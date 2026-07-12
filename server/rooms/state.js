// ============================================================================
// server/rooms/state.js — @colyseus/schema room state (the DOWN-stream truth).
// Kept LEAN: one EntitySchema per fighter (10 total: humans + bots), a small
// MatchSchema (scores/clock/state). Transient events (kills/shots) do NOT live
// in schema — they go over the MSG.EVENTS message channel so they fire once and
// never bloat the state patch (see protocol.js / BattleRoom).
//
// Plain-JS schema via defineTypes (no decorators / no TS). @colyseus/schema
// 2.x. Numbers are packed small: team/weapon are uint8 ids (protocol tables),
// positions float32, yaw float32. hp uint8 (0..100). The client interpolates
// remote entities from these; the LOCAL player is client-predicted and only
// RECONCILED against its own entity (see src/net/prediction.js).
// ============================================================================

import { Schema, MapSchema, defineTypes } from '@colyseus/schema';

export class EntitySchema extends Schema {
  constructor() {
    super();
    this.id = 0;        // stable entity id (player.id or bot.id)
    this.name = '';
    this.team = 0;      // TEAM_ID: 0 se, 1 bug
    this.isBot = true;
    this.x = 0; this.y = 0; this.z = 0;
    this.yaw = 0;
    this.hp = 100;
    this.dead = false;
    this.weapon = 0;    // WEAPON_ID: 0 rifle, 1 pistol, 2 knife
    this.protectedUntil = 0; // game-time; client can gray-out protected fighters
    this.ackSeq = 0;    // last input seq the server processed FOR this entity
                        // (only meaningful for the client's own entity → reconciliation)
    this.skin = 0;      // v2.4: appearance seed — the client derives the whole
                        // randomized kour-style character deterministically from
                        // (skin, team), so every client renders the SAME body for
                        // a given fighter with just 2 bytes on the wire.
  }
}
defineTypes(EntitySchema, {
  id: 'uint16',
  name: 'string',
  team: 'uint8',
  isBot: 'boolean',
  x: 'float32', y: 'float32', z: 'float32',
  yaw: 'float32',
  hp: 'uint8',
  dead: 'boolean',
  weapon: 'uint8',
  protectedUntil: 'float32',
  ackSeq: 'uint32',
  skin: 'uint16',
});

export class MatchState extends Schema {
  constructor() {
    super();
    this.entities = new MapSchema(); // key = String(entity.id)
    this.seScore = 0;
    this.bugScore = 0;
    this.clock = 0;      // seconds remaining (game-time)
    this.phase = 'live'; // 'live' | 'over'
    this.winner = '';    // '' until over, then 'se' | 'bug' | 'draw'
    this.mapName = 'battle';
  }
}
defineTypes(MatchState, {
  entities: { map: EntitySchema },
  seScore: 'uint16',
  bugScore: 'uint16',
  clock: 'float32',
  phase: 'string',
  winner: 'string',
  mapName: 'string',
});
