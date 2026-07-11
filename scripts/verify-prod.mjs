// Standalone verification harness for prodMap — replicates the collider + graph
// authoring math WITHOUT the three/addons import or import.meta.env (which need
// Vite). Mirrors buildProdMap's addBox/addSym collider construction and the
// buildWaypoints() literal, then runs the SAME three self-checks the DEV path
// runs in the browser. Any divergence here means a bad edit before it ships.
// Run: node scripts/verify-prod.mjs

// ---- geometry constants (keep in sync with prodMap.js) ----
const HALF_X = 20, HALF_Z = 14, WALL_H = 4, WALL_T = 0.6, RACK_H = 2.2;
const INNER_X = 13, A_DIV_Z = -7.0, B_DIV_Z = 11.0;
const DOOR_N = [-12.8, -11.2], DOOR_C = [-1.5, 1.5], DOOR_S = [11.2, 13.2];
const CONN_SE = [-9.0, -5.0], CONN_BUG = [5.0, 9.0];

const colliders = [];
function addBox(w, h, d, x, base, z, collide = true) {
  if (collide) {
    colliders.push({
      min: { x: x - w / 2, y: base, z: z - d / 2 },
      max: { x: x + w / 2, y: base + h, z: z + d / 2 },
    });
  }
}
function addSym(w, h, d, x, base, z, collide = true) {
  addBox(w, h, d, x, base, z, collide);
  addBox(w, h, d, -x, base, z, collide); // X-mirror (west↔east; z unchanged)
}

// ---- replicate buildProdMap's collider set (render-only boxes pass collide=false) ----
// floor (no collide)
addBox(HALF_X * 2 + 2, 0.5, HALF_Z * 2 + 2, 0, -0.5, 0, false);
// perimeter
addBox(HALF_X * 2 + WALL_T, WALL_H, WALL_T, 0, 0, -HALF_Z - WALL_T / 2);
addBox(HALF_X * 2 + WALL_T, WALL_H, WALL_T, 0, 0, HALF_Z + WALL_T / 2);
addBox(WALL_T, WALL_H, HALF_Z * 2 + WALL_T, -HALF_X - WALL_T / 2, 0, 0);
addBox(WALL_T, WALL_H, HALF_Z * 2 + WALL_T, HALF_X + WALL_T / 2, 0, 0);
// far-wall trim strips (no collide)
addBox(HALF_X * 2, 0.3, 0.12, 0, 2.6, -HALF_Z + 0.12, false);
addBox(HALF_X * 2, 0.3, 0.12, 0, 2.6, HALF_Z - 0.12, false);
// spawn-room inner walls (SE at -INNER_X; addSym X-mirrors to Bug)
const innerSeg = (z0, z1) => addSym(WALL_T, WALL_H, z1 - z0, -INNER_X, 0, (z0 + z1) / 2);
innerSeg(-HALF_Z, DOOR_N[0]);
innerSeg(DOOR_N[1], DOOR_C[0]);
innerSeg(DOOR_C[1], DOOR_S[0]);
innerSeg(DOOR_S[1], HALF_Z);
// spawn-room nub
addSym(0.6, WALL_H, 3.0, -18.4, 0, 11.0);
// mid racks
addBox(0.6, RACK_H, 3.6, -2.5, 0, -3.2);
addBox(0.6, RACK_H, 3.6, 2.5, 0, 3.2);
// mid crates
addSym(1.0, 1.0, 1.0, -4.6, 0, -3.4);
addSym(1.0, 0.5, 1.0, 4.6, 0, 3.4);
// A-lane divider (3 segments leaving CONN_SE + CONN_BUG) + cover + crate
const aSeg = (x0, x1) => addBox(x1 - x0, WALL_H, WALL_T, (x0 + x1) / 2, 0, A_DIV_Z);
aSeg(-INNER_X, CONN_SE[0]); aSeg(CONN_SE[1], CONN_BUG[0]); aSeg(CONN_BUG[1], INNER_X);
addSym(2.2, RACK_H, 0.6, -4.3, 0, -10.2);
addSym(1.0, 1.0, 1.0, -12.4, 0, -13.0);
// A-lane accent strip (no collide)
addBox(9.4, 0.25, 0.1, 0, 0.9, A_DIV_Z - WALL_T / 2 - 0.06, false);
// B-corridor inner wall (3 segments) + OFFSET dogleg
const bInnerFace = B_DIV_Z + WALL_T / 2;
const bPerimFace = HALF_Z;
const bSeg = (x0, x1) => addBox(x1 - x0, WALL_H, WALL_T, (x0 + x1) / 2, 0, B_DIV_Z);
bSeg(-INNER_X, CONN_SE[0]); bSeg(CONN_SE[1], CONN_BUG[0]); bSeg(CONN_BUG[1], INNER_X);
const WEST_STUB_S = 12.8, EAST_STUB_N = 12.5;
addBox(0.6, WALL_H, WEST_STUB_S - bInnerFace, -2.2, 0, (bInnerFace + WEST_STUB_S) / 2);
addBox(0.6, WALL_H, bPerimFace - EAST_STUB_N, 2.2, 0, (EAST_STUB_N + bPerimFace) / 2);
// B accent strip (no collide)
addBox(9.4, 0.25, 0.1, 0, 0.9, bInnerFace + 0.06, false);

// ---- waypoints (keep in sync with buildWaypoints) ----
const nodes = [
  { x: -17.0, z: -9.5, links: [3, 4] },              // 0
  { x: -18.5, z: -2.0, links: [3, 5] },              // 1
  { x: -17.5, z: 9.0, links: [3, 6] },               // 2
  { x: -15.5, z: -4.5, links: [0, 1, 2] },           // 3
  { x: -12.2, z: -12.0, links: [0, 7] },             // 4
  { x: -12.0, z: 0.0, links: [1, 12] },              // 5
  { x: -12.2, z: 12.4, links: [2, 17] },             // 6
  { x: -11.0, z: -11.5, links: [4, 8] },             // 7
  { x: -7.0, z: -11.5, links: [7, 9, 29] },          // 8
  { x: 0.0, z: -11.5, links: [8, 10] },              // 9
  { x: 7.0, z: -11.5, links: [9, 11, 30] },          // 10
  { x: 11.0, z: -11.5, links: [10, 22] },            // 11
  { x: -4.5, z: 0.0, links: [5, 13, 29, 31] },       // 12
  { x: 0.0, z: 0.0, links: [12, 14, 15, 16] },       // 13
  { x: 4.5, z: 0.0, links: [13, 23, 30, 32] },       // 14
  { x: 0.0, z: -6.5, links: [13] },                  // 15
  { x: 0.0, z: 6.5, links: [13] },                   // 16
  { x: -11.0, z: 12.6, links: [6, 18] },             // 17
  { x: -7.0, z: 12.6, links: [17, 19, 31] },         // 18
  { x: -1.2, z: 13.3, links: [18, 33] },             // 19
  { x: 7.0, z: 12.6, links: [33, 21, 32] },          // 20
  { x: 11.0, z: 12.6, links: [20, 24] },             // 21
  { x: 12.2, z: -12.0, links: [11, 25] },            // 22
  { x: 12.0, z: 0.0, links: [14, 26] },              // 23
  { x: 12.2, z: 12.4, links: [21, 27] },             // 24
  { x: 17.0, z: -9.5, links: [22, 28] },             // 25
  { x: 18.5, z: -2.0, links: [23, 28] },             // 26
  { x: 17.5, z: 9.0, links: [24, 28] },              // 27
  { x: 15.5, z: -4.5, links: [25, 26, 27] },         // 28
  { x: -7.0, z: -7.0, links: [8, 12] },              // 29
  { x: 7.0, z: -7.0, links: [10, 14] },              // 30
  { x: -7.0, z: 7.0, links: [18, 12] },              // 31
  { x: 7.0, z: 7.0, links: [20, 14] },               // 32
  { x: 1.2, z: 11.9, links: [19, 20] },              // 33
];

// ---- spawns ----
const YAW_EAST = -Math.PI / 2, YAW_WEST = Math.PI / 2;
const seSpawnDefs = [
  { x: -17.0, z: -9.5 }, { x: -18.5, z: -2.0 }, { x: -17.5, z: 6.0 }, { x: -15.5, z: -4.5 },
];
const seSpawns = seSpawnDefs.map((s) => ({ pos: { x: s.x, z: s.z }, yaw: YAW_EAST }));
const bugSpawns = seSpawnDefs.map((s) => ({ pos: { x: -s.x, z: s.z }, yaw: YAW_WEST }));

// ---- rayBlocked (slab method, XZ ray at fixed y) ----
function rayBox(ox, oy, oz, dx, dy, dz, min, max, maxDist) {
  const o = [ox, oy, oz], d = [dx, dy, dz];
  const mn = [min.x, min.y, min.z], mx = [max.x, max.y, max.z];
  let tmin = 0, tmax = maxDist;
  for (let i = 0; i < 3; i++) {
    if (d[i] === 0) { if (o[i] < mn[i] || o[i] > mx[i]) return -1; continue; }
    const inv = 1 / d[i];
    let t1 = (mn[i] - o[i]) * inv, t2 = (mx[i] - o[i]) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}
function rayBlocked(ox, oy, oz, dx, dy, dz, dist) {
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    const t = rayBox(ox, oy, oz, dx, dy, dz, c.min, c.max, dist);
    if (t >= 0 && t < dist) return i; // return the blocking collider index
  }
  return -1;
}

// ============================ RUN THE CHECKS ============================
let fail = 0;
const n = nodes.length;

// (a) BFS connectivity from node 0
const seen = new Uint8Array(n);
const queue = [0]; seen[0] = 1; let reached = 1;
while (queue.length) {
  const cur = queue.shift();
  for (const nb of nodes[cur].links) {
    if (nb < 0 || nb >= n) { console.log(`OUT-OF-RANGE link ${cur}→${nb}`); fail++; continue; }
    if (!seen[nb]) { seen[nb] = 1; reached++; queue.push(nb); }
  }
}
if (reached !== n) {
  const missing = []; for (let i = 0; i < n; i++) if (!seen[i]) missing.push(i);
  console.log(`(a) CONNECTIVITY FAIL: ${reached}/${n}; unreachable [${missing}]`); fail++;
} else console.log(`(a) connectivity OK: ${reached}/${n} nodes reachable from 0`);

// symmetry
let asym = 0;
for (let i = 0; i < n; i++) for (const nb of nodes[i].links) {
  if (nb >= 0 && nb < n && !nodes[nb].links.includes(i)) { console.log(`   asymmetry ${i}→${nb}`); asym++; }
}
if (asym) { console.log(`(a') LINK ASYMMETRY: ${asym} one-way links`); fail++; }
else console.log(`(a') all links symmetric`);

// (b) spawn clearance ≥0.6 m
const CLEAR = 0.6;
function checkSpawns(label, arr) {
  for (let s = 0; s < arr.length; s++) {
    const p = arr[s].pos;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (c.max.y <= 0.05) continue;
      const cx = Math.max(c.min.x, Math.min(p.x, c.max.x));
      const cz = Math.max(c.min.z, Math.min(p.z, c.max.z));
      const dx = p.x - cx, dz = p.z - cz;
      if (dx * dx + dz * dz < CLEAR * CLEAR) {
        console.log(`(b) SPAWN CLEARANCE FAIL: ${label} spawn ${s} (${p.x},${p.z}) <${CLEAR}m from collider ${i} [${JSON.stringify(c.min)}..${JSON.stringify(c.max)}]`);
        fail++; break;
      }
    }
  }
}
checkSpawns('SE', seSpawns); checkSpawns('Bug', bugSpawns);
if (!fail) console.log(`(b) spawn clearance OK: ${seSpawns.length + bugSpawns.length} spawns ≥${CLEAR}m clear`);

// (c) links clear of geometry at y=1.0
const EYE = 1.0; let checked = 0, blocked = 0;
for (let i = 0; i < n; i++) for (const bi of nodes[i].links) {
  if (bi <= i || bi < 0 || bi >= n) continue;
  const a = nodes[i], b = nodes[bi];
  let dx = b.x - a.x, dz = b.z - a.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-4) continue;
  dx /= dist; dz /= dist;
  checked++;
  const hit = rayBlocked(a.x, EYE, a.z, dx, 0, dz, dist);
  if (hit >= 0) {
    const c = colliders[hit];
    console.log(`(c) LINK BLOCKED: ${i}↔${bi} (len ${dist.toFixed(1)}) by collider ${hit} x[${c.min.x},${c.max.x}] z[${c.min.z},${c.max.z}]`);
    blocked++; fail++;
  }
}
console.log(`(c) link geometry: ${checked} links tested, ${blocked} blocked`);

// bonus: report the longest A-lane sightline (node 7↔11 along z=-11.8) and
// verify B-corridor has NO full-length clear sightline (dogleg working).
function clearBetween(a, b, y = 1.6) {
  let dx = b.x - a.x, dz = b.z - a.z; const dist = Math.hypot(dx, dz);
  dx /= dist; dz /= dist;
  return rayBlocked(a.x, y, a.z, dx, 0, dz, dist) < 0;
}
const aMouthSE = { x: -14, z: -11.8 }, aMouthBug = { x: 14, z: -11.8 };
const aLen = Math.hypot(aMouthBug.x - aMouthSE.x, aMouthBug.z - aMouthSE.z);
console.log(`\n--- sightlines ---`);
console.log(`A-lane spawn-exit→spawn-exit: ${aLen.toFixed(1)} m, clear at eye height: ${clearBetween(aMouthSE, aMouthBug, 1.6)}`);
const bMouthSE = { x: -11.0, z: 12.6 }, bMouthBug = { x: 11.0, z: 12.6 };
console.log(`B-corridor mouth→mouth (${Math.hypot(bMouthBug.x - bMouthSE.x, 0).toFixed(1)} m) clear (should be FALSE — dogleg): ${clearBetween(bMouthSE, bMouthBug, 1.6)}`);
// Also confirm the two dogleg pass-channels are walkable width (≥1.0 m): south of
// the west stub, and north of the east stub.
const westStubS = 12.8, eastStubN = 12.5, innerFace = B_DIV_Z + WALL_T / 2;
console.log(`dogleg channels: south-of-west-stub ${(HALF_Z - westStubS).toFixed(2)} m, north-of-east-stub ${(eastStubN - innerFace).toFixed(2)} m (both should be ≥1.0)`);

console.log(`\ncolliders: ${colliders.length}`);

// -- ASCII minimap (top-down; X→right = west..east, Z↓ = north..south). Samples
//    the floor on a grid: '#' = inside a wall/collider, '.' = open floor.
console.log(`\n--- Prod minimap (top view; left=SE/west, right=Bug/east, top=A-lane/north) ---`);
const COLS = 80, ROWS = 30;
function solidAt(x, z) {
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (c.max.y <= 0.05) continue; // skip floor + flat strips
    if (x >= c.min.x && x <= c.max.x && z >= c.min.z && z <= c.max.z) return true;
  }
  return false;
}
for (let r = 0; r < ROWS; r++) {
  const z = -HALF_Z + (r + 0.5) / ROWS * (2 * HALF_Z);
  let line = '';
  for (let col = 0; col < COLS; col++) {
    const x = -HALF_X + (col + 0.5) / COLS * (2 * HALF_X);
    line += solidAt(x, z) ? '#' : ' ';
  }
  console.log(line);
}

console.log(fail ? `\n*** ${fail} FAILURE(S) ***` : `\n=== ALL CHECKS PASS ===`);
process.exit(fail ? 1 : 0);
