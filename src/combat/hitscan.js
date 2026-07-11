// ============================================================================
// Hitscan ray casting — the "did the bullet hit anything" math. Zero-alloc:
// every call reuses module-scope scratch and writes into a caller-owned `out`
// object (I1 — a GC hitch is a felt hitch). Pure geometry; no damage, no
// state — weapons.js decides what a hit means.
//
// Edge cases owned here:
//   E1  ray ALWAYS comes from the camera center (caller passes origin/dir).
//   E3  wall blocks shots, but a peeking head is hittable → NEAREST hit across
//        world AABBs AND per-character head-sphere/body; head tested first so a
//        ray clipping head+body counts as a headshot (generous, skilled dir).
//   E13 knife respects world geometry — a nearer wall beats the target.
//   I1  no allocations per shot.
//
// Colliders are the world.colliders shape from testRoom.js: { min:V3, max:V3 }.
// Targets are the targets.js shape: a living Damageable exposing
//   { dead, bodyMin:V3, bodyMax:V3, headCenter:V3, headRadius:number }.
// ============================================================================

import * as THREE from 'three';

const _p = new THREE.Vector3();   // scratch: sphere-relative origin
const _hit = new THREE.Vector3(); // scratch: candidate hit point

// The dummy head sphere dips ~1 cm below the body top, and the body box is
// wider than the sphere — so a ray grazing the neck seam can enter the body
// marginally before the head. Within this band the headshot stands (E3:
// clips-both → head wins); beyond it the body hit is genuinely first.
const HEAD_SEAM_EPS = 0.05;

// Result object shape (documented for callers building their own `out`):
//   { hitSomething, point:V3, normalAxis:'x'|'y'|'z', normalSign:-1|1,
//     target|null, isHead:boolean, dist:number }
export function makeHitResult() {
  return {
    hitSomething: false,
    point: new THREE.Vector3(),
    normalAxis: 'y',
    normalSign: 1,
    target: null,
    isHead: false,
    dist: Infinity,
  };
}

// --- Ray vs axis-aligned box (slab method) --------------------------------
// Returns entry distance t (≥0) along a UNIT dir, or -1 for a miss within
// maxDist. Writes the entry face into _slabAxis/_slabSign for the normal.
// dirInv components may be ±Infinity when a dir axis is 0 — the sign/NaN
// handling below is the standard robust-slab treatment.
let _slabAxis = 'y';
let _slabSign = 1;
const AXES = ['x', 'y', 'z'];

function rayBox(ox, oy, oz, dx, dy, dz, min, max, maxDist) {
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const mn = [min.x, min.y, min.z];
  const mx = [max.x, max.y, max.z];

  let tmin = 0;          // we only care about hits ahead of the muzzle
  let tmax = maxDist;
  let enterAxis = 0;
  let enterSign = 1;

  for (let i = 0; i < 3; i++) {
    if (d[i] === 0) {
      // Ray parallel to this slab: an origin outside the slab never hits.
      if (o[i] < mn[i] || o[i] > mx[i]) return -1;
      continue;
    }
    const inv = 1 / d[i];
    let t1 = (mn[i] - o[i]) * inv;
    let t2 = (mx[i] - o[i]) * inv;
    let sign = -1; // entering the min face when dir is +ve on this axis
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; sign = 1; }
    if (t1 > tmin) { tmin = t1; enterAxis = i; enterSign = sign; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1; // slabs don't overlap → miss
  }

  _slabAxis = AXES[enterAxis];
  _slabSign = enterSign;
  return tmin;
}

// --- Ray vs sphere --------------------------------------------------------
// Nearest positive intersection distance along a UNIT dir, or -1 for a miss
// within maxDist.
function raySphere(ox, oy, oz, dx, dy, dz, center, radius, maxDist) {
  _p.set(ox - center.x, oy - center.y, oz - center.z);
  // dir is unit → a = 1; solve t² + 2·b·t + c = 0
  const b = _p.x * dx + _p.y * dy + _p.z * dz;
  const c = _p.lengthSq() - radius * radius;
  // Origin inside the sphere (c<0): t=0 is a hit (point-blank head clip).
  if (c <= 0) return 0;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc); // nearest root
  if (t < 0 || t > maxDist) return -1;
  return t;
}

/**
 * Cast a bullet ray. Nearest hit across world colliders and living targets.
 * Per target: head sphere tested before body (E3). World geometry blocks the
 * shot (a nearer wall wins over a farther target, and vice-versa).
 *
 * @param {THREE.Vector3} origin  camera-center origin (E1)
 * @param {THREE.Vector3} dir     UNIT direction (spread already applied by caller)
 * @param {number} maxDist        ray length (bullets: large/"unlimited")
 * @param {Array<{min:V3,max:V3}>} worldColliders
 * @param {Array} targets         living-or-not; dead ones skipped
 * @param {object} out            result, reused; see makeHitResult()
 * @returns {object} out
 */
export function castRay(origin, dir, maxDist, worldColliders, targets, out) {
  out.hitSomething = false;
  out.target = null;
  out.isHead = false;
  out.dist = maxDist;
  let best = maxDist;
  let found = false;

  // World blocks shots (E3/E13): closest wall caps how far a target can be hit.
  if (worldColliders) {
    for (let i = 0; i < worldColliders.length; i++) {
      const c = worldColliders[i];
      const t = rayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, c.min, c.max, best);
      if (t >= 0 && t < best) {
        best = t;
        found = true;
        out.target = null;
        out.isHead = false;
        out.normalAxis = _slabAxis;
        out.normalSign = _slabSign;
      }
    }
  }

  // Characters. Head sphere FIRST — if the head is hit at/inside the body
  // distance it wins the target as a headshot (generous, E3).
  if (targets) {
    for (let i = 0; i < targets.length; i++) {
      const tgt = targets[i];
      if (!tgt || tgt.dead) continue; // E2-adjacent: no dead/absent targets; self not in the list

      const th = raySphere(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
        tgt.headCenter, tgt.headRadius, best);
      if (th >= 0 && th < best) {
        best = th;
        found = true;
        out.target = tgt;
        out.isHead = true;
      }

      const tb = rayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
        tgt.bodyMin, tgt.bodyMax, best);
      if (tb >= 0 && tb < best) {
        // E3: "ray clips both → head wins." If this target's head already owns
        // the hit, a body entry inside the head/neck overlap seam must not
        // demote it — only a body hit nearer by more than the seam epsilon is
        // a genuinely body-first ray (e.g. side-on into the torso).
        const keepHead = out.target === tgt && out.isHead && (best - tb) < HEAD_SEAM_EPS;
        best = tb;
        found = true;
        out.target = tgt;
        out.isHead = keepHead;
      }
    }
  }

  out.hitSomething = found;
  out.dist = best;
  if (found) {
    out.point.set(origin.x + dir.x * best, origin.y + dir.y * best, origin.z + dir.z * best);
  }
  return out;
}

/**
 * Line-of-sight test for bots (Phase 3): is the straight segment from `origin`
 * along UNIT `dir` for `maxDist` blocked by any WORLD collider? Characters are
 * intentionally ignored — a bot must be able to see (and shoot past) friends and
 * foes; only geometry blocks sight. Zero-alloc (reuses rayBox's module scratch).
 *
 * Used by bots.js for staggered LOS raycasts (never all bots the same frame).
 * Additive helper — does not touch castRay/castKnife.
 *
 * @param {THREE.Vector3} origin  ray start (a bot's headCenter)
 * @param {THREE.Vector3} dir     UNIT direction toward the target
 * @param {number} maxDist        distance to the target (don't test past it)
 * @param {Array<{min:V3,max:V3}>} worldColliders
 * @returns {boolean} true if a wall is between origin and the target
 */
export function rayBlocked(origin, dir, maxDist, worldColliders) {
  if (!worldColliders) return false;
  for (let i = 0; i < worldColliders.length; i++) {
    const c = worldColliders[i];
    const t = rayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, c.min, c.max, maxDist);
    if (t >= 0 && t < maxDist) return true; // a wall sits before the target → no sight
  }
  return false;
}

/**
 * Cast the knife ray: range-limited, walls respected (E13), body AABB grown
 * by `pad` so a near-miss still connects (generous). Knife CANNOT headshot
 * (E14) — the head sphere is never tested; the padded body carries the head
 * region anyway.
 *
 * @param {THREE.Vector3} origin
 * @param {THREE.Vector3} dir     UNIT direction
 * @param {number} range         knife reach (COMBAT.knife.range)
 * @param {Array<{min:V3,max:V3}>} worldColliders
 * @param {Array} targets
 * @param {object} out
 * @param {number} pad           body AABB expansion (COMBAT.knife.hitPad)
 * @returns {object} out
 */
export function castKnife(origin, dir, range, worldColliders, targets, out, pad = 0) {
  out.hitSomething = false;
  out.target = null;
  out.isHead = false; // E14: knife never scores a headshot
  out.dist = range;
  let best = range;
  let found = false;

  // A nearer wall blocks the stab — no stabbing through doors (E13).
  if (worldColliders) {
    for (let i = 0; i < worldColliders.length; i++) {
      const c = worldColliders[i];
      const t = rayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, c.min, c.max, best);
      if (t >= 0 && t < best) {
        best = t;
        found = true;
        out.target = null;
        out.normalAxis = _slabAxis;
        out.normalSign = _slabSign;
      }
    }
  }

  if (targets) {
    for (let i = 0; i < targets.length; i++) {
      const tgt = targets[i];
      if (!tgt || tgt.dead) continue;
      // Body grown by pad on every side — generous reach (§4B). Reuse _p as
      // the padded-min and _hit as the padded-max scratch to stay zero-alloc.
      _p.set(tgt.bodyMin.x - pad, tgt.bodyMin.y - pad, tgt.bodyMin.z - pad);
      _hit.set(tgt.bodyMax.x + pad, tgt.bodyMax.y + pad, tgt.bodyMax.z + pad);
      const t = rayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, _p, _hit, best);
      if (t >= 0 && t < best) {
        best = t;
        found = true;
        out.target = tgt;
      }
    }
  }

  out.hitSomething = found;
  out.dist = best;
  if (found) {
    out.point.set(origin.x + dir.x * best, origin.y + dir.y * best, origin.z + dir.z * best);
  }
  return out;
}
