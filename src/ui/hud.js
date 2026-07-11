// ============================================================================
// HUD — DOM overlay (G1). Phase 1 carried the crosshair dot + dev fps counter;
// Phase 2 adds the combat HUD (register group G):
//   • Bottom-right ammo block: big `mag / reserve` (knife = ∞), a weapon-name
//     chip. Text updates ONLY on ammo/switch events (G2 — never per frame). The
//     block flashes on low ammo (≤ CROSSHAIR.lowAmmoFrac of the mag) and on
//     dry-fire (G6 — visible, not only audible).
//   • Crosshair: centre dot + 4 thin gap lines. Per-frame the lines expand with
//     weapon spread via transform ONLY (G2/G8: thin, size-capped, never a blob).
//   • Hitmarker: a white X flick on any hit (headshot variant tinted); a larger
//     kill-X on a kill. Driven by opacity/transform + a game-time countdown.
//
// Everything the loop touches per frame is transform/opacity (G2). All elements
// are grabbed ONCE in the constructor. Hitmarker/flash timers tick on RAW dt in
// tick() so pausing the sim doesn't strand a half-faded marker on screen.
// ============================================================================

import { CROSSHAIR, FEEL, COMBAT } from '../config.js';

export class Hud {
  constructor() {
    // Dev fps counter (Phase 1) ------------------------------------------------
    this.fpsEl = document.getElementById('fps');
    this.frames = 0;
    this.acc = 0;
    if (!import.meta.env.DEV) this.fpsEl.style.display = 'none';

    // Crosshair lines (expand with bloom) -------------------------------------
    this.chLines = {
      up: document.getElementById('ch-up'),
      down: document.getElementById('ch-down'),
      left: document.getElementById('ch-left'),
      right: document.getElementById('ch-right'),
    };

    // Hitmarker + kill-X ------------------------------------------------------
    this.hitmarker = document.getElementById('hitmarker');
    this.hmTimer = 0;      // seconds of hitmarker life remaining (raw-dt)
    this.hmDuration = FEEL.hitmarkerMs / 1000;
    this._hmHead = false;  // was the last hitmarker a headshot? (colour chosen in tick)
    this.killTimer = 0;    // seconds of kill-X life remaining (raw-dt)
    this.killDuration = 0.25;
    this._hmColor = '';    // last colour written to the marker (skip redundant writes)

    // Ammo block --------------------------------------------------------------
    this.ammoEl = document.getElementById('ammo');
    this.ammoMagEl = document.getElementById('ammo-mag');
    this.ammoResEl = document.getElementById('ammo-res');
    this.weaponChipEl = document.getElementById('weapon-chip');
    this.flashTimer = 0;         // dry-fire flash pulse (raw-dt)
    this.flashDuration = 0.18;   // s of the dry-fire/low-ammo flash pulse

    // Cached low-ammo state so we only toggle the class on change (no per-frame writes).
    this._lowActive = false;
    // Cached crosshair gap so we skip re-writing 4 transforms when it's unchanged.
    this._lastGap = -1;
  }

  // ---- Event-driven writes (called from main on weapon events; NOT per frame) --

  // onAmmoChanged / onSwitchEnd → refresh the numbers + low-ammo styling (G2).
  setAmmo(weapon, ammo) {
    const knife = weapon === 'knife';
    // Text writes happen here only (event-driven), never in tick() (G2).
    this.ammoMagEl.textContent = knife ? '∞' : String(ammo.mag);
    this.ammoResEl.textContent = knife ? '' : String(ammo.reserve);

    // Low-ammo flash state (G6): mag at/under the fraction of magSize. Knife is
    // never "low". Toggle the class only on transition to avoid layout churn.
    const magSize = COMBAT[weapon]?.magSize ?? 0;
    const low = !knife && magSize > 0 && ammo.mag <= Math.ceil(magSize * CROSSHAIR.lowAmmoFrac);
    if (low !== this._lowActive) {
      this._lowActive = low;
      this.ammoEl.classList.toggle('low', low);
    }
  }

  // onSwitchStart → update the weapon-name chip (switch is when the name changes).
  setWeapon(name) {
    this.weaponChipEl.textContent = name.toUpperCase();
  }

  // onDryFire → a brief visible flash on the ammo block (G6, deaf-friendly).
  flashAmmo() {
    this.flashTimer = this.flashDuration;
  }

  // onShotResolved(hit on a character) → hitmarker; isHead picks the variant.
  // Remember the variant instead of writing colour here: the weapon system fires
  // onKill BEFORE onShotResolved for a killing shot, so colour is chosen in the
  // tick by priority (kill > hit) — never by event order (which would let a
  // hitmarker colour clobber the kill-X colour).
  showHitmarker(isHead) {
    this.hmTimer = this.hmDuration;
    this._hmHead = isHead;
  }

  // onKill → a larger, tinted kill-X that lingers a touch longer.
  showKill() {
    this.killTimer = this.killDuration;
  }

  // ---- Per-frame (transform/opacity only, G2) -----------------------------

  // spreadRad: weapons.currentSpreadRad() — expands the crosshair gap (G8).
  // rawDt drives all HUD timers so a pause doesn't leave a marker stuck.
  tick(rawDt, spreadRad = 0) {
    this._tickFps(rawDt);
    this._tickCrosshair(spreadRad);
    this._tickHitmarker(rawDt);
    this._tickAmmoFlash(rawDt);
  }

  _tickFps(rawDt) {
    if (!import.meta.env.DEV) return;
    this.frames += 1;
    this.acc += rawDt;
    if (this.acc >= 0.5) {
      this.fpsEl.textContent = `${Math.round(this.frames / this.acc)} fps`;
      this.frames = 0;
      this.acc = 0;
    }
  }

  _tickCrosshair(spreadRad) {
    // Gap in px from the resting gap plus the spread expansion, hard-capped so
    // the crosshair can never bloom into a blob (G8).
    const gap = Math.min(
      CROSSHAIR.maxGapPx,
      CROSSHAIR.baseGapPx + spreadRad * CROSSHAIR.pxPerRad,
    );
    // Skip the 4 transform writes when the gap is visually unchanged (rounded to
    // the px) — most frames the spread is steady (or exactly base for the knife).
    const g = Math.round(gap * 2) / 2; // half-px granularity
    if (g === this._lastGap) return;
    this._lastGap = g;
    // transform-only: translate each line outward by the gap (G2). The lines are
    // anchored at centre; we push them along their axis.
    this.chLines.up.style.transform = `translate(-50%, calc(-100% - ${g}px))`;
    this.chLines.down.style.transform = `translate(-50%, ${g}px)`;
    this.chLines.left.style.transform = `translate(calc(-100% - ${g}px), -50%)`;
    this.chLines.right.style.transform = `translate(${g}px, -50%)`;
  }

  _tickHitmarker(rawDt) {
    // Colour + shape by PRIORITY, not event order: kill (red, big) beats a
    // headshot marker (amber) beats a body marker (white). Both timers advance
    // so a kill-X that outlives the hitmarker still fades correctly.
    if (this.hmTimer > 0) this.hmTimer -= rawDt;
    if (this.killTimer > 0) this.killTimer -= rawDt;

    if (this.killTimer > 0) {
      this._setColor(CROSSHAIR.killColor);
      const f = Math.max(0, this.killTimer / this.killDuration);
      this.hitmarker.style.opacity = String(f);
      this.hitmarker.style.transform = `translate(-50%, -50%) scale(${1.4 - 0.3 * f})`;
    } else if (this.hmTimer > 0) {
      this._setColor(this._hmHead ? CROSSHAIR.headColor : CROSSHAIR.hitColor);
      const f = Math.max(0, this.hmTimer / this.hmDuration);
      this.hitmarker.style.opacity = String(f);
      this.hitmarker.style.transform = `translate(-50%, -50%) scale(${1.15 - 0.15 * f})`;
    } else if (this.hitmarker.style.opacity !== '0') {
      this.hitmarker.style.opacity = '0'; // settled — one final write, then quiet
    }
  }

  _setColor(c) {
    if (this._hmColor !== c) { this._hmColor = c; this.hitmarker.style.color = c; }
  }

  _tickAmmoFlash(rawDt) {
    if (this.flashTimer <= 0) return;
    this.flashTimer -= rawDt;
    // A quick opacity blink on the ammo block (opacity var only, no layout).
    const f = Math.max(0, this.flashTimer / this.flashDuration);
    // 0→1→0 pulse via a triangle on f.
    const pulse = f > 0.5 ? (1 - f) * 2 : f * 2;
    this.ammoEl.style.setProperty('--flash', String(pulse));
    if (this.flashTimer <= 0) this.ammoEl.style.setProperty('--flash', '0');
  }
}
