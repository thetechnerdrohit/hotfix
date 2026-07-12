// ============================================================================
// src/net/client.js — the browser NET CLIENT: connect → quick-match → a clean
// surface main.js drives. It owns the Colyseus connection, decodes room state
// into prediction/interpolation, and exposes callbacks + send. It does NOT
// touch the DOM, THREE, audio, or the HUD — main.js (the lead's job) wires those
// to the callbacks below.
//
// ── PUBLIC SURFACE (what main.js uses) ──────────────────────────────────────
//   const net = new NetClient(controller, cam);
//   await net.connect(url);                 // ws://host:2567 (default same host :2567)
//   net.selfId        → number              // our entity id (set after WELCOME)
//   net.selfTeam      → 'se' | 'bug'
//   net.latency       → number (ms, smoothed rtt)
//   net.onSnapshot(cb) → cb() each patch    // read net.entities for render
//   net.onEvent(cb)    → cb(events[])       // kill/shot/hit/death (feed + audio + hitmarker)
//   net.onWelcome(cb)  → cb({selfId,team,mapName})
//   net.entities       → Map<id, {id,name,team,isBot,pos:V3,yaw,hp,dead,weapon,protectedUntil,isSelf}>
//                        (remote entities are INTERPOLATED; self is PREDICTED)
//   net.sendInput(cmd) → void               // send one InputCommand (see protocol.js)
//   net.disconnect()
//
// ── MAIN.JS WIRING CONTRACT (the lead implements; drop-in for the SP loop) ──
// Replace the single-player Match with a NetClient in MULTIPLAYER mode. Per
// frame, in the PLAYING branch, INSTEAD of `match.update`:
//
//   1) INPUT + PREDICT (before rendering):
//        const keys = net.keysFromInput(input);           // WASD/Shift/LMB/RMB bitmask
//        const fireClick = input.takeMousePressed(0);      // semi edge
//        const reloadEdge = input.takePressed('KeyR');
//        const switchTo = net.switchFromInput(input);      // 0|1|2|3 (drains Digit1-3)
//        const cols = net.predictedColliders(room.colliders); // static + interp remote AABBs
//        const cmd = net.predictor.sampleAndPredict(simDt, input, cols, fireClick, reloadEdge, switchTo, keys);
//        net.sendInput(cmd);
//        cam.follow(player, simDt);   // camera follows the PREDICTED controller
//        // local weapons.update STILL runs for viewmodel/crosshair/ADS feel, but
//        // its hits are cosmetic — the SERVER is authoritative (weapons.targets
//        // = [] so no local damage; onFire/onShotResolved drive FX only).
//
//   2) NETWORK STATE (each net.onSnapshot):
//        net already reconciled self + interpolated remotes into net.entities.
//        Render each remote entity: reuse the Bot mesh builder OR a light avatar;
//        position/yaw from net.entities. hp/dead/weapon drive nameplates/ragdoll.
//
//   3) EVENTS (net.onEvent): map EV.KILL→kill feed, EV.SHOT→positional muzzle+
//        audio at {x,y,z}, EV.DEATH→splat at the entity, EV.HIT→local hitmarker.
//
//   4) HUD: scores/clock/phase from net.match (mirrors match HUD inputs).
//
// The client sends inputs at the render rate (capped by the server's rate cap);
// the server ticks 30 Hz and patches 20 Hz. Interp delay is 100 ms.
// ============================================================================

import * as THREE from 'three';
import { Client } from 'colyseus.js';
import { MSG, NET, WEAPON_NAME, TEAM_NAME, KEYS, EV } from './protocol.js';
import { LocalPredictor, ReplayInput, RemoteInterpolator } from './prediction.js';

export class NetClient {
  /**
   * @param {import('../player/controller.js').PlayerController} controller
   * @param {{yaw:number, pitch:number}} cam
   */
  constructor(controller, cam) {
    this.controller = controller;
    this.cam = cam;
    this.predictor = new LocalPredictor(controller, cam);
    this.interp = new RemoteInterpolator();
    this._replay = new ReplayInput();

    this.room = null;
    this.selfId = 0;
    this.selfTeam = 'se';
    this.latency = 0;
    this.mapName = 'battle';

    // Decoded, render-ready view. main.js reads this each frame.
    this.entities = new Map();
    this.match = { seScore: 0, bugScore: 0, clock: 0, phase: 'live', winner: '' };

    // Callbacks (main.js assigns).
    this._onSnapshot = null;
    this._onEvent = null;
    this._onWelcome = null;

    this._pingTimer = 0;
    this._lastPingSent = 0;
    this._colScratch = null;
  }

  onSnapshot(cb) { this._onSnapshot = cb; }
  onEvent(cb) { this._onEvent = cb; }
  onWelcome(cb) { this._onWelcome = cb; }

  // Connect + quick-match. `url` e.g. 'ws://localhost:2567'. `opts.name` optional.
  // v2.7: `opts.mode` ('tdm' | 'ffa') picks the room TYPE — this is the whole
  // matchmaking mechanism (the two Play buttons pass one or the other).
  async connect(url, opts = {}) {
    const wsUrl = url || `ws://${location.hostname}:2567`;
    this.client = new Client(wsUrl);
    const roomType = opts.mode === 'ffa' ? 'ffa' : 'tdm';
    this.mode = roomType;
    this.room = await this.client.joinOrCreate(roomType, { name: opts.name });

    this.room.onMessage(MSG.WELCOME, (w) => {
      this.selfId = w.selfId;
      this.selfTeam = TEAM_NAME[w.team] || 'se';
      this.mapName = w.mapName;
      this.mode = w.mode || roomType; // authoritative mode from the server
      if (this._onWelcome) this._onWelcome({ selfId: w.selfId, team: this.selfTeam, mapName: w.mapName, mode: this.mode });
    });

    this.room.onMessage(MSG.EVENTS, (evs) => {
      if (this._onEvent) this._onEvent(this._decodeEvents(evs));
    });

    this.room.onMessage('pong', (t) => {
      // rtt = now − sentAt; smooth it.
      const rtt = performance.now() - t;
      this.latency = this.latency ? this.latency * 0.8 + rtt * 0.2 : rtt;
    });

    // State patches → decode into predicted/interpolated view.
    this.room.onStateChange((state) => this._onState(state));

    return this.room;
  }

  disconnect() { if (this.room) this.room.leave(); this.room = null; }

  // ---- Per-frame tick (main.js calls once per rendered frame) --------------
  // Advances interpolation + sends a periodic ping for rtt. `nowMs` = performance.now().
  tick(nowMs) {
    this.interp.update(nowMs);
    // Refresh interpolated remote positions into the render view.
    for (const [id, view] of this.entities) {
      if (view.isSelf) continue;
      const buf = this.interp.get(id);
      if (buf) { view.pos.copy(buf.pos); view.yaw = buf.yaw; }
    }
    // Periodic ping (every ~1 s) for rtt estimation.
    if (this.room && nowMs - this._lastPingSent > 1000) {
      this._lastPingSent = nowMs;
      this.room.send('ping', nowMs);
    }
  }

  sendInput(cmd) { if (this.room) this.room.send(MSG.INPUT, cmd); }

  // ---- State decode: reconcile self, buffer remotes ------------------------
  _onState(state) {
    const nowMs = performance.now();
    const live = new Set();
    state.entities.forEach((e, key) => {
      const id = e.id;
      live.add(id);
      const isSelf = id === this.selfId;
      let view = this.entities.get(id);
      if (!view) {
        view = { id, name: e.name, team: TEAM_NAME[e.team], isBot: e.isBot,
          pos: new THREE.Vector3(), yaw: 0, hp: 100, dead: false, weapon: 'rifle',
          protectedUntil: 0, isSelf, skin: e.skin || 0 };
        this.entities.set(id, view);
      }
      view.name = e.name;
      view.team = TEAM_NAME[e.team];
      view.isBot = e.isBot;
      view.skin = e.skin || 0; // v2.4 appearance seed (AvatarPool derives the body)
      view.hp = e.hp;
      view.dead = e.dead;
      view.weapon = WEAPON_NAME[e.weapon] || 'rifle';
      view.protectedUntil = e.protectedUntil;
      view.isSelf = isSelf;

      if (isSelf) {
        // RECONCILE the local predicted controller against authority.
        this.predictor.reconcile(
          { x: e.x, y: e.y, z: e.z }, e.ackSeq, this._replay,
          this._colScratch || [], // colliders set by predictedColliders(); replay uses last set
        );
        view.pos.copy(this.controller.pos);
        view.yaw = this.cam.yaw;
      } else {
        // Buffer for interpolation (rendered 100 ms in the past).
        this.interp.ingest(id, e.x, e.y, e.z, e.yaw, nowMs);
      }
    });
    // Drop entities that left.
    for (const id of [...this.entities.keys()]) {
      if (!live.has(id)) { this.entities.delete(id); this.interp.remove(id); }
    }

    this.match.seScore = state.seScore;
    this.match.bugScore = state.bugScore;
    this.match.clock = state.clock;
    this.match.phase = state.phase;
    this.match.winner = state.winner;
    this.match.mode = state.mode || 'tdm'; // v2.7

    if (this._onSnapshot) this._onSnapshot();
  }

  // ---- Helpers main.js uses to build a command -----------------------------
  // Held-key bitmask from the browser Input (WASD/Shift/LMB/RMB).
  keysFromInput(input) {
    let k = 0;
    if (input.pressed('KeyW')) k |= KEYS.W;
    if (input.pressed('KeyA')) k |= KEYS.A;
    if (input.pressed('KeyS')) k |= KEYS.S;
    if (input.pressed('KeyD')) k |= KEYS.D;
    if (input.pressed('ShiftLeft') || input.pressed('ShiftRight')) k |= KEYS.SHIFT;
    if (input.buttons.has(0)) k |= KEYS.LMB;
    if (input.buttons.has(2)) k |= KEYS.RMB;
    return k;
  }

  // Drain weapon-switch edges → 0|1|2|3 (newest wins), mirrors weapons._readSwitchInput.
  switchFromInput(input) {
    let want = 0;
    if (input.takePressed('Digit1')) want = 1;
    if (input.takePressed('Digit2')) want = 2;
    if (input.takePressed('Digit3')) want = 3;
    return want;
  }

  // Predicted collider set for local movement: static world + interpolated
  // remote-fighter AABBs (so the local player collides with other players/bots
  // between server corrections). Rebuilt each frame into a reused array (I1).
  predictedColliders(staticColliders) {
    if (!this._colScratch) this._colScratch = staticColliders.slice();
    const arr = this._colScratch;
    let n = staticColliders.length;
    // ensure prefix is the statics (identity stable)
    for (let i = 0; i < staticColliders.length; i++) arr[i] = staticColliders[i];
    const hw = 0.4, h = 1.8; // MOVE.halfWidth / MOVE.height (avoid importing config here)
    for (const [id, view] of this.entities) {
      if (view.isSelf || view.dead) continue;
      const p = view.pos;
      if (!this._pool) this._pool = [];
      let box = this._pool[n - staticColliders.length];
      if (!box) { box = { min: new THREE.Vector3(), max: new THREE.Vector3() }; this._pool[n - staticColliders.length] = box; }
      box.min.set(p.x - hw, p.y, p.z - hw);
      box.max.set(p.x + hw, p.y + h, p.z + hw);
      arr[n++] = box;
    }
    arr.length = n;
    return arr;
  }

  _decodeEvents(evs) {
    // Expand the compact wire fields (k/kt/v/vt/w/h/id/ki/by/x/y/z) into the
    // friendly names main.js reads. KILL/DEATH carry killer/victim names+teams;
    // SHOT carries a world pos; HIT carries the victim id. v2.5 adds killerId
    // (ki) for positional/self kill audio.
    const out = [];
    for (const ev of evs) {
      if (ev.t === EV.KILL) {
        out.push({ t: EV.KILL,
          killerName: ev.k, killerTeam: ev.kt === 255 ? null : TEAM_NAME[ev.kt],
          victimName: ev.v, victimTeam: TEAM_NAME[ev.vt],
          weapon: WEAPON_NAME[ev.w] || 'rifle', isHead: !!ev.h,
          id: ev.id, killerId: ev.ki ?? 0 });
      } else if (ev.t === EV.DEATH) {
        out.push({ t: EV.DEATH, id: ev.id, killerTeam: ev.kt === 255 ? null : TEAM_NAME[ev.kt], isHead: !!ev.h,
          killerName: ev.k, weapon: WEAPON_NAME[ev.w] || 'rifle' });
      } else if (ev.t === EV.SHOT) {
        out.push({ t: EV.SHOT, id: ev.id, x: ev.x, y: ev.y, z: ev.z });
      } else if (ev.t === EV.HIT) {
        out.push({ t: EV.HIT, id: ev.id, by: this.selfId }); // HIT is sent only to the shooter
      } else {
        out.push(ev);
      }
    }
    return out;
  }
}

export { EV, WEAPON_NAME, TEAM_NAME };
