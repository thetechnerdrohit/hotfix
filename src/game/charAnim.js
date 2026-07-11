// ============================================================================
// CharAnim — the tiny procedural, transform-only animator for a single bot
// figure (SE dev or Bug creature). It owns NO game state: a Bot constructs one,
// hands it precomputed limb-mesh references + a set of tintable materials, and
// ticks it once per frame with (dt, horizontal speed, flinchAmt, deathAmt).
//
// Animation discipline (B2/B6, I1):
//   • Transform-ONLY — rotates/positions cosmetic child meshes. It NEVER touches
//     hitboxes, colliders, nav, or the group's world position/yaw (the Bot owns
//     those; they are FROZEN for v1.1). Limbs live in the group's LOCAL space, so
//     the Bot yawing the whole group carries them for free.
//   • Game-time dt, exp-smoothed limb targets (1 − e^(−k·dt)) — a 30 fps potato
//     and a 240 Hz monitor animate identically; pauses freeze it cleanly.
//   • ZERO per-frame allocations: all limb refs + the phase accumulator are set
//     up once at construction; tick() only writes existing rotation/position
//     scalars and existing material.emissive Color objects (setRGB, no new()).
//
// Flinch/death tint (item 5 — the FX-compat contract): bots have no separate
// render-fx pass (unlike the practice dummies' TargetFx), so this animator IS
// their flinch/death flash. It walks the `tintMats` list — every Lambert body/
// limb material of the figure — and drives their `emissive` from the amounts the
// Bot computes off its game-time `flinch` flag + the death edge. Basic materials
// (the CanvasTexture label/visor) are excluded from the list, so the badge text
// stays legible and unlit. Same red-flinch / white-death compose as TargetFx.
// ============================================================================

import * as THREE from 'three';
import { CHARACTER } from '../config.js';

// Flinch = hot red (0xff5a4d), death = white pop — matches TargetFx exactly so
// SE bots + Bug bots + practice dummies all read identically on a hit.
const FLINCH_RGB = [1.0, 0.353, 0.302];
const DEAD_RGB = [1.0, 1.0, 1.0];

const DEG = Math.PI / 180;

export class CharAnim {
  /**
   * @param {'se'|'bug'} team
   * @param {object} rig  precomputed refs from the Bot's mesh build:
   *   { legs: Mesh[], arms?: Mesh[], antennae?: Mesh[], bobGroup: Object3D,
   *     legRestY: number[], tintMats: Material[] }
   *   - legs/arms/antennae: the swinging child meshes (their rest rotation.x is 0)
   *   - bobGroup: an Object3D wrapping the body so the whole torso can bob in Y
   *     without moving the group origin (feet stay put; hitboxes are unaffected)
   *   - tintMats: every Lambert material to flash on flinch/death
   * @param {number} index  roster index — seeds a per-bot phase offset (desync)
   */
  constructor(team, rig, index) {
    this.team = team;
    this.rig = rig;
    // Per-bot stride phase — offset so the whole roster doesn't animate in
    // lockstep. Advanced on game dt in tick(), never wall-clock.
    this._phase = (index * 0.618) % 1 * Math.PI * 2;
    this._bobBaseY = rig.bobGroup.position.y; // remember rest Y so bob is relative
    // Death-edge tracking so the white pop fires once, like TargetFx.
    this._wasDead = false;
    this._deathFlash = 0;
  }

  // dt: game seconds. speed: horizontal m/s. flinch: the Bot's game-time flinch
  // seconds remaining. flinchTime: the tuning window (to normalise). dead: bool.
  tick(dt, speed, flinch, flinchTime, dead) {
    const c = CHARACTER;
    const runFrac = Math.min(1, speed / 5.0); // 5 = MOVE.runSpeed; cosmetic scale only

    // Advance the stride phase: frequency scales with actual speed (a faster
    // figure steps faster). When standing, a slow idle bob rate keeps it alive.
    const moving = speed > c.strideMinSpeed;
    const hz = moving
      ? c.strideHz * (0.4 + 0.6 * runFrac) * (this.team === 'bug' ? c.bugSkitterHzMult : 1)
      : c.bobHz;
    this._phase += dt * hz * Math.PI * 2;
    // Keep the accumulator bounded (avoid float drift over a long match) — I1
    // safe, no alloc.
    if (this._phase > 1e6) this._phase -= 1e6;

    const s = Math.sin(this._phase);
    const sHalf = Math.sin(this._phase * 0.5); // slower body-bob component
    const k = 1 - Math.exp(-c.animSmooth * dt); // ease factor toward targets

    // --- Body bob (vertical only, inside bobGroup — feet + hitbox unaffected) --
    const bobAmp = (this.team === 'bug' ? c.bobAmpBody * c.bugBodyBobMult : c.bobAmpBody)
      * (moving ? runFrac : 0.35); // a little idle breathing even when still
    const bobY = this._bobBaseY + Math.abs(s) * bobAmp;
    const bg = this.rig.bobGroup;
    bg.position.y += (bobY - bg.position.y) * k;

    // --- Legs: alternating swing. SE = human fore/aft walk; Bug = tripod skitter.
    const legs = this.rig.legs;
    if (this.team === 'se') {
      const swing = c.seLegSwingDeg * DEG * (moving ? runFrac : 0) ;
      for (let i = 0; i < legs.length; i++) {
        const target = swing * (i % 2 === 0 ? s : -s); // left/right anti-phase
        legs[i].rotation.x += (target - legs[i].rotation.x) * k;
      }
      // Arms counter-swing (opposite the legs) — small, they're holding a rifle.
      const arms = this.rig.arms;
      if (arms) {
        const armSwing = (moving ? c.seArmSwingDeg * runFrac : c.seIdleArmSwayDeg) * DEG;
        for (let i = 0; i < arms.length; i++) {
          const target = armSwing * (i % 2 === 0 ? -s : s);
          arms[i].rotation.x += (target - arms[i].rotation.x) * k;
        }
      }
    } else {
      // Bug: 6 legs in two alternating tripod sets (front-left/mid-right/rear-left
      // vs the mirror). Index parity picks the set; the skitter is sharper/faster.
      const swing = c.bugLegSkitterDeg * DEG * (moving ? (0.4 + 0.6 * runFrac) : 0.12);
      for (let i = 0; i < legs.length; i++) {
        const set = (i % 2 === 0) ? s : -s; // alternating tripod
        legs[i].rotation.x += (set * swing - legs[i].rotation.x) * k;
      }
      // Antennae sway — driven by speed with a constant idle wobble on top.
      const ant = this.rig.antennae;
      if (ant) {
        const sway = c.bugAntennaSwayDeg * DEG * (0.35 + 0.65 * runFrac);
        for (let i = 0; i < ant.length; i++) {
          const target = sway * (i === 0 ? sHalf : -sHalf);
          ant[i].rotation.z += (target - ant[i].rotation.z) * k;
        }
      }
    }

    // --- Flinch / death tint (this animator IS the bot's hit-flash pass) -------
    if (dead && !this._wasDead) this._deathFlash = 0.18;
    if (!dead && this._wasDead) this._deathFlash = 0;
    this._wasDead = dead;
    if (this._deathFlash > 0) this._deathFlash = Math.max(0, this._deathFlash - dt);

    const flinchAmt = flinch > 0 ? (flinch / flinchTime) * 0.9 : 0;
    const deathAmt = this._deathFlash > 0 ? (this._deathFlash / 0.18) : 0;
    this._applyTint(flinchAmt, deathAmt);
  }

  _applyTint(flinchAmt, deathAmt) {
    const mats = this.rig.tintMats;
    if (flinchAmt <= 0 && deathAmt <= 0) {
      // Snap to rest, skipping writes once already settled (cheap idle path).
      for (let i = 0; i < mats.length; i++) {
        const e = mats[i].emissive;
        if (e.r !== 0 || e.g !== 0 || e.b !== 0) e.setRGB(0, 0, 0);
      }
      return;
    }
    const r = FLINCH_RGB[0] * flinchAmt + DEAD_RGB[0] * deathAmt;
    const g = FLINCH_RGB[1] * flinchAmt + DEAD_RGB[1] * deathAmt;
    const b = FLINCH_RGB[2] * flinchAmt + DEAD_RGB[2] * deathAmt;
    for (let i = 0; i < mats.length; i++) mats[i].emissive.setRGB(r, g, b);
  }
}
