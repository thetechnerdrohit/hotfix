// ============================================================================
// BotAudioFx — the render-side POSITIONAL footstep pass for bots (§4B "enemy
// footsteps, honest and loud … own steps quiet"). Backend bots emit no footstep
// events, so — exactly like TargetFx reads dummy state and draws it — this pass
// READS each living bot's movement each frame and fires a positional step tick
// per stride. It never mutates bot game logic (hard constraint): it only reads
// pos/vel/team/dead/visible and calls AudioEngine.footstep(...).
//
// Stride model (speed-correct + frame-rate independent, B2): accumulate the
// horizontal DISTANCE a bot travels; every `strideDist` metres → one step. That
// makes cadence scale with speed naturally (a sprinting bot steps more often)
// without any wall-clock timer. A bot moving slower than footstepMinSpeedFrac ×
// runSpeed is "not moving" → no steps (and its accumulator bleeds off so it
// doesn't fire a stale step the instant it starts again).
//
// enemy vs ally is relative to the PLAYER's team (SE): a Bug is an enemy (loud),
// an SE bot is an ally (quiet). AudioEngine.footstep() owns the global 100 ms
// throttle + the voice-cap yield (steps are lowest priority) — this pass just
// decides WHEN a bot has taken a step and WHERE.
//
// Zero per-frame allocations (I1): per-bot stride state is a parallel array
// built once (keyed by roster index, which is stable for the match's life).
// Ticks on GAME dt (steps pause with the sim + freeze in a hit-stop, matching
// every other positional sound). Zero cost when there's no match (practice).
// ============================================================================

import { MOVE, AUDIO } from '../config.js';

export class BotAudioFx {
  /**
   * @param {import('../game/match.js').Match|null} match  the TDM match (null in practice)
   * @param {import('../audio/audio.js').AudioEngine} audio
   * @param {'se'|'bug'} playerTeam  the player's team (SE) — decides enemy vs ally
   */
  constructor(match, audio, playerTeam = 'se') {
    this.match = match;
    this.audio = audio;
    this.playerTeam = playerTeam;

    // Distance per stride at any speed (metres). Cadence = strideDist / speed.
    this.strideDist = MOVE.runSpeed * AUDIO.footstepStrideSec;
    this.minSpeed = MOVE.runSpeed * AUDIO.footstepMinSpeedFrac;

    // Per-bot stride accumulator (metres since last step). Parallel to match.bots
    // (stable identity for the match's life). Built once — no per-frame alloc.
    this._acc = match ? new Float32Array(match.bots.length) : null;
    // Start each bot mid-stride so the whole roster doesn't step in lockstep on
    // the first frame of movement (desync by roster index).
    if (this._acc) {
      for (let i = 0; i < this._acc.length; i++) this._acc[i] = (i * 0.31 * this.strideDist) % this.strideDist;
    }
  }

  update(gameDt) {
    const m = this.match;
    if (!m || gameDt <= 0) return;
    const bots = m.bots;
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      if (bot.dead || !bot.group.visible) { this._acc[i] = 0; continue; }
      // Horizontal speed from the bot's own velocity (floor-locked, vy=0).
      const vx = bot.vel.x, vz = bot.vel.z;
      const speed = Math.sqrt(vx * vx + vz * vz);
      if (speed < this.minSpeed) {
        // Standing still → bleed the accumulator so it won't fire a stale step
        // the instant the bot moves again (feels honest — no phantom footstep).
        this._acc[i] *= Math.exp(-6 * gameDt);
        continue;
      }
      this._acc[i] += speed * gameDt; // distance travelled this frame
      if (this._acc[i] >= this.strideDist) {
        this._acc[i] -= this.strideDist; // consume one stride (keep remainder)
        const enemy = bot.team !== this.playerTeam; // Bug → enemy (loud); SE bot → ally (quiet)
        // Play at the bot's FEET-ish height (a step is on the floor). The engine
        // throttles + yields to combat; a dropped step just doesn't sound.
        this.audio.footstep(bot.pos.x, bot.pos.y + 0.1, bot.pos.z, enemy);
      }
    }
  }
}
