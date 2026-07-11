// ============================================================================
// Viewmodel — the low-poly first-person weapon rig. Box-primitive models for
// rifle / pistol / knife, parented to the CAMERA so they ride head movement,
// offset right-and-low. Exposes a muzzle anchor (Object3D) and getMuzzleWorldPos
// so the FX layer can start tracers / place the flash at the barrel tip (E1 —
// tracers are visual-only; the shot truth is the camera ray).
//
// ALL animation is game-time + exponential decay (B2/B6): no setTimeout, no
// per-frame constants — a 30 fps potato and a 240 Hz monitor produce identical
// motion. The rig eases toward a computed TARGET transform each frame; discrete
// events (fire, switch, reload) nudge impulse state that then decays back.
//
// This is explicitly NOT head-bob (FEEL.headBob stays false and untouched): the
// sway/bob here is a tiny weapon-only motion, not a camera move.
//
// update(dt, weapons, controller, player) is ticked from main while PLAYING.
// Reads weapons.active / weapons.state / weapons.isLowered(controller); the
// discrete kicks are pushed in by main from the weapon events (onFire etc.).
// Zero per-frame allocations (I1): module scratch + in-place writes.
// ============================================================================

import * as THREE from 'three';
import { VIEWMODEL, COMBAT, MOVE, CHARACTER, ADS } from '../config.js';

const _muzzleWorld = new THREE.Vector3();

// A small helper to build a flat-shaded Lambert box mesh at a local offset.
// Optional rotation (radians) for angled details (grips, forearms).
function box(w, h, d, x, y, z, color, rx = 0, ry = 0, rz = 0) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const mat = new THREE.MeshLambertMaterial({ color });
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (rx || ry || rz) m.rotation.set(rx, ry, rz);
  return m;
}

// v1.1 LOOKS: first-person hand/forearm hints in the palette's skin/glove tone —
// two small boxes gripping the weapon so the player's hands read on screen. Pure
// cosmetic children of the weapon rig; they do NOT move the muzzle anchor.
function addHands(g, color, gripX, gripY, gripZ, foreZ) {
  // Rear hand at the grip, forearm angled back toward the shoulder.
  g.add(box(0.06, 0.06, 0.10, gripX, gripY, gripZ, color, 0.5, 0, 0));
  // Front/support hand further down the barrel.
  g.add(box(0.06, 0.055, 0.09, gripX * 0.4, gripY + 0.005, foreZ, color, 0.3, 0, 0));
}

export class Viewmodel {
  constructor(camera) {
    this.camera = camera;

    // Root rig parented to the camera. Everything below is in camera-local space
    // (so it's always in front of the eye). matrixAutoUpdate stays ON — this
    // moves every frame.
    this.root = new THREE.Group();
    this.root.position.set(VIEWMODEL.posX, VIEWMODEL.posY, VIEWMODEL.posZ);
    camera.add(this.root);

    // Per-weapon sub-rigs; only the active one is visible. Each carries a muzzle
    // anchor Object3D at its barrel tip.
    this.rigs = {
      rifle: this._buildRifle(),
      pistol: this._buildPistol(),
      knife: this._buildKnife(),
    };
    for (const k in this.rigs) this.root.add(this.rigs[k].group);
    this.active = 'rifle';
    this._showOnly('rifle');

    // --- Animation state (all game-time, exp-decayed) ----------------------
    this.recoil = 0;      // 0..1-ish recoil impulse (gun kick-back + pitch)
    this.knifeSwing = 0;  // 0..1 knife swing arc impulse
    this.reloadT = 0;     // seconds remaining in a reload dip (0 = none)
    this.reloadTotal = 0; // total reload time for the current dip
    this.bobPhase = 0;    // walk-bob phase accumulator

    // Smoothed applied transforms (so switching weapons doesn't snap). Start at
    // the LOWERED pose so the very first play frame raises the weapon in from low
    // (the rifle boots in state 'raising'), rather than popping up from rest.
    this._posOff = new THREE.Vector3(0, -VIEWMODEL.lowerDrop, 0);
    this._rotOff = new THREE.Vector3(VIEWMODEL.lowerRot, 0, 0);
  }

  // ---- Model construction (chunky low-poly boxes) --------------------------
  // Local space: +x right, +y up, −z forward (camera-local). The muzzle anchor
  // sits at the forward tip so getMuzzleWorldPos points at the barrel.

  // v1.1 LOOKS: each weapon upgraded from a single box to a convincing low-poly
  // silhouette (receiver/barrel/sight/mag/stock etc.) + hand hints. The muzzle
  // anchor local position is UNCHANGED from v1.0 (the getMuzzleWorldPos contract
  // the FX layer relies on — tracers/flash start there), so the added detail is
  // purely visual and the shot truth (camera ray) is untouched.

  _buildRifle() {
    const g = new THREE.Group();
    g.add(box(0.09, 0.11, 0.34, 0, 0, -0.12, 0x2f3646));    // receiver/body (slate)
    g.add(box(0.05, 0.055, 0.34, 0, 0.005, -0.32, 0x232838)); // barrel (dark, longer)
    g.add(box(0.035, 0.035, 0.06, 0, 0.06, -0.44, 0x1b2030)); // front sight post
    g.add(box(0.05, 0.03, 0.09, 0, 0.075, -0.08, 0x39414f)); // rear sight rail
    g.add(box(0.05, 0.03, 0.10, 0, 0.075, -0.10, 0x3fb89e)); // sight accent (teal)
    g.add(box(0.07, 0.15, 0.09, 0.0, -0.12, 0.0, 0x2a3040)); // pistol grip
    g.add(box(0.055, 0.12, 0.16, 0, -0.11, -0.18, 0x2a2f3d)); // magazine (canted fwd)
    g.add(box(0.06, 0.09, 0.14, 0, -0.01, 0.10, 0x272c3a));  // stock hint (rear)
    addHands(g, CHARACTER.handColor, 0.02, -0.09, 0.0, -0.26); // trigger + support hands
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, -0.01, -0.46); // UNCHANGED (FX contract)
    g.add(muzzle);
    return { group: g, muzzle };
  }

  _buildPistol() {
    const g = new THREE.Group();
    g.add(box(0.06, 0.075, 0.22, 0, 0.01, -0.08, 0x2f3646)); // slide
    g.add(box(0.055, 0.02, 0.20, 0, 0.055, -0.07, 0x39414f)); // slide top / rib
    g.add(box(0.038, 0.038, 0.09, 0, 0.005, -0.18, 0x232838)); // barrel/muzzle end
    g.add(box(0.045, 0.02, 0.055, 0, 0.06, -0.10, 0x3fb89e)); // sight accent
    g.add(box(0.06, 0.13, 0.07, 0, -0.09, 0.02, 0x2a3040, 0.18)); // grip (angled)
    g.add(box(0.02, 0.05, 0.05, 0.0, -0.035, -0.045, 0x1b2030)); // trigger-guard hint
    addHands(g, CHARACTER.handColor, 0.01, -0.07, 0.02, -0.10);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.005, -0.24); // UNCHANGED (FX contract)
    g.add(muzzle);
    return { group: g, muzzle };
  }

  _buildKnife() {
    // v1.4 (Rohit): the knife must READ as a held knife, not a shouldered gun.
    // All parts live in an inner `pose` group canted like a fist grip — blade
    // longer, angled up-and-across the view; the outer group keeps receiving
    // the shared anim transforms (raise/sway/swing) untouched.
    const g = new THREE.Group();
    const pose = new THREE.Group();
    pose.position.set(-0.05, 0.03, 0.02);
    pose.rotation.set(0.22, -0.35, -0.55); // tip up, angled inward, canted grip
    g.add(pose);
    pose.add(box(0.036, 0.12, 0.07, 0, -0.07, 0.05, 0x2a3040));  // handle (in the fist)
    pose.add(box(0.07, 0.022, 0.045, 0, -0.005, 0.0, 0x1b2030)); // guard (crossbar)
    pose.add(box(0.028, 0.055, 0.34, 0, 0.0, -0.17, 0xcdd6e6));  // blade spine (longer)
    pose.add(box(0.006, 0.058, 0.34, 0.015, 0.0, -0.17, 0xeef3fb)); // edge bevel
    addHands(pose, CHARACTER.handColorKnife, 0.0, -0.09, 0.07, 0.02);
    const muzzle = new THREE.Object3D(); // "muzzle" = blade tip (flash anchor; tracer n/a)
    muzzle.position.set(0, 0.0, -0.36); // rides the posed blade tip
    pose.add(muzzle);
    return { group: g, muzzle };
  }

  _showOnly(name) {
    for (const k in this.rigs) this.rigs[k].group.visible = (k === name);
  }

  // ---- Muzzle world position (FX consumes this synchronously) --------------
  getMuzzleWorldPos(out) {
    // The active rig's muzzle anchor, in world space. Camera world matrix is
    // current for this frame (camera.follow ran before us). updateWorldMatrix
    // walks the parent chain so the value is exact even the frame after a switch.
    const m = this.rigs[this.active].muzzle;
    m.updateWorldMatrix(true, false);
    return m.getWorldPosition(out ?? _muzzleWorld);
  }

  // ---- Discrete event kicks (pushed by main from the weapon events) --------
  onFire(weapon) {
    if (weapon === 'knife') {
      this.knifeSwing = 1; // trigger the swing arc
    } else {
      this.recoil = Math.min(1.5, this.recoil + 1); // stack for auto-fire, capped
    }
  }
  onSwitch(name) {
    this.active = name;
    this._showOnly(name);
    // A switch begins lowered (weapons.state==='raising') and rises via the
    // isLowered() read in update — no explicit timer needed here.
    this.recoil = 0;
    this.knifeSwing = 0;
    this.reloadT = 0;
  }
  onReloadStart(weapon) {
    this.reloadTotal = this._reloadTime(weapon);
    this.reloadT = this.reloadTotal;
  }
  onReloadEnd(_weapon, _completed) {
    this.reloadT = 0; // completed OR switch-cancelled: the dip ends either way
  }

  _reloadTime(weapon) {
    // Straight from COMBAT — no magic number, no duplication (config is canon).
    return COMBAT[weapon]?.reloadTime ?? 0;
  }

  // ---- Per-frame update ----------------------------------------------------
  update(dt, weapons, controller, player) {
    // Keep the visible rig in sync in case a switch landed between events.
    if (weapons.active !== this.active) { this.active = weapons.active; this._showOnly(this.active); }

    // Decay impulses on game time (B2/B6).
    this.recoil *= Math.exp(-VIEWMODEL.recoilRecover * dt);
    if (this.recoil < 1e-3) this.recoil = 0;
    this.knifeSwing *= Math.exp(-VIEWMODEL.knifeSwingRecover * dt);
    if (this.knifeSwing < 1e-3) this.knifeSwing = 0;
    if (this.reloadT > 0) this.reloadT = Math.max(0, this.reloadT - dt);

    // Horizontal speed drives subtle sway/bob (weapon-only; NOT head bob).
    const vx = player?.vel?.x ?? 0;
    const vz = player?.vel?.z ?? 0;
    const speed = Math.hypot(vx, vz);
    const grounded = player?.grounded ?? true;
    this.bobPhase += dt * (VIEWMODEL.bobBaseRate + speed * 0.8);
    const moveAmt = grounded ? Math.min(1, speed / MOVE.runSpeed) : 0;

    // --- Compose the TARGET local transform (position + euler offsets) ------
    let px = 0, py = 0, pz = 0;    // extra position offset from rest
    let rx = 0, ry = 0, rz = 0;    // extra rotation (radians)

    // Lowered (sprint or raising): drop + rotate away.
    const lowered = weapons.isLowered(controller);
    if (lowered) {
      py -= VIEWMODEL.lowerDrop;
      rx += VIEWMODEL.lowerRot;
    }

    // Reload dip + tilt, scaled by a smooth in/out over the reload window.
    if (this.reloadT > 0 && this.reloadTotal > 0) {
      const p = 1 - this.reloadT / this.reloadTotal; // 0..1 progress
      const env = Math.sin(Math.PI * Math.min(1, Math.max(0, p))); // ease in/out
      py -= VIEWMODEL.reloadDrop * env;
      rx += VIEWMODEL.reloadRot * env;
      rz += VIEWMODEL.reloadRoll * env;
    }

    // Recoil kick-back (−z) + muzzle pitch-up. Stacks per shot, decays out.
    pz += VIEWMODEL.recoilKick * this.recoil;
    rx -= VIEWMODEL.recoilRot * this.recoil;

    // Knife swing: a fast arc — sweep down-and-across then recover.
    if (this.knifeSwing > 0) {
      rx -= VIEWMODEL.knifeSwingRot * this.knifeSwing;
      rz += VIEWMODEL.knifeSwingRot * 0.5 * this.knifeSwing;
    }

    // ADS pose (register group L): ease toward a centered, sights-up pose scaled
    // by the eased blend read straight off the weapon system (no event — L: "blend
    // eases with the same adsBlend"). Sway/bob are DAMPED ×swayDamp toward a steady
    // sight picture as the blend rises. Knife has no pose entry ⇒ untouched (L8).
    // At blend 0 pose add is 0 and swayScale is 1 — a true no-op path.
    const blend = weapons.adsBlend ?? 0;
    const pose = ADS.viewmodelPose[this.active];
    if (pose && blend > 0) {
      px += pose.x * blend;
      py += pose.y * blend;
      pz += pose.z * blend; // +z = toward the camera (rig sits at posZ = −0.42)
    }
    const swayScale = 1 - (1 - ADS.swayDamp) * blend;

    // Sway/bob from movement — tiny (damped while aiming).
    px += Math.sin(this.bobPhase * 0.5) * VIEWMODEL.swayAmount * moveAmt * swayScale;
    py += Math.abs(Math.sin(this.bobPhase)) * VIEWMODEL.bobAmount * moveAmt * swayScale;

    // --- Ease the applied offsets toward the target (exp smoothing) ---------
    const k = 1 - Math.exp(-VIEWMODEL.followRate * dt);
    this._posOff.x += (px - this._posOff.x) * k;
    this._posOff.y += (py - this._posOff.y) * k;
    this._posOff.z += (pz - this._posOff.z) * k;
    this._rotOff.x += (rx - this._rotOff.x) * k;
    this._rotOff.y += (ry - this._rotOff.y) * k;
    this._rotOff.z += (rz - this._rotOff.z) * k;

    this.root.position.set(
      VIEWMODEL.posX + this._posOff.x,
      VIEWMODEL.posY + this._posOff.y,
      VIEWMODEL.posZ + this._posOff.z,
    );
    this.root.rotation.set(this._rotOff.x, this._rotOff.y, this._rotOff.z);
  }
}
