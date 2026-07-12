// ============================================================================
// Match — the Team Deathmatch game logic (Phase 3, the first real milestone).
// Owns the roster (player + 4 SE bots + 5 Bug bots), team spawns, scores, the
// game-time clock, win/draw resolution, and every per-frame maintenance the two
// layers depend on. GAME LOGIC ONLY — it emits nullable callback events the
// frontend agent consumes; it never touches the HUD/DOM/audio/overlays itself.
//
// Edge cases owned here (F/D5 groups + §4B death/respawn):
//   F1  all damage still routes through the single applyDamage entry (weapons.js
//        for the player, BotGun for bots) — the match only ORCHESTRATES.
//   F2/F3  dead flag is set inside applyDamage; two fighters trading in one
//        frame both die — the match counts both kills.
//   F10 SPAWN PROTECTION: while protected a fighter is (a) immune to damage and
//        (b) de-prioritized by bots. BOTH are enforced by ONE mechanism — a
//        protected fighter is EXCLUDED from every target list the match
//        maintains (enemiesOfPlayer + per-bot enemy lists). Hitscan can only hit
//        what's in the list, so exclusion = immunity, cleanly, without a special
//        case inside applyDamage. Protection BREAKS the instant a fighter fires
//        (player via notifyFired; a bot clears its own window in BotGun.fire).
//   D5  spawn selection: the team point FARTHEST from living enemies that also
//        doesn't overlap any combatant; a dev-mode depenetration assert warns if
//        a chosen spawn still overlaps geometry.
//
// Zero per-frame allocations (I1): the target arrays and the player-collider
// array are PREALLOCATED once and maintained IN PLACE (length reset + push into
// stable slots; identities never change so the WeaponSystem/PlayerController
// keep the same reference forever). BFS/senses scratch lives in bots.js.
//
// Clock is game-time (counts down off clamped dt, B6) — never wall-clock.
// ============================================================================

import * as THREE from 'three';
import { MATCH, PROPS, getBotTuning } from '../config.js';
import { applyDamage } from '../combat/damage.js';
import { buildBots } from './bots.js';
import { makeNameDealers } from './names.js';
import { PropsManager } from './props.js';

// Phase 4: team spawns are no longer hard-coded here — the MAP owns them (both
// world/prodMap.js and world/testRoom.js return { seSpawns, bugSpawns } where
// each entry is { pos:THREE.Vector3 (feet, y=0), yaw:number (facing toward
// mid/exits) }). main.js passes them into this constructor. D5 spawn-selection,
// respawn, and protection logic below are map-agnostic — they read whatever
// arrays they're handed.

// Module scratch — zero-alloc spawn scoring + yaw→forward conversion (I1).
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();

// yaw → unit XZ forward, matching the camera convention (camera.js): forward =
// (−sin yaw, 0, −cos yaw). Used to face bots on spawn (bots want a vector; the
// player takes the yaw directly via respawnAt).
function yawToForward(yaw, out) {
  return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
}

export class Match {
  /**
   * @param {import('./entities.js').PlayerEntity} player
   * @param {import('../combat/weapons.js').WeaponSystem} weapons  the player's gun (watched for fire → break protection)
   * @param {object} graph   WaypointGraph (waypoints.js)
   * @param {THREE.Scene} scene
   * @param {Array<{min:THREE.Vector3,max:THREE.Vector3}>} staticColliders  room.colliders
   * @param {{seSpawns:Array<{pos:THREE.Vector3,yaw:number}>, bugSpawns:Array<{pos:THREE.Vector3,yaw:number}>}} spawns
   *        the map's team spawns (prodMap/testRoom return these); each entry is a
   *        feet position + a facing yaw toward mid/exits. Replaces the old
   *        hard-coded SE_SPAWNS/BUG_SPAWNS (Phase-4 map plumbing).
   * @param {number} nameSeed
   */
  constructor(player, weapons, graph, scene, staticColliders, spawns, nameSeed = 0x1234abcd) {
    this.player = player;
    this.weapons = weapons;
    this.graph = graph;
    this.scene = scene;
    this.staticColliders = staticColliders;
    this.seSpawns = spawns.seSpawns;   // [{pos,yaw}] — map-supplied (D5 selection reads these)
    this.bugSpawns = spawns.bugSpawns; // [{pos,yaw}]
    this._nameSeed = nameSeed >>> 0;

    this.tuning = getBotTuning(); // folded BOTS + active difficulty preset

    // --- Roster ------------------------------------------------------------
    this._dealers = makeNameDealers(this._nameSeed);
    // 4 SE bots (the player is the 5th SE), 5 Bug bots. baseIndex seeds the LOS
    // stagger phase across the whole roster so no two bots raycast in lockstep.
    const seNames = [];
    for (let i = 0; i < MATCH.teamSize - 1; i++) seNames.push(this._dealers.se.next());
    const bugNames = [];
    for (let i = 0; i < MATCH.teamSize; i++) bugNames.push(this._dealers.bug.next());

    this.seBots = buildBots('se', seNames, scene, graph, this.tuning, 0);
    this.bugBots = buildBots('bug', bugNames, scene, graph, this.tuning, this.seBots.length);
    this.bots = this.seBots.concat(this.bugBots); // living-or-dead; stable identity

    // Full combatant rosters per team (player is an SE). Stable arrays.
    this.seTeam = [this.player, ...this.seBots];
    this.bugTeam = [...this.bugBots];
    this.allCombatants = [this.player, ...this.bots];

    // --- Match state -------------------------------------------------------
    this.scores = { se: 0, bug: 0 };
    this.clock = MATCH.timeLimit; // counts down (game-time)
    this.state = 'live';          // 'live' | 'over'
    this.result = null;           // { winner:'se'|'bug'|'draw', se, bug } once over
    this._overHold = 0;           // s the "over" screen must hold before restart is allowed
    this.playerAlive = true;      // main.js gates controller/weapons on this (§4B)

    // Player respawn countdown (game-time). Each bot carries its OWN countdown
    // in bot._respawnTimer (a field, not a Map) so the respawn tick iterates the
    // fixed roster array with zero per-frame allocations (I1).
    this._playerRespawn = 0;

    // --- Stable, preallocated, maintained-in-place arrays (I1) -------------
    // The player's live target list — the WeaponSystem holds THIS reference
    // (main.js passes it in place of the dummy targets). Contents rebuilt each
    // frame (living, unprotected Bugs); identity never changes.
    this.enemiesOfPlayer = [];
    // Per-bot enemy lists (living, unprotected enemies of that bot). Preallocate
    // one stable array per bot; rebuilt in place each frame.
    this._botEnemies = new Map();
    for (let i = 0; i < this.bots.length; i++) this._botEnemies.set(this.bots[i], []);
    // Per-bot ally lists (same team, for separation). Stable; rebuilt in place.
    this._botAllies = new Map();
    for (let i = 0; i < this.bots.length; i++) this._botAllies.set(this.bots[i], []);

    // dynamicColliders[] — the ONE stable array the PlayerController collides
    // against: the static room colliders first, then a preallocated pool of
    // living-bot AABBs appended after. Never reallocated per frame; compacted by
    // rewriting slots. This is the PLAYER's collider set only (bots collide
    // against the static set, so no bot ever needs to skip its own slot here).
    this._colliderPool = [];
    for (let i = 0; i < this.bots.length; i++) {
      this._colliderPool.push({ min: new THREE.Vector3(), max: new THREE.Vector3() });
    }
    this.dynamicColliders = staticColliders.slice(); // starts as a copy of the statics
    this._staticCount = staticColliders.length;

    // --- v2.3 PROPS: roaming chickens (personal points) + a kickable football.
    // Self-contained sim owned here; chickens are appended to the player target
    // list each rebuild so the stock hitscan hits them. A chicken kill fires the
    // PERSONAL score callback (onChickenScore) — it NEVER touches team scores.
    this.props = new PropsManager({ colliders: staticColliders, seSpawns: this.seSpawns, bugSpawns: this.bugSpawns }, scene, this._nameSeed);
    this.chickenScore = 0;             // player's personal chicken tally
    this.onChickenScore = null;        // (total, gained) => HUD counter + feed
    this.props.onChickenKilled = (chicken, source) => {
      // Only the PLAYER's shots score (bots ignore chickens as targets). If a bot
      // ever kills one, source !== player and we simply don't award points.
      if (source === this.player) {
        this.chickenScore += PROPS.chickens.points;
        if (this.onChickenScore) this.onChickenScore(this.chickenScore, PROPS.chickens.points);
      }
    };

    // --- Events (nullable; frontend wires) ---------------------------------
    this.onKillFeed = null;      // ({ killerName, killerTeam, victimName, victimTeam, weapon, isHead })
    this.onScoreChanged = null;  // (se, bug)
    this.onMatchEnd = null;      // ({ winner, se, bug })
    this.onPlayerDeath = null;   // ({ killerName, killerTeam, weapon, isHead })
    this.onPlayerRespawn = null; // ()
    this.onBotFired = null;      // (bot)  — positional shot sound + muzzle light-quad
    this.onBotKilled = null;     // (bot, { killerTeam, isHead })  — splat

    this._wireCombatantHooks();
    this._spawnEveryone();

    // Watch the player's fire to break spawn protection early (§4B). The
    // WeaponSystem's `shotsFired` monotonic counter is the fire signal (the
    // frontend owns onFire, so we don't co-opt it); we snapshot it and detect
    // an increase each frame. Seeded here so frame 1 never mis-reads.
    this._lastShotsFired = weapons.shotsFired;
  }

  // ---- Hook wiring: every combatant's applyDamage feedback → match logic ---
  _wireCombatantHooks() {
    // PLAYER: applyDamage calls player.onDamaged/onKilled. We shape the rich
    // danger payload (source pos, etc.) via PlayerEntity._relayDamage, but we
    // need the ATTACKER for that — applyDamage passes `source` (the firing
    // Combatant) as info.source. So the player's onDamaged reads info.source.
    this.player.onDamaged = (info) => {
      this.player._relayDamage(info, info.source || null);
    };
    this.player.onKilled = (info) => {
      // dead flag already set (F2). Credit the killer + start the countdown.
      const killer = info.source || null;
      this._onCombatantKilled(this.player, killer, info.isHead);
    };

    // BOTS: point the applyDamage (F1) duck-type hook straight at
    // onDamagedInternal (flinch + shot-from-behind reaction, then it relays to
    // bot._frontendDamaged — the frontend's positional hit-fx slot, left null
    // here). onKilled credits the kill; onShot drives per-bullet feedback.
    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      bot.onDamaged = (info) => bot.onDamagedInternal(info); // F1 hook → internal handler
      bot.onKilled = (info) => this._onCombatantKilled(bot, info.source || null, info.isHead);
      bot.onShot = (b, shot) => this._onBotShot(b, shot);
    }
  }

  // ---- Spawning ------------------------------------------------------------
  _spawnEveryone() {
    const now = MATCH.timeLimit - this.clock; // game-time elapsed = 0 at start
    // Player at an SE point; bots spread across their team points.
    this._spawnPlayer(now, true);
    this._spawnTeamBots(this.seBots, this.seSpawns, now);
    this._spawnTeamBots(this.bugBots, this.bugSpawns, now);
  }

  _spawnTeamBots(bots, points, gameTime) {
    for (let i = 0; i < bots.length; i++) {
      const sp = this._pickSpawn(points, bots[i]); // {pos, yaw}
      const node = this.graph.nearestNode(sp.pos);
      // Bots want a forward VECTOR; convert the spawn's yaw (faces mid/exits).
      yawToForward(sp.yaw, _fwd);
      bots[i].spawnAt(sp.pos, _fwd, gameTime + MATCH.spawnProtection, node);
    }
  }

  _spawnPlayer(gameTime, initial) {
    const sp = this._pickSpawn(this.seSpawns, this.player); // {pos, yaw}
    // respawnAt takes the facing YAW directly and applies it to the camera
    // (PlayerEntity owns the cam) — no reaching into cam here.
    this.player.respawnAt(sp.pos, sp.yaw, gameTime + MATCH.spawnProtection);
    this.playerAlive = true;
    if (!initial && this.onPlayerRespawn) this.onPlayerRespawn();
  }

  // D5 spawn selection: among a team's points, choose the one FARTHEST from the
  // nearest living ENEMY, breaking ties toward the point that's clearest of
  // other combatants. Returns the whole {pos, yaw} spawn (caller needs the yaw).
  // Dev assert warns if the chosen point overlaps geometry.
  _pickSpawn(points, forWhom) {
    const enemies = this._enemiesTeamOf(forWhom);
    let bestSpawn = points[0];
    let bestScore = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const pt = points[i].pos;
      // Distance to the nearest living enemy (bigger = safer).
      let nearestEnemy = Infinity;
      for (let e = 0; e < enemies.length; e++) {
        const en = enemies[e];
        if (en.dead) continue;
        _v.set(en.pos.x - pt.x, 0, en.pos.z - pt.z);
        const d = _v.lengthSq();
        if (d < nearestEnemy) nearestEnemy = d;
      }
      if (nearestEnemy === Infinity) nearestEnemy = 1e6; // no living enemies → any is fine
      // Penalty if a living combatant is already standing on this point.
      let occupied = 0;
      for (let c = 0; c < this.allCombatants.length; c++) {
        const cc = this.allCombatants[c];
        if (cc === forWhom || cc.dead) continue;
        _v.set(cc.pos.x - pt.x, 0, cc.pos.z - pt.z);
        if (_v.lengthSq() < 1.2 * 1.2) occupied += 1;
      }
      const score = nearestEnemy - occupied * 25; // occupancy strongly discourages a point
      if (score > bestScore) { bestScore = score; bestSpawn = points[i]; }
    }

    if (import.meta.env.DEV) this._assertClear(bestSpawn.pos);
    return bestSpawn;
  }

  // Dev-only depenetration assert (D5): warn if a spawn point overlaps any
  // static collider footprint (a bad hand-authored point). Cheap, dev-only.
  _assertClear(pt) {
    const hw = this.tuning.bodyRadiusXZ;
    for (let i = 0; i < this._staticCount; i++) {
      const c = this.dynamicColliders[i];
      if (pt.x - hw < c.max.x && pt.x + hw > c.min.x &&
          pt.z - hw < c.max.z && pt.z + hw > c.min.z &&
          0 < c.max.y && this.tuning.bodyHeight > c.min.y) {
        console.warn(`[hotfix] spawn point (${pt.x},${pt.z}) overlaps geometry — D5`);
        return;
      }
    }
  }

  // ---- Kill accounting -----------------------------------------------------
  _onCombatantKilled(victim, killer, isHead) {
    // Only ENEMY kills score. A kill by nothing (impossible now) doesn't count.
    if (killer && killer.team && killer.team !== victim.team) {
      this.scores[killer.team] += 1;
      if (this.onScoreChanged) this.onScoreChanged(this.scores.se, this.scores.bug);
    }

    // Kill-feed line (frontend renders; last 4, fading — G7).
    if (this.onKillFeed) {
      this.onKillFeed({
        killerName: killer ? killer.name : '—',
        killerTeam: killer ? killer.team : null,
        victimName: victim.name,
        victimTeam: victim.team,
        weapon: this._weaponOf(killer),
        isHead: !!isHead,
      });
    }

    if (victim === this.player) {
      this.playerAlive = false;
      this._playerRespawn = MATCH.respawnDelay;
      if (this.onPlayerDeath) {
        this.onPlayerDeath({
          killerName: killer ? killer.name : '—',
          killerTeam: killer ? killer.team : null,
          weapon: this._weaponOf(killer),
          isHead: !!isHead,
        });
      }
    } else {
      // A bot died: hide it, schedule respawn, tell the frontend (splat).
      victim.group.visible = false;
      victim._respawnTimer = MATCH.respawnDelay;
      if (this.onBotKilled) {
        this.onBotKilled(victim, { killerTeam: killer ? killer.team : null, isHead: !!isHead });
      }
    }

    this._checkWin();
  }

  // The weapon a killer used. Bots are rifle-only; the player's is its active
  // weapon at the moment of the kill (weapons.active). A null killer → 'rifle'
  // as a harmless default (never happens in Phase 3).
  _weaponOf(killer) {
    if (!killer) return 'rifle';
    if (killer === this.player) return this.weapons.active;
    return 'rifle'; // bots carry the symmetric rifle only
  }

  // ---- Bot shot feedback (per bullet) -------------------------------------
  _onBotShot(bot, shot) {
    // Positional shot sound + muzzle light-quad at the bot (frontend). The
    // KILL, if any, was already counted via applyDamage → onKilled above.
    if (this.onBotFired) this.onBotFired(bot);
    void shot; // shot.result is the shared bot hit result; frontend may read it synchronously if wired
  }

  // ---- Win / draw resolution ----------------------------------------------
  _checkWin() {
    if (this.state === 'over') return;
    if (this.scores.se >= MATCH.killTarget || this.scores.bug >= MATCH.killTarget) {
      this._endMatch();
    }
  }

  _endMatch() {
    this.state = 'over';
    this._overHold = MATCH.restartDelay;
    let winner;
    if (this.scores.se > this.scores.bug) winner = 'se';
    else if (this.scores.bug > this.scores.se) winner = 'bug';
    else winner = 'draw';
    this.result = { winner, se: this.scores.se, bug: this.scores.bug };
    if (this.onMatchEnd) this.onMatchEnd(this.result);
  }

  // ---- Team helpers --------------------------------------------------------
  _enemiesTeamOf(c) { return c.team === 'se' ? this.bugTeam : this.seTeam; }
  _alliesTeamOf(c) { return c.team === 'se' ? this.seTeam : this.bugTeam; }

  // ==========================================================================
  // PER-FRAME UPDATE. main.js calls this in the PLAYING branch. Order:
  //   1) refresh the player entity's hitboxes (bots aim at its current pose)
  //   2) detect player fire → break protection
  //   3) tick respawn countdowns + protection expiry
  //   4) rebuild the stable target/ally/collider arrays IN PLACE
  //   5) tick every living bot (senses cadence, movement, guns)
  //   6) tick the match clock + time-expiry win check
  // ==========================================================================
  update(dt) {
    // Even when 'over', keep the player hitboxes fresh and the world rendering,
    // but FREEZE bots (no fire/move) and stop the clock (§4B match-end).
    this.player.refresh();

    if (this.state === 'live') {
      this._detectPlayerFire();
      this._tickRespawns(dt);
    }

    // Clear expired spawn protection is implicit: protectedUntil is compared to
    // the live game clock in the target-list rebuild and everywhere else.
    this._rebuildLists();

    if (this.state === 'live') {
      const gameTime = this._gameTime();
      for (let i = 0; i < this.bots.length; i++) {
        const bot = this.bots[i];
        if (bot.dead || !bot.group.visible) continue;
        bot.update(
          dt,
          this._botEnemies.get(bot),
          this.staticColliders,    // STATIC world only: teammates don't block a bot's
                                   //   movement (separation handles bot-bot), its LOS,
                                   //   or its bullets (friendly fire OFF). Bots are
                                   //   obstacles for the PLAYER (dynamicColliders), not
                                   //   for each other.
          this._botAllies.get(bot),
          gameTime,
        );
      }

      // v2.3 props: chickens wander + respawn, football rolls; the football is
      // nudged by every living combatant it touches (player + bots).
      this.props.update(dt, this.allCombatants);

      // Advance the clock; time expiry ends the match (higher score wins, tie=draw).
      this.clock = Math.max(0, this.clock - dt);
      if (this.clock <= 0) this._endMatch();
    } else {
      // Over: hold the end screen; a restart is allowed after the hold (the
      // shell decides whether to auto-restart or wait for input).
      if (this._overHold > 0) this._overHold = Math.max(0, this._overHold - dt);
    }
  }

  _gameTime() { return MATCH.timeLimit - this.clock; }

  // Detect a player shot to break spawn protection early (§4B — no protected
  // camping). The WeaponSystem exposes `shotsFired`, a monotonic count of REAL
  // shots (post dry-fire early-return, all weapons — see weapons.js) that we
  // snapshot and compare. This is weapon-agnostic and immune to reload/switch
  // artifacts (a switch or reload never advances shotsFired). Far cleaner than
  // watching the mag, and exactly the fire signal the WeaponSystem intends.
  _detectPlayerFire() {
    const n = this.weapons.shotsFired;
    if (this.playerAlive && n > this._lastShotsFired) this.player.notifyFired();
    this._lastShotsFired = n;
  }

  // Tick player + bot respawn countdowns (game-time). On expiry, respawn at a
  // safe spawn with a fresh protection window.
  _tickRespawns(dt) {
    if (!this.playerAlive && this._playerRespawn > 0) {
      this._playerRespawn -= dt;
      if (this._playerRespawn <= 0) {
        this._playerRespawn = 0;
        this._spawnPlayer(this._gameTime(), false);
        // No fire-snapshot reseed needed: shotsFired is monotonic and a refill
        // never advances it, so the respawn can't be mis-read as a shot.
      }
    }
    // Bots — iterate the fixed roster array (zero-alloc; no Map iterator/pair).
    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      if (bot._respawnTimer <= 0) continue; // living (0) or already respawned
      bot._respawnTimer -= dt;
      if (bot._respawnTimer <= 0) {
        bot._respawnTimer = 0;
        const points = bot.team === 'se' ? this.seSpawns : this.bugSpawns;
        const sp = this._pickSpawn(points, bot); // {pos, yaw}
        yawToForward(sp.yaw, _fwd);
        bot.spawnAt(sp.pos, _fwd, this._gameTime() + MATCH.spawnProtection, this.graph.nearestNode(sp.pos));
      }
    }
  }

  // Rebuild every stable target/ally list + the player-collider array IN PLACE
  // (I1: no new arrays; reset .length and push into the same objects). A
  // combatant is a valid TARGET iff it's living AND not spawn-protected (F10):
  // exclusion from the list is exactly its damage-immunity + bot de-prioritize.
  _rebuildLists() {
    const gt = this._gameTime();

    // Player's enemy list = living, unprotected Bugs.
    const pe = this.enemiesOfPlayer;
    pe.length = 0;
    for (let i = 0; i < this.bugBots.length; i++) {
      const b = this.bugBots[i];
      if (!b.dead && !(b.protectedUntil > gt)) pe.push(b);
    }
    // v2.3: living chickens ride the SAME player target list so the stock
    // hitscan hits them (they expose the head/body hit surface). They carry their
    // own applyDamage (1-shot → personal points), so a hit never enters the team
    // applyDamage/onKilled combat path — no friendly-fire or score interaction.
    const chickens = this.props.chickens;
    for (let i = 0; i < chickens.length; i++) {
      if (!chickens[i].dead) pe.push(chickens[i]);
    }

    // Per-bot enemy + ally lists.
    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      const enemies = this._botEnemies.get(bot);
      const allies = this._botAllies.get(bot);
      enemies.length = 0;
      allies.length = 0;

      const enemyTeam = this._enemiesTeamOf(bot);
      for (let e = 0; e < enemyTeam.length; e++) {
        const en = enemyTeam[e];
        if (en.dead) continue;
        if (en.protectedUntil > gt) continue; // protected → not targetable, not hittable (F10)
        // The player entity is a valid enemy for Bug bots; it's in bugTeam's
        // opposing set (seTeam) — enemyTeam already resolves that.
        enemies.push(en);
      }
      const allyTeam = this._alliesTeamOf(bot);
      for (let a = 0; a < allyTeam.length; a++) {
        const al = allyTeam[a];
        if (al === bot || al.dead) continue;
        // Only BOTS separate (the player pushes bots via the collider, not the
        // soft separation). Skip the player entity in the ally-separation list.
        if (al === this.player) continue;
        allies.push(al);
      }
    }

    // Rebuild dynamicColliders: static room prefix (fixed, [0, _staticCount) —
    // never overwritten) + one AABB per living bot appended from the
    // preallocated pool. Array IDENTITY is preserved (PlayerController holds this
    // reference); only the tail is rewritten and .length trimmed — no realloc.
    // This array is the PLAYER's movement collider set; the player isn't in it,
    // so no self-collision, and bots collide against the STATIC set (not this),
    // so no per-bot self-skip is needed either.
    let n = this._staticCount;
    let poolIdx = 0;
    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      if (bot.dead || !bot.group.visible) continue;
      const slot = this._colliderPool[poolIdx++];
      bot.writeCollider(slot);
      this.dynamicColliders[n++] = slot;
    }
    this.dynamicColliders.length = n; // drop stale tail slots (in place; no realloc of the prefix)
  }

  // ---- Restart (no page reload) -------------------------------------------
  // Full reset: scores, clock, everyone respawned, protections re-armed. The
  // difficulty may have changed between matches → re-fold the tuning.
  restart() {
    this.tuning = getBotTuning();
    for (let i = 0; i < this.bots.length; i++) this.bots[i].tuning = this.tuning;

    this.scores.se = 0;
    this.scores.bug = 0;
    this.clock = MATCH.timeLimit;
    this.state = 'live';
    this.result = null;
    this._overHold = 0;
    this._playerRespawn = 0;
    // Bot respawn timers are cleared by spawnAt() in _spawnEveryone below.

    // Names + baked head-label textures persist across a restart (they're
    // already unique and rebuilding CanvasTextures would allocate for no gain) —
    // the bots keep their identity, only the match state resets.
    this._spawnEveryone();
    this._lastShotsFired = this.weapons.shotsFired; // reseed the fire snapshot
    if (this.onScoreChanged) this.onScoreChanged(0, 0);
  }
}
