// ============================================================================
// Practice dummies for Phase 2 — static head+body targets so shooting is fun
// with no enemies yet (§4B "Static targets with head + body zones"). Each is a
// Damageable (the applyDamage duck-type, F1) AND carries the hitboxes hitscan
// reads: a body AABB + a head hit sphere slightly larger than the visual head
// cube (generous in the skilled direction, E3). Bug-error-label styling is
// Phase 3; these are the clean slate/amber placeholder look.
//
// NOT movement colliders — the player walks THROUGH them (they're targets, not
// walls); they never enter room.colliders. Placed clear of the feel-gym
// obstacles (jump chain / slide gap / lintel). At least one faces AWAY from
// spawn so the knife backstab arc (E14) is testable.
//
// onDamaged raises a game-time flinch flag the frontend renders; onKilled sinks
// the corpse and schedules a full-hp respawn — all on game dt (B6/E15), no
// setTimeout. Zero per-frame allocations (I1): update() only writes existing
// vectors / scalars.
// ============================================================================

import * as THREE from 'three';
import { COMBAT, TARGETS, PERF } from '../config.js';

// Slate body + amber head — matches the room palette; the error-label badge
// look lands in Phase 3.
const BODY_COLOR = 0x566079; // slate
const HEAD_COLOR = 0xe8913f; // amber (reads as the "hit here" zone)

// Placements: [x, z, facingYaw]. Forward = (−sin yaw, 0, −cos yaw): yaw 0
// faces −z — AWAY from spawn (z=+9), its back to the player; yaw PI faces +z,
// toward the player.
const PLACEMENTS = [
  [-3.0, -6.0, 0],          // back to spawn — backstab-testable straight off the walk-up
  [3.0, -8.0, Math.PI],     // faces the player — frontal knife/shot target
  [-8.0, -2.0, Math.PI / 2],
  [2.0, 2.5, Math.PI],      // faces the player; clear of the lintel (x∈[-2.25,0.25])
  [9.0, -4.0, -Math.PI / 2],
];

class Dummy {
  constructor(x, z, yaw) {
    const bs = TARGETS.bodySize;
    const feetY = 0; // floor top is y=0

    // Damageable (F1 duck-type).
    this.hp = COMBAT.maxHealth;
    this.maxHp = COMBAT.maxHealth;
    this.dead = false;

    // Facing (unit XZ forward). yaw 0 → −z. Stored for the backstab dot (E14).
    this.forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).normalize();
    this.pos = new THREE.Vector3(x, feetY, z); // feet; backstab uses XZ only

    // --- Meshes (low-poly boxes) -------------------------------------------
    this.group = new THREE.Group();
    this.group.position.set(x, feetY, z);
    this.group.rotation.y = yaw;

    const bodyGeo = new THREE.BoxGeometry(bs.x, bs.y, bs.z);
    const bodyMat = new THREE.MeshLambertMaterial({ color: BODY_COLOR });
    this.bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    this.bodyMesh.position.y = bs.y / 2; // base at feet
    this.bodyMesh.castShadow = PERF.shadows;
    this.bodyMesh.receiveShadow = PERF.shadows;
    this.group.add(this.bodyMesh);

    const hs = TARGETS.headSize;
    const headBase = bs.y + TARGETS.headGap;
    const headGeo = new THREE.BoxGeometry(hs, hs, hs);
    const headMat = new THREE.MeshLambertMaterial({ color: HEAD_COLOR });
    this.headMesh = new THREE.Mesh(headGeo, headMat);
    this.headMesh.position.y = headBase + hs / 2;
    this.headMesh.castShadow = PERF.shadows;
    this.group.add(this.headMesh);

    // --- Hitboxes in WORLD space (what hitscan reads) ----------------------
    // Body AABB is axis-aligned in world space. The dummies are box-shaped and
    // only yaw-rotated; using the un-rotated footprint as the AABB is the
    // deliberate low-poly quirk (a tight OBB isn't worth it here) and stays
    // generous. Half-extent uses the larger of x/z so a yawed body is still
    // fully covered.
    const halfXZ = Math.max(bs.x, bs.z) / 2;
    this.bodyMin = new THREE.Vector3(x - halfXZ, feetY, z - halfXZ);
    this.bodyMax = new THREE.Vector3(x + halfXZ, feetY + bs.y, z + halfXZ);

    // Head hit sphere: centered on the head cube, radius from config (larger
    // than the visual cube — generous, E3). Center is fixed (static target).
    this.headCenter = new THREE.Vector3(x, feetY + headBase + hs / 2, z);
    this.headRadius = TARGETS.hitSphereRadius;

    // --- Feedback / lifecycle state (frontend reads flinch; we own timers) --
    this.flinch = 0;        // seconds of raised flinch flag remaining
    this.lastHit = null;    // last damage info, for the frontend
    this._sink = 0;         // 0..1 sink progress while dead
    this._respawn = 0;      // seconds until respawn while dead
    this._baseY = feetY;
  }

  // Feedback hooks the damage entry point calls (F1). Kept tiny; the frontend
  // renders off `flinch`/`lastHit`. Death handling is local + game-time.
  onDamaged(info) {
    this.flinch = TARGETS.flinchTime;
    this.lastHit = info;
  }

  onKilled(_info) {
    // dead flag is already set inside applyDamage (F2). Start the sink + the
    // respawn countdown; both advance on game dt in update().
    this._sink = 0;
    this._respawn = TARGETS.respawnTime;
  }

  update(dt) {
    if (this.flinch > 0) this.flinch = Math.max(0, this.flinch - dt);

    if (this.dead) {
      // Sink/shrink the corpse, then respawn full-hp after the delay. Simple
      // placeholder death — the bug-splat is Phase 3.
      this._sink = Math.min(1, this._sink + dt / TARGETS.sinkTime);
      this.group.position.y = this._baseY - this._sink * 1.4; // drop out of sight
      const s = Math.max(0.001, 1 - this._sink);
      this.group.scale.setScalar(s);

      this._respawn -= dt;
      if (this._respawn <= 0) this._reset();
    }
  }

  _reset() {
    this.hp = this.maxHp;
    this.dead = false;
    this.flinch = 0;
    this.lastHit = null;
    this._sink = 0;
    this._respawn = 0;
    this.group.position.y = this._baseY;
    this.group.scale.setScalar(1);
  }
}

/**
 * Build the practice dummies, add their meshes to the scene, and return the
 * list (also the exact array hitscan iterates). Not added to room.colliders —
 * targets aren't walls.
 * @param {THREE.Scene|THREE.Group} scene
 * @returns {Dummy[]}
 */
export function buildTargets(scene) {
  const list = [];
  for (let i = 0; i < PLACEMENTS.length; i++) {
    const [x, z, yaw] = PLACEMENTS[i];
    const d = new Dummy(x, z, yaw);
    scene.add(d.group);
    list.push(d);
  }
  return list;
}
