// ============================================================================
// Safe persistence (J1/J2): localStorage can throw (private mode, disabled,
// quota) and stored JSON can be corrupt or from an old version. Every failure
// path lands on defaults — the game is fully playable with zero persistence.
//
// SCHEMA VERSIONING (§9 J1/J2, groups I4/J2). Settings are a versioned payload
// { v, ... }. Reading is TOTAL — it never throws and never returns a bad value:
//   • no payload / localStorage throws / parse error  → a fresh DEFAULTS copy.
//   • a KNOWN older version (v1)                       → migrated forward, its
//        real values kept, new fields (fast/difficulty) filled with defaults.
//   • an unknown/garbage version, or missing v         → DEFAULTS (never crash).
//   • every field is then SANITIZED (clamped/whitelisted) so a corrupt single
//        field — fov:"NaN", volume:5, difficulty:42 — can't leak into the game;
//        the bad field falls back to its default while good fields survive.
// v1 → v2 added: fast:boolean (Krunker-style graphics preset, I4) and
// difficulty:'easy'|'normal'|'hard' (persisted BOTS.difficulty).
// ============================================================================

const KEY = 'hotfix.settings';

export const SETTINGS_VERSION = 2;

// v2 defaults. Frozen so a stray write can't mutate the canonical template.
const DEFAULTS = Object.freeze({
  v: SETTINGS_VERSION,
  sensitivity: 1.0,
  fov: 75,
  volume: 0.8,
  fast: false,          // §I4 — Krunker-style "Fast" graphics preset, off by default
  difficulty: 'normal', // 'easy' | 'normal' | 'hard' — persisted BOTS.difficulty
});

const DIFFICULTIES = ['easy', 'normal', 'hard'];

// -- Per-field sanitizers. Each takes a raw value + the fallback and returns a
//    SAFE value: a finite number clamped to the slider's real range, a real
//    boolean, or a whitelisted string. This is the crash-proof guarantee (J2):
//    any single garbage field degrades to its default; the rest survive.
function num(v, fallback, min, max) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function bool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}
function difficulty(v, fallback) {
  return DIFFICULTIES.includes(v) ? v : fallback;
}

// Coerce ANY object of loose fields into a valid, fully-populated v2 settings
// object. Shared by the fresh-read and the v1-migration paths — both just hand
// their (partial) fields here and get a sane, complete result. Never throws.
function sanitize(src) {
  const s = src && typeof src === 'object' ? src : {};
  return {
    v: SETTINGS_VERSION,
    sensitivity: num(s.sensitivity, DEFAULTS.sensitivity, 0.1, 3),
    fov: num(s.fov, DEFAULTS.fov, 60, 100),
    volume: num(s.volume, DEFAULTS.volume, 0, 1),
    fast: bool(s.fast, DEFAULTS.fast),
    difficulty: difficulty(s.difficulty, DEFAULTS.difficulty),
  };
}

// Migrate a parsed payload of a KNOWN older version to the current shape. v1 had
// { v:1, sensitivity, fov, volume } — carry those forward; sanitize fills the
// new v2 fields (fast/difficulty) with defaults. Add a case per future bump.
function migrate(data) {
  // v1 → v2: same three fields, minus the new ones. sanitize() supplies the rest.
  if (data.v === 1) return sanitize(data);
  // Unknown/older-than-we-handle version → defaults (never crash on garbage).
  return { ...DEFAULTS };
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return { ...DEFAULTS };
    if (data.v === SETTINGS_VERSION) return sanitize(data); // current version — still sanitize
    return migrate(data);                                   // older/unknown — migrate or default
  } catch {
    // J1: localStorage unavailable OR J2: corrupt JSON → in-memory defaults.
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    // Persist a SANITIZED, current-version copy so the store is always clean and
    // self-heals a partial/legacy in-memory object on the next save.
    localStorage.setItem(KEY, JSON.stringify(sanitize(settings)));
  } catch {
    // J1: no persistence available — keep playing on in-memory settings
  }
}
