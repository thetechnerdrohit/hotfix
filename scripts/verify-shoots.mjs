// Standalone verification harness for shootsMap — replicates its collider + graph
// construction WITHOUT three/addons or import.meta.env (Vite-only), then runs the
// SAME y-aware self-check (mapChecks.js). Run: node scripts/verify-shoots.mjs

const HALF_X = 31, HALF_Z = 31, WALL_H = 4, WALL_T = 0.6;
const DECK_TOP = 2.63, DECK_SLAB = 0.2, CORNER_TOP = 2.45, FLANK_TOP = 1.2;

const dA = { minX: -14, maxX: 0, minZ: -11, maxZ: -3 };
const dB = { minX: 0, maxX: 14, minZ: 3, maxZ: 11 };
const cbS = { minX: -26, maxX: -18, minZ: -24, maxZ: -16 };
const cbN = { minX: 18, maxX: 26, minZ: 16, maxZ: 24 };
const lfW = { minX: -12, maxX: -8, minZ: -16, maxZ: -12 };
const lfE = { minX: 8, maxX: 12, minZ: 12, maxZ: 16 };

const colliders = [];
function addBox(w, h, d, x, base, z, collide = true) {
  if (collide) colliders.push({ min: { x: x - w / 2, y: base, z: z - d / 2 }, max: { x: x + w / 2, y: base + h, z: z + d / 2 } });
}
function sym2(w, h, d, x, base, z, collide = true) { addBox(w, h, d, x, base, z, collide); addBox(w, h, d, -x, base, z, collide); }

// ground + perimeter
addBox(HALF_X * 2 + 2, 0.5, HALF_Z * 2 + 2, 0, -0.5, 0);
addBox(HALF_X * 2 + WALL_T, WALL_H, WALL_T, 0, 0, HALF_Z + WALL_T / 2);
addBox(HALF_X * 2 + WALL_T, WALL_H, WALL_T, 0, 0, -HALF_Z - WALL_T / 2);
addBox(WALL_T, WALL_H, HALF_Z * 2 + WALL_T, HALF_X + WALL_T / 2, 0, 0);
addBox(WALL_T, WALL_H, HALF_Z * 2 + WALL_T, -HALF_X - WALL_T / 2, 0, 0);

// decks
function buildRaisedDeck(f) {
  const w = f.maxX - f.minX, d = f.maxZ - f.minZ, cx = (f.minX + f.maxX) / 2, cz = (f.minZ + f.maxZ) / 2;
  addBox(w, DECK_SLAB, d, cx, DECK_TOP - DECK_SLAB, cz);
  const pierH = DECK_TOP - DECK_SLAB;
  for (const x of [f.minX + 0.4, cx, f.maxX - 0.4]) for (const z of [f.minZ + 0.4, f.maxZ - 0.4]) addBox(0.6, pierH, 0.6, x, 0, z);
  addBox(w, 0.9, 0.12, cx, DECK_TOP, f.minZ + 0.06);
  addBox(w, 0.9, 0.12, cx, DECK_TOP, f.maxZ - 0.06);
}
buildRaisedDeck(dA); buildRaisedDeck(dB);
const TERR_RISE = 0.33, TERR_TREAD = 1.0, N_TERR = Math.ceil(DECK_TOP / TERR_RISE), TERR_W = 5.0;
const terrAx = (dA.minX + dA.maxX) / 2, terrBx = (dB.minX + dB.maxX) / 2;
function terraceRun(x, edgeZ, dir) {
  for (let i = 0; i < N_TERR; i++) { const top = Math.min(DECK_TOP, (i + 1) * TERR_RISE); const z = edgeZ - dir * (N_TERR - i - 0.5) * TERR_TREAD; addBox(TERR_W, top, TERR_TREAD, x, 0, z); }
}
terraceRun(terrAx, dA.minZ, +1); terraceRun(terrBx, dB.maxZ, -1);
{ const cwW = 4.0; addBox(cwW, DECK_SLAB, 6.4, 0, DECK_TOP - DECK_SLAB, 0); addBox(0.6, DECK_TOP - DECK_SLAB, 0.6, 0, 0, 0); addBox(0.12, 0.9, 6.4, -cwW / 2 + 0.06, DECK_TOP, 0); addBox(0.12, 0.9, 6.4, cwW / 2 - 0.06, DECK_TOP, 0); }

// corner buildings
function stairRun(zCenter, edgeX, dir, width) {
  const rise = 0.34, tread = 0.55, steps = Math.ceil(CORNER_TOP / rise);
  for (let i = 0; i < steps; i++) { const top = Math.min(CORNER_TOP, (i + 1) * rise); const x = edgeX - dir * (steps - i - 0.5) * tread; addBox(tread, top, width, x, 0, zCenter); }
}
function buildCornerBuilding(f, bug) {
  const w = f.maxX - f.minX, d = f.maxZ - f.minZ, cx = (f.minX + f.maxX) / 2, cz = (f.minZ + f.maxZ) / 2;
  addBox(w, CORNER_TOP, d, cx, 0, cz);
  addBox(0.12, 0.95, d, bug ? f.maxX - 0.06 : f.minX + 0.06, CORNER_TOP, cz);
  addBox(w, 0.95, 0.12, cx, CORNER_TOP, bug ? f.maxZ - 0.06 : f.minZ + 0.06);
  const edgeX = bug ? f.minX : f.maxX;
  stairRun(cz, edgeX, bug ? +1 : -1, Math.min(6.0, d * 0.7));
}
buildCornerBuilding(cbS, false); buildCornerBuilding(cbN, true);

// flanks
function buildFlank(f, bug) {
  const w = f.maxX - f.minX, d = f.maxZ - f.minZ, cx = (f.minX + f.maxX) / 2, cz = (f.minZ + f.maxZ) / 2;
  addBox(w, FLANK_TOP, d, cx, 0, cz);
  const dir = bug ? +1 : -1, edgeZ = bug ? f.maxZ : f.minZ;
  for (let i = 0; i < 3; i++) { const top = (i + 1) * (FLANK_TOP / 3); const z = edgeZ + dir * (3 - i - 0.5) * 0.6; addBox(w, top, 0.6, cx, 0, z); }
}
buildFlank(lfW, false); buildFlank(lfE, true);

// cover
const SB_H = 1.4;
const COVER = [[-20, -6, 6, 'x'], [-9, -18, 5, 'z'], [-4, -20, 4, 'x'], [-13, 3, 5, 'x']];
for (const [x, z, len, axis] of COVER) { if (axis === 'x') sym2(len, SB_H, 0.6, x, 0, z); else sym2(0.6, SB_H, len, x, 0, z); }

// spawns
const YAW_N = Math.PI, YAW_S = 0, SPAWN_Z = 28;
const seSpawnXs = [-9, -3, 3, 9];
const seSpawns = seSpawnXs.map((x) => ({ pos: { x, y: 0, z: -SPAWN_Z }, yaw: YAW_N }));
const bugSpawns = seSpawnXs.map((x) => ({ pos: { x: -x, y: 0, z: SPAWN_Z }, yaw: YAW_S }));

// ---- waypoints (mirror of buildWaypoints) ----
const terrAfootZ = dA.minZ - N_TERR * TERR_TREAD - 0.5, terrAtopZ = dA.minZ + 1.0;
const cbSc = { x: (cbS.minX + cbS.maxX) / 2, z: (cbS.minZ + cbS.maxZ) / 2 };
const cbSfootX = cbS.maxX + 1.4;
const lfWc = { x: (lfW.minX + lfW.maxX) / 2, z: (lfW.minZ + lfW.maxZ) / 2 };
const OFFSET = 18, ROOF = 36;
const crossFn = (i) => ({ cross: i });
const SE = [
  { x: -9, y: 0, z: -SPAWN_Z, links: [3] },
  { x: -3, y: 0, z: -SPAWN_Z, links: [3] },
  { x: 3, y: 0, z: -SPAWN_Z, links: [3] },
  { x: 0, y: 0, z: -SPAWN_Z + 5, links: [0, 1, 2, 4, 5] },
  { x: -12, y: 0, z: -24, links: [3, 9, 6] },
  { x: 6, y: 0, z: -24, links: [3, 7] },
  { x: -13, y: 0, z: -8, links: [4, 16, 15] },
  { x: terrAx, y: 0, z: -21, links: [5, 8] },
  { x: terrAx, y: DECK_TOP, z: -11.5, links: [7, ROOF] },
  { x: -13, y: 0, z: -20.2, links: [4, 10, 11] },
  { x: -18.8, y: CORNER_TOP, z: -20, links: [9] },
  { x: -10, y: 0, z: -18.5, links: [9, 12] },
  { x: lfWc.x, y: FLANK_TOP, z: lfWc.z, links: [11] },
  { x: -9, y: 0, z: 12, links: [16] },
  { x: 13, y: 0, z: -8, links: [17] },
  { x: -25, y: 0, z: -14, links: [6] },
  { x: -4, y: 0, z: 4, links: [6, 13, 17, crossFn(17)] },
  { x: 4, y: 0, z: 4, links: [16, 14, crossFn(16)] },
];
const M = SE.length;
const nodes = new Array(M * 2 + 1);
const crossPairs = [];
for (let i = 0; i < M; i++) {
  const s = SE[i], seLinks = [];
  for (const l of s.links) {
    if (l === ROOF) seLinks.push(ROOF);
    else if (typeof l === 'object' && 'cross' in l) { const b = l.cross + OFFSET; seLinks.push(b); crossPairs.push([i, b]); }
    else seLinks.push(l);
  }
  nodes[i] = { x: s.x, y: s.y, z: s.z, links: seLinks };
}
for (let i = 0; i < M; i++) {
  const s = SE[i], bugLinks = [];
  for (const l of s.links) {
    if (l === ROOF) bugLinks.push(ROOF);
    else if (typeof l === 'object' && 'cross' in l) { const t = l.cross; bugLinks.push(t); crossPairs.push([i + OFFSET, t]); }
    else bugLinks.push(l + OFFSET);
  }
  nodes[i + OFFSET] = { x: -s.x, y: s.y, z: -s.z, links: bugLinks };
}
nodes[ROOF] = { x: 0, y: DECK_TOP, z: 0, links: [8, 8 + OFFSET] };
for (const [a, b] of crossPairs) { if (!nodes[a].links.includes(b)) nodes[a].links.push(b); if (!nodes[b].links.includes(a)) nodes[b].links.push(a); }

// ============================ mapChecks (JS port) ============================
const CLEAR = 0.6, EYE = 1.0, BODY_H = 1.8, SLOPE_MAX = 0.45;
const ny = (i) => nodes[i].y ?? 0;
let fail = 0; const n = nodes.length;

const seen = new Uint8Array(n); const queue = [0]; seen[0] = 1; let reached = 1;
while (queue.length) { const cur = queue.shift(); for (const nb of nodes[cur].links) { if (nb < 0 || nb >= n) { console.log(`OUT-OF-RANGE ${cur}→${nb}`); fail++; continue; } if (!seen[nb]) { seen[nb] = 1; reached++; queue.push(nb); } } }
if (reached !== n) { const m = []; for (let i = 0; i < n; i++) if (!seen[i]) m.push(i); console.log(`(a) CONNECTIVITY FAIL ${reached}/${n} unreachable [${m}]`); fail++; } else console.log(`(a) connectivity OK ${reached}/${n}`);

let asym = 0;
for (let i = 0; i < n; i++) for (const nb of nodes[i].links) if (nb >= 0 && nb < n && !nodes[nb].links.includes(i)) { console.log(`   asym ${i}→${nb}`); asym++; }
if (asym) { console.log(`(a') ${asym} one-way links`); fail++; } else console.log(`(a') links symmetric`);

function rayBox(o, d, min, max, maxDist) {
  const mn = [min.x, min.y, min.z], mx = [max.x, max.y, max.z]; let tmin = 0, tmax = maxDist;
  for (let i = 0; i < 3; i++) { if (d[i] === 0) { if (o[i] < mn[i] || o[i] > mx[i]) return -1; continue; } const inv = 1 / d[i]; let t1 = (mn[i] - o[i]) * inv, t2 = (mx[i] - o[i]) * inv; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; } if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2; if (tmin > tmax) return -1; }
  return tmin;
}
function rayBlocked(o, d, dist) { for (let i = 0; i < colliders.length; i++) { const t = rayBox(o, d, colliders[i].min, colliders[i].max, dist); if (t >= 0 && t < dist) return i; } return -1; }
function checkSpawn(label, arr) {
  for (let s = 0; s < arr.length; s++) { const p = arr[s].pos, feetY = p.y, headY = p.y + BODY_H;
    for (let i = 0; i < colliders.length; i++) { const c = colliders[i]; if (c.max.y <= 0.05) continue; if (c.max.y <= feetY + 0.05 || c.min.y >= headY) continue; const cx = Math.max(c.min.x, Math.min(p.x, c.max.x)), cz = Math.max(c.min.z, Math.min(p.z, c.max.z)); const dx = p.x - cx, dz = p.z - cz; if (dx * dx + dz * dz < CLEAR * CLEAR) { console.log(`(b) CLEARANCE FAIL ${label} spawn ${s} (${p.x},${p.z}) <${CLEAR}m from col ${i}`); fail++; break; } } }
}
checkSpawn('SE', seSpawns); checkSpawn('Bug', bugSpawns);
function checkSupport(label, arr) {
  for (let s = 0; s < arr.length; s++) { const p = arr[s].pos; let ok = false;
    for (let i = 0; i < colliders.length; i++) { const c = colliders[i]; if (p.x < c.min.x || p.x > c.max.x || p.z < c.min.z || p.z > c.max.z) continue; if (c.max.y <= p.y + 0.01 && c.max.y >= p.y - 0.5) { ok = true; break; } }
    if (!ok) { console.log(`(b2) NO FLOOR under ${label} spawn ${s} (${p.x},${p.y},${p.z})`); fail++; } }
}
checkSupport('SE', seSpawns); checkSupport('Bug', bugSpawns);

let checked = 0, blocked = 0, steep = 0;
for (let i = 0; i < n; i++) { const a = nodes[i], ay = ny(i);
  for (const bi of a.links) { if (bi <= i || bi < 0 || bi >= n) continue; const b = nodes[bi], by = ny(bi);
    const dx = b.x - a.x, dz = b.z - a.z, xzLen = Math.hypot(dx, dz), dy = by - ay;
    if (xzLen < 1e-4) { if (Math.abs(dy) > 1e-3) { steep++; console.log(`(d) VERTICAL ${i}↔${bi} Δy${dy.toFixed(2)}`); fail++; } continue; }
    if (Math.abs(dy) / xzLen > SLOPE_MAX) { steep++; console.log(`(d) STEEP ${i}↔${bi} slope ${(Math.abs(dy) / xzLen).toFixed(2)}/m (Δy ${dy.toFixed(2)} over ${xzLen.toFixed(1)})`); fail++; }
    const dist = Math.hypot(dx, dy, dz), dir = [dx / dist, dy / dist, dz / dist]; checked++;
    const hit = rayBlocked([a.x, ay + EYE, a.z], dir, dist);
    if (hit >= 0) { const c = colliders[hit]; console.log(`(c) BLOCKED ${i}↔${bi} len${dist.toFixed(1)} eyeY${(ay + EYE).toFixed(1)}→${(by + EYE).toFixed(1)} by col ${hit} x[${c.min.x.toFixed(1)},${c.max.x.toFixed(1)}] y[${c.min.y.toFixed(1)},${c.max.y.toFixed(1)}] z[${c.min.z.toFixed(1)},${c.max.z.toFixed(1)}]`); blocked++; fail++; }
  }
}
console.log(`(c/d) ${checked} links LOS-tested, ${blocked} blocked, ${steep} over-steep`);
console.log(`\ncolliders: ${colliders.length}, nodes: ${n}, draw buckets(colors): see build`);
console.log(`deckA X[${dA.minX},${dA.maxX}] Z[${dA.minZ},${dA.maxZ}] top ${DECK_TOP} headroom ${(DECK_TOP - DECK_SLAB).toFixed(2)}`);
console.log(`terraces ${N_TERR}×${TERR_RISE}=${(N_TERR * TERR_RISE).toFixed(2)}; corner ${CORNER_TOP}; flank ${FLANK_TOP}`);
console.log(`spawn→center ${SPAWN_Z}m = ${(SPAWN_Z / 5).toFixed(1)}s @5m/s`);

// minimap
console.log(`\n--- Shoots minimap (top view; left=west,right=east; TOP=+Z Bug end, BOTTOM=-Z SE end) ---`);
const COLS = 74, ROWS = 34;
function solidAt(x, z, yBand) {
  for (let i = 0; i < colliders.length; i++) { const c = colliders[i]; if (c.max.y <= 0.05) continue; if (x >= c.min.x && x <= c.max.x && z >= c.min.z && z <= c.max.z && c.max.y > yBand) return c.max.y; }
  return 0;
}
for (let r = 0; r < ROWS; r++) {
  const z = HALF_Z - (r + 0.5) / ROWS * (2 * HALF_Z); let line = '';
  for (let col = 0; col < COLS; col++) {
    const x = -HALF_X + (col + 0.5) / COLS * (2 * HALF_X);
    const h = solidAt(x, z, 0.05);
    line += h === 0 ? ' ' : h >= 2.4 ? '#' : h >= 1.3 ? '=' : '.';
  }
  console.log(line);
}
console.log(`legend: '#' deck/tall(≥2.4)  '=' cover(1.3–2.4)  '.' low step  ' ' open`);

console.log(fail ? `\n*** ${fail} FAILURE(S) ***` : `\n=== ALL CHECKS PASS ===`);
process.exit(fail ? 1 : 0);

// ---- PROBE (appended; only runs with arg 'probe') ----
if (process.argv[2] === 'probe') {
  console.log('\n=== PROBE ===');
  // deckA slab extent and terrace tops
  console.log('deckA slab collider search:');
  colliders.forEach((c,i)=>{ if (Math.abs(c.max.y-DECK_TOP)<0.02 && c.max.x-c.min.x>3) console.log(i, 'x',c.min.x,c.max.x,'z',c.min.z,c.max.z,'y',c.min.y,c.max.y); });
}
