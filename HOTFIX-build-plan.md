# HOTFIX — Build Plan
*Working title. A Krunker-style browser FPS: 5 Software Engineers vs. 5 Bugs.*

---

## 1. The Concept

A fast, low-poly, browser-based first-person shooter that runs on a mid-spec PC with no install. Mechanically it's a symmetric 5v5 arena shooter in the mold of CS / Valorant — two teams, same weapons, both sides shoot. The theme is the twist: one team is **Software Engineers**, the other is **Bugs** (crawling errors with labels like `NullPointerException`, `segfault`, `merge conflict`). Think **CT vs. T, reskinned as SE vs. Bugs.**

Start single-player against bots. Add real 5v5 multiplayer later, once the game is already fun.

**The elevator pitch:** *Krunker, but you're clearing bugs out of production.*

---

## 2. Design Pillars

These are the non-negotiables. Every decision gets checked against them.

1. **Feel first.** Movement and shooting must feel good *before* anything else gets built. A great-feeling gun in an empty room beats a feature-packed game that feels like mud.
2. **Low-poly is the style, not a compromise.** Boxy, clean, colorful. This is *why* it runs on weak machines — the same reason Krunker holds 60 FPS on a Chromebook. Lean into it.
3. **Runs on a potato.** Mid-spec is a hard target, not a nice-to-have. Every feature is judged partly on its performance cost.
4. **The theme carries the fun.** The engineer in-jokes (error-labeled bugs, the Heisenbug, fighting in "Prod") are the personality. Don't lose them.
5. **Ship the small thing.** Every phase ends in something playable. No phase is allowed to be "invisible plumbing with nothing to show."

---

## 3. Target & Tech Stack

| Area | Choice | Why |
|---|---|---|
| Engine | **Three.js** (WebGL) | Same stack Krunker used; proven to run well on low-end machines. |
| Build tooling | **Vite** + vanilla JS | Fast dev server + hot reload. No React/heavy framework for the game itself. |
| Geometry | Primitive shapes (boxes, cylinders) | Zero art pipeline for now. Models come much later, if ever. |
| Movement & collision | **Hand-rolled character controller** + raycasts + AABB | A rigid-body physics engine fights you on jump/movement feel — shooters use custom controllers. Precise control over feel = Pillar #1. |
| Physics engine | *Optional, later:* **Rapier** (fast, Rust/WASM) or **cannon-es** (easy, pure-JS) | Only if you add physics props — bouncing grenades, ragdoll deaths. **Not needed for core movement.** |
| Shooting | **Hitscan** (raycast from camera) | Instant hit like CS/Valorant — no bullet travel or drop. Simpler to build and to network. |
| Input | Pointer Lock API + raw key events | Standard for mouse-look FPS. Sensitivity = a multiplier on mouse delta. |
| Audio | Web Audio API (or Howler.js) | Layered, low-latency sound. Sound is most of "feel." |
| Storage | `localStorage` | Save settings + high scores. No backend needed for single-player. |
| Multiplayer (Phase 5) | **Colyseus** (authoritative Node server), WebSocket first | Built-in matchmaking + state sync; MIT/free. Kirka.io (a Krunker-like FPS) runs on it — proof it fits. Krunker's lesson still applies: a JS server is CPU-bound and caps players-per-match. |
| Deployment | Client → static host (Cloudflare Pages / Netlify / Vercel). Server (Phase 5) → Colyseus Cloud / Fly.io / Railway | Client is just static files (free to host). Recurring cost lives only in the Phase 5 server. |

---

## 4. Game Design Spec

### Controls (MVP)
- `W A S D` — move
- `Shift` — sprint
- `Space` — jump
- `Mouse` — look / aim
- `Left click` — fire
- `R` — reload
- `1` — rifle (primary)
- `2` — pistol (secondary)
- `3` — knife (melee)

### Weapons (MVP)

| Slot | Key | Weapon | Role |
|---|---|---|---|
| Primary | `1` | Rifle | Main workhorse. Hitscan, moderate recoil, medium fire rate. |
| Secondary | `2` | Pistol | Backup. Lower damage, high accuracy, quick to draw. |
| Melee | `3` | Knife | Fast, close-range, high damage. Fun "gotcha" finisher. |

*Theme flavor (optional polish): the rifle is a "Debugger," the knife is a "Hotfix." Not required for MVP.*

### Teams
- **SE (Software Engineers)** vs. **Bugs.**
- Mechanically **symmetric** — same weapons, same movement. Only the look differs. This is why the SE-vs-Bugs theme costs almost nothing to build over a normal 5v5.
- *Later expansion (out of scope for now):* give Bugs asymmetric abilities — wall-crawling, melee swarm, a Heisenbug that teleports when aimed at. Save this until after 5v5 works.

### Modes
- **MVP: Team Deathmatch.** Simplest possible. First team to X kills, or most kills in a time limit.
- **Stretch: Search & Destroy** (plant/defuse) — the CS/Valorant-authentic mode. More logic (bomb, sites, round economy). Save for after TDM feels good.

### The Map — "Prod"
One map for now. Theme: a data center / server room — you are, of course, fighting in **production**.
- Two spawns (SE side, Bug side).
- A **mid** area with sightlines + cover.
- Two routes/lanes connecting the spawns.
- If you later add Search & Destroy: two "sites" (e.g. Database Site, Server Rack Site).
- **Sketch it on paper first.** Valorant/CS maps look simple but are carefully tuned for sightlines and timing. A rough paper layout saves real pain.

### Settings (MVP)
- **Mouse sensitivity slider** (built early — it defines how the whole game feels).
- Volume.
- *Later:* FOV slider, a "Fast" graphics preset (shadows/particles off) like Krunker's, rebindable keys.

### Combat tuning — damage & distance

**The health number is arbitrary. What matters is shots-to-kill (STK) and time-to-kill (TTK).** Pick STK first, back out the damage, and treat every value as a constant you dial in by *playtesting* — not math on paper. Baseline: **100 HP** (clean math, universal standard).

| Weapon | Body dmg | Headshot | Body STK | Role |
|---|---|---|---|---|
| **Rifle** (main) | 34 | ~100 (3× → one-shot) | 3 shots | Workhorse. Rewards aim. |
| **Pistol** (secondary) | 25 | 50 (2× → two-shot) | 4 shots | Backup. Precision over spray. |
| **Knife** (melee) | 50 front | — | 2 hits | Backstab = instakill (100+). High risk/reward. |

Keep it all in one config object so retuning the whole game is editing five numbers:

```js
const COMBAT = {
  maxHealth: 100,
  rifle:  { body: 34, headMult: 3 },   // 3 body shots, or 1 headshot
  pistol: { body: 25, headMult: 2 },   // 4 body, or 2 head
  knife:  { body: 50, backstab: 100 }, // 2 front hits; backstab = instakill
};
```

**Fire rate is the other half of TTK.** These damage numbers interact with the fire rates set in Phase 2 — tune them together.

**Distance matters, but mostly through accuracy, not damage.** The weapons are hitscan (instant hit, no leading or bullet drop). Range shows up three ways, in order of importance:
1. **Spread / recoil** — the *main* CS/Valorant range lever. Standing still + tapping is accurate; running + spraying scatters. Distance mostly decides *whether you hit*.
2. **Weapon role** — knife = touching distance, pistol = short/mid, rifle = mid/long. Wrong tool for the range loses the fight (free distance play, zero math).
3. **Damage falloff** — same hit does less at range. Real, but secondary.

**Falloff + spread-at-range are Phase 4**, not Phase 1 — in a boxy test room everything is close range, so they'd do nothing you could feel. Add them once the real map has long sightlines vs. tight corners. Then it's just more config:

```js
// Phase 4 addition, per weapon:
falloff: { start: 20, end: 50, minMult: 0.6 }, // full dmg to 20 units, → 60% by 50
```

**Rifle headshot lethality is the key skill lever.** One-shot-headshot is the core of CS/Valorant aim expression. Keep headshots softer while tuning movement/aim vs. bots, then tighten toward one-shot once fundamentals feel good. Armor/shield (Valorant-style) parks until there's a buy phase.

---

## 4B. FPS Fundamentals — the moment-to-moment spec

Everything a shooter must answer second-to-second: *how do I move, how do I shoot, did I hit, who's hitting me, how close to death am I, what happens when I die.* The damage table above is the "how much"; this section is the "how, exactly." All numbers here live in the single config object (§4C) — these are starting values, tuned by playtest.

### Weapons — full firing spec

Extends the damage table with the other half of TTK:

| Stat | Rifle | Pistol | Knife |
|---|---|---|---|
| Fire mode | Full-auto (hold) | Semi-auto (per click) | Melee swing |
| Fire interval | 100 ms (600 RPM) | 130 ms min between clicks | 500 ms per swing |
| Magazine | 30 | 12 | — |
| Reserve ammo | 90 | 36 | ∞ |
| Reload time | 2.2 s | 1.8 s | — |
| Raise time (switch-in) | 0.45 s | 0.35 s | 0.25 s |
| Reach | Hitscan, unlimited (falloff = Phase 4) | Hitscan, unlimited | 1.9 m ray from camera |
| Damage | 34 body / 3× head | 25 body / 2× head | 50 front / 100 backstab, **no headshot** |

**The firing model:**
- **The ray comes from the camera center, never the gun muzzle.** The crosshair is the truth; a muzzle-origin ray misses what the crosshair covers (parallax). Tracers *draw* from the muzzle to the hit point — that's visual only.
- One ray per shot; take the **closest** intersection across world *and* characters. World geometry blocks shots (no wall penetration; wallbangs are parked).
- **Headshot hitbox** = a sphere (r ≈ 0.18 m) at the top of the character. Test it before the body box; if a ray clips both, it counts as head — generous in the skilled direction. Bug bots get a visually distinct head block (the error-label badge) so the target is readable.
- **Backstab definition (exact, or it feels random):** backstab iff the attacker stands in the victim's rear 120° arc — `dot(victimForwardXZ, normalize(attackerPos − victimPos).xz) < −0.5` → flat 100.
- Knife is a short hitscan ray with a generous radius, and it respects walls — no stabbing through doors.
- **Semi-auto input buffer:** a click landing ≤ 60 ms before the pistol's cooldown expires fires on expiry (mirrors jump buffering — forgiveness reads as responsiveness).
- **Sprint and fire don't mix:** firing input during sprint drops sprint and fires after a 150 ms "sprint-out." No sprint-strafe laser accuracy.
- **Recoil** = camera kick per shot (mostly vertical + small horizontal jitter) with exponential recovery toward the original aim point (Valorant-style re-center). **Spread** = base cone + per-shot bloom that decays; **first shot is exact** (CS-mold skill expression). Both stay minimal/flat until the real map (Phase 4) makes range matter.
- Fire-rate gating uses a **next-shot-time accumulator in game time** — never per-frame checks (frame-rate changes DPS) and never `setTimeout` (breaks on pause).

### Ammo, reload, switch — the state machine

The reload/switch interactions are the classic bug farm. Rules, decided now:

1. `R` with a full mag → no-op. `R` with zero reserve → no-op + dry-click sound.
2. Reload is a **timed state; ammo swaps atomically at completion**, not at start. Cancelled reload = nothing happened.
3. **Switching weapons cancels reload** (progress lost, mag unchanged). This is standard and enables switch-cancel skill play.
4. **Firing input during reload is blocked and does *not* cancel the reload** (CS-mold; CoD-style fire-cancel parked as a tunable).
5. Sprinting during reload is allowed — the reload continues (sprint already blocks *firing*; blocking reload too feels awful).
6. Empty mag + fire → **dry-click sound + ammo HUD flash. No auto-reload** (teaches the reload habit; flag as a future accessibility toggle).
7. Pressing the current weapon's key → no-op. A switch during a switch retargets to the newest press. Firing is blocked until raise completes.
8. Out of everything → the knife is always there (infinite).
9. Reserve refills on respawn. Ammo pickups = Phase 4 map decision.
10. **All weapon timing ticks off game-time `dt`** — reload mid-pause resumes correctly, muzzle flash doesn't outlive a pause. (Global rule: `setTimeout` is banned for gameplay timing.)

### Damage & health model

- **One entry point: `applyDamage(target, amount, source, isHead)`.** Every bullet, knife, and future hazard routes through it — it's where clamps, kill credit, and feedback triggers live, and where Phase 5's server authority will slot in.
- 100 HP, **no passive regen** (regen would gut the shots-to-kill tuning that the whole damage table is built on). Health pickups = Phase 4 map decision. Heals clamp at max.
- Death at `hp ≤ 0`; the entity is **flagged dead the same frame** — a dead player can't fire a queued shot. Two entities killing each other in the same frame = a trade; both die. Correct and satisfying.
- Guard rails in `applyDamage`: ignore damage to already-dead targets, ignore ≤ 0 amounts, integer damage only. Overkill (102 on 100 HP) is just dead.
- Friendly fire **off** vs. bots (revisit for multiplayer).

### Getting shot — danger must answer "from WHERE?" in under 200 ms

- **Directional damage indicator:** a red wedge around the crosshair pointing at the damage source, projected in screen space and **recomputed every frame against camera yaw** — turning while it fades keeps it truthful. ~0.8 s fade. Multiple sources = multiple wedges (pool of 4, reuse oldest). Source directly above/below projects onto the horizontal plane.
- **Hurt flash:** red edge vignette pulse, intensity scaled by damage (34 reads harder than 10). Stacked hits re-trigger without additive white-out (alpha cap).
- **Incoming-hit sound is a different instrument than your outgoing hit-confirm** — low thud when you're hit, high tick when you hit. Players must never confuse dealing with receiving.
- Small camera shake on taking damage, amplitude scaled by damage. Subtle — this is information, not punishment.

### Low health — the escalating signal stack

Thresholds in config; every layer derives from *current hp observed each frame*, never from events — so healing/respawn clears everything instantly (the "heartbeat stuck after respawn" classic is impossible by construction).

| Layer | hp ≤ 35 | hp ≤ 15 |
|---|---|---|
| Vignette | persistent red edge, ~1 Hz slow pulse | stronger, faster pulse |
| Audio | heartbeat loop fades in | heartbeat faster + louder, subtle low-pass on world sounds (cheap Web Audio biquad — huge "about to die" feel) |
| HUD | health number amber, pulses | health number red, pulses harder |

### Dealing damage — the feedback ladder

Every hit answers "did I hit, and where?" within one frame:

1. **Hitmarker** — white cross flick over the crosshair (~80 ms); headshot variant distinct in color/shape.
2. **Hit sound** — crisp high tick; **headshot ding** (the dopamine bell); kill = deeper confirm. These three sounds are the most load-bearing audio in the game.
3. **Target reaction** — flinch + color flash on the bot, small directional particle puff (pooled).
4. **Kill confirm** — kill sound + crosshair X + kill-feed line + ~50 ms hit-stop (single-player only; revisit for MP) + the bug-death splat.
5. **World feedback** — pooled bullet-hole decals (cap 64, ring buffer, never on characters), impact particles.
6. **Muzzle flash** = emissive quad, ~40 ms, + slight camera kick. **No dynamic light per shot** — a light is the expensive way to get 10% more flash.
7. Tracer: thin fading quad, muzzle → hit point, pooled.
8. Floating damage numbers: **off by default**, config flag exists (contested taste; fights the CS-mold cleanliness).

### Death & respawn

`death → input locked → camera drop/tilt (~0.6 s) → death overlay (killer + weapon, 3 s countdown) → respawn`.
- Respawn: full hp/ammo, at the team spawn **farthest from living enemies** with a clear-of-geometry guarantee.
- **1.5 s spawn protection** vs. bots (damage-immune + bots deprioritize), **broken early the moment you fire** (no protected camping).
- All low-hp effects, wedges, and reload state hard-reset on respawn.

### HUD — spec and tech decision

**HUD is DOM/CSS overlaid on the canvas, not in-engine sprites.** Free layout, crisp text at any DPR, zero draw calls. Per-frame JS may touch **only `transform` and `opacity`** (no layout thrash).

Layout: center crosshair (dot + optional lines; expands with bloom; kill-X overlay) · bottom-left **health** (number + bar, color ramps green→amber→red at the low-hp thresholds) · bottom-right **ammo `mag / reserve`** (flashes when ≤ 25% and on dry-fire) · top-right kill feed (last 4, fading) · top-center score/round timer (Phase 3) · damage wedges around center · dev builds always show an fps/frametime counter (perf regressions must be *seen* the day they're introduced).

Game state machine: `MENU → PLAYING ⇄ PAUSED → DEAD → PLAYING`. Pause = Esc *or* pointer-lock loss (they're the same event in a browser). Pause menu owns: resume, sensitivity slider, FOV slider, volume, controls cheat-sheet. Pausing never mutates match state; rendering continues under the menu (frozen scene reads better than a black screen).

### Audio — spec

- **AudioContext starts suspended until a user gesture** (autoplay policy). `resume()` it inside the same click that requests pointer lock; guard every play against a suspended context. This is the #1 "silent game" bug in browser FPS.
- **Synth-first:** ship Phase 2 with Web Audio–synthesized SFX (oscillators + noise buffers for shots, ticks, clicks, heartbeat). Zero assets, surprisingly good, keeps the repo art-free. Samples can replace them later behind the same play calls.
- Buses: `master / sfx / ui` gain nodes; volume sliders = bus gains, persisted.
- **Voice cap:** ~16 concurrent one-shots, steal the oldest. A 600 RPM rifle needs overlapping pooled voices, not restarts.
- Distinct in/out sounds (see danger section). Positional audio (PannerNode) + footsteps arrive with bots (Phase 3): own steps quiet, enemy steps loud and honest — competitive information.

### Performance budgets & code conventions (mid-spec is a hard target)

Budgets: **≤ 150 draw calls · ≤ 100k tris · ≤ 1 shadow-casting light · devicePixelRatio capped at 2** (the later "Fast" preset drops shadows/particles/DPR, like Krunker's).

Conventions (these are rules, not tips):
- **Zero allocations in the per-frame loop.** Preallocate scratch `Vector3`s and reuse. A GC pause is a felt hitch, and a felt hitch is a feel bug.
- **Pool every transient:** tracers, decals, particles, damage wedges, audio voices.
- **All smoothing is exponential decay** — `x += (target − x) * (1 − exp(−k·dt))` — never `x *= 0.9`. Frame-rate independence: a 240 Hz monitor and a 30 fps potato must produce the same trajectories.
- `setTimeout`/`setInterval` are **banned for gameplay** (pause-unsafe, drift); everything ticks off clamped game `dt`.
- Static meshes: `matrixAutoUpdate = false`; merge static map geometry (Phase 4). Flat-shaded Lambert materials, vertex colors, fog for depth. `NoToneMapping` + sRGB output — flat colors stay true; that's the deliberate look.
- Handle `webglcontextlost`/`restored` (GPU resets are real): preventDefault, show a reload overlay — never a silent freeze.

---

## 4C. Single-source config — the full schema

CLAUDE.md's `COMBAT` block stays the canonical damage record — **on any conflict, CLAUDE.md's damage numbers win.** `src/config.js` extends it with everything else that's tunable. Shape:

```js
export const COMBAT = {
  maxHealth: 100,
  rifle:  { body: 34, headMult: 3,             // canon (CLAUDE.md)
            mode: 'auto', fireInterval: 0.100, magSize: 30, reserve: 90,
            reloadTime: 2.2, raiseTime: 0.45,
            spreadBase: 0.3, bloomPerShot: 0.25, recoilPerShot: 0.45 },
  pistol: { body: 25, headMult: 2,             // canon
            mode: 'semi', fireInterval: 0.130, magSize: 12, reserve: 36,
            reloadTime: 1.8, raiseTime: 0.35,
            spreadBase: 0.2, bloomPerShot: 0.15, recoilPerShot: 0.3 },
  knife:  { body: 50, backstab: 100,           // canon
            mode: 'melee', fireInterval: 0.5, raiseTime: 0.25,
            range: 1.9, backstabDot: -0.5 },
  headRadius: 0.18, sprintOutTime: 0.15, semiBufferMs: 60,
};

export const MOVE = {
  runSpeed: 5.0, sprintMult: 1.4, accelGround: 12, accelAir: 3,
  gravity: 22, jumpHeight: 1.1, coyoteMs: 100, jumpBufferMs: 120,
  maxFallSpeed: 40, dtClampMs: 50,
  height: 1.8, eyeHeight: 1.62, halfWidth: 0.4,   // LOCKED before map authoring
};

export const FEEL = {
  fovBase: 75, fovSprintAdd: 5, landDipScale: 0.03,
  hitStopMs: 50, hitmarkerMs: 80,
  lowHpThreshold: 35, criticalHpThreshold: 15,
  damageNumbers: false, headBob: false,
};

export const AUDIO = { masterVolume: 0.8, voiceCap: 16 };
export const PERF  = { dprCap: 2, shadows: true, decalCap: 64 };
```

**Player dimensions are LOCKED once map authoring starts** (height 1.8 / eye 1.62 / half-width 0.4; jump apex ~1.1 m clears a 1 m crate). Changing them later invalidates every doorway and jump route.

---

## 4D. Open decisions — defaults chosen, flagged for revisit

Decisions made without a strong ruling; each is one config value or a small diff to reverse.

| Decision | Default | Revisit when |
|---|---|---|
| Crouch | **None** through Phase 3 (single hitbox size; simpler bots; controls stay 8 keys) | Phase 4, with real-map sightlines (key choice: `C` — never `Ctrl`, browsers own `Ctrl+W`) |
| Fall damage | None | Phase 4, if the map gets verticality |
| Health regen | **No regen** (locked — protects STK tuning) | Only if the game drifts arcade |
| Auto-reload on empty | Off (dry click teaches) | Accessibility toggle later |
| Damage numbers | Off, flag exists | Playtest taste check |
| Head bob | Off — landing dip + FOV kick carry the motion feel | Probably never |
| FOV | 75 vertical (~103° h @ 16:9), slider 60–100, persisted | — |
| Sprint-fire | Blocked, 150 ms sprint-out | Feel pass in Phase 2 |
| Fire during reload | Doesn't cancel reload (switch does) | Feel pass in Phase 2 |
| Bunny-hop / air-strafe tech | Parked; plain jump forgiveness only | Post-Phase 4 identity question: Krunker-movement vs. CS-positioning |
| Sim step | Variable `dt`, clamped 50 ms, exp smoothing | Phase 5 will want a fixed tick — keep integration isolated in the controller |

---

## 5. The Roadmap

Build order matters more than anything here: **feel → shooting → enemies → map → multiplayer.** Each phase sits on top of a working previous phase.

**Size legend** (rough, relative — not hours; depends on your time & experience): 🟢 small · 🟡 medium · 🔴 large.

---

### Phase 0 — Foundations 🟢
**Goal:** Decisions locked, environment ready, no scope surprises.
- [ ] Confirm stack (Three.js + vanilla JS/Vite).
- [ ] Project skeleton + git repo, dev server running, blank canvas renders.
- [ ] Sketch the "Prod" map on paper (spawns, mid, two lanes, cover).

**Done when:** an empty Three.js scene renders in the browser and the repo is set up.

---

### Phase 1 — Movement & Feel 🟡
**Goal:** Walking around the test room feels *good*. This is the bedrock — if it feels bad, nothing else matters.
- [x] Pointer-lock mouse-look (`unadjustedMovement` where supported; pitch clamped ±89°).
- [x] **Sensitivity slider** (early, on purpose) — persisted, applies live.
- [x] WASD movement + `Shift` sprint (wish-direction **normalized** — no √2 diagonal speed).
- [x] Gravity + `Space` jump — with **coyote time (~100 ms)** and **jump buffering (~120 ms)**; ceiling contact zeroes upward velocity.
- [x] A boxy test room with wall collision — **per-axis AABB collide-and-slide** (Y→X→Z) so pressing into a wall glides along it.
- [x] The loop hardening that makes it feel *solid*: `dt` clamp (tab-suspend can't launch you through walls), exponential-decay smoothing everywhere, key-state cleared on blur/tab-switch (no stuck sprint), pause-on-pointer-lock-loss, re-lock cooldown handled (Chrome's ~1.25 s).
- [x] Feel juice: sprint FOV kick, landing camera dip scaled by impact.
- [x] Dev tuning panel (lil-gui, dev builds only) bound to the config — feel is tuned live, not by editing files.

**Done when:** you can walk, sprint, and jump around a room and it feels smooth and responsive — including the invisible stuff: jumping a frame after walking off a crate still works, alt-tabbing never wedges a key, and 144 Hz vs. 30 fps machines move identically. Edge cases: register §9, groups A–D.

---

### Phase 2 — Weapons & Shooting 🟡
**Goal:** Shooting feels *satisfying*. Apply every "juice" lesson — hit feedback, sound, the pop. The full spec is §4B; this checklist implements it.
- [x] `1/2/3` weapon switching with raise times; switch cancels reload (state machine rules §4B, all 10).
- [x] Hitscan firing — ray **from the camera**, closest hit across world + characters, game-time fire-rate accumulator (auto rifle / semi pistol with click cap / knife swing).
- [x] Ammo: mag + reserve, dry-fire click, HUD `mag / reserve` with low-ammo flash. `R` reload — atomic at completion.
- [x] Recoil (camera kick + recovery) / spread (base + bloom, first shot exact) — minimal values until Phase 4.
- [x] Knife: 1.9 m camera ray, wall-respecting; backstab arc per §4B.
- [x] Static targets with head + body zones (headshot sphere first, generous).
- [x] The feedback ladder: hitmarker (+ headshot variant), hit/headshot/kill sounds (synthesized), muzzle flash (emissive quad, no light), tracers, pooled decals, target flinch.
- [x] Audio boot: AudioContext resumed on the start-click gesture; `master/sfx/ui` buses; voice cap. *(+ volume slider in the pause menu, persisted.)*
- [x] Sprint-out on fire input (150 ms); fire blocked during raise/reload/sprint.
- [x] First-person viewmodel (box-primitive rifle/pistol/knife, raise/reload/recoil/swing animations) + ~50 ms hit-stop on kill.

*Known accepted quirks (from the independent review): standing inside a dummy and firing registers a headshot in any direction (dummies aren't movement colliders; resolves in Phase 3 when bots become colliders); tracer/flash origin lags the rig by one frame on the very first shot (invisible at 120 fps).*

**Done when:** shooting static targets is fun on its own, with no enemies yet — tap-firing feels crisp, the headshot ding is addictive, and reload/switch spam can't produce a single weird state. Edge cases: register §9, group E (+H for audio).

---

### Phase 3 — The Bug Team (bots) 🔴 ← **FIRST REAL MILESTONE**
**Goal:** A complete, genuinely fun single-player "SE vs. Bugs" game you can show people.
- [x] Bug enemies (low-poly, with error-label sprites; the label block IS the head hitbox — theme and readability in one). *(+ 4 SE teammate bots — it's a real 5v5.)*
- [x] Basic bot AI: path toward player (hand-authored waypoint graph — no navmesh for a boxy map), shoot when in line of sight (LOS raycasts staggered across bots, not every bot every frame).
- [x] **Bots must feel human, not aimbot:** reaction time as a distribution (~280 ± 80 ms), aim error as a cone that tightens while the target stays visible, extra error vs. a strafing player — **dodging must be rewarded** or movement is pointless against hitscan. Difficulty tunes reaction/error/burst discipline, never damage (bots deal the same 34 a player does — keeps the damage model honest). *(Verified: stationary target 63–92% hit vs. dodging 0–13%.)*
- [x] Health + damage + hit registration through the single `applyDamage()` entry point (§4B) — you take damage too.
- [x] **Danger communication + low-health stack (§4B):** directional damage wedges, hurt vignette + incoming-hit sound, heartbeat/vignette/HUD escalation at 35/15 hp.
- [x] Death, respawn, spawns: death cam + overlay, 3 s respawn, farthest-spawn selection, 1.5 s spawn protection (breaks if you fire), same-frame trades resolve as both-die.
- [x] Score / kill tracking + kill feed + simple round logic (Team Deathmatch: first to 30 or best at 5:00; PLAY AGAIN restarts without reload).
- [x] Satisfying bug-death splat (+ ~50 ms hit-stop on kill).
- [x] Positional audio for bots (PannerNode): enemy footsteps loud and honest, yours quiet.

**Why this phase is bigger than it looks:** building bots forces you to build health, damage, hit-reg, spawns, respawn, scoring, and rounds — the exact shared game-state layer multiplayer sits on top of later. **None of it is throwaway.**

**Done when:** you can play a full TDM round vs. bots, win or lose, and want to play again. *Natural point to pause and decide you love it before committing to multiplayer.*

---

### Phase 4 — The Real Map 🟡
**Goal:** Replace the test room with the actual "Prod" map.
- [x] Build out "Prod": two spawns (Dev Bay / Legacy Wing, 3 exits each), mid server racks, A-lane (28 m rifle sightline) + B-corridor dogleg (<10 m), cover, X-mirror team symmetry, teal/orange half coding, merged geometry (~11 draw calls).
- [x] Tune bot navigation for the real layout (34-node graph, DEV self-checks: reachability, spawn clearance + floor support, link LOS).
- [x] Range model per §4: damage falloff (rifle 20→50 m to 60%, pistol 12→30 m) applied identically to player and bots via one shared function + movement spread penalty (running scatters).
- [ ] (Optional) Add Search & Destroy mode: sites, plant/defuse, round economy. *(Parked.)*

**Done when:** matches on the real map feel tactical — cover matters, sightlines matter. *(Feel verdict pending the human playtest; systems verified in-browser.)*

---

### Phase 5 — Multiplayer: Real 5v5 🔴🔴 (THE MOUNTAIN)
**Goal:** Humans vs. humans. This is the heart of the "real players as Bugs" idea — and realistically **bigger than Phases 0–4 combined.** It's its own serious project. The saving grace: you're adding networking to a game that already works, instead of building both at once.

What's actually in it (named once so it's concrete, not scary):
- [ ] **Authoritative server** — the server owns the truth; clients are never trusted. This is your anti-cheat foundation (the browser client is fully inspectable).
- [ ] **Client-side prediction + reconciliation** — so your own movement feels instant despite ping.
- [ ] **Entity interpolation** — so other players move smoothly.
- [ ] **Hit registration + lag compensation** — deciding if a shot landed when both players have latency.
- [ ] **Matchmaking / lobbies** — getting 10 people into one game.
- [ ] **Hosting** — always-on servers that cost money every hour they run.

**Reality check:** Krunker's server was rewritten in JavaScript, and because game servers are CPU-bound, that's what limited its players-per-match. Plan capacity accordingly; consider a faster server language if you ever scale.

**Done when:** two real people can join the same match, shoot each other, and it feels fair. (This alone is a huge achievement.)

---

## 6. Out of Scope — For Now (the parking lot)

Writing these down so they don't sneak in and blow up the schedule. All are fine *later*; none belong in the first playable game.

- Open world / large streaming map (the original trap — a symmetric arena is the right scope).
- Asymmetric Bug abilities (wall-crawl, swarm, teleporting Heisenbug).
- Boss fights (the "P0 Incident" boss).
- Custom 3D models / animations / skins (primitives are fine for a long time).
- LLM-generated flavor text (dynamic error labels, end-of-match post-mortem roast). *Great feature, easy to bolt on later via a pooled-generation approach — but it's polish, not core.*
- Progression, unlocks, marketplace, accounts.
- Multiple maps.
- Mobile / touch controls.

---

## 7. Risks & How to De-risk

| Risk | De-risk |
|---|---|
| Movement/shooting feels bad → whole game feels bad | Spend real time on Phases 1–2; don't rush past "feel." |
| Multiplayer complexity kills the project | Build the full single-player game first (Phases 0–4). Treat Phase 5 as a separate decision. |
| Cheating in a browser FPS | Server-authoritative design from the start of Phase 5. Never trust the client. |
| Scope creep (the recurring one) | The Section 6 parking lot. Anything not in the current phase goes there. |
| Performance on weak machines | Low-poly discipline; a "Fast" graphics preset; test on a modest machine early. |

---

## 8. Right Now — Where Things Stand

**THE SINGLE-PLAYER GAME IS COMPLETE — v1.0.0** *(2026-07-11, phases 0–4 + release polish, built in one autonomous run)*. Full SE-vs-Bug 5v5 TDM against bots on the real "Prod" map: human-feeling bot AI on three difficulties, danger/low-HP signal stacks, death-cam + themed death/victory screens, synthesized positional audio, kill feed/scoreboard, Fast graphics preset, persisted settings (v2 schema), README with self-serve deploy instructions. `npm run build` produces a clean static `dist/` (verified booting with dev surfaces stripped, zero console errors).

Every phase passed a browser gate. The gates earned their keep — each caught something static review couldn't: a wrapper-vs-inner-camera boot crash (Phase 2), and a visual-only floor that dropped the player out of the world (Phase 4, D9 fired exactly as designed; the map self-check now also asserts floor support under every spawn).

**Next: the human feel-pass, then Rohit ships it.** Play full matches: movement + gunfeel + audio + bot difficulty + Prod's readability (its palette got a deliberate lift — judge it live). Tune with the feel-tuner, bake the values into `config.js`, then follow README → deploy `dist/` to Cloudflare Pages / Netlify / itch.io. Nothing has been published anywhere — that call is the owner's.

**Phase 5 (multiplayer) remains the mountain** — deliberately not built (see §5 and the README's status note): it's an authoritative-server project with recurring hosting costs, bigger than everything above combined, and the right time to decide is after real people have played the single-player game.

---

## 9. The Edge-Case Register

Every known way this game can feel broken, decided *before* it's coded. Each entry: the case → the decision/mitigation → the phase that implements it. Phase checklists reference these groups; when a phase closes, its group gets audited. Rows marked *rule* are authoring/code conventions rather than features.

### A — Input & pointer lock

| # | Edge case | Decision / mitigation | Phase |
|---|---|---|---|
| A1 | `Esc` exits pointer lock at browser level — not interceptable as a key | Lock-loss **is** pause: `pointerlockchange → unlocked` always transitions to PAUSED; never simulate while unlocked | P1 |
| A2 | Chrome enforces ~1.25 s cooldown after unlock; an early re-lock request **rejects** | Catch the promise rejection, show "click again in a moment" — never a silently dead Resume button | P1 |
| A3 | `requestPointerLock` only works inside a user gesture | Call it synchronously in the click handler — never after an `await` | P1 |
| A4 | Alt-Tab / Cmd-Tab mid-keyhold: `keyup` never fires → stuck sprint forever | Clear ALL key state on window `blur`, `visibilitychange`, and lock loss | P1 |
| A5 | AZERTY/Dvorak users find WASD scattered | Bind `event.code` (physical position), never `event.key` | P1 |
| A6 | Held Space fires OS key-repeat → accidental jump spam | Guard `e.repeat`; edge-triggered actions arm once per physical press | P1 |
| A7 | Space/arrows scroll the page when not locked | `preventDefault` game keys only while playing; menus stay scrollable | P1 |
| A8 | `Ctrl+W` closes the tab — cannot be intercepted | Never design Ctrl-chords (future crouch = `C`) | rule |
| A9 | `mousemove` can deliver absurd delta spikes (lock-acquisition frame, driver glitches) | Clamp per-event delta magnitude | P1 |
| A10 | OS mouse acceleration pollutes aim on some platforms | Request `unadjustedMovement: true`; fall back gracefully where rejected (Safari/FF) | P1 |
| A11 | Mouse4/5 = browser Back/Forward; middle-click pastes on Linux | `preventDefault` mousedown while locked | P1 |
| A12 | Right-click context menu pops mid-fight | Suppress `contextmenu` while locked (future ADS lives on RMB) | P1 |
| A13 | Double-click on the start overlay double-fires the lock request | Idempotence guard: ignore while a request is pending or lock is held | P1 |
| A14 | Input accumulated while paused replays on resume | Zero mouse deltas + clear edge buffers on every state transition | P1 |

### B — Time & the game loop

| # | Edge case | Decision / mitigation | Phase |
|---|---|---|---|
| B1 | Tab hidden suspends rAF; on return `dt` = minutes → player integrates through every wall | **Clamp `dt` ≤ 50 ms.** The single most important line in the loop | P1 |
| B2 | `v *= 0.9` smoothing behaves differently at 30 vs 240 fps | All smoothing = `1 − exp(−k·dt)` — identical trajectories on every machine | P1 |
| B3 | Per-frame fire-rate checks cap DPS at low fps | Next-shot-time accumulator in game time | P2 |
| B4 | 240 Hz monitors run the frame 8× more often than a potato | Zero-alloc loop; cheap frames; fps counter always on in dev | P1 |
| B5 | A GC pause / hitch lands mid-jump | Semi-implicit Euler integration + the dt clamp — stable through hitches | P1 |
| B6 | `setTimeout` timers drift and ignore pause (reload finishing while paused…) | **Banned for gameplay.** Everything ticks off clamped game `dt` | rule |
| B7 | Resume after pause delivers the pause duration as one giant `dt` | Reset the last-frame timestamp on resume (clamp is the backstop) | P1 |
| B8 | Variable `dt` is fine solo but multiplayer needs determinism | Integration stays isolated in the controller; Phase 5 swaps in a fixed tick locally | P5 |

### C — Movement

| # | Edge case | Decision / mitigation | Phase |
|---|---|---|---|
| C1 | W+A unnormalized = √2× speed — the oldest FPS bug | Normalize the wish direction before applying speed | P1 |
| C2 | Backward/strafe sprint undefined | Sprint applies only when wish direction is forward-ish (dot > 0.5) | P1 |
| C3 | Jump pressed a frame after walking off a ledge gets eaten | **Coyote time ~100 ms** | P1 |
| C4 | Jump pressed a frame before landing gets dropped | **Jump buffer ~120 ms**, consumed once | P1 |
| C5 | Buffer + key-repeat = accidental auto-bhop | `e.repeat` guard; buffer arms per physical press (bhop itself parked, §4D) | P1 |
| C6 | Zero air control feels dead; full air control is silly | Separate `accelAir` ≈ ¼ of ground accel | P1 |
| C7 | Head touches ceiling → player "sticks" to it for the arc | Ceiling contact zeroes only *upward* velocity | P1 |
| C8 | Unbounded fall speed | `maxFallSpeed` cap (also insurance against tunneling) | P1 |
| C9 | Landing feels like nothing | Kill `vy` exactly, set grounded, camera dip scaled by impact speed | P1 |
| C10 | Walking off an edge (no jump) must still arm coyote | `grounded` derives from the collision result every frame, not from jump state | P1 |
| C11 | FOV kick / landing dip can nauseate sensitive players | Subtle values, exp-smoothed, config-flagged (future reduce-motion toggle) | P1 |
| C12 | Movement input during MENU/DEAD must do nothing | Controller only ticks in PLAYING | P1 |

### D — Collision (hand-rolled AABB — we own every failure mode)

| # | Edge case | Decision / mitigation | Phase |
|---|---|---|---|
| D1 | Resolving the full 3D move at once makes walls "sticky" | **Per-axis resolve (Y → X → Z)**, zeroing only the blocked axis → wall-sliding falls out for free | P1 |
| D2 | Tunneling through thin walls at sprint speed + low fps | dt clamp caps a step at ~0.35 m **+ map rule: static geometry ≥ 0.5 m thick.** Documented so nobody adds swept-AABB complexity we don't need | P1 |
| D3 | Flush wall seams snag the slide via float error | Skin epsilon (~1e-3) on clamps; prefer one merged collider over abutting slabs | P1 |
| D4 | Landing exactly on a crate corner: grounded is float-luck | One epsilon-consistent overlap test decides deterministically | P1 |
| D5 | Spawning/teleporting inside geometry = wedged forever | Spawn points clear by construction + dev-mode depenetration assert | P1/P3 |
| D6 | Gaps narrower than the player make the resolver oscillate | Map rule: never author gaps in (0, playerWidth + 0.1); dev overlap warning | rule |
| D7 | AABB player overhangs a crate edge visually | Accepted low-poly quirk (capsule collider parked) | — |
| D8 | Openings shorter than the player jitter the ceiling clamp | Map rule: openings ≥ height + 0.1 | rule |
| D9 | A collider-authoring mistake drops the player out of the world | Kill-floor Y assert + dev respawn — cheap insurance | P1 |
| D10 | Float precision far from origin | Irrelevant at < 100 m arena scale — noted, ignored | — |
| D11 | Stairs/ramps need step-up logic AABB doesn't give | None in Phase 1 (jumpable crates instead); decide with the real map | P4 |
| D12 | Changing player dims after map authoring invalidates every doorway | Dims **LOCKED** in config: 1.8 h / 1.62 eye / 0.4 half-width / 1.1 jump apex | rule |

### E — Shooting & weapons

| # | Edge case | Decision / mitigation | Phase |
|---|---|---|---|
| E1 | Muzzle-origin rays miss what the crosshair covers (parallax) | Ray from **camera center**; muzzle is visual-only (tracer start) | P2 |
| E2 | Shooter's own collider eats the shot | Ray skips self and owned objects | P2 |
| E3 | Wall must block bullets, but a peeking head must be hittable | Closest-hit across world + per-character head-sphere & body tests | P2 |
| E4 | Fire held across pause → resume = surprise gunfire | Clear button state on pause/unlock | P2 |
| E5 | Autoclickers push semi-auto to silly RPM | Min interval between pistol shots (130 ms) | P2 |
| E6 | Click 20 ms before cooldown expiry gets eaten | 60 ms semi-auto input buffer (mirrors jump buffer) | P2 |
| E7 | Sprint-strafe firing with full accuracy | Sprint blocks fire; fire input triggers 150 ms sprint-out, then fires | P2 |
| E8 | Firing during weapon raise | Blocked until raise completes | P2 |
| E9 | `R` with full mag / zero reserve | No-op (+ dry click on zero reserve) | P2 |
| E10 | Cancelled reload duplicates or loses ammo | Ammo swaps **atomically at completion**; cancel = nothing happened | P2 |
| E11 | Switch during reload / switch during switch | Cancels reload (mag untouched); re-switch retargets to newest press | P2 |
| E12 | Empty mag + fire | Dry click + ammo HUD flash; **no auto-reload** (§4D) | P2 |
| E13 | Knife stabs through walls/doors | Knife ray respects world geometry | P2 |
| E14 | "That wasn't a backstab!" | Exact rear-120°-arc dot test (§4B); knife can't headshot | P2 |
| E15 | Weapon timers via `setTimeout` break on pause | Game-time timers only (B6) | P2 |
| E16 | headMult 3 × 34 = 102 > 100 | Intended one-shot; death check is `hp ≤ 0`, damage stays integer | P2 |

### F — Damage, health, death

| # | Edge case | Decision / mitigation | Phase |
|---|---|---|---|
| F1 | Damage applied from N call sites drifts (missed clamps/feedback) | Single `applyDamage(target, amount, source, isHead)` entry point | P3 |
| F2 | A dead player's queued shot fires the same frame | Dead flag set immediately inside the damage call | P3 |
| F3 | Both entities reach 0 in the same frame | It's a trade — both die. Deliberate, and MP-correct later | P3 |
| F4 | Negative/zero damage; damage to the already-dead | Guarded at the entry point | P3 |
| F5 | Heal above max / display below 0 | Clamp both ends; HUD shows `max(0, hp)` | P3 |
| F6 | Regen silently invalidates the STK math the game is tuned on | **No regen** (locked, §4D) | design |
| F7 | Damage wedge goes stale as you turn | Wedge angle recomputed vs. camera yaw every frame of its fade | P3 |
| F8 | Ten hits in a second white-out the screen | Vignette alpha cap; re-trigger, never accumulate | P3 |
| F9 | Heartbeat keeps playing after respawn (the classic) | All low-hp effects derive from *observed hp each frame*, never from events | P3 |
| F10 | Spawn protection enables protected camping | Protection breaks the moment you fire | P3 |

### G — HUD, UI, menus

| # | Edge case | Decision / mitigation | Phase |
|---|---|---|---|
| G1 | In-canvas text HUD costs draw calls and blurs at DPR | DOM/CSS overlay — crisp, free, zero draw calls | P2 |
| G2 | Per-frame HUD writes cause layout thrash | Only `transform`/`opacity` change per frame | P2 |
| G3 | Pause over a black screen disorients | Keep rendering the frozen scene under the menu | P1 |
| G4 | Esc-pause and lock-loss diverge into two different states | They are the SAME transition (A1) | P1 |
| G5 | Sensitivity/FOV need a reload to apply | Applied live from the pause menu | P1 |
| G6 | Dry-fire/low-ammo communicated only by sound | Ammo HUD flash at ≤ 25% and on dry-fire (deaf-friendly) | P2 |
| G7 | Kill feed grows unbounded | Last 4 entries, fading, pooled rows | P3 |
| G8 | Crosshair-as-info (bloom/kill-X/hitmarker) occludes aim | Thin lines, size caps, never a filled blob | P2 |

### H — Audio

| # | Edge case | Decision / mitigation | Phase |
|---|---|---|---|
| H1 | AudioContext is suspended until a gesture → fully silent game | `resume()` inside the start click; guard every play call | P2 |
| H2 | 600 RPM rifle restarting one voice cuts itself off | Pooled overlapping voices | P2 |
| H3 | Unbounded one-shots in a firefight distort and drop frames | Voice cap ~16, steal oldest | P2 |
| H4 | Dealing vs. receiving hits sound confusable | Different registers: outgoing = high tick, incoming = low thud | P2/P3 |
| H5 | Hardcoded 44100 Hz breaks on odd devices | Use `context.sampleRate` | P2 |
| H6 | Volume forgotten between sessions | Persisted bus gains | P2 |
| H7 | Tab-out leaves the game blaring | Optional mute-on-blur setting (default off) | later |

### I — Performance & memory

| # | Edge case | Decision / mitigation | Phase |
|---|---|---|---|
| I1 | Per-frame allocations → GC hitches felt as input lag | Zero-alloc hot loop; preallocated scratch vectors | rule |
| I2 | Transients (tracers/decals/particles/wedges) churn objects | Pools with caps (decals 64, ring buffer) | P2/P3 |
| I3 | A dynamic light per muzzle flash tanks mid-spec GPUs | Emissive quad instead; ≤ 1 shadow-casting light total | P2 |
| I4 | Hi-DPI renders 4–9× the pixels | DPR capped at 2; "Fast" preset later drops to 1 | P1 |
| I5 | Matrix auto-updates on static world meshes | `matrixAutoUpdate = false` for statics | P1 |
| I6 | Many small static meshes = many draw calls | Merge static geometry at Phase 4 (test room fine as-is); budget ≤ 150 calls | P4 |
| I7 | Perf regressions discovered months later | Dev builds always display fps/frametime | P1 |
| I8 | WebGL context loss (driver update, GPU reset) freezes silently | Handle `webglcontextlost/restored` + reload overlay | P1 |

### J — Browser, platform, persistence

| # | Edge case | Decision / mitigation | Phase |
|---|---|---|---|
| J1 | `localStorage` throws (private mode, disabled, quota) | try/catch wrapper; game fully playable with zero persistence | P1 |
| J2 | Corrupt/old settings JSON crashes boot | Versioned schema `{v:1,…}`; any parse error → defaults, never crash | P1 |
| J3 | Two tabs write settings simultaneously | Last-write-wins accepted for settings (scores may want merge-max later) | note |
| J4 | Safari lacks `unadjustedMovement`; per-browser delta quirks | Feature-detect via rejection; the sensitivity slider absorbs platform differences — don't chase per-browser constants | P1 |
| J5 | Dragging the window between monitors changes devicePixelRatio | Listen `resize` + `matchMedia` resolution change; re-read DPR, resize renderer, update aspect | P1 |
| J6 | Browser zoom ≠ 100% skews CSS-pixel math | Canvas uses client size (works); hint toward 100% zoom if DPR looks odd | note |
| J7 | Three r152+ color management shifts colors between versions | Set `outputColorSpace` + `NoToneMapping` explicitly — flat colors stay true | P0 |
| J8 | Hosting under a subpath (itch.io, GH Pages) breaks asset URLs | Vite `base: './'` | P0 |
| J9 | Extensions (dark-mode injectors) restyle the DOM HUD | Accepted risk; keep HUD selectors specific | note |
| J10 | Ancient browser: no pointer lock / WebGL | Feature-check at boot → friendly "browser not supported" message, never a blank page | P1 |
