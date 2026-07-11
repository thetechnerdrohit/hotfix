// ============================================================================
// Keyboard + mouse + pointer-lock lifecycle.
// Implements edge-case register group A: physical key codes (A5), repeat
// guards (A6), blur clearing (A4), delta clamping (A9), unadjustedMovement
// with fallback (A10/J4), gesture + cooldown rules (A2/A3), double-request
// guard (A13), state-boundary input clearing (A14).
// Also exposes edge-press buffers — takePressed(code)/takeMousePressed(button)
// — armed once per physical press (A6) and drained by consumers; the weapon
// switch keys and semi-fire click ride these. All buffers clear in clearAll so
// nothing crosses a pause/lock boundary (A14/E4).
// ============================================================================

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'Space', 'ShiftLeft', 'ShiftRight', 'Tab',
  'KeyR', 'Digit1', 'Digit2', 'Digit3',
]);

const MAX_DELTA = 300; // per-event mouse delta clamp (A9)

export class Input {
  constructor() {
    this.keys = new Set();
    this.buttons = new Set();
    this.pressedKeys = new Set();    // edge buffer: keys pressed since last drain (A6)
    this.pressedButtons = new Set(); // edge buffer: mouse buttons pressed since last drain
    this.dx = 0;
    this.dy = 0;
    this.jumpQueued = false;
    this.locked = false;
    this.lockPending = false;
    this.onLockChange = null;   // (locked) => void
    this.onLockRejected = null; // () => void
    this.el = null;
  }

  attach(el) {
    this.el = el;

    window.addEventListener('keydown', (e) => {
      if (this.locked && GAME_KEYS.has(e.code)) e.preventDefault(); // A7
      if (e.repeat) return; // A6: edge-triggered actions arm once per press
      this.keys.add(e.code);
      this.pressedKeys.add(e.code); // edge arm (drained by takePressed)
      if (e.code === 'Space') this.jumpQueued = true;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    // A4: focus loss must never leave a key stuck down
    window.addEventListener('blur', () => this.clearAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clearAll();
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.dx += Math.max(-MAX_DELTA, Math.min(MAX_DELTA, e.movementX));
      this.dy += Math.max(-MAX_DELTA, Math.min(MAX_DELTA, e.movementY));
    });
    document.addEventListener('mousedown', (e) => {
      if (this.locked && e.button !== 0) e.preventDefault(); // A11
      this.buttons.add(e.button);
      this.pressedButtons.add(e.button); // edge arm (drained by takeMousePressed)
    });
    document.addEventListener('mouseup', (e) => this.buttons.delete(e.button));
    document.addEventListener('contextmenu', (e) => {
      if (this.locked) e.preventDefault(); // A12
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      this.lockPending = false;
      this.clearAll(); // A14: no stale input crosses a state boundary
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => {
      this.lockPending = false;
      if (this.onLockRejected) this.onLockRejected();
    });
  }

  // Call synchronously from inside a user gesture (A3).
  requestLock() {
    if (this.locked || this.lockPending) return; // A13
    this.lockPending = true;

    let result;
    try {
      // A10: bypass OS mouse acceleration where supported
      result = this.el.requestPointerLock({ unadjustedMovement: true });
    } catch {
      result = undefined; // engines that reject the options bag synchronously
    }

    if (result instanceof Promise) {
      result.catch(() => {
        // Either unadjustedMovement is unsupported (J4) or we're inside
        // Chrome's ~1.25 s re-lock cooldown (A2). Retry plain; if that also
        // fails, surface it — never a silently dead Resume button.
        let retry;
        try {
          retry = this.el.requestPointerLock();
        } catch {
          retry = undefined;
        }
        if (retry instanceof Promise) {
          retry.catch(() => {
            this.lockPending = false;
            if (this.onLockRejected) this.onLockRejected();
          });
        }
      });
    } else if (result === undefined && !('requestPointerLock' in this.el)) {
      this.lockPending = false;
      if (this.onLockRejected) this.onLockRejected();
    }
    // Non-promise engines report through pointerlockchange/error events.
  }

  pressed(code) {
    return this.keys.has(code);
  }

  // Edge-triggered jump: returns true once per physical press (C5)
  takeJump() {
    const j = this.jumpQueued;
    this.jumpQueued = false;
    return j;
  }

  // Edge-triggered key: true exactly once per physical press, then consumed
  // (A6). Weapon-switch keys (Digit1/2/3) and R read through this.
  takePressed(code) {
    if (!this.pressedKeys.has(code)) return false;
    this.pressedKeys.delete(code);
    return true;
  }

  // Edge-triggered mouse button: true once per physical click, then consumed.
  // Semi-auto fire (LMB) uses this so a click can't auto-fire on hold.
  takeMousePressed(button) {
    if (!this.pressedButtons.has(button)) return false;
    this.pressedButtons.delete(button);
    return true;
  }

  resetMouseDelta() {
    this.dx = 0;
    this.dy = 0;
  }

  clearAll() {
    this.keys.clear();
    this.buttons.clear();
    this.pressedKeys.clear();    // A14/E4: no edge press survives a pause boundary
    this.pressedButtons.clear();
    this.dx = 0;
    this.dy = 0;
    this.jumpQueued = false;
  }
}
