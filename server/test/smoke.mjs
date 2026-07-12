// Quick headless smoke test of the sim (no Colyseus). Run with the loader.
import { loadWorld } from '../sim/worldLoader.js';
import { ServerMatch } from '../sim/serverMatch.js';
import { KEYS } from '../sim/serverInput.js';

const world = loadWorld();
console.log('world OK: colliders', world.colliders.length, 'nodes', world.waypointNodes.length,
  'se', world.seSpawns.length, 'bug', world.bugSpawns.length);

const match = new ServerMatch(world);
console.log('match built: slots', match.slots.length, 'seTeam', match.seTeam.length, 'bugTeam', match.bugTeam.length);

// Tick 60 frames all-bots.
for (let i = 0; i < 60; i++) match.update(1 / 30);
console.log('after 60 all-bot ticks: scores', match.scores, 'events', match.events.length);
match.events.length = 0;

// Join a human.
const ctx = match.addHuman('sessA', 'TESTER');
console.log('joined: id', ctx.entity.id, 'team', ctx.entity.team, 'humans', match.humanCount());
const startSlotBots = match.slots.filter((s) => s.occupant === s.bot).length;
console.log('bot-held slots after join (expect 9):', startSlotBots);

// Feed movement commands (hold W) for 30 ticks; expect position to change.
const before = ctx.controller.pos.clone();
for (let i = 0; i < 30; i++) {
  match.queueInput('sessA', { seq: i, dtMs: 33, keys: KEYS.W, yaw: 0, pitch: 0, jump: 0, reload: 0, fireClick: 0, switchTo: 0 });
  match.update(1 / 30);
}
const moved = ctx.controller.pos.distanceTo(before);
console.log('human moved (m) holding W:', moved.toFixed(3), moved > 0.5 ? 'OK' : 'FAIL');

// Leave → bot backfills.
match.removeHuman('sessA');
const botsAfter = match.slots.filter((s) => s.occupant === s.bot).length;
console.log('bot-held slots after leave (expect 10):', botsAfter, 'humans', match.humanCount());

console.log('SMOKE OK');
