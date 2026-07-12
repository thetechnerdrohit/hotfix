// ============================================================================
// src/game/props.js — v2.3 world toys (kour.io flavor): roaming CHICKENS that
// give the shooter PERSONAL points (never team score) and one kickable/shootable
// FOOTBALL. Both are self-contained, headless-safe SIM objects: the visual mesh
// is optional (attachMeshes builds it), so the SAME classes run inside the SP
// Match AND the authoritative ServerMatch (which has no THREE scene / renderer).
//
// Contracts:
//   • A Chicken is a Damageable in the kour-hitscan sense — it exposes
//     dead/headCenter/headRadius/bodyMin/bodyMax/applyDamage so it can be dropped
//     straight into weapons.targets and be hit by the exact same castRay path as
//     a bot (no special-case in hitscan.js). On death it fires onChickenKilled
//     (shooter) → the match turns that into a PERSONAL score bump + feed line.
//   • The Football is pure kinematics: gravity + ground bounce + rolling friction
//     + per-axis wall resolve against the world AABBs (mirrors the controller's
//     collide-and-slide). kick()/shove() impart velocity; the match calls
//     bodyNudge() for each combatant near it each tick.
//
// Rules honored: game-dt only, no setTimeout (B6); exp-decay smoothing (B2);
// zero per-frame allocation on the hot path (module scratch, I1); every tunable
// in config.PROPS. Hitboxes/colliders of the FIGHTERS are untouched — chickens
// add NEW targets, they don't change existing ones.
// ============================================================================

import * as THREE from 'three';
import { PROPS, PERF } from '../config.js';

// Module scratch (I1 — zero alloc on the tick path).
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

// Deterministic-ish PRNG seeded per manager so the server and a replay behave
// identically for a given seed and Math.random() (banned in workflow scripts, not
// here) stays out of the hot path patterns. A tiny LCG is plenty for wander.
function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// Chicken — a wandering 1-HP critter. Hit surface matches bots; on death it
// notifies (shooter) and schedules a respawn at a fresh wander point.
// ---------------------------------------------------------------------------
class Chicken {
  constructor(id, rng, walkableBounds) {
    this.id = id;
    this.kind = 'chicken';          // lets the match tell chickens from fighters
    this._rng = rng;
    this._bounds = walkableBounds;  // { minX, maxX, minZ, maxZ } — wander box
    this.pos = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1);
    this.vel = new THREE.Vector3();
    // Damageable duck-type (matches combat/damage.js applyDamage): hp/maxHp/dead
    // + an onKilled(info) hook. A chicken has 1 HP, so any bullet kills it via
    // the SAME shared applyDamage path the fighters use — no hitscan special-case.
    this.dead = false;
    this.hp = PROPS.chickens.hp;
    this.maxHp = PROPS.chickens.hp;
    this._turnTimer = 0;
    this._respawnT = 0;
    this._wasDead = false;          // edge-detect the external death flag

    // Hit volumes (kept fresh in refresh()). headCenter is a live Vector3 the
    // ray sphere-tests; bodyMin/Max are the AABB.
    this.headCenter = new THREE.Vector3();
    this.headRadius = PROPS.chickens.headRadius;
    this.bodyMin = new THREE.Vector3();
    this.bodyMax = new THREE.Vector3();

    // Set by the manager: onKilled(info) where info.source is the shooter.
    this.onKilled = null;
    this.onDamaged = null;          // unused (kept for duck-type completeness)
    this.mesh = null;               // optional THREE.Group (client only)
  }

  spawnAt(x, z) {
    this.pos.set(x, 0, z);
    this.vel.set(0, 0, 0);
    this.dead = false;
    this._wasDead = false;
    this.hp = PROPS.chickens.hp;
    this._turnTimer = 0;
    this._pickHeading();
    this.refresh();
    if (this.mesh) this.mesh.visible = true;
  }

  update(dt, colliders) {
    // applyDamage (shared combat path) flips `dead` and fires onKilled directly;
    // we detect that edge here to hide the mesh + arm the respawn timer.
    if (this.dead && !this._wasDead) {
      this._wasDead = true;
      this.vel.set(0, 0, 0);
      this._respawnT = PROPS.chickens.respawnDelay;
      if (this.mesh) this.mesh.visible = false;
    }

    if (this.dead) {
      this._respawnT -= dt;
      if (this._respawnT <= 0) {
        const b = this._bounds;
        this.spawnAt(
          b.minX + this._rng() * (b.maxX - b.minX),
          b.minZ + this._rng() * (b.maxZ - b.minZ),
        );
      }
      return;
    }

    // Re-pick a heading on a jittered timer (a lazy stroll, not a sprint).
    this._turnTimer -= dt;
    if (this._turnTimer <= 0) this._pickHeading();

    // Move along the heading; per-axis resolve against world so it bounces off
    // walls (turning away on a block reads as pecking around).
    const sp = PROPS.chickens.wanderSpeed;
    this._moveAxis('x', this.forward.x * sp * dt, colliders);
    this._moveAxis('z', this.forward.z * sp * dt, colliders);
    this._clampToBounds();
    this.refresh();
  }

  _pickHeading() {
    const a = this._rng() * Math.PI * 2;
    this.forward.set(Math.sin(a), 0, Math.cos(a));
    const { turnEveryMin: lo, turnEveryMax: hi } = PROPS.chickens;
    this._turnTimer = lo + this._rng() * (hi - lo);
  }

  _moveAxis(axis, delta, colliders) {
    if (delta === 0 || !colliders) { this.pos[axis] += delta; return; }
    this.pos[axis] += delta;
    const hw = PROPS.chickens.bodyRadius;
    const h = PROPS.chickens.bodyHeight;
    const p = this.pos;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      const overlaps =
        p.x - hw < c.max.x && p.x + hw > c.min.x &&
        p.y < c.max.y && p.y + h > c.min.y &&
        p.z - hw < c.max.z && p.z + hw > c.min.z;
      if (!overlaps) continue;
      // Blocked: back out on this axis and flip that heading component so the
      // chicken wanders away from the wall next frame.
      if (axis === 'x') { p.x = delta > 0 ? c.min.x - hw - 1e-3 : c.max.x + hw + 1e-3; this.forward.x = -this.forward.x; }
      else { p.z = delta > 0 ? c.min.z - hw - 1e-3 : c.max.z + hw + 1e-3; this.forward.z = -this.forward.z; }
      this._turnTimer = Math.min(this._turnTimer, 0.2); // re-pick soon
    }
  }

  _clampToBounds() {
    const b = this._bounds;
    const r = PROPS.chickens.bodyRadius;
    if (this.pos.x < b.minX + r) { this.pos.x = b.minX + r; this.forward.x = Math.abs(this.forward.x); }
    else if (this.pos.x > b.maxX - r) { this.pos.x = b.maxX - r; this.forward.x = -Math.abs(this.forward.x); }
    if (this.pos.z < b.minZ + r) { this.pos.z = b.minZ + r; this.forward.z = Math.abs(this.forward.z); }
    else if (this.pos.z > b.maxZ - r) { this.pos.z = b.maxZ - r; this.forward.z = -Math.abs(this.forward.z); }
  }

  // Keep hit volumes + mesh in sync with pos/forward.
  refresh() {
    const c = PROPS.chickens;
    const p = this.pos;
    this.bodyMin.set(p.x - c.bodyRadius, p.y, p.z - c.bodyRadius);
    this.bodyMax.set(p.x + c.bodyRadius, p.y + c.bodyHeight, p.z + c.bodyRadius);
    this.headCenter.set(p.x, p.y + c.bodyHeight * c.headYFrac, p.z);
    if (this.mesh) {
      this.mesh.position.copy(p);
      this.mesh.rotation.y = Math.atan2(this.forward.x, this.forward.z);
    }
  }
}

// ---------------------------------------------------------------------------
// Football — one kickable sphere with hand-rolled kinematics.
// ---------------------------------------------------------------------------
class Football {
  constructor(home) {
    this.kind = 'football';
    this.home = home.clone();       // spawn/reset point (on the ground)
    this.pos = home.clone();
    this.pos.y = PROPS.football.spawnHeight;
    this.vel = new THREE.Vector3();
    this.mesh = null;
    this._spin = 0;
  }

  reset() {
    this.pos.copy(this.home);
    this.pos.y = PROPS.football.spawnHeight;
    this.vel.set(0, 0, 0);
  }

  // A body (fighter) at `bodyPos` with `bodyRadius` nudges the ball if touching.
  bodyNudge(bodyPos, bodyRadius) {
    const r = PROPS.football.radius + bodyRadius;
    _v.set(this.pos.x - bodyPos.x, 0, this.pos.z - bodyPos.z);
    const d2 = _v.x * _v.x + _v.z * _v.z;
    if (d2 > r * r || d2 < 1e-6) return;
    const d = Math.sqrt(d2);
    _v.multiplyScalar(1 / d);
    // Push out of overlap + impart kick speed along the contact normal.
    this.pos.x = bodyPos.x + _v.x * (r + 1e-3);
    this.pos.z = bodyPos.z + _v.z * (r + 1e-3);
    const k = PROPS.football.kickSpeed;
    this.vel.x = _v.x * k;
    this.vel.z = _v.z * k;
    if (this.vel.y < 1) this.vel.y = 1.2; // a little hop reads as a kick
  }

  // A bullet traveling along unit `dir` that passes within radius shoves it.
  shove(dir) {
    const s = PROPS.football.shotImpulse;
    this.vel.x += dir.x * s;
    this.vel.z += dir.z * s;
    this.vel.y += Math.max(0, dir.y) * s * 0.5 + 1.5;
    this._clampSpeed();
  }

  update(dt, colliders) {
    const f = PROPS.football;
    // Gravity.
    this.vel.y -= f.gravity * dt;

    // Integrate per-axis with wall resolve (mirrors controller collide-and-slide).
    this._moveAxis('x', this.vel.x * dt, colliders);
    this._moveAxis('z', this.vel.z * dt, colliders);
    this.pos.y += this.vel.y * dt;

    // Ground plane (y=0) bounce.
    if (this.pos.y <= f.radius) {
      this.pos.y = f.radius;
      if (this.vel.y < 0) this.vel.y = -this.vel.y * f.restitution;
      if (Math.abs(this.vel.y) < 0.4) this.vel.y = 0; // settle
      // Rolling friction on the horizontal velocity while grounded (B2).
      const damp = Math.exp(-f.rollFriction * dt);
      this.vel.x *= damp;
      this.vel.z *= damp;
      if (Math.abs(this.vel.x) < 0.02) this.vel.x = 0;
      if (Math.abs(this.vel.z) < 0.02) this.vel.z = 0;
    }
    this._clampSpeed();

    if (this.mesh) {
      this.mesh.position.copy(this.pos);
      // Fake roll: spin about the axis perpendicular to travel.
      const sp = Math.hypot(this.vel.x, this.vel.z);
      this._spin += sp * dt / f.radius;
      this.mesh.rotation.set(this._spin, 0, this._spin * 0.6);
    }
  }

  _moveAxis(axis, delta, colliders) {
    this.pos[axis] += delta;
    if (!colliders) return;
    const r = PROPS.football.radius;
    const p = this.pos;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      const overlaps =
        p.x - r < c.max.x && p.x + r > c.min.x &&
        p.y - r < c.max.y && p.y + r > c.min.y &&
        p.z - r < c.max.z && p.z + r > c.min.z;
      if (!overlaps) continue;
      if (axis === 'x') { p.x = delta > 0 ? c.min.x - r - 1e-3 : c.max.x + r + 1e-3; this.vel.x = -this.vel.x * 0.5; }
      else { p.z = delta > 0 ? c.min.z - r - 1e-3 : c.max.z + r + 1e-3; this.vel.z = -this.vel.z * 0.5; }
    }
  }

  _clampSpeed() {
    const m = PROPS.football.maxSpeed;
    const s2 = this.vel.x * this.vel.x + this.vel.z * this.vel.z;
    if (s2 > m * m) {
      const s = m / Math.sqrt(s2);
      this.vel.x *= s;
      this.vel.z *= s;
    }
  }
}

// ---------------------------------------------------------------------------
// PropsManager — owns the chicken flock + the football; ticked by the match.
// Headless-safe: pass a scene to build meshes, or null (server) for sim-only.
// ---------------------------------------------------------------------------
export class PropsManager {
  /**
   * @param {object} world  the map world: { colliders, seSpawns/bugSpawns, ... }
   * @param {THREE.Scene|null} scene  client scene (null on the server)
   * @param {number} seed
   */
  constructor(world, scene, seed = 0x1234abcd) {
    this.world = world;
    this.scene = scene || null;
    this.colliders = world.colliders || [];
    this._rng = makeRng(seed);
    this.chickens = [];
    this.football = null;

    const bounds = this._computeBounds();
    this._bounds = bounds;

    // Chickens.
    for (let i = 0; i < PROPS.chickens.count; i++) {
      const ch = new Chicken(1000 + i, this._rng, bounds);
      if (this.scene) this._attachChickenMesh(ch);
      ch.spawnAt(
        bounds.minX + this._rng() * (bounds.maxX - bounds.minX),
        bounds.minZ + this._rng() * (bounds.maxZ - bounds.minZ),
      );
      this.chickens.push(ch);
    }

    // Football at the map center-ish (average of the two spawn clusters).
    if (PROPS.football.enabled) {
      const center = this._mapCenter();
      this.football = new Football(center);
      if (this.scene) this._attachBallMesh(this.football);
    }
  }

  // The chicken hit surfaces, appended to the player's weapons.targets so the
  // stock castRay hits them with no special-casing.
  get targets() { return this.chickens; }

  // Wire the personal-score callback (match sets this). Each chicken's onKilled
  // receives the shared applyDamage `info` object; we forward (chicken, shooter).
  set onChickenKilled(cb) {
    this._onChickenKilled = cb;
    for (const c of this.chickens) c.onKilled = (info) => cb(c, info?.source ?? null);
  }

  // Per-frame sim. `combatants` = living fighters (for football body nudges).
  update(dt, combatants) {
    for (let i = 0; i < this.chickens.length; i++) this.chickens[i].update(dt, this.colliders);
    if (this.football) {
      this.football.update(dt, this.colliders);
      if (combatants) {
        for (let i = 0; i < combatants.length; i++) {
          const c = combatants[i];
          if (!c || c.dead) continue;
          this.football.bodyNudge(c.pos, 0.4);
        }
      }
    }
  }

  // A bullet resolved by the weapon system: if it passed near the ball, shove it.
  // origin/dir are the shot ray; dist is where it hit (or a large number).
  onShotRay(origin, dir, dist) {
    if (!this.football) return;
    // Closest point on the ray to the ball center.
    _v.copy(this.football.pos).sub(origin);
    const t = Math.max(0, Math.min(dist, _v.dot(dir)));
    _n.copy(dir).multiplyScalar(t).add(origin);
    const near = _n.distanceTo(this.football.pos);
    if (near <= PROPS.football.radius + 0.15) this.football.shove(dir);
  }

  // ---- bounds / center -----------------------------------------------------
  _computeBounds() {
    // Wander the chickens inside the collider bounding box, shrunk a touch so
    // they don't hug the outer wall. Falls back to a sane box if empty.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of this.colliders) {
      if (c.min.x < minX) minX = c.min.x;
      if (c.max.x > maxX) maxX = c.max.x;
      if (c.min.z < minZ) minZ = c.min.z;
      if (c.max.z > maxZ) maxZ = c.max.z;
    }
    if (!isFinite(minX)) { minX = -30; maxX = 30; minZ = -30; maxZ = 30; }
    const padX = (maxX - minX) * 0.12;
    const padZ = (maxZ - minZ) * 0.12;
    return { minX: minX + padX, maxX: maxX - padX, minZ: minZ + padZ, maxZ: maxZ - padZ };
  }

  _mapCenter() {
    const se = this.world.seSpawns?.[0]?.pos;
    const bug = this.world.bugSpawns?.[0]?.pos;
    if (se && bug) return new THREE.Vector3((se.x + bug.x) / 2, 0, (se.z + bug.z) / 2);
    return new THREE.Vector3(0, 0, 0);
  }

  // ---- meshes (client only) ------------------------------------------------
  _attachChickenMesh(ch) {
    const g = new THREE.Group();
    const white = new THREE.MeshLambertMaterial({ color: 0xf4f4f4 });
    const red = new THREE.MeshLambertMaterial({ color: 0xd23b3b });
    const beak = new THREE.MeshLambertMaterial({ color: 0xe8a13a });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.30, 0.40), white);
    body.position.y = 0.18;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.20, 0.20), white);
    head.position.set(0, 0.40, -0.14);
    const comb = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.14), red);
    comb.position.set(0, 0.52, -0.14);
    const bk = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, 0.10), beak);
    bk.position.set(0, 0.38, -0.26);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.20, 0.14), white);
    tail.position.set(0, 0.26, 0.22); tail.rotation.x = -0.5;
    g.add(body, head, comb, bk, tail);
    if (PERF.shadows) { body.castShadow = true; head.castShadow = true; }
    ch.mesh = g;
    this.scene.add(g);
  }

  _attachBallMesh(ball) {
    // Classic black/white football via a low-poly icosphere + a couple of dark
    // pentagon-ish patch boxes (cheap; reads as a football at gameplay distance).
    const g = new THREE.Group();
    const white = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const black = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
    const sphere = new THREE.Mesh(new THREE.IcosahedronGeometry(PROPS.football.radius, 1), white);
    const patchGeo = new THREE.BoxGeometry(0.11, 0.02, 0.11);
    for (const [x, y, z] of [[0, PROPS.football.radius, 0], [0, -PROPS.football.radius, 0],
      [PROPS.football.radius, 0, 0], [-PROPS.football.radius, 0, 0],
      [0, 0, PROPS.football.radius], [0, 0, -PROPS.football.radius]]) {
      const patch = new THREE.Mesh(patchGeo, black);
      patch.position.set(x * 0.9, y * 0.9, z * 0.9);
      patch.lookAt(0, 0, 0);
      g.add(patch);
    }
    g.add(sphere);
    ball.mesh = g;
    this.scene.add(g);
  }

  dispose() {
    if (!this.scene) return;
    for (const c of this.chickens) if (c.mesh) this.scene.remove(c.mesh);
    if (this.football?.mesh) this.scene.remove(this.football.mesh);
  }
}
