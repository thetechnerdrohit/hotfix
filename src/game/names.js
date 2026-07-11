// ============================================================================
// Name pools for the two teams (Phase 3). SE bots get engineer handles; Bugs
// get error labels — the Bug label IS rendered on its head block (the badge is
// the head hitbox, build-plan Phase 3 line 1). The player's displayName is
// always 'you'.
//
// Pickers hand out UNIQUE names within a single match: NameDealer shuffles each
// pool once at construction (deterministic, no Math.random in a hot path — this
// runs once per match, never per frame, I1) and pops from the front. If a pool
// is exhausted it falls back to a numbered handle so a name is never null and
// never collides. reset() reshuffles for a fresh match (match.restart()).
//
// No allocations in any per-frame path — this module is touched only at match
// construction / restart. Pure data + a tiny dealer class; no THREE, no config.
// ============================================================================

// SE (Software Engineers) — the "good guys" you play alongside.
const SE_NAMES = [
  'backend_dev', 'sre_oncall', 'staff_eng', 'intern_2', 'frontend_dev',
  'devops_lead', 'qa_tester', 'db_admin', 'tech_lead', 'the_architect',
  'junior_dev', 'security_eng', 'ml_intern', 'platform_eng', 'release_mgr',
];

// Bugs — error labels. These strings are drawn onto the head-badge CanvasTexture
// (monospace), so keep them readable at a small size.
const BUG_NAMES = [
  'NullPointerException', 'segfault', 'merge_conflict', 'OOMKilled',
  'race_condition', 'off_by_one', 'heisenbug', 'stack_overflow',
  'deadlock', 'memory_leak', 'infinite_loop', 'undefined_ref',
  'timeout_504', 'CORS_error', 'flaky_test',
];

export const PLAYER_NAME = 'you';

// A tiny xorshift so the shuffle doesn't touch Math.random (which the build
// bans in workflow scripts and which we keep out of gameplay for determinism).
// Seed is stamped by the caller; the sequence only needs to be "varied enough"
// for name ordering, not cryptographic.
function shuffled(source, seed) {
  const arr = source.slice();
  let s = (seed | 0) || 0x9e3779b9;
  for (let i = arr.length - 1; i > 0; i--) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s |= 0;
    const j = (s >>> 0) % (i + 1);
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

class NameDealer {
  constructor(source, prefix, seed) {
    this._source = source;
    this._prefix = prefix; // fallback prefix once the pool is exhausted
    this._seed = seed >>> 0;
    this._pool = shuffled(source, this._seed);
    this._n = 0; // fallback counter
  }

  // Next unique name this match. Never returns null; never repeats until reset.
  next() {
    if (this._pool.length > 0) return this._pool.shift();
    return `${this._prefix}_${++this._n}`; // pool drained (only if teams grow past the pool)
  }

  // Reshuffle for a fresh match. Vary the seed so a restart isn't identical.
  reset() {
    this._seed = (this._seed * 1664525 + 1013904223) >>> 0;
    this._pool = shuffled(this._source, this._seed);
    this._n = 0;
  }
}

/**
 * Build the per-match name dealers. Call once at match construction; call the
 * returned .reset() family via makeNameDealers again on restart, or reuse the
 * dealer objects and call their reset(). Seeds are passed in (the loop bans
 * argless Date/Math.random in scripts; here we just want variety, so the caller
 * hands a seed — main.js uses a cheap boot value).
 *
 * @param {number} seed  any integer; different seeds → different orderings
 * @returns {{ se: NameDealer, bug: NameDealer }}
 */
export function makeNameDealers(seed = 0x1234abcd) {
  return {
    se: new NameDealer(SE_NAMES, 'se_bot', seed ^ 0x5a5a5a5a),
    bug: new NameDealer(BUG_NAMES, 'bug', seed ^ 0xa5a5a5a5),
  };
}
