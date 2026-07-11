// ============================================================================
// STAIR CARVE (M6) — the ONE shared build-time transform that makes Shoots'
// high decks CLIMBABLE. Pure function over the raw dataset box list; the source
// JSON stays pristine. Consumed IDENTICALLY by:
//   • shootsMap.js               (runtime colliders + render)
//   • scripts/gen-shoots-nav.mjs (walkability lattice discovers the carved runs)
//   • scripts/verify-shoots.mjs  (harness colliders + silhouette check)
// so all three agree byte-for-byte and the output is deterministic.
//
// THE PROBLEM (verified): the source's terraced stairs DID survive into the
// dataset as ~894 thin `stair` treads, but each deck's footprint is filled by a
// SOLID `prop` box (ground → ~3.1 m) that BURIES them — no headroom, so a 0.4 m
// step-up reaches nothing above ~1.6 m and ZERO of the deck clusters are
// climbable.
//
// THE FIX: for every solid ground-founded prop (k='prop', h≥1.5 m, bottom<0.6 m)
// whose footprint intersects a source stair-run rectangle (reference/
// shoots-layout.json → shootsStairRuns.json), REPLACE that prop with a set of
// stepped slabs. Each slab's top follows the run's own fromY→toY climb, stepped
// to ≤0.30 m rises along the run's climb axis (deduced from the treads' own
// top-vs-position correlation); tread depth = the raster cell (≥0.34 m). Cells
// of the prop NOT under any run keep the original prop top (a sheer face stays
// sheer). The footprint is tiled EXACTLY per prop, so the top-down OCCUPANCY
// silhouette (where geometry exists vs open) is unchanged; only the height
// PROFILE of a carved run drops from a cliff to a staircase — that IS the carve
// (reported as an expected height delta, not a footprint change).
//
// This SUPERSEDES the earlier 2-corridor stub (deck#2/#3 only) and the M4/M5
// "geometrically infeasible" note: the run-driven terraced ramp reaches 8 of the
// 10 real deck clusters. Decks with no rendered stairs at all stay solid by
// design (§ reported to the lead) — no geometry is invented.
//
// DETERMINISM: no Math.random / Date; fixed raster grid + stable insertion-order
// iteration. Runs ONCE at build — zero per-frame cost, zero hot-path allocation.
// ============================================================================

const CELL = 0.34;         // raster cell / min tread depth (m)
const MAX_RISE = 0.30;     // step rise cap (m) — comfortably under MOVE.stepHeight 0.4
const MIN_PROP_H = 1.5;    // only tall props are "buried decks" worth carving
const GROUND_MAX = 0.6;    // prop must be founded at/near ground to be a climb base
const RUN_MIN_AREA = 30;   // ignore tiny decorative stair fragments
const RUN_MIN_STEPS = 10;

const overlaps = (a0, a1, b0, b1) => a1 > b0 && a0 < b1;

// Deduce each substantial run's climb axis + direction from the correlation of
// its treads' top height with X / Z, cap its top at the deck it feeds (so we do
// not ramp up into a solid roof over a low deck), and drop its base to ground so
// step 1 is a ≤0.4 m climb from the floor.
function prepareRuns(boxes, stairRuns, decks) {
  const big = stairRuns.filter((r) => r.area >= RUN_MIN_AREA && r.steps >= RUN_MIN_STEPS);
  const stairs = boxes.filter((b) => b.k === 'stair');
  return big.map((r) => {
    const inr = stairs.filter((b) => b.c[0] > r.minX && b.c[0] < r.maxX && b.c[2] > r.minZ && b.c[2] < r.maxZ);
    const n = inr.length || 1;
    const tops = inr.map((b) => b.c[1] + b.s[1] / 2);
    const mt = tops.reduce((a, b) => a + b, 0) / n;
    const corr = (vals) => {
      const mv = vals.reduce((a, b) => a + b, 0) / n;
      let num = 0, dt = 0, dv = 0;
      for (let k = 0; k < n; k++) { num += (vals[k] - mv) * (tops[k] - mt); dt += (tops[k] - mt) ** 2; dv += (vals[k] - mv) ** 2; }
      return num / Math.sqrt(dt * dv || 1);
    };
    const cx = corr(inr.map((b) => b.c[0]));
    const cz = corr(inr.map((b) => b.c[2]));
    const axis = Math.abs(cx) >= Math.abs(cz) ? 'x' : 'z';
    const dir = (axis === 'x' ? cx : cz) >= 0 ? 1 : -1;
    const run = { idx: stairRuns.indexOf(r), minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ, fromY: r.fromY, toY: r.toY, axis, dir };
    let cap = null;
    for (const dk of decks) if (overlaps(r.minX, r.maxX, dk.minX, dk.maxX) && overlaps(r.minZ, r.maxZ, dk.minZ, dk.maxZ)) if (cap === null || dk.topY > cap) cap = dk.topY;
    if (cap !== null && cap < run.toY) run.toY = cap + 0.05;
    run.fromY = Math.min(run.fromY, 0.05);
    return run;
  });
}

// Quantized stepped-ramp height at (x,z): max over covering runs.
function rampHeightAt(runs, x, z) {
  let best = null;
  for (const r of runs) {
    if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) continue;
    const span = r.axis === 'x' ? r.maxX - r.minX : r.maxZ - r.minZ;
    const lo = r.axis === 'x' ? r.minX : r.minZ;
    let t = ((r.axis === 'x' ? x : z) - lo) / span;
    if (r.dir < 0) t = 1 - t;
    t = Math.max(0, Math.min(1, t));
    const rise = r.toY - r.fromY;
    const nsteps = Math.max(1, Math.ceil(rise / MAX_RISE));
    const y = r.fromY + Math.min(nsteps, Math.ceil(t * nsteps)) * (rise / nsteps);
    if (best === null || y > best) best = y;
  }
  return best;
}

function propRunHits(stairRuns, b) {
  const x0 = b.c[0] - b.s[0] / 2, x1 = b.c[0] + b.s[0] / 2, z0 = b.c[2] - b.s[2] / 2, z1 = b.c[2] + b.s[2] / 2;
  return stairRuns.some((r) => overlaps(x0, x1, r.minX, r.maxX) && overlaps(z0, z1, r.minZ, r.maxZ));
}

/**
 * Carve the dataset box list (data-space, PRE any z-translate). Returns:
 *   kept    — every box NOT replaced (verbatim; incl. non-carve props, walls,
 *             floors, and the platform CAPS that define the deck tops).
 *   carved  — new stepped slabs {c:[x,y,z], s:[w,h,d], k:'stair'} replacing the
 *             carved props (bottom at 0, top = the tread profile). Same shape as
 *             a dataset box so callers treat them uniformly.
 *   log     — one M6.x entry per carved prop for the MODIFICATIONS banner.
 *
 * @param {Array} boxes      GEO.boxes
 * @param {Array} stairRuns  shootsStairRuns.json .stairRuns
 * @param {Array} decks      shootsStairRuns.json .decks
 */
export function carveShoots(boxes, stairRuns, decks) {
  const runs = prepareRuns(boxes, stairRuns, decks);
  const isCarve = (b) => b.k === 'prop' && b.s[1] >= MIN_PROP_H && (b.c[1] - b.s[1] / 2) < GROUND_MAX && propRunHits(stairRuns, b);
  const kept = boxes.filter((b) => !isCarve(b));
  const carveProps = boxes.filter(isCarve);
  const carved = [];
  const log = [];

  // Rasterize a rect [x0..x1]×[z0..z1] into stepped slabs whose top = heightFn(x,z)
  // (rounded to the tread quantum so equal cells merge). Two-pass greedy merge
  // (z-runs per column, then merge identical runs across adjacent columns) keeps
  // the slab count tiny. Returns {cnt, lo, hi}. Deterministic (fixed grid, stable
  // insertion order).
  const emitField = (x0, x1, z0, z1, heightFn) => {
    const nx = Math.max(1, Math.round((x1 - x0) / CELL));
    const nz = Math.max(1, Math.round((z1 - z0) / CELL));
    const cw = (x1 - x0) / nx, cd = (z1 - z0) / nz;
    const H = new Array(nx * nz);
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const h = heightFn(x0 + (i + 0.5) * cw, z0 + (j + 0.5) * cd);
      H[i * nz + j] = h === null ? null : Math.round(h * 100) / 100;
    }
    const segs = [];
    for (let i = 0; i < nx; i++) { let j = 0; while (j < nz) { const h = H[i * nz + j]; if (h === null) { j++; continue; } let j2 = j; while (j2 + 1 < nz && H[i * nz + (j2 + 1)] === h) j2++; segs.push({ i, j, j2, h }); j = j2 + 1; } }
    const byKey = new Map();
    for (const s of segs) { const k = `${s.j}:${s.j2}:${s.h}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(s); }
    let lo = Infinity, hi = -Infinity, cnt = 0;
    for (const arr of byKey.values()) {
      arr.sort((a, c) => a.i - c.i);
      let k = 0;
      while (k < arr.length) {
        let k2 = k; while (k2 + 1 < arr.length && arr[k2 + 1].i === arr[k2].i + 1) k2++;
        const i0 = arr[k].i, i1 = arr[k2].i, j = arr[k].j, j2 = arr[k].j2, h = arr[k].h;
        const bx0 = x0 + i0 * cw, bx1 = x0 + (i1 + 1) * cw, bz0 = z0 + j * cd, bz1 = z0 + (j2 + 1) * cd;
        const w = bx1 - bx0, d = bz1 - bz0;
        if (h > 0.02) { carved.push({ c: [bx0 + w / 2, h / 2, bz0 + d / 2], s: [w, h, d], k: 'stair' }); lo = Math.min(lo, h); hi = Math.max(hi, h); cnt++; }
        k = k2 + 1;
      }
    }
    return { cnt, lo, hi };
  };

  // PASS 1 — carve each buried solid prop: cells under a run become the stepped
  // ramp; cells with no run keep the original prop top (sheer face stays sheer).
  for (const b of carveProps) {
    const px0 = b.c[0] - b.s[0] / 2, px1 = b.c[0] + b.s[0] / 2;
    const pz0 = b.c[2] - b.s[2] / 2, pz1 = b.c[2] + b.s[2] / 2;
    const ptop = b.c[1] + b.s[1] / 2;
    const { cnt, lo, hi } = emitField(px0, px1, pz0, pz1, (x, z) => {
      const rp = rampHeightAt(runs, x, z);
      return rp !== null ? Math.min(rp, ptop) : ptop;
    });
    const servedRuns = runs.filter((r) => overlaps(px0, px1, r.minX, r.maxX) && overlaps(pz0, pz1, r.minZ, r.maxZ)).map((r) => r.idx);
    log.push({
      c: [+b.c[0].toFixed(2), +b.c[1].toFixed(2), +b.c[2].toFixed(2)],
      s: [+b.s[0].toFixed(2), +b.s[1].toFixed(2), +b.s[2].toFixed(2)],
      runs: servedRuns,
      before: `solid 0→${ptop.toFixed(2)}`,
      after: `${cnt} terraces ${isFinite(lo) ? lo.toFixed(2) : '-'}→${isFinite(hi) ? hi.toFixed(2) : '-'}`,
    });
  }

  // PASS 2 — RUN BACKFILL: some runs (the N/S cap decks) climb over the source's
  // cantilevered stair fragments that came in FLOATING (a 1.5 m tread over open
  // floor, no riser) — a cliff the prop-carve alone can't bridge because there is
  // no prop under those cells. Fill each run's rect with the SAME stepped ramp
  // BELOW the existing surface: the added slabs run ground→ramp-top but never rise
  // ABOVE what already occupies the cell (cap at the existing max top), so this is
  // occupancy-neutral (these rects are 91–97% already occupied) — it only supplies
  // the missing risers under the floating treads.
  const keptTopAt = (x, z) => {
    let t = null;
    for (const c of kept) {
      const kx0 = c.c[0] - c.s[0] / 2, kx1 = c.c[0] + c.s[0] / 2, kz0 = c.c[2] - c.s[2] / 2, kz1 = c.c[2] + c.s[2] / 2, ktop = c.c[1] + c.s[1] / 2;
      if (x >= kx0 && x <= kx1 && z >= kz0 && z <= kz1 && ktop > -0.3 && ktop < 3.95) if (t === null || ktop > t) t = ktop;
    }
    return t;
  };
  for (const r of runs) {
    const before = carved.length;
    const { cnt, lo, hi } = emitField(r.minX, r.maxX, r.minZ, r.maxZ, (x, z) => {
      const rp = rampHeightAt(runs, x, z);
      if (rp === null) return null;
      const cap = keptTopAt(x, z);
      // fill the riser under a floating tread, but never above the local surface
      return cap === null ? rp : Math.min(rp, cap + 0.05);
    });
    if (carved.length > before) {
      log.push({ c: [`run${r.idx}`], s: [`${(r.maxX - r.minX).toFixed(1)}×${(r.maxZ - r.minZ).toFixed(1)}`], runs: [r.idx], before: 'floating treads / cliff', after: `${cnt} backfill risers ${isFinite(lo) ? lo.toFixed(2) : '-'}→${isFinite(hi) ? hi.toFixed(2) : '-'}` });
    }
  }

  // Combined verbatim-shape list (data-space {c,s,k}): callers translate + build
  // uniformly. `boxes` = kept ⧺ carved so occupancy is preserved.
  const combined = kept.concat(carved);
  return { boxes: combined, kept, carved, log, dropped: carveProps.length, added: carved.length };
}
