// ============================================================================
// Combatant — the shared duck-type both the game-logic layer (bots, match) and
// the presentation layer read. Bots (bots.js) and the player (PlayerEntity
// below) both implement it, so hitscan / applyDamage / bot senses treat every
// fighter uniformly. Documented here as the ONE contract:
//
//   Combatant {
//     id:            number (stable within a match)
//     name:          string (from names.js; player = 'you')
//     team:          'se' | 'bug'
//     hp, maxHp:     number
//     dead:          boolean (set the SAME frame damage kills — F2)
//     pos:           THREE.Vector3  — FEET position (y = floor = 0)
//     forward:       THREE.Vector3  — unit XZ facing (y = 0); backstab + aim use it
//     bodyMin/Max:   THREE.Vector3  — world-space AABB hitscan reads (E3)
//     headCenter:    THREE.Vector3  — world-space head-sphere center (E3)
//     headRadius:    number         — head-sphere radius (COMBAT.headRadius-ish)
//     protectedUntil: number        — GAME-TIME seconds; while game clock < this,
//                                      the fighter is spawn-protected (F10)
//     onDamaged(info) | null        — feedback hook (F1); see the info shape below
//     onKilled(info)  | null        — kill hook (F1)
//   }
//
// applyDamage (damage.js) fires the target's onDamaged/onKilled hooks with:
//   { amount, source, isHead, killed, hp }
// PlayerEntity RE-SHAPES that (in _relayDamage, wired to onDamaged by the match)
// into the richer payload the frontend danger stack needs — source POSITION for
// the directional wedges, hpAfter — and forwards it to the SEPARATE `onDanger`
// frontend slot (kept separate from the applyDamage hook to avoid recursion).
// That payload is a REUSED module-scope object (zero-alloc on the hot path);
// the frontend must copy what it keeps (esp. sourcePos) synchronously — see
// PlayerEntity._relayDamage for the contract.
//
// Spawn protection (§4B/F10): while protectedUntil is in the future the fighter
// is damage-immune AND bots de-prioritize it. BOTH are enforced by ONE clean
// mechanism in match.js — a protected fighter is EXCLUDED from every target
// list (enemiesOfPlayer + per-bot enemy lists). Hitscan can only hit what's in
// a list, so exclusion = immunity, with no special case inside applyDamage
// (which stays the pure clamp/kill entry point). Protection breaks EARLY the
// instant the fighter fires — the match calls notifyFired() for the player (off
// the WeaponSystem's shotsFired signal); a bot clears its own window in
// BotGun.fire on its first shot.
// ============================================================================

import * as THREE from 'three';
import { COMBAT, MOVE } from '../config.js';
import { PLAYER_NAME } from './names.js';

// Module scratch — zero allocations on the per-frame refresh (I1).
const _fwd = new THREE.Vector3();

// Module-scope REUSED danger payload + its source-position vector. The player
// can be hit several times a second in a firefight, and _relayDamage sits on a
// path reachable from a bot's update() (bot fires → applyDamage(player) →
// onDamaged → _relayDamage), so allocating a fresh object + Vector3 per hit
// would be GC pressure on the hot path (I1). Instead we reuse this ONE object,
// exactly like weapons.js reuses its hit `result`. CONTRACT: onDanger's payload
// is TRANSIENT — the frontend must COPY what it needs (notably sourcePos, which
// it reprojects vs. camera yaw every frame for the wedge, F7) synchronously on
// receipt; the next hit overwrites it.
const _dangerPayload = {
  amount: 0, hpAfter: 0, isHead: false,
  hasSource: false,              // false ⇒ sourcePos is stale/meaningless (no attacker)
  sourcePos: new THREE.Vector3(), // COPY THIS on receipt (reused across hits)
  sourceName: null, sourceTeam: null, killed: false,
};

/**
 * PlayerEntity — wraps the existing PlayerController so the player is a
 * first-class Combatant that bots can see, target, and kill, and that the match
 * scores. It does NOT touch controller internals for movement (main.js gates
 * that on match.playerAlive); it only READS controller.pos + the camera yaw to
 * keep its hitboxes current, and owns the player's hp / dead / respawn plumbing.
 *
 * The head-sphere sits at EYE height (MOVE.eyeHeight) so a bot aiming at the
 * player's head aims where the camera actually is — symmetric with how the
 * player's own camera-ray resolves against bot heads.
 */
export class PlayerEntity {
  /**
   * @param {number} id
   * @param {import('../player/controller.js').PlayerController} controller
   * @param {import('../combat/weapons.js').WeaponSystem} weapons
   * @param {{ yaw:number }} cam  the FpsCamera (read .yaw for facing/head aim)
   */
  constructor(id, controller, weapons, cam) {
    this.id = id;
    this.name = PLAYER_NAME;
    this.team = 'se';
    this.maxHp = COMBAT.maxHealth;
    this.hp = COMBAT.maxHealth;
    this.dead = false;

    this._controller = controller;
    this._weapons = weapons;
    this._cam = cam;

    // Combatant hitbox/pose fields (world space). Refreshed every frame in
    // refresh(); allocated once here (I1). Player uses the SAME body dims as the
    // movement collider (MOVE) so what you can be shot in matches what you are.
    this.pos = controller.pos;            // alias the controller's live feet vector
    this.forward = new THREE.Vector3(0, 0, -1);
    this.bodyMin = new THREE.Vector3();
    this.bodyMax = new THREE.Vector3();
    this.headCenter = new THREE.Vector3();
    this.headRadius = COMBAT.headRadius + 0.06; // generous, skilled direction (E3), like dummies

    // Spawn protection window in GAME-TIME seconds (F10). match sets it on
    // spawn/respawn; notifyFired() collapses it early.
    this.protectedUntil = 0;

    // Hooks. `onDamaged`/`onKilled` are the applyDamage (F1) duck-type hooks —
    // the MATCH wires onDamaged to _relayDamage (which shapes the RICH danger
    // payload and forwards it to `onDanger`, the frontend's slot). Keeping the
    // frontend slot SEPARATE from the applyDamage hook avoids any recursion.
    this.onDamaged = null; // set by match → _relayDamage (applyDamage hook)
    this.onKilled = null;  // set by match → death handling (applyDamage hook)
    this.onDanger = null;  // (rich) — FRONTEND slot: directional-danger payload (see _relayDamage)

    this.refresh(); // seed the hitboxes before the first tick
  }

  // Refresh body AABB + head-sphere from the live controller pos and camera
  // yaw. Called every frame by the match BEFORE bots sense (so they aim at the
  // player's current pose) and before the player's own shot resolves. Forward
  // is the camera's yaw flattened to XZ (pitch ignored — backstab/aim are
  // horizontal, matching the knife arc and dummy convention).
  refresh() {
    const hw = MOVE.halfWidth;
    const p = this._controller.pos;
    // pos is aliased to controller.pos already; keep it in sync defensively in
    // case a respawn replaced the vector (it doesn't — respawn copies in place).
    if (this.pos !== p) this.pos = p;

    this.bodyMin.set(p.x - hw, p.y, p.z - hw);
    this.bodyMax.set(p.x + hw, p.y + MOVE.height, p.z + hw);
    // Head sphere at the eye — where the camera (and thus the crosshair) is.
    this.headCenter.set(p.x, p.y + MOVE.eyeHeight, p.z);

    const yaw = this._cam.yaw;
    _fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw)); // camera forward flattened to XZ
    this.forward.copy(_fwd); // already unit in XZ
  }

  // True while the game clock hasn't passed the protection window (F10).
  isProtected(gameTime) {
    return gameTime < this.protectedUntil;
  }

  // Break spawn protection the instant the player fires (§4B — no protected
  // camping). The match calls this when the WeaponSystem's shotsFired counter
  // advances (a real shot this frame; see match._detectPlayerFire). Idempotent.
  notifyFired() {
    this.protectedUntil = 0;
  }

  // The match wires this as the player's applyDamage `onDamaged` hook, so EVERY
  // hit (bot bullet, future hazard) flows through here. It fills the REUSED
  // module-scope danger payload the frontend's directional stack needs and
  // forwards it to the SEPARATE `onDanger` slot. Payload shape (see _dangerPayload):
  //   { amount, hpAfter, isHead, hasSource, sourcePos:V3, sourceName, sourceTeam, killed }
  // CONTRACT: the payload is TRANSIENT (reused, zero-alloc — I1). The frontend
  // must COPY sourcePos into its own pooled wedge slot synchronously on receipt
  // (it reprojects that position vs. camera yaw every frame — F7); the next hit
  // overwrites the vector. `hasSource=false` ⇒ no attacker, sourcePos is stale.
  // `attacker` is info.source (the firing Combatant), passed by the match's hook.
  _relayDamage(info, attacker) {
    if (!this.onDanger) return;
    const p = _dangerPayload;
    p.amount = info.amount;
    p.hpAfter = Math.max(0, info.hp);
    p.isHead = info.isHead;
    p.killed = info.killed;
    if (attacker && attacker.pos) {
      p.hasSource = true;
      p.sourcePos.copy(attacker.pos);      // reused vector — frontend copies on receipt (F7)
      p.sourceName = attacker.name;
      p.sourceTeam = attacker.team;
    } else {
      p.hasSource = false;                 // sourcePos left stale; frontend must check hasSource
      p.sourceName = null;
      p.sourceTeam = null;
    }
    this.onDanger(p);
  }

  // Point the camera at a spawn's facing yaw (Phase-4 map plumbing). The MAP
  // authors each spawn with a yaw toward mid/exits; the match calls this on
  // (re)spawn so you face the fight, not the back wall. Mouse still owns
  // this.yaw immediately afterward — this is a one-shot snap. Kept as a NAMED
  // hook (not an inline cam poke from match.js) so the match never reaches into
  // the camera: it hands PlayerEntity a yaw, PlayerEntity owns the cam. Pitch is
  // levelled so you don't spawn looking at the floor/ceiling.
  applySpawnFacing(faceYaw) {
    if (this._cam) { this._cam.yaw = faceYaw; this._cam.pitch = 0; }
  }

  // Full reset on (re)spawn: hp/ammo restored, position placed at a safe spawn
  // by the match, spawn-protection armed. The match owns WHERE (safe spawn
  // selection, D5) and the countdown; this just applies the state.
  //   feetPos: THREE.Vector3 safe spawn (feet)
  //   faceYaw: number facing yaw (the map's spawn yaw → applySpawnFacing)
  //   protectUntil: game-time the protection expires
  respawnAt(feetPos, faceYaw, protectUntil) {
    this.hp = this.maxHp;
    this.dead = false;
    this.protectedUntil = protectUntil;

    // Place the controller (movement) — copy in place so aliases stay valid.
    this._controller.pos.copy(feetPos);
    this._controller.vel.set(0, 0, 0);
    this._controller.grounded = false;
    this._controller.coyote = 0;
    this._controller.jumpBuffer = 0;
    this._controller.sprintSuppress = 0;

    // Aim the camera at the spawn's friendly yaw (mouse still owns it after).
    this.applySpawnFacing(faceYaw);

    // Ammo/reserve refill + weapon state reset (R "reserve refills on respawn").
    this._weapons.refill();

    this.refresh();
  }
}
