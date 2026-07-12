// ============================================================================
// src/net/skins.js — deterministic kour.io-style character APPEARANCE from a
// 16-bit `skin` seed + team. The server assigns each fighter a random skin
// (serverMatch._makeSkin) and syncs it (2 bytes); every client derives the SAME
// body here, so a given fighter looks identical on all screens.
//
// Design (Rohit: "random + Squid accents, team-tinted, kour-style"):
//   • Keep the Squid-Game DNA — a HOODED tracksuit silhouette + a shape BADGE
//     (○△□) on the chest — but randomize the outfit color, badge shape, and a
//     kour-style HAT/accessory per player.
//   • Stay TEAM-READABLE: the outfit color is drawn from a team-specific pool
//     (SE = cool greens/teals/blues; Bug = warm reds/oranges/magentas), so
//     friend/foe reads at a glance even though every body is unique.
//   • Pure + allocation-free to CALL (returns a small plain object the avatar
//     builder reads once at construction). No THREE import — safe anywhere.
// ============================================================================

// Team outfit pools (kour-ish saturated flats, but sorted cool vs warm so teams
// stay distinguishable). Each entry: [suit, hood(darker), trim(accent)].
const SUITS = {
  se: [
    [0x2f9d7f, 0x1f6f59, 0x8ff0d4], // teal (the classic SE tracksuit)
    [0x2e8b57, 0x1c5c39, 0x9be8b0], // sea green
    [0x3a7bd5, 0x2456a0, 0x9ec7ff], // azure
    [0x4aa3a2, 0x2f6d6c, 0xa9f0ef], // cyan-slate
    [0x5a8f3c, 0x3c6027, 0xc3f09a], // olive-lime
    [0x2d6ca6, 0x1b4670, 0x8fc0ee], // steel blue
  ],
  bug: [
    [0xc2314e, 0x8a1f36, 0xff8fa3], // guard red (the classic Bug)
    [0xd8622f, 0x9c4320, 0xffb389], // burnt orange
    [0xb5346e, 0x7c2049, 0xf58fc0], // magenta
    [0xcf4444, 0x922e2e, 0xffa0a0], // brick red
    [0xd98a2b, 0x9c611c, 0xffd08f], // amber
    [0xa8324f, 0x741f35, 0xef8aa6], // wine
  ],
};

// kour-style hats/accessories (a small blocky prop on the head). 0 = none, so
// roughly 1-in-N players go bare-headed. Colors are picked from an accent pool.
const HATS = ['none', 'cap', 'cowboy', 'beanie', 'band', 'tophat'];
const HAT_COLORS = [0x222831, 0xe8a13a, 0xd23b3b, 0xf4f4f4, 0x3a7bd5, 0x6b4f2a, 0x9b59b6];
const BADGES = ['circle', 'triangle', 'square']; // the Squid ○△□ chest mark
const SKIN_TONES = [0xe8c9a5, 0xd8b48f, 0xc59d6f, 0xa5744b, 0x8a5a34, 0xf0d9bd];

// A tiny splitmix-style unspooler so each field pulls independent bits from the
// 16-bit seed (mixed up first so low/high fighters don't cluster).
function mix(seed) {
  let h = (seed >>> 0) || 0x9e3779b9;
  h ^= h << 13; h >>>= 0;
  h ^= h >> 17;
  h ^= h << 5; h >>>= 0;
  let cursor = h;
  return (n) => {
    // advance + return an int in [0, n)
    cursor = (Math.imul(cursor, 1664525) + 1013904223) >>> 0;
    return cursor % n;
  };
}

/**
 * Derive a full appearance from (skin, team).
 * @param {number} skin  uint16 seed (0 → a stable default per team)
 * @param {'se'|'bug'} team
 * @returns {{suit:number, hood:number, trim:number, skinTone:number,
 *            hat:string, hatColor:number, badge:string}}
 */
export function deriveAppearance(skin, team) {
  const pool = SUITS[team] || SUITS.se;
  const next = mix((skin << 3) ^ (team === 'bug' ? 0x5bd1e995 : 0x27d4eb2f));
  const suit = pool[next(pool.length)];
  return {
    suit: suit[0],
    hood: suit[1],
    trim: suit[2],
    skinTone: SKIN_TONES[next(SKIN_TONES.length)],
    hat: HATS[next(HATS.length)],
    hatColor: HAT_COLORS[next(HAT_COLORS.length)],
    badge: BADGES[next(BADGES.length)],
  };
}
