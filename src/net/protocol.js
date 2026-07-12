// ============================================================================
// src/net/protocol.js — the ONE shared wire contract between the browser client
// (src/net/client.js) and the authoritative server (server/**). Constants only,
// no imports, no THREE — safe to import from either side (the server imports it
// through the same loader shim; the client bundles it with Vite).
//
// Design: inputs go UP as a compact per-tick command; state comes DOWN as a
// @colyseus/schema room state (positions/hp/weapon at 20 Hz) plus a transient
// EVENTS channel (kills/shots) the client turns into feed lines + positional
// audio. The client never asserts damage — it sends intent (a fire command with
// the aim ray); the server casts + applies (see server hitscan lag-comp).
// ============================================================================

// --- Input key/button bitmask (ServerInput.KEYS mirrors this EXACTLY) -------
export const KEYS = {
  W: 1 << 0,
  A: 1 << 1,
  S: 1 << 2,
  D: 1 << 3,
  SHIFT: 1 << 4,
  LMB: 1 << 5, // fire held (auto weapons)
  RMB: 1 << 6, // ADS held
};

// --- Message channels (Colyseus room.send / onMessage type strings) ---------
export const MSG = {
  INPUT: 'i',   // client → server: one InputCommand (see shape below)
  EVENTS: 'e',  // server → client: array of transient events (kills/shots)
  WELCOME: 'w', // server → client: { selfId, team, mapName, tickRate }
};

// --- Weapon id table (schema stores a small int, not the string, to stay lean).
export const WEAPON_ID = { rifle: 0, pistol: 1, knife: 2 };
export const WEAPON_NAME = ['rifle', 'pistol', 'knife'];

// --- Team id table ----------------------------------------------------------
export const TEAM_ID = { se: 0, bug: 1 };
export const TEAM_NAME = ['se', 'bug'];

// --- Event kinds on the EVENTS channel --------------------------------------
export const EV = {
  KILL: 0,  // { k:killerName, kt:killerTeam, v:victimName, vt:victimTeam, w:weaponId, h:isHead }
  SHOT: 1,  // { x,y,z: shooter head pos, id: shooterEntityId } — positional shot audio/muzzle
  HIT: 2,   // { id: victimEntityId } — local-player hitmarker confirm (sent to the shooter only)
  DEATH: 3, // { id: entityId, kt: killerTeam, h: isHead } — splat at a fighter
};

// --- Tunables the protocol layer needs on both sides ------------------------
export const NET = {
  tickRate: 30,          // server sim ticks / s (fixed dt = 1/30)
  patchRate: 20,         // room-state broadcast rate / s (Colyseus patchRate)
  interpDelayMs: 100,    // client renders remote entities this far in the past
  maxCmdDtMs: 50,        // server rejects a command dt above this (== MOVE.dtClampMs)
  maxCmdsPerSec: 120,    // per-client command rate cap (basic anti-cheat)
  lagCompWindowMs: 300,  // server position ring-buffer length for rewind hitscan
  maxClients: 10,        // one 10-slot TDM room (5 SE / 5 Bug)
};

// InputCommand shape (client → server, MSG.INPUT):
//   {
//     seq:   number,   // monotonic per-client sequence (reconciliation)
//     dtMs:  number,   // this command's frame dt in ms (server clamps to maxCmdDtMs)
//     keys:  number,   // KEYS bitmask (held)
//     yaw:   number,   // absolute look yaw (radians)
//     pitch: number,   // absolute look pitch (radians)
//     jump:  0|1,
//     reload:0|1,
//     fireClick: 0|1,  // LMB edge this frame (semi weapons)
//     switchTo: 0|1|2|3, // 0 none, else weapon id+1 (1 rifle,2 pistol,3 knife)
//   }
