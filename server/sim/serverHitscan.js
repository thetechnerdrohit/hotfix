// ============================================================================
// server/sim/serverHitscan.js — server-authoritative shooting with LAG
// COMPENSATION. The client NEVER claims a hit; it sends fire INTENT (via its
// input command's fire bits + look yaw/pitch). The server runs the REAL
// WeaponSystem state machine (cooldown / mag / reload / ADS / burst / spread —
// all shared math) and, when it fires, casts the REAL hitscan against targets
// REWOUND to where the shooter saw them.
//
// LAG-COMP MODEL (v1): rewind time = (shooter.rtt / 2) + interpDelay (100 ms).
// The client renders remote entities ~interpDelay in the past and its packets
// take ~rtt/2 to arrive, so at the instant the client pulled the trigger the
// enemies were at (now − rtt/2 − interpDelay) on the server timeline. We look up
// each enemy's recorded pose at that time from the ring buffer, TEMPORARILY move
// its hitboxes there, let weapons.update() cast + applyDamage through the normal
// path, then RESTORE the live poses. Damage is applied to the LIVE entity (hp is
// authoritative-now); only the geometry the ray tests is historical.
//
// Why rewind-in-place instead of re-casting? It keeps the ENTIRE real fire path
// (weapons._fire → castRay → applyDamage → onKill/onShotResolved, incl. spread
// bloom, falloff, headshot, knife backstab) intact and identical to
// single-player. The only server-specific bit is which coordinates the target
// AABBs carry during the cast.
//
// v1 SIMPLIFICATIONS (documented, deferred): (a) rewind granularity is the tick
// (33 ms) — no sub-tick interpolation between two recorded frames; we snap to
// the nearest recorded frame ≤ the rewind time. (b) rtt is a smoothed estimate
// from ping, floored at 0. (c) world geometry is static, so only character AABBs
// are rewound (walls never move). These are fine for a first online cut and are
// the standard "good enough" lag-comp; sub-tick lerp is the obvious v2.
// ============================================================================

import * as THREE from 'three';
import { NET } from '../../src/net/protocol.js';

const _pos = new THREE.Vector3();

// Ring buffer of per-tick fighter poses for rewind. We store, per recorded
// frame: gameTime + a flat array of {id, x,y,z, yaw, dead} snapshots. Sized to
// cover lagCompWindowMs at the tick rate.
export class LagCompensator {
  constructor() {
    this.capacity = Math.ceil((NET.lagCompWindowMs / 1000) * NET.tickRate) + 2;
    this.frames = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) this.frames[i] = { gt: -1, poses: new Map() };
    this.head = 0;
    this.count = 0;
  }

  // Record the current pose of every combatant this tick.
  record(combatants, gt) {
    const frame = this.frames[this.head];
    frame.gt = gt;
    // Reuse the map; overwrite entries. Store feet pos (hitboxes derive from it).
    for (const c of combatants) {
      let e = frame.poses.get(c.id);
      if (!e) { e = { x: 0, y: 0, z: 0, dead: false }; frame.poses.set(c.id, e); }
      e.x = c.pos.x; e.y = c.pos.y; e.z = c.pos.z; e.dead = c.dead;
    }
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  // Return the recorded pose for `id` at the frame nearest to (but not after)
  // gameTime `atGt`, or null if we have no history that old (fall back to live).
  poseAt(id, atGt) {
    let best = null, bestDelta = Infinity;
    for (let i = 0; i < this.count; i++) {
      const f = this.frames[i];
      if (f.gt < 0 || f.gt > atGt) continue;
      const d = atGt - f.gt;
      if (d < bestDelta) {
        const p = f.poses.get(id);
        if (p) { best = p; bestDelta = d; }
      }
    }
    return best;
  }
}

// Run the human's REAL weapon update with lag-compensated target geometry.
// Called once per sim step for a human, AFTER its controller has moved.
//   ctx: HumanCtx  ·  dt: this step's dt  ·  match: ServerMatch  ·  gt: game time
export function serverHumanFire(ctx, dt, match, gt) {
  const targets = ctx.weapons.targets; // the human's live enemy list (already set)
  if (!targets || targets.length === 0) {
    // No enemies to rewind — run the state machine anyway (cooldown/reload/ADS
    // must still advance; a shot into empty space resolves as a miss).
    ctx.weapons.update(dt, ctx.input, ctx.controller);
    return;
  }

  // Rewind time on the server timeline (seconds).
  const rewind = (ctx.rtt || 0) / 2 / 1000 + NET.interpDelayMs / 1000;
  const atGt = gt - rewind;

  // Snapshot LIVE hitbox state so we can restore it after the cast. We move the
  // feet pos of each target to its historical position and refresh its hitboxes;
  // both bots and the PlayerEntity expose refresh()/_refreshHitboxes.
  const saved = [];
  for (const t of targets) {
    const hist = match.lagComp.poseAt(t.id, atGt);
    if (!hist || hist.dead) continue;
    saved.push({ t, x: t.pos.x, y: t.pos.y, z: t.pos.z });
    t.pos.set(hist.x, hist.y, hist.z);
    _refreshTargetHitbox(t);
  }

  // Fire through the REAL path (spread/bloom/falloff/headshot/backstab + F1
  // applyDamage all happen here). Damage lands on the LIVE entity (hp is now).
  ctx.weapons.update(dt, ctx.input, ctx.controller);

  // Restore live poses + hitboxes.
  for (const s of saved) {
    s.t.pos.set(s.x, s.y, s.z);
    _refreshTargetHitbox(s.t);
  }
}

function _refreshTargetHitbox(t) {
  if (typeof t._refreshHitboxes === 'function') t._refreshHitboxes(); // Bot
  else if (typeof t.refresh === 'function') t.refresh();               // PlayerEntity
}
