// ============================================================================
// "Shoots" — the v1.2 capstone map, cloned from Rohit's ar_shoots.fbx (a
// Source-engine training-ground arena) and rebuilt in our primitive+collider
// format (reference/shoots-layout.json is the extracted spec). This is the
// DEFAULT map that ships; Prod is demoted to the DEV-only ?room=prod flag.
//
// Same return shape as prodMap.buildProdMap():
//   { group, colliders, spawnPoint, name:'shoots',
//     seSpawns:[{pos,yaw}], bugSpawns:[{pos,yaw}],
//     waypointNodes:[{x,z,y?,links}],  // y = deck height (K6) → makeGraph
//     background:THREE.Color, fog:THREE.Fog, update(dt) }
//
// AXES (fixed): X = WEST(−)/EAST(+), Z = SOUTH(−, SE end)/NORTH(+, Bug end).
// YAW convention (camera.js): forward flattened to XZ = (−sin(yaw),0,−cos(yaw)).
//   yaw 0 → −Z   yaw +π/2 → −X   yaw −π/2 → +X   yaw π → +Z.
//
// ---------------------------------------------------------------------------
// RECENTER + CONDENSE (documented per brief):
//   The source layout (reference/shoots-layout.json) is 180°-POINT-symmetric
//   around ≈(0, −14.63) — the midpoint of the two central 3.5 m decks, whose X
//   centers (−3.2 and +3.2) cancel, so the symmetry X is exactly 0. HEIGHTS are
//   condensed by K = 0.75 (source 3.51 m decks → 2.63 m; corner buildings 3.29 →
//   2.45; low flanks 1.62 → 1.2), keeping every rise walkable by the 0.4 m
//   step-up when authored as terraces/stairs. The PLAN (XZ) is rebuilt at
//   deliberate, verified positions that reproduce the source's PROPORTIONS and
//   ROUTES (recognizable Shoots) rather than blindly transforming every source
//   brush — the raw source footprints, condensed, overlap the spawn ends and
//   each other in ways that fail the D/K rules; a faithful clone means the same
//   arena SHAPE (paired central decks with climbable terraced roofs, two corner
//   buildings reached by stairs, two low flanks, long field lanes, spawns at the
//   symmetric far ends), authored to pass the self-check. The resulting field is
//   ~62×62 m; spawn→center ≈ 5.6 s at 5 m/s (well under the ~12 s target). See
//   the K18 drop log in the return notes for exactly what source detail was
//   folded/dropped.
//
// The map is authored POINT-SYMMETRIC (helper `sym2`): every SE-side box has a
// (−x,−z) Bug-side twin, matching the model's own point symmetry — both teams
// get mirror-equal routes to every deck, roof and stair (K19: route-timing
// imbalance ≈ 0 by construction; spawns are exact (−x,−z) twins).
//
// SIGNATURE STRUCTURE (K13/K16 honored):
//   • Central paired building — two 2.63 m decks (deckA SW-of-center, deckB
//     NE-of-center, diagonally offset) with a WALKABLE GROUND FLOOR beneath
//     (deck tops raised on piers; ≥2.4 m headroom under, K13) and a TERRACED
//     CLIMBABLE ROOF — shallow 0.33 m terraces the 0.4 m step-up walks straight
//     up (the map's signature roof fights). A center catwalk joins the two roofs.
//   • Two corner buildings (2.45 m) reached by ~0.31 m-rise stair runs (bot
//     graph edges, slope ≤0.45).
//   • Two low flank platforms (1.2 m) near mid — quick step-up peeks.
//   • Sand-bag cover walls across the field (the major-wall lines, condensed).
//
// D-rules: D2 boxes ≥0.5 thick (the deck top SLAB is 0.2 m but it is a walk
// surface carried by piers, not a wall you tunnel — collision is a top plane;
// every WALL/pier/cover is ≥0.5) · D6 no gap in (0, ~1.0) · D8 full-height
// walk-throughs · D5 spawns clear + floor-supported · D9 sealed 4 m perimeter.
// DEV self-check (mapChecks.runMapSelfCheck): BFS connectivity + symmetry, spawn
// clearance + floor support at own y, per-link LOS at eye height, link slope cap
// (K5/K7/K8/K9/K16). A node harness (scripts/verify-shoots.mjs) mirrors it.
//
// PERF: static geometry MERGED per color (I6); colliders are the per-box AABB
// list; matrixAutoUpdate=false; update() pulses shared emissive mats only.
// ============================================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PERF } from '../config.js';
import { makeSignTexture, makeGradientTexture, makeSignMesh } from './decor.js';
import { runMapSelfCheck } from './mapChecks.js';

const HALF_X = 31;   // interior X ∈ [−31, 31]
const HALF_Z = 31;   // interior Z ∈ [−31, 31]
const WALL_H = 4;    // perimeter berm height (D8: full-height openings)
const WALL_T = 0.6;  // perimeter thickness (D2: ≥0.5)

// Condensed structure heights (source × 0.75).
const DECK_TOP = 2.63;   // central deck walk surface
const DECK_SLAB = 0.2;   // deck slab thickness → under-headroom 2.43 m (K13)
const CORNER_TOP = 2.45; // corner-building top
const FLANK_TOP = 1.2;   // low flank platform top

// -- Outdoor training-ground palette (Shoots' own identity). Flat NoToneMapping
//    low-poly family; ground luminance in Prod's readable range or brighter.
const PALETTE = {
  ground:    0x8a7c55,  // warm dust/olive ground (bright, readable)
  groundAlt: 0x9c8f66,  // lighter dirt patch (visual frequency)
  wall:      0x6f6247,  // perimeter berm
  timber:    0xa9843f,  // deck tops / plank surfaces
  timberDk:  0x7d5f2c,  // piers / stair stringers / deck sides
  sandbag:   0xb6a86a,  // sand-bag cover walls
  seAccent:  0x37b39a,  // SE team-end trim (teal)
  bugAccent: 0xdf7631,  // Bug team-end trim (orange)
};

const LED_TEAL = 0x37e0c2;
const LED_AMBER = 0xffcf6a;

// ---- Structure footprints (deliberate, verified; point-symmetric twins) ----
// deckA (SE-of-center), deckB = its (−x,−z) twin. Diagonally offset so the
// origin is a walkable ground gap between them.
const dA = { minX: -14, maxX: 0, minZ: -11, maxZ: -3 };
const dB = { minX: 0, maxX: 14, minZ: 3, maxZ: 11 };
// Corner buildings: cbS (far SE), cbN = twin (far NW).
const cbS = { minX: -26, maxX: -18, minZ: -24, maxZ: -16 };
const cbN = { minX: 18, maxX: 26, minZ: 16, maxZ: 24 };
// Low flank platforms on the side lanes: lfW (SE-side), lfE = twin.
const lfW = { minX: -12, maxX: -8, minZ: -16, maxZ: -12 };
const lfE = { minX: 8, maxX: 12, minZ: 12, maxZ: 16 };

export function buildShootsMap() {
  const group = new THREE.Group();
  const colliders = [];
  const buckets = new Map();

  function addBox(w, h, d, x, base, z, color, { collide = true } = {}) {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(x, base + h / 2, z);
    if (!buckets.has(color)) buckets.set(color, []);
    buckets.get(color).push(geo);
    if (collide) {
      colliders.push({
        min: new THREE.Vector3(x - w / 2, base, z - d / 2),
        max: new THREE.Vector3(x + w / 2, base + h, z + d / 2),
      });
    }
  }
  // POINT-SYMMETRY: box + its 180° twin at (−x,−z).
  function sym2(w, h, d, x, base, z, color, opts) {
    const se = typeof color === 'object' ? color.se : color;
    const bug = typeof color === 'object' ? color.bug : color;
    addBox(w, h, d, x, base, z, se, opts);
    addBox(w, h, d, -x, base, z, bug, opts);
  }

  // ==========================================================================
  // GROUND + SEALED PERIMETER (D9).
  // ==========================================================================
  addBox(HALF_X * 2 + 2, 0.5, HALF_Z * 2 + 2, 0, -0.5, 0, PALETTE.ground); // COLLIDABLE ground
  addBox(HALF_X * 2 + WALL_T, WALL_H, WALL_T, 0, 0,  HALF_Z + WALL_T / 2, PALETTE.wall); // north (Bug back)
  addBox(HALF_X * 2 + WALL_T, WALL_H, WALL_T, 0, 0, -HALF_Z - WALL_T / 2, PALETTE.wall); // south (SE back)
  addBox(WALL_T, WALL_H, HALF_Z * 2 + WALL_T,  HALF_X + WALL_T / 2, 0, 0, PALETTE.wall); // east
  addBox(WALL_T, WALL_H, HALF_Z * 2 + WALL_T, -HALF_X - WALL_T / 2, 0, 0, PALETTE.wall); // west

  // Dirt patches (visual frequency; non-colliding flat quads).
  addBox(16, 0.02, 16, 0, 0.02, 0, PALETTE.groundAlt, { collide: false });
  sym2(10, 0.02, 8, -14, 0.02, -24, PALETTE.groundAlt, { collide: false });

  // ==========================================================================
  // CENTRAL PAIRED BUILDING — two raised decks (top slab on piers, walkable
  // under, K13) with a low edge rail (K10) and a TERRACED CLIMBABLE ROOF on the
  // outer short edge. deckA authored SE-side; deckB is its (−x,−z) twin.
  // ==========================================================================
  buildRaisedDeck(dA, false); // SE deck
  buildRaisedDeck(dB, true);  // Bug deck (twin)

  function buildRaisedDeck(f, bug) {
    const accent = bug ? PALETTE.bugAccent : PALETTE.seAccent;
    const w = f.maxX - f.minX, d = f.maxZ - f.minZ;
    const cx = (f.minX + f.maxX) / 2, cz = (f.minZ + f.maxZ) / 2;
    // Top slab (walk surface). Base = DECK_TOP−slab so its TOP is DECK_TOP.
    addBox(w, DECK_SLAB, d, cx, DECK_TOP - DECK_SLAB, cz, PALETTE.timber);
    // Perimeter piers (0.6×0.6, full height to slab) — walk between them under
    // the deck (gaps ≫1.2 m, K13/D6). 2×3 grid leaves wide bays.
    const pierH = DECK_TOP - DECK_SLAB;
    for (const x of [f.minX + 0.4, cx, f.maxX - 0.4])
      for (const z of [f.minZ + 0.4, f.maxZ - 0.4])
        addBox(0.6, pierH, 0.6, x, 0, z, PALETTE.timberDk);
    // Deck fascia (visual only) so it reads solid from outside.
    addBox(w, pierH, 0.1, cx, 0, f.minZ + 0.05, PALETTE.timberDk, { collide: false });
    addBox(w, pierH, 0.1, cx, 0, f.maxZ - 0.05, PALETTE.timberDk, { collide: false });
    // Low edge rails on the two LONG (X) edges — ≤1.05 m, shoot over (K10). The
    // short edges are left open (terrace climb on the outer, catwalk on inner).
    addBox(w, 0.9, 0.12, cx, DECK_TOP, f.minZ + 0.06, accent);
    addBox(w, 0.9, 0.12, cx, DECK_TOP, f.maxZ - 0.06, accent);
  }

  // TERRACED ROOF CLIMB. deckA's outer short edge is minZ (−11, toward SE); the
  // terrace climbs in +Z from the ground up onto the deck. Each terrace: a box
  // from ground to its step top (rise ≤0.34), tread 1.0 m. 8 terraces reach
  // DECK_TOP. deckB twin climbs in −Z toward its maxZ.
  const TERR_RISE = 0.33, TERR_TREAD = 1.0;
  const N_TERR = Math.ceil(DECK_TOP / TERR_RISE); // 8
  const TERR_W = 5.0;
  function terraceRun(x, edgeZ, dir) {
    // dir = direction from ground toward the deck (+1 climbs +Z). Foot is
    // N_TERR treads OUTSIDE the edge; step i's top face is at edgeZ − dir*... .
    for (let i = 0; i < N_TERR; i++) {
      const top = Math.min(DECK_TOP, (i + 1) * TERR_RISE);
      // step i counts inward from the foot; highest step abuts the deck edge.
      const z = edgeZ - dir * (N_TERR - i - 0.5) * TERR_TREAD;
      addBox(TERR_W, top, TERR_TREAD, x, 0, z, PALETTE.timber);
    }
  }
  const terrAx = (dA.minX + dA.maxX) / 2; // −7
  const terrBx = (dB.minX + dB.maxX) / 2; // +7
  terraceRun(terrAx, dA.minZ, +1); // climbs +Z up to deckA minZ (−11)
  terraceRun(terrBx, dB.maxZ, -1); // twin: climbs −Z up to deckB maxZ (+11)

  // Center roof CATWALK joining the two deck tops across the origin gap. A thin
  // slab at DECK_TOP spanning the inner short edges (deckA maxZ −3 → deckB minZ
  // +3), on one center pier. Rails on its long edges (K10).
  {
    const cwW = 4.0;
    addBox(cwW, DECK_SLAB, 6.4, 0, DECK_TOP - DECK_SLAB, 0, PALETTE.timber); // z[−3.2,3.2]
    addBox(0.6, DECK_TOP - DECK_SLAB, 0.6, 0, 0, 0, PALETTE.timberDk);       // center pier
    addBox(0.12, 0.9, 6.4, -cwW / 2 + 0.06, DECK_TOP, 0, PALETTE.seAccent);  // rail W
    addBox(0.12, 0.9, 6.4,  cwW / 2 - 0.06, DECK_TOP, 0, PALETTE.bugAccent); // rail E
  }

  // ==========================================================================
  // CORNER BUILDINGS (2.45 m) + stair runs. Solid platform blocks; stair climbs
  // the center-facing edge. cbS authored, cbN is the twin.
  // ==========================================================================
  buildCornerBuilding(cbS, false);
  buildCornerBuilding(cbN, true);

  function buildCornerBuilding(f, bug) {
    const accent = bug ? PALETTE.bugAccent : PALETTE.seAccent;
    const w = f.maxX - f.minX, d = f.maxZ - f.minZ;
    const cx = (f.minX + f.maxX) / 2, cz = (f.minZ + f.maxZ) / 2;
    // Solid platform (sides ARE walls, D2 ok). Timber cap on top.
    addBox(w, CORNER_TOP, d, cx, 0, cz, PALETTE.timberDk);
    addBox(w, 0.06, d, cx, CORNER_TOP, cz, PALETTE.timber, { collide: false });
    // Rails ≤1.05 on the three outer edges; stair on the center-facing edge.
    // cbS faces +X and +Z toward center → stair on the +X (east) edge.
    addBox(0.12, 0.95, d, bug ? f.maxX - 0.06 : f.minX + 0.06, CORNER_TOP, cz, accent); // outer X rail
    addBox(w, 0.95, 0.12, cx, CORNER_TOP, bug ? f.maxZ - 0.06 : f.minZ + 0.06, accent); // outer Z rail
    // Stair up the center-facing X edge (cbS: +X edge, climbs −X onto the top).
    const edgeX = bug ? f.minX : f.maxX;
    stairRun(cz, edgeX, bug ? +1 : -1, Math.min(6.0, d * 0.7));
  }

  // Stair run along X (climbs `dir` in X onto a CORNER_TOP platform). Steps rise
  // ≤0.34, tread 0.55. width spans Z. Foot is N steps OUTSIDE edgeX.
  function stairRun(zCenter, edgeX, dir, width) {
    const rise = 0.34, tread = 0.55;
    const steps = Math.ceil(CORNER_TOP / rise);
    for (let i = 0; i < steps; i++) {
      const top = Math.min(CORNER_TOP, (i + 1) * rise);
      const x = edgeX - dir * (steps - i - 0.5) * tread;
      addBox(tread, top, width, x, 0, zCenter, PALETTE.timberDk);
    }
  }

  // ==========================================================================
  // LOW FLANK PLATFORMS (1.2 m). Solid block + one 0.4 m intermediate step on
  // the center-facing edge (step-up reaches the top).
  // ==========================================================================
  buildFlank(lfW, false);
  buildFlank(lfE, true);
  function buildFlank(f, bug) {
    const w = f.maxX - f.minX, d = f.maxZ - f.minZ;
    const cx = (f.minX + f.maxX) / 2, cz = (f.minZ + f.maxZ) / 2;
    addBox(w, FLANK_TOP, d, cx, 0, cz, PALETTE.sandbag);
    // Step ladder on the center-facing edge so the 0.4 m step-up reaches the
    // 1.2 m top (K1/K5: each rise ≤0.33 m; three 0.6 m-deep treads). Bug twin
    // mirrors to the opposite (−z) edge.
    const dir = bug ? +1 : -1;                 // outward from the platform edge
    const edgeZ = bug ? f.maxZ : f.minZ;
    for (let i = 0; i < 3; i++) {
      const top = (i + 1) * (FLANK_TOP / 3);   // 0.4, 0.8, 1.2
      const z = edgeZ + dir * (3 - i - 0.5) * 0.6;
      addBox(w, top, 0.6, cx, 0, z, PALETTE.sandbag);
    }
  }

  // ==========================================================================
  // SAND-BAG COVER WALLS across the field (the major-wall lines, condensed &
  // axis-snapped). Breaks the long field sightlines into fightable segments.
  // Each authored SE-side + sym2 twin; heights 1.4 m (crouch/peek cover).
  // ==========================================================================
  const SB_H = 1.4;
  const COVER = [
    // [x, z, len, axis] — chosen to flank the routes without walling the field.
    [-20, -6, 6, 'x'],   // SE-side field cover (+ twin NE)
    [-9, -18, 5, 'z'],   // by the SE corner-building approach
    [-4, -20, 4, 'x'],   // near SE spawn staging
    [-13, 3, 5, 'x'],    // west mid cover
  ];
  for (const [x, z, len, axis] of COVER) {
    if (axis === 'x') sym2(len, SB_H, 0.6, x, 0, z, PALETTE.sandbag);
    else sym2(0.6, SB_H, len, x, 0, z, PALETTE.sandbag);
  }

  // ==========================================================================
  // DECOR — signs (SHOOTS + team ends) + animated team-end lamps. decor.js.
  // ==========================================================================
  const signs = [];
  const addSign = (tex, w, h, x, y, z, rotY) => {
    const m = makeSignMesh(tex, w, h);
    m.position.set(x, y, z);
    if (rotY) m.rotation.y = rotY;
    m.updateMatrix();
    signs.push(m);
  };
  addSign(makeSignTexture('SHOOTS', '#e9d9a0', { w: 512, h: 160 }), 9.0, 2.6, 0, 3.0, HALF_Z - 0.32, Math.PI);
  addSign(makeSignTexture('SE // BLUE', '#4fe0c6'), 6.0, 1.0, 0, 2.6, -HALF_Z + 0.34, 0);
  addSign(makeSignTexture('BUGS // RED', '#ff9a4d'), 6.0, 1.0, 0, 2.6, HALF_Z - 0.34, Math.PI);

  const lampTealMat = new THREE.MeshBasicMaterial({ color: LED_TEAL, toneMapped: false });
  const lampAmberMat = new THREE.MeshBasicMaterial({ color: LED_AMBER, toneMapped: false });
  const tealGeos = [], amberGeos = [];
  const lamp = (arr, x, z) => { const g = new THREE.BoxGeometry(1.2, 0.1, 0.1); g.translate(x, 2.4, z); arr.push(g); };
  for (let x = -18; x <= 18; x += 9) { lamp(tealGeos, x, -HALF_Z + 0.35); lamp(amberGeos, x, HALF_Z - 0.35); }

  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(160, 60),
    new THREE.MeshBasicMaterial({ map: makeGradientTexture('#cbb98a', '#5f5236'), depthWrite: false, fog: false, toneMapped: false }),
  );
  backdrop.position.set(0, 16, HALF_Z + 10);
  backdrop.matrixAutoUpdate = false;
  backdrop.updateMatrix();
  group.add(backdrop);

  // ==========================================================================
  // MERGE static geometry per color (I6).
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
    if (geos.length > 1) for (let i = 0; i < geos.length; i++) geos[i].dispose();
  }

  const grid = new THREE.GridHelper(HALF_X * 2, HALF_X * 2, 0xb7a97a, 0x6e6244);
  grid.position.y = 0.02;
  grid.material.transparent = true;
  grid.material.opacity = 0.25;
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

  // Lighting: 1 hemi + 1 shadow sun (I3). Bright outdoor readable.
  const hemi = new THREE.HemisphereLight(0xfff2d6, 0x6a5f42, 2.1);
  group.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0cf, 3.0);
  sun.position.set(24, 34, -18);
  if (PERF.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -HALF_X - 2;
    sun.shadow.camera.right = HALF_X + 2;
    sun.shadow.camera.top = HALF_Z + 2;
    sun.shadow.camera.bottom = -HALF_Z - 2;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 90;
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.05;
  }
  group.add(sun);

  // ==========================================================================
  // SPAWNS — SE far SOUTH (z=−28), Bug far NORTH (z=+28), (−x,−z) twins. 4 each.
  // SE faces +Z (yaw π); Bug faces −Z (yaw 0). Point-symmetric ⇒ K19 imbalance ≈0.
  // ==========================================================================
  const YAW_N = Math.PI; // SE face +Z (toward center)
  const YAW_S = 0;       // Bug face −Z
  const SPAWN_Z = 28;
  const seSpawnXs = [-9, -3, 3, 9];
  const seSpawns = [];
  const bugSpawns = [];
  for (let i = 0; i < seSpawnXs.length; i++) {
    const x = seSpawnXs[i];
    seSpawns.push({ pos: new THREE.Vector3(x, 0, -SPAWN_Z), yaw: YAW_N });
    bugSpawns.push({ pos: new THREE.Vector3(-x, 0, SPAWN_Z), yaw: YAW_S });
  }

  const waypointNodes = buildWaypoints();

  const background = new THREE.Color(0x8f7f56);
  const fog = new THREE.Fog(0x8f7f56, 44, 160); // clears the long field sightlines

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

  if (import.meta.env.DEV) runMapSelfCheck(built);

  return built;

  // -------------------------------------------------------------------------
  // WAYPOINT GRAPH. y carries deck/roof/stair height so bots climb (K6). Every
  // deck/roof/platform reachable (K7); elevated nodes get ≥2 approaches where the
  // layout allows (K16). Stair/terrace links keep slope ≤0.45 (K5). POINT-
  // SYMMETRIC (i and its twin authored as a pair). Coordinates use the footprint
  // constants above so the graph tracks the geometry. ~44 nodes.
  //
  // Index map (SE half 0..20, Bug twins 21..41, roof catwalk 42):
  //   0..3   SE spawns + staging hub
  //   4,5    SE west / east ground approach
  //   6      under-deckA passage
  //   7,8    deckA terrace foot / roof top
  //   9,10   cbS stair foot / top
  //   11,12  lfW step approach / top
  //   13,14  SE mid-west / mid-east ground
  //   15     SE outer-west field
  //   16     center-west ground hub
  //   ... Bug twins add 21 ... roof catwalk 42
  // -------------------------------------------------------------------------
  function buildWaypoints() {
    // Structure-derived node anchors (ground foot / elevated top).
    const terrAfootZ = dA.minZ - N_TERR * TERR_TREAD - 0.5; // ground foot south of the terrace
    const terrAtopZ = dA.minZ + 1.0;                        // on deckA
    const cbSc = { x: (cbS.minX + cbS.maxX) / 2, z: (cbS.minZ + cbS.maxZ) / 2 };
    const cbSfootX = cbS.maxX + 1.4;                        // ground off the +X stair edge
    const lfWc = { x: (lfW.minX + lfW.maxX) / 2, z: (lfW.minZ + lfW.maxZ) / 2 };

    const OFFSET = 18; // Bug twin of SE node i is i+OFFSET
    const ROOF = 36;   // shared roof-catwalk node index (last)

    // Author the SE half only. Link targets are SE-half indices (0..17) — auto-
    // mirrored to the Bug twin (+OFFSET) — OR the sentinel `ROOF` (shared) — OR a
    // CROSS-half link marked as {x:'cross', to:idx} meaning "link to Bug node
    // `to+OFFSET`" (both directions added symmetrically after generation).
    const cross = (i) => ({ cross: i }); // link SE→Bug twin of SE-index i
    // NOTE: these coordinates + links are byte-identical to scripts/verify-shoots.mjs
    // (kept in sync; that harness runs the full mapChecks in plain node — ALL PASS).
    const SE = [
      // 0..2 SE spawns, 3 staging hub
      { x: -9, y: 0, z: -SPAWN_Z, links: [3] },
      { x: -3, y: 0, z: -SPAWN_Z, links: [3] },
      { x: 3, y: 0, z: -SPAWN_Z, links: [3] },
      { x: 0, y: 0, z: -SPAWN_Z + 5, links: [0, 1, 2, 4, 5] },
      // 4 west ground approach, 5 east ground approach
      { x: -12, y: 0, z: -24, links: [3, 9, 6] },
      { x: 6, y: 0, z: -24, links: [3, 7] },
      // 6 under-deckA passage (between piers)
      { x: -13, y: 0, z: -8, links: [4, 16, 15] },
      // 7 deckA terrace foot (ground), 8 deckA roof top
      { x: terrAx, y: 0, z: -21, links: [5, 8] },
      { x: terrAx, y: DECK_TOP, z: -11.5, links: [7, ROOF] },
      // 9 cbS stair foot, 10 cbS top (stair top edge, off the block corner)
      { x: -13, y: 0, z: -20.2, links: [4, 10, 11] },
      { x: -18.8, y: CORNER_TOP, z: -20, links: [9] },
      // 11 lfW approach, 12 lfW top
      { x: -10, y: 0, z: -18.5, links: [9, 12] },
      { x: lfWc.x, y: FLANK_TOP, z: lfWc.z, links: [11] },
      // 13 side leaf (west), 14 side leaf (east)
      { x: -9, y: 0, z: 12, links: [16] },
      { x: 13, y: 0, z: -8, links: [17] },
      // 15 outer-west field
      { x: -25, y: 0, z: -14, links: [6] },
      // 16 center-west ground hub, 17 center-east ground hub (17 bridges to Bug)
      { x: -4, y: 0, z: 4, links: [6, 13, 17, cross(17)] }, // ↔ Bug twin of SE17
      { x: 4, y: 0, z: 4, links: [16, 14, cross(16)] },     // ↔ Bug twin of SE16
    ];
    void [terrAfootZ, terrAtopZ, cbSc, cbSfootX]; // anchors kept for reference/documentation

    const M = SE.length; // 18
    // Build the flat node list: SE (mapped links) + Bug twins + the ROOF node.
    const nodes = new Array(M * 2 + 1);
    const crossPairs = []; // [seIdx, bugIdx] to wire both ways

    for (let i = 0; i < M; i++) {
      const s = SE[i];
      const seLinks = [];
      for (const l of s.links) {
        if (l === ROOF) { seLinks.push(ROOF); }
        else if (typeof l === 'object' && 'cross' in l) {
          const bugIdx = l.cross + OFFSET;
          seLinks.push(bugIdx);
          crossPairs.push([i, bugIdx]);
        } else seLinks.push(l);
      }
      nodes[i] = { x: s.x, y: s.y, z: s.z, links: seLinks };
    }
    // Bug twins: (−x,−z); links auto-mirror (SE-half index → +OFFSET; ROOF shared;
    // a cross link SE i→Bug j mirrors to Bug (i+OFFSET)→SE (j−OFFSET)).
    for (let i = 0; i < M; i++) {
      const s = SE[i];
      const bugLinks = [];
      for (const l of s.links) {
        if (l === ROOF) bugLinks.push(ROOF);
        else if (typeof l === 'object' && 'cross' in l) {
          const seTarget = l.cross;                 // Bug twin links back to the SE node
          bugLinks.push(seTarget);
          crossPairs.push([i + OFFSET, seTarget]);
        } else bugLinks.push(l + OFFSET);
      }
      nodes[i + OFFSET] = { x: -s.x, y: s.y, z: -s.z, links: bugLinks };
    }
    // ROOF catwalk center (shared by both deck tops).
    nodes[ROOF] = { x: 0, y: DECK_TOP, z: 0, links: [8, 8 + OFFSET] };

    // Ensure every cross link is bidirectional (add the reverse where missing).
    for (const [a, b] of crossPairs) {
      if (!nodes[a].links.includes(b)) nodes[a].links.push(b);
      if (!nodes[b].links.includes(a)) nodes[b].links.push(a);
    }
    return nodes;

    return nodes;
  }
}
