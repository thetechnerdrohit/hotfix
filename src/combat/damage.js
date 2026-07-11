// ============================================================================
// The ONE damage entry point (F1). Every bullet, knife, and future hazard
// routes through applyDamage — it's where the clamps, the kill flag, and the
// feedback triggers live, and where Phase 5's server authority will slot in.
// Edge cases owned here: F1 (single entry point), F2 (dead flag set the SAME
// call — a dead entity can't fire a queued shot), F4 (guard ≤0 damage + damage
// to the already-dead), F5 (integer damage; overkill 102>100 is just dead, E16).
//
// Also home to the SHARED range-falloff math (Phase 4, §4). Falloff must be
// byte-identical for the player (weapons.js) and the bots (bots.js) — symmetry
// is sacred (§4B) — so it lives here as ONE pure function both import, rather
// than being copy-pasted into two hot paths where they could drift.
// ============================================================================

import { COMBAT } from '../config.js';

/**
 * Range-falloff multiplier for a weapon at `dist` metres (§4 Phase-4 range
 * model). Full damage (×1) out to `start`, then a LINEAR lerp of the multiplier
 * down to `minMult` across [start, end], clamped to minMult beyond `end`. A
 * weapon with no COMBAT.falloff entry (the knife) always returns 1.
 *
 * CALL ORDER CONTRACT (both damage paths must obey it, per the plan): apply the
 * headshot multiplier to the BASE body damage FIRST, then multiply by this
 * factor, then Math.round. So a long-range headshot can drop below a one-shot —
 * intended (§4: falloff is "real, but secondary").
 *
 * Pure + alloc-free (I1): a couple of reads + one lerp; safe on the shot path.
 *
 * @param {'rifle'|'pistol'|'knife'} weapon
 * @param {number} dist  hit distance in metres (hitscan out.dist)
 * @returns {number} damage multiplier in [minMult, 1]
 */
export function falloffMult(weapon, dist) {
  const f = COMBAT.falloff && COMBAT.falloff[weapon];
  if (!f) return 1;                       // knife / unconfigured → no falloff
  if (dist <= f.start) return 1;          // point-blank band: full damage
  if (dist >= f.end) return f.minMult;    // past the end: clamped floor
  // Linear lerp 1 → minMult across the [start, end] window.
  const t = (dist - f.start) / (f.end - f.start);
  return 1 + (f.minMult - 1) * t;
}

// Damageable duck-type (targets.js implements it, the player will in Phase 3):
//   { hp, maxHp, dead, onDamaged(info)?, onKilled(info)? }
// info passed to callbacks: { amount, source, isHead, killed, hp }.

/**
 * Apply damage to a Damageable. Total and side-effecting: clamps, sets the
 * dead flag inline, fires the target's own feedback hooks. Returns a small
 * result so the caller (weapons.js) can drive its onShotResolved / onKill.
 *
 * @param {{hp:number,maxHp:number,dead:boolean,onDamaged?:Function,onKilled?:Function}} target
 * @param {number} amount   raw damage; rounded to an integer, ≤0 ignored (F4/F5)
 * @param {*}      source    whatever dealt it (weapon name, attacker) — for kill credit
 * @param {boolean} isHead   headshot flag (caller decides; knife can't headshot, E14)
 * @returns {{killed:boolean, amount:number}}  amount actually dealt (0 if the hit was a no-op)
 */
export function applyDamage(target, amount, source, isHead = false) {
  // F4: never touch a corpse, never process a non-positive hit.
  if (!target || target.dead) return { killed: false, amount: 0 };
  const dmg = Math.round(amount); // F5: integer damage only
  if (dmg <= 0) return { killed: false, amount: 0 };

  target.hp -= dmg;

  // F2: death is decided and flagged in THIS call, before control returns —
  // so a shot queued the same frame by a now-dead entity can't land. Two
  // entities zeroing each other in one frame both flip dead → a trade (F3).
  const killed = target.hp <= 0; // E16: overkill (102 on 100) is just dead
  if (killed) target.dead = true;

  const info = { amount: dmg, source, isHead, killed, hp: target.hp };
  if (target.onDamaged) target.onDamaged(info);
  if (killed && target.onKilled) target.onKilled(info);

  return { killed, amount: dmg };
}
