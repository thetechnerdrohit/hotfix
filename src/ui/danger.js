// ============================================================================
// DangerStack — the "getting shot" presentation (§4B "danger must answer from
// WHERE in under 200 ms"). Two layers, both DOM overlay (G1), both driven per
// frame via transform/opacity ONLY (G2):
//
//   1) DIRECTIONAL WEDGES (F7): a pool of dangerWedgeCount DOM chevrons around
//      the crosshair. On a hit WITH a source, claim a wedge (reuse the OLDEST)
//      and COPY the damage source position into the slot. EVERY FRAME each live
//      wedge reprojects its screen angle from (sourcePos − cameraPos) against the
//      camera's yaw — so turning while it fades keeps it truthful. transform:
//      rotate() only. A source directly above/below projects onto the horizontal
//      plane (its XZ offset is ~0 → we fall back to "dead ahead" not a wild spin).
//
//   CONTRACT (backend amendment): the onDanger payload is TRANSIENT — both the
//   object and its sourcePos Vector3 are REUSED every hit. onDamage() therefore
//   copies the source SCALARS synchronously on receipt (never retains the ref),
//   exactly like onShotResolved copies its reused hit result. A hit with
//   hasSource=false (no attacker / future non-positional hazard) has stale
//   sourcePos → we pulse the vignette but claim NO wedge.
//
//   2) HURT VIGNETTE (F8): a fullscreen radial-red overlay whose opacity pulses
//      by damage amount (34 reads harder than 10), re-triggering WITHOUT additive
//      white-out (hard alpha cap), decaying on RAW dt.
//
// Camera shake + the incoming-hit sound are NOT owned here (they live on the
// camera + audio engine); main.js calls those from the same onDanger payload so
// all three read one event. This module is pure DOM feel.
//
// Zero per-frame allocations (I1): the wedge pool is built once; reprojection
// uses only scalars (no THREE vectors needed — plain XZ trig). Timers tick on
// RAW dt (danger is information; it must not freeze in a hit-stop or pause).
// ============================================================================

import { FEEL } from '../config.js';

const RAD2DEG = 180 / Math.PI;

export class DangerStack {
  /**
   * @param {{ yaw:number, camera:{ position:{x:number,z:number} } }} cam  FpsCamera
   */
  constructor(cam) {
    this.cam = cam;

    // Hurt vignette element + its decaying alpha (F8).
    this.hurtEl = document.getElementById('hurt-vignette');
    this.hurt = 0;               // current vignette alpha (0..dangerVignetteMax)
    this._lastHurt = -1;         // last value written (skip redundant writes)

    // Wedge pool. Each entry holds the DOM node + the COPIED source XZ (F7) +
    // remaining life. `active` false ⇒ free. `seq` orders them so a new hit past
    // the pool size reuses the OLDEST (§4B "pool of 4, reuse oldest").
    const nodes = document.querySelectorAll('#danger-wedges .danger-wedge');
    this.wedges = [];
    for (let i = 0; i < nodes.length; i++) {
      this.wedges.push({
        el: nodes[i], active: false, life: 0, seq: 0,
        sx: 0, sz: 0,          // COPIED source XZ (world) — held across frames (F7)
        lastDeg: 9999,         // last rotate() written (skip redundant writes)
        lastOp: -1,            // last opacity written
      });
    }
    this._seq = 0;
    this._radiusPx = FEEL.dangerWedgeRadiusPx;
  }

  // --- Event: a hit landed (called from main's onDanger handler) ------------
  // amount scales the vignette pulse. hasSource says whether sourcePos is a real
  // attacker position (the payload is TRANSIENT — sourcePos is a REUSED vector,
  // stale when hasSource is false). We read sourcePos SYNCHRONOUSLY here and copy
  // only the scalars into the pooled slot — never retain the reference (F7). A
  // hit with no source (hasSource=false) still flashes the vignette but spawns
  // no wedge (there's no direction to point at).
  onDamage(amount, hasSource, sourcePos) {
    // Vignette pulse: scale by damage, floor so a small tick still reads, then
    // CAP so stacked hits never white-out (F8). Re-trigger = max, not add.
    const pulse = Math.min(
      FEEL.dangerVignetteMax,
      Math.max(FEEL.dangerVignetteMinPulse, amount * FEEL.dangerVignettePerDmg),
    );
    if (pulse > this.hurt) this.hurt = pulse; // re-trigger toward the target, never sum

    if (!hasSource || !sourcePos) return; // no attacker → vignette only, no wedge

    // Claim a wedge: a free one, else the OLDEST active (smallest seq).
    let slot = null;
    for (let i = 0; i < this.wedges.length; i++) {
      if (!this.wedges[i].active) { slot = this.wedges[i]; break; }
    }
    if (!slot) {
      slot = this.wedges[0];
      for (let i = 1; i < this.wedges.length; i++) {
        if (this.wedges[i].seq < slot.seq) slot = this.wedges[i];
      }
    }
    slot.active = true;
    slot.life = FEEL.dangerWedgeMs / 1000;
    slot.seq = ++this._seq;
    // COPY the scalars NOW (the payload's sourcePos vector is reused by the next
    // hit — holding the ref would make the wedge point at the wrong attacker).
    slot.sx = sourcePos.x;
    slot.sz = sourcePos.z;
  }

  // --- Per-frame tick (RAW dt) ----------------------------------------------
  // Reproject every live wedge against the current camera yaw + position (F7),
  // fade both wedge + vignette. transform/opacity only (G2).
  tick(rawDt) {
    // Hurt vignette decay (exp, raw dt — a felt "sting" that eases off).
    if (this.hurt > 0) {
      this.hurt *= Math.exp(-FEEL.dangerVignetteDecay * rawDt);
      if (this.hurt < 0.004) this.hurt = 0;
    }
    const hv = Math.round(this.hurt * 1000) / 1000;
    if (hv !== this._lastHurt) {
      this._lastHurt = hv;
      this.hurtEl.style.setProperty('--hurt', String(hv));
    }

    // Wedges: reproject + fade.
    const camX = this.cam.camera.position.x;
    const camZ = this.cam.camera.position.z;
    const yaw = this.cam.yaw;
    // Camera forward + right in XZ (matches camera.js: fwd = (−sin, −cos)).
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw); // right-hand: right = fwd rotated −90° about +Y

    for (let i = 0; i < this.wedges.length; i++) {
      const w = this.wedges[i];
      if (!w.active) continue;
      w.life -= rawDt;
      if (w.life <= 0) {
        w.active = false;
        if (w.lastOp !== 0) { w.el.style.opacity = '0'; w.lastOp = 0; }
        continue;
      }
      // Direction from camera to the (held) source, in XZ.
      const dx = w.sx - camX, dz = w.sz - camZ;
      const f = dx * fx + dz * fz;    // forward component (ahead > 0)
      const r = dx * rx + dz * rz;    // right component (right > 0)
      // Screen bearing: 0° points UP (source dead ahead), +CW toward the right.
      // Source directly above/below (dx≈dz≈0) → f≈r≈0 → atan2(0,0)=0 → "ahead",
      // the horizontal-plane fallback the spec calls for (no wild spin).
      const deg = Math.atan2(r, f) * RAD2DEG;
      const dr = Math.round(deg * 2) / 2; // half-degree granularity (skip churn)
      if (dr !== w.lastDeg) {
        w.lastDeg = dr;
        // rotate about the crosshair centre, then push out to the ring. The
        // wedge's ::before tip points up at rotate(0) (see CSS).
        w.el.style.transform = `rotate(${dr}deg) translateY(-${this._radiusPx}px)`;
      }
      const op = Math.round((w.life / (FEEL.dangerWedgeMs / 1000)) * 100) / 100;
      if (op !== w.lastOp) { w.lastOp = op; w.el.style.opacity = String(op); }
    }
  }

  // Hard reset on respawn / match restart — clear every wedge + the vignette so
  // nothing lingers into the next life (F9-style clean snap; the vignette also
  // decays on its own, but a respawn should be instant).
  reset() {
    this.hurt = 0;
    for (let i = 0; i < this.wedges.length; i++) {
      const w = this.wedges[i];
      w.active = false; w.life = 0;
      if (w.lastOp !== 0) { w.el.style.opacity = '0'; w.lastOp = 0; }
    }
  }
}
