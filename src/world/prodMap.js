// ============================================================================
// "Prod" — the real map (Phase 4). A low-poly data-center arena, ~40 × 28 m,
// MIRROR-SYMMETRIC across X=0 (every SE-side box has a Bug-side twin at (−x, z))
// so the two teams get identical routes to both lanes — the actual team-fairness
// goal. (Deliberate call: the brief said "180°-rotational", but a literal 180°
// rotation maps north→south, which would force A-lane and B-corridor to be the
// same shape — contradicting the brief's OWN "A-lane long/open, B-corridor
// tight/dogleg" requirement. An X-mirror delivers fairness AND distinct lanes;
// it's the standard competitive-map approach. See addSym below.) All play is at
// floor y=0: bots are FLOOR-LOCKED (bots.js — they cannot jump or climb), so
// there are NO raised walk areas, NO stairs/ramps. A few 0.5/1.0 m crates exist
// purely for the PLAYER to hop for an angle; none is ever a required route (a bot
// must always have a floor path everywhere — the DEV self-check's BFS proves it).
//
// This module extends the world/testRoom.js interface (buildTestRoom's shape)
// with the match's spawn + navigation data, so main.js can hand a map straight
// to Match + makeGraph:
//   { group, colliders, spawnPoint, name:'prod',
//     seSpawns:[{pos,yaw}], bugSpawns:[{pos,yaw}],   // yaw faces toward mid/exits
//     waypointNodes:[{x,z,links}],                    // → makeGraph(...)
//     background:THREE.Color, fog:THREE.Fog }         // the map OWNS its palette
//
// AXES (fixed for the whole file): X = WEST(−)/EAST(+), Z = NORTH(−)/SOUTH(+).
//   WEST  = SE spawn "Dev Bay"        EAST = Bug spawn "Legacy Wing"
//   NORTH = A-lane (the long rifle lane, longest sightline ≥26 m — falloff land)
//   SOUTH = B-corridor "the hotpath" (tight, dogleg, sightline <10 m — pistol/knife)
// YAW convention (camera.js): forward flattened to XZ = (−sin(yaw),0,−cos(yaw)).
//   yaw 0 → −Z (north)   yaw +π/2 → −X (west)   yaw −π/2 → +X (east)   yaw π → +Z (south)
//   SE face mid (east) ⇒ yaw −π/2.   Bugs face mid (west) ⇒ yaw +π/2.
//
// Map-authoring rules honored (build-plan §9 group D):
//   D2  every static box ≥ 0.5 m thick.
//   D6  no gap authored in (0, playerWidth+0.1); doorways ≥ 1.2 m (jump apex is
//        1.1 m — nothing 1.0-or-less separates areas that shouldn't connect; a
//        1.0 m crate IS hoppable and is placed only where hopping is a bonus).
//   D8  openings ≥ height+0.1 (walk-throughs are full 4 m height — no lintels).
//   D5  spawn points clear of geometry (dev self-check asserts ≥0.6 m).
//   D9  sealed 4 m perimeter; the kill-floor Y assert stays pure insurance.
//   I6  static geometry MERGED by color into a handful of meshes via
//        mergeGeometries (draw calls ≈ 1 per color group + grid + 2 lights, well
//        under the ≤150 budget). Colliders stay the per-box AABB list —
//        collision and rendering are decoupled. matrixAutoUpdate=false; one hemi
//        + one shadow-casting sun (the testRoom static-bake pattern).
//
// A DEV-only self-check runs at build via the SHARED, y-aware runMapSelfCheck
// (world/mapChecks.js — reused by Prod + the v1.2 Shoots map): BFS connectivity,
// spawn clearance + floor-support at each spawn's own y, per-link LOS at the
// link's eye height, and a link-slope cap (K5/K8/K9). console.warn on any
// failure — cheap authoring insurance, zero cost in prod (guarded + tree-shaken).
// ============================================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PERF } from '../config.js';
import { makeSignTexture, makeGradientTexture, makeSignMesh } from './decor.js';
import { runMapSelfCheck } from './mapChecks.js'; // shared DEV self-check (K8/K9) — reused by every map

// -- Palette. Extends the testRoom COLORS discipline; keeps the Phase-1 flat
//    NoToneMapping look. SE half accents teal, Bug half accents orange; A-lane a
//    cool strip, B-corridor warm. Orientation is readable at a glance (§ brief).
//
// READABILITY LIFT (release polish): Prod read darker than the test room in a
// side-by-side — its floor/wall were darker AND its fog (deeper, longer-range on
// a bigger arena) muddied them further. Lifted to be COMPARABLE to the test room
// (testRoom floor 0x49536a / wall 0x6a7590, hemi 1.6 / sun 2.4) while keeping the
// data-center mood (cooler than the gym) and the teal/orange team coding. Only
// values changed — geometry untouched. Floor/wall pushed a touch ABOVE the gym's
// to counteract Prod's heavier fog; the rack (a big dark surface) nudged up so it
// still reads as cover against the now-lighter floor.
const PALETTE = {
  floor:     0x505b73,  // slate data-center floor (was 0x424c63 — lifted above the gym's 0x49536a to beat Prod's fog)
  wall:      0x6d7994,  // neutral perimeter + interior wall (was 0x59647e — now ~gym's 0x6a7590)
  rack:      0x3d5c88,  // mid server-rack (was 0x33507a — nudged up to read against the lighter floor)
  crate:     0x939db3,  // neutral hop crate (was 0x8a94ab — slight lift to match)
  seAccent:  0x37b39a,  // SE half trim (was 0x2f9c86 — teal, HUD.seColor family)
  bugAccent: 0xdf7631,  // Bug half trim (was 0xd06a2c — orange)
  laneCool:  0x7cbcd4,  // A-lane cool light strip (north)
  laneWarm:  0xdda65c,  // B-corridor warm strip (south)
};

// LED strip tints (server-rack detail). Emissive materials driven by the shared
// map.update(dt) pulse (one material per color, not per-LED — § brief).
const LED_TEAL = 0x37e0c2;
const LED_AMBER = 0xffcf6a;

// Arena extents (interior play area). ~40 (X) × 28 (Z); walls 4 m tall.
const HALF_X = 20;   // interior spans X ∈ [−20, 20]  (40 m)
const HALF_Z = 14;   // interior spans Z ∈ [−14, 14]  (28 m)
const WALL_H = 4;    // perimeter + interior wall height (D8: full-height openings)
const WALL_T = 0.6;  // wall thickness (D2: ≥ 0.5)
const RACK_H = 2.2;  // server-rack height (blocks a standing sightline)

// Key interior planes + gaps (single source; the geometry AND the reasoning in
// comments both read from these). All gaps are ≥1.6 m (well over D6's 0.9 floor;
// the widest — the center spawn door — is 3.0 m). Nothing separating two areas
// is ≤1.0 m, so a 1.0 m hop crate can never accidentally bridge a wall (D6).
const INNER_X = 13;             // spawn-room inner wall plane (SE −13, Bug +13)
const A_DIV_Z = -7.0;           // A-lane↔mid divider plane (north)
const B_DIV_Z = 11.0;           // B-corridor↔mid inner wall plane (south) — inner
                                //   (south) face at 11.3 ⇒ a ~2.7 m corridor to the
                                //   z=14 perimeter, wide enough for a real dogleg
                                //   with ≥1.2 m pass-channels (D6).
// Spawn-room door gaps (in Z, on the x=±INNER_X wall). Each door opens straight
// INTO its target lane band: N door into the A-lane band (z<−7), S door into the
// B-corridor band (z>11.5), C door into mid. Same z on both sides (X-mirror).
const DOOR_N = [-12.8, -11.2];  // north door → A-lane band     (1.6 m)
const DOOR_C = [-1.5, 1.5];     // center door → mid            (3.0 m)
const DOOR_S = [11.2, 13.2];    // south door → B-corridor band (2.0 m; sized so the
                                //   diagonal spawn→door link threads it cleanly)
// Lane-divider connector gaps (in X): flank rotations mid↔lane at x≈±7.
const CONN_SE = [-9.0, -5.0];   // SE-flank connector (4 m)
const CONN_BUG = [5.0, 9.0];    // Bug-flank connector (4 m)

export function buildProdMap() {
  const group = new THREE.Group();
  const colliders = [];

  // Per-color geometry buckets. Each addBox() pushes a translated BoxGeometry
  // into its color bucket (NOT a Mesh) so we can mergeGeometries per color at the
  // end → one draw call per material (I6). Colliders are pushed separately, so
  // rendering and collision stay decoupled.
  const buckets = new Map(); // colorHex → BufferGeometry[]

  // (w,h,d) box whose BASE sits at y=base (matches how the player thinks — the
  // testRoom convention). Adds geometry to the merge bucket + an AABB collider.
  // `collide=false` → visual only. Decoration ONLY (trim strips): the FLOOR must
  // always be a collider — the controller's ground contact IS the floor AABB's
  // Y-clamp; a visual-only floor drops the player through the world (D9 fired
  // exactly this way in the Phase-4 gate — don't repeat it).
  function addBox(w, h, d, x, base, z, color, { collide = true } = {}) {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(x, base + h / 2, z); // bake the world position into the geometry (merge-ready)
    if (!buckets.has(color)) buckets.set(color, []);
    buckets.get(color).push(geo);
    if (collide) {
      colliders.push({
        min: new THREE.Vector3(x - w / 2, base, z - d / 2),
        max: new THREE.Vector3(x + w / 2, base + h, z + d / 2),
      });
    }
  }

  // TEAM-MIRROR helper: place a box AND its WEST↔EAST twin at (−x, z) — a mirror
  // across the X=0 plane (Z unchanged). Used for everything that must be
  // equivalent for both teams. `color` may be a single hex (both twins same) or
  // {se,bug} to accent each half.
  //
  // WHY X-MIRROR, NOT A LITERAL 180° ROTATION (a deliberate, documented call):
  // the brief asks for BOTH "team fairness via symmetry" AND two DISTINCT lanes —
  // A-lane (north) long & open, B-corridor (south) tight with a dogleg. A literal
  // 180° rotation maps north→south, which would force A-lane and B-corridor to be
  // the SAME shape — directly contradicting the distinct-lanes requirement. An
  // X-mirror (SE west ↔ Bug east) is what actually delivers the FAIRNESS goal:
  // both teams get identical routes to A-lane and to B-corridor, mirror-equal in
  // every timing. It's the standard competitive-map approach (bilateral, not
  // rotational). So SE↔Bug is a perfect mirror; A-lane ≠ B-corridor by design.
  function addSym(w, h, d, x, base, z, color, opts) {
    const se = typeof color === 'object' ? color.se : color;
    const bug = typeof color === 'object' ? color.bug : color;
    addBox(w, h, d, x, base, z, se, opts);         // SE side (west, as authored)
    addBox(w, h, d, -x, base, z, bug, opts);       // Bug twin (east, X-mirrored)
  }

  // ==========================================================================
  // FLOOR + SEALED PERIMETER (D9). Floor top at y=0. Perimeter walls 4 m tall,
  // 0.6 thick, centered just inside the extents so their INNER face is the play
  // boundary. Corners overlap by the wall thickness (D3 — prefer overlap to
  // abutting seams).
  // ==========================================================================
  addBox(HALF_X * 2 + 2, 0.5, HALF_Z * 2 + 2, 0, -0.5, 0, PALETTE.floor); // COLLIDABLE — ground contact lives here
  // North + south perimeter (run the full width). North wall gets the A-lane cool
  // trim; south gets B-corridor warm — a glance at the far wall tells you the lane.
  addBox(HALF_X * 2 + WALL_T, WALL_H, WALL_T, 0, 0, -HALF_Z - WALL_T / 2, PALETTE.wall); // north
  addBox(HALF_X * 2 + WALL_T, WALL_H, WALL_T, 0, 0,  HALF_Z + WALL_T / 2, PALETTE.wall); // south
  // East + west perimeter (run the full depth).
  addBox(WALL_T, WALL_H, HALF_Z * 2 + WALL_T, -HALF_X - WALL_T / 2, 0, 0, PALETTE.wall); // west (SE back)
  addBox(WALL_T, WALL_H, HALF_Z * 2 + WALL_T,  HALF_X + WALL_T / 2, 0, 0, PALETTE.wall); // east (Bug back)

  // Thin colored trim strips on the far (north/south) walls — orientation reading
  // (§ brief: A-lane cool, B-corridor warm). Visual only (collide:false — they sit
  // flush on the wall face and must not create a phantom collider ledge).
  addBox(HALF_X * 2, 0.3, 0.12, 0, 2.6, -HALF_Z + 0.12, PALETTE.laneCool, { collide: false }); // north strip
  addBox(HALF_X * 2, 0.3, 0.12, 0, 2.6,  HALF_Z - 0.12, PALETTE.laneWarm, { collide: false }); // south strip

  // ==========================================================================
  // SPAWN ROOMS — "Dev Bay" (WEST, SE) and its X-mirror "Legacy Wing" (EAST,
  // Bug). Each ~7 (X) × 28 (Z, the back band). A back-set inner wall at x=±13
  // separates the room from the field, pierced by THREE full-height doorways
  // (D8, walk-throughs are the full 4 m): NORTH → A-lane, CENTER → mid, SOUTH →
  // B-corridor. Spawncamping one door must fail (§ brief) — three exits guarantee
  // it. Built as WALL SEGMENTS between the gaps (per-box collider list). The
  // segment list is the inner wall MINUS the three door gaps.
  // ==========================================================================
  // Inner wall at x=−INNER_X (SE); addSym mirrors each segment to +INNER_X (Bug).
  // Segment helper: a Z-run of inner wall. Gaps left at DOOR_N / DOOR_C / DOOR_S.
  const innerSeg = (z0, z1) => addSym(WALL_T, WALL_H, z1 - z0, -INNER_X, 0, (z0 + z1) / 2, PALETTE.wall);
  innerSeg(-HALF_Z, DOOR_N[0]);   // north corner → north door
  innerSeg(DOOR_N[1], DOOR_C[0]); // north door → center door
  innerSeg(DOOR_C[1], DOOR_S[0]); // center door → south door
  innerSeg(DOOR_S[1], HALF_Z);    // south door → south corner

  // Spawn-room interior nub — a short fin against the back wall so the bay reads
  // as a ROOM and gives a sliver of in-spawn cover. Tucked into the deep SW
  // corner (a wall-hugging fin), clear of every spawn point + door + spawn↔hub
  // link. Accented per team. ≥0.5 thick (D2).
  addSym(0.6, WALL_H, 3.0, -18.4, 0, 11.0, { se: PALETTE.seAccent, bug: PALETTE.bugAccent });

  // ==========================================================================
  // MID — the central server-rack cluster. TWO parallel rack rows near X=0,
  // OFFSET in Z so crossing mid N↔S must break TWO staggered sightlines (the
  // §-brief chicane). Each rack ~3.6 long (Z) × 0.6 thick (X) × 2.2 tall — a
  // vertical wall you go around. Deliberately SHORT enough to leave a clear
  // horizontal channel through z=0 (so mid W↔center↔E is walkable), and set well
  // inside the flank connectors (x≈±7) so mid↔lane rotations stay open. Point-
  // symmetric as a pair. Plus 0.5/1.0 crates for player-hop angles (a bonus peek,
  // never a required route — bots path around on the floor).
  //
  //   rack A at x=−2.5, Z ∈ [−5.0,−1.4]  (north-west of center)
  //   rack B at x=+2.5, Z ∈ [ 1.4, 5.0]  (south-east — the offset)
  //   z=0 band is clear → the mid cross-channel; the two racks stagger the
  //   long N↔S lines so you can't hold both halves from one spot.
  // ==========================================================================
  addBox(0.6, RACK_H, 3.6, -2.5, 0, -3.2, PALETTE.rack); // rack A (Z −5.0..−1.4)
  addBox(0.6, RACK_H, 3.6,  2.5, 0,  3.2, PALETTE.rack); // rack B (Z 1.4..5.0), offset

  // Player-hop crates in mid (1.0 m — clears under the 1.1 m apex; a bonus peek,
  // never a route). Symmetric pair, tucked beside a rack so a bot's floor path
  // (down the open channels + connectors) never needs them.
  addSym(1.0, 1.0, 1.0, -4.6, 0, -3.4, PALETTE.crate);
  // A lower 0.5 m step-crate pair for a crouchless quick-peek up onto the line.
  addSym(1.0, 0.5, 1.0, 4.6, 0, 3.4, PALETTE.crate);

  // ==========================================================================
  // A-LANE (NORTH) — the long rifle lane. The band Z ∈ [−14, −7] between the
  // north perimeter and the A-divider (z=−7). This holds the map's LONGEST
  // sightline (spawn-exit to spawn-exit ≈ 28 m) — the rifle/falloff lane. The
  // divider separates it from mid, pierced by the two FLANK connector gaps
  // (CONN_SE / CONN_BUG at x≈±7) so mid↔A rotations exist at the halfway points.
  // Third-point cover keeps it from being a pure sniper alley without closing the
  // long line.
  //
  // Divider segments at z=−7 (leaving CONN_SE and CONN_BUG open):
  //   X ∈ [−13,−9]  | gap CONN_SE [−9,−5] | X ∈ [−5,5] | gap CONN_BUG [5,9] | X ∈ [9,13]
  // ==========================================================================
  const aSeg = (x0, x1) => addBox(x1 - x0, WALL_H, WALL_T, (x0 + x1) / 2, 0, A_DIV_Z, PALETTE.wall);
  aSeg(-INNER_X, CONN_SE[0]);   // SE end segment
  aSeg(CONN_SE[1], CONN_BUG[0]); // center segment (spans the origin)
  aSeg(CONN_BUG[1], INNER_X);   // Bug end segment

  // A-lane third-point cover: a rack block on each third (mirrored), breaking the
  // 28 m line into fightable segments. Set at the lane third x≈−4.3, z=−10.2 —
  // NORTH of mid, SOUTH of the lane node line (z=−11.5) so links ALONG the lane
  // skim past its front, and CLEAR of the flank connector x≈−7 so mid↔A rotations
  // stay open. It DOES stand on the center sightline (that's the point).
  addSym(2.2, RACK_H, 0.6, -4.3, 0, -10.2, PALETTE.rack); // rack cover, SE third
  // A hop crate in each lane's deep far corner (bonus high peek onto the long
  // line). Tucked into the NW corner, clear of the north door mouth (z≈−9.2).
  addSym(1.0, 1.0, 1.0, -12.4, 0, -13.0, PALETTE.crate);

  // A-lane cool accent strip low on the divider center segment — "you're in A".
  addBox(9.4, 0.25, 0.1, 0, 0.9, A_DIV_Z - WALL_T / 2 - 0.06, PALETTE.laneCool, { collide: false });

  // ==========================================================================
  // B-CORRIDOR (SOUTH) — "the hotpath". The band Z ∈ [~11.3, 14], a ~2.7 m
  // service corridor hugging the south wall, with a DOGLEG mid-way so NO sightline
  // runs its length (max < 10 m — pistol/knife territory). Formed by the inner
  // wall at z=11.0 (with the two flank connector gaps, mirroring A) plus an OFFSET
  // dogleg pair that forces an S-bend.
  //
  // Inner-wall segments at z=11.0 (same X gaps as A's divider — symmetric flanks):
  //   X ∈ [−13,−9] | gap [−9,−5] | X ∈ [−5,5] | gap [5,9] | X ∈ [9,13]
  // ==========================================================================
  const bInnerFace = B_DIV_Z + WALL_T / 2; // south face of the B-inner wall (≈11.3)
  const bPerimFace = HALF_Z;               // north face of the south perimeter (z=14.0)
  const bSeg = (x0, x1) => addBox(x1 - x0, WALL_H, WALL_T, (x0 + x1) / 2, 0, B_DIV_Z, PALETTE.wall);
  bSeg(-INNER_X, CONN_SE[0]);
  bSeg(CONN_SE[1], CONN_BUG[0]);
  bSeg(CONN_BUG[1], INNER_X);

  // DOGLEG (offset S-bend, POINT-symmetric — the one place a 180° pair is right:
  // a dogleg must OFFSET to break a sightline while staying walkable, which an
  // X-mirror pinch can't do). A stub from the NORTH (inner) wall poking south,
  // west of center; and a stub from the SOUTH (perimeter) wall poking north, east
  // of center. Each is ~1.5 m deep into the ~2.7 m corridor, leaving a ≥1.2 m pass
  // channel on its open side (D6), and their Z-ranges OVERLAP (≈12.5..12.8) so no
  // straight line threads both (LOS broken). Fair: SE (west) weaves south-then-
  // north; Bug (east) weaves north-then-south — one weave each, mirror-equal.
  const WEST_STUB_S = 12.8; // west stub (from north wall) reaches this far south
  const EAST_STUB_N = 12.5; // east stub (from south wall) reaches this far north
  addBox(0.6, WALL_H, WEST_STUB_S - bInnerFace, -2.2, 0, (bInnerFace + WEST_STUB_S) / 2, PALETTE.seAccent);  // player passes SOUTH of it
  addBox(0.6, WALL_H, bPerimFace - EAST_STUB_N,  2.2, 0, (EAST_STUB_N + bPerimFace) / 2, PALETTE.bugAccent); // player passes NORTH of it

  // B-corridor warm accent strip low on the inner-wall center segment.
  addBox(9.4, 0.25, 0.1, 0, 0.9, bInnerFace + 0.06, PALETTE.laneWarm, { collide: false });

  // ==========================================================================
  // SET-DRESSING (v1.1 MAPS pass — ALL VISUAL, collide:false or baked INTO an
  // existing collider footprint; nav/spawns/sightlines are FROZEN, verified
  // byte-identical). Three parts:
  //   1) animated server-rack LED strips (blink via map.update — shared mats)
  //   2) CanvasTexture signage on wall faces + floor lane markings
  //   3) overhead cable-tray run + a background gradient plane
  // ==========================================================================

  // --- 1) SERVER-RACK LED DETAIL ------------------------------------------
  // Thin emissive strips on the rack faces, INSIDE each rack's collider
  // footprint (racks are 0.6 thick in one axis; strips sit ~0.31 off-center so
  // they hug the face without adding collision — decoration only). TWO shared
  // emissive materials (teal / amber) whose intensity map.update() pulses — so
  // the whole rack farm blinks at ~2 draw calls, zero per-frame allocation.
  const ledTealMat = new THREE.MeshBasicMaterial({ color: LED_TEAL, toneMapped: false });
  const ledAmberMat = new THREE.MeshBasicMaterial({ color: LED_AMBER, toneMapped: false });
  const ledTealGeos = [];
  const ledAmberGeos = [];
  // A thin LED quad on a rack's ±X face (racks in mid + A-lane are 0.6 thick in
  // X). x = rack center; faceSign picks which face; strips run vertically in Z.
  function ledStrip(geoList, x, z, faceSign, y, len) {
    const g = new THREE.BoxGeometry(0.02, 0.06, len);
    g.translate(x + faceSign * 0.31, y, z); // 0.31 = just proud of the 0.30 half-thickness face
    geoList.push(g);
  }
  function ledDots(geoList, x, z, faceSign, ys) {
    for (let i = 0; i < ys.length; i++) {
      const g = new THREE.BoxGeometry(0.04, 0.05, 0.05);
      g.translate(x + faceSign * 0.31, ys[i], z);
      geoList.push(g);
    }
  }
  // Mid racks (x=∓2.5). Vertical strip up each inner face + a column of status dots.
  ledStrip(ledTealGeos, -2.5, -3.2, +1, 1.1, 3.2); // rack A inner (east) face — teal
  ledDots(ledTealGeos, -2.5, -3.2, +1, [0.5, 0.9, 1.3, 1.7]);
  ledStrip(ledAmberGeos, 2.5, 3.2, -1, 1.1, 3.2);  // rack B inner (west) face — amber
  ledDots(ledAmberGeos, 2.5, 3.2, -1, [0.5, 0.9, 1.3, 1.7]);
  // A-lane third-point cover racks (x=∓4.3, thin in Z=0.6). Strips on their south
  // face (toward mid) run in X. addSym'd geometry, so dress both twins.
  function ledStripX(geoList, x, z, faceSign, y, len) {
    const g = new THREE.BoxGeometry(len, 0.06, 0.02);
    g.translate(x, y, z + faceSign * 0.31);
    geoList.push(g);
  }
  ledStripX(ledTealGeos, -4.3, -10.2, +1, 1.6, 1.8);  // SE A-cover, south face — teal
  ledStripX(ledAmberGeos, 4.3, -10.2, +1, 1.6, 1.8);  // Bug A-cover, south face — amber

  // --- 2a) SIGNAGE (CanvasTexture wall signs, flush on wall faces) ----------
  // Spawn-door banners over the inner walls, lane markers at the lane mouths, and
  // a big PROD on the north wall. All are flat planes offset 0.01 off the face —
  // non-colliding (makeSignMesh never registers a collider). Kept in a small
  // list so we can add them to the group after the merge (signs use their own
  // MeshBasicMaterial + CanvasTexture, so they're NOT part of the color merge).
  const signs = [];
  const addSign = (tex, w, h, x, y, z, rotY) => {
    const m = makeSignMesh(tex, w, h);
    m.position.set(x, y, z);
    if (rotY) m.rotation.y = rotY;
    m.updateMatrix();
    signs.push(m);
  };
  // "DEV BAY" (teal) over the SE center door, facing east into the field.
  addSign(makeSignTexture('DEV BAY', '#4fe0c6'), 3.2, 0.8, -INNER_X + 0.31, 3.1, 0, -Math.PI / 2);
  // "LEGACY WING" (orange) over the Bug center door, facing west.
  addSign(makeSignTexture('LEGACY WING', '#ff9a4d'), 3.6, 0.8, INNER_X - 0.31, 3.1, 0, Math.PI / 2);
  // Big "PROD" on the north perimeter wall (cool), facing south into the arena.
  addSign(makeSignTexture('PROD', '#9fd6e8', { w: 512, h: 160 }), 7.0, 2.2, 0, 3.0, -HALF_Z + 0.32, 0);
  // Lane markers "A" (cool, north) / "B" (warm, south) at the center divider gap.
  addSign(makeSignTexture('A', '#7cbcd4', { w: 128, h: 128 }), 0.9, 0.9, 0, 3.4, A_DIV_Z - 0.32, Math.PI);
  addSign(makeSignTexture('B', '#dda65c', { w: 128, h: 128 }), 0.9, 0.9, 0, 3.4, bInnerFace + 0.02, 0);

  // --- 2b) FLOOR LANE MARKINGS (painted quads on the floor, y≈0.02) ---------
  // Non-colliding (thin, flat) — a cool centerline tracing the A-lane, a warm one
  // for B, and hazard-stripe pads at the mid flank connectors. Baked as painted
  // quads into their own tiny color buckets via addBox(collide:false).
  addBox(20, 0.01, 0.5, 0, 0.02, -11.5, PALETTE.laneCool, { collide: false }); // A-lane centerline
  addBox(20, 0.01, 0.5, 0, 0.02, 12.6, PALETTE.laneWarm, { collide: false });  // B-corridor centerline
  // Hazard pads at the four flank-connector mouths (x≈±7, z=±7).
  const hazard = 0xdcb23a;
  addSym(3.0, 0.01, 1.2, -7.0, 0.015, -7.0, hazard, { collide: false }); // A connectors
  addSym(3.0, 0.01, 1.2, -7.0, 0.015, 7.0, hazard, { collide: false });  // B connectors

  // --- 3) OVERHEAD + BACKDROP ---------------------------------------------
  // Sparse cable-tray/pipe run above mid — ≥3 m up (walk clearance is untouched;
  // nothing walkable passes under 2.4 m of it), non-colliding, visual depth. Two
  // long trays spanning X over mid at y=3.2, plus a couple of cross pipes.
  const tray = 0x2b3446;
  addBox(24, 0.18, 0.35, 0, 3.2, -2.5, tray, { collide: false });
  addBox(24, 0.18, 0.35, 0, 3.2, 2.5, tray, { collide: false });
  addBox(0.3, 0.14, 8, -6, 3.15, 0, tray, { collide: false });
  addBox(0.3, 0.14, 8, 6, 3.15, 0, tray, { collide: false });

  // Subtle vertical background gradient plane behind the far (north) wall so the
  // void above the walls reads intentional (§ brief). A big backdrop plane, well
  // outside play, non-colliding, unlit (MeshBasic). One draw call.
  const gradTex = makeGradientTexture('#243247', '#12192a');
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 40),
    new THREE.MeshBasicMaterial({ map: gradTex, depthWrite: false, fog: false, toneMapped: false }),
  );
  backdrop.position.set(0, 12, -HALF_Z - 8);
  backdrop.matrixAutoUpdate = false;
  backdrop.updateMatrix();
  group.add(backdrop);

  // --- 4) WALL PANEL DETAILING (thin trim on wall faces) ------------------
  // Inset/outset trim strips baked flush onto the perimeter wall INNER faces so
  // the big flat walls read as paneled server-hall surfaces. All proud of the
  // face by ~0.04 m (never intruding into walk space) and collide:false. Two
  // shades (a darker recessed groove + a lighter raised rib) for depth. Runs are
  // horizontal bands at two heights along N/S/E/W inner faces.
  const trimDark = 0x2f3647;   // recessed groove (darker than wall 0x6d7994)
  const trimLite = 0x828ea8;   // raised rib (lighter than wall)
  // Inner-face planes: north inner face z=−HALF_Z+ (wall centered at −HALF_Z−T/2,
  // inner face ≈ −HALF_Z). We sit trim at z=−HALF_Z+0.04 etc.
  const NF = -HALF_Z + 0.04, SF = HALF_Z - 0.04, WF = -HALF_X + 0.04, EF = HALF_X - 0.04;
  // Horizontal bands on N & S walls (full width), two heights.
  for (const [y, col] of [[1.3, trimDark], [2.7, trimLite]]) {
    addBox(HALF_X * 2 - 1, 0.12, 0.03, 0, y, NF, col, { collide: false });
    addBox(HALF_X * 2 - 1, 0.12, 0.03, 0, y, SF, col, { collide: false });
  }
  // Horizontal bands on E & W back walls (full depth), two heights.
  for (const [y, col] of [[1.3, trimDark], [2.7, trimLite]]) {
    addBox(0.03, 0.12, HALF_Z * 2 - 1, WF, y, 0, col, { collide: false });
    addBox(0.03, 0.12, HALF_Z * 2 - 1, EF, y, 0, col, { collide: false });
  }
  // Vertical pilaster ribs on the back walls (evenly spaced) — structural rhythm.
  for (let z = -10; z <= 10; z += 5) {
    addBox(0.04, WALL_H - 0.6, 0.18, WF, 0, z, trimLite, { collide: false });
    addBox(0.04, WALL_H - 0.6, 0.18, EF, 0, z, trimLite, { collide: false });
  }

  // --- 5) PERIMETER VENT GLOW (a 3rd — animated — LED group) --------------
  // Emissive vent slots low on the N/S perimeter inner faces, a cool cyan that
  // slowly breathes via a SEPARATE shared material (the 3rd animated group, at
  // the ≤3 budget). Reads as HVAC/airflow in the data hall. collide:false.
  const ventMat = new THREE.MeshBasicMaterial({ color: 0x2c8fb0, toneMapped: false });
  const ventGeos = [];
  const vent = (x, z) => {
    const g = new THREE.BoxGeometry(0.9, 0.12, 0.03);
    g.translate(x, 0.55, z);
    ventGeos.push(g);
  };
  for (let x = -16; x <= 16; x += 4) { vent(x, NF); vent(x, SF); }

  // --- 6) CEILING-EDGE ACCENT STRIPS --------------------------------------
  // A continuous cool strip running the top perimeter edge (y≈WALL_H−0.15) — a
  // static emissive rim so the ceiling line reads. Its own tiny bucket color
  // (not animated; steady glow). collide:false.
  const rim = 0x4a6f86;
  addBox(HALF_X * 2, 0.1, 0.06, 0, WALL_H - 0.15, NF, rim, { collide: false });
  addBox(HALF_X * 2, 0.1, 0.06, 0, WALL_H - 0.15, SF, rim, { collide: false });
  addBox(0.06, 0.1, HALF_Z * 2, WF, WALL_H - 0.15, 0, rim, { collide: false });
  addBox(0.06, 0.1, HALF_Z * 2, EF, WALL_H - 0.15, 0, rim, { collide: false });

  // --- 7) DEV BAY / LEGACY WING INTERIOR CLUTTER (non-colliding) ----------
  // Desk + monitor blocks giving each spawn room lived-in character. STRICT
  // safety: every prop is collide:false (bullets/movement pass through — Prod
  // gameplay is byte-identical), sits ≥0.6 m clear of all 4 team spawns, and
  // never occupies a doorway. Placed against the back/side walls of the bay.
  // addSym mirrors each into Legacy Wing (Bug side) with the team accent swapped.
  // SE spawns (avoid): (−17,−9.5) (−18.5,−2) (−17.5,6) (−15.5,−4.5). Doors at
  // x=−13. All desks live at x≤−18.2 (deep against the west wall) or the far
  // corners, well clear.
  const deskTop = 0x394253;   // dark desk surface
  const deskLeg = 0x2b3240;   // desk frame
  const monitor = 0x11161f;   // monitor bezel (near-black)
  const monGlow = { se: 0x2f9c86, bug: 0xd06a2c }; // screen glow (team-tinted)
  // A desk unit: top slab + a front rail + a small monitor block + a glowing
  // screen quad, authored on the SE side and X-mirrored. `z` is the desk center;
  // desks hug the west wall (x≈−19.3) facing east into the room.
  const monGlowSeGeos = [];
  const monGlowBugGeos = [];
  function deskUnit(z) {
    const dx = -19.2;
    addSym(1.4, 0.06, 0.7, dx, 0.95, z, deskTop, { collide: false }); // desk top slab (y≈0.98)
    addSym(0.06, 0.95, 0.6, dx - 0.6, 0, z, deskLeg, { collide: false }); // back leg panel
    addSym(0.06, 0.95, 0.6, dx + 0.6, 0, z, deskLeg, { collide: false }); // front leg panel
    addSym(0.5, 0.34, 0.05, dx, 1.04, z, monitor, { collide: false });    // monitor bezel on the desk
    // Screen glow quad (team-tinted, its own emissive bucket) — proud of the bezel.
    const gSe = new THREE.BoxGeometry(0.42, 0.26, 0.02); gSe.translate(dx + 0.04, 1.04, z); monGlowSeGeos.push(gSe);
    const gBug = new THREE.BoxGeometry(0.42, 0.26, 0.02); gBug.translate(-(dx + 0.04), 1.04, z); monGlowBugGeos.push(gBug);
  }
  // Three desks along the west wall at z clear of every spawn (nearest spawn is
  // −9.5; these sit at −12.5, 0.5, 9.0 — all ≥1.6 m from any spawn, none near a
  // door, all at x≈−19.2 hard against the back wall).
  deskUnit(-12.5);
  deskUnit(0.5);
  deskUnit(9.0);
  // A couple of floor-standing tower/crate clutter blocks in the deep corners
  // (never on a spawn or a spawn↔door line; collide:false so paths are frozen).
  addSym(0.5, 1.2, 0.5, -19.4, 0, -13.0, deskLeg, { collide: false }); // NW corner tower
  addSym(0.5, 0.8, 0.5, -19.4, 0, 3.5, deskLeg, { collide: false });   // mid-wall tower

  // --- 8) HANGING CABLE BUNDLES (thin drops from the overhead trays) ------
  // A few slack cable bundles dropping from the mid cable-trays — thin vertical
  // boxes hung high (top at the tray y=3.2, dropping ~1 m, so their bottom is
  // ≥2.0 m — well above head height; nothing walkable is affected). collide:false.
  const cable = 0x1d2430;
  for (const [x, z] of [[-4, -2.5], [3, 2.5], [7, -2.5], [-7, 2.5]]) {
    addBox(0.06, 1.0, 0.06, x, 2.2, z, cable, { collide: false });
  }

  // ==========================================================================
  // MERGE static geometry per color → one mesh per material (I6). Colliders are
  // already collected above (per-box), so this is purely the render side. Each
  // merged mesh is static: matrixAutoUpdate off, shadows per PERF.
  // ==========================================================================
  for (const [color, geos] of buckets) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    const mat = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = PERF.shadows;
    mesh.receiveShadow = PERF.shadows;
    mesh.matrixAutoUpdate = false; // static world (I5)
    mesh.updateMatrix();
    group.add(mesh);
    // Free the per-box source geometries we merged (the merged buffer owns its
    // own data now). Skip when we passed the single geo straight through.
    if (geos.length > 1) for (let i = 0; i < geos.length; i++) geos[i].dispose();
  }

  // Motion-perception grid (low-poly floors need visual frequency to read speed
  // against — same reasoning as the testRoom). Covers the whole floor; one draw
  // call; static.
  const grid = new THREE.GridHelper(HALF_X * 2, HALF_X * 2, 0x8f9ab4, 0x515c76);
  grid.position.y = 0.02;
  grid.scale.z = HALF_Z / HALF_X; // stretch the square grid to the rectangular floor
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  grid.matrixAutoUpdate = false;
  grid.updateMatrix();
  group.add(grid);

  // LED meshes — one merged mesh per shared emissive material (≤2 draw calls).
  // Kept referenced so map.update(dt) can pulse the material colors (blink).
  const ledMeshes = [];
  if (ledTealGeos.length) {
    const mesh = new THREE.Mesh(mergeGeometries(ledTealGeos, false), ledTealMat);
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    for (const g of ledTealGeos) g.dispose();
    group.add(mesh); ledMeshes.push(mesh);
  }
  if (ledAmberGeos.length) {
    const mesh = new THREE.Mesh(mergeGeometries(ledAmberGeos, false), ledAmberMat);
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    for (const g of ledAmberGeos) g.dispose();
    group.add(mesh); ledMeshes.push(mesh);
  }
  // Perimeter vent glow — the 3rd animated group (breathes in update()).
  if (ventGeos.length) {
    const mesh = new THREE.Mesh(mergeGeometries(ventGeos, false), ventMat);
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    for (const g of ventGeos) g.dispose();
    group.add(mesh);
  }
  // Monitor screen glows — STEADY emissive (not animated), one merged mesh per
  // team tint. Their own MeshBasic materials (emissive look under NoToneMapping).
  if (monGlowSeGeos.length) {
    const mesh = new THREE.Mesh(mergeGeometries(monGlowSeGeos, false),
      new THREE.MeshBasicMaterial({ color: monGlow.se, toneMapped: false }));
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    for (const g of monGlowSeGeos) g.dispose();
    group.add(mesh);
  }
  if (monGlowBugGeos.length) {
    const mesh = new THREE.Mesh(mergeGeometries(monGlowBugGeos, false),
      new THREE.MeshBasicMaterial({ color: monGlow.bug, toneMapped: false }));
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    for (const g of monGlowBugGeos) g.dispose();
    group.add(mesh);
  }

  // Signs (CanvasTexture planes on wall faces) — their own materials, added last.
  for (let i = 0; i < signs.length; i++) group.add(signs[i]);

  // Lighting: flat + honest — hemisphere fill + ONE shadow-casting sun (≤1, I3).
  // READABILITY LIFT (release polish): raised above the test room's 1.6/2.4 to
  // counteract Prod's heavier fog + bigger volume so the arena reads as clearly as
  // the gym (§ brief). Still one shadow-casting sun; mood stays cool/data-center.
  // Shadow frustum widened to cover the bigger arena.
  const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x69645b, 2.0); // was 1.6
  group.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff4e0, 2.9); // was 2.4
  sun.position.set(18, 26, 12);
  if (PERF.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); // bigger arena → a touch more shadow res
    sun.shadow.camera.left = -HALF_X - 2;
    sun.shadow.camera.right = HALF_X + 2;
    sun.shadow.camera.top = HALF_Z + 2;
    sun.shadow.camera.bottom = -HALF_Z - 2;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 70;
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.05;
  }
  group.add(sun);

  // ==========================================================================
  // SPAWNS — 4 per team (§ brief), each with a FACING yaw toward its exits/mid.
  // SE in Dev Bay (west, x≈−16..−18), facing east (yaw −π/2). Bugs are the exact
  // X-mirror in Legacy Wing (east), facing west (yaw +π/2). Spread across the
  // room's north/center/south so a single doorway camp can't cover all four
  // (they naturally feed different exits). Feet positions (y=0). The player's
  // initial spawn = the first SE spawn.
  // ==========================================================================
  const YAW_EAST = -Math.PI / 2; // SE face mid (+X)
  const YAW_WEST = Math.PI / 2;  // Bug face mid (−X)

  // Author the SE spawns; X-MIRROR each for the Bug side (−x, same z → identical
  // timings to every lane). The bay is x ∈ [−20,−13]; spawns sit at x≈−16..−18,
  // spread N/C/S so no single door camp covers them, all clear of the SW nub
  // (x≈−18.4, z 9.5..12.5) and the walls.
  const seSpawnDefs = [
    { x: -17.0, z: -9.5 }, // N of the bay — feeds the north (A-lane) door
    { x: -18.5, z: -2.0 }, // center-back — feeds the mid door
    { x: -17.5, z:  6.0 }, // S of the bay — feeds the south (B-corridor) door
    { x: -15.5, z: -4.5 }, // forward-north — quickest to A / mid
  ];
  const seSpawns = [];
  const bugSpawns = [];
  for (let i = 0; i < seSpawnDefs.length; i++) {
    const s = seSpawnDefs[i];
    seSpawns.push({ pos: new THREE.Vector3(s.x, 0, s.z), yaw: YAW_EAST });
    // Bug twin: X-mirror the position (−x, same z); face the opposite way.
    bugSpawns.push({ pos: new THREE.Vector3(-s.x, 0, s.z), yaw: YAW_WEST });
  }

  // ==========================================================================
  // WAYPOINT GRAPH — 33 nodes covering both spawn rooms, both lanes, mid, and the
  // flank connectors (full index map + coordinates in buildWaypoints() below,
  // the authoritative source). Bots are floor-locked; every node is a floor
  // point with ≥ ~0.6 m clearance and every link is a straight floor segment
  // clear of walls — the DEV self-check proves both (BFS reachability + per-link
  // rayBlocked + spawn clearance). Links are bidirectional (author both ends).
  // X-mirror symmetric (SE↔Bug) so both teams path identically.
  // ==========================================================================
  const waypointNodes = buildWaypoints();

  const background = new THREE.Color(0x1c2433);            // deep data-center blue
  // Fog: far plane MUST clear the 28 m A-lane sightline (fog can't hide a
  // sightline the game is balanced around, § brief). Start 34 m, full 120 m — the
  // whole arena's longest diagonal (~48 m) stays visible; fog only softens the
  // sealed far walls. (testRoom used 30→90; this map is bigger.)
  const fog = new THREE.Fog(0x1c2433, 34, 120);

  // Blink hook: pulse the two shared LED emissive materials in soft-antiphase so
  // the rack farm reads "alive". Zero-alloc, no setTimeout — ticks on game dt
  // (B6); main.js calls map.update(dt) per frame (guarded). ~zero cost: two
  // scalar sin() + two color .setScalar-style writes on cached base colors.
  let _ledPhase = 0;
  const _tealBase = new THREE.Color(LED_TEAL);
  const _amberBase = new THREE.Color(LED_AMBER);
  const _ventBase = new THREE.Color(0x2c8fb0);
  function update(dt) {
    _ledPhase += dt;
    // Two rack-LED blink rates, antiphased — a busy-server flicker; plus a slow
    // vent "breathe" — all off cached base colors, zero per-frame allocation.
    const tealK = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(_ledPhase * 3.1));
    const amberK = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(_ledPhase * 2.3 + 1.7));
    const ventK = 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(_ledPhase * 0.9)); // slow HVAC breathe
    ledTealMat.color.copy(_tealBase).multiplyScalar(tealK);
    ledAmberMat.color.copy(_amberBase).multiplyScalar(amberK);
    ventMat.color.copy(_ventBase).multiplyScalar(ventK);
  }

  const built = {
    group,
    colliders,
    spawnPoint: seSpawns[0].pos.clone(), // player's initial = first SE spawn
    name: 'prod',
    seSpawns,
    bugSpawns,
    waypointNodes,
    background,
    fog,
    update, // visual LED blink; main.js calls it per frame (see main.js guard)
  };

  // DEV authoring insurance — never runs in prod (tree-shaken by the guard).
  // Now the SHARED, y-aware check (mapChecks.js) so Prod + Shoots stay in sync.
  if (import.meta.env.DEV) {
    runMapSelfCheck(built);
  }

  return built;
}

// ---------------------------------------------------------------------------
// Waypoint node definitions. Kept in its own function so the literal doesn't
// bloat buildProdMap's body. POINT-SYMMETRIC by construction (node i and its
// mirror are placed as pairs), links bidirectional (author both ends — the
// self-check flags asymmetry). Each node { x, z, links:[indices] }. 34 nodes.
//
// Index map (X→right; Z north=−, south=+):
//   Dev Bay (SE, west):     0(back-N) 1(back-C) 2(back-S) 3(forward-C)
//   SE door feeders:        4(A door) 5(mid door) 6(B door)
//   A-lane (north):         7(SE mouth) 8(SE third) 9(center) 10(Bug third) 11(Bug mouth)
//   Mid:                    12(SE side) 13(center) 14(Bug side) 15(mid-N hub) 16(mid-S hub)
//   B-corridor (south):     17(SE mouth) 18(SE third) 19(center) 20(Bug third) 21(Bug mouth)
//   Bug door feeders:       22(A door) 23(mid door) 24(B door)
//   Legacy Wing (Bug,east): 25(back-N) 26(back-C) 27(back-S) 28(forward-C)   [mirror of 0..3]
//   Connectors:             29(A↔mid SE) 30(A↔mid Bug) 31(B↔mid SE) 32(B↔mid Bug) 33(mid cross)
// ---------------------------------------------------------------------------
function buildWaypoints() {
  return [
    // -- Dev Bay (SE, west) : 0..3.  Door links thread the gap ~perpendicular
    //    (0→4 N, 1→5 C, 2→6 S) so a link never clips a wall segment beside a gap.
    { x: -17.0, z: -9.5, links: [3, 4] },              // 0  SE spawn back-north  → N door
    { x: -18.5, z: -2.0, links: [3, 5] },              // 1  SE spawn back-center → C door
    { x: -17.5, z:  9.0, links: [3, 6] },              // 2  SE spawn back-south  → S door
    { x: -15.5, z: -4.5, links: [0, 1, 2] },           // 3  SE room hub (ties the bay together)
    // -- SE door field-side nodes : 4(N→A) 5(C→mid) 6(S→B) --
    { x: -12.2, z: -12.0, links: [0, 7] },             // 4  through N door → A-lane band
    { x: -12.0, z:  0.0, links: [1, 12] },             // 5  through center door → mid approach
    { x: -12.2, z:  12.4, links: [2, 17] },            // 6  through S door → B-corridor band
    // -- A-lane (north), west→east along Z=−11.5 : 7..11. Connects to mid ONLY
    //    via the flank connectors 29/30 (the divider center segment is solid).
    { x: -11.0, z: -11.5, links: [4, 8] },             // 7  A SE mouth
    { x:  -7.0, z: -11.5, links: [7, 9, 29] },         // 8  A SE third (flank-connector mouth)
    { x:   0.0, z: -11.5, links: [8, 10] },            // 9  A center (past the cover line)
    { x:   7.0, z: -11.5, links: [9, 11, 30] },        // 10 A Bug third (flank-connector mouth)
    { x:  11.0, z: -11.5, links: [10, 22] },           // 11 A Bug mouth
    // -- Mid : 12(W hub) 13(center) 14(E hub) via the clear z=0 channel; 15/16
    //    are north/south mid waypoints hanging off center (13). Racks block any
    //    hub→cross link, so the cross channel is strictly W↔center↔E along z=0.
    { x:  -4.5, z:  0.0, links: [5, 13, 29, 31] },     // 12 mid W hub (west of rack A)
    { x:   0.0, z:  0.0, links: [12, 14, 15, 16] },    // 13 mid center (clear z=0 channel)
    { x:   4.5, z:  0.0, links: [13, 23, 30, 32] },    // 14 mid E hub (east of rack B)
    { x:   0.0, z: -6.5, links: [13] },                // 15 mid-north waypoint (north of both racks)
    { x:   0.0, z:  6.5, links: [13] },                // 16 mid-south waypoint (south of both racks)
    // -- B-corridor (south), west→east along Z≈12.6 : 17..21 + the dogleg weave
    //    (19 south-of-west-stub, 33 north-of-east-stub). The path S-bends through
    //    the central gap between the two offset stubs; connects to mid ONLY via
    //    the flank connectors 31/32.
    { x: -11.0, z:  12.6, links: [6, 18] },            // 17 B SE mouth
    { x:  -7.0, z:  12.6, links: [17, 19, 31] },       // 18 B SE third (flank-connector mouth)
    { x:  -1.2, z:  13.3, links: [18, 33] },           // 19 B center-south (south channel, past west stub)
    { x:   7.0, z:  12.6, links: [33, 21, 32] },       // 20 B Bug third (flank-connector mouth)
    { x:  11.0, z:  12.6, links: [20, 24] },           // 21 B Bug mouth
    // -- Bug door field-side nodes : 22(N→A) 23(C→mid) 24(S→B)  [X-mirror of 4,5,6] --
    { x:  12.2, z: -12.0, links: [11, 25] },           // 22 through Bug N door → A-lane band
    { x:  12.0, z:  0.0, links: [14, 26] },            // 23 through Bug center door → mid
    { x:  12.2, z:  12.4, links: [21, 27] },           // 24 through Bug S door → B-corridor band
    // -- Legacy Wing (Bug, east) : 25..28  [X-mirror of 0,1,2,3] --
    { x:  17.0, z: -9.5, links: [22, 28] },            // 25 Bug spawn back-north  (mirror of 0)
    { x:  18.5, z: -2.0, links: [23, 28] },            // 26 Bug spawn back-center (mirror of 1)
    { x:  17.5, z:  9.0, links: [24, 28] },            // 27 Bug spawn back-south  (mirror of 2)
    { x:  15.5, z: -4.5, links: [25, 26, 27] },        // 28 Bug room hub          (mirror of 3)
    // -- Flank connectors (mid↔lane at x≈±7) : 29..32  [29/31 SE, 30/32 Bug] --
    { x:  -7.0, z:  -7.0, links: [8, 12] },            // 29 A↔mid connector, SE flank (gap x−9..−5)
    { x:   7.0, z:  -7.0, links: [10, 14] },           // 30 A↔mid connector, Bug flank (gap x5..9)
    { x:  -7.0, z:   7.0, links: [18, 12] },           // 31 B↔mid connector, SE flank
    { x:   7.0, z:   7.0, links: [20, 14] },           // 32 B↔mid connector, Bug flank
    // -- B-corridor dogleg weave node : 33 (north channel, before the east stub) --
    { x:   1.2, z:  11.9, links: [19, 20] },           // 33 B center-north (S-bend link 19↔20)
  ];
}
