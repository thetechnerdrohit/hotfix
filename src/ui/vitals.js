// ============================================================================
// Vitals — the low-health escalating signal stack + the health HUD (§4B "low
// health — the escalating signal stack"). THE load-bearing rule (F9): every
// layer here derives from the player's OBSERVED hp each frame, NEVER from an
// event. So death/respawn/heal snaps the whole stack clean by construction —
// the classic "heartbeat stuck after respawn" is impossible.
//
// Layers, all keyed off hp vs FEEL.lowHpThreshold (35) / criticalHpThreshold
// (15):
//   • Vignette: a persistent red edge (its own DOM layer, separate from the hurt
//     flash) with a ~1 Hz pulse that speeds up at critical. Steady alpha + pulse
//     rate ramp with how deep into the danger zone hp is.
//   • Audio: heartbeat loop fades in (rate + gain set on the AudioEngine, which
//     loops it on GAME time so pausing pauses it, B6); at/below critical a gentle
//     low-pass engages over the world sfx bus (BiquadFilter, smoothed cutoff).
//   • HUD: the bottom-left health number ramps green→amber→red and pulses; the
//     bar fill scales with hp. Text updates ONLY when the integer hp changes (G2).
//
// The heartbeat + low-pass are DRIVEN here but PLAYED/held by the AudioEngine
// (this module just sets targets each frame from hp). Vignette pulse phase ticks
// on GAME dt so a pause freezes it with everything else; the HUD number/colour
// is pure state (no timer). Zero per-frame allocations (I1).
// ============================================================================

import { FEEL, HUD, COMBAT } from '../config.js';

// Health colour ramp stops (green → amber → red). Chosen to match the HUD theme
// (teal-ish green, warn amber, danger red) and the low-hp story.
const HP_GREEN = '#8fe388';
const HP_AMBER = '#ffd166';
const HP_RED = '#ff5a4d';

export class Vitals {
  /**
   * @param {import('../audio/audio.js').AudioEngine} audio  drives heartbeat + low-pass
   */
  constructor(audio) {
    this.audio = audio;

    // Low-hp vignette layer (separate element from the hurt flash).
    this.vignEl = document.getElementById('lowhp-vignette');

    // Health HUD block (bottom-left). Grabbed once (G2).
    this.healthEl = document.getElementById('health');
    this.hpNumEl = document.getElementById('hp-num');
    this.hpFillEl = document.getElementById('hp-fill');

    // Cached last-written values so we only touch the DOM on change (G2).
    this._lastHpInt = -1;       // last integer hp written to the number
    this._lastColor = '';       // last colour ramp written
    this._lastFrac = -1;        // last bar fill fraction written
    this._lastVign = -1;        // last vignette alpha written
    this._lastPulseOp = -1;     // last number-pulse opacity written

    // Pulse phase (game-time). Advances only while in the danger zone.
    this._pulsePhase = 0;

    this.maxHp = COMBAT.maxHealth;
  }

  // Show/hide the health block (a match exists vs practice mode). Called once
  // from main when the match is (not) present.
  setVisible(on) {
    this.healthEl.classList.toggle('hidden', !on);
  }

  // --- Per-frame tick -------------------------------------------------------
  // hp: the player's CURRENT hp, read fresh every frame (F9). gameDt advances
  // the pulse phase (pauses with the sim). rawDt is unused today but accepted so
  // the call site can pass it symmetrically with the danger stack.
  //
  // dead: when the player is dead we hold the stack silent/cleared (a corpse has
  // no heartbeat); the number still shows 0 briefly under the death overlay but
  // the audio + vignette go quiet. Respawn (hp back to max) clears everything by
  // the same hp-derived math — no special-case teardown (F9).
  tick(hp, gameDt, dead) {
    const clamped = Math.max(0, hp);

    // ---- HUD number + bar (state-derived; writes only on change, G2) -------
    const hpInt = Math.round(clamped);
    if (hpInt !== this._lastHpInt) {
      this._lastHpInt = hpInt;
      this.hpNumEl.textContent = String(hpInt); // HUD shows max(0, hp) (F5)
    }
    const frac = Math.max(0, Math.min(1, clamped / this.maxHp));
    const fr = Math.round(frac * 100) / 100;
    if (fr !== this._lastFrac) {
      this._lastFrac = fr;
      this.hpFillEl.style.transform = `scaleX(${fr})`; // transform-only (G2)
    }
    const color = this._rampColor(clamped);
    if (color !== this._lastColor) {
      this._lastColor = color;
      // Set the CSS var once; both number + bar fill read it.
      this.healthEl.style.setProperty('--hp-color', color);
    }

    // ---- Danger-zone derived intensities (0 above low, →1 at/below critical) --
    const low = FEEL.lowHpThreshold;
    const crit = FEEL.criticalHpThreshold;
    // t = 0 at the low threshold, 1 at the critical threshold, clamped. Above the
    // low threshold everything is OFF (t<0 → clamp to "inactive").
    let inZone = clamped > 0 && clamped <= low && !dead;
    const t = inZone ? Math.max(0, Math.min(1, (low - clamped) / Math.max(1e-3, low - crit))) : 0;

    // ---- Vignette: steady alpha + pulse, both ramping with t ---------------
    if (inZone) {
      const baseAlpha = lerp(FEEL.lowHpVignetteLow, FEEL.lowHpVignetteCritical, t);
      const pulseHz = lerp(FEEL.lowHpPulseHzLow, FEEL.lowHpPulseHzCritical, t);
      this._pulsePhase += gameDt * pulseHz * Math.PI * 2;
      // Pulse ±25% around the base alpha (a slow breathe, stronger at critical).
      const pulse = 1 + 0.25 * Math.sin(this._pulsePhase);
      const alpha = Math.min(0.85, baseAlpha * pulse);
      const av = Math.round(alpha * 1000) / 1000;
      if (av !== this._lastVign) { this._lastVign = av; this.vignEl.style.opacity = String(av); }
      // Number pulses too (harder at critical) — via opacity only.
      const numPulse = 1 - (0.15 + 0.2 * t) * (0.5 + 0.5 * Math.sin(this._pulsePhase));
      const np = Math.round(numPulse * 100) / 100;
      if (np !== this._lastPulseOp) { this._lastPulseOp = np; this.healthEl.style.setProperty('--hp-pulse', String(np)); }
    } else {
      // Out of the zone (healthy or dead) → snap the vignette + number pulse off.
      if (this._lastVign !== 0) { this._lastVign = 0; this.vignEl.style.opacity = '0'; }
      if (this._lastPulseOp !== 1) { this._lastPulseOp = 1; this.healthEl.style.setProperty('--hp-pulse', '1'); }
      this._pulsePhase = 0;
    }

    // ---- Audio: heartbeat + low-pass (driven here, held by the AudioEngine) --
    if (inZone) {
      const bpm = lerp(FEEL.heartbeatBpmLow, FEEL.heartbeatBpmCritical, t);
      const gain = lerp(FEEL.heartbeatGainLow, FEEL.heartbeatGainCritical, t);
      this.audio.setHeartbeat(bpm, gain);
    } else {
      this.audio.setHeartbeat(0, 0); // healthy/dead → silent (F9)
    }
    // Low-pass engages only in the CRITICAL band (hp ≤ critical). Above it the
    // cutoff is dry/open; the smoothing in the engine avoids any zipper.
    const critEngaged = clamped > 0 && clamped <= crit && !dead;
    this.audio.setSfxLowpass(critEngaged ? FEEL.lowPassCutoffWet : FEEL.lowPassCutoffDry);
  }

  _rampColor(hp) {
    if (hp <= FEEL.criticalHpThreshold) return HP_RED;
    if (hp <= FEEL.lowHpThreshold) return HP_AMBER;
    return HP_GREEN;
  }

  // Hard reset (respawn / restart): clear the pulse + audio immediately. The
  // hp-derived math already clears everything next tick, but a respawn should be
  // instant, not one-frame-late.
  reset() {
    this._pulsePhase = 0;
    if (this._lastVign !== 0) { this._lastVign = 0; this.vignEl.style.opacity = '0'; }
    if (this._lastPulseOp !== 1) { this._lastPulseOp = 1; this.healthEl.style.setProperty('--hp-pulse', '1'); }
    this.audio.setHeartbeat(0, 0);
    this.audio.setSfxLowpass(FEEL.lowPassCutoffDry);
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }
