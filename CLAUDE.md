# CLAUDE.md — HOTFIX

Persistent context for this project. Full design + roadmap lives in **`BUILD-PLAN.md`** — read it before starting substantive work; this file is the short operating manual.

## Project
- **HOTFIX** (working title): a browser FPS — **5 Software Engineers vs. 5 Bugs**.
- Mechanically a **symmetric arena shooter** in the CS/Valorant mold; the SE-vs-Bugs theme is a reskin of CT vs. T (same weapons, both sides shoot, only the look differs).
- Runs **in-browser on mid-spec hardware, no install**. Krunker.io is the reference point.
- **Single-player vs. bots first.** Real 5v5 multiplayer is a later, separate, deliberate phase — not the starting scope.

## Current status
- **SINGLE-PLAYER GAME COMPLETE — v1.0.0** (2026-07-11): phases 0–4 + release polish, all browser-verified. Full 5v5 SE-vs-Bug TDM vs bots (player + 4 SE bots vs 5 error-labeled Bugs) on the real **"Prod"** map (Dev Bay / Legacy Wing spawns, 28 m A-lane, dogleg B-corridor, X-mirror symmetric, merged geometry). Human-feeling bots (reaction/tightening-cone/burst; difficulty never touches damage; dodging strongly rewarded), danger wedges + low-HP stack, death-cam + themed overlays, kill feed/score/clock, damage falloff + move-spread (shared player/bot function), synthesized positional audio, Fast graphics preset, settings v2 (sanitized, migrated), README with deploy instructions. `npm run build` → clean static `dist/` (verified: dev surfaces stripped, zero console errors).
- **Next step: Rohit's feel-pass** (movement/gunfeel/audio/difficulty/Prod readability — tune live with the feel-tuner, bake values into `config.js`), then **he deploys `dist/` himself** per README (Cloudflare Pages / Netlify / itch.io). Nothing has been published anywhere.
- Phase order: `0`✅ → `1`✅ → `2`✅ → `3`✅ → `4`✅ → **release polish ✅** → `5` Multiplayer ✅ **v1 (2026-07-13)**.
- The plan carries: §4B moment-to-moment FPS spec, §4C config schema, §4D open decisions w/ defaults, §9 edge-case register (~105 entries) — read those before any further work.
- **Build pattern (per Rohit):** implementation runs as role-split Opus 4.8 max-effort agents — systems/backend → presentation/frontend → independent review — lead defines contracts up front, merges STRICTLY SERIALLY (two agents on the tree = collision; it happened twice), and browser-gates every merge: agents don't boot the page, and the two worst bugs (wrapper-vs-inner camera crash; visual-only floor dropping the player out of the world) were only catchable there.
- **v1.1–v1.2 (2026-07-12):** character/viewmodel visual overhaul (procedural animation, hitboxes frozen) · Prod set-dressed (LEDs/signage/clutter, colliders byte-identical) · **right-click ADS** (group L) · **verticality** — player step-up/snap-down + bot 3D nav (group K) · **"Shoots"** — the default map, cloned from Rohit's `ar_shoots.fbx` via layout extraction (`reference/shoots-layout.json`): central paired decks (2.63 m) with terraced climbable roofs + catwalk, corner buildings + stairs, point-symmetric spawns. All browser-gated; combat regressions checked at every merge.
- **v1.4–v2.0 (2026-07-13 overnight):** survival-show theme (red masked guards ○△□, green tracksuit teammates, held-blade knife, pink/teal UI) · pastel staircase palette · **climbable ROPES** (hold W; deterministic headroom-verified landings) · **"Battleground" default map** — 4× PUBG-style pastel field, compound as gated central POI, 4 enterable camp-hut clusters + roof ropes, 8 great trees with sniper-stand ropes, 1,259-node bridged nav, field-edge spawns. `?room=shoots` = compound-only arena (DEV).
- Feel-pass flags for Rohit: bots climb but don't *favor* high ground (patrol weighting knob); roof-vs-ground + rope-perch balance needs human judgment; bot hunting range on the big field; Battleground pacing (10 fighters on 192 m — consider more bots or shorter clock).
- **Phase 5 v1 — ONLINE (2026-07-13):** Colyseus 0.15 authoritative server (`server/`, `npm run server` → ws://:2567). Quick-match `joinOrCreate('battle')`, join-in-progress: humans replace bots (team-balanced), bots backfill on leave — match never stops. 30 Hz fixed-tick sim / 20 Hz patch; server reuses the REAL `src/` sim modules via a Node loader hook (`server/register-json.mjs`) + DOM stub; lag-comp ring buffer for hitscan; input validation (dt clamp + rate cap). Client: `src/net/` — prediction+reconciliation, 100 ms remote interpolation, pooled avatars; **`net.tick(nowMs)` must run every frame**. Play online: `?online=1` (optional `&server=ws://…`). Browser-gated 2-client: movement propagation, wire events, leave→backfill. **Fixed en route: bot patrol arrival checked the DEPARTED node — every patrol froze after one leg on wide graphs (Battleground); now measures the target node (fixes SP too).**
- **v2.3 — kour.io pass (2026-07-13, SP-gated):** Rohit sent kour.io reference. (1) **Viewmodels** — chunky two-handed gloved grip (rear trigger fist + front support fist + forearms) on all weapons; cosmetic only, muzzle FX anchors frozen (`src/player/viewmodel.js`, `_fistArm`). (2) **Havana map** (`src/world/havanaMap.js`, `?room=havana`) — dense Mediterranean town: pink/tan/teal arched buildings + balconies, central plaza, climbable corners, alleys, awnings/palms/crates/power-lines, blue sky; ~96 m, 116 colliders, connected nav, point-symmetric spawns; Battleground stays default. (3) **Props** (`src/game/props.js`, `config.PROPS`) — headless-safe `PropsManager` driven by Match: roaming 1-HP **chickens** ride the player target list (stock hitscan hits them) → **PERSONAL** score only (HUD 🐔 counter + feed, never team score); one **football** with hand-rolled kinematics (gravity/bounce/roll + per-axis wall resolve), kicked by body contact + shoved by a bullet along its ray (`weapons.onShotResolved` now passes `origin`/`dir`). Online props (server-owned + wire sync) DEFERRED to v2.3-online.
- **UNCOMMITTED — `deploy/` (deploy.sh, pm2 ecosystem.config.cjs, nginx conf, setup-server.sh):** an agent auto-created server-deploy scaffolding this session. NOT committed (Rohit deploys himself; no unrequested infra). Left in the working tree for his review — delete or keep as he decides.
- Dev URL params (dev builds only): `?room=test` (feel gym + verticality fixture) · `?room=prod` (the old Prod arena) · `?room=havana` (v2.3 Havana town) · `?bots=0` (dummy practice) · `?nolock=1` (headless testing, exposes `window.__game`) · `?online=1` (join the Colyseus server).

## Tech stack (settled decisions — don't re-litigate without a reason)
- **Rendering:** Three.js (WebGL), low-poly primitives. No art pipeline yet.
- **Build:** Vite + vanilla JS. No React or heavy framework for the game itself.
- **Movement & collision:** hand-rolled character controller + raycasts + AABB. **Do NOT add a physics engine for core movement** — it fights the feel. Rapier or cannon-es only if physics props (bouncing grenades, ragdolls) are added later.
- **Shooting:** hitscan (raycast from camera). Not projectile — no bullet travel or drop.
- **Input:** Pointer Lock API + raw key events. Sensitivity = a multiplier on mouse delta.
- **Audio:** Web Audio API (or Howler.js). Sound carries the "feel."
- **Persistence:** `localStorage` (settings, high scores).
- **Multiplayer (Phase 5 only):** Colyseus (authoritative Node server), WebSocket first.

## Conventions / rules
- **Feel first.** Movement + shooting must feel good *before* features. Juice (hit feedback, sound, screen shake, hit-stop) is core, not polish.
- **Low-poly is the style, not a compromise** — it's why it runs on weak machines. Keep it deliberate.
- **Mid-spec is a hard target.** Judge every feature partly on its performance cost.
- **All combat values live in ONE config object** (below). Never hardcode damage/health inline.
- **Each phase must end in something playable.** No invisible-plumbing phases.
- **Respect the Out-of-Scope list** (below). Do not build parked features unless asked.

## Code conventions (all contributors — human or agent)
- **ES modules, one system per file, a class per system.** Layout: `src/core/ player/ world/ combat/ fx/ audio/ ui/ debug/`. No frameworks, no new deps without a reason written in the plan.
- **Every tunable lives in `src/config.js`** — never inline numbers. COMBAT damage canon mirrors this file.
- **Hot path = zero allocations.** Module-scope scratch vectors (`const _dir = new THREE.Vector3()`), pooled transients, no closures/spreads per frame.
- **`setTimeout`/`setInterval` are banned for gameplay** — everything ticks off clamped game `dt` (pause-safe). All smoothing is `1 − exp(−k·dt)` (frame-rate independent).
- **Systems talk via plain callback fields** (`weapons.onFire = …`) assigned in `main.js` — no event-bus library.
- **DOM HUD:** elements grabbed once in constructors; per-frame changes via `transform`/`opacity` only.
- **Comments:** file-top banner saying what the file owns + which edge-case register IDs (build plan §9) it implements; inline comments only for non-obvious constraints (`// E10: ammo swaps atomically at completion`).
- **Proof of health:** `npx vite build` must pass after any change set; movement/combat behavior changes get re-verified in the browser before the phase closes.

## Canonical combat constants
100 HP baseline. What matters is shots-to-kill / time-to-kill; these are tuned by playtesting.
```js
const COMBAT = {
  maxHealth: 100,
  rifle:  { body: 34, headMult: 3 },   // 3 body shots, or 1 headshot
  pistol: { body: 25, headMult: 2 },   // 4 body, or 2 head
  knife:  { body: 50, backstab: 100 }, // 2 front hits; backstab = instakill
};
```
Damage falloff + spread-at-range are **Phase 4** (need the real map). Flat hitscan + minimal spread until then.

## Controls
`WASD` move · `Shift` sprint · `Space` jump · `Mouse` look · `LMB` fire · `R` reload · `1` rifle · `2` pistol · `3` knife

## Out of scope — do NOT build yet
Open world / large streaming map · asymmetric Bug abilities (wall-crawl, swarm, teleporting Heisenbug) · boss fights (the "P0 Incident") · LLM-generated flavor text · progression / unlocks / marketplace / accounts · mobile / touch controls.

**Un-parked for v1.1 (Rohit, 2026-07-12):** character/viewmodel visual detail (still primitives-only + procedural transform animation — no asset pipeline) and a second map + map picker. Hard rule for all v1.1 visual work: **hitboxes, colliders, and nav are FROZEN** — combat must be pixel-identical.

## Commands
- `npm install` — deps (three, vite, lil-gui).
- `npm run dev` — dev server (Vite). Dev builds show the fps counter + lil-gui **feel tuner** bound live to `src/config.js`.
- `npm run build` / `npm run preview` — production build / serve it.
- Dev-only URL param `?nolock=1` — starts the sim without pointer lock, for automated/headless testing (`window.__game` is exposed in dev).

## Where things live
- `src/config.js` — **every tunable** (COMBAT damage canon mirrors this file; MOVE/FEEL/INPUT/AUDIO/PERF).
- `src/core/` input + settings · `src/player/` controller + camera · `src/world/` test room + colliders · `src/ui/` HUD + menus · `src/debug/` tuner.
