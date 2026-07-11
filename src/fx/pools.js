// ============================================================================
// Pooled visual transients — tracers, bullet decals, impact particles, muzzle
// flash (register group I). EVERYTHING here is preallocated at boot and reused;
// there is not a single allocation on the shot path (I1/I2). Each pool owns its
// meshes, adds them to the scene ONCE, hides them when idle, and exposes one
// update(dt) that fades/moves live entries. Module-scope scratch vectors only.
//
// These are VISUAL ONLY (E1): the hit truth already came from the camera ray in
// weapons.js. Tracers therefore START at the viewmodel muzzle and end at the
// resolved hit point — the classic "gun points where the bullet went" cheat.
//
// Edge cases owned here:
//   E1  tracer origin = muzzle (visual); the resolved point is the camera-ray truth.
//   I1  zero per-shot allocations — pools + module scratch, ring reuse.
//   I2  decals capped (PERF.decalCap) in a ring buffer; NEVER on characters
//        (spawnDecal is only called for world hits — result.target === null).
//   I3  muzzle flash is an emissive quad, NOT a dynamic light.
//
// Lifetimes tick on game dt; main.js decides whether they keep fading while
// paused (they do — a frozen tracer mid-air reads worse than one that finishes).
// ============================================================================

import * as THREE from 'three';
import { FX } from '../config.js';

// ---- Module-scope scratch (zero allocations per shot, I1) -------------------
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _fwd = new THREE.Vector3(0, 0, 1); // default plane/box forward normal

// Axis → surface normal for oriented decals (the box face the ray entered).
function axisNormal(axis, sign, out) {
  out.set(0, 0, 0);
  out[axis] = sign;
  return out;
}

// ===========================================================================
// TracerPool — thin additive streaks, muzzle → hit point, brief fade (E1).
// Each tracer is a unit box scaled along local +Z to the beam length, oriented
// by a lookAt-style quaternion. Additive + depthWrite off so overlaps glow.
// ===========================================================================
class TracerPool {
  constructor(scene) {
    const geo = new THREE.BoxGeometry(FX.tracerWidth, FX.tracerWidth, 1);
    geo.translate(0, 0, 0.5); // origin at one END so scaling z grows from the muzzle
    const mat = new THREE.MeshBasicMaterial({
      color: FX.tracerColor, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.mat = mat;
    this.items = [];
    for (let i = 0; i < FX.tracerCount; i++) {
      const m = new THREE.Mesh(geo, mat.clone());
      m.visible = false;
      m.matrixAutoUpdate = true; // transient — moves every frame it's alive
      m.frustumCulled = false;
      scene.add(m);
      this.items.push({ mesh: m, life: 0 });
    }
    this.cursor = 0;
  }

  // from/to are consumed synchronously (copied into the mesh transform now).
  spawn(from, to) {
    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    _a.copy(from); _b.copy(to);
    _dir.subVectors(_b, _a);
    const len = _dir.length();
    if (len < 1e-4) return;
    _dir.multiplyScalar(1 / len);
    it.mesh.position.copy(_a);
    _q.setFromUnitVectors(_fwd, _dir);
    it.mesh.quaternion.copy(_q);
    it.mesh.scale.set(1, 1, len);
    it.mesh.material.opacity = 1;
    it.mesh.visible = true;
    it.life = FX.tracerLife;
  }

  update(dt) {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.life <= 0) continue;
      it.life -= dt;
      if (it.life <= 0) { it.mesh.visible = false; continue; }
      it.mesh.material.opacity = it.life / FX.tracerLife; // linear fade
    }
  }
}

// ===========================================================================
// DecalPool — small dark quads at WORLD hit points, ring-reused (I2). Oriented
// flat on the surface the ray entered, pushed off slightly to beat z-fighting.
// Never spawned on characters (caller gates on result.target === null).
// ===========================================================================
class DecalPool {
  constructor(scene) {
    const geo = new THREE.PlaneGeometry(FX.decalSize, FX.decalSize);
    const mat = new THREE.MeshBasicMaterial({
      color: FX.decalColor, transparent: true, opacity: 0.9,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
    });
    this.items = [];
    for (let i = 0; i < FX.decalCount; i++) {
      const m = new THREE.Mesh(geo, mat.clone());
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.items.push({ mesh: m, life: 0 });
    }
    this.cursor = 0;
  }

  // point + (normalAxis, normalSign) consumed synchronously.
  spawn(point, normalAxis, normalSign) {
    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length; // ring reuse (I2)
    axisNormal(normalAxis, normalSign, _dir); // surface normal
    // Offset off the surface along its normal to avoid z-fighting (D3-style skin).
    _a.copy(point).addScaledVector(_dir, FX.decalOffset);
    it.mesh.position.copy(_a);
    // Orient the plane (default +Z normal) to the surface normal.
    _q.setFromUnitVectors(_fwd, _dir);
    it.mesh.quaternion.copy(_q);
    it.mesh.material.opacity = 0.9;
    it.mesh.visible = true;
    it.life = FX.decalLife;
  }

  update(dt) {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.life <= 0) continue;
      it.life -= dt;
      if (it.life <= 0) { it.mesh.visible = false; continue; }
      // Hold opaque, fade only in the last 20% of life.
      const f = it.life / FX.decalLife;
      it.mesh.material.opacity = 0.9 * Math.min(1, f / 0.2);
    }
  }
}

// ===========================================================================
// ImpactPool — small particle puffs at hit points. A flat budget of one-tri
// sprites shared across all impacts; each spawn claims `impactPerHit` of them,
// scattered with an initial velocity + gravity + fade. Target hits tint hot,
// world hits tint dust.
// ===========================================================================
class ImpactPool {
  constructor(scene) {
    const geo = new THREE.PlaneGeometry(FX.impactSize, FX.impactSize);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 1,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.items = [];
    for (let i = 0; i < FX.impactCount; i++) {
      const m = new THREE.Mesh(geo, mat.clone());
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.items.push({
        mesh: m, life: 0,
        vx: 0, vy: 0, vz: 0,
      });
    }
    this.cursor = 0;
  }

  // point consumed synchronously; `isTarget` picks the tint. Velocities are
  // deterministic-ish scatter using a cheap per-particle hash (no alloc).
  burst(point, isTarget) {
    const color = isTarget ? FX.impactHitColor : FX.impactWorldColor;
    for (let k = 0; k < FX.impactPerHit; k++) {
      const it = this.items[this.cursor];
      this.cursor = (this.cursor + 1) % this.items.length;
      it.mesh.position.copy(point);
      it.mesh.material.color.setHex(color);
      it.mesh.material.opacity = 1;
      it.mesh.visible = true;
      it.life = FX.impactLife;
      // Scatter direction on a hemisphere-ish spread — cheap trig from k.
      const a = (k / FX.impactPerHit) * Math.PI * 2 + point.x + point.z;
      const el = 0.3 + 0.6 * ((k * 0.61803) % 1); // fractional-golden elevation
      const sp = FX.impactSpeed * (0.5 + 0.5 * ((k * 0.7548) % 1));
      it.vx = Math.cos(a) * sp;
      it.vy = el * sp;
      it.vz = Math.sin(a) * sp;
    }
  }

  update(dt) {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.life <= 0) continue;
      it.life -= dt;
      if (it.life <= 0) { it.mesh.visible = false; continue; }
      it.vy -= FX.impactGravity * dt;
      it.mesh.position.x += it.vx * dt;
      it.mesh.position.y += it.vy * dt;
      it.mesh.position.z += it.vz * dt;
      it.mesh.material.opacity = it.life / FX.impactLife;
      const s = Math.max(0.05, it.life / FX.impactLife);
      it.mesh.scale.setScalar(s);
    }
  }
}

// ===========================================================================
// MuzzleFlash — emissive quads at the muzzle anchor, ~40 ms, random roll/scale.
// NO dynamic light (I3): the quad IS the flash. Placed each spawn at the muzzle
// world position, billboarded by copying the camera quaternion.
// ===========================================================================
class MuzzleFlashPool {
  constructor(scene) {
    const geo = new THREE.PlaneGeometry(FX.flashSize, FX.flashSize);
    const mat = new THREE.MeshBasicMaterial({
      color: FX.flashColor, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.items = [];
    for (let i = 0; i < FX.flashCount; i++) {
      const m = new THREE.Mesh(geo, mat.clone());
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.items.push({ mesh: m, life: 0 });
    }
    this.cursor = 0;
    this._roll = 0;
  }

  // pos = muzzle world pos, camQuat = camera orientation (billboard).
  spawn(pos, camQuat) {
    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    it.mesh.position.copy(pos);
    it.mesh.quaternion.copy(camQuat);
    // Slight random roll + scale so repeated flashes don't look identical. Roll
    // walks by an irrational step (no alloc, no Math.random dependency needed).
    this._roll = (this._roll + 2.399963) % (Math.PI * 2);
    it.mesh.rotateZ(this._roll);
    const s = 0.8 + 0.5 * ((this.cursor * 0.61803) % 1);
    it.mesh.scale.setScalar(s);
    it.mesh.material.opacity = 1;
    it.mesh.visible = true;
    it.life = FX.flashLife;
  }

  update(dt) {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.life <= 0) continue;
      it.life -= dt;
      if (it.life <= 0) { it.mesh.visible = false; continue; }
      it.mesh.material.opacity = it.life / FX.flashLife;
    }
  }
}

// ===========================================================================
// SplatBurst — the bug/SE death particle pop (§4B "the satisfying splat"). Like
// ImpactPool but bigger, longer-lived, more particles, and TEAM-TINTED per
// spawn. Its own pool so it never competes with the bullet-impact budget. Rises
// a touch then falls under gravity; additive so a burst reads as a wet pop.
// ===========================================================================
class SplatBurst {
  constructor(scene) {
    const geo = new THREE.PlaneGeometry(FX.splatSize, FX.splatSize);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 1,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.items = [];
    for (let i = 0; i < FX.splatCount; i++) {
      const m = new THREE.Mesh(geo, mat.clone());
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.items.push({ mesh: m, life: 0, vx: 0, vy: 0, vz: 0 });
    }
    this.cursor = 0;
  }

  // pos = the bot's body center-ish; color = team particle tint. Deterministic
  // scatter from k (no alloc, no Math.random dependency).
  burst(pos, color) {
    for (let k = 0; k < FX.splatPerKill; k++) {
      const it = this.items[this.cursor];
      this.cursor = (this.cursor + 1) % this.items.length;
      it.mesh.position.copy(pos);
      it.mesh.material.color.setHex(color);
      it.mesh.material.opacity = 1;
      it.mesh.scale.setScalar(1);
      it.mesh.visible = true;
      it.life = FX.splatLife;
      const a = (k / FX.splatPerKill) * Math.PI * 2 + pos.x * 1.7 + pos.z * 0.9;
      const el = 0.35 + 0.7 * ((k * 0.61803) % 1); // upward-biased spread
      const sp = FX.splatSpeed * (0.45 + 0.55 * ((k * 0.7548) % 1));
      it.vx = Math.cos(a) * sp;
      it.vy = el * sp;
      it.vz = Math.sin(a) * sp;
    }
  }

  update(dt) {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.life <= 0) continue;
      it.life -= dt;
      if (it.life <= 0) { it.mesh.visible = false; continue; }
      it.vy -= FX.splatGravity * dt;
      it.mesh.position.x += it.vx * dt;
      it.mesh.position.y += it.vy * dt;
      it.mesh.position.z += it.vz * dt;
      const f = it.life / FX.splatLife;
      it.mesh.material.opacity = f;
      it.mesh.scale.setScalar(Math.max(0.05, f));
    }
  }
}

// ===========================================================================
// SplatDecalPool — the flat floor stain left under a killed bot (§4B). A big
// horizontal team-tinted quad, ring-reused, lying on the floor (y≈0). Separate
// from the bullet-hole DecalPool: bigger, coloured, floor-only, its own ring so
// it never evicts bullet holes. NOT additive (a stain, not a glow).
// ===========================================================================
class SplatDecalPool {
  constructor(scene) {
    const geo = new THREE.PlaneGeometry(FX.splatDecalSize, FX.splatDecalSize);
    geo.rotateX(-Math.PI / 2); // lie flat on the floor (normal = +Y)
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.85,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
    });
    this.items = [];
    for (let i = 0; i < FX.splatDecalCount; i++) {
      const m = new THREE.Mesh(geo, mat.clone());
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.items.push({ mesh: m, life: 0 });
    }
    this.cursor = 0;
  }

  // feetPos = the bot's feet (y≈0); color = team floor-stain tint.
  spawn(feetPos, color) {
    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length; // ring reuse (I2)
    it.mesh.position.set(feetPos.x, 0.012, feetPos.z); // just above the floor plane
    it.mesh.rotation.y = (this.cursor * 2.399963) % (Math.PI * 2); // vary orientation
    it.mesh.material.color.setHex(color);
    it.mesh.material.opacity = 0.85;
    it.mesh.visible = true;
    it.life = FX.splatDecalLife;
  }

  update(dt) {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.life <= 0) continue;
      it.life -= dt;
      if (it.life <= 0) { it.mesh.visible = false; continue; }
      const f = it.life / FX.splatDecalLife;
      it.mesh.material.opacity = 0.85 * Math.min(1, f / 0.25); // hold, fade last 25%
    }
  }
}

// ===========================================================================
// FxPools — bundles the pools behind one update(dt) and a small event-facing
// API. main.js owns one instance, ticks it, and calls into it from the weapon
// events (Phase 2) and the match events (Phase 3 splats).
// ===========================================================================
export class FxPools {
  constructor(scene) {
    this.tracers = new TracerPool(scene);
    this.decals = new DecalPool(scene);
    this.impacts = new ImpactPool(scene);
    this.flashes = new MuzzleFlashPool(scene);
    this.splats = new SplatBurst(scene);
    this.splatDecals = new SplatDecalPool(scene);
  }

  // The bug/SE death splat (§4B): a team-tinted particle burst at the body plus
  // a flat floor stain under the feet. `bodyPos` = mid-body world point,
  // `feetPos` = feet world point, palette = { particle, decal } team colours.
  splat(bodyPos, feetPos, palette) {
    this.splats.burst(bodyPos, palette.particle);
    this.splatDecals.spawn(feetPos, palette.decal);
  }

  update(dt) {
    this.tracers.update(dt);
    this.decals.update(dt);
    this.impacts.update(dt);
    this.flashes.update(dt);
    this.splats.update(dt);
    this.splatDecals.update(dt);
  }
}

export { TracerPool, DecalPool, ImpactPool, MuzzleFlashPool, SplatBurst, SplatDecalPool };
