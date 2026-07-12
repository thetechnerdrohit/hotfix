// ============================================================================
// HOTFIX — boot + game loop + state machine (MENU → PLAYING ⇄ PAUSED).
// The loop clamps dt (B1) so a suspended tab can never integrate through a
// wall, keeps rendering under menus (G3), and treats pointer-lock loss as
// pause (A1/G4). Feature gates (J10) come before anything renders.
// ============================================================================

import * as THREE from 'three';
import './style.css';
import { MOVE, PERF, FEEL, BOTS, ADS } from './config.js';
import { Input } from './core/input.js';
import { loadSettings, saveSettings } from './core/settings.js';
import { PlayerController } from './player/controller.js';
import { FpsCamera } from './player/camera.js';
import { Viewmodel } from './player/viewmodel.js';
import { buildTestRoom } from './world/testRoom.js';
import { buildProdMap } from './world/prodMap.js';
import { buildShootsMap } from './world/shootsMap.js';
import { buildBattleMap } from './world/battleMap.js';
import { buildTargets } from './world/targets.js';
import { makeGraph } from './world/waypoints.js';
import { WeaponSystem } from './combat/weapons.js';
import { PlayerEntity } from './game/entities.js';
import { Match } from './game/match.js';
import { AudioEngine } from './audio/audio.js';
import { FxPools } from './fx/pools.js';
import { TargetFx } from './fx/targetFx.js';
import { BotAudioFx } from './fx/botAudioFx.js';
import { Hud } from './ui/hud.js';
import { DangerStack } from './ui/danger.js';
import { Vitals } from './ui/vitals.js';
import { MatchHud } from './ui/matchHud.js';
import { Menus } from './ui/menus.js';
import { FX } from './config.js';
import { initTuner } from './debug/tuner.js';
import { NetClient } from './net/client.js';
import { AvatarPool } from './net/avatars.js';
import { EV } from './net/protocol.js';

// Module scratch for the camera-ray closure — zero allocations per shot (I1).
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _WORLD_UP = new THREE.Vector3(0, 1, 0);

// Module scratch for the presentation layer's per-shot work — zero allocations
// on the shot path (I1). onShotResolved's `result` is a SHARED reused object, so
// we copy point + normal into these synchronously inside the callback.
const _muzzle = new THREE.Vector3();   // tracer start (viewmodel barrel tip, E1)
const _hitPoint = new THREE.Vector3(); // copied hit point (result.point is reused!)

// Module scratch for the Phase-3 match presentation — bot muzzle/splat world
// points computed synchronously inside the match event callbacks (I1).
const _botMuzzle = new THREE.Vector3(); // bot shot flash/positional-audio origin
const _botBody = new THREE.Vector3();   // bot mid-body point (splat particle burst)
const _botFeet = new THREE.Vector3();   // bot feet point (splat floor decal)

// Team splat palettes (particle + floor-stain tints) — read once from config.
const SPLAT_PALETTE = {
  bug: { particle: FX.splatBugColor, decal: FX.splatBugDecalColor },
  se: { particle: FX.splatSeColor, decal: FX.splatSeDecalColor },
};

// ============================================================================
// "FAST" GRAPHICS PRESET (§4 Settings + I4 — the Krunker-style preset). When
// settings.fast is on we mutate the config IN PLACE, BEFORE anything reads it:
//   • PERF.shadows = false → renderer.shadowMap disabled + maps skip castShadow
//     (a shadow-casting sun is the single most expensive light, I3).
//   • PERF.dprCap = 1 → half the pixels of the 2× cap on hi-DPI (I4 — the
//     "Fast preset later drops to 1" line, verbatim).
//   • Halve every FX POOL BUDGET (tracers/decals/impacts/flash/splats). Pools are
//     sized ONCE in their constructors from these fields, so this must land
//     before new FxPools()/new WebGLRenderer()/buildProdMap() — i.e. the very
//     first thing boot() does. decalCount mirrors PERF.decalCap; halve both.
// This is why it's a BOOT preset (not a live toggle): shadows/DPR/pool sizes are
// fixed at construction. Flipping it from the menu therefore offers a reload.
// Idempotent-safe (guarded) though boot() only ever runs once.
// ============================================================================
let _fastApplied = false;
function applyFastPreset() {
  if (_fastApplied) return;
  _fastApplied = true;
  PERF.shadows = false;
  PERF.dprCap = 1;
  const half = (n) => Math.max(1, Math.floor(n / 2)); // never drop a pool to 0
  PERF.decalCap = half(PERF.decalCap);
  FX.tracerCount = half(FX.tracerCount);
  FX.decalCount = half(FX.decalCount); // mirrors PERF.decalCap (config comment)
  FX.impactCount = half(FX.impactCount);
  FX.flashCount = half(FX.flashCount);
  FX.splatCount = half(FX.splatCount);
  FX.splatDecalCount = half(FX.splatDecalCount);
}

const canvas = document.getElementById('game');
// v1.5 rope hint element (created once; opacity-only updates — G2)
const _ropeHintEl = document.createElement('div');
_ropeHintEl.id = 'rope-hint';
_ropeHintEl.textContent = 'hold W to climb';
document.body.appendChild(_ropeHintEl);
let _ropeHintShown = false;
const settings = loadSettings();
const menus = new Menus(settings);

// J10: old browser → a friendly message, never a blank page
function supported() {
  if (!('requestPointerLock' in Element.prototype)) return false;
  try {
    const probe = document.createElement('canvas');
    return !!(probe.getContext('webgl2') || probe.getContext('webgl'));
  } catch {
    return false;
  }
}

if (!supported()) {
  menus.show('unsupported');
} else {
  boot();
}

function boot() {
  // FIRST thing: fold the persisted FAST preset into the config BEFORE anything
  // reads PERF/FX (renderer, map, FX pools all sample these at construction, I4).
  if (settings.fast) applyFastPreset();
  // Seed the bot difficulty from the persisted setting so the FIRST match built
  // below uses it (getBotTuning() reads BOTS.difficulty at Match construction).
  BOTS.difficulty = settings.difficulty;

  const params = new URLSearchParams(location.search);
  // Dev-only escape hatch for automated testing: ?nolock=1 starts the sim
  // without pointer lock (headless browsers can't feel-test mouse-look anyway)
  const NOLOCK = import.meta.env.DEV && params.has('nolock');
  // Dev-only ?bots=0 boots the OLD Phase-2 target practice: the test-room
  // geometry with static dummies and NO match (no bot teams, no TDM). The
  // default flow (bots on) replaces the dummies with the Phase-3 SE-vs-Bug
  // match. Practice mode keeps the dummy target list + targetFx alive.
  const WANT_BOTS = !(import.meta.env.DEV && params.get('bots') === '0');
  // PHASE 5 (approved): ?online=1 joins the authoritative Colyseus server —
  // quick-match into an open room, humans replace bots (dynamic joining). The
  // local Match is NOT built; the server owns all entities/scoring. Offline
  // single-player stays byte-identical without the flag.
  const ONLINE = params.has('online');
  const SERVER_URL = params.get('server') || `ws://${location.hostname}:2567`;
  // v1.2: the DEFAULT map is "Shoots" (the ar_shoots clone — verticality capstone).
  // Prod is demoted to the DEV-only ?room=prod flag; ?room=test keeps the Phase-1
  // feel gym (its own spawns + waypoint graph) so ?bots=0 practice + tuning work.
  // One map ships (per Rohit) — no picker, no settings change.
  const ROOM = import.meta.env.DEV ? params.get('room') : null;
  const WANT_TEST_ROOM = ROOM === 'test';
  const WANT_PROD = ROOM === 'prod';

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, PERF.dprCap)); // I4
  renderer.outputColorSpace = THREE.SRGBColorSpace; // J7: explicit — flat colors stay true
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = PERF.shadows;
  renderer.shadowMap.autoUpdate = false; // static scene: bake shadows once (I3)
  renderer.shadowMap.needsUpdate = true;

  // The MAP owns its palette (Phase 4): build*() returns background + fog so a
  // map can tune its own look (Prod's fog far-plane is set to keep the 28 m
  // A-lane sightline visible — fog must never hide a balanced sightline).
  // v2.0: the Battleground (compound + fields + camps + great trees) is the
  // shipped map; the compound-only arena stays at DEV ?room=shoots.
  const WANT_SHOOTS = import.meta.env.DEV && params.get('room') === 'shoots';
  const room = WANT_TEST_ROOM ? buildTestRoom()
    : WANT_PROD ? buildProdMap()
    : WANT_SHOOTS ? buildShootsMap()
    : buildBattleMap();

  const scene = new THREE.Scene();
  scene.background = room.background;
  scene.fog = room.fog;
  scene.add(room.group);

  // Practice dummies (§4B) exist ONLY in ?bots=0 practice mode — the default
  // flow replaces them with the match's bot teams. Empty array otherwise so the
  // Phase-2 presentation wiring (targetFx, the per-frame update) stays valid and
  // simply iterates nothing. NOT added to room.colliders — targets aren't walls.
  const targets = WANT_BOTS ? [] : buildTargets(scene);

  const cam = new FpsCamera(window.innerWidth / window.innerHeight, settings.fov);
  cam.sensitivity = settings.sensitivity;
  // The viewmodel is parented to the camera, so the camera must live in the
  // scene graph for its children to render (a bare camera renders nothing but
  // itself). Adding it is harmless — a camera has no visible geometry.
  scene.add(cam.camera);

  const player = new PlayerController(room.spawnPoint);
  player.ropes = room.ropes ?? null; // v1.5: climbable ropes (map-provided)
  const input = new Input();
  input.attach(canvas);
  const hud = new Hud();

  // The weapon state machine (Phase 2 combat core). Events are left UNASSIGNED
  // here — the presentation layer wires onFire/onShotResolved/etc. Only the
  // ray-source hook is injected, because it's engine geometry the system can't
  // own itself (E1: the ray is always the camera center).
  const weapons = new WeaponSystem(room.colliders, targets);
  weapons.getCameraRay = (outOrigin, outDir, spreadRad) => {
    // Origin = camera center (E1). Forward from yaw/pitch (camera Euler is YXZ).
    outOrigin.copy(cam.camera.position);
    const cp = Math.cos(cam.pitch);
    _fwd.set(-Math.sin(cam.yaw) * cp, Math.sin(cam.pitch), -Math.cos(cam.yaw) * cp).normalize();

    if (spreadRad > 0) {
      // Uniform disk sample inside the cone, offset in the camera's own basis.
      // Math.random is fine for spread (§ task brief). tan() keeps wide cones
      // honest; for the minimal Phase-2 cones it's ≈ the angle.
      _right.crossVectors(_fwd, _WORLD_UP).normalize();
      _up.crossVectors(_right, _fwd); // already unit (both operands unit ⟂)
      const a = Math.random() * Math.PI * 2;
      const r = Math.tan(spreadRad) * Math.sqrt(Math.random());
      outDir.copy(_fwd)
        .addScaledVector(_right, Math.cos(a) * r)
        .addScaledVector(_up, Math.sin(a) * r)
        .normalize();
    } else {
      outDir.copy(_fwd);
    }
  };

  // ==========================================================================
  // PHASE 3 — the match: bot teams + the player as a damageable combatant + TDM.
  // The player entity wraps the controller so bots can see/kill it; the match
  // owns the roster, spawns, scoring, respawns, and the stable target/collider
  // arrays. Built only when WANT_BOTS (the default); ?bots=0 keeps the Phase-2
  // dummy practice with no match. Match EVENTS (onKillFeed/onPlayerDeath/…) are
  // left UNASSIGNED — the frontend agent wires them; here we only do the
  // functional plumbing (target list, colliders, input gate, the tick).
  // ==========================================================================
  let match = null;
  let playerEntity = null;
  if (WANT_BOTS && !ONLINE) {
    const graph = makeGraph(room.waypointNodes); // the ACTIVE map's node graph (prod or test)
    playerEntity = new PlayerEntity(1, player, weapons, cam);
    weapons.owner = playerEntity; // kill credit + directional-danger source pos
    // The map owns the team spawns (feet pos + facing yaw); pass them in so the
    // match is map-agnostic (Phase-4 plumbing — no hard-coded spawn arrays).
    match = new Match(playerEntity, weapons, graph, scene, room.colliders,
      { seSpawns: room.seSpawns, bugSpawns: room.bugSpawns });
    // Repoint ONLY the weapon's target list at the match's stable, maintained-
    // in-place enemy array (WeaponSystem reads it fresh each shot). The player's
    // bullets hit bots through this TARGET list (head-sphere + body), so bots do
    // NOT belong in weapons.world — that stays the STATIC room geometry, exactly
    // as in Phase 2, or bot bodies would double as bullet-blocking walls. The
    // bots-as-obstacles physicality is a MOVEMENT concern only: PlayerController
    // gets match.dynamicColliders (statics + living-bot AABBs) in the loop.
    weapons.targets = match.enemiesOfPlayer;
  }

  // ==========================================================================
  // PRESENTATION LAYER — audio, FX pools, viewmodel, target reactions, and the
  // HUD combat feedback, all wired onto the weapon system's event surface. The
  // combat core stays untouched; this is pure feel on top of its events.
  // ==========================================================================
  const audio = new AudioEngine();
  // H6: honour the PERSISTED volume at boot, not just when the slider moves.
  // setMasterVolume updates this.masterVolume now; unlock()→_buildGraph() reads
  // it when the context is later created inside the start-click gesture (H1), so
  // a returning user hears their saved level from the first sound — no slider nudge.
  audio.setMasterVolume(settings.volume);
  const fx = new FxPools(scene);
  const targetFx = new TargetFx(targets);
  const viewmodel = new Viewmodel(cam.camera); // the THREE camera — the rig parents to it

  // ==========================================================================
  // PHASE 3 PRESENTATION — danger stack, low-hp stack, match HUD, positional bot
  // audio. All are DORMANT (harmless no-ops / hidden) in practice mode where
  // `match` is null: the danger/vitals/matchHud objects still exist (so the loop
  // wiring is uniform) but nothing feeds them, and the HUD blocks stay hidden.
  // ==========================================================================
  const danger = new DangerStack(cam);          // directional wedges + hurt vignette (F7/F8)
  const vitals = new Vitals(audio);             // low-hp escalating stack (F9)
  const matchHud = new MatchHud();              // scoreboard + kill feed + death/end overlays

  // -- ONLINE (Phase 5): net client + remote avatars + event/HUD wiring -------
  let net = null, avatars = null, selfDead = false;
  if (ONLINE) {
    net = new NetClient(player, cam);
    avatars = new AvatarPool(scene);
    net.onWelcome(({ team }) => { hud.setWeapon(weapons.active); matchHud.setScore(0, 0); });
    net.onEvent((events) => {
      for (const ev of events) {
        if (ev.t === EV.KILL) matchHud.addKill({ killerName: ev.killerName, killerTeam: ev.killerTeam, victimName: ev.victimName, victimTeam: ev.victimTeam, weapon: ev.weapon, isHead: !!ev.isHead });
        else if (ev.t === EV.SHOT) audio.botShot(ev.x, ev.y, ev.z);
        else if (ev.t === EV.DEATH) {
          if (ev.id === net.selfId) { selfDead = true; matchHud.showDeath({ killerName: ev.killerName, killerTeam: ev.killerTeam, weapon: ev.weapon, isHead: !!ev.isHead }); cam.setDeathTilt(true); }
          else { const e = net.entities.get(ev.id); if (e) fx.splat(e.pos, e.pos, SPLAT_PALETTE[e.team] ?? SPLAT_PALETTE.bug); }
        } else if (ev.t === EV.HIT && ev.by === net.selfId) hud.showHitmarker(!!ev.isHead);
      }
    });
    net.onSnapshot(() => {
      const self = net.entities.get(net.selfId);
      if (self && selfDead && !self.dead) { selfDead = false; matchHud.hideDeath(); cam.setDeathTilt(false); danger.reset(); vitals.reset(); }
      matchHud.setScore(net.match.seScore, net.match.bugScore);
    });
  }
  const botAudioFx = new BotAudioFx(match, audio, 'se'); // positional enemy/ally footsteps
  // Health block + scoreboard only exist when there's a match (SE-vs-Bug TDM).
  vitals.setVisible(!!match);
  matchHud.setVisible(!!match);

  // Hit-stop (feedback ladder item 4, single-player only): a kill briefly scales
  // the SIMULATION dt way down for a chunky freeze. The timer itself counts down
  // on RAW dt (below) so it always ends even though it's slowing sim time.
  let hitStopTimer = 0;

  // Seed the HUD with the starting weapon + ammo so the block isn't stale before
  // the first event (the rifle starts raising in the weapon system's ctor).
  hud.setWeapon(weapons.active);
  hud.setAmmo(weapons.active, weapons.ammo[weapons.active]);

  // -- Per-weapon shot sound router (kept tiny; no per-frame cost) ------------
  function playShotSound(weapon) {
    if (weapon === 'rifle') audio.rifleShot();
    else if (weapon === 'pistol') audio.pistolShot();
    else audio.knifeSwing(); // knife "shot" is the swing whoosh; the thunk is on hit
  }

  // -- Event wiring ----------------------------------------------------------

  // FIRE: shot sound + muzzle flash + camera recoil + viewmodel kick. The tracer
  // is drawn in onShotResolved (it needs the hit point). Crosshair bloom is read
  // per-frame from currentSpreadRad(), so nothing to do here for it.
  weapons.onFire = ({ weapon, recoilDeg }) => {
    playShotSound(weapon);
    cam.applyRecoil(recoilDeg);         // camera kick (recovers toward aim, §4B)
    viewmodel.onFire(weapon);           // gun kick-back / knife swing arc
    if (weapon !== 'knife') {
      viewmodel.getMuzzleWorldPos(_muzzle);
      fx.flashes.spawn(_muzzle, cam.camera.quaternion); // emissive quad, no light (I3)
    }
  };

  // SHOT RESOLVED: draw the tracer (muzzle → hit point), spawn impact particles,
  // world-only decals, the hit-confirm tick/ding, and the hitmarker. CRITICAL:
  // `result` is a SHARED reused object — copy point/normal into our pooled
  // scratch synchronously, right here, before it's overwritten by the next shot.
  weapons.onShotResolved = ({ result, isHead, weapon }) => {
    if (!result.hitSomething) return;
    _hitPoint.copy(result.point);            // copy NOW (result.point is reused)
    const normalAxis = result.normalAxis;    // primitives — safe to read directly
    const normalSign = result.normalSign;
    const onTarget = result.target !== null;

    // Tracer for guns (knife has no bullet streak). Start at the muzzle (E1).
    if (weapon !== 'knife') {
      viewmodel.getMuzzleWorldPos(_muzzle);
      fx.tracers.spawn(_muzzle, _hitPoint);
    }

    // Impact puff at the hit point; tint by what we struck.
    fx.impacts.burst(_hitPoint, onTarget);

    if (onTarget) {
      // Outgoing hit confirm: high tick (H4). Headshot → the dopamine bell too.
      if (weapon === 'knife') audio.knifeHit();
      else audio.hitTick();
      if (isHead) audio.headshotDing();
      hud.showHitmarker(isHead);
    } else {
      // World hit only (E13/I2): a bullet-hole decal — never on characters.
      fx.decals.spawn(_hitPoint, normalAxis, normalSign);
    }
  };

  // DRY FIRE: mechanical click + a visible ammo-block flash (G6, deaf-friendly).
  weapons.onDryFire = (_weapon) => {
    audio.dryClick();
    hud.flashAmmo();
  };

  // RELOAD: start/cancel the game-time stage-click sequencer + the viewmodel dip.
  weapons.onReloadStart = (weapon) => {
    audio.startReloadSequence(weapon); // magOut now; magIn/rack advance on game dt (B6)
    viewmodel.onReloadStart(weapon);
  };
  weapons.onReloadEnd = (weapon, completed) => {
    // completed=false ⇒ switch-cancelled: drop the pending clicks + end the dip.
    audio.stopReloadSequence();
    viewmodel.onReloadEnd(weapon, completed);
  };

  // SWITCH: a soft click, the weapon chip, and the viewmodel lower→raise. The
  // chip updates on switch START (that's when the name changes).
  weapons.onSwitchStart = (name) => {
    audio.switchClick();
    viewmodel.onSwitch(name);
    hud.setWeapon(name);
  };
  weapons.onSwitchEnd = (name) => {
    // Raise finished — refresh ammo for the now-active weapon (∞ for knife).
    hud.setAmmo(name, weapons.ammo[name]);
  };

  // AMMO: refresh the HUD numbers + low-ammo flash state (event-driven; G2).
  weapons.onAmmoChanged = (weapon) => {
    hud.setAmmo(weapon, weapons.ammo[weapon]);
  };

  // KILL: deeper confirm sound, kill-X on the crosshair, and the hit-stop freeze.
  // For the same shot the weapon system calls onKill FIRST, then onShotResolved
  // (which rings the tick + headshot ding). So we deliberately do NOT ding here —
  // a headshot-kill layers killConfirm + ding + tick (distinct registers), which
  // reads richer than ringing the same bell twice.
  weapons.onKill = (_target, _info) => {
    audio.killConfirm();
    hud.showKill();
    hitStopTimer = FEEL.hitStopMs / 1000; // arm the freeze (ticked on raw dt below)
  };

  // ADS (register group L): a soft in/out tick on the ui bus (edge-driven). The
  // eased FOV/sensitivity/pose/crosshair all read weapons.adsBlend per frame
  // below — this callback is ONLY the audio cue.
  weapons.onAdsChanged = (active) => {
    audio.adsTick(ADS.tickGain, active);
  };

  // ==========================================================================
  // PHASE 3 MATCH EVENT WIRING (event → presentation). Every field is nullable
  // and assigned here (the backend leaves them unassigned). Guarded by `if
  // (match)` so practice mode (?bots=0) never touches them.
  // ==========================================================================
  if (match) {
    // -- Player got shot: the danger stack + shake + incoming thud (§4B). The
    //    payload is TRANSIENT/REUSED (backend zero-alloc contract) — danger.onDamage
    //    copies sourcePos synchronously; hasSource gates the wedge (false ⇒ stale
    //    sourcePos, vignette only). Everything read here is consumed in-call.
    playerEntity.onDanger = (info) => {
      danger.onDamage(info.amount, info.hasSource, info.sourcePos); // wedge + hurt vignette (F7/F8)
      cam.addShake(Math.min(FEEL.shakeMax, info.amount * FEEL.shakePerDmg)); // subtle shake ∝ dmg
      // Incoming = LOW thud, distinct from the outgoing high hitTick (H4); a
      // sharper variant once the hit drops us to/below the critical threshold.
      audio.incomingHit(info.hpAfter <= FEEL.criticalHpThreshold);
    };

    // -- Scoreboard + kill feed (G7). 'you' appears verbatim in the feed.
    match.onScoreChanged = (se, bug) => matchHud.setScore(se, bug);
    match.onKillFeed = (entry) => matchHud.addKill(entry);

    // -- Player death → respawn overlay + the death CAM (§4B deferred item): a
    //    short drop + roll eased into the RENDERED view only (cam owns the ease;
    //    aim state is untouched, so the respawn snaps back clean).
    match.onPlayerDeath = (info) => {
      matchHud.showDeath(info);
      cam.setDeathTilt(true);
    };
    // -- Player respawn → clear the overlay, ease the death cam back out, AND
    //    hard-reset the danger/low-hp layers so nothing lingers into the new life
    //    (F9; belt-and-braces — the hp-derived vitals also clear themselves, but a
    //    respawn should snap).
    match.onPlayerRespawn = () => {
      matchHud.hideDeath();
      cam.setDeathTilt(false);
      danger.reset();
      vitals.reset();
    };

    // -- Match end → the verdict overlay. Release the pointer so its buttons are
    //    clickable, and enter the 'over' state (suppresses the pause menu on the
    //    resulting lock-loss). The match itself already froze bots + the clock.
    match.onMatchEnd = (result) => {
      matchHud.showEnd(result);
      setState('over');
      if (document.exitPointerLock) document.exitPointerLock();
    };

    // -- A bot fired: positional gunshot (PannerNode at the bot) + a world-space
    //    muzzle quad at the bot's gun. headCenter is the bot's shot origin
    //    (bots.js fires from there), so it's the honest muzzle point.
    match.onBotFired = (bot) => {
      _botMuzzle.copy(bot.headCenter);
      audio.botShot(_botMuzzle.x, _botMuzzle.y, _botMuzzle.z);
      // Reuse the muzzle-flash pool with a WORLD position + camera-billboard
      // quaternion so the flash faces the player and reads at distance (I3 — no
      // dynamic light). It's a small quad; the pool caps it.
      fx.flashes.spawn(_botMuzzle, cam.camera.quaternion);
    };

    // -- A bot died: the satisfying splat — team-palette particle burst + a flat
    //    floor stain + a positional death sound (crunchy Bug / sadder SE). The
    //    bot's own sink-out runs underneath (backend hides it, then respawns).
    match.onBotKilled = (bot, meta) => {
      _botFeet.copy(bot.pos);                              // feet (floor decal)
      _botBody.set(bot.pos.x, bot.pos.y + 0.7, bot.pos.z); // mid-body (particle burst)
      const palette = SPLAT_PALETTE[bot.team] || SPLAT_PALETTE.bug;
      fx.splat(_botBody, _botFeet, palette);
      audio.botDeath(_botBody.x, _botBody.y, _botBody.z, bot.team);
      void meta;
    };
  }

  let state = 'menu'; // 'menu' | 'playing' | 'paused' | 'over'
  let last = performance.now();
  // Has the player actually STARTED the current match (entered PLAYING at least
  // once for it)? Distinguishes the three difficulty states the brief calls out:
  // a match that is over, one NOT YET STARTED (constructed at boot but never
  // played — a difficulty pick still applies to it), and one MID-MATCH (a pick
  // must defer with a hint). Reset to false whenever a fresh match is restarted.
  let matchStarted = false;

  function setState(next) {
    state = next;
    if (next === 'playing') last = performance.now(); // B7: no giant post-pause dt
    if (next === 'playing' && match) matchStarted = true; // this match is now in progress
    // Menu overlay panel per state. 'over' shows NO menu panel — the match-end
    // overlay is its own interactive layer above the HUD; here we just hide the
    // menu overlay so the two don't stack.
    if (next === 'playing') menus.show(null);
    else if (next === 'paused') menus.show('paused');
    else if (next === 'over') menus.show(null);
    else menus.show('start');
    // Entering PLAYING always clears the match-end overlay — this is the single
    // point it hides, so if a re-lock from PLAY AGAIN is REJECTED (Chrome's A2
    // cooldown) the overlay + its buttons stay up for a retry rather than
    // leaving a blank playing-looking screen. Harmless when already hidden.
    if (next === 'playing' && match) matchHud.hideEnd();
  }

  // Pointer-lock loss IS pause — one transition, never two states (A1/G4).
  // EXCEPTION: while the match is 'over' the lock loss is one WE caused (to make
  // the end-overlay buttons clickable) — don't bounce to the pause menu.
  input.onLockChange = (locked) => {
    if (locked) setState('playing');
    else if (state === 'playing' && !NOLOCK) setState('paused');
  };
  input.onLockRejected = () => {
    // A2: Chrome's ~1.25 s re-lock cooldown — say so instead of a dead button
    menus.setLockHint('Browser blocked the mouse grab — wait a second, then click again.');
  };

  menus.onPlay(() => {
    // H1: resume the AudioContext inside the SAME click gesture that grabs
    // pointer lock — this is the one and only moment the browser will honor it.
    // Do it on BOTH paths (NOLOCK too) so headless/automation still boots audio.
    audio.unlock();
    // PHASE 5 ONLINE: connect + quick-match first (joinOrCreate lands us in an
    // open room, replacing a bot). Lock/state only after the join resolves.
    if (ONLINE && net && !net.room) {
      menus.setLockHint('Connecting…');
      net.connect(SERVER_URL).then(() => {
        menus.setLockHint('');
        if (NOLOCK) setState('playing');
        else input.requestLock();
      }).catch(() => menus.setLockHint('Server unreachable — run `npm run server`.'));
      return;
    }
    // Restart (re-folding difficulty via getBotTuning) when Play begins a match
    // that isn't already in progress:
    //   • state 'over' — returned from the MENU button of a FINISHED match; Play
    //     means a fresh round.
    //   • NOT YET STARTED — the match was constructed at boot but never played, and
    //     the difficulty may have been changed on the start screen since; restart
    //     re-folds it so the FIRST match honours a start-screen pick (brief). This
    //     is effect-free otherwise (everyone's already at spawn, score 0).
    // A LIVE, in-progress (paused) match just resumes — never reset underfoot.
    if (match && (match.state === 'over' || !matchStarted)) {
      match.restart();
      matchStarted = false;   // fresh, not-yet-started match again
      danger.reset();
      vitals.reset();
      // restart() respawns the player with initial=true, which does NOT fire
      // onPlayerRespawn — so clear the death cam + death overlay HERE too, or a
      // match that ENDED on the player's own death would carry the ~18° roll +
      // the frozen "TERMINATED" card into the fresh round (they're otherwise only
      // cleared on a non-initial respawn).
      cam.setDeathTilt(false);
      if (matchHud) matchHud.hideDeath();
    }
    if (NOLOCK) { setState('playing'); return; }
    input.requestLock(); // synchronous, inside the click gesture (A3)
  });

  // Match-end overlay buttons (§4B). PLAY AGAIN: restart the match, clear the
  // stacks, hide the overlay, and re-grab pointer lock via the same gesture path
  // (this handler runs inside the button's click, so requestLock is honored, A3;
  // and unlock() satisfies the audio gesture requirement, H1). MENU: back to the
  // start panel with the match kept in its 'over' state until the next Play
  // (which restarts it, above).
  matchHud.onPlayAgain = () => {
    if (!match) return;
    audio.unlock();          // H1 — inside the click gesture
    match.restart();         // re-folds difficulty (getBotTuning) for the new round
    matchStarted = false;    // fresh, not-yet-started match
    danger.reset();
    vitals.reset();
    // restart() respawns with initial=true (no onPlayerRespawn) — clear the death
    // cam + overlay here so a match that ended on the player's death doesn't drag
    // the roll/drop + frozen death card into the new round.
    cam.setDeathTilt(false);
    matchHud.hideDeath();
    // The overlay hides on entering PLAYING (setState) — NOT here — so a rejected
    // re-lock (A2) keeps the buttons available for a retry.
    if (NOLOCK) { setState('playing'); return; }
    input.requestLock();     // A3 — synchronous in the click handler
  };
  matchHud.onMenu = () => {
    matchHud.hideEnd();
    // Also clear a lingering death overlay: if the match ended ON the player's
    // death, showDeath() left the "TERMINATED" card up and nothing has cleared it
    // (respawn never ran). Without this it would show over the start panel. The
    // death cam is a rendered-only offset frozen behind the (non-rendering) menu,
    // and the next Play's restart resets it — but hide the card now so the start
    // panel is clean.
    matchHud.hideDeath();
    setState('menu');        // start panel; match stays 'over' until Play restarts it
  };
  menus.onSensitivity((v) => {
    cam.sensitivity = v;
    settings.sensitivity = v;
    saveSettings(settings);
  });
  menus.onFov((v) => {
    cam.setFov(v);
    settings.fov = v;
    saveSettings(settings);
  });
  menus.onVolume((v) => {
    audio.setMasterVolume(v); // H6 — master bus gain
    settings.volume = v;
    saveSettings(settings);
  });

  // DIFFICULTY (start panel): persist + set BOTS.difficulty. It takes effect at
  // the next match START or RESTART (getBotTuning() is re-folded there). So:
  //   • no match / a FINISHED ('over') match / one NOT YET STARTED → applies on the
  //     next Play (which restarts it — see onPlay) — no hint needed.
  //   • a match already IN PROGRESS (live AND started) → can't swap bots underfoot;
  //     show the "applies next match" hint (value saved + applies on next restart).
  // The control lives ONLY on the start panel (the pause panel stays sliders-only
  // per the brief), and the start panel is reachable only when no match is live
  // (fresh boot, or MENU which leaves the match 'over'), so the in-progress branch
  // is a correct-but-currently-unreachable guard — kept intentionally so the hint
  // still behaves if difficulty is ever surfaced over a live match.
  menus.onDifficulty((value) => {
    BOTS.difficulty = value;          // getBotTuning() reads this at start/restart
    settings.difficulty = value;
    saveSettings(settings);
    const inProgress = match && match.state === 'live' && matchStarted;
    menus.setDifficultyHint(inProgress ? 'Applies next match.' : '');
  });

  // GRAPHICS FAST (start panel): persist immediately; the preset itself is
  // boot-time (shadows/DPR/FX pools are fixed at construction, I4), so it can't
  // hot-apply. Offer a one-click "apply & reload" — an EXPLICIT user action, the
  // only sanctioned reason to reload (never a timer). If they flip it back to the
  // already-booted value, clear the hint (no reload needed).
  menus.onFast((on) => {
    settings.fast = on;
    saveSettings(settings);
    if (on === _fastApplied) {
      menus.setFastHint(''); // matches the currently-booted state → nothing to do
    } else {
      menus.setFastHint('Takes effect on reload.', () => location.reload());
    }
  });

  // Resize + monitor-drag DPR changes (J5)
  function onResize() {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, PERF.dprCap));
    renderer.setSize(window.innerWidth, window.innerHeight);
    cam.setAspect(window.innerWidth / window.innerHeight);
  }
  window.addEventListener('resize', onResize);
  (function watchDpr() {
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      .addEventListener('change', () => { onResize(); watchDpr(); }, { once: true });
  })();
  onResize();

  // I8: GPU resets are real — reload beats a silent freeze
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    menus.show('ctxlost');
  });

  cam.follow(player, 0.016); // frame the room behind the start menu

  if (import.meta.env.DEV) {
    initTuner();
    window.__game = { player, cam, input, weapons, targets, match, playerEntity, state: () => state, audio, fx, viewmodel, danger, vitals, matchHud, botAudioFx, net, avatars };
  }

  menus.show('start');

  function frame(now) {
    const rawDt = (now - last) / 1000;
    last = now;
    const clampedDt = Math.min(rawDt, MOVE.dtClampMs / 1000); // B1: THE clamp

    // Hit-stop (feedback ladder item 4): on a kill, scale the SIMULATION dt way
    // down for a chunky freeze — but not to zero, so motion still resolves. The
    // timer counts down on RAW dt so the freeze always ENDS (a sim-dt countdown
    // could never drain itself). Single-player only; self-contained here.
    let simDt = clampedDt;
    if (hitStopTimer > 0) {
      hitStopTimer = Math.max(0, hitStopTimer - rawDt); // raw dt → guaranteed to end
      simDt = clampedDt * 0.08;                          // ~8% speed while frozen
    }

    if (state === 'playing') {
      // ADS (register group L): push the weapon system's eased blend + the active
      // weapon's per-weapon zoom into the camera BEFORE applyMouse (sensitivity,
      // L7) and follow (FOV, L6). weapons.update ran last frame, so adsBlend is
      // this-frame-fresh enough for an eased value; blend 0 is a true no-op.
      cam.setAds(weapons.adsBlend, ADS.perWeaponZoomDeg[weapons.active] ?? ADS.zoomDeg);
      cam.applyMouse(input.dx, input.dy);
      input.resetMouseDelta();

      // PLAYER DEATH ↔ INPUT (§4B): while the player is dead the controller must
      // not move and weapons must not fire — gate on match.playerAlive without
      // touching controller internals. Practice mode (no match) is always alive.
      const alive = net ? !selfDead : (!match || match.playerAlive);
      // Bots are movement colliders for the player (match.dynamicColliders =
      // static room colliders + living-bot AABBs). Practice mode uses the room.
      const cols = match ? match.dynamicColliders : room.colliders;

      // While dead the weapon system doesn't tick, so its ADS move-speed hook
      // would freeze — force the controller back to full speed so a respawn never
      // inherits a stale ADS slowdown (L: ADS is a held state, cleared on respawn).
      if (!alive) player.speedScale = 1;
      if (net && net.room) {
        // ONLINE (Phase 5): client-side prediction replaces the raw controller
        // step — the predictor samples input, advances the SAME controller math
        // locally, and queues the command; the server reconciles on snapshots.
        if (alive) {
          const keys = net.keysFromInput(input);
          const fireClick = input.takeMousePressed(0);
          const reloadEdge = input.takePressed('KeyR');
          const switchTo = net.switchFromInput(input);
          const cmd = net.predictor.sampleAndPredict(simDt, input, net.predictedColliders(room.colliders), fireClick, reloadEdge, switchTo, keys);
          net.sendInput(cmd);
          weapons.update(simDt, input, player); // cosmetic feel only — targets=[], server owns damage
        }
        cam.follow(player, simDt);
        net.tick(performance.now()); // advance remote interpolation + rtt ping (contract omission — required)
        avatars.sync(net.entities, net.selfId);
        const selfE = net.entities.get(net.selfId);
        if (selfE) vitals.tick(selfE.hp, simDt, selfE.dead);
      } else {
      if (alive) player.update(simDt, input, cam.yaw, cols);
      // Weapons tick AFTER the controller so sprint-out suppression (E7) reads
      // this frame's sprint state; the ray is cast against the just-moved camera.
      cam.follow(player, simDt);
      if (alive) weapons.update(simDt, input, player);
      }

      // Tick the match (bots, respawns, protection, scoring, clock) — always,
      // even while the player is dead (the respawn countdown lives here). It
      // refreshes the player entity's hitboxes so bots aim at the current pose.
      if (match) match.update(simDt);
      else for (let i = 0; i < targets.length; i++) targets[i].update(simDt);

      // Presentation ticks — on sim time so they FREEZE with the hit-stop (they
      // are part of the frozen moment) and PAUSE with the sim (audio reload cues
      // must pause mid-reload, B6). Viewmodel + target reactions likewise.
      // AudioEngine.update also follows the LISTENER to the camera + smooths the
      // low-hp low-pass + loops the heartbeat (all game-time).
      audio.update(simDt, cam.camera);
      viewmodel.update(simDt, weapons, player, player);
      targetFx.update(simDt);
      fx.update(simDt);

      // Phase-3 match presentation. Low-hp stack reads playerEntity.hp FRESH
      // each frame (F9 — never event-driven); pulse/heartbeat advance on sim
      // (game) time. Footsteps + kill-feed + scoreboard likewise. All dormant
      // (guarded) in practice mode.
      if (match) {
        vitals.tick(playerEntity.hp, simDt, !match.playerAlive);
        matchHud.setClock(match.clock);
        matchHud.tick(rawDt, simDt);     // feed fades on raw dt; death countdown on game dt
        botAudioFx.update(simDt);        // positional enemy/ally footsteps (game time)
      }
    } else {
      // Paused/menu/over: keep FADING existing transients to rest on RAW dt — a
      // frozen tracer/muzzle/splat stranded mid-air reads worse than one that
      // finishes its short life. We do NOT spawn anything here and do NOT advance
      // audio/viewmodel/targets/bots (the sim is genuinely paused).
      fx.update(rawDt);
      // While the match-end overlay is up ('over'), keep the kill feed fading and
      // let the low-hp stack settle to rest — but freeze their GAME-time parts
      // (pass gameDt 0) so nothing progresses behind the modal.
      if (state === 'over' && match) {
        matchHud.tick(rawDt, 0);
        vitals.tick(playerEntity.hp, 0, !match.playerAlive);
      }
    }

    // Danger stack ticks on RAW dt ALWAYS (like the HUD markers): wedges must
    // keep reprojecting vs the current camera + fading even during a hit-stop or
    // a pause, and the hurt vignette must finish its decay. Dormant if no match
    // (no wedges are ever spawned, so this is a cheap no-op).
    if (match) danger.tick(rawDt);

    // HUD ticks on RAW dt (its markers must not freeze during hit-stop or pause);
    // crosshair bloom reads the live spread each frame (transform-only, G2/G8).
    hud.tick(rawDt, weapons.currentSpreadRad(), weapons.adsBlend);
    // v1.5 rope hint (event-ish: writes only on state CHANGE)
    if (player.nearRope !== _ropeHintShown) {
      _ropeHintShown = player.nearRope;
      _ropeHintEl.style.opacity = _ropeHintShown ? '1' : '0';
    }
    // Map visual tick (v1.1): the blinking server-rack LED strips. Visual-only,
    // zero-alloc, no gameplay state — run it EVERY frame on raw dt so the arena
    // stays alive even behind the menus (charm; § brief). Guarded (test room /
    // any map without an update hook simply skips).
    if (room.update) room.update(rawDt);
    renderer.render(scene, cam.camera); // G3: keep rendering under menus
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
