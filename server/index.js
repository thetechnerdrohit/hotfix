// ============================================================================
// server/index.js — boots the HOTFIX authoritative multiplayer server: a
// Colyseus Server on a WebSocket transport, one registered room type 'battle'.
// Clients quick-match with joinOrCreate('battle') (see src/net/client.js), which
// drops them into any open room or spins a fresh one. maxClients 10 per room.
//
// Run:  npm run server   (repo root)   →   node --experimental-loader server/loader.mjs server/index.js
//   or: cd server && npm start
//
// Self-hostable (the researched deploy target): plain Node + ws, no external
// services. PORT env overrides the default 2567.
// ============================================================================

import http from 'http';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { BattleRoom } from './rooms/BattleRoom.js';

const PORT = Number(process.env.PORT) || 2567;

const httpServer = http.createServer();
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define('battle', BattleRoom);

gameServer.listen(PORT).then(() => {
  console.log(`[hotfix] BattleRoom server listening on ws://localhost:${PORT}`);
}).catch((err) => {
  console.error('[hotfix] server failed to start:', err);
  process.exit(1);
});
