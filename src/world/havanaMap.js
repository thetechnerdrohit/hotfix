// ============================================================================
// "HAVANA" (v2.x DEV — ?room=havana) — a dense, warm Mediterranean/Havana-style
// town arena in the kour.io mold. Rohit's brief: pink/tan/teal/ochre plaster
// buildings (2–3 storeys, arched windows, small balconies), TIGHT ALLEYS that
// open into small PLAZAS, wooden crates + barrels as low cover, palm trees,
// market awnings/tarps strung overhead, graffiti accents, rooftop satellite
// dishes, power lines between buildings, BRIGHT BLUE SKY. Compact CS/kour-style
// close-to-mid-range FFA/TDM arena — NOT the big open Battleground field.
//
// This module owns: the Havana map geometry, colliders, spawns, and nav graph.
// It returns the SAME object shape as buildBattleMap() (group, colliders,
// spawnPoint, name, seSpawns, bugSpawns, waypointNodes, ropes, background, fog,
// update) so the boot path in main.js is map-agnostic.
//
// Layout (~96 × 96 m, playable ±48; buildings ring a central plaza):
//   • CENTRAL PLAZA (open, ~18 m) with a fountain centerpiece + crate cover.
//   • RING of 2–3 storey plaster blocks broken by TIGHT ALLEYS (≥3 m) that
//     feed the plaza. Corner buildings are climbable via exterior stairs to
//     flat roofs (nav-authored so bots contest them).
//   • PROPS: crates/barrels (body-height, collide), palm trees (trunk collides,
//     fronds don't), awnings/tarps + power lines + satellite dishes + graffiti
//     (all decorative, above head / non-collidable).
//   • SEALED perimeter wall ±48 (D9: no falling out of the world).
//
// Map rules mirror Battleground: walls ≥0.35 m thick (> max step/frame — no
// tunneling), doorways/alleys ≥3 m (D6 clearance), roofs at ≥2.7 m (jump apex
// can't mount them — stair/rope only), floor IS collidable (past bug: a
// non-collidable floor dropped the player out of the world), materials shared
// per color via a merge bucket, zero per-frame allocation (update = null).
// DEV self-check asserts a single connected nav component.
// ============================================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PERF } from '../config.js';

const HALF = 48;          // playable half-extent (~96 m across)
const WALL_H = 6, WALL_T = 1.0; // sealed perimeter

// Warm Havana palette — a small shared set (one material per color at merge).
const P = {
  ground:  0xcbb79a,  // sun-baked tan cobble
  groundB: 0xbfa988,  // paving tint
  perim:   0xb98c63,  // ochre boundary wall
  pink:    0xe6899b,  // rose plaster
  tan:     0xd9b877,  // ochre plaster
  teal:    0x7cc4bd,  // faded teal plaster
  blue:    0x8fb4d6,  // pale blue plaster
  yellow:  0xe8c86a,  // mustard plaster
  roof:    0xb56a55,  // terracotta roof / trim
  window:  0x3c4a55,  // dark inset (arched windows / doors)
  balcony: 0x6b4a34,  // wrought-iron / wood balcony
  stair:   0xd7c7ac,  // pale stone treads
  crate:   0x9c6b3f,  // wooden crate
  barrel:  0x557d74,  // teal barrel
  trunk:   0x7a5a3a,  // palm trunk
  frond:   0x6fae5c,  // palm frond green
  awning:  0xd85f5f,  // red-striped tarp
  awningB: 0xe8d3a0,  // cream stripe
  wire:    0x2c2c2c,  // power line
  dish:    0xdad2c4,  // satellite dish
  graffiti:0x4a8fb0,  // graffiti accent
};

export function buildHavanaMap() {
  const group = new THREE.Group();
  const colliders = [];
  const ropes = [];

  // -- merge-bucket helper (same discipline as battleMap) ---------------------
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

  // deterministic RNG for decorative scatter (no Math.random — resume-safe)
  const seedState = { s: 90210 };
  const rnd = () => (seedState.s = (seedState.s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  // -- GROUND + SEALED PERIMETER ----------------------------------------------
  addBox(HALF * 2 + 4, 0.5, HALF * 2 + 4, 0, -0.5, 0, P.ground); // top y=0
  for (let i = 0; i < 12; i++) { // paving tint patches (visual only)
    addBox(6 + rnd() * 10, 0.04, 6 + rnd() * 10, (rnd() * 2 - 1) * 40, 0.005, (rnd() * 2 - 1) * 40, P.groundB, { collide: false });
  }
  addBox(HALF * 2 + WALL_T * 2, WALL_H, WALL_T, 0, 0, -HALF - WALL_T / 2, P.perim);
  addBox(HALF * 2 + WALL_T * 2, WALL_H, WALL_T, 0, 0, HALF + WALL_T / 2, P.perim);
  addBox(WALL_T, WALL_H, HALF * 2 + WALL_T * 2, -HALF - WALL_T / 2, 0, 0, P.perim);
  addBox(WALL_T, WALL_H, HALF * 2 + WALL_T * 2, HALF + WALL_T / 2, 0, 0, P.perim);

  // Awnings + power lines are strung/animated? No — steady. Collected here so we
  // can also route power lines building-to-building after buildings are placed.
  const roofAnchors = []; // {x, z, y} rooftop points for wires/dishes

  // -- BUILDING PRIMITIVE ------------------------------------------------------
  // A plaster block: solid box body (collides), terracotta roof cap, arched
  // window insets (dark, non-collidable, decorative), optional small balcony.
  // Buildings are SOLID (no interior) — the play space is the streets/plaza,
  // kour-style. Height h ≥ 2.7 keeps roofs jump-proof.
  function building(cx, cz, w, d, h, color, { balconyFace = null } = {}) {
    addBox(w, h, d, cx, 0, cz, color);
    addBox(w + 0.4, 0.4, d + 0.4, cx, h, cz, P.roof); // terracotta cap (walkable top for stair-reached corners)
    roofAnchors.push({ x: cx, z: cz, y: h + 0.4 });
    // arched windows: rows of dark insets on the +X/-X/+Z/-Z faces (decor only)
    const eps = 0.06;
    const rows = Math.max(1, Math.floor(h / 2.4));
    for (let r = 0; r < rows; r++) {
      const wy = 1.4 + r * 2.4;
      if (wy > h - 0.6) break;
      // along X faces
      const nxz = Math.max(1, Math.floor(w / 2.6));
      for (let k = 0; k < nxz; k++) {
        const ox = (k - (nxz - 1) / 2) * (w / nxz);
        addBox(0.9, 1.3, eps, cx + ox, wy - 0.65, cz - d / 2 - eps / 2, P.window, { collide: false });
        addBox(0.9, 1.3, eps, cx + ox, wy - 0.65, cz + d / 2 + eps / 2, P.window, { collide: false });
        // little arch cap
        addBox(0.9, 0.25, eps, cx + ox, wy + 0.7, cz - d / 2 - eps / 2, P.roof, { collide: false });
        addBox(0.9, 0.25, eps, cx + ox, wy + 0.7, cz + d / 2 + eps / 2, P.roof, { collide: false });
      }
      const nzz = Math.max(1, Math.floor(d / 2.6));
      for (let k = 0; k < nzz; k++) {
        const oz = (k - (nzz - 1) / 2) * (d / nzz);
        addBox(eps, 1.3, 0.9, cx - w / 2 - eps / 2, wy - 0.65, cz + oz, P.window, { collide: false });
        addBox(eps, 1.3, 0.9, cx + w / 2 + eps / 2, wy - 0.65, cz + oz, P.window, { collide: false });
      }
    }
    // small balcony (decor, above head height — non-collidable)
    if (balconyFace) {
      const f = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[balconyFace];
      const by = Math.min(h - 0.8, 3.0);
      const bx = cx + f[0] * (w / 2 + 0.5), bz = cz + f[1] * (d / 2 + 0.5);
      addBox(f[0] !== 0 ? 1.0 : 2.2, 0.15, f[0] !== 0 ? 2.2 : 1.0, bx, by, bz, P.balcony, { collide: false });
      addBox(f[0] !== 0 ? 1.0 : 2.2, 0.6, 0.08, bx, by + 0.3, bz + (f[1] !== 0 ? f[1] * 0.45 : 0.45), P.balcony, { collide: false });
    }
  }

  // -- STAIR + ROOF (climbable corner buildings so bots/players contest roofs) -
  // Returns roof-nav info: {roof, mid, foot} like battleMap's villageRoofNodes.
  const roofNodes = [];
  function stairBuilding(cx, cz, w, d, h, color, stairSide /* 'N'|'S'|'E'|'W' */) {
    building(cx, cz, w, d, h, color);
    const faces = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
    const [sx, sz] = faces[stairSide];
    const rise = 0.35, deep = 0.5, wTread = 1.6;
    const steps = Math.ceil((h + 0.4) / rise);
    for (let k = 1; k <= steps; k++) {
      const t = Math.min(h + 0.4, k * rise);
      const off = (steps - k) * deep + (sx !== 0 ? w / 2 : d / 2) + deep / 2;
      const tx = cx + sx * off, tz = cz + sz * off;
      addBox(sx !== 0 ? deep : wTread, t, sx !== 0 ? wTread : deep, tx, 0, tz, P.stair);
    }
    const footOff = steps * deep + (sx !== 0 ? w / 2 : d / 2);
    roofNodes.push({
      roof: { x: cx, z: cz, y: h + 0.4 },
      foot: { x: cx + sx * (footOff + 0.6), z: cz + sz * (footOff + 0.6), y: 0 },
      mid: { x: cx + sx * (footOff * 0.5 + (sx !== 0 ? w / 2 : d / 2) * 0.5), z: cz + sz * (footOff * 0.5 + (sx !== 0 ? w / 2 : d / 2) * 0.5), y: (h + 0.4) / 2 },
    });
  }

  // -- CENTRAL PLAZA fountain + cover -----------------------------------------
  addBox(3.0, 0.7, 3.0, 0, 0, 0, P.teal);                 // fountain basin
  addBox(1.0, 1.6, 1.0, 0, 0.7, 0, P.stair);              // fountain column
  addBox(1.8, 0.2, 1.8, 0, 2.3, 0, P.window, { collide: false });

  // -- BUILDING RING (point-symmetric-ish; alleys between blocks feed plaza) ---
  // NW / SE corners get climbable stairs. Blocks sit at ±radius with ≥3 m gaps.
  // Corner (climbable) buildings — stairs face OUTWARD toward the perimeter.
  stairBuilding(-30, -30, 12, 12, 3.2, P.pink, 'W');
  stairBuilding(30, 30, 12, 12, 3.2, P.teal, 'E');
  stairBuilding(30, -30, 12, 12, 3.6, P.tan, 'N');
  stairBuilding(-30, 30, 12, 12, 3.6, P.blue, 'S');

  // Mid-edge blocks (solid, taller — 3 storeys) with balconies over the alleys.
  building(0, -34, 16, 9, 5.6, P.yellow, { balconyFace: 'S' });
  building(0, 34, 16, 9, 5.6, P.pink, { balconyFace: 'N' });
  building(-34, 0, 9, 16, 5.2, P.teal, { balconyFace: 'E' });
  building(34, 0, 9, 16, 5.2, P.tan, { balconyFace: 'W' });

  // Inner ring blocks framing the plaza + tight alleys (2 storey).
  building(-14, -13, 8, 8, 4.2, P.blue, { balconyFace: 'E' });
  building(14, 13, 8, 8, 4.2, P.yellow, { balconyFace: 'W' });
  building(14, -13, 7, 7, 3.8, P.pink);
  building(-14, 13, 7, 7, 3.8, P.tan);

  // -- MARKET AWNINGS/TARPS (decor, strung above alleys — non-collidable) ------
  function awning(cx, cz, w, d, y) {
    // striped tarp: alternate two colors in strips along w
    const strips = Math.max(2, Math.floor(w / 0.8));
    for (let i = 0; i < strips; i++) {
      const ox = (i - (strips - 1) / 2) * (w / strips);
      addBox(w / strips, 0.06, d, cx + ox, y, cz, i % 2 ? P.awning : P.awningB, { collide: false });
    }
    // posts (thin, decorative — do NOT collide so they don't clutter alleys)
    addBox(0.1, y, 0.1, cx - w / 2, 0, cz - d / 2, P.trunk, { collide: false });
    addBox(0.1, y, 0.1, cx + w / 2, 0, cz + d / 2, P.trunk, { collide: false });
  }
  awning(-7, -22, 5, 3, 2.9);
  awning(8, 20, 5, 3, 2.9);
  awning(20, -6, 3, 5, 2.9);
  awning(-20, 7, 3, 5, 2.9);

  // -- PALM TREES (trunk collides; fronds don't) -------------------------------
  function palm(cx, cz) {
    const th = 4.2 + rnd() * 1.4;
    addBox(0.4, th, 0.4, cx, 0, cz, P.trunk);              // trunk (collides, body-height)
    // fronds: a few angled slabs radiating from the top (decor)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, -0.7]]) {
      addBox(2.4, 0.12, 0.6, cx + dx * 1.0, th - 0.1, cz + dz * 1.0, P.frond, { collide: false });
    }
    addBox(0.7, 0.5, 0.7, cx, th, cz, P.frond, { collide: false }); // crown
  }
  for (const [px, pz] of [[-8, 6], [8, -6], [-6, -8], [6, 8], [-22, -22], [22, 22], [22, -22], [-22, 22]]) {
    palm(px, pz);
  }

  // -- CRATES + BARRELS (low cover, body-height, collide) ----------------------
  const coverSpots = [
    [-6, 0], [6, 2], [3, -6], [-3, 6], [-18, -3], [18, 3],
    [-3, -20], [3, 20], [20, -14], [-20, 14], [-40, -8], [40, 8],
    [-8, -40], [8, 40], [-24, 0], [24, 0], [0, -24], [0, 24],
  ];
  for (const [x, z] of coverSpots) {
    if (rnd() < 0.55) {
      // crate stack
      addBox(1.1, 1.0, 1.1, x, 0, z, P.crate);
      if (rnd() < 0.4) addBox(0.9, 0.8, 0.9, x + 0.4, 1.0, z - 0.3, P.crate);
    } else {
      // barrel cluster
      addBox(0.8, 1.1, 0.8, x, 0, z, P.barrel);
      addBox(0.8, 1.1, 0.8, x + 0.9, 0, z + 0.3, P.barrel, { collide: true });
    }
  }

  // -- GRAFFITI accents (thin decals on perimeter wall — decor) ----------------
  for (let i = 0; i < 6; i++) {
    const along = (rnd() * 2 - 1) * (HALF - 8);
    if (i % 2) addBox(3.0, 1.6, 0.05, along, 1.2, -HALF + 0.55, P.graffiti, { collide: false });
    else addBox(0.05, 1.6, 3.0, -HALF + 0.55, 1.2, along, P.graffiti, { collide: false });
  }

  // -- SATELLITE DISHES on rooftops (decor) ------------------------------------
  for (let i = 0; i < roofAnchors.length; i += 2) {
    const a = roofAnchors[i];
    addBox(0.9, 0.15, 0.9, a.x + 1.0, a.y, a.z + 1.0, P.dish, { collide: false });
    addBox(0.1, 0.8, 0.1, a.x + 1.0, a.y, a.z + 1.0, P.dish, { collide: false });
  }

  // -- POWER LINES between rooftops (thin, decorative, non-collidable) ---------
  // Author a few authored spans so they look intentional (kour "strung wires").
  const wireSpans = [
    [-30, -30, 0, -34], [0, 34, 30, 30], [-34, 0, -14, -13], [34, 0, 14, 13],
    [0, -34, 14, -13], [-14, 13, 0, 34],
  ];
  for (const [x1, z1, x2, z2] of wireSpans) {
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const cx = (x1 + x2) / 2, cz = (z1 + z2) / 2;
    // a single thin box spanning the two roofs at ~4 m; visual approximation
    const g0 = new THREE.BoxGeometry(len, 0.05, 0.05);
    g0.rotateY(-Math.atan2(dz, dx));
    g0.translate(cx, 4.2, cz);
    if (!buckets.has(P.wire)) buckets.set(P.wire, []);
    buckets.get(P.wire).push(g0);
  }

  // -- merge static buckets (one material per color) ---------------------------
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

  // -- LIGHTING (bright Havana midday): one hemi + one shadow sun -------------
  const hemi = new THREE.HemisphereLight(0xffffff, 0x9a8f6a, 2.2);
  group.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff4dc, 2.8);
  sun.position.set(50, 90, 30);
  if (PERF.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
    sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
    sun.shadow.camera.near = 5; sun.shadow.camera.far = 200;
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.06;
  }
  group.add(sun);

  // -- NAV: authored street lattice avoiding building footprints + roof chains -
  const nodes = [];
  const lattice = new Map();
  const STEP = 6;
  // building footprints to skip (half-extents inflated a touch for clearance)
  const foot = [
    [-30, -30, 6, 6], [30, 30, 6, 6], [30, -30, 6, 6], [-30, 30, 6, 6],
    [0, -34, 8, 4.5], [0, 34, 8, 4.5], [-34, 0, 4.5, 8], [34, 0, 4.5, 8],
    [-14, -13, 4, 4], [14, 13, 4, 4], [14, -13, 3.5, 3.5], [-14, 13, 3.5, 3.5],
    [0, 0, 2, 2], // fountain
  ];
  const inFoot = (x, z) => {
    for (const [fx, fz, hw, hd] of foot) {
      if (Math.abs(x - fx) < hw + 1.2 && Math.abs(z - fz) < hd + 1.2) return true;
    }
    return false;
  };
  for (let gx = -7; gx <= 7; gx++) {
    for (let gz = -7; gz <= 7; gz++) {
      const x = gx * STEP, z = gz * STEP;
      if (Math.abs(x) > HALF - 3 || Math.abs(z) > HALF - 3) continue;
      if (inFoot(x, z)) continue;
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
  // add diagonal links to keep the lattice connected around building gaps
  for (const [key, idx] of lattice) {
    const [gx, gz] = key.split(',').map(Number);
    for (const [dx, dz] of [[1, 1], [1, -1]]) {
      const nb = lattice.get(`${gx + dx},${gz + dz}`);
      if (nb !== undefined) { nodes[idx].links.push(nb); nodes[nb].links.push(idx); }
    }
  }
  const base = nodes.length;
  // roof chains: foot → mid → roof, foot tied to nearest lattice node
  for (const rn of roofNodes) {
    const fi = nodes.length; nodes.push({ x: rn.foot.x, y: 0, z: rn.foot.z, links: [] });
    const mi = nodes.length; nodes.push({ x: rn.mid.x, y: rn.mid.y, z: rn.mid.z, links: [] });
    const ri = nodes.length; nodes.push({ x: rn.roof.x, y: rn.roof.y, z: rn.roof.z, links: [] });
    nodes[fi].links.push(mi); nodes[mi].links.push(fi);
    nodes[mi].links.push(ri); nodes[ri].links.push(mi);
    let best = -1, bd = 1e9;
    for (const [, idx] of lattice) {
      const dx = nodes[idx].x - rn.foot.x, dz = nodes[idx].z - rn.foot.z;
      const dd = dx * dx + dz * dz;
      if (dd < bd) { bd = dd; best = idx; }
    }
    if (best >= 0) { nodes[fi].links.push(best); nodes[best].links.push(fi); }
  }
  if (import.meta.env.DEV) {
    const seen = new Uint8Array(nodes.length);
    const q = [0]; seen[0] = 1; let reach = 1;
    while (q.length) { const c = q.pop(); for (const nb of nodes[c].links) if (!seen[nb]) { seen[nb] = 1; reach++; q.push(nb); } }
    if (reach !== nodes.length) console.warn(`[havana] NAV connectivity ${reach}/${nodes.length}`);
    else console.info(`[havana] nav OK: ${nodes.length} nodes (street ${base} + roofs ${nodes.length - base}), 1 component`);
  }

  // -- SPAWNS: opposite ends of the plaza axis (teams start apart) -------------
  const YAW_N = 0, YAW_S = Math.PI;
  const seSpawns = [
    { pos: new THREE.Vector3(-6, 0, -42), yaw: YAW_S },
    { pos: new THREE.Vector3(0, 0, -42), yaw: YAW_S },
    { pos: new THREE.Vector3(6, 0, -42), yaw: YAW_S },
    { pos: new THREE.Vector3(-12, 0, -40), yaw: YAW_S },
    { pos: new THREE.Vector3(12, 0, -40), yaw: YAW_S },
  ];
  const bugSpawns = seSpawns.map((s) => ({ pos: new THREE.Vector3(-s.pos.x, 0, -s.pos.z), yaw: YAW_N }));

  return {
    group,
    colliders,
    spawnPoint: seSpawns[0].pos.clone(),
    name: 'havana',
    seSpawns,
    bugSpawns,
    waypointNodes: nodes,
    ropes,
    background: new THREE.Color(0x67b6e8), // bright blue sky
    fog: new THREE.Fog(0x9fd0f0, 55, 180),  // warm-haze visibility for a compact town
    update: null, // no animated geometry (awnings are steady)
  };
}
