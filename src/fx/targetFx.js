// ============================================================================
// TargetFx — the render-side reaction pass for the practice dummies (feedback
// ladder item 3: "target reaction — flinch + colour flash"). It READS the
// dummies' game-logic state (`.flinch` > 0, `.dead`) and drives their materials'
// emissive; it never mutates targets.js game logic (hard constraint). Keeping
// this separate means targets.js stays pure combat state and this file owns the
// look.
//
// Zero per-frame allocations (I1): the dummies' materials are Lambert (they have
// an `emissive` Color we can set in place); we only write existing color objects
// and scalars. One update(dt) ticked from main while PLAYING.
//
// flinch is already a game-time countdown owned by the Dummy (B6/E15); we just
// map its remaining value to an emissive punch that fades with it. On death the
// Dummy sinks/shrinks itself; we add a brief white "hit" tint at the moment of
// death so the kill reads on the body too.
// ============================================================================

import { TARGETS } from '../config.js';

// Flinch = hot red flash (reads as "hit"); death = a brief white pop. Stored as
// plain linear RGB triplets so the compose is per-channel scalar math (a
// THREE.Color has no vector add helpers). MeshLambertMaterial.emissive is set
// via setRGB, treated as already-linear (the material's emissive is linear).
const FLINCH_RGB = [1.0, 0.353, 0.302]; // ~0xff5a4d
const DEAD_RGB = [1.0, 1.0, 1.0];

export class TargetFx {
  constructor(targets) {
    this.targets = targets;
    // Per-dummy tiny render state, indexed to match the targets array. No alloc
    // in update() — this map is built once here.
    this.state = targets.map(() => ({ wasDead: false, deathFlash: 0 }));
  }

  update(dt) {
    const t = this.targets;
    for (let i = 0; i < t.length; i++) {
      const d = t[i];
      const s = this.state[i];

      // Detect the death edge (dead flag flips true) → a short bright pop.
      if (d.dead && !s.wasDead) s.deathFlash = 0.18;
      // Detect respawn edge (dead → alive) → clear any lingering tint.
      if (!d.dead && s.wasDead) s.deathFlash = 0;
      s.wasDead = d.dead;

      if (s.deathFlash > 0) s.deathFlash = Math.max(0, s.deathFlash - dt);

      // Compose the emissive: flinch (red, from the game-time flinch flag) plus
      // the death pop (white). Both fade to nothing → resting look is unlit.
      const flinchAmt = d.flinch > 0 ? (d.flinch / TARGETS.flinchTime) * 0.9 : 0;
      const deathAmt = s.deathFlash > 0 ? (s.deathFlash / 0.18) * 1.0 : 0;

      this._apply(d.bodyMesh, flinchAmt, deathAmt);
      this._apply(d.headMesh, flinchAmt, deathAmt);
    }
  }

  _apply(mesh, flinchAmt, deathAmt) {
    if (!mesh || !mesh.material || !mesh.material.emissive) return;
    const e = mesh.material.emissive;
    if (flinchAmt <= 0 && deathAmt <= 0) {
      if (e.r !== 0 || e.g !== 0 || e.b !== 0) e.setRGB(0, 0, 0); // snap to rest; skip writes once settled
      return;
    }
    // emissive = flinch*red + death*white, per channel (Color has no vector add).
    e.setRGB(
      FLINCH_RGB[0] * flinchAmt + DEAD_RGB[0] * deathAmt,
      FLINCH_RGB[1] * flinchAmt + DEAD_RGB[1] * deathAmt,
      FLINCH_RGB[2] * flinchAmt + DEAD_RGB[2] * deathAmt,
    );
  }
}
