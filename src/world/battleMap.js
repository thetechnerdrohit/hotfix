// ============================================================================
// "BATTLEGROUND" (v2.0) — the big one. Rohit's brief, verbatim: "like PUBG maps
// bro but in low poly and our squid-game theme, keep open spaces too, make it
// big, 4x of current" with "big trees, ropes, camping house — all interactive."
//
// Layout (~192 × 192 m, pastel palette):
//   • CENTER: the cloned ar_shoots compound (buildShootsMap embedded with a
//     GATED berm — four 7 m doors) = the central POI, fully intact: carved
//     ramps, deck ropes, LED/vent animation, 856-node interior nav.
//   • FIELDS: open ground ringing the compound (the PUBG breathing room),
//     sparse cover crates, small decorative trees.
//   • 4 CAMP CLUSTERS (corners): two enterable huts each (1.4 m doorways,
//     walk-in interiors, flat roofs) + a ROPE to one roof per camp.
//   • 8 GREAT TREES: thick trunks, mint canopies, a sniper STAND at 3.4 m with
//     a ROPE up — the treehouse fantasy, point-placed around the mid ring.
//   • Perimeter berm ±96 (sealed, D9); pink skyline ring rebuilt OUTSIDE it.
//
// Interactables: every rope uses the v1.5 mechanic (hold W to climb,
// deterministic authored landings — all landings sit on colliders THIS module
// authors, so headroom is by construction). Roofs/stands are player-only
// perches; bots keep ground+compound routes and can still shoot up (3D aim).
//
// NAV: compound interior graph (reindexed) + a generated field lattice (8 m,
// skipping POI footprints) + bridge links through the four gates. DEV
// self-check asserts single-component connectivity.
//
// Map rules: hut walls 0.35 m thick (≥ the 0.23 m/frame max step at the dt
// clamp — no tunneling), doorways ≥ 1.4 (D6), roofs at 2.7 (jump apex can't
// accidentally mount them — rope-only), sealed outer berm (D9), zero
// per-frame allocation (update() delegates to the compound's).
// ============================================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PERF } from '../config.js';
import { buildShootsMap } from './shootsMap.js';
import { makeSignTexture, makeSignMesh } from './decor.js';
import BACKDROP from './shootsBackdrop.json';

const FIELD_HALF = 96;     // playable half-extent
const BERM_H = 5, BERM_T = 1.2;

const P = {
  field:  0xb5c9b4,   // open-field pastel green-grey
  fieldB: 0xc4d2b6,   // patch tint
  berm:   0xc86f96,   // deep pink ring
  hutWall: 0xe9a9c4,  // bubblegum hut
  hutRoof: 0xc4e3ad,  // mint roof
  hutTrim: 0xe9cf4f,  // yellow trim
  trunk:  0x8a6a52,   // tree trunk
  canopy: 0x9fd3a4,   // mint canopy
  canopyB: 0x86c98f,
  stand:  0xf0c3d5,   // pale pink sniper stand
  crate:  0x8fd8cc,   // teal field crates
  rock:   0xcabcc2,   // pastel rock
  rope:   0xb8925a,
};

export function buildBattleMap() {
  const group = new THREE.Group();

  // -- CENTRAL POI: the compound, gated, without its own skyline -------------
  const compound = buildShootsMap({ berm: 'gated', backdrop: false });
  group.add(compound.group);
  const colliders = compound.colliders.slice(); // extended below
  const ropes = compound.ropes.slice();

  // -- merge-bucket helper (same discipline as the other maps) ---------------
  const buckets = new Map();
  function addRender(w, h, d, x, y, z, color) {
    const g0 = new THREE.BoxGeometry(Math.max(0.02, w), Math.max(0.02, h), Math.max(0.02, d));
    g0.translate(x, y, z);
    if (!buckets.has(color)) buckets.set(color, []);
    buckets.get(color).push(g0);
  }
  function addBox(w, h, d, x, base, z, color, { collide = true } = {}) {
    addRender(w, h, d, x, base + h / 2, z, color);
    if (collide) {
      colliders.push({
        min: new THREE.Vector3(x - w / 2, base, z - d / 2),
        max: new THREE.Vector3(x + w / 2, base + h, z + d / 2),
      });
    }
  }

  // -- FIELD GROUND + OUTER BERM ---------------------------------------------
  addBox(FIELD_HALF * 2 + 8, 0.5, FIELD_HALF * 2 + 8, 0, -0.5, 0, P.field); // top y=0
  // soft tint patches (visual only) for field variation
  const seedState = { s: 4242 };
  const rnd = () => (seedState.s = (seedState.s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 14; i++) {
    addBox(10 + rnd() * 18, 0.04, 8 + rnd() * 16, (rnd() * 2 - 1) * 82, 0.005, (rnd() * 2 - 1) * 82, P.fieldB, { collide: false });
  }
  addBox(FIELD_HALF * 2 + BERM_T * 2, BERM_H, BERM_T, 0, 0, -FIELD_HALF - BERM_T / 2, P.berm);
  addBox(FIELD_HALF * 2 + BERM_T * 2, BERM_H, BERM_T, 0, 0, FIELD_HALF + BERM_T / 2, P.berm);
  addBox(BERM_T, BERM_H, FIELD_HALF * 2 + BERM_T * 2, -FIELD_HALF - BERM_T / 2, 0, 0, P.berm);
  addBox(BERM_T, BERM_H, FIELD_HALF * 2 + BERM_T * 2, FIELD_HALF + BERM_T / 2, 0, 0, P.berm);

  // -- CAMP CLUSTERS (4 corners) ----------------------------------------------
  // A hut: 5 × 4 footprint, 0.35 walls, 1.4 door gap on +Z face, roof slab 2.7.
  function hut(cx, cz, doorSide /* +1 = +z, -1 = -z */) {
    const W = 5, D = 4, H = 2.5, T = 0.35;
    addBox(W, H, T, cx, 0, cz - doorSide * (D / 2 - T / 2), P.hutWall);           // back wall
    addBox(T, H, D, cx - W / 2 + T / 2, 0, cz, P.hutWall);                         // left
    addBox(T, H, D, cx + W / 2 - T / 2, 0, cz, P.hutWall);                         // right
    const seg = (W - 1.4) / 2;                                                     // door face: two segments
    addBox(seg, H, T, cx - (1.4 / 2 + seg / 2), 0, cz + doorSide * (D / 2 - T / 2), P.hutWall);
    addBox(seg, H, T, cx + (1.4 / 2 + seg / 2), 0, cz + doorSide * (D / 2 - T / 2), P.hutWall);
    addBox(W + 0.5, 0.25, D + 0.5, cx, H + 0.1, cz, P.hutRoof);                    // roof slab (rope-only)
    addBox(W + 0.6, 0.12, 0.3, cx, H - 0.15, cz + doorSide * (D / 2 + 0.1), P.hutTrim, { collide: false });
    return { roofY: H + 0.35, cx, cz };
  }
  const campSigns = [];
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const cx = sx * 66, cz = sz * 66;
    const h1 = hut(cx - 3.2, cz, sz > 0 ? -1 : 1);
    hut(cx + 3.4, cz + (sz > 0 ? 2.5 : -2.5), sz > 0 ? -1 : 1);
    // crates + a rope to hut-1's roof (landing = authored roof center)
    addBox(1.1, 1.0, 1.1, cx + 0.2, 0, cz + (sz > 0 ? -3.4 : 3.4), P.crate);
    addBox(0.9, 0.6, 0.9, cx - 1.4, 0, cz + (sz > 0 ? -4.2 : 4.2), P.crate);
    ropes.push({
      x: h1.cx - 2.8, z: h1.cz, yBottom: 0, yTop: h1.roofY + 0.45,
      land: { x: h1.cx - 1.6, y: h1.roofY + 0.05, z: h1.cz },
    });
    campSigns.push([cx, cz]);
  }

  // -- GREAT TREES (8, mid-ring) — climbable sniper stands ---------------------
  const GREATS = [
    [-52, -20], [52, 20], [-20, -52], [20, 52],
    [-52, 34], [52, -34], [34, -52], [-34, 52],
  ];
  for (const [tx, tz] of GREATS) {
    addBox(0.62, 5.4, 0.62, tx, 0, tz, P.trunk);                       // trunk (collides)
    addBox(3.6, 1.5, 3.6, tx, 4.4, tz, P.canopy, { collide: false });  // canopy (shoot/walk-through)
    addBox(2.6, 1.3, 2.6, tx, 5.6, tz, P.canopyB, { collide: false });
    addBox(1.8, 1.1, 1.8, tx, 6.6, tz, P.canopy, { collide: false });
    addBox(1.7, 0.22, 1.7, tx + 1.15, 3.3, tz, P.stand);               // sniper stand (collides)
    ropes.push({
      x: tx + 1.15, z: tz + 1.0, yBottom: 0, yTop: 3.95,
      land: { x: tx + 1.15, y: 3.57, z: tz },
    });
  }

  // -- small decorative trees + field cover ------------------------------------
  for (let i = 0; i < 26; i++) {
    const tx = (rnd() * 2 - 1) * 88, tz = (rnd() * 2 - 1) * 88;
    if (Math.abs(tx) < 50 && Math.abs(tz) < 46) continue; // keep compound approaches open
    addBox(0.3, 2.6 + rnd() * 1.2, 0.3, tx, 0, tz, P.trunk);
    addBox(1.6 + rnd(), 1.2, 1.6 + rnd(), tx, 2.4 + rnd(), tz, rnd() < 0.5 ? P.canopy : P.canopyB, { collide: false });
  }
  for (let i = 0; i < 12; i++) {
    const rx = (rnd() * 2 - 1) * 80, rz = (rnd() * 2 - 1) * 80;
    if (Math.abs(rx) < 48 && Math.abs(rz) < 44) continue;
    if (rnd() < 0.5) addBox(1.4, 0.9, 1.2, rx, 0, rz, P.rock);
    else addBox(1.1, 1.0, 1.1, rx, 0, rz, P.crate);
  }

  // -- ROPE VISUALS (all non-compound ropes; compound drew its own) ------------
  {
    const ropeGeos = [];
    for (const r of ropes.slice(compound.ropes.length)) {
      const line = new THREE.BoxGeometry(0.07, r.yTop - r.yBottom, 0.07);
      line.translate(r.x, (r.yTop + r.yBottom) / 2, r.z);
      ropeGeos.push(line);
      for (let y = 0.5; y < r.yTop - 0.2; y += 0.75) {
        const knot = new THREE.BoxGeometry(0.16, 0.1, 0.16);
        knot.translate(r.x, y, r.z);
        ropeGeos.push(knot);
      }
    }
    const mesh = new THREE.Mesh(mergeGeometries(ropeGeos, false), new THREE.MeshLambertMaterial({ color: P.rope }));
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    mesh.castShadow = PERF.shadows;
    group.add(mesh);
  }

  // -- SKYLINE ring rebuilt OUTSIDE the field berm ------------------------------
  {
    const skyGeos = [];
    for (const b of BACKDROP.boxes) {
      // RADIAL placement: keep each block's direction from center but push its
      // radius past the field berm (pure scaling left inner-ring blocks inside
      // the field — the vista camera ended up inside one).
      const bx = b.c[0], bz = b.c[2] + 14.63;
      const r = Math.max(Math.abs(bx), Math.abs(bz), 1);
      const rOut = FIELD_HALF + 14 + Math.max(0, r - 41) * 1.3;
      const f = rOut / r;
      const g0 = new THREE.BoxGeometry(Math.max(0.05, b.s[0]), Math.max(0.05, b.s[1]), Math.max(0.05, b.s[2]));
      g0.translate(bx * f, Math.max(b.c[1], b.s[1] / 2 - 0.5), bz * f);
      skyGeos.push(g0);
    }
    const sky = new THREE.Mesh(mergeGeometries(skyGeos, false), new THREE.MeshLambertMaterial({ color: 0xdbb6c8 }));
    sky.matrixAutoUpdate = false; sky.updateMatrix();
    group.add(sky);
  }

  // -- merge static buckets -----------------------------------------------------
  for (const [color, geos] of buckets) {
    const mesh = new THREE.Mesh(
      geos.length === 1 ? geos[0] : mergeGeometries(geos, false),
      new THREE.MeshLambertMaterial({ color }),
    );
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    mesh.castShadow = PERF.shadows;
    mesh.receiveShadow = PERF.shadows;
    group.add(mesh);
  }
  // camp signs (after merge — decor keeps its own tiny draw calls)
  for (const [cx, cz] of campSigns) {
    const sign = makeSignMesh(makeSignTexture('CAMP', '#e9cf4f'), 2.4, 0.6);
    sign.position.set(cx, 3.4, cz);
    group.add(sign);
  }

  // -- NAV: compound graph + field lattice + gate bridges -----------------------
  const nodes = compound.waypointNodes.map((n) => ({ x: n.x, y: n.y, z: n.z, links: n.links.slice() }));
  const base = nodes.length;
  const lattice = new Map(); // "gx,gz" → node index
  const STEP = 8;
  const inPoi = (x, z) => {
    if (Math.abs(x) < 46 && z > -44 && z < 34) return true; // compound + margin
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      if (Math.abs(x - sx * 66) < 8 && Math.abs(z - sz * 66) < 8) return true; // camps
    }
    for (const [tx, tz] of GREATS) if (Math.abs(x - tx) < 2.4 && Math.abs(z - tz) < 2.4) return true;
    return false;
  };
  for (let gx = -11; gx <= 11; gx++) {
    for (let gz = -11; gz <= 11; gz++) {
      const x = gx * STEP, z = gz * STEP;
      if (Math.abs(x) > FIELD_HALF - 4 || Math.abs(z) > FIELD_HALF - 4) continue;
      if (inPoi(x, z)) continue;
      lattice.set(`${gx},${gz}`, nodes.length);
      nodes.push({ x, y: 0, z, links: [] });
    }
  }
  for (const [key, idx] of lattice) {
    const [gx, gz] = key.split(',').map(Number);
    for (const [dx, dz] of [[1, 0], [0, 1]]) {
      const nb = lattice.get(`${gx + dx},${gz + dz}`);
      if (nb !== undefined) { nodes[idx].links.push(nb); nodes[nb].links.push(idx); }
    }
  }
  // bridges: gate ↔ nearest field node AND gate ↔ nearest compound node
  for (const gate of compound.gates) {
    let bestF = -1, bfd = 1e9, bestC = -1, bcd = 1e9;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.y > 0.5) continue;
      const d = (n.x - gate.x) ** 2 + (n.z - gate.z) ** 2;
      if (i >= base) { if (d < bfd) { bfd = d; bestF = i; } }
      else if (d < bcd) { bcd = d; bestC = i; }
    }
    if (bestF >= 0 && bestC >= 0) {
      nodes[bestF].links.push(bestC);
      nodes[bestC].links.push(bestF);
    }
  }
  // DEV self-check: single connected component
  if (import.meta.env.DEV) {
    const seen = new Uint8Array(nodes.length);
    const q = [0]; seen[0] = 1; let reach = 1;
    while (q.length) { const c = q.pop(); for (const nb of nodes[c].links) if (!seen[nb]) { seen[nb] = 1; reach++; q.push(nb); } }
    if (reach !== nodes.length) console.warn(`[battle] NAV connectivity ${reach}/${nodes.length} — field/compound bridge broken`);
    else console.info(`[battle] nav OK: ${nodes.length} nodes (${base} compound + ${nodes.length - base} field), 1 component`);
  }

  // -- SPAWNS: field edges (PUBG drop vibe — fight toward the center) -----------
  const YAW_E = -Math.PI / 2, YAW_W = Math.PI / 2;
  const seSpawns = [
    { pos: new THREE.Vector3(-86, 0, -12), yaw: YAW_E },
    { pos: new THREE.Vector3(-86, 0, 0), yaw: YAW_E },
    { pos: new THREE.Vector3(-86, 0, 12), yaw: YAW_E },
    { pos: new THREE.Vector3(-80, 0, -24), yaw: YAW_E },
    { pos: new THREE.Vector3(-80, 0, 24), yaw: YAW_E },
  ];
  const bugSpawns = seSpawns.map((s) => ({ pos: new THREE.Vector3(-s.pos.x, 0, -s.pos.z), yaw: YAW_W }));

  return {
    group,
    colliders,
    spawnPoint: seSpawns[0].pos.clone(),
    name: 'battle',
    seSpawns,
    bugSpawns,
    waypointNodes: nodes,
    ropes,
    background: compound.background,
    fog: new THREE.Fog(compound.fog.color, 70, 320), // big-field visibility
    update: compound.update, // LED/vent animation lives in the embedded POI
  };
}
