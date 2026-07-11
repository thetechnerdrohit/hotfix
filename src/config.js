// ============================================================================
// HOTFIX — the single source of every tunable. (Build plan §4C.)
// Damage numbers are canon from CLAUDE.md — on conflict, CLAUDE.md wins.
// Nothing here is hardcoded anywhere else; the dev tuner binds to these live.
// ============================================================================

export const COMBAT = {
  maxHealth: 100,
  rifle: {
    body: 34, headMult: 3, // canon: 3 body shots, or 1 headshot
    mode: 'auto', fireInterval: 0.100, magSize: 30, reserve: 90,
    reloadTime: 2.2, raiseTime: 0.45,
    spreadBase: 0.3, bloomPerShot: 0.25, recoilPerShot: 0.45,
  },
  pistol: {
    body: 25, headMult: 2, // canon: 4 body, or 2 head
    mode: 'semi', fireInterval: 0.130, magSize: 12, reserve: 36,
    reloadTime: 1.8, raiseTime: 0.35,
    spreadBase: 0.2, bloomPerShot: 0.15, recoilPerShot: 0.3,
  },
  knife: {
    body: 50, backstab: 100, // canon: 2 front hits; backstab = instakill
    mode: 'melee', fireInterval: 0.5, raiseTime: 0.25,
    range: 1.9, backstabDot: -0.5, // rear 120° arc (§4B, E14)
    hitPad: 0.25, // body AABB expanded by this before the knife ray tests it — generous in the skilled direction (E13/§4B)
  },
  headRadius: 0.18,
  sprintOutTime: 0.15,
  semiBufferMs: 60,

  // Spread/recoil recovery — how fast per-shot bloom and camera recoil relax
  // back toward the resting aim point. First shot is always exact (§4B): bloom
  // is zero once decay has drained it. Both are exp-decay rates (1/s), so the
  // trajectories are identical at 30 and 240 fps (B2). Flat/minimal until the
  // real map (Phase 4) makes range matter.
  bloomDecay: 6.0,      // rad/s pull of currentSpread back to spreadBase
  recoilRecovery: 9.0,  // 1/s the CAMERA uses to re-center kicked aim (frontend reads this)
  maxBloom: 1.4,        // hard cap so held auto-fire can't bloom to nonsense

  // -- RANGE MODEL (Phase 4, §4 "Distance matters through accuracy AND damage").
  //    Now that the real map ("Prod") has a ≥26 m rifle lane and a <10 m pistol
  //    corridor, distance finally does something you can feel. Two levers:
  //
  //    (1) DAMAGE FALLOFF (per weapon): full damage out to `start` m, then a
  //        LINEAR lerp of the multiplier 1 → minMult across start→end; clamped to
  //        minMult beyond `end`. Applied in BOTH damage paths (player weapons.js
  //        _fire + bot bots.js BotGun.fire — symmetry is sacred, §4B). Order is
  //        exact per the plan: headshot multiplier FIRST, then falloff, then
  //        Math.round — so a long-range rifle headshot (102 → ×~0.6 = 61) may no
  //        longer one-shot. That is intended (§4 "secondary, but real"). Knife has
  //        no falloff (touching distance only). rifle: full → 60% by 50 m;
  //        pistol: full → 55% by 30 m (falls off sooner + harder — it's the
  //        short/mid tool, §4 weapon-role lever).
  //
  //    (2) MOVEMENT SPREAD PENALTY: firing while moving multiplies the spread
  //        cone (CS-mold "running scatters", §4 lever #1 — the MAIN range lever).
  //        Engaged when the shooter's horizontal speed exceeds movePenaltyFrac ×
  //        runSpeed; the whole spread cone (base + bloom) is scaled by the
  //        per-weapon multiplier. Standing still + tapping stays exact (first shot
  //        exact still holds — bloom is 0). rifle scatters harder than the pistol
  //        (a moving rifle is punished; the pistol is the run-and-gun backup).
  //    All values live here; the dev tuner (COMBAT folder) binds falloff + penalty.
  falloff: {
    rifle:  { start: 20, end: 50, minMult: 0.60 }, // full dmg ≤20 m → 60% by 50 m
    pistol: { start: 12, end: 30, minMult: 0.55 }, // full dmg ≤12 m → 55% by 30 m (sooner + harder)
    // knife: none — melee is touching distance; no entry ⇒ code skips falloff.
  },
  movePenaltyFrac: 0.4,   // horizontal speed > this × runSpeed ⇒ the move-spread penalty engages
  spreadMovePenalty: {
    rifle: 2.2,           // running rifle spread ×2.2 ("running scatters", CS-mold)
    pistol: 1.6,          // pistol is the run-and-gun backup — punished less
    // knife: none — no cone anyway.
  },
};

export const MOVE = {
  runSpeed: 5.0,
  sprintMult: 1.4,
  accelGround: 12,
  accelAir: 3,
  gravity: 22,
  jumpHeight: 1.1, // apex clears a 1.0 m crate
  coyoteMs: 100,
  jumpBufferMs: 120,
  maxFallSpeed: 40,
  dtClampMs: 50, // B1 — tab-suspend can never integrate through a wall

  // LOCKED once map authoring starts (D12): doorways/jump routes depend on these.
  height: 1.8,
  eyeHeight: 1.62,
  halfWidth: 0.4,
};

export const FEEL = {
  fovBase: 75, // vertical; ~103° horizontal @ 16:9
  fovSprintAdd: 5,
  landDipScale: 0.022,
  landDipMinSpeed: 3, // ignore the tiny per-frame ground-contact "impacts"
  dipStiffness: 120,
  dipDamping: 14,
  hitStopMs: 50,
  hitmarkerMs: 80,
  lowHpThreshold: 35,
  criticalHpThreshold: 15,
  damageNumbers: false, // §4D — off by default
  headBob: false,       // §4D — landing dip + FOV kick carry the motion feel

  // -- Getting shot: the danger stack (§4B "danger must answer from WHERE" —
  //    F7/F8, register G/H). All fades tick on RAW dt (they must not freeze in
  //    hit-stop; danger is information the frozen moment shouldn't strand).
  dangerWedgeMs: 800,       // s×1000 a directional-damage wedge lives, reprojected every frame (F7)
  dangerWedgeCount: 4,      // pool of DOM wedges; a new hit reuses the OLDEST (§4B "pool of 4")
  dangerWedgeRadiusPx: 78,  // px from crosshair center the wedge sits at
  dangerVignetteMax: 0.62,  // hard alpha CAP on the hurt vignette — re-trigger never white-outs (F8)
  dangerVignettePerDmg: 0.014, // added alpha per point of damage (34 reads harder than 10, §4B)
  dangerVignetteMinPulse: 0.16, // floor alpha a single hit pulses to (so a 10-dmg tick still registers)
  dangerVignetteDecay: 2.6, // 1/s exp decay of the hurt vignette back to 0

  // -- Camera shake on taking damage (cam.addShake). Composited into the RENDERED
  //    transform only (like recoil) — never bleeds into aim state. Subtle:
  //    information, not punishment (§4B). Amplitude scales with damage, capped.
  shakePerDmg: 0.0022,      // rad of shake amplitude added per point of damage
  shakeMax: 0.085,          // rad hard cap on shake amplitude (a big hit ≠ seizure)
  shakeDecay: 9.0,          // 1/s exp decay of the shake envelope
  shakeFreq: 34,            // Hz-ish oscillation rate of the shake noise

  // -- Death cam (§4B "death → camera drop/tilt (~0.6 s)"; the deferred camera
  //    item). On death the RENDERED view drops a touch + rolls to one side, eased
  //    in over deathCamTime; on respawn it eases back out (faster). Composited
  //    into the rendered transform ONLY — exactly like addShake/recoil above, it
  //    NEVER touches player aim (this.yaw/pitch) or the movement collider, so a
  //    dead player's view can tilt while the underlying aim state is untouched for
  //    the respawn. Frame-rate independent (progress advances on dt; the ease is a
  //    fixed curve over the timer, B2). Cleared cleanly on respawn.
  deathCamDrop: 0.35,       // m the eye sinks at full death tilt (~knees-buckle)
  deathCamRoll: 0.314,      // rad view roll at full tilt (~18°) — head lolls to one side
  deathCamTime: 0.6,        // s to ease fully INTO the death tilt (§4B ~0.6 s)
  deathCamClearTime: 0.28,  // s to ease back OUT on respawn (quick snap-up, §4B "cleared")

  // -- Low-health escalating stack (§4B; F9 — ALL layers derive from observed hp
  //    each frame, never from events, so respawn snaps them clean by construction).
  heartbeatBpmLow: 66,      // heartbeat rate (bpm) at the low-hp threshold
  heartbeatBpmCritical: 110, // heartbeat rate (bpm) at/below the critical threshold
  heartbeatGainLow: 0.28,   // heartbeat peak gain at the low threshold
  heartbeatGainCritical: 0.5, // heartbeat peak gain at/below critical
  lowHpVignetteLow: 0.30,   // steady red-edge vignette alpha at the low threshold
  lowHpVignetteCritical: 0.52, // vignette alpha at/below critical
  lowHpPulseHzLow: 1.0,     // ~1 Hz slow pulse of the low-hp vignette (§4B)
  lowHpPulseHzCritical: 1.9, // faster pulse at/below critical
  lowPassCutoffDry: 22000,  // sfx-bus low-pass cutoff (Hz) above the critical threshold (effectively open)
  lowPassCutoffWet: 900,    // sfx-bus low-pass cutoff (Hz) at/below critical ("about to die" muffle)
  lowPassSmooth: 5.0,       // 1/s exp smoothing of the cutoff so there's no zipper noise
};

export const INPUT = {
  radPerCount: 0.0022, // baseline look speed; the sensitivity slider multiplies this
  pitchLimitDeg: 89,
};

export const AUDIO = {
  masterVolume: 0.8,
  voiceCap: 16,        // H3 — hard cap on concurrent one-shots; steal the oldest
  uiVolume: 1.0,       // ui bus gain (relative to master) — menu/switch clicks
  sfxVolume: 1.0,      // sfx bus gain (relative to master) — everything gameplay

  // -- Positional audio (Phase 3, register H). Bot shots + deaths + footsteps
  //    play through a PannerNode at the bot's world pos; the LISTENER follows the
  //    camera every frame (position + orientation). 'equalpower' is the cheaper
  //    panning model (vs HRTF) — right for a small boxy arena (§ task brief).
  panningModel: 'equalpower',
  panRefDistance: 3,   // m — full volume within this radius of the listener
  panMaxDistance: 26,  // m — arena-scaled; beyond this a source is ~silent (24 m arena)
  panRolloff: 1.1,     // inverse-distance rolloff factor (how fast a source fades with range)

  // -- Enemy footsteps: honest and loud; own-team quieter (§4B competitive info).
  //    A step tick fires every stride interval per living MOVING bot, positional.
  //    Globally throttled so a scramble can't spam voices (steps are lowest
  //    priority — skipped when the voice pool is near the cap).
  footstepStrideSec: 0.34,   // s between steps at full run speed (scaled by actual speed)
  footstepMinSpeedFrac: 0.22, // fraction of runSpeed below which a bot is "not moving" (no steps)
  footstepEnemyGain: 0.5,    // peak gain of an ENEMY footstep (loud, honest)
  footstepAllyGain: 0.16,    // peak gain of an ALLY (own-team) footstep (quiet)
  footstepMaxPer100ms: 4,    // global cap: at most this many step sounds per 100 ms window
  footstepVoiceHeadroom: 4,  // skip steps when fewer than this many voice slots remain (lowest priority)

  // -- Bot combat sounds (positional). Shots reuse the rifle timbre; deaths get a
  //    team-flavored one-shot (crunchy for Bugs, a sadder beep for SEs).
  botShotGain: 0.5,          // peak gain scale of a positional bot rifle shot
  botDeathGain: 0.6,         // peak gain scale of a bot death sound
};

export const PERF = {
  dprCap: 2,     // I4
  shadows: true, // one static-baked directional shadow map (I3)
  decalCap: 64,
};

// ---------------------------------------------------------------------------
// FX — pooled-transient tunables (tracers / decals / impacts / muzzle flash).
// Presentation only: the truth already came from the camera ray (E1); these
// draw FROM the muzzle. Every value here feeds a pool sized once at boot (I1/I2).
// All lifetimes are seconds and tick on game dt — no wall-clock timers (B6).
// ---------------------------------------------------------------------------
export const FX = {
  tracerCount: 24,        // pool size — a 600 RPM burst never needs more live at once
  tracerLife: 0.07,       // s a tracer stays visible (~70 ms) then fades out
  tracerWidth: 0.03,      // m — thin additive streak
  tracerColor: 0xfff2c0,  // warm bullet-streak tint (additive)

  decalCount: PERF.decalCap, // ring buffer; mirrors the decal cap (I2)
  decalSize: 0.11,        // m — small dark bullet hole
  decalLife: 6.0,         // s before a decal fades (also freed by ring reuse)
  decalOffset: 0.006,     // m push off the surface to beat z-fighting (D3-style skin)
  decalColor: 0x0a0c12,   // near-black scorch

  impactCount: 64,        // particle pool across all simultaneous impacts
  impactPerHit: 5,        // puff particles spawned per resolved hit
  impactLife: 0.28,       // s particle lifetime
  impactSize: 0.05,       // m sprite edge
  impactSpeed: 3.2,       // m/s initial scatter speed
  impactGravity: 9.0,     // m/s² pull on particles
  impactWorldColor: 0xcdd6e6, // dust/spark tint on world hits (matches wall palette)
  impactHitColor: 0xff5a4d,   // hot tint on a target hit (reads as damage)

  flashCount: 10,         // muzzle-flash quads (Phase 3: shared by the player + up to 5 firing bots; still trivial)
  flashLife: 0.04,        // s (~40 ms) — a blink, no dynamic light (I3)
  flashSize: 0.22,        // m base edge of the flash quad
  flashColor: 0xffd27a,   // warm muzzle glow (additive/emissive)

  // -- Bug/SE death splat (Phase 3, §4B "the satisfying splat"). A burst of
  //    team-palette particles + a flat splat decal on the floor under the body.
  //    Bigger + more than a bullet impact; its own pools so it never steals the
  //    bullet-hole decal budget (I2). Additive particles read as a wet pop.
  splatCount: 96,         // particle pool shared across simultaneous splats
  splatPerKill: 14,       // particles flung per kill
  splatLife: 0.5,         // s particle lifetime (longer than an impact puff)
  splatSize: 0.09,        // m particle sprite edge
  splatSpeed: 4.5,        // m/s initial scatter speed
  splatGravity: 11.0,     // m/s² pull on splat particles
  splatDecalCount: 10,    // floor-splat decals (ring buffer; one per recent kill)
  splatDecalSize: 1.1,    // m edge of the flat floor splat
  splatDecalLife: 8.0,    // s before a floor splat fades out
  // Team palettes (§4B: bugs sickly green/dark, SEs teal/slate).
  splatBugColor: 0x6fae3a,   // sickly green — a squashed bug
  splatBugDecalColor: 0x24401a, // dark green floor stain
  splatSeColor: 0x3fb89e,    // teal (SE identity)
  splatSeDecalColor: 0x1c3a44,  // dark slate/teal floor stain
};

// ---------------------------------------------------------------------------
// VIEWMODEL — first-person weapon rig transform tuning. All animation is
// game-time + exp decay (B2/B6) so it's frame-rate independent and pause-safe.
// This is NOT head-bob (FEEL.headBob stays false) — just weapon sway/kick/dip.
// ---------------------------------------------------------------------------
export const VIEWMODEL = {
  posX: 0.20, posY: -0.18, posZ: -0.42, // rest offset from the camera (right-low, in front)
  followRate: 22,          // 1/s exp rate the rig eases toward its target transform

  recoilKick: 0.045,       // m the gun jumps back (−z, local) per shot
  recoilRot: 0.10,         // rad the muzzle pitches up per shot
  recoilRecover: 14,       // 1/s exp recovery of the gun's recoil (separate from camera recoil)

  lowerDrop: 0.14,         // m the rig sinks while lowered (sprint / raise)
  lowerRot: 0.5,           // rad it rotates away while lowered

  reloadDrop: 0.12,        // m dip during a reload
  reloadRot: 0.6,          // rad pitch tilt during a reload
  reloadRoll: 0.25,        // rad roll (z) during a reload

  swayAmount: 0.010,       // m lateral sway scale from horizontal speed (subtle)
  bobAmount: 0.010,        // m vertical bob scale from horizontal speed (subtle)
  bobBaseRate: 6,          // rad/s idle bob rate; horizontal speed adds to it

  knifeSwingRot: 1.4,      // rad peak of the knife swing arc
  knifeSwingRecover: 11,   // 1/s recovery of the knife swing
};

// ---------------------------------------------------------------------------
// CHARACTER — v1.1 LOOKS pass. Procedural, transform-only animation tunables for
// the SE + Bug figures and the first-person hands. NO skeletal/asset animation:
// every value here drives a leg/arm/antenna transform eased on game dt with
// exp smoothing (B2/B6) — frame-rate independent, pause-safe, zero per-frame
// alloc (I1). HITBOXES ARE FROZEN — nothing here touches bodyMin/bodyMax/
// headCenter/headRadius or any collider; it only moves cosmetic child meshes.
// ---------------------------------------------------------------------------
export const CHARACTER = {
  // -- Locomotion animation (both teams) ----------------------------------
  animSmooth: 14,          // 1/s exp rate limb targets ease toward their pose (no snap)
  strideHz: 2.2,           // leg-cycle frequency (Hz) at full run speed; scales with actual speed
  strideMinSpeed: 0.3,     // m/s below which the figure is "standing" (idle sway only, no stride)
  bobAmpBody: 0.035,       // m vertical body bob amplitude at full run (subtle)
  bobHz: 2.0,              // idle body-bob frequency (Hz) — a slow breathing sway when standing

  // -- SE dev figures ------------------------------------------------------
  seLegSwingDeg: 34,       // peak fore/aft leg swing (deg) at full run
  seArmSwingDeg: 10,       // peak arm counter-swing (deg) — small, arms hold the rifle
  seIdleArmSwayDeg: 3,     // gentle idle arm sway (deg) when standing

  // -- Bug creatures -------------------------------------------------------
  bugLegSkitterDeg: 26,    // peak leg-stub skitter swing (deg) at full run — alternating tripod pairs
  bugSkitterHzMult: 1.8,   // bug legs skitter faster than SE stride (× strideHz) — buggy, twitchy
  bugAntennaSwayDeg: 14,   // antenna sway amplitude (deg) — driven by speed + idle wobble
  bugBodyBobMult: 1.3,     // bug body bobs a touch more than an SE (× bobAmpBody)

  // -- First-person hands (viewmodel) -------------------------------------
  handColor: 0x9a7d63,     // neutral skin/glove tone for the forearm/hand hint boxes
  handColorKnife: 0x8f7358, // slightly darker for the knife hand (reads distinct)
};

// ---------------------------------------------------------------------------
// CROSSHAIR / HITMARKER — HUD combat-feedback tuning (register group G).
// Per-frame crosshair changes are transform-only (G2/G8): thin, size-capped.
// ---------------------------------------------------------------------------
export const CROSSHAIR = {
  pxPerRad: 900,          // spread(rad) → crosshair gap expansion in px (bloom feedback, G8)
  maxGapPx: 34,           // hard cap so the crosshair never becomes a blob (G8)
  baseGapPx: 6,           // resting gap between the dot and each line
  hitColor: '#ffffff',    // hitmarker X — outgoing confirm (white, H4/G-ladder)
  headColor: '#ffd166',   // headshot hitmarker variant (amber, distinct)
  killColor: '#ff5a4d',   // kill-confirm X tint
  lowAmmoFrac: 0.25,      // mag ≤ this fraction of magSize → ammo block flashes (G6)
};

// ---------------------------------------------------------------------------
// HUD (match layer, Phase 3) — scoreboard, kill feed, death/victory overlays.
// Colors are the team identity used everywhere the frontend paints a name/score
// (kill feed, scoreboard, "TERMINATED BY", verdict). Per-frame changes to these
// elements stay transform/opacity only (G2); text updates are event-driven.
// ---------------------------------------------------------------------------
export const HUD = {
  seColor: '#3fb89e',    // SE team tint (teal) — matches the SE head block
  bugColor: '#ff5a4d',   // Bug team tint (hot red) — matches the error-label badge
  neutralColor: '#8b94a7', // dim/neutral (separators, drawn state)
  killFeedMax: 4,        // last N kill-feed rows kept (G7 — bounded, pooled, fading)
  killFeedRowMs: 4200,   // s×1000 a kill-feed row stays fully lit before it fades out
  killFeedFadeMs: 600,   // s×1000 the row takes to fade once its life expires
  respawnCountFrom: 3,   // the death overlay's respawn countdown start (mirrors MATCH.respawnDelay; display only)
};

// Phase 2 practice dummies (§4B "Static targets with head + body zones").
// Targets are NOT movement colliders — the player walks through them (they're
// targets, not walls). Placed by targets.js clear of the feel-gym obstacles.
export const TARGETS = {
  respawnTime: 3.0,        // seconds a dead dummy stays down before full-hp respawn
  flinchTime: 0.12,        // seconds the onDamaged flinch flag stays raised (frontend renders it)
  hitSphereRadius: 0.24,   // head hit sphere — a touch larger than the visual head cube (generous, skilled direction; §4B/E3)
  sinkTime: 0.45,          // seconds the corpse takes to sink/shrink out of sight after a kill
  bodySize: { x: 0.55, y: 1.15, z: 0.35 }, // low-poly body box
  headSize: 0.34,          // visual head cube edge (hit sphere above is slightly larger)
  headGap: 0.06,           // gap between body top and head bottom
};

// ---------------------------------------------------------------------------
// MATCH — Team Deathmatch rules (Phase 3, the first real milestone). The clock
// is GAME-TIME (counts down off clamped dt, pause-safe, B6) — never wall-clock.
// Respawn + spawn-protection windows tick the same way (F10, §4B death/respawn).
// ---------------------------------------------------------------------------
export const MATCH = {
  teamSize: 5,             // 5 SE (you + 4 bots) vs 5 Bugs (bots)
  killTarget: 30,          // first team to this many enemy kills wins
  timeLimit: 300,          // seconds; higher score at expiry wins, equal = draw
  respawnDelay: 3.0,       // §4B: death → 3 s → respawn (player AND bots)
  spawnProtection: 1.5,    // §4B/F10: damage-immune + de-prioritized; breaks the moment you FIRE
  restartDelay: 4.0,       // seconds the "match over" screen holds before an auto-restart is allowed
};

// ---------------------------------------------------------------------------
// BOTS — the enemy/ally AI knobs (Phase 3). Bots deal EXACTLY player damage
// (read straight from COMBAT.rifle — difficulty NEVER touches damage; that
// keeps the STK/TTK model honest, §4B). Difficulty tunes only reaction, aim
// error, burst discipline, and headshot chance. `difficulty` is a plain mutable
// field the shell sets before match start; getBotTuning() folds the active
// preset over the shared base so match.js reads one object.
//
// The senses model (the "bots must feel human, not aimbot" grading checklist):
//   • LOS checked every losInterval s, STAGGERED per bot (never all same frame).
//   • Reaction = max(0, gauss(reactionMean, reactionSd)) on each acquisition.
//   • Aim error = a cone that starts at aimErrorStartDeg and tightens
//     exponentially toward aimErrorMinDeg over tightenTime while LOS holds;
//     resets on LOS loss. EXTRA error added ∝ target lateral speed (dodging is
//     rewarded, strafePenaltyDegPerMs) and ∝ the bot's OWN movement speed.
//   • Burst = burstShots ± burstJitter, then burstPauseMs; first-shot-of-burst
//     gets a small extra delay.
//   • Headshots: aim BODY by default; headAimChance (small) aims an acquisition
//     at the head instead. Never a laser lock.
// All time knobs are SECONDS unless the name ends in Ms/Deg.
// ---------------------------------------------------------------------------
export const BOTS = {
  difficulty: 'normal',    // 'easy' | 'normal' | 'hard' — shell sets before match start

  // -- Movement (kinematic; no physics engine, floor-locked y=0 — flat map) --
  accel: 10,               // 1/s exp approach of velocity toward the desired move (B2)
  arriveRadius: 0.6,       // m — "at" a waypoint node when within this
  repathInterval: 0.7,     // s between hunt BFS re-paths (staggered per bot)
  separationRadius: 1.1,   // m — pairwise push so bots never stack (BOTS.separationRadius)
  separationPush: 6.0,     // m/s² strength of the separation shove
  engageRange: 22,         // m — inside this a bot with LOS holds & fights instead of chasing
  strafeSpeedFrac: 0.55,   // fraction of runSpeed used for the lateral engage strafe jitter
  strafeFlipMin: 0.6,      // s — min time before an engage strafe flips direction
  strafeFlipMax: 1.6,      // s — max time before it flips (desync per bot)
  bodyRadiusXZ: 0.4,       // half-width of a bot's dynamic movement AABB (matches player halfWidth)
  bodyHeight: 1.8,         // bot collider/visual height (matches MOVE.height)

  // -- Senses cadence (shared across difficulties) --------------------------
  losInterval: 0.10,       // s between LOS raycasts per bot (staggered so not all fire the same frame)
  targetSwitchPenalty: 1.4, // a new target must be this× closer than the current to steal focus (hysteresis)
  flinchTime: 0.12,        // s the onDamaged flinch flag stays raised (frontend renders it, like dummies)
  aimHeightBody: 0.5,      // fraction of body height the "body center" aim point sits at
  loseSightGrace: 0.25,    // s of lost LOS tolerated before the bot fully drops the engagement to hunt

  // -- Firing (symmetric gun; reads COMBAT.rifle for damage/interval) --------
  // Bots use the rifle fire interval so their RPM matches a player's rifle.
  maxEngageDist: 60,       // m — never even attempt a shot beyond this (matches the arena scale)

  // -- Difficulty presets: reaction / aim error / burst / headshot only ------
  presets: {
    easy: {
      reactionMean: 0.42, reactionSd: 0.12,   // slow, twitchy
      aimErrorStartDeg: 8.0, aimErrorMinDeg: 2.2, tightenTime: 1.4,
      strafePenaltyDegPerMs: 0.010, selfMoveErrorDeg: 3.0,
      burstShots: 3, burstJitter: 1, burstPauseMs: 480, firstShotExtraMs: 90,
      headAimChance: 0.05,
    },
    normal: {
      reactionMean: 0.28, reactionSd: 0.08,   // the §4B baseline (~280 ± 80 ms)
      aimErrorStartDeg: 5.5, aimErrorMinDeg: 1.2, tightenTime: 1.0,
      strafePenaltyDegPerMs: 0.008, selfMoveErrorDeg: 2.0,
      burstShots: 4, burstJitter: 1, burstPauseMs: 340, firstShotExtraMs: 60,
      headAimChance: 0.12,
    },
    hard: {
      reactionMean: 0.18, reactionSd: 0.05,   // fast, tight — still not aimbot
      aimErrorStartDeg: 3.5, aimErrorMinDeg: 0.6, tightenTime: 0.7,
      strafePenaltyDegPerMs: 0.006, selfMoveErrorDeg: 1.3,
      burstShots: 6, burstJitter: 2, burstPauseMs: 240, firstShotExtraMs: 40,
      headAimChance: 0.22,
    },
  },
};

// Fold the active difficulty preset over the shared BOTS base into one flat
// object match.js/bots.js read. Called at match construction and on restart,
// so a difficulty change between matches takes effect. Zero per-frame use —
// this allocates once per match, never in the hot loop (I1).
export function getBotTuning() {
  const preset = BOTS.presets[BOTS.difficulty] ?? BOTS.presets.normal;
  return { ...BOTS, ...preset };
}
