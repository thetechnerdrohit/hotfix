// ============================================================================
// server/sim/serverInput.js — an authoritative-server stand-in for the browser
// `Input` class (src/core/input.js). The REAL PlayerController + WeaponSystem
// read input ONLY through this surface:
//   pressed(code)          — held key (WASD/Shift)
//   takeJump()             — edge: jump once per press
//   takePressed(code)      — edge: KeyR / Digit1-3 (reload / weapon switch)
//   takeMousePressed(btn)  — edge: LMB semi-fire click
//   buttons                — Set of held mouse buttons (LMB fire hold, RMB ADS)
//   dx, dy / resetMouseDelta() — mouse look delta (server look is yaw/pitch-set,
//                                so these stay 0; look is applied directly)
//
// The netcode does NOT ship the browser's raw key events. Instead each client
// input command carries a compact bitmask of HELD keys/buttons plus explicit
// EDGE events for the frame (jump, reload, weapon 1/2/3, fire-click). This class
// translates one command into that Input surface for exactly one sim step, then
// the edges are consumed by the controller/weapons the same way the browser's
// edge buffers are drained. Zero allocation on the hot path (fields mutated in
// place; the two Sets are reused).
//
// Protocol bitmask (KEYS) — see src/net/protocol.js (shared constant table):
//   bit 0 W · 1 A · 2 S · 3 D · 4 Shift · 5 LMB(hold) · 6 RMB(hold, ADS)
// Edge events are booleans set per command: jump, reload, fireClick, switch(1..3|0).
// ============================================================================

// Bitmask layout — MUST match src/net/protocol.js KEYS.
export const KEYS = {
  W: 1 << 0,
  A: 1 << 1,
  S: 1 << 2,
  D: 1 << 3,
  SHIFT: 1 << 4,
  LMB: 1 << 5, // fire held (auto weapons + ADS-independent)
  RMB: 1 << 6, // ADS held
};

const LMB_BUTTON = 0;
const RMB_BUTTON = 2;

export class ServerInput {
  constructor() {
    this._held = 0;          // current held bitmask
    this.buttons = new Set(); // held mouse buttons (weapons reads .has(0)/.has(2))
    this.dx = 0;
    this.dy = 0;

    // Edge buffers — armed by applyCommand, drained once by the sim step.
    this._jump = false;
    this._pressed = new Set();       // 'KeyR','Digit1','Digit2','Digit3'
    this._mousePressed = new Set();  // 0 = LMB click (semi-fire edge)
  }

  // Load one client command for this sim step. `cmd` shape (protocol.js):
  //   { keys:bitmask, jump:bool, reload:bool, fireClick:bool, switchTo:0|1|2|3 }
  // switchTo: 1=rifle, 2=pistol, 3=knife, 0=no switch this command.
  applyCommand(cmd) {
    this._held = cmd.keys | 0;

    // Sync held mouse buttons from the bitmask.
    this.buttons.clear();
    if (this._held & KEYS.LMB) this.buttons.add(LMB_BUTTON);
    if (this._held & KEYS.RMB) this.buttons.add(RMB_BUTTON);

    // Arm edges for this step (drained during controller/weapons update).
    if (cmd.jump) this._jump = true;
    if (cmd.reload) this._pressed.add('KeyR');
    if (cmd.switchTo === 1) this._pressed.add('Digit1');
    else if (cmd.switchTo === 2) this._pressed.add('Digit2');
    else if (cmd.switchTo === 3) this._pressed.add('Digit3');
    if (cmd.fireClick) this._mousePressed.add(LMB_BUTTON);
  }

  // ---- The Input surface the controller + weapons consume ------------------
  pressed(code) {
    switch (code) {
      case 'KeyW': return (this._held & KEYS.W) !== 0;
      case 'KeyA': return (this._held & KEYS.A) !== 0;
      case 'KeyS': return (this._held & KEYS.S) !== 0;
      case 'KeyD': return (this._held & KEYS.D) !== 0;
      case 'ShiftLeft':
      case 'ShiftRight': return (this._held & KEYS.SHIFT) !== 0;
      default: return false;
    }
  }

  takeJump() {
    const j = this._jump;
    this._jump = false;
    return j;
  }

  takePressed(code) {
    if (!this._pressed.has(code)) return false;
    this._pressed.delete(code);
    return true;
  }

  takeMousePressed(button) {
    if (!this._mousePressed.has(button)) return false;
    this._mousePressed.delete(button);
    return true;
  }

  resetMouseDelta() {
    this.dx = 0;
    this.dy = 0;
  }

  // Clear all edge/held state (used on death/respawn boundary — mirrors the
  // browser's clearAll on a state change so no stale input crosses it).
  clearAll() {
    this._held = 0;
    this.buttons.clear();
    this._jump = false;
    this._pressed.clear();
    this._mousePressed.clear();
    this.dx = 0;
    this.dy = 0;
  }
}
