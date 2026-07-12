// ============================================================================
// server/rooms/BattleRoom.js — one 10-slot authoritative TDM room. Owns the
// fixed-tick sim loop, dynamic join/leave (bot ↔ human swap), input intake with
// basic anti-cheat, and the schema-state + events broadcast.
//
// Lifecycle:
//   onCreate  → load the world ONCE, build the ServerMatch, start the 30 Hz sim
//               clock + a 20 Hz state-sync (Colyseus patchRate).
//   onJoin    → match.addHuman → a bot is replaced by this client's fighter;
//               send MSG.WELCOME (selfId/team/map). Join-in-progress: allowed
//               any time the room isn't full (maxClients 10). Match never stops.
//   onMessage(MSG.INPUT) → validate (dt clamp + rate cap) → queue for the sim.
//   onLeave   → match.removeHuman → a bot backfills the slot.
//
// State sync: every patch we copy the sim's fighter poses/hp/weapon into the
// schema MapSchema (Colyseus diffs + sends only what changed). Transient events
// (kills/shots/hits) drain from match.events → a single MSG.EVENTS broadcast.
// ============================================================================

import { Room } from '@colyseus/core';
import { MatchState, EntitySchema } from './state.js';
import { loadWorld } from '../sim/worldLoader.js';
import { ServerMatch } from '../sim/serverMatch.js';
import { MSG, NET, WEAPON_ID, TEAM_ID, EV } from '../../src/net/protocol.js';

const TICK_MS = 1000 / NET.tickRate;
const FIXED_DT = 1 / NET.tickRate;

export class BattleRoom extends Room {
  onCreate(options) {
    this.maxClients = NET.maxClients;
    this.autoDispose = false; // keep the match alive with 0 humans (all-bot fallback)

    this.world = loadWorld();
    this.match = new ServerMatch(this.world, (options && options.seed) || 0x1234abcd);

    // Test-only live-room tracker (lets the headless sim test reach the running
    // instance in-process). Harmless in production — just an array of refs.
    (BattleRoom._live || (BattleRoom._live = [])).push(this);

    this.setState(new MatchState());
    this.state.mapName = this.world.name;

    // Seed the schema with all 10 fighters.
    this._syncEntities(true);

    // Fixed-step sim clock. Colyseus setSimulationInterval drives an accumulator
    // so the sim advances in fixed FIXED_DT steps regardless of timer jitter.
    this._acc = 0;
    this.setSimulationInterval((deltaMs) => this._onTick(deltaMs), TICK_MS);

    // State broadcast rate (Colyseus patch). Also drains transient events.
    this.setPatchRate(1000 / NET.patchRate);

    // Input intake.
    this.onMessage(MSG.INPUT, (client, cmd) => this._onInput(client, cmd));
    this.onMessage('ping', (client, t) => client.send('pong', t)); // rtt probe
  }

  onJoin(client, options) {
    const name = (options && typeof options.name === 'string') ? options.name.slice(0, 16) : null;
    const ctx = this.match.addHuman(client.sessionId, name);
    if (!ctx) {
      // Shouldn't happen (maxClients guards), but never leave a client hanging.
      client.leave(4000, 'room full');
      return;
    }
    this._syncEntities(true);
    client.send(MSG.WELCOME, {
      selfId: ctx.entity.id,
      team: TEAM_ID[ctx.entity.team],
      mapName: this.world.name,
      tickRate: NET.tickRate,
      interpDelayMs: NET.interpDelayMs,
    });
  }

  onLeave(client) {
    this.match.removeHuman(client.sessionId);
    this._syncEntities(true);
  }

  onDispose() {
    if (BattleRoom._live) {
      const i = BattleRoom._live.indexOf(this);
      if (i >= 0) BattleRoom._live.splice(i, 1);
    }
  }

  // ---- Input validation + queue (basic anti-cheat) -------------------------
  _onInput(client, cmd) {
    if (!cmd || typeof cmd !== 'object') return;
    const ctx = this.match.humans.get(client.sessionId);
    if (!ctx) return;

    // Rate cap: at most maxCmdsPerSec per client (rolling 1 s window).
    const nowMs = Date.now();
    ctx._cmdWindow = (ctx._cmdWindow || []).filter((t) => nowMs - t < 1000);
    if (ctx._cmdWindow.length >= NET.maxCmdsPerSec) return; // drop — flooding
    ctx._cmdWindow.push(nowMs);

    // Sanitize numeric fields; clamp dt server-side (reject huge steps — B1).
    const clean = {
      seq: cmd.seq >>> 0,
      dtMs: Math.max(0, Math.min(NET.maxCmdDtMs, +cmd.dtMs || 0)),
      keys: (cmd.keys | 0) & 0x7f,
      yaw: +cmd.yaw || 0,
      pitch: Math.max(-1.55, Math.min(1.55, +cmd.pitch || 0)),
      jump: cmd.jump ? 1 : 0,
      reload: cmd.reload ? 1 : 0,
      fireClick: cmd.fireClick ? 1 : 0,
      switchTo: [0, 1, 2, 3].includes(cmd.switchTo) ? cmd.switchTo : 0,
    };
    this.match.queueInput(client.sessionId, clean);
  }

  // ---- Sim tick (fixed dt accumulator) -------------------------------------
  _onTick(deltaMs) {
    this._acc += deltaMs;
    // Cap catch-up so a hitching host can't spiral (max ~5 steps / timer fire).
    let steps = 0;
    while (this._acc >= TICK_MS && steps < 5) {
      this.match.update(FIXED_DT);
      this._acc -= TICK_MS;
      steps++;
    }
    if (this._acc > TICK_MS * 5) this._acc = 0; // drop the backlog

    this._syncEntities(false);
    this._syncMatch();
    this._drainEvents();
  }

  // Copy sim fighter state → schema. `full` re-creates entries (join/leave), else
  // just updates fields (Colyseus diffs).
  _syncEntities(full) {
    const seen = new Set();
    for (const s of this.match.slots) {
      const c = s.occupant;
      const key = String(c.id);
      seen.add(key);
      let e = this.state.entities.get(key);
      if (!e) { e = new EntitySchema(); this.state.entities.set(key, e); }
      const isBot = !(this._isHuman(c));
      e.id = c.id;
      e.name = c.name;
      e.team = TEAM_ID[c.team];
      e.isBot = isBot;
      e.x = c.pos.x; e.y = c.pos.y; e.z = c.pos.z;
      e.yaw = this._yawOf(c);
      e.hp = Math.max(0, Math.min(255, Math.round(c.hp)));
      e.dead = !!c.dead;
      e.weapon = this._weaponIdOf(c);
      e.protectedUntil = c.protectedUntil || 0;
      e.ackSeq = isBot ? 0 : (s.human ? s.human.lastAckSeq : 0);
      e.skin = c.skin || 0; // v2.4 appearance seed (client derives the body)
    }
    if (full) {
      // Remove any stale entries (id changed on a human↔bot swap → both ids stay,
      // so this rarely removes; guards against future roster changes).
      for (const key of [...this.state.entities.keys()]) {
        if (!seen.has(key)) this.state.entities.delete(key);
      }
    }
  }

  _syncMatch() {
    this.state.seScore = this.match.scores.se;
    this.state.bugScore = this.match.scores.bug;
    this.state.clock = this.match.clock;
    this.state.phase = this.match.state;
    this.state.winner = this.match.result ? this.match.result.winner : '';
  }

  _drainEvents() {
    const evs = this.match.events;
    if (evs.length === 0) return;
    const out = [];
    const hitsByShooter = new Map(); // shooterId → [victimId,...] (private confirm)
    for (const ev of evs) {
      if (ev.kind === 'kill') {
        out.push({ t: EV.KILL, k: ev.killerName, kt: ev.killerTeam ? TEAM_ID[ev.killerTeam] : 255,
          v: ev.victimName, vt: TEAM_ID[ev.victimTeam], w: WEAPON_ID[ev.weapon] ?? 0, h: ev.isHead ? 1 : 0, id: ev.victimId });
        out.push({ t: EV.DEATH, id: ev.victimId, kt: ev.killerTeam ? TEAM_ID[ev.killerTeam] : 255, h: ev.isHead ? 1 : 0 });
      } else if (ev.kind === 'shot') {
        out.push({ t: EV.SHOT, id: ev.id, x: ev.x, y: ev.y, z: ev.z });
      } else if (ev.kind === 'hit') {
        if (!hitsByShooter.has(ev.shooterId)) hitsByShooter.set(ev.shooterId, []);
        hitsByShooter.get(ev.shooterId).push(ev.victimId);
      }
    }
    evs.length = 0;

    if (out.length) this.broadcast(MSG.EVENTS, out);

    // HIT confirms are private → only the shooter needs its hitmarker.
    for (const [shooterId, victims] of hitsByShooter) {
      const client = this._clientForEntity(shooterId);
      if (client) client.send(MSG.EVENTS, victims.map((vid) => ({ t: EV.HIT, id: vid })));
    }
  }

  // ---- helpers -------------------------------------------------------------
  _isHuman(c) {
    for (const ctx of this.match.humans.values()) if (ctx.entity === c) return true;
    return false;
  }
  _clientForEntity(entityId) {
    for (const ctx of this.match.humans.values()) {
      if (ctx.entity.id === entityId) {
        return this.clients.find((cl) => cl.sessionId === ctx.sessionId) || null;
      }
    }
    return null;
  }
  _yawOf(c) {
    // Bots store a forward vector; humans store yaw on their cam.
    for (const ctx of this.match.humans.values()) if (ctx.entity === c) return ctx.cam.yaw;
    return Math.atan2(c.forward.x, -c.forward.z); // bot forward → yaw (camera convention)
  }
  _weaponIdOf(c) {
    for (const ctx of this.match.humans.values()) if (ctx.entity === c) return WEAPON_ID[ctx.weapons.active] ?? 0;
    return WEAPON_ID.rifle; // bots are rifle-only
  }
}
