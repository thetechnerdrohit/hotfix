// ============================================================================
// src/net/prediction.js — client-side PREDICTION + RECONCILIATION for the local
// player, and INTERPOLATION buffers for remote entities. This is what makes an
// authoritative-server FPS feel local: the player's own movement is applied
// IMMEDIATELY using the SAME PlayerController math the server runs, and each
// server snapshot re-bases and replays the still-unacked inputs.
//
// It deliberately reuses the browser's REAL PlayerController (src/player/
// controller.js) so predicted movement is byte-identical to the server sim
// (same collide-and-slide, step-up, rope, gravity). No forked physics.
//
// ── LOCAL PLAYER (prediction/reconciliation) ──────────────────────────────
//   • Every input frame: build an InputCommand, apply it locally via the REAL
//     controller against the predicted colliders, and PUSH it to a pending ring.
//   • On a server snapshot for our entity: SNAP the controller to the server's
//     authoritative pos + ackSeq, then REPLAY every pending command with seq >
//     ackSeq through the same controller. The visible result: instant response,
//     silent correction when the server disagrees (misprediction → a small
//     rubber-band, rare on a LAN-ish connection).
//
// ── REMOTE ENTITIES (interpolation) ────────────────────────────────────────
//   • Each remote fighter keeps a short buffer of (renderTime, pos, yaw)
//     snapshots. We render them NET.interpDelayMs in the past, lerping between
//     the two bracketing snapshots — smooth motion despite 20 Hz updates + jitter.
//
// WIRING CONTRACT (main.js implements — see src/net/client.js banner for the
// full loop). This module is transport-agnostic: it takes snapshots/commands as
// plain objects; client.js feeds it from Colyseus.
// ============================================================================

import * as THREE from 'three';
import { MOVE } from '../config.js';
import { NET } from './protocol.js';

// ---- Local-player predictor -----------------------------------------------
export class LocalPredictor {
  /**
   * @param {import('../player/controller.js').PlayerController} controller  the REAL local controller
   * @param {{yaw:number, pitch:number}} cam
   */
  constructor(controller, cam) {
    this.controller = controller;
    this.cam = cam;
    this.pending = [];   // unacked InputCommands (ordered by seq)
    this.seq = 0;
    this.lastAck = 0;
    this._maxPending = 128;
  }

  // Build + record a command for THIS frame, apply it locally right now.
  // `dt` seconds, `input` the browser Input, `colliders` the predicted collider
  // set (static world + interpolated remote AABBs), `weapons` for switch/fire bits.
  // Returns the wire command to SEND.
  sampleAndPredict(dt, input, colliders, fireClick, reloadEdge, switchTo, keysBitmask) {
    const cmd = {
      seq: ++this.seq,
      dtMs: Math.min(NET.maxCmdDtMs, dt * 1000),
      keys: keysBitmask,
      yaw: this.cam.yaw,
      pitch: this.cam.pitch,
      jump: input.jumpQueued ? 1 : 0, // NOTE: caller reads jump via takeJump; see client.js
      reload: reloadEdge ? 1 : 0,
      fireClick: fireClick ? 1 : 0,
      switchTo: switchTo || 0,
    };
    // Apply locally with the REAL controller (yaw drives the wish dir).
    this.controller.update(dt, input, this.cam.yaw, colliders);
    this.pending.push(cmd);
    if (this.pending.length > this._maxPending) this.pending.shift();
    return cmd;
  }

  // Reconcile against the authoritative snapshot of OUR entity.
  //   serverPos: {x,y,z}, serverAckSeq: number, replayInput: an Input-shaped
  //   object the controller can re-run (see ReplayInput below), colliders.
  reconcile(serverPos, serverAckSeq, replayInput, colliders) {
    // Drop acked commands.
    this.lastAck = serverAckSeq;
    while (this.pending.length && this.pending[0].seq <= serverAckSeq) this.pending.shift();

    // Snap to authority.
    this.controller.pos.set(serverPos.x, serverPos.y, serverPos.z);

    // Replay the still-pending commands so the local view stays ahead of the
    // (older) authoritative pos by exactly the un-acked inputs.
    for (let i = 0; i < this.pending.length; i++) {
      const c = this.pending[i];
      replayInput.load(c);
      this.controller.update(c.dtMs / 1000, replayInput, c.yaw, colliders);
    }
  }
}

// A minimal Input stand-in used ONLY for reconciliation replay — feeds a stored
// command back through the controller (same surface controller.update reads).
// Mirrors ServerInput but client-side; keeps prediction math identical.
export class ReplayInput {
  constructor() { this._c = null; this.buttons = new Set(); this._jumpConsumed = false; }
  load(cmd) { this._c = cmd; this._jumpConsumed = false; }
  pressed(code) {
    const k = this._c.keys;
    switch (code) {
      case 'KeyW': return (k & (1 << 0)) !== 0;
      case 'KeyA': return (k & (1 << 1)) !== 0;
      case 'KeyS': return (k & (1 << 2)) !== 0;
      case 'KeyD': return (k & (1 << 3)) !== 0;
      case 'ShiftLeft': case 'ShiftRight': return (k & (1 << 4)) !== 0;
      default: return false;
    }
  }
  takeJump() { if (this._jumpConsumed) return false; this._jumpConsumed = true; return !!this._c.jump; }
  takePressed() { return false; } // switch/reload aren't replayed for MOVEMENT prediction
  takeMousePressed() { return false; }
  resetMouseDelta() {}
}

// ---- Remote-entity interpolation buffer -----------------------------------
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class RemoteInterpolator {
  constructor() {
    this.buffers = new Map(); // id → { snaps: [{t,x,y,z,yaw}], pos:V3, yaw }
  }

  // Ingest a server snapshot for one entity at client-clock time `nowMs`.
  ingest(id, x, y, z, yaw, nowMs) {
    let buf = this.buffers.get(id);
    if (!buf) { buf = { snaps: [], pos: new THREE.Vector3(x, y, z), yaw }; this.buffers.set(id, buf); }
    buf.snaps.push({ t: nowMs, x, y, z, yaw });
    // Keep ~500 ms of history.
    const cutoff = nowMs - 500;
    while (buf.snaps.length > 2 && buf.snaps[0].t < cutoff) buf.snaps.shift();
  }

  remove(id) { this.buffers.delete(id); }

  // Advance every buffer to renderTime = nowMs − interpDelay, writing buf.pos/yaw.
  update(nowMs) {
    const renderT = nowMs - NET.interpDelayMs;
    for (const buf of this.buffers.values()) {
      const s = buf.snaps;
      if (s.length === 0) continue;
      if (s.length === 1 || renderT <= s[0].t) {
        buf.pos.set(s[0].x, s[0].y, s[0].z); buf.yaw = s[0].yaw; continue;
      }
      if (renderT >= s[s.length - 1].t) {
        const last = s[s.length - 1];
        buf.pos.set(last.x, last.y, last.z); buf.yaw = last.yaw; continue;
      }
      // Find the bracketing pair.
      for (let i = 0; i < s.length - 1; i++) {
        const p = s[i], q = s[i + 1];
        if (renderT >= p.t && renderT <= q.t) {
          const alpha = (renderT - p.t) / Math.max(1, q.t - p.t);
          _a.set(p.x, p.y, p.z); _b.set(q.x, q.y, q.z);
          buf.pos.copy(_a).lerp(_b, alpha);
          buf.yaw = lerpAngle(p.yaw, q.yaw, alpha);
          break;
        }
      }
    }
  }

  get(id) { return this.buffers.get(id) || null; }
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
