// ============================================================================
// The Phase 1 test room. Not "Prod" — a feel gym: jump-height crates (0.5 /
// 1.0 / 1.5 chain), a 1.0 m slide gap (D6-compliant: > playerWidth + 0.1),
// an L-corner for wall-slide testing, and a 2.2 m lintel for head bumps (C7).
// Map rules honored: walls ≥ 0.5 m thick (D2), no gaps narrower than the
// player (D6), sealed perimeter (D9 kill floor is pure insurance).
// Every mesh is static: matrixAutoUpdate off (I5), shadows baked once (I3).
//
// Phase 4: buildTestRoom() now returns the SAME extended shape as prodMap
// (spawns + waypoint nodes + palette), so main.js treats maps uniformly and the
// dev ?room=test path (feel gym + ?bots=0 practice) keeps working exactly as
// before. The test-room team spawns (formerly hard-coded inside match.js) live
// here now, each carrying a facing yaw (SE face −z ⇒ yaw 0; Bug face +z ⇒ yaw π).
// ============================================================================

import * as THREE from 'three';
import { PERF } from '../config.js';
import { TEST_ROOM_NODES } from './waypoints.js';

const COLORS = {
  floor: 0x49536a,
  wall: 0x6a7590,
  wallAccent: 0x3fb89e,
  crate: 0xe8913f,
  crateAlt: 0xe3c04f,
  pillar: 0x7d88a0,
  block: 0x4fc0a8,
};

export function buildTestRoom() {
  const group = new THREE.Group();
  const colliders = [];

  // (w, h, d) box whose BASE sits at y = base — matches how the player thinks
  function addBox(w, h, d, x, base, z, color, { cast = true } = {}) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, base + h / 2, z);
    mesh.castShadow = cast && PERF.shadows;
    mesh.receiveShadow = PERF.shadows;
    mesh.matrixAutoUpdate = false; // static world (I5)
    mesh.updateMatrix();
    group.add(mesh);
    colliders.push({
      min: new THREE.Vector3(x - w / 2, base, z - d / 2),
      max: new THREE.Vector3(x + w / 2, base + h, z + d / 2),
    });
    return mesh;
  }

  // Floor (top at y = 0) and a sealed 4 m perimeter — jump apex is 1.1 m,
  // nobody is hopping out of the room.
  addBox(25, 0.5, 25, 0, -0.5, 0, COLORS.floor, { cast: false });
  addBox(25, 4, 0.5, 0, 0, -12.25, COLORS.wallAccent); // north — the accent wall, for orientation
  addBox(25, 4, 0.5, 0, 0, 12.25, COLORS.wall);
  addBox(0.5, 4, 24, 12.25, 0, 0, COLORS.wall);
  addBox(0.5, 4, 24, -12.25, 0, 0, COLORS.wall);

  // Jump chain: 0.5 → 1.0 → 1.5 (the 1.0 tests the tuned apex, the 1.5 needs the chain)
  addBox(1.4, 0.5, 1.4, 5, 0, 0, COLORS.crate);
  addBox(1.4, 1.0, 1.4, 5, 0, -1.8, COLORS.crateAlt);
  addBox(1.4, 1.5, 1.4, 5, 0, -3.6, COLORS.crate);

  // Slide gap: two pillars, 1.0 m clear between inner faces (player is 0.8 wide)
  addBox(0.6, 3, 0.6, -4.0, 0, -3, COLORS.pillar);
  addBox(0.6, 3, 0.6, -5.6, 0, -3, COLORS.pillar);

  // Lintel arch: 2.2 m clearance — walk under fine, jump under bumps your head (C7)
  addBox(0.5, 2.2, 0.5, -2, 0, 4, COLORS.pillar);
  addBox(0.5, 2.2, 0.5, 0, 0, 4, COLORS.pillar);
  addBox(3.0, 0.5, 0.9, -1, 2.2, 4, COLORS.pillar);

  // L-corner (wall-slide test) — the two slabs overlap at the joint (D3)
  addBox(4, 2, 0.4, 7, 0, 6, COLORS.block);
  addBox(0.4, 2, 4, 8.8, 0, 7.9, COLORS.block);

  // A fat mid block for circling around
  addBox(2, 1.2, 2, -6, 0, 5, COLORS.crateAlt);

  // Motion-perception grid — low-poly rooms need SOME visual frequency to
  // read your own speed against
  const grid = new THREE.GridHelper(24, 24, 0xaab3c8, 0x5f6a83);
  grid.position.y = 0.02;
  grid.material.transparent = true;
  grid.material.opacity = 0.45;
  grid.matrixAutoUpdate = false;
  grid.updateMatrix();
  group.add(grid);

  // Flat, honest light: hemisphere fill + one shadow-casting sun (≤ 1, per I3)
  const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x6a655c, 1.6);
  group.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
  sun.position.set(14, 20, 10);
  if (PERF.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -16;
    sun.shadow.camera.right = 16;
    sun.shadow.camera.top = 16;
    sun.shadow.camera.bottom = -16;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 50;
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.05; // kills acne on glancing-angle faces

  }
  group.add(sun);

  // Team spawns for the test room (formerly hard-coded in match.js). SE near
  // z=+9 facing −z (yaw 0, into the room); Bug near z=−9 facing +z (yaw π). 4
  // each, clear of the feel-gym obstacles. Player's initial = first SE spawn.
  const YAW_SE = 0;         // camera forward (−sin,·,−cos) at yaw 0 → (0,0,−1) = −z
  const YAW_BUG = Math.PI;  // → (0,0,+1) = +z
  const seSpawns = [
    { pos: new THREE.Vector3(-2.0, 0, 10.5), yaw: YAW_SE },
    { pos: new THREE.Vector3(2.0, 0, 10.5), yaw: YAW_SE },
    { pos: new THREE.Vector3(-8.0, 0, 10.0), yaw: YAW_SE },
    { pos: new THREE.Vector3(8.5, 0, 10.5), yaw: YAW_SE },
    { pos: new THREE.Vector3(0.0, 0, 8.0), yaw: YAW_SE },
  ];
  const bugSpawns = [
    { pos: new THREE.Vector3(-2.0, 0, -10.5), yaw: YAW_BUG },
    { pos: new THREE.Vector3(2.0, 0, -10.5), yaw: YAW_BUG },
    { pos: new THREE.Vector3(-8.0, 0, -10.0), yaw: YAW_BUG },
    { pos: new THREE.Vector3(8.5, 0, -10.5), yaw: YAW_BUG },
    { pos: new THREE.Vector3(0.0, 0, -8.0), yaw: YAW_BUG },
  ];

  return {
    group,
    colliders,
    spawnPoint: seSpawns[0].pos.clone(), // player's initial = first SE spawn (was (0,0,9))
    name: 'test',
    seSpawns,
    bugSpawns,
    waypointNodes: TEST_ROOM_NODES, // the hand-authored test-room graph (waypoints.js)
    // The test room owns its palette too (parity with prodMap); these are the
    // exact values main.js used before, so the feel gym looks unchanged.
    background: new THREE.Color(0x222b3d),
    fog: new THREE.Fog(0x222b3d, 30, 90),
  };
}
