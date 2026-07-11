// ============================================================================
// First-person camera rig: yaw/pitch with a hard pitch clamp, sensitivity as
// a multiplier on a baseline rad-per-count, sprint FOV kick and landing dip
// (C9/C11) — both exponential/spring smoothed so every fps feels identical.
//
// Weapon RECOIL (Phase 2) lives here as a SEPARATE offset from the player's own
// aim: applyRecoil(kickDeg) adds to a recoilOffset (pitch-up + tiny yaw jitter),
// which decays back toward zero at COMBAT.recoilRecovery (§4B Valorant-style
// re-center — recovery returns TOWARD the original aim, never climbs). Mouse
// input still owns this.pitch/this.yaw; the recoil is added ONLY to the rendered
// rotation, and the pitch clamp is honored on the composed result. So spending a
// mag walks the view up, and when you stop it settles back exactly where you
// were aiming — the recoil never permanently bleeds into the player's aim state.
//
// DAMAGE SHAKE (Phase 3, §4B "small camera shake on taking damage") uses the
// EXACT same discipline: addShake(amount) raises a decaying envelope; the shake
// is an oscillating offset composited into the RENDERED rotation + position only
// (never into this.yaw/this.pitch/player.pos), so like recoil it can't corrupt
// aim or the movement collider. Subtle by design — information, not punishment.
// Its phase advances on the frame dt passed to follow(); envelope decays exp
// (B2) so 30 fps and 240 Hz shake identically.
//
// DEATH CAM (§4B "death → camera drop/tilt (~0.6 s)", the deferred camera item)
// is the SAME pattern a third time: setDeathTilt(on) sets a 0/1 target and the
// envelope (deathTilt) eases toward it — up over deathCamTime on death, back down
// over deathCamClearTime on respawn. It composites a downward eye DROP + a screen
// ROLL (rotation.z, applied last in the YXZ order → a true screen-space roll)
// into the RENDERED transform only. Player aim (this.yaw/this.pitch) and the
// collider are never touched, so the underlying aim survives the whole death and
// the respawn snaps it back clean. Frame-rate independent (exp ease, B2).
// ============================================================================

import * as THREE from 'three';
import { MOVE, FEEL, INPUT, COMBAT, ADS } from '../config.js';
// K3 clamp: the step-eye offset can never exceed one full step's worth of dip
// (a stair burst can't sink the eye into the floor). Module const — no alloc.
const STEP_EYE_MIN = -MOVE.stepHeight;

const PITCH_LIMIT = THREE.MathUtils.degToRad(INPUT.pitchLimitDeg);

// Two irrational multipliers so the pitch/yaw/position shake axes don't move in
// lockstep (a single sine reads as a pure tilt, not a rattle). Module const —
// no per-frame alloc (I1).
const _SHAKE_KX = 1.0;
const _SHAKE_KY = 1.37;
const _SHAKE_KP = 0.61;

export class FpsCamera {
  constructor(aspect, fov) {
    this.camera = new THREE.PerspectiveCamera(fov ?? FEEL.fovBase, aspect, 0.05, 200);
    this.camera.rotation.order = 'YXZ';
    this.yaw = 0;
    this.pitch = 0;
    this.sensitivity = 1.0;
    this.fovBase = fov ?? FEEL.fovBase;
    this.fovCurrent = this.fovBase;
    this.dip = 0; // landing-dip spring state
    this.dipVel = 0;
    this.stepEye = 0; // K3: eye-height offset (m, ≤0) absorbing step-up pos.y pops; when the feet jump UP a step this pushes the eye DOWN by that delta, then decays to 0 (MOVE.stepEyeSmooth) so the view glides up smoothly instead of snapping. Same discipline as the landing dip — cosmetic, never touches aim/collider/pos.

    // Recoil offset (radians), separate from this.pitch/this.yaw. Added to the
    // rendered rotation only; recovered toward 0 each frame (§4B re-center).
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this._yawJitterSign = 1; // alternates so horizontal kick doesn't drift one way

    // Damage-shake envelope (§4B). shakeAmp is the current amplitude (rad),
    // decaying exp toward 0; shakePhase is the oscillator accumulator advanced by
    // dt. Composited into the RENDERED transform only (like recoil) — see follow().
    this.shakeAmp = 0;
    this.shakePhase = 0;

    // Death-cam envelope (§4B). deathTilt eases 0→1 (dead) or 1→0 (respawn)
    // toward deathTiltTarget; the drop/roll are scaled by it, composited into the
    // RENDERED transform only (like shake/recoil). Never touches aim/collider.
    this.deathTilt = 0;
    this.deathTiltTarget = 0;

    // ADS (register group L) — main.js sets these each PLAYING frame from the
    // weapon system BEFORE applyMouse/follow run: adsBlend is the eased 0→1
    // aim amount; adsZoomDeg is the active weapon's FOV reduction. Both default
    // to a true no-op (blend 0), so a non-aiming frame behaves exactly as before.
    this.adsBlend = 0;
    this.adsZoomDeg = ADS.zoomDeg;
  }

  // main.js pushes the weapon system's eased ADS state here once per PLAYING
  // frame, before applyMouse + follow (L6/L7). Kept as a tiny setter so the
  // camera stays the one place FOV + sensitivity compose.
  setAds(blend, zoomDeg) {
    this.adsBlend = blend;
    this.adsZoomDeg = zoomDeg;
  }

  applyMouse(dx, dy) {
    // L7: sensitivity scales CONTINUOUSLY with the ADS blend (lerp 1→sensMult),
    // so the slowdown tracks the zoom in with no threshold pop. Chosen over a
    // blend>0.5 step because a proportional slow reads as "the more I'm zoomed,
    // the finer my aim" — and it can't jump mid-blend. (A true zoom-proportional
    // sens would divide by the FOV ratio; a flat multiplier is the CS/Valorant
    // convention players expect, and it's what the tuner exposes.)
    const sensMult = 1 + (ADS.sensMult - 1) * this.adsBlend;
    const s = INPUT.radPerCount * this.sensitivity * sensMult;
    this.yaw -= dx * s;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * s, -PITCH_LIMIT, PITCH_LIMIT);
  }

  // Weapon fire kick (kickDeg from onFire's recoilDeg). Mostly pitch-up with a
  // small alternating horizontal jitter. Pushed into the offset — NOT into
  // this.pitch — so recovery returns to the player's real aim (§4B).
  applyRecoil(kickDeg) {
    if (!kickDeg) return;
    const kick = THREE.MathUtils.degToRad(kickDeg);
    this.recoilPitch += kick;                       // pitch UP (added to rendered pitch)
    this._yawJitterSign = -this._yawJitterSign;
    this.recoilYaw += kick * 0.25 * this._yawJitterSign; // small L/R wobble
  }

  // Damage shake (§4B): raise the shake envelope by `amount` radians, capped so
  // a big hit rattles but never seizes (FEEL.shakeMax). The frontend calls this
  // from the onDanger payload, amplitude ∝ damage. Additive so stacked hits
  // build (then cap) — the envelope decays in follow(). Like recoil, this only
  // ever touches the RENDERED transform; aim + collider are untouched.
  addShake(amount) {
    if (!amount) return;
    this.shakeAmp = Math.min(FEEL.shakeMax, this.shakeAmp + amount);
  }

  // Death cam (§4B): on=true tilts the view (drop + roll) in over deathCamTime;
  // on=false eases it back out over deathCamClearTime. Only sets the target — the
  // envelope is advanced in follow() so it's frame-rate independent (B2) and the
  // eased result is composited into the RENDERED transform ONLY (never aim). Wired
  // by main.js from match.onPlayerDeath (on) / onPlayerRespawn (off).
  setDeathTilt(on) {
    this.deathTiltTarget = on ? 1 : 0;
  }

  follow(player, dt) {
    // Landing dip: impulse on touchdown, damped spring back to zero (C9)
    if (player.landImpact > FEEL.landDipMinSpeed) {
      this.dipVel -= player.landImpact * FEEL.landDipScale;
    }
    this.dipVel += (-FEEL.dipStiffness * this.dip - FEEL.dipDamping * this.dipVel) * dt;
    this.dip = Math.max(this.dip + this.dipVel * dt, -0.3);

    // Step-up eye smoothing (K3): the controller reports metres pos.y jumped up
    // this frame (stepRise, 0 on flat ground). Push the eye DOWN by that delta so
    // the WORLD eye height (player.pos.y + this) doesn't jump, then decay the
    // offset back to 0 (exp, B2) so the view rises smoothly. Clamped so a fast
    // stair run can't stack the dip past one step. player.stepRise is undefined
    // on non-controller followers (e.g. death cam target) — guarded with ?? 0.
    this.stepEye = Math.max(STEP_EYE_MIN, this.stepEye - (player.stepRise ?? 0));
    this.stepEye += (0 - this.stepEye) * (1 - Math.exp(-MOVE.stepEyeSmooth * dt));
    if (this.stepEye > -1e-4) this.stepEye = 0;

    // FOV target = sprint kick (C11) composed with the ADS zoom (L6). ADS WINS
    // over the sprint kick: the sprint add is faded out by the blend, then the
    // zoom is subtracted, so a full aim is base − zoom with no sprint widening.
    // Clamp to ADS.minFovDeg so a low FOV slider + zoom can't over-crop the view
    // (never below ~40°). At blend 0 this reduces to the exact pre-ADS target.
    const sprintAdd = (player.sprinting ? FEEL.fovSprintAdd : 0) * (1 - this.adsBlend);
    const zoom = this.adsZoomDeg * this.adsBlend;
    const fovTarget = Math.max(ADS.minFovDeg, this.fovBase + sprintAdd - zoom);
    // Snappier easing while blended so the zoom keeps up with the fast adsBlend
    // (they read the same feel); the sprint kick alone stays at its gentle rate.
    const fovRate = 10 + 8 * this.adsBlend;
    this.fovCurrent += (fovTarget - this.fovCurrent) * (1 - Math.exp(-fovRate * dt));
    if (Math.abs(this.camera.fov - this.fovCurrent) > 0.01) {
      this.camera.fov = this.fovCurrent;
      this.camera.updateProjectionMatrix();
    }

    // Recoil recovery: pull the offset back toward zero (exp decay, frame-rate
    // independent, B2). Recovery targets the ORIGINAL aim so the view re-centers
    // rather than permanently climbing (§4B). Rate is COMBAT.recoilRecovery.
    const rk = Math.exp(-COMBAT.recoilRecovery * dt);
    this.recoilPitch *= rk;
    this.recoilYaw *= rk;
    if (Math.abs(this.recoilPitch) < 1e-5) this.recoilPitch = 0;
    if (Math.abs(this.recoilYaw) < 1e-5) this.recoilYaw = 0;

    // Damage-shake envelope: decay the amplitude (exp, B2) and advance the phase.
    // Compute the three shake offsets from one envelope × de-phased sines so the
    // rattle isn't a pure tilt. All composited below into the RENDERED transform
    // only — never into this.pitch/this.yaw/player.pos (like recoil).
    let shakePitch = 0, shakeYaw = 0, shakePosX = 0, shakePosY = 0;
    if (this.shakeAmp > 1e-5) {
      this.shakePhase += dt * FEEL.shakeFreq;
      this.shakeAmp *= Math.exp(-FEEL.shakeDecay * dt);
      if (this.shakeAmp < 1e-5) this.shakeAmp = 0;
      const a = this.shakeAmp;
      shakePitch = Math.sin(this.shakePhase * _SHAKE_KX) * a;
      shakeYaw = Math.sin(this.shakePhase * _SHAKE_KY + 1.3) * a;
      // Positional jiggle is a small fraction of the angular amp (metres), so the
      // eye trembles a touch without visibly leaving the head.
      shakePosX = Math.sin(this.shakePhase * _SHAKE_KP + 0.7) * a * 0.35;
      shakePosY = Math.cos(this.shakePhase * _SHAKE_KY) * a * 0.25;
    }

    // Death-cam envelope (§4B): ease deathTilt toward its 0/1 target. Rate comes
    // from the configured time (≈99% reached in deathCamTime in / deathCamClearTime
    // out) so the curve is smooth AND frame-rate independent (exp approach, B2).
    // The eased value scales the drop + roll below — composited into the rendered
    // transform ONLY (aim/collider untouched, like shake/recoil).
    if (this.deathTilt !== this.deathTiltTarget) {
      const goingIn = this.deathTiltTarget > this.deathTilt;
      const time = goingIn ? FEEL.deathCamTime : FEEL.deathCamClearTime;
      // 4.6 ≈ −ln(0.01): the envelope covers ~99% of the gap in `time` seconds.
      const k = 1 - Math.exp(-(4.6 / Math.max(1e-3, time)) * dt);
      this.deathTilt += (this.deathTiltTarget - this.deathTilt) * k;
      if (Math.abs(this.deathTiltTarget - this.deathTilt) < 1e-4) this.deathTilt = this.deathTiltTarget;
    }
    const deathDrop = this.deathTilt * FEEL.deathCamDrop;   // metres the eye sinks
    const deathRoll = this.deathTilt * FEEL.deathCamRoll;   // rad screen-space roll

    this.camera.position.set(
      player.pos.x + shakePosX,
      player.pos.y + MOVE.eyeHeight + this.dip + this.stepEye + shakePosY - deathDrop,
      player.pos.z,
    );
    // Rendered rotation = player aim + recoil offset + damage shake (+ death roll
    // on z). Mouse still owns this.yaw/this.pitch (untouched above); recoil, shake,
    // and the death tilt are layered on only here. The pitch clamp is honored on
    // the COMPOSED value so none can blow past ±89°. rotation.z is a pure screen
    // roll (applied last in the YXZ order) — the death lean.
    this.camera.rotation.y = this.yaw + this.recoilYaw + shakeYaw;
    this.camera.rotation.x = THREE.MathUtils.clamp(this.pitch + this.recoilPitch + shakePitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.camera.rotation.z = deathRoll;
  }

  setFov(fov) {
    this.fovBase = fov;
  }

  setAspect(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
