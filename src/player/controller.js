// ============================================================================
// Hand-rolled character controller — no physics engine, on purpose (feel).
// Movement: normalized wish direction (C1), exponential accel (B2), separate
// air control (C6), sprint only forward-ish (C2), coyote time + jump buffer
// (C3/C4), semi-implicit gravity with a fall cap (B5/C8).
// Collision: per-axis AABB collide-and-slide, Y first (D1), skin epsilon
// (D3), head bumps zero only upward velocity (C7), kill-floor insurance (D9).
// Combat interplay: suppressSprint(s) forces sprint off for a game-time window
// so a fire input drops sprint before the shot lands (E7); the weapon system
// owns the timing, the controller just honors the suppression.
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
    this.landImpact = 0; // m/s at touchdown this frame; camera dip consumes it (C9)
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
    const speed = MOVE.runSpeed * (this.sprinting ? MOVE.sprintMult : 1);

    // Horizontal velocity: exponential approach → identical feel at any fps (B2)
    const accel = this.grounded ? MOVE.accelGround : MOVE.accelAir;
    const k = 1 - Math.exp(-accel * dt);
    this.vel.x += (_wish.x * speed - this.vel.x) * k;
    this.vel.z += (_wish.z * speed - this.vel.z) * k;

    // Gravity: semi-implicit Euler, terminal velocity cap (B5/C8)
    this.vel.y = Math.max(this.vel.y - MOVE.gravity * dt, -MOVE.maxFallSpeed);

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
    this.grounded = false;
    this.moveAxis('y', this.vel.y * dt, colliders);
    this.moveAxis('x', this.vel.x * dt, colliders);
    this.moveAxis('z', this.vel.z * dt, colliders);

    if (this.pos.y < KILL_FLOOR_Y) this.respawn();
  }

  moveAxis(axis, delta, colliders) {
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
      } else if (axis === 'x') {
        p.x = delta > 0 ? c.min.x - hw - EPS : c.max.x + hw + EPS;
        this.vel.x = 0;
      } else {
        p.z = delta > 0 ? c.min.z - hw - EPS : c.max.z + hw + EPS;
        this.vel.z = 0;
      }
    }
  }

  respawn() {
    if (import.meta.env.DEV) console.warn('[hotfix] fell out of the world — collider hole? (D9)');
    this.pos.copy(this.spawn);
    this.vel.set(0, 0, 0);
  }
}
