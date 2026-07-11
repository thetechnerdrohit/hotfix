// ============================================================================
// MatchHud — the Team-Deathmatch HUD layer (Phase 3): top-center scoreboard +
// clock, top-right kill feed, the death/respawn overlay, and the match-end
// overlay. DOM overlay (G1); the same discipline as hud.js — every element is
// grabbed once in the constructor, text writes are EVENT-DRIVEN (never per
// frame, G2), and the only per-frame work is opacity/transform on the kill-feed
// rows + the two countdowns (numbers change ≤ once/second).
//
// It is a pure CONSUMER of the match's nullable events (main.js wires them):
//   onScoreChanged → setScore   · onKillFeed → addKill   · onMatchEnd → showEnd
//   onPlayerDeath → showDeath    · onPlayerRespawn → hideDeath
// plus a per-frame setClock() reading match.clock. The PLAY AGAIN / MENU buttons
// call back into main (which owns match.restart() + the pointer-lock re-grab).
//
// Kill feed (G7): a bounded pool of rows reused round-robin — last N shown,
// older ones fade + drop. Never grows unbounded.
//
// Countdowns run on GAME time (the death respawn countdown mirrors the match's
// own countdown, which isn't exposed as a field — we run our own mirror started
// on the death event; both drain off the same game dt so they never diverge
// visibly, B6). Kill-feed fades run on RAW dt (they must keep fading under the
// hit-stop / while the sim is briefly frozen). Zero per-frame allocations (I1).
// ============================================================================

import { HUD, MATCH } from '../config.js';

// mm:ss from seconds (clock display). Small + alloc-light (one string/second).
function mmss(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const m = (s / 60) | 0;
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

export class MatchHud {
  constructor() {
    // -- Scoreboard --------------------------------------------------------
    this.boardEl = document.getElementById('scoreboard');
    this.seEl = document.getElementById('score-se');
    this.bugEl = document.getElementById('score-bug');
    this.clockEl = document.getElementById('score-clock');
    this._lastSe = -1; this._lastBug = -1;
    this._lastClock = '';       // last mm:ss written (≤ 1 write/second, G2)
    this._lastUrgent = false;

    // Team colours (from config so §4C stays the single source).
    this.boardEl.style.setProperty('--se', HUD.seColor);
    this.boardEl.style.setProperty('--bug', HUD.bugColor);

    // -- Kill feed (pooled rows, G7) ---------------------------------------
    this.feedEl = document.getElementById('killfeed');
    this.rows = [];
    for (let i = 0; i < HUD.killFeedMax; i++) {
      const row = document.createElement('div');
      row.className = 'kf-row';
      row.style.opacity = '0';
      // Structure: <killer> <weapon> <victim> [head]. Built once; text is set on
      // reuse (event-driven), styling via class + inline colour (team tint).
      const killer = document.createElement('span'); killer.className = 'kf-killer';
      const weapon = document.createElement('span'); weapon.className = 'kf-weapon';
      const victim = document.createElement('span'); victim.className = 'kf-victim';
      const head = document.createElement('span'); head.className = 'kf-head';
      row.appendChild(killer); row.appendChild(weapon); row.appendChild(victim); row.appendChild(head);
      this.feedEl.appendChild(row);
      this.rows.push({ el: row, killer, weapon, victim, head, life: 0, order: 0, _lastOp: 0, _cssOrder: undefined });
    }
    this._feedCursor = 0;   // round-robin claim index
    this._feedSeq = 0;      // monotonic order stamp (newest = highest)

    // -- Death / respawn overlay -------------------------------------------
    this.deathEl = document.getElementById('death-overlay');
    this.deathKillerEl = document.getElementById('death-killer-name');
    this.deathWeaponEl = document.getElementById('death-weapon');
    this.deathCountEl = document.getElementById('death-count-num');
    this._deathActive = false;
    this._deathCountdown = 0;   // game-time mirror of the match respawn countdown
    this._lastDeathCount = -1;

    // -- Match-end overlay -------------------------------------------------
    this.endEl = document.getElementById('matchend-overlay');
    this.endCardEl = document.getElementById('matchend-card');
    this.endVerdictEl = document.getElementById('matchend-verdict');
    this.endSubEl = document.getElementById('matchend-sub');
    this.endSeEl = document.getElementById('me-se');
    this.endBugEl = document.getElementById('me-bug');
    this._endShown = false;

    // Button callbacks (main wires them: restart + pointer re-lock / back to menu).
    this.onPlayAgain = null;
    this.onMenu = null;
    document.getElementById('btn-playagain').addEventListener('click', () => this.onPlayAgain?.());
    document.getElementById('btn-tomenu').addEventListener('click', () => this.onMenu?.());
  }

  // Show/hide the whole match HUD (scoreboard + feed live-ness). Kill feed rows
  // hide themselves via life; the scoreboard toggles here. Practice mode hides it.
  setVisible(on) {
    this.boardEl.classList.toggle('hidden', !on);
    if (!on) this.clearFeed();
  }

  // ---- Scoreboard (event-driven text; G2) ---------------------------------
  setScore(se, bug) {
    if (se !== this._lastSe) { this._lastSe = se; this.seEl.textContent = String(se); }
    if (bug !== this._lastBug) { this._lastBug = bug; this.bugEl.textContent = String(bug); }
  }

  // Clock reads match.clock each frame but writes at most once per second (G2).
  setClock(seconds) {
    const s = mmss(seconds);
    if (s !== this._lastClock) { this._lastClock = s; this.clockEl.textContent = s; }
    const urgent = seconds <= 10;
    if (urgent !== this._lastUrgent) { this._lastUrgent = urgent; this.clockEl.classList.toggle('urgent', urgent); }
  }

  // ---- Kill feed (G7) ------------------------------------------------------
  // entry: { killerName, killerTeam, victimName, victimTeam, weapon, isHead }.
  // 'you' appears verbatim (the player's name from names.js). Claims a row
  // round-robin; the tick fades + reorders them.
  addKill(entry) {
    const r = this.rows[this._feedCursor];
    this._feedCursor = (this._feedCursor + 1) % this.rows.length;

    r.killer.textContent = entry.killerName ?? '—';
    r.killer.style.color = teamColor(entry.killerTeam);
    r.weapon.textContent = weaponGlyph(entry.weapon);
    r.victim.textContent = entry.victimName ?? '—';
    r.victim.style.color = teamColor(entry.victimTeam);
    r.head.textContent = entry.isHead ? 'HS' : '';

    r.life = HUD.killFeedRowMs / 1000 + HUD.killFeedFadeMs / 1000;
    r.order = ++this._feedSeq;
    this._writeOp(r, 1);
  }

  clearFeed() {
    for (let i = 0; i < this.rows.length; i++) {
      this.rows[i].life = 0;
      this._writeOp(this.rows[i], 0);
    }
  }

  // Write a row's opacity only when it actually changes (G2 — no redundant
  // per-frame DOM writes / string allocs while a row sits at full life).
  _writeOp(r, op) {
    if (r._lastOp === op) return;
    r._lastOp = op;
    r.el.style.opacity = String(op);
  }

  // ---- Death / respawn overlay (§4B) ---------------------------------------
  // Shown on onPlayerDeath; runs its OWN game-time countdown mirror (the match's
  // countdown field isn't exposed). Cleared on onPlayerRespawn (hideDeath).
  showDeath(info) {
    this._deathActive = true;
    this._deathCountdown = MATCH.respawnDelay;
    this._lastDeathCount = -1;
    this.deathKillerEl.textContent = info?.killerName ?? '—';
    this.deathKillerEl.style.color = teamColor(info?.killerTeam);
    // Weapon (§4B "killer + weapon"): " · RIFLE" appended, dim. Empty if unknown.
    this.deathWeaponEl.textContent = info?.weapon ? ` · ${info.weapon.toUpperCase()}` : '';
    this.deathEl.classList.remove('hidden');
  }

  hideDeath() {
    this._deathActive = false;
    this.deathEl.classList.add('hidden');
  }

  // ---- Match-end overlay (§4B) ---------------------------------------------
  // result: { winner:'se'|'bug'|'draw', se, bug }. Sets the verdict theme + score
  // and reveals the overlay (which captures clicks above the #hud). The buttons'
  // callbacks (onPlayAgain/onMenu) are wired by main.
  showEnd(result) {
    this._endShown = true;
    let verdict, sub, color;
    if (result.winner === 'se') {
      verdict = 'PROD IS STABLE 🎉'; sub = 'SHIPPED'; color = HUD.seColor;
    } else if (result.winner === 'bug') {
      verdict = 'PROD IS DOWN'; sub = 'BUGS WIN'; color = HUD.bugColor;
    } else {
      verdict = 'STALEMATE'; sub = 'WONTFIX'; color = HUD.neutralColor;
    }
    this.endVerdictEl.textContent = verdict;
    this.endSubEl.textContent = sub;
    this.endCardEl.style.setProperty('--verdict', color);
    this.endSeEl.textContent = String(result.se);
    this.endBugEl.textContent = String(result.bug);
    this.endEl.classList.remove('hidden');
  }

  hideEnd() {
    this._endShown = false;
    this.endEl.classList.add('hidden');
  }

  get endShown() { return this._endShown; }

  // ---- Per-frame tick ------------------------------------------------------
  // rawDt fades the kill feed (must keep fading under a hit-stop). gameDt drains
  // the death countdown (pauses with the sim, mirrors the match). Kept split so
  // both behave exactly like their siblings (hud.js markers = raw; audio = game).
  tick(rawDt, gameDt) {
    // Kill-feed rows: fade the tail of their life, reorder vertically by recency.
    // Newest at top: sort by `order` desc via a cheap stable index (only N≤4 rows).
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (r.life <= 0) continue;
      r.life -= rawDt;
      if (r.life <= 0) { r.life = 0; this._writeOp(r, 0); continue; }
      // Opacity: full while life is above the fade window, linear fade below it.
      const fade = HUD.killFeedFadeMs / 1000;
      const op = r.life >= fade ? 1 : r.life / fade;
      this._writeOp(r, Math.round(op * 100) / 100); // write only on change (G2)
    }
    this._reorderFeed();

    // Death countdown mirror (game time).
    if (this._deathActive && this._deathCountdown > 0) {
      this._deathCountdown = Math.max(0, this._deathCountdown - gameDt);
      const n = Math.max(0, Math.ceil(this._deathCountdown));
      if (n !== this._lastDeathCount) { this._lastDeathCount = n; this.deathCountEl.textContent = String(n); }
    }
  }

  // Order the (≤4) live rows top-to-bottom newest-first via flexbox `order`. Only
  // touches the `order` style (no layout thrash beyond the reflow flexbox already
  // does for opacity changes). Cheap at N≤4.
  _reorderFeed() {
    // Assign CSS order = negative of the recency stamp so newer (higher seq) sits
    // higher (smaller order value → earlier in a column). Only write on change.
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      const ord = r.life > 0 ? -r.order : 999;
      if (r._cssOrder !== ord) { r._cssOrder = ord; r.el.style.order = String(ord); }
    }
  }
}

// Team → tint (config-driven). null/unknown → neutral.
function teamColor(team) {
  if (team === 'se') return HUD.seColor;
  if (team === 'bug') return HUD.bugColor;
  return HUD.neutralColor;
}

// A tiny weapon glyph for the kill feed (keeps rows compact; the '✕' reads as
// "killed"). Knife gets a blade, guns get a bullet-ish mark.
function weaponGlyph(weapon) {
  if (weapon === 'knife') return ' 🔪 ';
  return ' ✕ ';
}
