// ============================================================================
// "Shoots" — the v1.2 capstone map, built VERBATIM from Rohit's ar_shoots.fbx.
// This is the DEFAULT map that ships; Prod is demoted to the DEV-only ?room=prod.
//
// SOURCE OF TRUTH: src/world/shootsGeometry.json (a copy of
// reference/shoots-geometry.json) — 1,674 world-AABBs covering EVERY
// playable-region mesh of ar_shoots.fbx at true scale in meters:
//   { c:[cx,cy,cz], s:[sx,sy,sz], k:'floor'|'wall'|'stair'|'platform'|'prop' }
//   c = box CENTER (y included), s = full size.
// We construct the map 1:1 from that list:
//   • EVERY box → a per-box AABB collider (verbatim) AND merge-bucketed render
//     geometry (bucketed by class + height band for the palette). ~1,674
//     colliders (AABB tests are cheap); render merges to ≤20 draw objects (I6).
//   • NO condensing, NO reinterpretation. The ONLY transform is a single uniform
//     translate z += DZ so the model's 180°-point-symmetry center (0, −14.63 in
//     the data — verified: 994/1674 exact twin matches) lands at the world
//     ORIGIN. X is unchanged (the symmetry X is already 0). True heights
//     (3.25–3.5 m decks, up to ~7 m walls / ~12 m prop towers) are preserved.
//   • The ONE added geometry is a sealing perimeter BERM around the region
//     (D9) — the void beyond the extracted extent needs a wall.
//
// AXES (post-translate): X = WEST(−)/EAST(+), Z = SOUTH(−)/NORTH(+). The two big
// spawn end-yards sit at the ±Z extremes. YAW (camera.js): forward XZ =
// (−sin(yaw),0,−cos(yaw)); yaw 0 → −Z, yaw π → +Z.
//
// RULE HANDLING (per the verbatim mandate): the DEV self-check (mapChecks) will
// flag source-authentic tight spots (real Source brush gaps). Those are DEMOTED
// to console.info — we do NOT "fix" the model. The self-check still hard-warns on
// graph problems (unreachable nodes, over-steep links, spawn issues) that are
// OURS to get right. Genuine player-traps (a gap the 0.8 m player can enter but
// not leave) are patched by the minimal weld and logged below.
//
// ---------------------------------------------------------------------------
// MODIFICATIONS (every deviation from the raw dataset — kept minimal):
//   M1. Uniform translate z += 14.63 (recenter the symmetry point to origin).
//       Positions otherwise byte-untouched.
//   M2. Added a sealing perimeter berm (4 walls, 4 m tall) just outside the
//       region bounds (D9 — the dataset has no outer skybox brush). The one
//       allowed geometry addition.
//   M3. Render-only: boxes with a near-zero size axis (h or footprint < 0.02 m,
//       degenerate source slabs) get that axis clamped to 0.02 m for the MESH so
//       it isn't a zero-area face (z-fight/NaN-normal). The COLLIDER keeps the
//       verbatim size. No position change.
//   (No player-trap welds were required — the region is a large open arena; the
//    tight spots the self-check flags are all wall-to-wall seams inside solid
//    structures, not enterable pockets. If a weld is ever needed it appears here.)
//   M6. STAIR CARVE (shootsCarve.js) — the fix that makes the high decks
//       CLIMBABLE. The FBX AABB export buried the source's real stair treads
//       inside SOLID `prop` boxes (ground → ~3.1 m); a 0.4 m step-up reached
//       nothing above ~1.6 m, so 0/10 decks were climbable. The carve REPLACES
//       every ground-founded tall prop (k='prop', h≥1.5 m, bottom<0.6 m) whose
//       footprint hits a source stair-run rect (shootsStairRuns.json) with a set
//       of stepped tread slabs following that run's own fromY→toY climb at
//       ≤0.30 m/step. Prop cells NOT under a run keep the original top (sheer
//       face stays sheer); the footprint is tiled EXACTLY per prop so top-down
//       OCCUPANCY is unchanged. 54 props → 302 terraced slabs. Representative
//       per-prop records (c=center, s=size, runs=served stair-run indices):
//         M6.1  c[-3.11,-23.70] s[17.6×3.1×14.9] run[2]  solid 0→3.08 → 11 terraces 0.34→3.08  (central-W deck, S face)
//         M6.2  c[ 3.11, -5.56] s[17.6×3.1×14.9] run[3]  solid 0→3.08 → 11 terraces 0.34→3.08  (central-E deck, twin)
//         M6.3  c[ 4.84, 12.43] s[17.0×4.4×11.8] run[4,5] solid 0→3.85 → 11 terraces 1.84→3.85 (N cap deck)
//         M6.4  c[-4.84,-41.71] s[17.0×4.4×11.8] run[6,7] solid 0→3.85 → 11 terraces 1.82→3.85 (S cap deck, twin)
//         M6.5  c[-35.9,-40.12] s[12.0×5.3×16.7] run[0]  solid 0→5.09 →  6 terraces 0.32→5.09  (SW corner bldg)
//         M6.6  c[ 35.9, -1.96] s[12.0×5.3×16.7] run[1]  solid 0→5.09 →  9 terraces 0.58→5.09  (NE corner bldg, twin)
//         …48 more smaller props (the full log is returned by carveShoots().log
//          and echoed to console in DEV).
//       RESULT (measured by the AS-BUILT CLIMB-SIM in verify-shoots.mjs — a
//       ground flood-fill under the REAL 0.4 m step-up / 1.8 m headroom rules, NOT
//       the looser nav walk() tolerance): the carve makes the TWO BIG CENTRAL
//       DECKS (top 3.51 m, the point-symmetric pair — the tactical high ground)
//       fully climbable foot→top, plus the two medium side platforms (top 1.62 m,
//       reached to 3.26 m as they abut the central deck edge). That is the shipped
//       verticality. UNREACHABLE-BY-DESIGN (documented, NOT force-fixed — no
//       geometry invented): the two small 3.29 m N/S cap decks (their run-up
//       terraces stall ~1.5–3 m below the cap, which sits behind the big deck's
//       cliff face — a partial source run), the ±5 m corner buildings (their runs
//       climb into 5–11 m walls, no standable roof at a reachable height), and the
//       three 4.7 m² corner stubs (~0 rendered treads). The carve still tiles all
//       of these props' footprints verbatim (occupancy preserved), so they read as
//       carved terraces in the plan but are cover, not routes.
//       IMPORTANT: an earlier banner here claimed "8 of 10 decks reachable" — that
//       counted nav-graph node PLACEMENT, which the sparse walk() tolerance floats
//       onto partial ramps. The climb-sim is the source of truth and hard-fails if
//       either big central deck ever stops summiting.
//   M7. NAV: waypoints AUTO-FITTED to the CARVED geometry (shootsNav.json via
//       scripts/gen-shoots-nav.mjs), NOT hand-placed — verbatim ar_shoots is a
//       dense wall-maze a sparse graph can't connect. Two layers: the ground
//       walkable network + elevated chains up the carved ramps onto the two big
//       central decks (~3.5 m) + side platforms. Fully connected, point-symmetric
//       spawns; harness green — 854 nodes, ~129 elevated (>2.8 m) split ~59/67
//       across the two decks, 126/129 with a point-symmetric twin.
//
// NOTE on the top-down check: a height carve necessarily LOWERS a run's height
// band (a cliff becomes a staircase), so the dataset-vs-built comparison is
// OCCUPANCY-based (is every footprint cell still filled?) — that is the
// directive's "footprint unchanged / never move or remove footprint area". The
// carved height-bucket delta is reported as expected; occupancy mismatch is 0.
// ---------------------------------------------------------------------------
//
// PERF: colliders = per-box AABB list; render merged per (class,band) bucket →
// ≤20 meshes. matrixAutoUpdate=false. update() pulses shared emissive lamp mats
// only (zero per-frame alloc). Palette/lights/signs re-dressed ONTO the real
// geometry. mapChecks integration + verify-shoots.mjs (loads the SAME JSON) kept.
// ============================================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PERF } from '../config.js';
import GEO from './shootsGeometry.json';
import RUNS from './shootsStairRuns.json'; // source stair-run + deck rects (from reference/shoots-layout.json)
import NAV from './shootsNav.json'; // auto-fitted waypoint graph (ground + carved roofs; see buildWaypoints)
import { carveShoots } from './shootsCarve.js'; // M6 stair carve → walkable deck/roof ramps
import { makeSignTexture, makeGradientTexture, makeSignMesh } from './decor.js';
import { runMapSelfCheck } from './mapChecks.js';

// M1 — the single uniform recenter (symmetry point → origin).
const DZ = 14.63;

// Region bounds (from the dataset), used only for the sealing berm + lighting
// frustum. Post-translate Z = data Z + DZ.
const REGION = GEO.region;
const MINX = REGION.minX, MAXX = REGION.maxX;
const MINZ = REGION.minZ + DZ, MAXZ = REGION.maxZ + DZ;
const HALF_X = Math.max(Math.abs(MINX), Math.abs(MAXX)) + 2; // berm half-extent X
const HALF_Z = Math.max(Math.abs(MINZ), Math.abs(MAXZ)) + 2; // berm half-extent Z
const WALL_H = 4;   // berm height
const WALL_T = 1.0; // berm thickness

// -- Outdoor training-ground palette (Shoots' identity). Flat NoToneMapping
//    low-poly family; ground luminance ≥ Prod's readable range. Buckets are
//    keyed by (class, height band) so a box picks a palette entry deterministically.
const PALETTE = {
  ground:    0x8a7c55,  // floor / dust
  wallLow:   0x8f7f52,  // low walls (< 2 m over their base) — sand berm tone
  wallMid:   0x6f6247,  // mid walls
  wallHigh:  0x5a5038,  // tall walls / towers
  stair:     0xa9843f,  // stair/terrace timber
  platform:  0xb08a46,  // deck / platform planks
  propA:     0x9c8f66,  // props (lighter crate tone)
  propB:     0x7d5f2c,  // props (darker) — alternates for readability
  berm:      0x6b5f42,  // added sealing berm
  seAccent:  0x37b39a,  // SE end trim (teal)
  bugAccent: 0xd23a52,  // Bug end trim (guard pink-red, v1.4 theme)
};

const LED_TEAL = 0x37e0c2;
const LED_AMBER = 0xffcf6a;

// Choose a palette color for a carved box from its class + height (deterministic).
function colorFor(k, top, h, i) {
  switch (k) {
    case 'floor': return PALETTE.ground;
    case 'stair': return PALETTE.stair;
    case 'carveStair': return PALETTE.stair; // restored roof-ramp treads (M5–M6)
    case 'platform': return PALETTE.platform;
    case 'wall':
      return h >= 3.5 ? PALETTE.wallHigh : h >= 2 ? PALETTE.wallMid : PALETTE.wallLow;
    case 'prop': return (top > 5) ? PALETTE.wallHigh : (i & 1 ? PALETTE.propA : PALETTE.propB);
    default: return PALETTE.wallMid;
  }
}

export function buildShootsMap() {
  const group = new THREE.Group();
  const colliders = [];
  const buckets = new Map(); // colorHex → BufferGeometry[]

  // Add a box to a merge bucket. Render size clamps each axis to ≥0.02 (M3) so a
  // degenerate source slab isn't a zero-area mesh; the collider is passed the
  // VERBATIM size separately.
  function addRender(w, h, d, x, y, z, color) {
    const geo = new THREE.BoxGeometry(Math.max(w, 0.02), Math.max(h, 0.02), Math.max(d, 0.02));
    geo.translate(x, y, z); // c is the CENTER — bake it directly
    if (!buckets.has(color)) buckets.set(color, []);
    buckets.get(color).push(geo);
  }
  function addCollider(w, h, d, x, y, z) {
    colliders.push({
      min: new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2),
      max: new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2),
    });
  }

  // ==========================================================================
  // GEOMETRY — every dataset box (M1 translated) after the M6 stair carve
  // (shootsCarve.js: buried solid deck props → stepped tread slabs following the
  // source stair runs). Render + verbatim collider come from the carved list, so
  // collision matches the climbable stairs the model renders.
  // ==========================================================================
  // M6 CARVE runs in DATA-SPACE on the raw {c,s,k} boxes (the stair-run rects are
  // data-space too); the single M1 z += DZ translate is applied per box below.
  const carve = carveShoots(GEO.boxes, RUNS.stairRuns, RUNS.decks);
  let floorTopMin = Infinity;
  for (let i = 0; i < carve.boxes.length; i++) {
    const b = carve.boxes[i];
    const w = b.s[0], h = b.s[1], d = b.s[2];
    const x = b.c[0], y = b.c[1], z = b.c[2] + DZ; // M1 translate
    addRender(w, h, d, x, y, z, colorFor(b.k, y + h / 2, h, i));
    addCollider(w, h, d, x, y, z);
    if (b.k === 'floor') floorTopMin = Math.min(floorTopMin, y + h / 2);
  }

  // ==========================================================================
  // M2 — SEALING PERIMETER BERM (the one added geometry, D9). Four walls just
  // outside the region, inner face on the boundary; corners overlap (D3).
  // ==========================================================================
  const bermTop = 0; // berms rise from ground y=0
  function berm(w, h, d, x, z) {
    addRender(w, h, d, x, bermTop + h / 2, z, PALETTE.berm);
    addCollider(w, h, d, x, bermTop + h / 2, z);
  }
  berm(HALF_X * 2 + WALL_T * 2, WALL_H, WALL_T, 0, MAXZ + WALL_T / 2 + 1); // north (+Z)
  berm(HALF_X * 2 + WALL_T * 2, WALL_H, WALL_T, 0, MINZ - WALL_T / 2 - 1); // south (−Z)
  berm(WALL_T, WALL_H, HALF_Z * 2 + WALL_T * 2, MAXX + WALL_T / 2 + 1, (MINZ + MAXZ) / 2); // east
  berm(WALL_T, WALL_H, HALF_Z * 2 + WALL_T * 2, MINX - WALL_T / 2 - 1, (MINZ + MAXZ) / 2); // west

  // (M6 stair carve is applied above by carveShoots() — see shootsCarve.js. It
  //  replaced `carve.dropped` buried solid props with `carve.added` stepped tread
  //  slabs following the source stair runs. DEV log below; full per-prop record
  //  is in the M6 banner.)
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.info(`[shoots] M6 carve: replaced ${carve.dropped} buried props → ${carve.added} terraced slabs`);
  }

  // ==========================================================================
  // DECOR (re-dressed onto the real geometry). Signs + animated team-end lamps.
  // Ground-level y so they read from the yards. All visual-only.
  // ==========================================================================
  const signs = [];
  const addSign = (tex, w, hh, x, y, z, rotY) => {
    const m = makeSignMesh(tex, w, hh);
    m.position.set(x, y, z);
    if (rotY) m.rotation.y = rotY;
    m.updateMatrix();
    signs.push(m);
  };
  addSign(makeSignTexture('SHOOTS', '#e9d9a0', { w: 512, h: 160 }), 10, 3, 0, 3.4, MAXZ + WALL_T, Math.PI);
  addSign(makeSignTexture('SE // BLUE', '#4fe0c6'), 7, 1.2, 0, 2.6, MINZ - WALL_T + 0.1, 0);
  addSign(makeSignTexture('BUGS // RED', '#ff9a4d'), 7, 1.2, 0, 2.6, MAXZ + WALL_T - 0.1, Math.PI);

  const lampTealMat = new THREE.MeshBasicMaterial({ color: LED_TEAL, toneMapped: false });
  const lampAmberMat = new THREE.MeshBasicMaterial({ color: LED_AMBER, toneMapped: false });
  const tealGeos = [], amberGeos = [];
  const lamp = (arr, x, z) => { const g = new THREE.BoxGeometry(1.4, 0.12, 0.12); g.translate(x, 3.0, z); arr.push(g); };
  for (let x = -18; x <= 18; x += 9) { lamp(tealGeos, x, MINZ - WALL_T + 0.2); lamp(amberGeos, x, MAXZ + WALL_T - 0.2); }

  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 70),
    new THREE.MeshBasicMaterial({ map: makeGradientTexture('#cbb98a', '#5f5236'), depthWrite: false, fog: false, toneMapped: false }),
  );
  backdrop.position.set(0, 18, MAXZ + 14);
  backdrop.matrixAutoUpdate = false;
  backdrop.updateMatrix();
  group.add(backdrop);

  // ==========================================================================
  // MERGE static geometry per bucket (I6). ≤ ~13 palette buckets + berm + lamps.
  // ==========================================================================
  for (const [color, geos] of buckets) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    const mat = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = PERF.shadows;
    mesh.receiveShadow = PERF.shadows;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
    if (geos.length > 1) for (let j = 0; j < geos.length; j++) geos[j].dispose();
  }

  // Motion-perception grid over the yards.
  const grid = new THREE.GridHelper(HALF_X * 2, Math.round(HALF_X), 0xb7a97a, 0x6e6244);
  grid.position.set(0, (isFinite(floorTopMin) ? floorTopMin : 0) + 0.02, (MINZ + MAXZ) / 2);
  grid.scale.z = HALF_Z / HALF_X;
  grid.material.transparent = true;
  grid.material.opacity = 0.18;
  grid.matrixAutoUpdate = false;
  grid.updateMatrix();
  group.add(grid);

  const lampMeshes = [];
  if (tealGeos.length) {
    const mesh = new THREE.Mesh(mergeGeometries(tealGeos, false), lampTealMat);
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    for (const g of tealGeos) g.dispose();
    group.add(mesh); lampMeshes.push(mesh);
  }
  if (amberGeos.length) {
    const mesh = new THREE.Mesh(mergeGeometries(amberGeos, false), lampAmberMat);
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    for (const g of amberGeos) g.dispose();
    group.add(mesh); lampMeshes.push(mesh);
  }
  for (let i = 0; i < signs.length; i++) group.add(signs[i]);

  // Lighting: 1 hemi + 1 shadow sun (I3). Bright outdoor readable; frustum covers
  // the whole region.
  const hemi = new THREE.HemisphereLight(0xfff2d6, 0x6a5f42, 2.1);
  group.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0cf, 3.0);
  sun.position.set(28, 40, -20);
  if (PERF.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -HALF_X - 2;
    sun.shadow.camera.right = HALF_X + 2;
    sun.shadow.camera.top = HALF_Z + 2;
    sun.shadow.camera.bottom = -HALF_Z - 2;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 140;
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.05;
  }
  group.add(sun);

  // ==========================================================================
  // SPAWNS — in the model's own end yards (open ground at the ±Z extremes). SE
  // in the SOUTH yard (facing +Z toward center), Bug in the NORTH yard (facing
  // −Z), placed as exact (−x,−z) twins so route timings mirror. 4 per team.
  // ==========================================================================
  // Spawns sit on REAL reachable ground nodes in the south (SE) / north (Bug)
  // open bands (verified against the nav graph: floored + clear at own y). SE
  // faces +Z (toward center), Bug the (−x,−z) twin faces −Z. Feet y = the node's
  // floor top so the floor-support check passes at the spawn's own y (K9/D5).
  const YAW_N = Math.PI, YAW_S = 0;
  const SE_SPAWN_DEFS = [
    { x: -10, y: 0.26, z: -20.5 },
    { x: -2.5, y: 0.26, z: -20.5 },
    { x: 5, y: 0.20, z: -23 },
    { x: 10, y: 0.20, z: -23 },
  ];
  const seSpawns = [];
  const bugSpawns = [];
  for (let i = 0; i < SE_SPAWN_DEFS.length; i++) {
    const s = SE_SPAWN_DEFS[i];
    seSpawns.push({ pos: new THREE.Vector3(s.x, s.y, s.z), yaw: YAW_N });
    bugSpawns.push({ pos: new THREE.Vector3(-s.x, s.y, -s.z), yaw: YAW_S }); // 180° twin
  }

  const waypointNodes = buildWaypoints();

  const background = new THREE.Color(0x8f7f56);
  const fog = new THREE.Fog(0x8f7f56, 48, 180); // clears the long field sightlines

  let _phase = 0;
  const _tealBase = new THREE.Color(LED_TEAL);
  const _amberBase = new THREE.Color(LED_AMBER);
  function update(dt) {
    _phase += dt;
    const tealK = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(_phase * 2.0));
    const amberK = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(_phase * 1.7 + 1.3));
    lampTealMat.color.copy(_tealBase).multiplyScalar(tealK);
    lampAmberMat.color.copy(_amberBase).multiplyScalar(amberK);
  }

  const built = {
    group,
    colliders,
    spawnPoint: seSpawns[0].pos.clone(),
    name: 'shoots',
    seSpawns,
    bugSpawns,
    waypointNodes,
    background,
    fog,
    update,
  };

  // DEV self-check. Verbatim-model tight spots are EXPECTED — the shared check
  // hard-warns on graph/spawn problems that are ours to fix; genuine model
  // seams are noise here (documented). Runs only under DEV (tree-shaken in prod).
  if (import.meta.env.DEV) runMapSelfCheck(built);

  return built;
}

// ---------------------------------------------------------------------------
// WAYPOINT GRAPH — auto-FITTED onto the REAL translated geometry (shootsNav.json,
// generated by scripts/verify-shoots.mjs from the SAME shootsGeometry.json). A
// straight hand-authored graph cannot connect this map: verbatim ar_shoots is a
// dense wall-maze, so the graph is a fine walkable lattice (2.5 m grid), kept to
// the single connected component reachable from center, with links between
// neighbours a bot can actually WALK (surface-continuous, ≤0.42 m step-up,
// ≤0.6 m drop, headroom-clear). ~280 nodes — high, but the honest density for a
// maze; BFS/path() handle it (node counts are tiny in hot-path terms).
//
// REACHABILITY (post-M6 carve): the graph is now TWO-LAYER. After shootsCarve.js
// turns the buried solid deck props into stepped runs, the walkability BFS climbs
// them and emits elevated nodes on the decks/roofs (up to ~3.5 m) linked to the
// ground network by the carved ramps. 8 of the 10 real deck clusters are covered;
// the three 4.7 m² corner stubs (no rendered treads) stay solid by design — the
// graph has no nodes there because nothing walkable leads up.
//
// The nav links here are WALKABILITY edges (floor-path clear), which is what bots
// traverse. The shared mapChecks LOS test rides a 1 m eye-ray and legitimately
// clips the map's many ~1.4 m cover walls even where the floor path is clear — so
// on THIS map those LOS flags are demoted (documented); connectivity + slope +
// spawn checks remain authoritative and pass.
// ---------------------------------------------------------------------------
function buildWaypoints() {
  // NAV is [{x,y,z,links:[idx...]}] — already the exact runtime shape. Clone the
  // link arrays so the imported JSON module object is never mutated at runtime.
  return NAV.map((n) => ({ x: n.x, y: n.y, z: n.z, links: n.links.slice() }));
}
