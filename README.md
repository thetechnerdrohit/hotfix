# HOTFIX

**A fast, low-poly browser FPS: 5 Software Engineers vs. 5 Bugs.** Mechanically a symmetric arena shooter in the CS/Valorant mold — two teams, same weapons, both sides shoot — reskinned so one team is Software Engineers and the other is Bugs (crawling errors labelled `NullPointerException`, `segfault`, `merge conflict`). You fight a Team Deathmatch in **"Prod"**, a data-center arena. The elevator pitch: *Krunker, but you're clearing bugs out of production.* It runs in the browser on mid-spec hardware with no install.

---

## Controls

| Key | Action |
|---|---|
| `W` `A` `S` `D` | Move |
| `Shift` | Sprint |
| `Space` | Jump |
| `Mouse` | Look / aim |
| `Left click` | Fire |
| `R` | Reload |
| `1` | Rifle (primary) |
| `2` | Pistol (secondary) |
| `3` | Knife (melee) |
| `Esc` | Pause / release mouse |

The **start menu** picks bot **difficulty** (easy / normal / hard) and a **Fast** graphics preset (shadows off, lower resolution, lighter effects — for weaker machines). **Sensitivity**, **FOV**, and **volume** live in the pause menu (`Esc`) and apply live. All of these persist in your browser between sessions.

---

## Quick start (development)

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install     # three, vite, lil-gui
npm run dev      # start the Vite dev server, then open the printed localhost URL
```

Dev builds show an FPS/frametime counter and a live **feel-tuner** panel (lil-gui) bound to `src/config.js` — every movement, gun, and feel value can be tuned while playing. Neither ships in a production build.

### Dev-only URL params

These work **only** in the dev server (`npm run dev`); production builds ignore them.

| Param | Effect |
|---|---|
| `?room=test` | Load the Phase-1 "feel gym" test room instead of the Prod map. |
| `?bots=0` | Boot the old target-practice mode (static dummies, no match). |
| `?nolock=1` | Start without pointer lock (for automated/headless testing). |

---

## Production build

```bash
npm run build     # outputs a static site to dist/
npm run preview    # serve the built dist/ locally to check it
```

`dist/` is a fully static bundle (HTML + one JS + one CSS + no external assets) — there is no server or backend for single-player. Vite is configured with `base: './'` (relative asset URLs), so the build works when served from **any path**, including a subdirectory — you can drop `dist/` anywhere.

---

## Deploy it yourself

The game is 100% static, so any static host works and hosting is free. Build first (`npm run build`), then pick one:

### Cloudflare Pages
- **Dashboard:** create a Pages project → *Direct Upload* → drag the `dist/` folder in.
- **CLI:** `npx wrangler pages deploy dist` (after `wrangler login`).

### Netlify
- **Drop:** go to [app.netlify.com/drop](https://app.netlify.com/drop) and drag the `dist/` folder onto the page.
- **CLI:** `npx netlify deploy --dir=dist --prod`.

### itch.io
1. Zip the **contents** of `dist/` (so `index.html` sits at the top level of the zip, not inside a `dist/` folder).
2. Create a new project, set **Kind of project** to *HTML*, and upload the zip.
3. Check **"This file will be played in the browser."**
4. In the embed options, enable **Fullscreen** and — importantly — the setting that shares extra permissions with the iframe. itch.io sandboxes the game in an `<iframe>`; **pointer lock and fullscreen must be allowed** or mouse-look won't grab. Turn on *"Enable scrollbars"* off / *"Mobile friendly"* as you like, but make sure **fullscreen button** is enabled and the iframe permissions include pointer lock. A frame size around **1280 × 720** works well.

Because of `base: './'`, none of these need any path configuration — the relative URLs resolve wherever the files land.

> **Do not** commit build artifacts. `dist/` and `node_modules/` are git-ignored; rebuild on each deploy.

---

## Status

**Single-player is complete** — phases 0–4 of the build plan:

- **0 — Foundations:** Three.js + Vite skeleton.
- **1 — Movement & feel:** pointer-lock mouse-look, coyote/buffer jump, hand-rolled AABB collide-and-slide.
- **2 — Weapons & shooting:** rifle / pistol / knife, camera-ray hitscan with headshots + backstabs, the full juice ladder (hitmarkers, synthesized audio, tracers, muzzle flash, hit-stop).
- **3 — The Bug team:** human-feeling bots (reaction-time + aim-error distributions, difficulty presets), health/damage/respawn, danger + low-health feedback stacks, kill feed, TDM scoring.
- **4 — The real map:** "Prod", the data-center arena, with a range model (damage falloff + move-spread penalty).

**Multiplayer (phase 5) is deliberately not built.** Real 5v5 needs an authoritative game server (client prediction, lag compensation, matchmaking) — that's a separate project with recurring hosting cost, best treated as its own decision once the single-player game is proven fun (see the build plan §5).

---

*Tech: Three.js (WebGL, low-poly primitives) · Vite + vanilla JS · hand-rolled character controller · Web Audio (synthesized SFX) · `localStorage` for settings. No frameworks in the game itself. See `HOTFIX-build-plan.md` for the full design and `CLAUDE.md` for conventions.*
