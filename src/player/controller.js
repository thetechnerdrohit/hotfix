// ============================================================================
// Hand-rolled character controller — no physics engine, on purpose (feel).
// Movement: normalized wish direction (C1), exponential accel (B2), separate
// air control (C6), sprint only forward-ish (C2), coyote time + jump buffer
// (C3/C4), semi-implicit gravity with a fall cap (B5/C8).
// Collision: per-axis AABB collide-and-slide, Y first (D1), skin epsilon
// (D3), head bumps zero only upward velocity (C7), kill-floor insurance (D9).
// Verticality (v1.2, register group K): a GROUNDED horizontal pass that hits a
// collider whose top is within MOVE.stepHeight of the feet AND has headroom
// above it (K1/K2) LIFTS the feet to that top and lets the move proceed —
// auto-climbing low ledges/stairs; disabled while airborne. After the moves, a
// grounded, non-rising player SNAPS DOWN to a collider top within
// MOVE.stepSnapDown (K4) so descending stairs stays grounded (no per-step
// bounce/air-strafe). Every pos.y step feeds a cosmetic eye-smooth offset the
// camera decays (K3) so the view glides, never pops. On flat ground both are
// exact no-ops (nothing to step onto; snap-down finds the same floor → 0).
// Combat interplay: suppressSprint(s) forces sprint off for a game-time window
// so a fire input drops sprint before the shot lands (E7); the weapon system
// owns the timing, the controller just honors the suppression.
// ADS interplay (v1.2, L-move): speedScale is a plain multiplier on the target
// horizontal speed the weapon system sets each frame from the eased ADS blend
// (1 = no ADS ⇒ true no-op). It ONLY scales the desired top speed — accel,
// air-control, jump, gravity, sprint gating are all untouched.
// ============================================================================

import * as THREE from 'three';
import { MOVE } from '../config.js';

const EPS = 1e-3; // collision skin (D3/D4)
const KILL_FLOOR_Y = -20; // a collider-authoring mistake respawns instead of falling forever (D9)

const _wish = new THREE.Vector3(); // scratch — zero allocations per frame (I1)

export class PlayerController {
  constructor(spawnPoint) {
    this.spawn = spawnPoint.clone();
    this.pos = spawnPoint.clone(); // feet position
    this.vel = new THREE.Vector3();
    this.grounded = false;
    this.coyote = 0;     // seconds remaining (C3/C10)
    this.jumpBuffer = 0; // seconds remaining (C4)
    this.sprinting = false;
    this.sprintSuppress = 0; // seconds sprint is force-disabled (E7 sprint-out); game-time
    this.speedScale = 1; // L-move: ADS move-speed multiplier (weapons sets it each frame; 1 = no-op)
    this.landImpact = 0; // m/s at touchdown this frame; camera dip consumes it (C9)
    this.stepRise = 0;   // K3: metres pos.y jumped UP via step-up/snap-up THIS frame; the camera pushes its eye offset down by this and decays it, so a step glides instead of popping. 0 on any frame with no step (flat ground). Never affects pos/collider.
  }

  // Force sprint off for `seconds` (game-time, pause-safe). The weapon system
  // calls this when a fire input arrives mid-sprint so the sprint-out elapses
  // before the buffered shot fires (E7). Extends, never shortens, an active
  // window — repeated fire taps can't chip it down.
  suppressSprint(seconds) {
    this.sprintSuppress = Math.max(this.sprintSuppress, seconds);
  }

  update(dt, input, yaw, colliders) {
    // Wish direction, camera-relative, normalized (C1 — no √2 diagonals)
    const f = (input.pressed('KeyW') ? 1 : 0) - (input.pressed('KeyS') ? 1 : 0);
    const r = (input.pressed('KeyD') ? 1 : 0) - (input.pressed('KeyA') ? 1 : 0);
    _wish.set(
      -Math.sin(yaw) * f + Math.cos(yaw) * r,
      0,
      -Math.cos(yaw) * f - Math.sin(yaw) * r,
    );
    const moving = _wish.lengthSq() > 0;
    if (moving) _wish.normalize();

    // Sprint applies only with a forward component (C2), and never during the
    // fire sprint-out window (E7). Timer ticks on game dt so it survives pause.
    this.sprintSuppress = Math.max(0, this.sprintSuppress - dt);
    const wantSprint = input.pressed('ShiftLeft') || input.pressed('ShiftRight');
    this.sprinting = wantSprint && moving && f > 0 && this.sprintSuppress === 0;
    // L-move: ADS scales the TARGET top speed only (accel/air/jump untouched).
    // sprinting is already false while aiming (L2 drops sprint), so this composes
    // cleanly with the sprint gate above.
    const speed = MOVE.runSpeed * (this.sprinting ? MOVE.sprintMult : 1) * this.speedScale;

    // Horizontal velocity: exponential approach → identical feel at any fps (B2)
    const accel = this.grounded ? MOVE.accelGround : MOVE.accelAir;
    const k = 1 - Math.exp(-accel * dt);
    this.vel.x += (_wish.x * speed - this.vel.x) * k;
    this.vel.z += (_wish.z * speed - this.vel.z) * k;

    // Gravity: semi-implicit Euler, terminal velocity cap (B5/C8)
    this.vel.y = Math.max(this.vel.y - MOVE.gravity * dt, -MOVE.maxFallSpeed);

    // K4: LAST frame's contact truth, captured before the jump block and the
    // per-frame grounded reset. Snap-down must key off this — on the FIRST
    // airborne frame after walking over a lip, this frame's Y pass has already
    // lost contact, so a post-Y-pass flag reads false and the snap never fires
    // (the player free-falls the whole staircase — caught in the v1.2 gate).
    const wasGrounded = this.grounded;

    // Jump forgiveness (C3/C4): buffer the press, allow it during coyote
    if (input.takeJump()) this.jumpBuffer = MOVE.jumpBufferMs / 1000;
    else this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.coyote = this.grounded ? MOVE.coyoteMs / 1000 : Math.max(0, this.coyote - dt);

    if (this.jumpBuffer > 0 && (this.grounded || this.coyote > 0)) {
      this.vel.y = Math.sqrt(2 * MOVE.gravity * MOVE.jumpHeight);
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuffer = 0;
    }

    // Integrate per axis with collide-and-slide, Y first (D1). grounded is
    // re-derived from contact every frame, so walking off an edge arms
    // coyote exactly like a jump would (C10).
    this.landImpact = 0;
    this.stepRise = 0; // K3: reset each frame; step-up/snap-up add to it below
    this.grounded = false;
    // groundedBefore captures ground contact from the Y pass, BEFORE the
    // horizontal passes can clear it. Step-up (K1) is gated on being grounded at
    // the START of the horizontal move — a mid-air player never auto-climbs.
    this.moveAxis('y', this.vel.y * dt, colliders);
    const groundedBefore = this.grounded;
    this.moveAxis('x', this.vel.x * dt, colliders, groundedBefore);
    this.moveAxis('z', this.vel.z * dt, colliders, groundedBefore);

    // Snap-down (K4): if we were grounded and are WALKING down (not jumping —
    // vel.y ≤ 0, and not launched this frame since a jump sets grounded=false and
    // vel.y>0), and there's a collider top just below the feet within
    // stepSnapDown, drop onto it and stay grounded. Stops the "step off the lip →
    // free-fall a few cm → re-land" bounce that lets you air-strafe down stairs.
    // wasGrounded (last frame), NOT groundedBefore (this frame's Y pass): the
    // first frame past a stair lip has groundedBefore=false but wasGrounded=true
    // — exactly the frame the snap must catch. A jump is excluded by vel.y > 0.
    if (wasGrounded && !this.grounded && this.vel.y <= 0) this._snapDown(colliders);

    if (this.pos.y < KILL_FLOOR_Y) this.respawn();
  }

  // canStep: true only for grounded horizontal passes (K1). When a horizontal
  // move is blocked by a collider whose top is a climbable step (≤ stepHeight
  // above the feet) AND the player fits above that top (headroom, K2), we LIFT
  // the feet to the top and let the horizontal move stand instead of stopping —
  // auto-stepping the ledge. Otherwise it's the classic per-axis wall block (D1).
  moveAxis(axis, delta, colliders, canStep) {
    if (delta === 0 && axis !== 'y') return; // y always runs so ground contact re-asserts
    this.pos[axis] += delta;

    const hw = MOVE.halfWidth;
    const h = MOVE.height;
    const p = this.pos;

    for (const c of colliders) {
      const overlaps =
        p.x - hw < c.max.x && p.x + hw > c.min.x &&
        p.y < c.max.y && p.y + h > c.min.y &&
        p.z - hw < c.max.z && p.z + hw > c.min.z;
      if (!overlaps) continue;

      if (axis === 'y') {
        if (delta <= 0) {
          if (this.vel.y < 0) this.landImpact = -this.vel.y; // touchdown speed (C9)
          p.y = c.max.y;
          this.grounded = true;
        } else {
          p.y = c.min.y - h - EPS; // head bump: stop rising, keep falling free (C7)
        }
        this.vel.y = 0;
      } else {
        // Horizontal block. Try to STEP UP over it first (K1/K2): grounded, the
        // obstacle top is within stepHeight of the feet, and the player fits
        // above that top with no other collider in the way.
        const rise = c.max.y - p.y;
        if (canStep && rise > EPS && rise <= MOVE.stepHeight && this._hasHeadroom(c.max.y, colliders)) {
          p.y = c.max.y;            // lift feet to the step top; keep the horizontal delta
          this.stepRise += rise;    // K3: camera glides this away (never touches collider)
          continue;                 // move stands — DON'T zero horizontal velocity
        }
        if (axis === 'x') {
          p.x = delta > 0 ? c.min.x - hw - EPS : c.max.x + hw + EPS;
          this.vel.x = 0;
        } else {
          p.z = delta > 0 ? c.min.z - hw - EPS : c.max.z + hw + EPS;
          this.vel.z = 0;
        }
      }
    }
  }

  // K2: does the player's full-height box fit standing on `topY`? True unless
  // some collider overlaps the XZ footprint AND intrudes into [topY, topY+h] —
  // i.e. a ceiling too low above the step (don't climb into a crevice). Uses a
  // small skin so the step's OWN top face (topY == c.max.y) never counts.
  _hasHeadroom(topY, colliders) {
    const hw = MOVE.halfWidth;
    const h = MOVE.height;
    const p = this.pos;
    const headMax = topY + h;
    for (const c of colliders) {
      if (p.x - hw >= c.max.x || p.x + hw <= c.min.x) continue;
      if (p.z - hw >= c.max.z || p.z + hw <= c.min.z) continue;
      // Overlaps [topY+skin, headMax)? (skin excludes the step surface itself.)
      if (c.min.y < headMax - EPS && c.max.y > topY + EPS) return false;
    }
    return true;
  }

  // K4: find the highest collider top within [feet-stepSnapDown, feet] under the
  // XZ footprint and drop the feet onto it, re-grounding. Called only when we
  // walked off a lip while grounded and aren't jumping — so descending stairs
  // stays glued. The downward move is a cosmetic step too, so it feeds stepRise
  // NEGATIVELY? No: stepRise is only for UP pops (camera pushes DOWN then decays
  // up); a snap-DOWN doesn't pop the view upward, so it's left out of stepRise.
  _snapDown(colliders) {
    const hw = MOVE.halfWidth;
    const p = this.pos;
    const lowest = p.y - MOVE.stepSnapDown;
    let bestTop = -Infinity;
    for (const c of colliders) {
      if (p.x - hw >= c.max.x || p.x + hw <= c.min.x) continue;
      if (p.z - hw >= c.max.z || p.z + hw <= c.min.z) continue;
      // Top must sit in the snap band (just below the feet) and be the highest.
      if (c.max.y <= p.y + EPS && c.max.y >= lowest && c.max.y > bestTop) bestTop = c.max.y;
    }
    if (bestTop > -Infinity && bestTop < p.y - EPS) {
      p.y = bestTop;
      this.vel.y = 0;
      this.grounded = true;
    } else if (bestTop > -Infinity) {
      // Already resting on it (flat ground / same level) — just re-assert grounded.
      this.grounded = true;
    }
  }

  respawn() {
    if (import.meta.env.DEV) console.warn('[hotfix] fell out of the world — collider hole? (D9)');
    this.pos.copy(this.spawn);
    this.vel.set(0, 0, 0);
  }
}
