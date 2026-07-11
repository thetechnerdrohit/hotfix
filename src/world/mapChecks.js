// ============================================================================
// Shared DEV-only map self-check (register group K8/K9). Factored out of
// prodMap's inline runSelfCheck so the "Shoots" map (and any future map) reuses
// the SAME authoring assertions. Runs only under import.meta.env.DEV — zero cost
// in a production build. Every failure console.warns with enough detail to find
// the bad node/spawn/link the moment the map loads; a clean map prints one
// summary line proving the check ran.
//
// A map descriptor for this check is:
//   { name, colliders:[{min,max}], seSpawns:[{pos,yaw}], bugSpawns:[{pos,yaw}],
//     waypointNodes:[{x, z, y?, links:number[]}] }   (y omitted ⇒ 0)
//
// The checks (all y-AWARE for v1.2 verticality):
//   (a) CONNECTIVITY: BFS from node 0 reaches every node (unchanged — topology
//       is height-agnostic). Plus link-symmetry (one-way links are typos).
//   (b) SPAWN CLEARANCE (D5): every spawn clears every body-height collider by
//       ≥ CLEAR m in XZ — checked only against colliders that overlap the
//       spawn's OWN height band [spawnY, spawnY+bodyH] (K9), so a wall on another
//       deck doesn't false-flag.
//   (b2) SPAWN FLOOR SUPPORT: a collider top sits at the spawn's OWN y (K9) — the
//       visual-only-floor bug (player fell through the world) at the spawn's deck.
//   (c) LINK LOS: each link, tested along a ray at the link's eye height (node
//       ys lerped end→end + eye offset, K8), is rayBlocked-free — a link must not
//       cut through a wall/rack. Height-correct so a link over a low rail passes
//       and a link into a wall fails.
//   (d) LINK SLOPE (NEW, K5): a link whose |Δy| exceeds SLOPE_MAX per metre of
//       XZ run is flagged — stairs must be authored as graph edges with sane
//       rises (steeper than this reads as a teleport/elevator, not a walkable
//       slope). A purely-vertical link (zero XZ run, nonzero Δy) is always bad.
// ============================================================================

import * as THREE from 'three';
import { rayBlocked } from '../combat/hitscan.js';

const CLEAR = 0.6;      // m — min spawn XZ clearance from body-height geometry (D5)
const EYE = 1.0;        // m — chest/eye height offset the LOS ray rides at (over the deck)
const BODY_H = 1.8;     // m — player/bot standing height (matches MOVE.height / D12)
const SLOPE_MAX = 0.45; // K5 — max |Δy| per metre of XZ run a link may climb (stairs cap)

// Scratch — module-scope so the check allocates nothing per node/link (I1).
const _from = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * Run every authoring assertion against a map descriptor. DEV-only — the caller
 * guards with import.meta.env.DEV. Returns nothing; warns per failure.
 * @param {{name:string, colliders:Array, seSpawns:Array, bugSpawns:Array, waypointNodes:Array}} map
 */
export function runMapSelfCheck(map) {
  const tag = `[${map.name ?? 'map'}]`;
  const nodes = map.waypointNodes;
  const n = nodes.length;
  const ny = (i) => nodes[i].y ?? 0; // node deck height (default 0)

  // (a) BFS connectivity from node 0 + link symmetry.
  const seen = new Uint8Array(n);
  const queue = [0];
  seen[0] = 1;
  let reached = 1;
  while (queue.length) {
    const cur = queue.shift();
    const links = nodes[cur].links;
    for (let i = 0; i < links.length; i++) {
      const nb = links[i];
      if (nb < 0 || nb >= n) { console.warn(`${tag} node ${cur} links to out-of-range ${nb}`); continue; }
      if (!seen[nb]) { seen[nb] = 1; reached++; queue.push(nb); }
    }
  }
  if (reached !== n) {
    const missing = [];
    for (let i = 0; i < n; i++) if (!seen[i]) missing.push(i);
    console.warn(`${tag} SELF-CHECK (a) connectivity: BFS from 0 reached ${reached}/${n} nodes; unreachable: [${missing.join(',')}]`);
  }
  for (let i = 0; i < n; i++) {
    const links = nodes[i].links;
    for (let j = 0; j < links.length; j++) {
      const nb = links[j];
      if (nb < 0 || nb >= n) continue;
      if (!nodes[nb].links.includes(i)) {
        console.warn(`${tag} SELF-CHECK link asymmetry: ${i}→${nb} but not ${nb}→${i}`);
      }
    }
  }

  // (b) Spawn clearance ≥ CLEAR m from every body-height collider AT THE SPAWN'S
  //     OWN HEIGHT (K9). Only colliders whose y span overlaps [spawnY, spawnY+H]
  //     can wedge the spawn; geometry on another deck is ignored.
  const checkSpawn = (label, arr) => {
    for (let s = 0; s < arr.length; s++) {
      const p = arr[s].pos;
      const feetY = p.y, headY = p.y + BODY_H;
      for (let i = 0; i < map.colliders.length; i++) {
        const c = map.colliders[i];
        if (c.max.y <= 0.05) continue;                 // floor / flat strip — ignore
        if (c.max.y <= feetY + 0.05 || c.min.y >= headY) continue; // K9: no height-band overlap
        const cx = Math.max(c.min.x, Math.min(p.x, c.max.x));
        const cz = Math.max(c.min.z, Math.min(p.z, c.max.z));
        const dx = p.x - cx, dz = p.z - cz;
        if (dx * dx + dz * dz < CLEAR * CLEAR) {
          console.warn(`${tag} SELF-CHECK (b) spawn clearance: ${label} spawn ${s} (${p.x},${p.y},${p.z}) is <${CLEAR}m from collider ${i}`);
          break;
        }
      }
    }
  };
  checkSpawn('SE', map.seSpawns);
  checkSpawn('Bug', map.bugSpawns);

  // (b2) Spawn FLOOR SUPPORT at the spawn's OWN y (K9): some collider top sits
  //      at/just below the spawn feet AND contains its XZ. Catches the visual-
  //      only-floor bug on any deck (not just y=0).
  const checkSupport = (label, arr) => {
    for (let s = 0; s < arr.length; s++) {
      const p = arr[s].pos;
      let supported = false;
      for (let i = 0; i < map.colliders.length; i++) {
        const c = map.colliders[i];
        if (p.x < c.min.x || p.x > c.max.x || p.z < c.min.z || p.z > c.max.z) continue;
        if (c.max.y <= p.y + 0.01 && c.max.y >= p.y - 0.5) { supported = true; break; }
      }
      if (!supported) {
        console.warn(`${tag} SELF-CHECK (b2) NO FLOOR under ${label} spawn ${s} (${p.x},${p.y},${p.z}) — the player will fall out of the world (D9)`);
      }
    }
  };
  checkSupport('SE', map.seSpawns);
  checkSupport('Bug', map.bugSpawns);

  // (c) LINK LOS + (d) LINK SLOPE. Both walk each undirected link once.
  let checkedPairs = 0, blocked = 0, steep = 0;
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    const ay = ny(i);
    for (let j = 0; j < a.links.length; j++) {
      const bi = a.links[j];
      if (bi <= i) continue;               // each undirected pair once
      if (bi < 0 || bi >= n) continue;
      const b = nodes[bi];
      const by = ny(bi);

      const dx = b.x - a.x, dz = b.z - a.z;
      const xzLen = Math.sqrt(dx * dx + dz * dz);
      const dy = by - ay;

      // (d) SLOPE (K5): |Δy| per metre of XZ run must be ≤ SLOPE_MAX. A vertical
      // link (no XZ run but a height change) is always illegal — nothing to walk.
      if (xzLen < 1e-4) {
        if (Math.abs(dy) > 1e-3) {
          steep++;
          console.warn(`${tag} SELF-CHECK (d) link ${i}↔${bi} is vertical (Δy ${dy.toFixed(2)}m, no XZ run) — not a walkable slope (K5)`);
        }
      } else if (Math.abs(dy) / xzLen > SLOPE_MAX) {
        steep++;
        console.warn(`${tag} SELF-CHECK (d) link ${i}↔${bi} slope ${(Math.abs(dy) / xzLen).toFixed(2)}/m exceeds ${SLOPE_MAX}/m (Δy ${dy.toFixed(2)}m over ${xzLen.toFixed(1)}m) — author stairs with a gentler rise (K5)`);
      }

      // (c) LOS at eye height, ys lerped end→end + EYE offset over the deck (K8).
      if (xzLen < 1e-4) continue;          // no XZ ray to cast on a vertical link
      _from.set(a.x, ay + EYE, a.z);
      _dir.set(dx, dy, dz);                // include the height delta so the ray rides the slope
      const dist = _dir.length();
      _dir.multiplyScalar(1 / dist);
      checkedPairs++;
      if (rayBlocked(_from, _dir, dist, map.colliders)) {
        blocked++;
        console.warn(`${tag} SELF-CHECK (c) link ${i}↔${bi} crosses geometry (len ${dist.toFixed(1)}m, eye y=${(ay + EYE).toFixed(1)}→${(by + EYE).toFixed(1)})`);
      }
    }
  }

  console.log(`${tag} self-check: ${reached}/${n} nodes reachable, ${map.seSpawns.length + map.bugSpawns.length} spawns checked, ${checkedPairs} links LOS-tested (${blocked} blocked), ${steep} over-steep.`);
}
