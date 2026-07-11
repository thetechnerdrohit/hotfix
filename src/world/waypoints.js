// ============================================================================
// Waypoint graph tooling for bot navigation (Phase 3). No navmesh — a boxy
// arena is fine with a hand-authored node graph (build-plan Phase 3). This
// module is MAP-AGNOSTIC: makeGraph(nodes) builds the queryable graph, and the
// test-room graph below is just one author-time dataset. Phase 4 will hand the
// real "Prod" map's nodes to the SAME makeGraph — keep this file free of any
// test-room specifics beyond the exported TEST_ROOM_NODES constant.
//
// v1.2 (register group K): nodes gain an optional `y` (deck height) — links can
// now carry a slope, so bots climb stairs authored as graph edges. `y` defaults
// to 0, so every pre-v1.2 flat-map literal (y omitted) is byte-identical in
// behaviour. path()/BFS are unchanged (topology is height-agnostic).
//
// The graph exposes:
//   nodes:            [{ pos:THREE.Vector3(y from def, default 0), links:number[] }]
//   nearestNode(pos): closest node to a world pos (XZ + a small y tie-break, K6)
//   path(fromIdx, toIdx, outArray): BFS; fills outArray with the node-index
//                     chain [from … to] and returns its LENGTH (0 if no path /
//                     bad indices). PREALLOCATED visited/queue/parent scratch —
//                     zero allocations per call (I1); callers pass a reusable
//                     out array so the whole hot path stays alloc-free.
//
// Unweighted BFS is correct here: node spacing is roughly uniform, so fewest
// hops ≈ shortest path, and it's cheap enough to run per-bot on a stagger.
// ============================================================================

import * as THREE from 'three';

class WaypointGraph {
  constructor(nodeDefs) {
    // Build immutable node list. Each node: world pos (floor y=0) + neighbor
    // indices. We copy links into plain arrays so the input literal can be GC'd.
    this.nodes = new Array(nodeDefs.length);
    for (let i = 0; i < nodeDefs.length; i++) {
      const d = nodeDefs[i];
      // K6: nodes carry y (floor height of the deck this node sits on). Absent
      // ⇒ 0, so every existing flat map's literal (y omitted) is unchanged.
      this.nodes[i] = {
        pos: new THREE.Vector3(d.x, d.y ?? 0, d.z),
        links: d.links.slice(),
      };
    }

    // Preallocated BFS scratch — sized to the node count, reused every path().
    const n = this.nodes.length;
    this._visited = new Uint8Array(n);
    this._parent = new Int16Array(n);   // node count stays well under 32k
    this._queue = new Int16Array(n);    // ring-free FIFO: head/tail indices
    this._stamp = 1;                    // visited-generation stamp (avoids clearing the array)
    this._visitedGen = new Int32Array(n); // last stamp each node was visited on
  }

  // Nearest node to a world position, primarily by squared XZ distance, with a
  // small y-proximity TIE-BREAK (K6) so a stacked map (a node directly above
  // another on a higher deck) picks the one on the querier's own level. The
  // y term is weighted so it only ever separates near-equal XZ candidates — XZ
  // still dominates. Flat maps (all y=0) reduce to the old pure-XZ scan exactly.
  // Linear scan; node counts are tiny, so this stays cheap and alloc-free.
  nearestNode(pos) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const np = this.nodes[i].pos;
      const dx = np.x - pos.x;
      const dz = np.z - pos.z;
      const dy = np.y - pos.y;
      // XZ distance + a lightly-weighted y term (0.25×) → same-level bias without
      // letting height override a clearly-closer XZ node.
      const d = dx * dx + dz * dz + dy * dy * 0.25;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /**
   * BFS shortest hop-path from → to. Fills `out` with the node-index chain
   * (inclusive of both ends) and returns its length. Returns 0 (and leaves out
   * untouched) for out-of-range indices or when no path exists.
   *
   * Uses a per-call generation stamp instead of zeroing _visited, so there is
   * zero per-call allocation AND no O(n) clear — safe to call for every bot,
   * every repath tick.
   *
   * @param {number} from
   * @param {number} to
   * @param {Int16Array|number[]} out  preallocated (>= node count) — filled with indices
   * @returns {number} path length (node count); 0 if none
   */
  path(from, to, out) {
    const n = this.nodes.length;
    if (from < 0 || from >= n || to < 0 || to >= n) return 0;
    if (from === to) { out[0] = from; return 1; }

    const gen = this._stamp++;
    const q = this._queue;
    let head = 0;
    let tail = 0;

    this._visitedGen[from] = gen;
    this._parent[from] = -1;
    q[tail++] = from;

    let reached = false;
    while (head < tail) {
      const cur = q[head++];
      const links = this.nodes[cur].links;
      for (let i = 0; i < links.length; i++) {
        const nb = links[i];
        if (this._visitedGen[nb] === gen) continue;
        this._visitedGen[nb] = gen;
        this._parent[nb] = cur;
        if (nb === to) { reached = true; break; }
        q[tail++] = nb;
      }
      if (reached) break;
    }
    if (!reached) return 0;

    // Reconstruct the path by walking _parent back from `to`. BFS is DONE with
    // `q` now, so we safely reuse it from the front as scratch: write the chain
    // (reversed: to→…→from) into q[0..len), reading only _parent (never q) while
    // writing, then un-reverse into `out`. Zero-alloc, no aliasing hazard.
    let len = 0;
    let node = to;
    while (node !== -1) { q[len++] = node; node = this._parent[node]; } // reversed chain in q
    for (let i = 0; i < len; i++) out[i] = q[len - 1 - i];              // un-reverse into out
    return len;
  }
}

/**
 * Build a waypoint graph from node definitions. Map-agnostic entry point.
 * @param {Array<{x:number, z:number, links:number[]}>} nodes
 * @returns {WaypointGraph}
 */
export function makeGraph(nodes) {
  return new WaypointGraph(nodes);
}

// ---------------------------------------------------------------------------
// TEST-ROOM graph — authored against world/testRoom.js. The room is 25×25
// (walls at ±12.25, floor top y=0); nodes keep ≥ ~0.9 m clearance from every
// obstacle footprint and form a connected loop covering the floor plus both
// team-spawn ends (SE near z=+9, Bug near z=−9). Obstacle footprints avoided:
//   jump crates x=5, z∈{0,−1.8,−3.6}      slide pillars x∈{−4,−5.6}, z=−3
//   lintel posts x∈{−2,0}, z=4            L-corner x=7 z=6 & x=8.8 z=7.9
//   mid block x=−6, z=5 (x∈[−7,−5])
// 16 flat nodes (0..15) + 2 v1.2 stair nodes (16 foot, 17 platform, appended
// below with y). Phase 4+ supply real maps' nodes through makeGraph unchanged.
//
// Layout (x → right, z → toward SE spawn / +z; ASCII, not to scale):
//         BUG spawn (z≈−9):   12 — 13 — 14
//                              |    |    |
//   left lane:  11 ---------- 8 --- 9 -- 10 :right lane
//                |            |     |     |
//               7 ---------- 4 --- 5 --- 6
//                |            |     |     |
//         SE spawn (z≈+9):    1 --- 0 --- 2 --- 3
// ---------------------------------------------------------------------------
export const TEST_ROOM_NODES = [
  { x: 0.0,  z: 9.0,  links: [1, 2, 5] },      // 0  SE spawn center
  { x: -6.0, z: 9.0,  links: [0, 7] },          // 1  SE spawn left
  { x: 6.0,  z: 9.0,  links: [0, 3, 6] },       // 2  SE spawn right
  { x: 10.5, z: 9.0,  links: [2, 6] },          // 3  SE right corner
  // (node 6 also links to the v1.2 stair-foot node 16 — see the append below.)
  { x: -3.0, z: 2.0,  links: [5, 7, 8] },       // 4  mid-left (clear of lintel posts at z=4)
  { x: 3.5,  z: 2.0,  links: [0, 4, 6, 9] },    // 5  mid-center
  { x: 10.0, z: 3.0,  links: [2, 3, 5, 10] },   // 6  right lane mid (clear of L-corner x=7,z=6)
  { x: -10.0, z: 4.0, links: [1, 4, 11] },      // 7  left lane mid (clear of mid block x=−6)
  { x: -2.5, z: -5.5, links: [4, 9, 11, 12] },  // 8  mid-left far (clear of slide pillars z=−3)
  { x: 4.0,  z: -5.5, links: [5, 8, 10, 13] },  // 9  mid-center far
  { x: 10.0, z: -5.5, links: [6, 9, 14] },      // 10 right lane far
  { x: -10.0, z: -5.0, links: [7, 8, 12] },     // 11 left lane far
  { x: -6.0, z: -9.0, links: [8, 11, 13] },     // 12 Bug spawn left
  { x: 0.0,  z: -9.0, links: [9, 12, 14] },     // 13 Bug spawn center
  { x: 6.0,  z: -9.0, links: [10, 13] },        // 14 Bug spawn right
  { x: -10.5, z: 9.0, links: [1, 7] },          // 15 SE left corner (extra coverage)
  // -- v1.2 VERTICALITY GATE nodes (register group K6/K7) — ON the testRoom
  //    staircase fixture so bots CLIMB it in the test-room match. y carries the
  //    deck height; the foot→platform link averages 0.38 m/m (≤ SLOPE_MAX 0.45,
  //    K5). 16 sits on the floor just before the first tread; 17 sits on the
  //    1.75 m platform. Placed in the clear NE quadrant, clear of node 10.
  { x: 9.0, y: 0.0,  z: 1.6,  links: [6, 17] },   // 16 stair FOOT (floor level, before tread 1)
  { x: 9.0, y: 1.75, z: -3.0, links: [16] },      // 17 PLATFORM top (1.75 m — bots hold it & shoot down)
];

// Rewire node 1 to include the SE left corner (15) now that it exists — keeps
// the loop fully connected without editing the literal above out of order.
TEST_ROOM_NODES[1].links.push(15);
// Wire the right-lane node 6 to the stair foot (16) so the staircase is reachable
// from the graph (K7 — no player-only areas; a bot BFS can find the platform).
TEST_ROOM_NODES[6].links.push(16);
