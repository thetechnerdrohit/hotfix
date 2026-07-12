// ============================================================================
// "BATTLEGROUND" (v2.0) — the big one. Rohit's brief, verbatim: "like PUBG maps
// bro but in low poly and our squid-game theme, keep open spaces too, make it
// big, 4x of current" with "big trees, ropes, camping house — all interactive."
//
// Layout (~192 × 192 m, pastel palette):
//   • CENTER (v2.2): an OPEN VILLAGE — 8 enterable houses around a plaza,
//     each with a walkable exterior stair to a flat roof (bots path them);
//     low shoot-over cover; the wall-maze compound moved to DEV ?room=shoots.
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
// NAV: authored village street/roof nodes + a generated field lattice (8 m,
// skipping POI footprints), bridged at the village edge. DEV self-check
// asserts single-component connectivity.
//
// Map rules: hut walls 0.35 m thick (≥ the 0.23 m/frame max step at the dt
// clamp — no tunneling), doorways ≥ 1.4 (D6), roofs at 2.7 (jump apex can't
// accidentally mount them — rope-only), sealed outer berm (D9), zero
// per-frame allocation (update() delegates to the compound's).
// ============================================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PERF } from '../config.js';
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

  // -- v2.2 (Rohit): the wall-maze compound is OUT of the default map ("walls
  //    are very much — keep open spaces"). The center is now an OPEN VILLAGE:
  //    enterable houses with WALKABLE exterior stairs to flat roofs (0.35 m
  //    treads — native step-up, and authored as nav edges so bots contest the
  //    roofs), a plaza, and low cover. The verbatim compound lives on at
  //    DEV ?room=shoots.
  const colliders = [];
  const ropes = [];

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

  // -- OPEN VILLAGE CENTER (v2.2) ----------------------------------------------
  // 8 houses around a plaza. house(): enterable room (1.5 m doorway), flat roof,
  // and an EXTERIOR STAIR RUN (0.35 rise / 0.5 deep treads, 1.4 wide) up the
  // rear — players step-up it natively and bots path it (nav edges below).
  const villageRoofNodes = []; // {x,z,y} per roof + stair foot, for nav
  function house(cx, cz, w, d, h, stairSide /*'E'|'W'|'N'|'S'*/, color) {
    const T = 0.35;
    // walls: back + two sides + door face (1.5 m gap), door faces the plaza (toward 0,0)
    const doorToPlaza = Math.abs(cx) > Math.abs(cz) ? (cx > 0 ? 'W' : 'E') : (cz > 0 ? 'N' : 'S');
    const faces = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
    for (const f of ['N', 'S', 'E', 'W']) {
      const [fx, fz] = faces[f];
      const isDoor = f === doorToPlaza;
      const along = fx !== 0 ? d : w; // wall length axis
      if (!isDoor) {
        if (fx !== 0) addBox(T, h, d, cx + fx * (w / 2 - T / 2), 0, cz, color);
        else addBox(w, h, T, cx, 0, cz + fz * (d / 2 - T / 2), color);
      } else {
        const seg = (along - 1.5) / 2;
        if (fx !== 0) {
          addBox(T, h, seg, cx + fx * (w / 2 - T / 2), 0, cz - (1.5 / 2 + seg / 2), color);
          addBox(T, h, seg, cx + fx * (w / 2 - T / 2), 0, cz + (1.5 / 2 + seg / 2), color);
        } else {
          addBox(seg, h, T, cx - (1.5 / 2 + seg / 2), 0, cz + fz * (d / 2 - T / 2), color);
          addBox(seg, h, T, cx + (1.5 / 2 + seg / 2), 0, cz + fz * (d / 2 - T / 2), color);
        }
      }
    }
    addBox(w + 0.4, 0.25, d + 0.4, cx, h, cz, P.hutRoof); // roof slab (walkable top)
    // exterior stair: treads climbing along stairSide face up to the roof
    const [sx, sz] = faces[stairSide];
    const rise = 0.35, deep = 0.5, wTread = 1.4;
    const steps = Math.ceil((h + 0.25) / rise);
    for (let k = 1; k <= steps; k++) {
      const t = Math.min(h + 0.25, k * rise);
      // treads run parallel to the face, marching toward it from outside
      const off = (steps - k) * deep + (sx !== 0 ? w / 2 : d / 2) + deep / 2;
      const tx = cx + sx * off, tz = cz + sz * off;
      addBox(sx !== 0 ? deep : wTread, t, sx !== 0 ? wTread : deep, tx, 0, tz, P.stand);
    }
    const footOff = steps * deep + (sx !== 0 ? w / 2 : d / 2);
    villageRoofNodes.push({
      roof: { x: cx, z: cz, y: h + 0.25 },
      foot: { x: cx + sx * (footOff + 0.6), z: cz + sz * (footOff + 0.6), y: 0 },
      mid: { x: cx + sx * (footOff * 0.5 + (sx !== 0 ? w / 2 : d / 2) * 0.5), z: cz + sz * (footOff * 0.5 + (sx !== 0 ? w / 2 : d / 2) * 0.5), y: (h + 0.25) / 2 },
    });
  }
  // ring of 8 houses around a plaza (streets ≥6 m), varied sizes/heights
  house(-14, -10, 6, 5, 2.6, 'W', P.hutWall);
  house(14, 10, 6, 5, 2.6, 'E', P.hutWall);
  house(-13, 9, 5, 6, 3.0, 'S', 0xe697b8);
  house(13, -9, 5, 6, 3.0, 'N', 0xe697b8);
  house(0, -16, 7, 5, 2.6, 'N', 0xd985aa); // stairs on the REAR (door auto-faces plaza)
  house(0, 16, 7, 5, 2.6, 'S', 0xd985aa); // stairs on the REAR
  house(-22, 0, 5, 5, 3.4, 'W', 0xedadc6);
  house(22, 0, 5, 5, 3.4, 'E', 0xedadc6);
  // plaza centerpiece + low cover ring
  addBox(2.2, 1.2, 2.2, 0, 0, 0, P.hutTrim);          // the monument (yellow pop)
  addBox(3.2, 0.15, 3.2, 0, 1.2, 0, P.hutRoof, { collide: false });
  for (const [lx, lz, lw] of [[-7, -4, 3], [7, 4, 3], [-4, 7, 2.5], [4, -7, 2.5]]) {
    addBox(lw, 0.95, 0.4, lx, 0, lz, P.rock);          // shoot-over cover walls
  }

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
    for (const r of ropes) { // all ropes are ours now (no embedded compound)
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

  // -- LIGHTING (v2.2): the old rig lived inside the embedded compound's group;
  //    the village must own its own. One hemi + one shadow sun (I3), bounds
  //    sized to the whole field (2048 map for acceptable softness at ±100 m).
  const hemi = new THREE.HemisphereLight(0xfff2d6, 0x6a5f42, 2.1);
  group.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0cf, 3.0);
  sun.position.set(80, 120, 60);
  if (PERF.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -105; sun.shadow.camera.right = 105;
    sun.shadow.camera.top = 105; sun.shadow.camera.bottom = -105;
    sun.shadow.camera.near = 10; sun.shadow.camera.far = 300;
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.06;
  }
  group.add(sun);

  // -- NAV (v2.2): village street/roof nodes + field lattice, one graph ---------
  const nodes = [];
  // village: plaza + street ring + doorway-ish nodes
  const streetPts = [[0, -6], [0, 6], [-6, 0], [6, 0], [-14, -4], [14, 4], [-8, 12], [8, -12], [-18, 6], [18, -6], [0, -11], [0, 11], [-9, -9], [9, 9]];
  for (const [x, z] of streetPts) nodes.push({ x, y: 0, z, links: [] });
  // link street nodes within 9.5 m by clear LOS-ish adjacency (authored open plan)
  for (let i = 0; i < streetPts.length; i++) {
    for (let j = i + 1; j < streetPts.length; j++) {
      const dx = nodes[i].x - nodes[j].x, dz = nodes[i].z - nodes[j].z;
      if (dx * dx + dz * dz < 9.5 * 9.5) { nodes[i].links.push(j); nodes[j].links.push(i); }
    }
  }
  // roofs: foot → mid-stair → roof chains (bots climb with highGroundBias)
  for (const rn of villageRoofNodes) {
    const fi = nodes.length; nodes.push({ x: rn.foot.x, y: 0, z: rn.foot.z, links: [] });
    const mi = nodes.length; nodes.push({ x: rn.mid.x, y: rn.mid.y, z: rn.mid.z, links: [] });
    const ri = nodes.length; nodes.push({ x: rn.roof.x, y: rn.roof.y, z: rn.roof.z, links: [] });
    nodes[fi].links.push(mi); nodes[mi].links.push(fi);
    nodes[mi].links.push(ri); nodes[ri].links.push(mi);
    // tie the foot into the nearest street node
    let best = 0, bd = 1e9;
    for (let i = 0; i < streetPts.length; i++) {
      const dx = nodes[i].x - rn.foot.x, dz = nodes[i].z - rn.foot.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    nodes[fi].links.push(best); nodes[best].links.push(fi);
  }
  const base = nodes.length;
  const lattice = new Map();
  const STEP = 8;
  const inPoi = (x, z) => {
    if (Math.abs(x) < 30 && Math.abs(z) < 22) return true; // village core (streets carry it)
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      if (Math.abs(x - sx * 66) < 8 && Math.abs(z - sz * 66) < 8) return true;
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
  // bridge the village to the field: outer street nodes ↔ nearest lattice node
  for (const i of [4, 5, 8, 9, 10, 11]) {
    let best = -1, bd = 1e9;
    for (const [, idx] of lattice) {
      const dx = nodes[idx].x - nodes[i].x, dz = nodes[idx].z - nodes[i].z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = idx; }
    }
    if (best >= 0) { nodes[i].links.push(best); nodes[best].links.push(i); }
  }
  if (import.meta.env.DEV) {
    const seen = new Uint8Array(nodes.length);
    const q = [0]; seen[0] = 1; let reach = 1;
    while (q.length) { const c = q.pop(); for (const nb of nodes[c].links) if (!seen[nb]) { seen[nb] = 1; reach++; q.push(nb); } }
    if (reach !== nodes.length) console.warn(`[battle] NAV connectivity ${reach}/${nodes.length}`);
    else console.info(`[battle] nav OK: ${nodes.length} nodes (village ${base} + field ${nodes.length - base}), 1 component`);
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
    background: new THREE.Color(0xe8c9d7), // pale pink sky (pastel)
    fog: new THREE.Fog(0xe8c9d7, 70, 320), // big-field visibility
    update: null, // no animated groups in the village yet (lamps are steady)
  };
}
