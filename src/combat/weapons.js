// ============================================================================
// WeaponSystem — the fire/reload/switch state machine. This is the classic
// bug farm, so every interaction is decided and named against the register.
//
// Timing model: NO setTimeout anywhere (B6/E15). A per-weapon fire cooldown
// and the raise/reload state timers are game-time accumulators counted down by
// clamped dt — identical DPS at 30 and 240 fps (B3), and they resume correctly
// across a pause because dt simply stops arriving (E15). All smoothing/decay is
// 1−exp(−k·dt) (B2). Zero allocations per shot: module scratch + out-params (I1).
//
// Edge cases owned here (E-group shooting + R-group reload/switch rules):
//   E1  ray always from the camera center — via the injected getCameraRay.
//   E4  fire held across a pause is cleared by input.clearAll; auto-fire reads
//        the live held state, so it can't re-latch a stale press.
//   E5  semi-auto min interval caps autoclicker RPM.
//   E6  60 ms semi input buffer — a click just before cooldown expiry fires on expiry.
//   E7  fire input while sprinting → suppressSprint + buffered shot after sprint-out.
//   E8  fire blocked during weapon raise.
//   E10 reload swaps ammo ATOMICALLY at completion; cancel = nothing happened.
//   E11 switch cancels reload (mag untouched); switch-during-switch retargets newest.
//   E12 empty mag + fire → onDryFire, no auto-reload.
//   E14 knife can't headshot; backstab = rear-arc dot test → flat backstab damage.
//   E15 all weapon timers are game-time (pause-safe).
//   E16 headshot damage = round(body × headMult); 102>100 is intended (one-shot).
//   R1  R with full mag → no-op.          R2  R with zero reserve → no-op + onDryFire.
//   R3  reload timed, atomic at completion (= E10).
//   R4  switch cancels reload, mag untouched; switch-during-switch → newest.
//   R5  fire blocked during reload, does NOT cancel it.
//   R6  sprint during reload allowed (reload only blocks firing).
//   R7  pressing the current weapon's key → no-op; fire blocked during raise (= E8).
//   R8  empty mag + fire → onDryFire (no auto-reload) (= E12).
//   R9  out of everything → the knife is always there (infinite ammo).
//   R10 all weapon timing ticks off game dt (= B6/E15).
//
// Systems talk via plain nullable callback fields assigned in main.js — no
// event bus. Every emit guards the field (may be null). See the event surface
// at the bottom of this file.
// ============================================================================

import * as THREE from 'three';
import { COMBAT, MOVE } from '../config.js';
import { castRay, castKnife, makeHitResult } from './hitscan.js';
import { applyDamage, falloffMult } from './damage.js';

const LMB = 0;
const KEY_FOR = { rifle: 'Digit1', pistol: 'Digit2', knife: 'Digit3' };
const NAMES = ['rifle', 'pistol', 'knife'];
const INFINITE = Infinity; // knife reserve sentinel (R9)

// Module-scope scratch — zero allocations per shot/frame (I1).
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _toAttacker = new THREE.Vector3(); // backstab: victim→attacker, XZ
const _hit = makeHitResult();

export class WeaponSystem {
  constructor(worldColliders, targets) {
    this.world = worldColliders;
    this.targets = targets;

    // The Combatant firing this weapon (the player entity in Phase 3), used as
    // applyDamage's `source` for KILL CREDIT + the directional-danger source
    // position. Left null for the Phase-2/headless path (source falls back to
    // the weapon name — dummies ignore source, so nothing changes there). The
    // `targets` array and `world` colliders are ALSO live-reassignable fields:
    // main.js points them at match.enemiesOfPlayer + match.dynamicColliders
    // after the match is built (the fire path reads them fresh each shot).
    this.owner = null;

    // Per-weapon runtime ammo. Knife carries infinite reserve and no mag
    // gating (R9) — its "mag" stays Infinity so the fire path never dry-fires.
    this.ammo = {
      rifle: { mag: COMBAT.rifle.magSize, reserve: COMBAT.rifle.reserve },
      pistol: { mag: COMBAT.pistol.magSize, reserve: COMBAT.pistol.reserve },
      knife: { mag: INFINITE, reserve: INFINITE },
    };

    // Monotonic count of REAL shots fired (rifle/pistol/knife — not dry-fires).
    // A robust, weapon-agnostic fire signal the match watches to break the
    // player's spawn protection the moment they fire (§4B), independent of the
    // onFire callback (which the frontend owns). Never reset (it's an edge
    // detector — the match snapshots and compares).
    this.shotsFired = 0;

    this.active = 'rifle';
    this.state = 'raising';               // start by raising the rifle in (E8/R7)
    this.stateTimer = COMBAT.rifle.raiseTime;
    this.fireCooldown = 0;                // game-time countdown; ≤0 ⇒ may fire (B3)

    // Semi-auto buffered click (E6) and its remaining validity window.
    this.semiBuffered = false;
    this.semiBufferTimer = 0;

    // Sprint-out buffered shot (E7): a fire input during sprint parks here and
    // releases after the sprint-out window the controller is honoring.
    this.sprintOutTimer = 0;
    this.pendingSprintFire = false;

    // Spread bloom (degrees; converted in currentSpreadRad). Decays to 0 so the
    // FIRST shot after a lull is base-only — "first shot exact" (§4B).
    this.bloom = 0;

    // §4 movement spread penalty (Phase 4). A cached multiplier on the WHOLE
    // spread cone, recomputed each update() from the controller's live
    // horizontal speed: > movePenaltyFrac × runSpeed ⇒ this jumps to the
    // per-weapon spreadMovePenalty ("running scatters", CS-mold), else 1. Cached
    // (not recomputed inside currentSpreadRad) because currentSpreadRad is also
    // called per-FRAME by the HUD for crosshair bloom — so the crosshair honestly
    // widens while you move, and the shot + the display read the SAME factor.
    this._moveSpreadFactor = 1;

    // Switch-during-switch (R4) needs no separate queue: a newer press just
    // calls _beginSwitch again the same frame, re-pointing active + restarting
    // the raise on the newest weapon. There is no partial/committed ammo to
    // reconcile because reloads are atomic-at-completion (E10).

    // --- Events (nullable callback fields; main.js / frontend assign) -------
    this.getCameraRay = null; // (outOrigin, outDir, spreadRad) => void — injected in main.js (E1)
    this.onFire = null;          // ({ weapon, spreadRad, recoilDeg })
    this.onShotResolved = null;  // ({ result, killed, isHead, damage, weapon })
    this.onDryFire = null;       // (weapon)
    this.onReloadStart = null;   // (weapon)
    this.onReloadEnd = null;     // (weapon, completed)
    this.onSwitchStart = null;   // (name)
    this.onSwitchEnd = null;     // (name)
    this.onAmmoChanged = null;   // (weapon)
    this.onKill = null;          // (target, { isHead, weapon })
  }

  // ---- Introspection the frontend / viewmodel needs ------------------------
  get spec() { return COMBAT[this.active]; }

  // Sprinting OR raising → the viewmodel should show the weapon lowered.
  isLowered(controller) {
    return this.state === 'raising' || (controller && controller.sprinting);
  }

  // Spread cone half-angle in radians = (base + accumulated bloom) × the cached
  // movement penalty, all stored as degrees for human tuning. Bloom is 0 after
  // decay ⇒ a STANDING first shot is base-only (first shot exact, §4B); the
  // move factor is 1 when standing, so it doesn't disturb that. Both the shot
  // and the HUD crosshair read this, so a moving player SEES the wider cone.
  currentSpreadRad() {
    const base = this.spec.spreadBase ?? 0;
    return THREE.MathUtils.degToRad((base + this.bloom) * this._moveSpreadFactor);
  }

  // ---- Main tick. main.js gates this to the PLAYING state. -----------------
  update(dt, input, controller) {
    // Decay the fire cooldown and spread bloom on game time (B2/B3).
    if (this.fireCooldown > 0) this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    if (this.bloom > 0) this.bloom *= Math.exp(-(COMBAT.bloomDecay ?? 6) * dt);
    if (this.bloom < 1e-4) this.bloom = 0; // snap to exact so the next shot is base-only

    // §4 movement spread penalty: cache the cone multiplier from the controller's
    // live horizontal speed. Above movePenaltyFrac × runSpeed the per-weapon
    // spreadMovePenalty engages ("running scatters"); at/below it the cone is
    // unpenalized (factor 1). Knife (no penalty entry) always stays 1. Read here
    // once per frame so currentSpreadRad() — hit-tested this frame AND painted by
    // the HUD crosshair — reflects the same running-scatter state (I1: no alloc).
    this._moveSpreadFactor = 1;
    const penalty = COMBAT.spreadMovePenalty && COMBAT.spreadMovePenalty[this.active];
    if (penalty && controller && controller.vel) {
      const vx = controller.vel.x, vz = controller.vel.z;
      const speed = Math.sqrt(vx * vx + vz * vz);
      if (speed > (COMBAT.movePenaltyFrac ?? 0.4) * MOVE.runSpeed) this._moveSpreadFactor = penalty;
    }

    // Age the semi buffer window (E6).
    if (this.semiBufferTimer > 0) {
      this.semiBufferTimer -= dt;
      if (this.semiBufferTimer <= 0) { this.semiBuffered = false; this.semiBufferTimer = 0; }
    }

    // 1) Weapon-switch input (edge). A press retargets even mid-switch (R4).
    this._readSwitchInput(input);

    // 2) Advance the active timed state (raise / reload). May apply a queued
    //    switch or complete a reload atomically this tick (E10/R3).
    this._tickState(dt);

    // 3) Reload request (R with edge). Blocked/queued rules inside (R1/R2/R5).
    if (input.takePressed('KeyR')) this._requestReload();

    // 4) Firing — sprint-out gating, cooldown, buffers, the shot itself.
    this._tickFire(dt, input, controller);
  }

  // -------------------------------------------------------------------------
  // Switching
  // -------------------------------------------------------------------------
  _readSwitchInput(input) {
    // Drain ALL three keys (each is a once-per-press token); the newest press
    // in scan order wins if several land in one frame (R4 "newest press").
    let want = null;
    for (let i = 0; i < NAMES.length; i++) {
      const name = NAMES[i];
      if (input.takePressed(KEY_FOR[name])) want = name;
    }
    if (!want) return;
    // R7: pressing the CURRENT weapon's key is a no-op — even mid-raise, it
    // must not restart the raise. Only a switch to a DIFFERENT weapon acts.
    if (want === this.active) return;
    this._beginSwitch(want); // switch-during-switch retargets to this newest (R4)
  }

  _beginSwitch(name) {
    // Switching cancels an in-progress reload; the mag is left exactly as it
    // was (E11/R4) — atomic-at-completion means no partial ammo ever existed.
    if (this.state === 'reloading') this._endReload(false);

    this.active = name;
    this.state = 'raising';
    this.stateTimer = this.spec.raiseTime; // E8/R7: fire blocked until this drains
    this._cancelBufferedFire(); // a queued shot from the old weapon must not carry over
    if (this.onSwitchStart) this.onSwitchStart(name);
  }

  // -------------------------------------------------------------------------
  // Timed-state advance (raise / reload)
  // -------------------------------------------------------------------------
  _tickState(dt) {
    if (this.state === 'ready') return;
    this.stateTimer -= dt; // game-time (E15/R10)
    if (this.stateTimer > 0) return;

    if (this.state === 'raising') {
      this.state = 'ready';
      this.stateTimer = 0;
      if (this.onSwitchEnd) this.onSwitchEnd(this.active);
    } else if (this.state === 'reloading') {
      this._completeReload(); // E10/R3: ammo moves ONLY here
    }
  }

  // -------------------------------------------------------------------------
  // Reload
  // -------------------------------------------------------------------------
  _requestReload() {
    if (this.active === 'knife') return;           // knife never reloads (R9)
    if (this.state === 'raising') return;          // can't reload mid-raise; feels wrong
    if (this.state === 'reloading') return;        // already reloading

    const a = this.ammo[this.active];
    const spec = this.spec;
    if (a.mag >= spec.magSize) return;             // R1: full mag → no-op
    if (a.reserve <= 0) {                          // R2: zero reserve → no-op + dry click
      if (this.onDryFire) this.onDryFire(this.active);
      return;
    }

    this.state = 'reloading';
    this.stateTimer = spec.reloadTime;             // game-time countdown (E15)
    this._cancelBufferedFire();                    // no shot queued through a reload (R5)
    if (this.onReloadStart) this.onReloadStart(this.active);
  }

  _completeReload() {
    // E10/R3: the ONLY place ammo moves during a reload. Move as much reserve
    // as the mag needs, capped by what's actually in reserve — no duplication,
    // no loss, even if magSize was retuned live.
    const a = this.ammo[this.active];
    const spec = this.spec;
    const need = spec.magSize - a.mag;
    const take = Math.min(need, a.reserve);
    a.mag += take;
    a.reserve -= take;

    this.state = 'ready';
    this.stateTimer = 0;
    if (this.onReloadEnd) this.onReloadEnd(this.active, true); // completed
    if (this.onAmmoChanged) this.onAmmoChanged(this.active);
  }

  // Cancel WITHOUT moving ammo (switch-cancel). completed=false (E10/R4).
  _endReload(completed) {
    if (this.state !== 'reloading') return;
    this.state = 'ready';
    this.stateTimer = 0;
    if (this.onReloadEnd) this.onReloadEnd(this.active, completed);
  }

  // -------------------------------------------------------------------------
  // Firing
  // -------------------------------------------------------------------------
  _tickFire(dt, input, controller) {
    const spec = this.spec;
    const isSemi = spec.mode === 'semi';

    // Age the sprint-out window; note the frame it drains so the parked shot
    // can release this same tick (E7).
    let sprintReleased = false;
    if (this.sprintOutTimer > 0) {
      this.sprintOutTimer = Math.max(0, this.sprintOutTimer - dt);
      if (this.sprintOutTimer === 0 && this.pendingSprintFire) sprintReleased = true;
    }

    // The player's fire intent this frame. Read the click edge unconditionally
    // (it's a once-per-press token — leaving it unread would leak into a later
    // frame). auto/melee fire while held; semi fires on the edge.
    const held = input.buttons.has(LMB);
    const edge = input.takeMousePressed(LMB);
    const wantFire = isSemi ? edge : held;

    // Firing needs the 'ready' state: blocked during raise (E8/R7) and reload
    // (R5). The reload is NOT cancelled — the fire input is simply dropped.
    const canAct = this.state === 'ready';
    if (!canAct) return;

    // E7: a fire intent while actually sprinting drops sprint and PARKS the
    // shot; it fires once the sprint-out window elapses. No sprint-strafe laser
    // accuracy. (controller.sprinting already reflects any suppression from a
    // previous frame — the controller ticks before us.)
    if (wantFire && controller && controller.sprinting) {
      controller.suppressSprint(COMBAT.sprintOutTime);
      this.sprintOutTimer = COMBAT.sprintOutTime;
      this.pendingSprintFire = true;
      return; // resolves post-sprint-out via sprintReleased
    }

    // While the sprint-out window is still draining, the ONLY thing that may
    // fire is the parked shot on release. A normal held/semi shot must not slip
    // through just because suppression already forced sprinting=false — that
    // would defeat the 150 ms sprint-out entirely.
    if (this.sprintOutTimer > 0 && !sprintReleased) return;

    // Fire decision for this frame.
    let fireNow = false;
    if (sprintReleased) {
      // Sprint-out just finished → fire the parked shot regardless of the
      // current button state (the intent was already registered).
      this.pendingSprintFire = false;
      fireNow = this.fireCooldown <= 0;
    } else if (isSemi) {
      fireNow = this._resolveSemi(edge);
    } else if (wantFire) {
      fireNow = this.fireCooldown <= 0; // auto / melee: gated purely by cooldown
    }

    if (fireNow) this._fire(controller);
  }

  // Semi-auto: returns whether to fire THIS frame, honoring the min interval
  // (E5) and the 60 ms pre-expiry buffer (E6).
  _resolveSemi(edge) {
    if (edge) {
      if (this.fireCooldown <= 0) return true;                       // ready → fire
      // Cooldown still running: buffer the click only if it lands inside the
      // last `semiBufferMs` of it (E6). Earlier clicks are dropped (E5 cap).
      if (this.fireCooldown <= COMBAT.semiBufferMs / 1000) {
        this.semiBuffered = true;
        this.semiBufferTimer = COMBAT.semiBufferMs / 1000;
      }
      return false;
    }
    // No new edge: release a valid buffered click the instant cooldown expires.
    if (this.semiBuffered && this.fireCooldown <= 0) {
      this.semiBuffered = false;
      this.semiBufferTimer = 0;
      return true;
    }
    return false;
  }

  _fire(controller) {
    const spec = this.spec;
    const a = this.ammo[this.active];

    // R8/E12: empty mag → dry click, NO auto-reload. Knife's mag is Infinity
    // so it never trips this. Reset the cooldown so a held empty gun clicks at
    // most once per fire interval rather than every frame.
    if (a.mag <= 0) {
      this.fireCooldown = spec.fireInterval;
      this._cancelBufferedFire();
      if (this.onDryFire) this.onDryFire(this.active);
      return;
    }

    this.fireCooldown = spec.fireInterval; // next-shot-time, game-time (B3)
    this.shotsFired++;                     // a real shot committed (fire signal, all weapons)
    if (this.active !== 'knife') {
      a.mag -= 1;
      if (this.onAmmoChanged) this.onAmmoChanged(this.active);
    }

    const isKnife = this.active === 'knife';
    const spreadRad = isKnife ? 0 : this.currentSpreadRad(); // first shot exact; knife has no cone

    // E1: the ray ALWAYS starts at the camera center. main.js injects this and
    // applies the spread cone sample into _dir.
    if (this.getCameraRay) {
      this.getCameraRay(_origin, _dir, spreadRad);
    } else {
      // Defensive: no ray source wired (headless bring-up). Emit onFire so
      // ammo/feedback still flow, but resolve nothing.
      if (this.onFire) this.onFire({ weapon: this.active, spreadRad, recoilDeg: spec.recoilPerShot ?? 0 });
      return;
    }

    // Recoil kick is emitted for the CAMERA to apply — the weapon never touches
    // the camera. Bloom grows AFTER this shot so the shot just fired used the
    // pre-bloom cone (first-shot-exact holds).
    if (this.onFire) {
      this.onFire({ weapon: this.active, spreadRad, recoilDeg: spec.recoilPerShot ?? 0 });
    }
    if (!isKnife) {
      this.bloom = Math.min((COMBAT.maxBloom ?? 1.4), this.bloom + (spec.bloomPerShot ?? 0));
    }

    // Cast + resolve.
    if (isKnife) {
      castKnife(_origin, _dir, spec.range, this.world, this.targets, _hit, COMBAT.knife.hitPad ?? 0);
    } else {
      castRay(_origin, _dir, 1000, this.world, this.targets, _hit); // "unlimited" reach; range shows up as damage falloff (§4, applied below)
    }

    let killed = false;
    let isHead = false;
    let damage = 0;

    if (_hit.hitSomething && _hit.target) {
      const tgt = _hit.target;
      if (isKnife) {
        // E14: knife can't headshot. Backstab iff the attacker is in the
        // victim's rear 120° arc: dot(victimForwardXZ, norm(attacker−victim).xz) < backstabDot.
        // Knife has NO range falloff (touching distance only — no COMBAT.falloff entry).
        damage = this._knifeDamage(tgt, controller);
        isHead = false;
      } else {
        isHead = _hit.isHead;
        // §4 range model — call order is FIXED: headshot multiplier on the base
        // body damage FIRST, THEN range falloff, THEN Math.round (falloffMult in
        // damage.js documents the contract). A long-range rifle headshot
        // (102 × ~0.6 ≈ 61) may thus no longer one-shot — intended (§4). Uses the
        // hit distance from the SAME cast (_hit.dist). Bots run identical math in
        // BotGun.fire (symmetry is sacred, §4B).
        const pre = isHead ? spec.body * spec.headMult : spec.body;
        damage = Math.round(pre * falloffMult(this.active, _hit.dist));
      }
      // source = the firing Combatant (kill credit + danger source pos); falls
      // back to the weapon name when no owner is wired (Phase-2/headless).
      const res = applyDamage(tgt, damage, this.owner ?? this.active, isHead);
      killed = res.killed;
      damage = res.amount; // the amount actually dealt (0 if guarded)
      if (killed && this.onKill) this.onKill(tgt, { isHead, weapon: this.active });
    }

    if (this.onShotResolved) {
      this.onShotResolved({ result: _hit, killed, isHead, damage, weapon: this.active });
    }
  }

  // Backstab arc test (E14/§4B). Falls back to front damage when we lack a
  // controller position (headless without a player). Uses XZ only — a source
  // directly above/below still reads by horizontal facing.
  _knifeDamage(target, controller) {
    const front = COMBAT.knife.body;
    const back = COMBAT.knife.backstab;
    if (!controller || !target.forward) return front;

    _toAttacker.set(
      controller.pos.x - target.pos.x,
      0,
      controller.pos.z - target.pos.z,
    );
    if (_toAttacker.lengthSq() < 1e-6) return back; // exactly on top → treat as behind
    _toAttacker.normalize();
    // target.forward is a unit XZ facing (y ignored).
    const dot = target.forward.x * _toAttacker.x + target.forward.z * _toAttacker.z;
    return dot < COMBAT.knife.backstabDot ? back : front;
  }

  _cancelBufferedFire() {
    this.semiBuffered = false;
    this.semiBufferTimer = 0;
    this.pendingSprintFire = false;
    this.sprintOutTimer = 0;
  }

  // On respawn (wired in Phase 3): refill reserve + reset state (R "reserve
  // refills on respawn"). Present now so the player entity can call it.
  refill() {
    this.ammo.rifle = { mag: COMBAT.rifle.magSize, reserve: COMBAT.rifle.reserve };
    this.ammo.pistol = { mag: COMBAT.pistol.magSize, reserve: COMBAT.pistol.reserve };
    this.ammo.knife = { mag: INFINITE, reserve: INFINITE };
    this.bloom = 0;
    this._cancelBufferedFire();
    if (this.onAmmoChanged) this.onAmmoChanged(this.active);
  }
}

// ============================================================================
// EVENT SURFACE (for the frontend agent) — all nullable, guard before calling:
//   getCameraRay(outOrigin, outDir, spreadRad)  INPUT hook, injected by main.js
//   onFire         ({ weapon, spreadRad, recoilDeg })   // recoilDeg: degrees, camera applies it
//   onShotResolved ({ result, killed, isHead, damage, weapon })
//                    result = hitscan out: { hitSomething, point, normalAxis,
//                    normalSign, target, isHead, dist }
//   onDryFire      (weapon)
//   onReloadStart  (weapon)
//   onReloadEnd    (weapon, completed)   // completed=false ⇒ switch-cancelled
//   onSwitchStart  (name)
//   onSwitchEnd    (name)
//   onAmmoChanged  (weapon)
//   onKill         (target, { isHead, weapon })
// ============================================================================
