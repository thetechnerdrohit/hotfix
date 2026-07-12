// ============================================================================
// server/sim/worldLoader.js — the ONE canonical server-side map load. Returns
// exactly the shape match.js + the PlayerController need, sourced from the SAME
// client map builder the browser uses, so the authoritative world is
// byte-identical to what every client renders.
//
// Strategy (approach (a), per the netcode brief): install the DOM stub, then
// import the UNMODIFIED src/world/battleMap.js via the loader shim
// (server/loader.mjs handles three/addons + JSON + import.meta.env). We build
// the map, then STRIP the THREE rendering objects (group/meshes/materials) —
// the server keeps only the collider AABBs, waypoint nodes, spawns, ropes, and
// gate list. Collider {min,max} are THREE.Vector3 already (Vector3 math is
// Node-safe), which is exactly what hitscan/controller/match consume.
//
// Why not hand-mirror battleMap's geometry? Because that ~290-line builder
// (compound carve + berm + camps + trees + field nav lattice + gate bridges)
// would drift the instant the world engineer edits it. Importing it directly is
// zero-duplication and self-verifying (assertCounts below fails loudly if the
// map ever stops producing a well-formed world).
// ============================================================================

import { installDomStub } from './domStub.js';

installDomStub(); // MUST run before importing any src/world or src/game module

// Dynamic import so the DOM stub is guaranteed installed first.
const { buildBattleMap } = await import('../../src/world/battleMap.js');
const { makeGraph } = await import('../../src/world/waypoints.js');

/**
 * Build the authoritative battle world once.
 * @returns {{
 *   colliders: Array<{min:THREE.Vector3, max:THREE.Vector3}>,
 *   graph: object,                 // WaypointGraph (waypoints.js)
 *   waypointNodes: Array,          // raw node defs (for asserts/debug)
 *   seSpawns: Array<{pos:THREE.Vector3, yaw:number}>,
 *   bugSpawns: Array<{pos:THREE.Vector3, yaw:number}>,
 *   ropes: Array,                  // client rope data (unused server-side; parity)
 *   gates: Array,
 *   name: string,
 * }}
 */
export function loadWorld() {
  const built = buildBattleMap();

  const world = {
    colliders: built.colliders,          // [{min:V3,max:V3}] — hitscan/controller ready
    graph: makeGraph(built.waypointNodes), // bots + match consume the graph
    waypointNodes: built.waypointNodes,
    seSpawns: built.seSpawns,            // [{pos:V3, yaw}]
    bugSpawns: built.bugSpawns,
    ropes: built.ropes,
    gates: built.gates || [],
    name: built.name || 'battle',
  };

  assertCounts(world);
  return world;
}

// Fail LOUD if the imported map ever regresses to a degenerate world — a broken
// nav graph or missing spawns would silently ruin every match otherwise.
function assertCounts(w) {
  const problems = [];
  if (!w.colliders || w.colliders.length < 50) problems.push(`colliders=${w.colliders?.length} (<50)`);
  if (!w.waypointNodes || w.waypointNodes.length < 100) problems.push(`nodes=${w.waypointNodes?.length} (<100)`);
  if (!w.seSpawns || w.seSpawns.length < 5) problems.push(`seSpawns=${w.seSpawns?.length} (<5)`);
  if (!w.bugSpawns || w.bugSpawns.length < 5) problems.push(`bugSpawns=${w.bugSpawns?.length} (<5)`);
  // spot-check a collider has real Vector3 min/max
  const c = w.colliders && w.colliders[0];
  if (!c || typeof c.min?.x !== 'number' || typeof c.max?.x !== 'number') problems.push('collider[0] not a V3 AABB');
  if (problems.length) {
    throw new Error('[worldLoader] map regression: ' + problems.join(', '));
  }
}
