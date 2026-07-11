// ============================================================================
// Bot — an AI Combatant (entities.js duck-type) for both teams. Bots fight each
// other autonomously; the match is alive with no player. NO physics engine
// (kinematic mover on the waypoint graph), NO reuse of the input-driven player
// WeaponSystem — a bot carries a lean symmetric BotGun instead.
//
// "Bots must feel human, not aimbot" (the graded Phase-3 checklist item). The
// senses/aim model, all tuned from BOTS (config.js, folded per difficulty):
//   • LOS: head→target-head ray vs WORLD colliders only (rayBlocked), checked
//     every losInterval s, STAGGERED per bot (phase offset) so they never all
//     raycast the same frame.
//   • Reaction: on (re)acquiring LOS, the first shot is delayed by
//     max(0, gauss(reactionMean, reactionSd)), precomputed per acquisition.
//   • Aim error: an angular cone starting at aimErrorStartDeg and tightening
//     exponentially toward aimErrorMinDeg over tightenTime while LOS holds;
//     resets on LOS loss. EXTRA error ∝ the target's lateral speed across the
//     bot's view (strafePenaltyDegPerMs — dodging is rewarded) and ∝ the bot's
//     OWN movement speed (selfMoveErrorDeg).
//   • Burst discipline: burstShots ± burstJitter, then burstPauseMs; a small
//     first-shot-of-burst extra delay.
//   • Target selection: nearest visible living enemy, skipping spawn-protected
//     ones; re-evaluated on target death/LOS loss; targetSwitchPenalty
//     hysteresis so focus doesn't jitter between two equidistant foes.
//   • Headshots: aim the BODY center by default; with headAimChance an
//     acquisition aims at the head. Never a laser lock.
// Damage is ALWAYS COMBAT.rifle.body / headMult — difficulty never touches it.
//
// Movement states: 'patrol' (random neighbor walks, per-bot desync), 'engage'
// (hold near the current node with lateral strafe jitter, facing the target),
// 'hunt' (BFS toward the last-known node of the nearest enemy). Speed
// MOVE.runSpeed, exponential accel (B2), floor-locked (y=0 — flat maps by
// design; bots do NOT jump. Documented; Phase 4 revisits with real verticality).
// Pairwise separation push (separationRadius) so bots never stack. Each bot
// exposes a dynamic AABB the match maintains and feeds the player collider.
//
// Timing: everything ticks off game dt (B6) — no setTimeout. Aim/reaction
// randomness uses Math.random (fine for gameplay, matching weapons.js spread).
// Zero per-frame allocations: module scratch + in-place writes (I1).
// ============================================================================

import * as THREE from 'three';
import { COMBAT, BOTS, MOVE, PERF, CHARACTER } from '../config.js';
import { castRay, rayBlocked, makeHitResult } from '../combat/hitscan.js';
import { applyDamage, falloffMult } from '../combat/damage.js';
import { CharAnim } from './charAnim.js';

// -- Theme palette (low-poly, flat Lambert). v1.1 LOOKS pass: richer silhouettes
// built from primitives, but the HITBOXES ARE FROZEN — the extra meshes are pure
// cosmetic children; nothing here changes BODY/HEAD_CENTER_Y or _refreshHitboxes.
// Bug = team-red / sickly family; SE = teal/slate family (stay in prodMap PALETTE).
const BUG_THORAX = 0x35202a;   // front segment (a touch warmer/redder)
const BUG_ABDOMEN = 0x281820;  // rear segment (darker, sickly)
const BUG_LEG = 0x160f14;      // near-black articulated leg stubs
const BUG_ANTENNA = 0x4a2630;  // dull red antennae
const BUG_HEAD_BG = '#2a0508'; // error-label badge plate (darker red terminal tag)
const BUG_HEAD_FG = '#ff6f63'; // error-label text (brighter mono — reads as a glowing tag)
const SE_TORSO = 0x566079;     // slate hoodie (matches the dummy body / prod palette)
const SE_TORSO_HOOD = 0x455069; // darker two-tone hood/shoulder
const SE_HEAD = 0x6b7690;      // head block (lighter slate)
const SE_VISOR = 0x3fb89e;     // teal visor/face hint (SE identity)
const SE_LIMB = 0x3f4860;      // arms/legs (dark slate)
const SE_GUN = 0x232838;       // the little held rifle box (so fights read)
const SE_LABEL_BG = '#12303a';
const SE_LABEL_FG = '#9fe8d6';

// Body box dims — reuse the dummy footprint so hit feel matches the practice
// targets, and the head sits where the head-sphere is.
const BODY = { x: 0.55, y: 1.15, z: 0.35 };
const HEAD_EDGE = 0.34;      // visual head cube / badge edge
const HEAD_GAP = 0.06;
const HEAD_CENTER_Y = BODY.y + HEAD_GAP + HEAD_EDGE / 2; // above feet

// Module scratch — zero allocations per frame across ALL bots (I1). Bots tick
// sequentially, so sharing these across bots is normally safe. THE ONE
// re-entrancy: a bot's _tryFire → gun.fire → applyDamage(victim) synchronously
// runs victim.onDamagedInternal, which does its OWN vector math. To keep that
// from clobbering the FIRING bot's scratch, onDamagedInternal uses a DEDICATED
// scratch (_dmgReact) — never these. (It also calls _forcePath → graph BFS,
// which is safe only because the firing bot has already finished its own BFS in
// _move before _tryFire runs — an ordering the code preserves; see the note on
// onDamagedInternal.)
const _toTarget = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _aimDir = new THREE.Vector3();
const _aimRight = new THREE.Vector3();
const _aimUp = new THREE.Vector3();
const _aimPoint = new THREE.Vector3();
const _dmgReact = new THREE.Vector3(); // ONLY onDamagedInternal — see the re-entrancy note above
const _WORLD_UP = new THREE.Vector3(0, 1, 0);
const _botHit = makeHitResult(); // BotGun's private hit result (never the player's)

// Box-2π gauss (Box–Muller) → standard normal. Cheap; called only on LOS
// (re)acquisition, never per frame.
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// BotGun — the lean symmetric rifle a bot fires. Reads COMBAT.rifle for damage
// AND fire interval so a bot's RPM matches a player's rifle exactly (§4B). It
// casts the SAME hitscan the player does (castRay) from the bot's headCenter,
// tests only the bot's living ENEMIES (friendly fire OFF — teammates neither
// block nor take the bullet), and routes through the single applyDamage entry
// (F1). It does NOT own reload/mag state — bots have effectively continuous
// ammo gated only by burst discipline (a Phase-4 concern to add mag pressure).
// ---------------------------------------------------------------------------
class BotGun {
  constructor(bot) {
    this.bot = bot;
    this.cooldown = 0; // game-time; ≤0 ⇒ may fire (B3)
  }

  tick(dt) {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
  }

  ready() { return this.cooldown <= 0; }

  // Fire one shot along UNIT dir from the bot's head. enemies = the bot's live
  // enemy list (match maintains it). world = the static + dynamic colliders the
  // shot can be blocked by. isHeadAim just tags intent; the actual head/body
  // outcome is decided by castRay's geometry (a head-aimed shot that clips the
  // body is a body hit — honest).
  fire(dir, enemies, world) {
    this.cooldown = COMBAT.rifle.fireInterval; // next-shot accumulator (B3)

    const origin = this.bot.headCenter;
    castRay(origin, dir, 1000, world, enemies, _botHit); // "unlimited" reach; range shows up as damage falloff below (§4), matches the player rifle

    // A bot firing breaks its OWN spawn protection (§4B — same rule as the
    // player; a protected bot that shoots is fair game).
    this.bot.protectedUntil = 0;

    let victim = null, isHead = false, killed = false;
    if (_botHit.hitSomething && _botHit.target) {
      isHead = _botHit.isHead;
      // §4 range model — IDENTICAL math + order to the player (weapons.js): head
      // multiplier FIRST, then falloff by the hit distance, then Math.round.
      // Symmetry is sacred (§4B): a bot's long-range headshot loses its one-shot
      // exactly as a player's does. Bots carry the symmetric rifle → 'rifle'.
      const pre = isHead ? COMBAT.rifle.body * COMBAT.rifle.headMult : COMBAT.rifle.body;
      const dmg = Math.round(pre * falloffMult('rifle', _botHit.dist));
      const res = applyDamage(_botHit.target, dmg, this.bot, isHead); // source = the bot (kill credit)
      victim = _botHit.target;
      killed = res.killed;
    }
    // Report the shot to the match for feedback (positional sound / muzzle) and
    // kill accounting. result is the shared _botHit — the match reads it
    // synchronously in onBotShot (like weapons.js onShotResolved).
    return { victim, isHead, killed, result: _botHit };
  }
}

let _nextBotId = 1000; // bot ids start above any plausible player id

export class Bot {
  /**
   * @param {string} name
   * @param {'se'|'bug'} team
   * @param {object} graph   WaypointGraph (waypoints.js)
   * @param {object} tuning  folded BOTS+preset (config.getBotTuning())
   * @param {number} index   position in the roster — seeds the LOS stagger phase
   */
  constructor(name, team, graph, tuning, index) {
    this.id = _nextBotId++;
    this.name = name;
    this.team = team;
    this.graph = graph;
    this.tuning = tuning;

    // --- Combatant duck-type (entities.js) ---------------------------------
    this.maxHp = COMBAT.maxHealth;
    this.hp = COMBAT.maxHealth;
    this.dead = false;
    this.pos = new THREE.Vector3();      // feet
    this.forward = new THREE.Vector3(0, 0, team === 'se' ? -1 : 1); // face the enemy end
    this.bodyMin = new THREE.Vector3();
    this.bodyMax = new THREE.Vector3();
    this.headCenter = new THREE.Vector3();
    this.headRadius = COMBAT.headRadius + 0.06; // generous, like dummies/player (E3)
    this.protectedUntil = 0;

    // Feedback hooks. The match points the applyDamage (F1) duck-type hook
    // `onDamaged` straight at onDamagedInternal (raises flinch + drives the
    // "shot from behind → turn & hunt" reaction), which then relays to the
    // frontend slot `_frontendDamaged` (no recursion). onShot fires per bullet
    // (positional sound / muzzle light-quad); onKilled fires on death.
    this.onDamaged = null;        // set by match → onDamagedInternal (applyDamage hook)
    this._frontendDamaged = null; // (info) — frontend feedback (positional hit fx)
    this.onKilled = null;         // (info) — { source, isHead, ... }
    this.onShot = null;           // (bot, { victim, isHead, killed, result }) — match wires it

    // Respawn countdown (game-time seconds) the MATCH owns/ticks. >0 ⇒ this bot
    // is dead and waiting to respawn. A per-bot field (not a Map) so the match's
    // respawn tick iterates the fixed roster array with zero allocations (I1).
    this._respawnTimer = 0;

    // --- Movement/kinematic state ------------------------------------------
    this.vel = new THREE.Vector3();
    this.gun = new BotGun(this);
    this.curNode = 0;         // node the bot is currently at / leaving
    this.targetNode = 0;      // node it's walking toward
    this._pathBuf = new Int16Array(graph.nodes.length); // preallocated BFS out (I1)
    this._pathLen = 0;
    this._pathIdx = 0;
    this._repathTimer = 0;

    // --- AI state ----------------------------------------------------------
    this.state = 'patrol';    // 'patrol' | 'engage' | 'hunt'
    this.target = null;       // current enemy Combatant or null
    this._losTimer = (index * 0.017) % tuning.losInterval; // STAGGER: phase-offset per bot
    this._hasLos = false;
    this._losGrace = 0;       // s of tolerated LOS loss before dropping engagement
    this._reactionTimer = 0;  // s until the first shot after (re)acquiring LOS
    this._acquired = false;   // has the reaction delay elapsed for this acquisition?
    this._aimTightenT = 0;    // s of continuous LOS — drives the cone tightening
    this._burstLeft = 0;      // shots remaining in the current burst
    this._burstPause = 0;     // s of forced pause between bursts
    this._headAimThisAcq = false; // did this acquisition roll a head aim?
    this._lastKnownNode = -1; // node nearest the target's last-seen position (hunt goal)

    // Per-bot finite-difference of the target's position → its lateral speed
    // across our view (the player entity exposes no .vel, so we measure it). Own
    // vector per bot (module scratch can't persist per-bot across frames).
    this._prevTargetPos = new THREE.Vector3();
    this._prevTargetId = -1; // resets the difference when the target changes
    this._lastDt = 1 / 60;   // last frame's dt, for the m/s conversion

    // Engage strafe jitter (lateral dodge while fighting).
    this._strafeSign = Math.random() < 0.5 ? -1 : 1;
    this._strafeTimer = this._randStrafeTime();

    // --- Meshes ------------------------------------------------------------
    this.group = new THREE.Group();
    this.flinch = 0;          // s flinch flag (the CharAnim renders it, like dummies' TargetFx)
    this._animIndex = index;  // seeds the animator's per-bot stride phase (desync)
    this.anim = null;         // set by _buildBug/_buildSe (procedural transform animator)
    if (team === 'bug') this._buildBug();
    else this._buildSe();
    this.group.visible = false; // match spawns → places → shows

    this._refreshHitboxes();
  }

  // ---- Mesh construction (low-poly, built here like targets.js) -----------
  //
  // v1.1 LOOKS: both figures hang their body + limbs off a `_bobGroup` (an
  // Object3D at the group origin) so the animator can bob the whole torso in Y
  // without moving the group origin — feet stay planted and, crucially, the
  // HITBOXES are computed from this.pos in _refreshHitboxes (NOT from any mesh
  // transform), so this cosmetic bob never touches a hit volume. Swinging limbs
  // are children in LOCAL space, carried by the group yaw for free. `tintMats`
  // collects every Lambert material so the animator can flash them on flinch/
  // death (bots have no separate render-fx pass — the animator IS that pass).
  // `bodyMesh`/`headMesh`/`_nameLabel` keep their meaning for the combat/FX
  // contract (bodyMesh = primary torso, headMesh = head/badge at the hitbox).

  _buildBug() {
    const bob = new THREE.Group();
    this.group.add(bob);
    this._bobGroup = bob;
    const tintMats = [];
    const legs = [], antennae = [];

    // Two-segment body: thorax (front, larger) + abdomen (rear, tapered). Their
    // combined footprint reads as the squat bug body; bodyMesh = the thorax
    // (primary torso, the tint anchor). Slightly different tones per the brief.
    const thoraxMat = new THREE.MeshLambertMaterial({ color: BUG_THORAX });
    const thorax = new THREE.Mesh(new THREE.BoxGeometry(BODY.x, BODY.y * 0.62, BODY.z * 1.05), thoraxMat);
    thorax.position.set(0, BODY.y * 0.42, -BODY.z * 0.18); // front-heavy
    thorax.castShadow = PERF.shadows;
    bob.add(thorax);
    this.bodyMesh = thorax;
    tintMats.push(thoraxMat);

    const abdoMat = new THREE.MeshLambertMaterial({ color: BUG_ABDOMEN });
    const abdomen = new THREE.Mesh(new THREE.BoxGeometry(BODY.x * 0.82, BODY.y * 0.5, BODY.z * 0.95), abdoMat);
    abdomen.position.set(0, BODY.y * 0.3, BODY.z * 0.55); // sits behind + lower
    abdomen.castShadow = PERF.shadows;
    bob.add(abdomen);
    tintMats.push(abdoMat);

    // Four articulated leg stubs (two per side), each pivoting from a hip nub
    // near the thorax. The animator swings them in alternating pairs (a skitter).
    // Each leg is a child Group so rotation.x pivots from the hip, not the mesh
    // centre. (4 legs keeps the per-bot mesh count ≤10 — draw-call budget I6.)
    const legMat = new THREE.MeshLambertMaterial({ color: BUG_LEG });
    tintMats.push(legMat);
    const legGeo = new THREE.BoxGeometry(0.07, 0.05, 0.26);
    const hipX = BODY.x / 2 - 0.02;
    for (let i = 0; i < 4; i++) {
      const side = i < 2 ? -1 : 1;
      const row = i % 2;                       // 0 front, 1 rear
      const hip = new THREE.Group();
      hip.position.set(side * hipX, 0.17, (row === 0 ? -1 : 1) * BODY.z * 0.35);
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(side * 0.11, -0.06, 0); // splay out + down from the hip
      leg.rotation.z = side * 0.5;
      leg.castShadow = PERF.shadows;
      hip.add(leg);
      bob.add(hip);
      legs.push(hip); // animate the HIP pivot (rotation.x)
    }

    // Two short antennae off the front, above the badge.
    const antMat = new THREE.MeshLambertMaterial({ color: BUG_ANTENNA });
    tintMats.push(antMat);
    const antGeo = new THREE.BoxGeometry(0.03, 0.22, 0.03);
    for (let i = 0; i < 2; i++) {
      const base = new THREE.Group();
      base.position.set((i === 0 ? -1 : 1) * 0.1, HEAD_CENTER_Y + HEAD_EDGE * 0.4, -BODY.z * 0.35);
      const ant = new THREE.Mesh(antGeo, antMat);
      ant.position.y = 0.11;
      ant.rotation.x = -0.35; // lean forward
      base.add(ant);
      bob.add(base);
      antennae.push(base);
    }

    // Error-label head badge — the label IS the head hitbox. Glowing terminal tag.
    this._buildLabelHead(BUG_HEAD_BG, BUG_HEAD_FG, bob);

    this.anim = new CharAnim('bug', {
      legs, antennae, bobGroup: bob, tintMats,
    }, this._animIndex);
  }

  _buildSe() {
    const bob = new THREE.Group();
    this.group.add(bob);
    this._bobGroup = bob;
    const tintMats = [];
    const legs = [], arms = [];

    // Two-tone torso: a hoodie body + a darker hood/shoulder cap on top. bodyMesh
    // = the main torso (tint anchor). Torso is a touch shorter than BODY.y so legs
    // fill the bottom; the overall silhouette still fills the frozen body box.
    const torsoMat = new THREE.MeshLambertMaterial({ color: SE_TORSO });
    const torso = new THREE.Mesh(new THREE.BoxGeometry(BODY.x, BODY.y * 0.55, BODY.z), torsoMat);
    torso.position.y = BODY.y * 0.58;
    torso.castShadow = PERF.shadows;
    bob.add(torso);
    this.bodyMesh = torso;
    tintMats.push(torsoMat);

    const hoodMat = new THREE.MeshLambertMaterial({ color: SE_TORSO_HOOD });
    const hood = new THREE.Mesh(new THREE.BoxGeometry(BODY.x * 1.02, BODY.y * 0.18, BODY.z * 1.04), hoodMat);
    hood.position.y = BODY.y * 0.82;
    hood.castShadow = PERF.shadows;
    bob.add(hood);
    tintMats.push(hoodMat);

    // Head block with a teal visor slab hint (the "face"). headMesh = the block,
    // sitting at HEAD_CENTER_Y (the hit zone). The visor is a thin basic-lit slab
    // (kept off the tint list so it reads as an emissive-ish face accent).
    const headMat = new THREE.MeshLambertMaterial({ color: SE_HEAD });
    const head = new THREE.Mesh(new THREE.BoxGeometry(HEAD_EDGE, HEAD_EDGE, HEAD_EDGE), headMat);
    head.position.y = HEAD_CENTER_Y;
    head.castShadow = PERF.shadows;
    bob.add(head);
    this.headMesh = head;
    tintMats.push(headMat);

    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(HEAD_EDGE * 0.86, HEAD_EDGE * 0.32, 0.03),
      new THREE.MeshBasicMaterial({ color: SE_VISOR }), // basic: the visor stays lit/legible
    );
    visor.position.set(0, HEAD_CENTER_Y + 0.02, -HEAD_EDGE / 2 - 0.005);
    bob.add(visor);

    // Two legs (pivot from the hip, filling the lower body box) that walk-swing.
    const limbMat = new THREE.MeshLambertMaterial({ color: SE_LIMB });
    tintMats.push(limbMat);
    const legGeo = new THREE.BoxGeometry(0.17, BODY.y * 0.42, BODY.z * 0.9);
    for (let i = 0; i < 2; i++) {
      const hip = new THREE.Group();
      hip.position.set((i === 0 ? -1 : 1) * BODY.x * 0.24, BODY.y * 0.32, 0);
      const leg = new THREE.Mesh(legGeo, limbMat);
      leg.position.y = -BODY.y * 0.2; // hang below the hip
      leg.castShadow = PERF.shadows;
      hip.add(leg);
      bob.add(hip);
      legs.push(hip);
    }

    // Two arms in a held-rifle pose, angled forward. The RIGHT arm carries a
    // small gun box so fights read at a glance. Arms pivot from the shoulder.
    const armGeo = new THREE.BoxGeometry(0.11, BODY.y * 0.4, 0.13);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const shoulder = new THREE.Group();
      shoulder.position.set(side * (BODY.x / 2 + 0.02), BODY.y * 0.72, 0);
      shoulder.rotation.x = -0.5; // arms forward, holding a weapon
      const arm = new THREE.Mesh(armGeo, limbMat);
      arm.position.y = -BODY.y * 0.18;
      arm.castShadow = PERF.shadows;
      shoulder.add(arm);
      bob.add(shoulder);
      arms.push(shoulder);
    }
    // A little rifle in the hands, parented to the right shoulder so it rides the
    // arm swing. Pure cosmetic (bots hitscan from headCenter; this fires nothing).
    const gun = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.09, 0.5),
      new THREE.MeshLambertMaterial({ color: SE_GUN }),
    );
    gun.position.set(-BODY.x * 0.28, -BODY.y * 0.34, -0.2);
    arms[1].add(gun); // right shoulder holds it forward
    tintMats.push(gun.material);

    this._buildNameLabel(SE_LABEL_BG, SE_LABEL_FG, HEAD_CENTER_Y + HEAD_EDGE / 2 + 0.14, bob);

    this.anim = new CharAnim('se', {
      legs, arms, bobGroup: bob, tintMats,
    }, this._animIndex);
  }

  // A CanvasTexture badge box that renders the bot's name in monospace. For a
  // Bug this box occupies the head slot (it's the hit target). Built once; the
  // texture never updates per frame (I1/G2-style discipline). Basic-lit so it
  // reads as a glowing terminal tag and is EXCLUDED from the tint list.
  _buildLabelHead(bg, fg, parent) {
    const tex = this._nameTexture(this.name, bg, fg);
    // A slightly flattened box so the label reads on the front/back faces.
    const geo = new THREE.BoxGeometry(HEAD_EDGE * 1.9, HEAD_EDGE, 0.06);
    const mat = new THREE.MeshBasicMaterial({ map: tex }); // basic: label stays legible unlit
    const head = new THREE.Mesh(geo, mat);
    head.position.y = HEAD_CENTER_Y;
    (parent ?? this.group).add(head);
    this.headMesh = head;
  }

  _buildNameLabel(bg, fg, y, parent) {
    const tex = this._nameTexture(this.name, bg, fg);
    const geo = new THREE.PlaneGeometry(0.9, 0.24);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
    const label = new THREE.Mesh(geo, mat);
    label.position.y = y;
    this._nameLabel = label;
    (parent ?? this.group).add(label);
  }

  // Render `text` to a small canvas → CanvasTexture. Allocated once per bot at
  // construction (never per frame). Theme colors passed in.
  _nameTexture(text, bg, fg) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = bg;
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = fg;
    g.font = 'bold 30px monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // Shrink overly long error labels to fit the badge width.
    let size = 30;
    while (g.measureText(text).width > c.width - 16 && size > 12) {
      size -= 2; g.font = `bold ${size}px monospace`;
    }
    g.fillText(text, c.width / 2, c.height / 2 + 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  // ---- Hitboxes + mesh transform from feet pos (called every frame) -------
  _refreshHitboxes() {
    const p = this.pos;
    // HIT AABB uses the wider of x/z as the half-extent so a yawed body is still
    // fully covered (same convention as the dummy, E3-generous). This is the
    // SHOOTABLE box; the MOVEMENT collider (writeCollider) uses bodyRadiusXZ.
    const halfXZ = Math.max(BODY.x, BODY.z) / 2;
    this.bodyMin.set(p.x - halfXZ, p.y, p.z - halfXZ);
    this.bodyMax.set(p.x + halfXZ, p.y + BODY.y, p.z + halfXZ);
    this.headCenter.set(p.x, p.y + HEAD_CENTER_Y, p.z);
  }

  // The dynamic MOVEMENT collider AABB the match feeds the player controller.
  // Written into a caller-provided collider object (zero-alloc; the match owns
  // a preallocated pool of these). Uses bodyRadiusXZ (matches player halfWidth).
  writeCollider(out) {
    const p = this.pos;
    const hw = this.tuning.bodyRadiusXZ;
    out.min.set(p.x - hw, p.y, p.z - hw);
    out.max.set(p.x + hw, p.y + this.tuning.bodyHeight, p.z + hw);
  }

  // ---- Spawn / placement --------------------------------------------------
  spawnAt(feetPos, faceForward, protectUntil, nodeIdx) {
    this.hp = this.maxHp;
    this.dead = false;
    this._respawnTimer = 0; // clear any pending respawn countdown
    this.pos.copy(feetPos);
    this.vel.set(0, 0, 0);
    this.protectedUntil = protectUntil;
    if (faceForward) this.forward.copy(faceForward).setY(0).normalize();

    this.curNode = nodeIdx;
    this.targetNode = nodeIdx;
    this._pathLen = 0; this._pathIdx = 0;
    this.state = 'patrol';
    this.target = null;
    this._hasLos = false; this._acquired = false; this._losGrace = 0;
    this._aimTightenT = 0; this._burstLeft = 0; this._burstPause = 0;
    this._reactionTimer = 0; this._headAimThisAcq = false;
    this._lastKnownNode = -1;
    this.flinch = 0;
    this._repathTimer = (this.id % 7) * 0.05; // desync repaths across bots

    this.group.visible = true;
    this.group.position.copy(feetPos);
    this._faceForwardMesh();
    this._refreshHitboxes();
  }

  _randStrafeTime() {
    const t = this.tuning;
    return t.strafeFlipMin + Math.random() * (t.strafeFlipMax - t.strafeFlipMin);
  }

  // ---- Damage feedback + "shot from behind" reaction ----------------------
  // The match wires this as the applyDamage (F1) duck-type hook. Raise the
  // flinch flag (frontend renders it); if the bot can't currently see its
  // attacker, turn toward the hit and hunt the attacker's node — bots must
  // react to being shot from behind. Then relay to the frontend feedback slot
  // (a SEPARATE field, so there's no recursion through this same hook).
  onDamagedInternal(info) {
    this.flinch = this.tuning.flinchTime;
    const attacker = info.source; // the firing Combatant (bot or player)
    // NOTE: this runs SYNCHRONOUSLY inside applyDamage, which is called from the
    // ATTACKER bot's _tryFire. So `this` here is a DIFFERENT bot than the one
    // mid-update. Use the dedicated _dmgReact scratch (never _toTarget/_desired/
    // _aim*) so we don't clobber the firing bot's in-flight vectors. _forcePath
    // runs a graph BFS — safe only because every bot finishes its own BFS in
    // _move (which precedes _tryFire), so no BFS is ever in progress here.
    if (attacker && attacker.pos && this.target !== attacker && !this._hasLos) {
      // Snap facing toward the damage source and switch to hunting its node.
      _dmgReact.set(attacker.pos.x - this.pos.x, 0, attacker.pos.z - this.pos.z);
      if (_dmgReact.lengthSq() > 1e-6) {
        this.forward.copy(_dmgReact).normalize();
        this._lastKnownNode = this.graph.nearestNode(attacker.pos);
        this.state = 'hunt';
        this._forcePath(this._lastKnownNode);
      }
    }
    if (this._frontendDamaged) this._frontendDamaged(info);
  }

  // ---- Per-frame AI + movement (match calls this for living bots) ---------
  // enemies: this bot's live enemy list. world: the FULL collider array (static
  // + dynamic bot AABBs) the shot/LOS test against. allies: same-team living
  // bots for separation. gameTime: match clock (for protection checks).
  update(dt, enemies, world, allBots, gameTime) {
    this._lastDt = dt; // for the target-lateral-speed finite difference
    this.gun.tick(dt);
    if (this.flinch > 0) this.flinch = Math.max(0, this.flinch - dt);

    this._sense(dt, enemies, world, gameTime);
    this._move(dt, allBots, world);
    this._tryFire(dt, enemies, world, gameTime);

    // Record the target's position for next frame's lateral-speed measurement.
    // _applyAimError reads _prevTargetPos (last frame's pos) BEFORE this runs;
    // the id keys whether that difference is valid (a fresh/switched target has
    // no prior, so lateral speed is skipped for one frame — no phantom speed).
    if (this.target) {
      this._prevTargetPos.copy(this.target.pos);
      this._prevTargetId = this.target.id;
    } else {
      this._prevTargetId = -1;
    }

    // Commit pose to the mesh + hitboxes.
    this.group.position.copy(this.pos);
    this._faceForwardMesh();
    this._refreshHitboxes();

    // Cosmetic procedural animation (transform-only, game dt) + flinch/death
    // tint. Runs AFTER hitboxes so it can never influence them; the animator
    // only writes child-mesh transforms + material emissive (I1). A living bot
    // is never dead here, but pass this.dead for edge-safety on the tint pass.
    if (this.anim) {
      const speed = Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z);
      this.anim.tick(dt, speed, this.flinch, this.tuning.flinchTime, this.dead);
    }
  }

  _faceForwardMesh() {
    // Yaw the whole group to face `forward` (XZ). atan2 of (x, z) → the group's
    // +? we want the body to visually face the aim; align its −z to forward.
    this.group.rotation.y = Math.atan2(this.forward.x, this.forward.z) + Math.PI;
    // Billboard the SE name label to stay upright/readable (cheap; only SEs).
    if (this._nameLabel) this._nameLabel.rotation.y = -this.group.rotation.y;
  }

  // ---- Senses: LOS (staggered), target selection, reaction, cone tighten --
  _sense(dt, enemies, world, gameTime) {
    // Age the reaction + LOS-grace timers every frame (they're time, not ticks).
    if (this._reactionTimer > 0) this._reactionTimer = Math.max(0, this._reactionTimer - dt);
    if (this._burstPause > 0) this._burstPause = Math.max(0, this._burstPause - dt);

    // LOS raycast on the staggered cadence (never every frame, never all bots
    // the same frame — the phase offset seeded in the ctor spreads them).
    this._losTimer -= dt;
    let recheck = false;
    if (this._losTimer <= 0) {
      this._losTimer += this.tuning.losInterval;
      recheck = true;
    }

    if (recheck) {
      // (Re)pick a target: nearest VISIBLE living enemy, skipping protected
      // ones, with switch hysteresis so focus is sticky.
      const picked = this._pickTarget(enemies, world, gameTime);
      const hadTarget = this.target;
      this.target = picked;

      const seesTarget = picked ? this._canSee(picked, world) : false;
      if (seesTarget) {
        if (!this._hasLos || this.target !== hadTarget) {
          // Fresh acquisition → arm the reaction delay + reset the aim cone.
          this._beginAcquisition();
        }
        this._hasLos = true;
        this._losGrace = this.tuning.loseSightGrace;
      } else {
        this._hasLos = false;
      }
    }

    // Between rechecks, decay the LOS grace; when it runs out, drop engagement.
    if (!this._hasLos) {
      if (this._losGrace > 0) {
        this._losGrace = Math.max(0, this._losGrace - dt);
      }
      this._acquired = false;
      this._aimTightenT = 0; // cone resets on LOS loss
    } else {
      // Continuous LOS → the cone tightens.
      this._aimTightenT += dt;
      if (this._reactionTimer <= 0) this._acquired = true;
    }

    // Decide movement state from senses.
    if (this._hasLos && this.target) {
      // Update last-known node whenever we see the target.
      this._lastKnownNode = this.graph.nearestNode(this.target.pos);
      _toTarget.set(this.target.pos.x - this.pos.x, 0, this.target.pos.z - this.pos.z);
      const dist = Math.sqrt(_toTarget.lengthSq());
      this.state = dist <= this.tuning.engageRange ? 'engage' : 'hunt';
    } else if (this._losGrace > 0 && this._lastKnownNode >= 0) {
      this.state = 'hunt'; // just lost sight — push to where they were
    } else if (this._lastKnownNode >= 0 && this.state === 'hunt') {
      // keep hunting toward the last known node until we arrive, then patrol
    } else {
      this.state = 'patrol';
    }
  }

  _beginAcquisition() {
    const t = this.tuning;
    this._reactionTimer = Math.max(0, t.reactionMean + gauss() * t.reactionSd);
    this._acquired = false;
    this._aimTightenT = 0;
    this._burstLeft = 0;      // a fresh burst starts once acquired
    this._headAimThisAcq = Math.random() < t.headAimChance; // roll head vs body aim
  }

  // Nearest living enemy the bot can see (LOS), skipping spawn-protected ones,
  // with switch hysteresis: a new candidate must be targetSwitchPenalty× closer
  // than the currently-held (still-valid) target to steal focus.
  _pickTarget(enemies, world, gameTime) {
    const cur = this.target;
    const curValid = cur && !cur.dead && this._canSee(cur, world) &&
      !(cur.protectedUntil > gameTime);
    let curDist = Infinity;
    if (curValid) {
      _toTarget.set(cur.pos.x - this.pos.x, 0, cur.pos.z - this.pos.z);
      curDist = _toTarget.lengthSq();
    }

    let best = curValid ? cur : null;
    let bestD = curValid ? curDist : Infinity;

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e || e.dead) continue;
      if (e.protectedUntil > gameTime) continue; // skip spawn-protected (F10)
      _toTarget.set(e.pos.x - this.pos.x, 0, e.pos.z - this.pos.z);
      const d = _toTarget.lengthSq();
      if (d > this.tuning.maxEngageDist * this.tuning.maxEngageDist) continue;
      if (!this._canSee(e, world)) continue;
      // Hysteresis: an enemy that ISN'T the current target must be clearly
      // closer (penalty² since we're comparing squared distances) to win.
      const threshold = (e === cur) ? d : d * (this.tuning.targetSwitchPenalty * this.tuning.targetSwitchPenalty);
      if (threshold < bestD) { bestD = (e === cur) ? d : threshold; best = e; }
    }
    return best;
  }

  // LOS: head→enemy-head vs WORLD-ONLY colliders (rayBlocked ignores characters
  // so friends don't block sight). Reuses _aimDir scratch.
  _canSee(enemy, world) {
    _aimDir.set(
      enemy.headCenter.x - this.headCenter.x,
      enemy.headCenter.y - this.headCenter.y,
      enemy.headCenter.z - this.headCenter.z,
    );
    const dist = _aimDir.length();
    if (dist < 1e-4) return true;
    _aimDir.multiplyScalar(1 / dist);
    return !rayBlocked(this.headCenter, _aimDir, dist, world);
  }

  // ---- Movement: patrol / engage / hunt + separation ----------------------
  _move(dt, allBots, world) {
    _desired.set(0, 0, 0);

    if (this.state === 'engage' && this.target) {
      // Hold near the current spot; add a lateral strafe relative to the target
      // (dodge). Face the target. Small in-place jitter, no waypoint walking.
      this._strafeTimer -= dt;
      if (this._strafeTimer <= 0) { this._strafeSign = -this._strafeSign; this._strafeTimer = this._randStrafeTime(); }
      _toTarget.set(this.target.pos.x - this.pos.x, 0, this.target.pos.z - this.pos.z);
      if (_toTarget.lengthSq() > 1e-6) {
        _toTarget.normalize();
        this.forward.copy(_toTarget); // face the enemy while fighting
        // Perpendicular (right-hand) direction for the strafe.
        _desired.set(-_toTarget.z, 0, _toTarget.x).multiplyScalar(this._strafeSign);
      }
      const strafeSpeed = MOVE.runSpeed * this.tuning.strafeSpeedFrac;
      _desired.multiplyScalar(strafeSpeed);
    } else if (this.state === 'hunt' && this._lastKnownNode >= 0) {
      // BFS toward the last-known node; walk the node chain.
      this._followPath(dt, this._lastKnownNode);
      this._steerToNode(_desired);
    } else {
      // Patrol: wander to a random neighbor, desynced per bot.
      this._patrol();
      this._steerToNode(_desired);
    }

    // Pairwise separation push so bots never stack (BOTS.separationRadius).
    this._separate(allBots);

    // Exponential accel toward the desired velocity (B2 — fps-independent).
    const k = 1 - Math.exp(-this.tuning.accel * dt);
    this.vel.x += (_desired.x - this.vel.x) * k;
    this.vel.z += (_desired.z - this.vel.z) * k;
    this.vel.y = 0; // floor-locked (flat map; bots don't jump — documented)

    // Integrate + resolve against world colliders (per-axis, like the player,
    // so bots slide along walls and can't walk through geometry).
    this._moveAxis('x', this.vel.x * dt, world);
    this._moveAxis('z', this.vel.z * dt, world);
    this.pos.y = 0; // hard floor lock
  }

  // Simple XZ AABB collide-and-slide against the STATIC world (mirrors the
  // controller's per-axis resolve, D1/D3). `colliders` is the static room set —
  // a bot does NOT collide against other bots (separation handles bot-vs-bot
  // softly, which reads better than hard blocking, and stops them wedging at a
  // shared spawn). Bots ARE hard obstacles for the PLAYER (the match appends
  // their AABBs to the player's collider array separately).
  _moveAxis(axis, delta, colliders) {
    if (delta === 0) return;
    this.pos[axis] += delta;
    const hw = this.tuning.bodyRadiusXZ;
    const h = this.tuning.bodyHeight;
    const p = this.pos;
    const EPS = 1e-3;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      const overlaps =
        p.x - hw < c.max.x && p.x + hw > c.min.x &&
        p.y < c.max.y && p.y + h > c.min.y &&
        p.z - hw < c.max.z && p.z + hw > c.min.z;
      if (!overlaps) continue;
      if (axis === 'x') { p.x = delta > 0 ? c.min.x - hw - EPS : c.max.x + hw + EPS; this.vel.x = 0; }
      else { p.z = delta > 0 ? c.min.z - hw - EPS : c.max.z + hw + EPS; this.vel.z = 0; }
    }
  }

  _steerToNode(out) {
    const target = this.graph.nodes[this.targetNode].pos;
    out.set(target.x - this.pos.x, 0, target.z - this.pos.z);
    const d2 = out.lengthSq();
    if (d2 > 1e-6) {
      out.multiplyScalar(1 / Math.sqrt(d2));
      out.multiplyScalar(MOVE.runSpeed);
      // While patrolling/hunting, face the direction of travel.
      if (this.state !== 'engage') this.forward.set(out.x, 0, out.z).normalize();
    }
  }

  _patrol() {
    const node = this.graph.nodes[this.curNode];
    _toTarget.set(node.pos.x - this.pos.x, 0, node.pos.z - this.pos.z);
    // Arrived at the current node? Pick a random neighbor to head to next.
    if (this.targetNode === this.curNode || _toTarget.lengthSq() < this.tuning.arriveRadius * this.tuning.arriveRadius) {
      const arrivedNode = this.graph.nodes[this.targetNode];
      this.curNode = this.targetNode;
      const links = arrivedNode.links;
      if (links.length > 0) {
        this.targetNode = links[(Math.random() * links.length) | 0];
      }
    }
  }

  // Advance along the BFS path to `goalNode`, repathing on the timer. Consumes
  // waypoints as the bot arrives at each.
  _followPath(dt, goalNode) {
    this._repathTimer -= dt;
    const needPath = this._pathLen === 0 || this._repathTimer <= 0 ||
      (this._pathLen > 0 && this._pathBuf[this._pathLen - 1] !== goalNode);
    if (needPath) {
      this._repathTimer = this.tuning.repathInterval;
      this._forcePath(goalNode);
    }
    if (this._pathLen === 0) return;

    // Have we reached the current path node? Advance the cursor.
    const cur = this._pathBuf[this._pathIdx];
    this.targetNode = cur;
    const np = this.graph.nodes[cur].pos;
    _toTarget.set(np.x - this.pos.x, 0, np.z - this.pos.z);
    if (_toTarget.lengthSq() < this.tuning.arriveRadius * this.tuning.arriveRadius) {
      this.curNode = cur;
      if (this._pathIdx < this._pathLen - 1) this._pathIdx++;
      this.targetNode = this._pathBuf[this._pathIdx];
    }
  }

  // (Re)compute the BFS path from the nearest node to `goalNode` into _pathBuf.
  _forcePath(goalNode) {
    const from = this.graph.nearestNode(this.pos);
    this._pathLen = this.graph.path(from, goalNode, this._pathBuf);
    this._pathIdx = 0;
    if (this._pathLen > 0) this.targetNode = this._pathBuf[0];
  }

  // Pairwise separation: push away from any ally closer than separationRadius.
  _separate(allBots) {
    const r = this.tuning.separationRadius;
    const r2 = r * r;
    let ax = 0, az = 0;
    for (let i = 0; i < allBots.length; i++) {
      const o = allBots[i];
      if (o === this || o.dead || !o.group.visible) continue;
      const dx = this.pos.x - o.pos.x;
      const dz = this.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const push = (r - d) / r; // 0 at the edge → 1 when overlapping
      ax += (dx / d) * push;
      az += (dz / d) * push;
    }
    _desired.x += ax * this.tuning.separationPush;
    _desired.z += az * this.tuning.separationPush;
  }

  // ---- Firing: reaction gate, aim cone, burst discipline ------------------
  _tryFire(dt, enemies, world, gameTime) {
    if (this.dead) return;
    if (!this._hasLos || !this.target || this.target.dead) return;
    if (!this._acquired || this._reactionTimer > 0) return; // still reacting
    if (this._burstPause > 0) return;                        // between-burst pause
    if (this.target.protectedUntil > gameTime) return;       // don't shoot a protected foe
    if (!this.gun.ready()) return;

    // Start a new burst if the last one is spent.
    if (this._burstLeft <= 0) {
      const t = this.tuning;
      const jitter = ((Math.random() * (2 * t.burstJitter + 1)) | 0) - t.burstJitter;
      this._burstLeft = Math.max(1, t.burstShots + jitter);
      // Small extra delay on the first shot of a burst (settle before firing).
      this.gun.cooldown = t.firstShotExtraMs / 1000;
      return; // fire the actual first shot next eligible frame
    }

    // Build the aim direction: base = head→(body-center | head, per acquisition
    // roll), then add the tightening cone + strafe/self-move error.
    this._computeAimPoint();
    _aimDir.set(
      _aimPoint.x - this.headCenter.x,
      _aimPoint.y - this.headCenter.y,
      _aimPoint.z - this.headCenter.z,
    );
    const dist = _aimDir.length();
    if (dist < 1e-4) return;
    _aimDir.multiplyScalar(1 / dist);

    this._applyAimError(_aimDir);

    // Fire. The match reads the returned result synchronously for feedback.
    const shot = this.gun.fire(_aimDir, enemies, world);
    this._burstLeft--;
    if (this._burstLeft <= 0) this._burstPause = this.tuning.burstPauseMs / 1000;

    // Hand the shot to the match's hook (positional sound / muzzle / kills).
    if (this.onShot) this.onShot(this, shot);
  }

  // The point the bot is aiming AT before error: the target's body center by
  // default, or its head if this acquisition rolled a head aim.
  _computeAimPoint() {
    const t = this.target;
    if (this._headAimThisAcq) {
      _aimPoint.copy(t.headCenter);
    } else {
      // Body center: feet + a fraction of body height (aimHeightBody).
      _aimPoint.set(t.pos.x, t.pos.y + BODY.y * this.tuning.aimHeightBody, t.pos.z);
    }
  }

  // Perturb the UNIT aim dir inside a cone. Cone half-angle (deg) =
  //   tighten(aimErrorStartDeg → aimErrorMinDeg over tightenTime)   [continuous LOS]
  //   + strafePenaltyDegPerMs × target lateral speed (mm/s across our view)
  //   + selfMoveErrorDeg × (our speed / runSpeed, clamped 0..1)
  // Then offset by a uniform disk sample inside that cone (same basis math as
  // the player's getCameraRay spread). Dodging (lateral target motion) and our
  // own movement both WIDEN it — the "reward dodging" + "no run-and-gun laser"
  // behavior the humanity checklist grades.
  _applyAimError(dir) {
    const t = this.tuning;
    // Exponential tighten from start → min over tightenTime (continuous LOS).
    const frac = Math.min(1, this._aimTightenT / Math.max(1e-3, t.tightenTime));
    const ease = 1 - Math.exp(-3 * frac); // ~0.95 at frac=1 — smooth, not linear
    let coneDeg = t.aimErrorStartDeg + (t.aimErrorMinDeg - t.aimErrorStartDeg) * ease;

    // Target lateral speed across our view = |perp component of its motion|.
    // Measured by finite difference on the target's pos (the player exposes no
    // .vel). Valid only when the target is the SAME as last frame (id match);
    // a fresh acquisition skips it for one frame (no phantom speed).
    if (this._prevTargetId === this.target.id) {
      const perpX = -dir.z, perpZ = dir.x; // XZ perpendicular to the view dir
      const dvx = this.target.pos.x - this._prevTargetPos.x;
      const dvz = this.target.pos.z - this._prevTargetPos.z;
      const latPerFrame = Math.abs(dvx * perpX + dvz * perpZ);   // m moved perpendicular this frame
      const latMs = (latPerFrame / Math.max(1e-3, this._lastDt)) * 1000; // → mm/s
      coneDeg += t.strafePenaltyDegPerMs * latMs;                // deg per (mm/s)
    }

    // Our own movement widens the cone too (no run-and-gun laser).
    const ownSpeed = Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z);
    coneDeg += t.selfMoveErrorDeg * Math.min(1, ownSpeed / MOVE.runSpeed);

    // HARD CLAMP the cone at 45°. Two reasons: (1) a >45° "miss cone" adds no
    // meaningful behavior (it's already spraying wildly), and (2) it keeps
    // tan(coneRad) bounded — a huge angle (e.g. a one-frame position jump on an
    // enemy respawn inflating the lateral-speed term) would otherwise send tan()
    // toward its 90° singularity and corrupt the aim direction. Robustness, I1.
    if (coneDeg > 45) coneDeg = 45;
    if (coneDeg <= 1e-4) return; // effectively on target (never, given minDeg>0)
    const coneRad = THREE.MathUtils.degToRad(coneDeg);

    // Uniform disk sample inside the cone, in the aim's own basis (matches how
    // getCameraRay offsets the player's spread).
    _aimRight.crossVectors(dir, _WORLD_UP);
    if (_aimRight.lengthSq() < 1e-6) _aimRight.set(1, 0, 0); // dir nearly vertical
    _aimRight.normalize();
    _aimUp.crossVectors(_aimRight, dir); // unit
    const a = Math.random() * Math.PI * 2;
    const r = Math.tan(coneRad) * Math.sqrt(Math.random());
    dir.addScaledVector(_aimRight, Math.cos(a) * r)
       .addScaledVector(_aimUp, Math.sin(a) * r)
       .normalize();
  }
}

/**
 * Build one team's bots (meshes added to the scene). Returns the Bot[] — the
 * match owns placement/spawn and the per-frame update.
 * @param {'se'|'bug'} team
 * @param {string[]} names   pre-dealt unique names for this team
 * @param {THREE.Scene|THREE.Group} scene
 * @param {object} graph     WaypointGraph
 * @param {object} tuning    getBotTuning()
 * @param {number} baseIndex roster offset (seeds LOS stagger phase)
 * @returns {Bot[]}
 */
export function buildBots(team, names, scene, graph, tuning, baseIndex = 0) {
  const list = [];
  for (let i = 0; i < names.length; i++) {
    const bot = new Bot(names[i], team, graph, tuning, baseIndex + i);
    scene.add(bot.group);
    list.push(bot);
  }
  return list;
}
