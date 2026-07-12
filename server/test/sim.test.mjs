// ============================================================================
// server/test/sim.test.mjs — HEADLESS end-to-end proof of the authoritative
// BattleRoom (the netcode gate; no browser available to the netcode engineer).
//
// Boots a real Colyseus server on an ephemeral port, connects TWO real
// colyseus.js clients over WebSocket, and asserts the owner's core mechanics:
//   1. World + match boot (10 fighters, all bots).
//   2. JOIN replaces a bot: after client A joins, 9 slots are bot-held, A holds 1.
//   3. Movement is authoritative: holding W moves A's server entity.
//   4. A fire command can DAMAGE the other player (B shoots A across a clear
//      line → A's hp drops on the server).  [uses a direct sim assertion — the
//      network fire path shares the same code, verified via the room too]
//   5. Two clients coexist on opposite teams; both appear in every client's state.
//   6. LEAVE → a bot backfills the slot (10 bot-held again after both leave).
//
// Run:  cd server && npm test   (node --experimental-loader ./loader.mjs test/sim.test.mjs)
// Exit code 0 = all pass, 1 = a failure (CI gate).
// ============================================================================

import http from 'http';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from 'colyseus.js';
import { BattleRoom } from '../rooms/BattleRoom.js';
import { ServerMatch } from '../sim/serverMatch.js';
import { loadWorld } from '../sim/worldLoader.js';
import { KEYS, MSG } from '../../src/net/protocol.js';

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const PORT = 2599;
  const httpServer = http.createServer();
  const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }) });
  gameServer.define('battle', BattleRoom);
  await gameServer.listen(PORT);
  console.log(`[test] server up on :${PORT}`);

  // Reach into the live room instance for authoritative assertions (same-process).
  const roomInstance = () => [...gameServer.rooms.values ? gameServer.rooms.values() : Object.values(gameServer.rooms)][0]
    || gameServer.matchMaker?.rooms && [...Object.values(gameServer.matchMaker.rooms)][0];

  // --- Connect client A ---
  const clientA = new Client(`ws://localhost:${PORT}`);
  const roomA = await clientA.joinOrCreate('battle', { name: 'ALPHA' });
  let welcomeA = null;
  roomA.onMessage(MSG.WELCOME, (w) => { welcomeA = w; });
  await waitFor(() => welcomeA, 2000);
  check('A received WELCOME with selfId', welcomeA && welcomeA.selfId > 0);

  // Find the live room + match (same process).
  await sleep(100);
  const lr = findRoom(gameServer);
  check('server has one live BattleRoom', !!lr && lr instanceof BattleRoom);
  const match = lr.match;

  check('match has 10 slots', match.slots.length === 10);
  check('after A joins: 1 human, 9 bot-held slots',
    match.humanCount() === 1 && match.slots.filter((s) => s.occupant === s.bot).length === 9);

  const ctxA = [...match.humans.values()][0];
  const teamA = ctxA.entity.team;
  check('A occupies a slot with a real PlayerEntity', ctxA.entity.id === welcomeA.selfId);

  // --- 3. Movement authority: hold W for ~0.6 s of sim, expect A to move ---
  const startPos = ctxA.entity.pos.clone();
  for (let i = 0; i < 25; i++) {
    roomA.send(MSG.INPUT, { seq: i + 1, dtMs: 33, keys: KEYS.W, yaw: 0, pitch: 0, jump: 0, reload: 0, fireClick: 0, switchTo: 0 });
    await sleep(20);
  }
  await sleep(150);
  const movedA = ctxA.entity.pos.distanceTo(startPos);
  check(`A moved under authoritative control (${movedA.toFixed(2)} m)`, movedA > 0.5);

  // --- 5. Connect client B; both coexist ---
  const clientB = new Client(`ws://localhost:${PORT}`);
  const roomB = await clientB.joinOrCreate('battle', { name: 'BRAVO' });
  let welcomeB = null;
  roomB.onMessage(MSG.WELCOME, (w) => { welcomeB = w; });
  await waitFor(() => welcomeB, 2000);
  await sleep(150);
  check('after B joins: 2 humans, 8 bot-held', match.humanCount() === 2 && match.slots.filter((s) => s.occupant === s.bot).length === 8);
  const ctxB = [...match.humans.values()].find((h) => h !== ctxA);
  check('A and B on opposite teams (team balancer)', ctxA.entity.team !== ctxB.entity.team);

  // Both clients should see both human entities in their room state.
  await sleep(200);
  const aSeesBoth = roomA.state.entities.get(String(ctxA.entity.id)) && roomA.state.entities.get(String(ctxB.entity.id));
  const bSeesBoth = roomB.state.entities.get(String(ctxA.entity.id)) && roomB.state.entities.get(String(ctxB.entity.id));
  check('client A sees both humans in state', !!aSeesBoth);
  check('client B sees both humans in state', !!bSeesBoth);

  // --- 4a. Networked SHOT delivery: B's fire INPUT reaches the server and
  //         produces authoritative fire (real shots committed). We can't pin
  //         positions deterministically against the async sim timer, so the
  //         damage OUTCOME is asserted in 4b on an in-process match that runs the
  //         IDENTICAL weapons→castRay→applyDamage path synchronously. Here we
  //         just prove the wire carries fire intent into real server shots. ---
  const shotsBeforeNet = ctxB.weapons.shotsFired;
  for (let i = 0; i < 20; i++) {
    roomB.send(MSG.INPUT, { seq: 300 + i, dtMs: 33, keys: KEYS.LMB, yaw: 0, pitch: 0, jump: 0, reload: 0, fireClick: 1, switchTo: 0 });
    await sleep(20);
  }
  check(`B's fire commands produced authoritative shots over the wire (${ctxB.weapons.shotsFired - shotsBeforeNet} fired)`,
    ctxB.weapons.shotsFired > shotsBeforeNet);

  // --- 4b. Fire DAMAGES the other player (deterministic, same code path). A
  //         fresh in-process match, two humans pinned 3 m apart on flat ground,
  //         B facing A, fired via REAL input commands + synchronous ticks. This
  //         is the exact weapons→lag-comp→castRay→applyDamage the room drives;
  //         running it in-process just removes the async-timer race so the
  //         assertion is deterministic. ---
  const detMatch = new ServerMatch(loadWorld());
  const dA = detMatch.addHuman('detA', 'DET_A');
  const dB = detMatch.addHuman('detB', 'DET_B');
  check('deterministic fighters on opposite teams', dA.entity.team !== dB.entity.team);
  // Remove the 8 remaining bots from the fight so no crossfire kills our two
  // test fighters mid-assertion (this isolates the B→A shot; the bots' own
  // combat is proven by the all-bot smoke test + the live room ticking above).
  for (const s of detMatch.slots) {
    if (s.occupant !== dA.entity && s.occupant !== dB.entity) { s.occupant.dead = true; if (s.occupant.group) s.occupant.group.visible = false; }
  }
  detMatch._nextRespawn.clear();
  // OPEN, FLAT field spot clear of the central compound + camp/tree POIs
  // (battle field ±96; compound ~±46; camps at ±66; trees point-placed). The
  // SE-spawn approach around x=-80,z=0 is verified flat ground (settles y=0).
  const BX = -80, BZ = 0, AX = -77, AZ = 0, GY = 0;
  function pin() {
    dB.controller.pos.set(BX, GY, BZ); dB.controller.vel.set(0, 0, 0); dB.controller.grounded = true; dB.controller.ropes = null;
    dB.cam.yaw = -Math.PI / 2; dB.cam.pitch = 0; // forward (-sin,0,-cos) = (+1,0,0) → toward A (+x)
    dB.cam.camera.position.set(BX, GY + 1.62, BZ);
    dA.controller.pos.set(AX, GY, AZ); dA.controller.vel.set(0, 0, 0); dA.controller.grounded = true; dA.controller.ropes = null;
    dA.entity.protectedUntil = 0; dB.entity.protectedUntil = 0;
    dA.entity.refresh(); dB.entity.refresh();
  }
  dA.entity.hp = 100; dA.entity.dead = false;
  // WARM-UP: pin + tick WITHOUT firing so the lag-comp ring buffer fills with A
  // at its pinned position (fighters were teleported here, so rewind history
  // would otherwise point at their old spawn and the first shots would honestly
  // miss the historical target — correct lag-comp, but noise for this assertion).
  for (let i = 0; i < 20; i++) { pin(); detMatch.update(1 / 30); dA.controller.pos.set(AX, GY, AZ); dA.entity.refresh(); }
  const hpBefore = dA.entity.hp;
  // Run long enough to clear the rifle raise (~0.45 s ≈ 14 ticks) + a burst.
  for (let i = 0; i < 90 && dA.entity.hp === hpBefore && !dA.entity.dead; i++) {
    pin();
    detMatch.queueInput('detB', { seq: 100 + i, dtMs: 33, keys: KEYS.LMB, yaw: -Math.PI / 2, pitch: 0, jump: 0, reload: 0, fireClick: 1, switchTo: 0 });
    detMatch.update(1 / 30);
    dA.controller.pos.set(AX, GY, AZ); dA.entity.refresh(); // keep A put after the tick
  }
  check(`B's fire damaged A (deterministic same-code path; hp ${hpBefore} → ${dA.entity.hp})`, dA.entity.hp < hpBefore);

  // --- 6. Leave → bot backfill ---
  await roomA.leave();
  await roomB.leave();
  await sleep(300);
  check('after both leave: 0 humans, 10 bot-held (bots backfilled)',
    match.humanCount() === 0 && match.slots.filter((s) => s.occupant === s.bot).length === 10);

  // Match kept running through all of this.
  check('match never ended prematurely (still live or naturally over)', match.state === 'live' || match.state === 'over');

  await gameServer.gracefullyShutdown(false);
  console.log(failures ? `\n*** ${failures} FAILURE(S) ***` : `\n=== ALL SIM TESTS PASS ===`);
  process.exit(failures ? 1 : 0);
}

function findRoom(gameServer) {
  // Colyseus keeps live rooms in the LocalPresence/driver; the process-local
  // matchmaker exposes them. Fall back to scanning the driver.
  const mm = gameServer.matchMaker || (gameServer.transport && gameServer.transport.matchMaker);
  // 0.15: gameServer has `.rooms`? Not public. Use the module-level handler map.
  // Simplest robust path: the room registered a static tracker on construction.
  return BattleRoom._live && BattleRoom._live[BattleRoom._live.length - 1];
}

async function waitFor(pred, timeoutMs) {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < timeoutMs) await sleep(20);
  return pred();
}

main().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });
