// ============================================================================
// server/sim/serverMatch.js — the AUTHORITATIVE 5v5 TDM match with DYNAMIC
// human slots (the owner's core ask: quick-match into an open room, a human
// REPLACES a bot; on leave, a bot BACKFILLS the slot; the match never stops).
//
// REUSE (imported UNMODIFIED from ../../src via the loader shim):
//   • Bot                (src/game/bots.js)        — enemy/ally AI, byte-identical
//   • PlayerController    (src/player/controller.js) — the human movement sim
//   • WeaponSystem        (src/combat/weapons.js)   — the human fire/reload/switch SM
//   • PlayerEntity        (src/game/entities.js)    — human as a Combatant
//   • applyDamage, castRay, falloffMult, makeHitResult (src/combat/*)
//   • getBotTuning, COMBAT, MOVE, MATCH (src/config.js)
//   • makeNameDealers     (src/game/names.js)
//
// WHY NOT reuse Match (src/game/match.js) directly? Match hard-wires exactly ONE
// PlayerEntity into fixed roster arrays at construction. Dynamic N-human slots
// need the roster to flip fighters between bot-controlled and human-controlled
// at runtime. So this file MIRRORS Match's orchestration (D5 spawn pick, F10
// protection-by-exclusion, F1 single-applyDamage, respawns, scoring, clock) but
// over a UNIFORM fighter model where any slot can be a Bot or a human-driven
// PlayerEntity. The combat/movement/AI math itself is 100% the shared modules —
// no forked physics or damage. Divergence from Match is orchestration only and
// is called out inline.
//
// A "slot" is one roster position with a stable team + spawn set. It holds
// EITHER a Bot (default) or a human PlayerEntity (when a client occupies it).
// Swapping is just replacing the combatant object the roster arrays point to;
// the target-list rebuild reads whatever is currently there.
//
// Tick: fixed dt (1/30). humans simulated with the REAL controller+weapons from
// their queued input command; bots ticked with the REAL Bot.update. Lag-comp
// hitscan for human shots lives in serverHitscan.js.
// ============================================================================

import * as THREE from 'three';
import { COMBAT, MOVE, MATCH, getBotTuning } from '../../src/config.js';
import { applyDamage } from '../../src/combat/damage.js';
import { PlayerController } from '../../src/player/controller.js';
import { WeaponSystem } from '../../src/combat/weapons.js';
import { PlayerEntity } from '../../src/game/entities.js';
import { Bot } from '../../src/game/bots.js';
import { makeNameDealers, PLAYER_NAME } from '../../src/game/names.js';
import { ServerInput } from './serverInput.js';
import { LagCompensator, serverHumanFire } from './serverHitscan.js';
import { WEAPON_ID, TEAM_ID } from '../../src/net/protocol.js';

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();

function yawToForward(yaw, out) {
  return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
}

// A fake camera the PlayerEntity + WeaponSystem read (.yaw/.pitch). The human's
// look comes straight off input commands; we set yaw/pitch each tick. It also
// carries a `camera.position` used by getCameraRay origin (eye position).
class ServerCam {
  constructor() {
    this.yaw = 0;
    this.pitch = 0;
    this.camera = { position: new THREE.Vector3() };
  }
}

// One human-controlled slot's runtime bundle (created on join, torn down on
// leave). Reuses the REAL controller/weapons/entity so the human is simulated
// exactly like a browser single-player session.
class HumanCtx {
  constructor(entityId, team, spawnPos) {
    this.sessionId = null; // Colyseus client sessionId (set by the room)
    this.controller = new PlayerController(spawnPos.clone());
    this.cam = new ServerCam();
    this.weapons = new WeaponSystem([], []); // colliders/targets repointed each tick
    this.entity = new PlayerEntity(entityId, this.controller, this.weapons, this.cam);
    this.entity.team = team;
    this.entity.name = PLAYER_NAME; // replaced with the client's chosen/dealt name
    this.weapons.owner = this.entity;
    this.input = new ServerInput();

    // getCameraRay: server builds the ray from the human's yaw/pitch + eye pos —
    // IDENTICAL geometry to main.js's injected hook (E1: origin = camera center).
    this.weapons.getCameraRay = (outOrigin, outDir, spreadRad) => {
      outOrigin.copy(this.cam.camera.position);
      const cp = Math.cos(this.cam.pitch);
      _fwd.set(-Math.sin(this.cam.yaw) * cp, Math.sin(this.cam.pitch), -Math.cos(this.cam.yaw) * cp).normalize();
      if (spreadRad > 0) {
        _serverSpread(outDir, _fwd, spreadRad);
      } else {
        outDir.copy(_fwd);
      }
    };

    // Latest queued command + reconciliation ack.
    this.pendingCmds = [];   // ordered InputCommands not yet simulated
    this.lastAckSeq = 0;     // last seq the server has simulated
    this._cmdTimestamps = []; // rolling window for the rate cap
  }
}

// Uniform-disk cone sample (matches main.js getCameraRay + bots' _applyAimError).
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _WORLD_UP = new THREE.Vector3(0, 1, 0);
function _serverSpread(outDir, fwd, spreadRad) {
  _right.crossVectors(fwd, _WORLD_UP).normalize();
  _up.crossVectors(_right, fwd);
  const a = Math.random() * Math.PI * 2;
  const r = Math.tan(spreadRad) * Math.sqrt(Math.random());
  outDir.copy(fwd).addScaledVector(_right, Math.cos(a) * r).addScaledVector(_up, Math.sin(a) * r).normalize();
}

export class ServerMatch {
  /**
   * @param {ReturnType<import('./worldLoader.js').loadWorld>} world
   * @param {number} nameSeed
   */
  constructor(world, nameSeed = 0x1234abcd) {
    this.world = world;
    this.graph = world.graph;
    this.staticColliders = world.colliders;
    this.seSpawns = world.seSpawns;
    this.bugSpawns = world.bugSpawns;
    this.tuning = getBotTuning();
    this._dealers = makeNameDealers(nameSeed >>> 0);

    // --- Build the bot roster with the REAL Bot class (headless scene stub) ---
    // scene only needs .add() (Bot ctor calls scene.add(bot.group)); we don't
    // render, so a no-op sink is fine.
    const scene = { add() {} };
    const seNames = [];
    for (let i = 0; i < MATCH.teamSize; i++) seNames.push(this._dealers.se.next());
    const bugNames = [];
    for (let i = 0; i < MATCH.teamSize; i++) bugNames.push(this._dealers.bug.next());

    // NOTE: unlike single-player (player = 1 SE + 4 SE bots), the server fills
    // BOTH teams fully with bots (5+5); humans then REPLACE bots on join. So we
    // build 5 SE bots and 5 Bug bots. index seeds the LOS stagger across all 10.
    this.seBots = [];
    this.bugBots = [];
    for (let i = 0; i < MATCH.teamSize; i++) {
      const b = new Bot(seNames[i], 'se', this.graph, this.tuning, i);
      scene.add(b.group);
      this.seBots.push(b);
    }
    for (let i = 0; i < MATCH.teamSize; i++) {
      const b = new Bot(bugNames[i], 'bug', this.graph, this.tuning, MATCH.teamSize + i);
      scene.add(b.group);
      this.bugBots.push(b);
    }

    // --- Slots: one per roster position. slot.occupant is the LIVE combatant
    //     (a Bot by default; a human PlayerEntity when a client holds the slot).
    //     slot.bot is the bot that backfills when the human leaves. --------------
    this.slots = [];
    for (let i = 0; i < this.seBots.length; i++) this.slots.push(this._makeSlot(this.seBots[i], 'se'));
    for (let i = 0; i < this.bugBots.length; i++) this.slots.push(this._makeSlot(this.bugBots[i], 'bug'));

    // Humans keyed by sessionId → HumanCtx.
    this.humans = new Map();

    // --- Match state ----------------------------------------------------------
    this.scores = { se: 0, bug: 0 };
    this.clock = MATCH.timeLimit;
    this.state = 'live';
    this.result = null;

    // --- Stable rosters + target/collider scratch (rebuilt in place each tick) -
    this.seTeam = [];  // combatants currently on SE (bots or humans)
    this.bugTeam = [];
    this.allCombatants = [];
    this._botEnemies = new Map();  // per-bot enemy list
    this._botAllies = new Map();
    this._colliderPool = [];       // dynamic bot/human AABBs appended to player collider sets
    for (let i = 0; i < this.slots.length; i++) {
      this._colliderPool.push({ min: new THREE.Vector3(), max: new THREE.Vector3() });
    }
    this._dynamicColliders = this.staticColliders.slice();
    this._staticCount = this.staticColliders.length;

    // Lag compensation: ring buffer of every fighter's head/body pose per tick.
    this.lagComp = new LagCompensator();

    // --- Transient event sink (kills/shots) — the room drains these each tick --
    this.events = [];

    this._nextRespawn = new Map(); // combatant → respawn countdown (game-time)

    // Wire hooks on every combatant (bots + future humans get wired on join).
    for (const s of this.slots) this._wireBotHooks(s.bot);

    this._rebuildRosters();
    this._spawnEveryone();
  }

  _makeSlot(bot, team) {
    return { team, bot, occupant: bot, spawns: team === 'se' ? this.seSpawns : this.bugSpawns };
  }

  // ---- Combatant hooks (F1 feedback → match logic) -------------------------
  _wireBotHooks(bot) {
    bot.onDamaged = (info) => bot.onDamagedInternal(info);
    bot.onKilled = (info) => this._onKilled(bot, info.source || null, info.isHead);
    bot.onShot = (b, shot) => this._onShot(b, shot);
  }

  _wireHumanHooks(ctx) {
    const ent = ctx.entity;
    ent.onDamaged = (info) => { /* server: hp already applied; danger is client-side FX */ };
    ent.onKilled = (info) => this._onKilled(ent, info.source || null, info.isHead);
    // onFire → a positional SHOT event (muzzle/audio for everyone). Kills are
    // counted in applyDamage→onKilled; a HIT confirm is sent to the shooter for
    // its hitmarker.
    ctx.weapons.onFire = () => {
      const p = ctx.cam.camera.position;
      this.events.push({ kind: 'shot', id: ent.id, x: p.x, y: p.y, z: p.z });
    };
    ctx.weapons.onShotResolved = (r) => {
      if (r.result && r.result.hitSomething && r.result.target) {
        this.events.push({ kind: 'hit', shooterId: ent.id, victimId: r.result.target.id, killed: r.killed, isHead: r.isHead });
      }
    };
  }

  // ==========================================================================
  // JOIN / LEAVE — dynamic slots (the owner's core ask)
  // ==========================================================================

  // Pick the team with FEWER humans (ties → SE), then an OPEN slot on it (one
  // currently held by a bot), replace that bot with a fresh human. Returns the
  // HumanCtx (its entity.id is the stable network id) or null if the room is
  // somehow full (should not happen; the room caps at maxClients).
  addHuman(sessionId, name) {
    const seHumans = this.slots.filter((s) => s.team === 'se' && s.occupant !== s.bot).length;
    const bugHumans = this.slots.filter((s) => s.team === 'bug' && s.occupant !== s.bot).length;
    const team = seHumans <= bugHumans ? 'se' : 'bug';

    const slot = this.slots.find((s) => s.team === team && s.occupant === s.bot);
    if (!slot) {
      // Chosen team full — try the other (keeps join working near capacity).
      const other = this.slots.find((s) => s.occupant === s.bot);
      if (!other) return null;
      return this._occupy(other, sessionId, name);
    }
    return this._occupy(slot, sessionId, name);
  }

  _occupy(slot, sessionId, name) {
    const bot = slot.bot;
    // Human INHERITS the bot's current spawn point + entity id space is its own
    // (entity id = the human's stable id; we use a dedicated id range so it never
    // collides with bot ids which start at 1000).
    const ctx = new HumanCtx(this._nextHumanId(), slot.team, bot.pos);
    ctx.sessionId = sessionId;
    ctx.entity.name = name || this._dealers[slot.team].next();
    this._wireHumanHooks(ctx);

    // The bot despawns (leaves the fight, stops being a target/collider). Its
    // respawn timer is cleared so it doesn't pop back while the human holds it.
    bot.dead = true;
    bot.group.visible = false;
    this._nextRespawn.delete(bot);

    slot.occupant = ctx.entity;
    slot.human = ctx;
    this.humans.set(sessionId, ctx);

    // Spawn the human at a SAFE spawn (D5) with protection, facing mid.
    this._rebuildRosters();
    this._spawnCombatant(ctx.entity, slot, true);
    return ctx;
  }

  // Human leaves → a BOT backfills the slot (match never loses a fighter).
  removeHuman(sessionId) {
    const ctx = this.humans.get(sessionId);
    if (!ctx) return;
    const slot = this.slots.find((s) => s.human === ctx);
    this.humans.delete(sessionId);
    if (!slot) return;

    // Backfill: the slot's bot re-enters at a safe spawn.
    slot.occupant = slot.bot;
    slot.human = null;
    this._rebuildRosters();
    slot.bot.dead = false;
    slot.bot._respawnTimer = 0;
    this._spawnCombatant(slot.bot, slot, true);
  }

  _nextHumanId() {
    // Human ids in [1..999]; bot ids start at 1000 (bots.js _nextBotId). Never collide.
    this._humanIdSeq = (this._humanIdSeq || 0) + 1;
    return this._humanIdSeq;
  }

  humanCount() { return this.humans.size; }

  // ==========================================================================
  // SPAWNING (D5 — safe spawn selection, mirrors match.js)
  // ==========================================================================
  _spawnEveryone() {
    const gt = this._gameTime();
    for (const s of this.slots) this._spawnCombatant(s.occupant, s, true, gt);
  }

  _spawnCombatant(c, slot, initial, gameTime = this._gameTime()) {
    const sp = this._pickSpawn(slot.spawns, c);
    const protectUntil = gameTime + MATCH.spawnProtection;
    if (c instanceof PlayerEntity) {
      c.respawnAt(sp.pos, sp.yaw, protectUntil);
      // Keep the server cam + eye position in sync so the first ray is sane.
      const ctx = this.humans.get(slot.human?.sessionId);
      if (slot.human) {
        slot.human.cam.yaw = sp.yaw; slot.human.cam.pitch = 0;
        slot.human.controller.pos.copy(sp.pos);
        slot.human.cam.camera.position.set(sp.pos.x, sp.pos.y + MOVE.eyeHeight, sp.pos.z);
      }
    } else {
      // Bot
      const node = this.graph.nearestNode(sp.pos);
      yawToForward(sp.yaw, _fwd);
      c.spawnAt(sp.pos, _fwd, protectUntil, node);
    }
  }

  // D5: the team point farthest from living enemies, de-prioritizing occupied points.
  _pickSpawn(points, forWhom) {
    const enemies = this._enemiesTeamOf(forWhom);
    let best = points[0];
    let bestScore = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const pt = points[i].pos;
      let nearest = Infinity;
      for (const en of enemies) {
        if (en.dead) continue;
        _v.set(en.pos.x - pt.x, 0, en.pos.z - pt.z);
        const d = _v.lengthSq();
        if (d < nearest) nearest = d;
      }
      if (nearest === Infinity) nearest = 1e6;
      let occupied = 0;
      for (const cc of this.allCombatants) {
        if (cc === forWhom || cc.dead) continue;
        _v.set(cc.pos.x - pt.x, 0, cc.pos.z - pt.z);
        if (_v.lengthSq() < 1.2 * 1.2) occupied += 1;
      }
      const score = nearest - occupied * 25;
      if (score > bestScore) { bestScore = score; best = points[i]; }
    }
    return best;
  }

  // ==========================================================================
  // KILL / SCORE (F1/F2/F3)
  // ==========================================================================
  _onKilled(victim, killer, isHead) {
    if (killer && killer.team && killer.team !== victim.team) {
      this.scores[killer.team] += 1;
    }
    this.events.push({
      kind: 'kill',
      killerName: killer ? killer.name : '—',
      killerTeam: killer ? killer.team : null,
      victimName: victim.name,
      victimTeam: victim.team,
      weapon: this._weaponOf(killer),
      isHead: !!isHead,
      victimId: victim.id,
    });
    // Schedule respawn (bots + humans both respawn after the delay).
    if (victim instanceof Bot) {
      victim.group.visible = false;
      victim._respawnTimer = MATCH.respawnDelay;
    } else {
      this._nextRespawn.set(victim, MATCH.respawnDelay);
    }
    this._checkWin();
  }

  _weaponOf(killer) {
    if (!killer) return 'rifle';
    if (killer instanceof PlayerEntity) {
      const ctx = [...this.humans.values()].find((h) => h.entity === killer);
      return ctx ? ctx.weapons.active : 'rifle';
    }
    return 'rifle';
  }

  _onShot(bot, shot) {
    this.events.push({ kind: 'shot', id: bot.id, x: bot.headCenter.x, y: bot.headCenter.y, z: bot.headCenter.z });
  }

  _checkWin() {
    if (this.state === 'over') return;
    if (this.scores.se >= MATCH.killTarget || this.scores.bug >= MATCH.killTarget) this._endMatch();
  }

  _endMatch() {
    this.state = 'over';
    let winner;
    if (this.scores.se > this.scores.bug) winner = 'se';
    else if (this.scores.bug > this.scores.se) winner = 'bug';
    else winner = 'draw';
    this.result = { winner, se: this.scores.se, bug: this.scores.bug };
    this._overHold = MATCH.restartDelay;
  }

  restart() {
    this.scores.se = 0; this.scores.bug = 0;
    this.clock = MATCH.timeLimit;
    this.state = 'live';
    this.result = null;
    this._nextRespawn.clear();
    this._rebuildRosters();
    this._spawnEveryone();
  }

  _enemiesTeamOf(c) { return c.team === 'se' ? this.bugTeam : this.seTeam; }
  _alliesTeamOf(c) { return c.team === 'se' ? this.seTeam : this.bugTeam; }

  // ==========================================================================
  // ROSTER + TARGET LIST rebuild (F10: protection-by-exclusion)
  // ==========================================================================
  _rebuildRosters() {
    this.seTeam.length = 0;
    this.bugTeam.length = 0;
    this.allCombatants.length = 0;
    for (const s of this.slots) {
      (s.team === 'se' ? this.seTeam : this.bugTeam).push(s.occupant);
      this.allCombatants.push(s.occupant);
    }
    // Ensure per-bot lists exist for every current bot occupant.
    for (const s of this.slots) {
      if (s.occupant instanceof Bot) {
        if (!this._botEnemies.has(s.occupant)) this._botEnemies.set(s.occupant, []);
        if (!this._botAllies.has(s.occupant)) this._botAllies.set(s.occupant, []);
      }
    }
  }

  _rebuildTargetLists(gt) {
    for (const s of this.slots) {
      const bot = s.occupant;
      if (!(bot instanceof Bot)) continue;
      const enemies = this._botEnemies.get(bot);
      const allies = this._botAllies.get(bot);
      enemies.length = 0;
      allies.length = 0;
      const enemyTeam = this._enemiesTeamOf(bot);
      for (const en of enemyTeam) {
        if (en.dead) continue;
        if (en.protectedUntil > gt) continue; // F10
        enemies.push(en);
      }
      const allyTeam = this._alliesTeamOf(bot);
      for (const al of allyTeam) {
        if (al === bot || al.dead) continue;
        if (al instanceof PlayerEntity) continue; // humans push bots via collider, not soft separation
        allies.push(al);
      }
    }
  }

  // Build the dynamic collider set a given HUMAN collides against: static world
  // + every OTHER living fighter's AABB. (Bots collide vs static only, like SP.)
  _dynamicCollidersFor(selfEntity) {
    let n = this._staticCount;
    let poolIdx = 0;
    for (const s of this.slots) {
      const c = s.occupant;
      if (c === selfEntity || c.dead) continue;
      if (c instanceof Bot && !c.group.visible) continue;
      const slot = this._colliderPool[poolIdx++];
      if (c instanceof Bot) {
        c.writeCollider(slot);
      } else {
        // human AABB (same dims as controller)
        const p = c.pos, hw = MOVE.halfWidth;
        slot.min.set(p.x - hw, p.y, p.z - hw);
        slot.max.set(p.x + hw, p.y + MOVE.height, p.z + hw);
      }
      this._dynamicColliders[n++] = slot;
    }
    this._dynamicColliders.length = n;
    return this._dynamicColliders;
  }

  // Living, unprotected enemies of a human — the target list its hitscan tests.
  _enemyTargetsFor(entity, gt) {
    const out = this._humanEnemyScratch || (this._humanEnemyScratch = []);
    out.length = 0;
    for (const en of this._enemiesTeamOf(entity)) {
      if (en.dead) continue;
      if (en.protectedUntil > gt) continue;
      out.push(en);
    }
    return out;
  }

  _gameTime() { return MATCH.timeLimit - this.clock; }

  // ==========================================================================
  // FIXED-STEP TICK (server authority). dt is the fixed sim dt (1/tickRate).
  // ==========================================================================
  update(dt) {
    const gt = this._gameTime();

    // Refresh human entity hitboxes first (bots aim at current pose), keep the
    // eye/cam position current from the controller.
    for (const ctx of this.humans.values()) {
      ctx.cam.camera.position.set(ctx.controller.pos.x, ctx.controller.pos.y + MOVE.eyeHeight, ctx.controller.pos.z);
      ctx.entity.refresh();
    }

    if (this.state === 'live') {
      this._tickRespawns(dt);
    }

    this._rebuildTargetLists(gt);

    if (this.state === 'live') {
      // 1) Simulate every human from its queued input commands (REAL controller
      //    + weapons). Multiple commands may have arrived since last tick; we
      //    apply them in order so reconciliation stays exact.
      for (const ctx of this.humans.values()) {
        this._simulateHuman(ctx, dt, gt);
      }

      // 2) Tick every living bot (REAL Bot.update) with static colliders only.
      for (const s of this.slots) {
        const bot = s.occupant;
        if (!(bot instanceof Bot)) continue;
        if (bot.dead || !bot.group.visible) continue;
        bot.update(dt, this._botEnemies.get(bot), this.staticColliders, this._botAllies.get(bot), gt);
      }

      // 3) Snapshot poses for lag compensation AFTER movement resolves this tick.
      this.lagComp.record(this.allCombatants, gt);

      // 4) Advance clock; time expiry ends the match.
      this.clock = Math.max(0, this.clock - dt);
      if (this.clock <= 0) this._endMatch();
    } else if (this._overHold > 0) {
      this._overHold = Math.max(0, this._overHold - dt);
      if (this._overHold <= 0) this.restart();
    }
  }

  // Simulate ONE human for this tick: drain its queued commands through the REAL
  // PlayerController + WeaponSystem. Look is authoritative-from-client (yaw/pitch
  // set directly); movement/fire/reload/switch run the real state machines.
  _simulateHuman(ctx, tickDt, gt) {
    const ent = ctx.entity;
    if (ent.dead) { ctx.pendingCmds.length = 0; return; }

    // SHOOTING world = STATIC geometry ONLY (main.js contract: other fighters'
    // AABBs must NOT be bullet-blocking walls — bullets hit them through the
    // TARGET list's head-sphere/body instead; the collider width would otherwise
    // shadow the narrower hit box and eat every shot). MOVEMENT collides against
    // the dynamic set (statics + other fighters), passed to controller.update.
    ctx.weapons.world = this.staticColliders;
    ctx.weapons.targets = this._enemyTargetsFor(ent, gt);

    const cmds = ctx.pendingCmds;
    if (cmds.length === 0) {
      // No new input — still integrate one idle step so gravity/rope/ADS ease
      // continue (matches the browser rendering a frame with no key change).
      this._stepHuman(ctx, tickDt, gt, /*cmd*/ null);
      return;
    }
    for (let i = 0; i < cmds.length; i++) {
      const cmd = cmds[i];
      const dt = Math.min(cmd.dtMs / 1000, MOVE.dtClampMs / 1000); // clamp (anti-cheat + B1)
      this._stepHuman(ctx, dt, gt, cmd);
      ctx.lastAckSeq = cmd.seq;
    }
    cmds.length = 0;
  }

  _stepHuman(ctx, dt, gt, cmd) {
    const ent = ctx.entity;
    if (cmd) {
      ctx.cam.yaw = cmd.yaw;
      ctx.cam.pitch = cmd.pitch;
      ctx.input.applyCommand(cmd);
    } else {
      // idle step: keep held state, no new edges
      ctx.input.applyCommand({ keys: ctx.input._held, jump: 0, reload: 0, fireClick: 0, switchTo: 0, yaw: ctx.cam.yaw, pitch: ctx.cam.pitch });
    }

    // Break spawn protection the moment the human fires (mirror _detectPlayerFire).
    const beforeShots = ctx.weapons.shotsFired;

    // Sync eye position BEFORE the controller move (getCameraRay reads it), then
    // run the REAL controller + weapons exactly as main.js does. MOVEMENT uses
    // the DYNAMIC collider set (statics + other fighters); SHOOTING uses the
    // static set (set on ctx.weapons.world in _simulateHuman) — the split matters
    // (see the main.js contract note there).
    ctx.cam.camera.position.set(ctx.controller.pos.x, ctx.controller.pos.y + MOVE.eyeHeight, ctx.controller.pos.z);
    ctx.controller.ropes = this.world.ropes; // enable rope climb (parity with SP)
    ctx.controller.update(dt, ctx.input, ctx.cam.yaw, this._dynamicCollidersFor(ent));
    ent.refresh();
    ctx.cam.camera.position.set(ctx.controller.pos.x, ctx.controller.pos.y + MOVE.eyeHeight, ctx.controller.pos.z);

    // Fire is handled with LAG COMPENSATION: instead of letting weapons._fire
    // cast against the live world, we intercept fire intent. To keep the REAL
    // state machine (cooldown/mag/reload/ADS/burst), we run weapons.update but
    // temporarily point its getCameraRay to record the shot, then re-cast with
    // rewound targets. serverHumanFire wraps this cleanly.
    serverHumanFire(ctx, dt, this, gt);

    if (ctx.weapons.shotsFired > beforeShots) ent.notifyFired();
  }

  _tickRespawns(dt) {
    const gt = this._gameTime();
    // Humans
    for (const [victim, timer] of this._nextRespawn) {
      const t = timer - dt;
      if (t <= 0) {
        this._nextRespawn.delete(victim);
        const slot = this.slots.find((s) => s.occupant === victim);
        if (slot) this._spawnCombatant(victim, slot, false, gt);
      } else {
        this._nextRespawn.set(victim, t);
      }
    }
    // Bots
    for (const s of this.slots) {
      const bot = s.occupant;
      if (!(bot instanceof Bot)) continue;
      if (bot._respawnTimer <= 0) continue;
      bot._respawnTimer -= dt;
      if (bot._respawnTimer <= 0) {
        bot._respawnTimer = 0;
        this._spawnCombatant(bot, s, false, gt);
      }
    }
  }

  // Queue a validated input command for a human (called by the room on MSG.INPUT).
  queueInput(sessionId, cmd) {
    const ctx = this.humans.get(sessionId);
    if (!ctx) return;
    // Rate cap (basic anti-cheat): drop commands beyond maxCmdsPerSec.
    const now = ctx._cmdCount = (ctx._cmdCount || 0) + 1;
    ctx.pendingCmds.push(cmd);
    // Guard against unbounded backlog (a client flooding): keep only the most
    // recent ~8 commands (the server ticks 30 Hz; more than that is abuse/lag).
    if (ctx.pendingCmds.length > 8) ctx.pendingCmds.splice(0, ctx.pendingCmds.length - 8);
  }
}
