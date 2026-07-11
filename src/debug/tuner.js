// ============================================================================
// Dev-only live tuning panel. Feel is tuned with sliders while playing, not
// by editing files — this binds lil-gui straight onto the config objects.
// The dynamic import sits behind import.meta.env.DEV, so production builds
// drop both the panel and the dependency.
// ============================================================================

import { MOVE, FEEL, COMBAT, VIEWMODEL, CROSSHAIR } from '../config.js';

export async function initTuner() {
  if (!import.meta.env.DEV) return;
  const { default: GUI } = await import('lil-gui');

  const gui = new GUI({ title: 'feel tuner (dev)' });

  const m = gui.addFolder('MOVE');
  m.add(MOVE, 'runSpeed', 2, 10, 0.1);
  m.add(MOVE, 'sprintMult', 1, 2, 0.05);
  m.add(MOVE, 'accelGround', 2, 30, 0.5);
  m.add(MOVE, 'accelAir', 0.5, 10, 0.25);
  m.add(MOVE, 'gravity', 8, 40, 0.5);
  m.add(MOVE, 'jumpHeight', 0.5, 2, 0.05);
  m.add(MOVE, 'coyoteMs', 0, 250, 10);
  m.add(MOVE, 'jumpBufferMs', 0, 250, 10);

  const f = gui.addFolder('FEEL');
  f.add(FEEL, 'fovSprintAdd', 0, 15, 0.5);
  f.add(FEEL, 'landDipScale', 0, 0.08, 0.002);
  f.add(FEEL, 'dipStiffness', 40, 300, 5);
  f.add(FEEL, 'dipDamping', 4, 30, 1);
  f.add(FEEL, 'hitStopMs', 0, 150, 5);
  f.add(FEEL, 'hitmarkerMs', 20, 200, 5);
  // Death cam (§4B deferred item) — drop/roll/ease timings, composited into the
  // rendered transform only (see camera.js). Tunable live like the rest of FEEL.
  f.add(FEEL, 'deathCamDrop', 0, 1, 0.05).name('death drop (m)');
  f.add(FEEL, 'deathCamRoll', 0, 0.8, 0.02).name('death roll (rad)');
  f.add(FEEL, 'deathCamTime', 0.1, 1.5, 0.05).name('death ease-in (s)');

  // Phase 2 combat/weapon feel — recoil kick + how fast the view re-centers.
  const c = gui.addFolder('COMBAT (feel)');
  c.add(COMBAT.rifle, 'recoilPerShot', 0, 2, 0.05).name('rifle recoilDeg');
  c.add(COMBAT.pistol, 'recoilPerShot', 0, 2, 0.05).name('pistol recoilDeg');
  c.add(COMBAT, 'recoilRecovery', 2, 20, 0.5);
  c.add(COMBAT, 'bloomDecay', 1, 15, 0.5);

  // Phase 4 RANGE MODEL — damage falloff (per weapon) + the movement spread
  // penalty. Falloff is read fresh on every shot in BOTH damage paths (player +
  // bots), so a slider tweak takes effect on the very next bullet — tune the
  // rifle lane vs the pistol corridor live. movePenaltyFrac is the shared
  // "you're moving" threshold; the per-weapon multipliers are the scatter.
  const r = gui.addFolder('COMBAT (range — Phase 4)');
  r.add(COMBAT.falloff.rifle, 'start', 5, 40, 1).name('rifle falloff start (m)');
  r.add(COMBAT.falloff.rifle, 'end', 20, 80, 1).name('rifle falloff end (m)');
  r.add(COMBAT.falloff.rifle, 'minMult', 0.2, 1, 0.05).name('rifle min mult');
  r.add(COMBAT.falloff.pistol, 'start', 4, 30, 1).name('pistol falloff start (m)');
  r.add(COMBAT.falloff.pistol, 'end', 12, 60, 1).name('pistol falloff end (m)');
  r.add(COMBAT.falloff.pistol, 'minMult', 0.2, 1, 0.05).name('pistol min mult');
  r.add(COMBAT, 'movePenaltyFrac', 0.1, 1, 0.05).name('move-penalty speed frac');
  r.add(COMBAT.spreadMovePenalty, 'rifle', 1, 4, 0.1).name('rifle move ×spread');
  r.add(COMBAT.spreadMovePenalty, 'pistol', 1, 4, 0.1).name('pistol move ×spread');

  // Viewmodel kick/sway + crosshair bloom scale (the on-screen weapon feel).
  const v = gui.addFolder('VIEWMODEL');
  v.add(VIEWMODEL, 'recoilKick', 0, 0.15, 0.005);
  v.add(VIEWMODEL, 'recoilRot', 0, 0.4, 0.01);
  v.add(VIEWMODEL, 'recoilRecover', 4, 30, 1);
  v.add(VIEWMODEL, 'followRate', 6, 40, 1);
  v.add(CROSSHAIR, 'pxPerRad', 200, 2000, 50).name('crosshair px/rad');

  gui.close(); // present but folded — one click away while feel-testing
}
