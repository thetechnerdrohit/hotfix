// Generates src/world/shootsNav.json for the carved Shoots map. Applies the SAME
// M6 stair carve as shootsMap.js (src/world/shootsCarve.js) then builds a single
// height-aware walkable lattice over the carved colliders: one node per grid cell
// at that cell's top surface (ground OR a carved deck/ramp), linked to neighbours
// the 0.4 m step-up can actually walk (surface-continuous, ≤0.42 m up, ≤0.6 m
// drop, 1.7 m headroom, link-slope ≤0.45/m). Because the carve fills each deck
// solid up to its stepped top, every XZ column has ONE walkable surface, so a
// flat lattice captures both ground and elevated decks. Kept to the single
// center-reachable component. Deterministic (fixed grid, stable order). Run:
//   node scripts/gen-shoots-nav.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { carveShoots } from '../src/world/shootsCarve.js';

const D = JSON.parse(readFileSync(new URL('../reference/shoots-geometry.json', import.meta.url)));
const R = JSON.parse(readFileSync(new URL('../src/world/shootsStairRuns.json', import.meta.url)));
const DZ = 14.63;

// Carve in data-space, then translate (M1) into world colliders {minx..maxz,top,bot}.
const carve = carveShoots(D.boxes, R.stairRuns, R.decks);
console.log(`carve: replaced ${carve.dropped} buried props → ${carve.added} terraced slabs`);
const col = carve.boxes.map((b) => ({
  minx: b.c[0] - b.s[0] / 2, maxx: b.c[0] + b.s[0] / 2,
  minz: b.c[2] + DZ - b.s[2] / 2, maxz: b.c[2] + DZ + b.s[2] / 2,
  top: b.c[1] + b.s[1] / 2, bot: b.c[1] - b.s[1] / 2,
}));

const GRID = 1.5;      // lattice spacing (m) — fine enough for the carved runs
const STEP_UP = 0.42;  // ≤ MOVE.stepHeight 0.4 (+tol)
const DROP = 0.6;      // max walk-down
const HEAD = 1.7;      // headroom
const SLOPE = 0.45;    // K5 link-slope cap
const YMAX = 3.95;     // ignore skybox/tower tops above the top deck

function surface(x, z) {
  let t = null;
  for (const c of col) { if (x >= c.minx && x <= c.maxx && z >= c.minz && z <= c.maxz) { if (c.top < -0.3 || c.top > YMAX) continue; if (t === null || c.top > t) t = c.top; } }
  return t;
}
function clearAbove(x, z, y) {
  for (const c of col) { if (x >= c.minx && x <= c.maxx && z >= c.minz && z <= c.maxz && c.top > y + 0.2 && c.bot < y + HEAD) return false; }
  return true;
}
// Walkable if the interpolated surface stays step-continuous the whole way AND
// headroom is clear along it (bots + player traverse the floor, not an eye-ray).
function walk(a, b) {
  const n = Math.ceil(Math.hypot(a.x - b.x, a.z - b.z) / 0.5);
  let py = a.y;
  for (let s = 1; s <= n; s++) {
    const t = s / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    const sy = surface(x, z);
    if (sy === null) return false;
    if (sy - py > STEP_UP || py - sy > DROP) return false;
    if (!clearAbove(x, z, sy)) return false;
    py = sy;
  }
  return true;
}

// Lattice nodes: one per cell at its walkable surface (with headroom).
let pts = [];
for (let z = -40; z <= 44; z += GRID) for (let x = -42; x <= 42; x += GRID) {
  const s = surface(x, z);
  if (s !== null && clearAbove(x, z, s)) pts.push({ x: +x.toFixed(2), z: +z.toFixed(2), y: +s.toFixed(2), l: [] });
}
function link(arr) {
  for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
    const a = arr[i], b = arr[j];
    const xz = Math.hypot(a.x - b.x, a.z - b.z);
    if (xz < 0.5 || xz > GRID * 1.6) continue;
    if (Math.abs(a.y - b.y) / xz > SLOPE) continue;     // K5 slope cap
    if (walk(a, b) && walk(b, a)) { a.l.push(j); b.l.push(i); }
  }
}
link(pts);

// Keep only the component reachable from the node nearest the center (with links).
let seed = 0, bd = 1e9;
pts.forEach((p, i) => { const d = p.x * p.x + p.z * p.z; if (d < bd && p.l.length) { bd = d; seed = i; } });
const cm = new Array(pts.length).fill(0); const q = [seed]; cm[seed] = 1;
while (q.length) { const c = q.shift(); for (const nb of pts[c].l) if (!cm[nb]) { cm[nb] = 1; q.push(nb); } }
const map = new Map(); const idx = [];
for (let i = 0; i < pts.length; i++) if (cm[i]) { map.set(i, idx.length); idx.push(i); }
const out = idx.map((i) => ({ x: pts[i].x, y: pts[i].y, z: pts[i].z, links: [...new Set(pts[i].l.filter((j) => map.has(j)).map((j) => map.get(j)))] }));

// Sanity: BFS from node 0 must reach all.
const seen = new Array(out.length).fill(0); const q2 = [0]; seen[0] = 1; let reached = 1;
while (q2.length) { const c = q2.shift(); for (const nb of out[c].links) if (!seen[nb]) { seen[nb] = 1; reached++; q2.push(nb); } }
const ground = out.filter((p) => p.y < 1).length;
const elev = out.filter((p) => p.y > 1).length;
const elevHi = out.filter((p) => p.y > 2.5).length;
console.log(`TOTAL nodes ${out.length} connected ${reached} | ground ${ground} | elevated>1m ${elev} (>2.5m ${elevHi}) | maxY ${Math.max(...out.map((p) => p.y)).toFixed(2)}`);
writeFileSync(new URL('../src/world/shootsNav.json', import.meta.url), JSON.stringify(out));
console.log('wrote src/world/shootsNav.json');
