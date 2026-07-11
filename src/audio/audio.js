// ============================================================================
// AudioEngine — synth-first Web Audio (register group H). Owns EVERY sound in
// the game; there are no asset files (§4B "synth-first"): shots, ticks, clicks,
// reload stages and the dopamine bells are all built from oscillators + noise
// buffers + envelopes at play time. Samples could later replace them behind the
// same play* calls.
//
// Edge cases owned here:
//   H1  AudioContext starts SUSPENDED (autoplay policy). unlock() resumes it and
//        MUST be called inside the same click gesture that grabs pointer lock
//        (main.js does this in menus.onPlay). Every play guards a missing/
//        suspended context and returns silently — the game runs, just quiet, if
//        audio is unavailable. Nothing here ever throws.
//   H2  A 600 RPM rifle OVERLAPS voices — each shot is a fresh node graph; we
//        never restart/cut one voice to play the next.
//   H3  Hard cap AUDIO.voiceCap concurrent one-shots; a new voice past the cap
//        steals (stops) the OLDEST. Voices self-evict when they finish.
//   H4  Outgoing hit = crisp HIGH tick (hitTick); incoming hits (Phase 3) will
//        use a different low register — the two must never be confusable.
//   H5  Rates derive from ctx.sampleRate — never a hardcoded 44100.
//   H6  Buses: master → sfx / ui gain nodes; master gain from settings.volume,
//        persisted by the caller. setMasterVolume(v) drives the master bus.
//
// Timing model (B6/E15): the reload STAGE cues (magOut → magIn → rack) are
// scheduled on GAME TIME via update(dt), not on ctx time across the whole
// reload — so a pause mid-reload pauses the remaining clicks, and a
// switch-cancel (onReloadEnd completed=false) drops them cleanly. Only the tiny
// intra-sound envelopes use ctx scheduling (they're < ~250 ms and fire once).
//
// PHASE 3 additions (register H, §4B danger/low-hp/positional audio):
//   • INCOMING hit = a LOW thud (incomingHit) — a different register from the
//     outgoing high hitTick (H4), plus a sharper variant when the hit drops the
//     player to critical. The two must never be confusable.
//   • HEARTBEAT — a synthesized two-beat lub-dub the low-hp stack loops on a
//     GAME-TIME timer (update(dt)) so pausing pauses it (F9/B6). vitals.js sets
//     rate + gain from observed hp; death/respawn stops it by construction.
//   • sfx-bus LOW-PASS (BiquadFilter) — dry (open) above the critical threshold,
//     engaged below; the cutoff is smoothed toward its target each frame (no
//     zipper noise). The whole sfx bus routes THROUGH it (so bot shots, hits and
//     footsteps all muffle "about to die"); the ui bus is unaffected.
//   • POSITIONAL bot audio (PannerNode, 'equalpower'): shots, deaths, footsteps
//     panned at the bot's world pos. The LISTENER follows the camera every frame
//     in update(dt, camera). Own-team footsteps quiet, enemy loud + honest (§4B).
// ============================================================================

import { AUDIO, COMBAT, FEEL } from '../config.js';

// Reload stage cue points as FRACTIONS of the weapon's reloadTime, so retuning
// reloadTime keeps the clicks proportional. magOut early, magIn mid, rack late.
const RELOAD_STAGES = [
  { at: 0.12, cue: 'magOut' },
  { at: 0.55, cue: 'magIn' },
  { at: 0.88, cue: 'rack' },
];

export class AudioEngine {
  constructor() {
    this.ctx = null;          // created lazily on first unlock() (H1)
    this.master = null;       // master GainNode → destination
    this.sfx = null;          // sfx bus  → lowpass → master (H6)
    this.sfxLowpass = null;    // BiquadFilter on the sfx bus (low-hp muffle, §4B)
    this.ui = null;           // ui bus   → master (H6) — NOT low-passed
    this._noise = null;       // shared white-noise buffer (precomputed once)
    this._voices = [];        // live one-shot source nodes, oldest first (H3)
    this.masterVolume = AUDIO.masterVolume;

    // Reload sequencer — advanced by update(dt) on game time (B6). Inactive
    // until onReloadStart arms it; onReloadEnd(false) cancels the remaining cues.
    this._reload = { active: false, weapon: null, t: 0, total: 0, next: 0 };

    // Low-pass smoothing state: the cutoff eases toward _lowpassTarget each frame
    // so engaging/releasing the "about to die" muffle has no zipper noise. vitals
    // sets the target via setSfxLowpass(); update(dt) smooths + writes it.
    this._lowpassCutoff = FEEL.lowPassCutoffDry;
    this._lowpassTarget = FEEL.lowPassCutoffDry;

    // Heartbeat loop state (game-time; F9). vitals sets targetRate/targetGain
    // from observed hp each frame; 0 gain ⇒ silent. The loop timer counts down
    // on game dt so pausing pauses the heartbeat (the classic "stuck after
    // respawn" is impossible — vitals zeroes the gain when hp is healthy/dead).
    this._heart = { timer: 0, rate: 0, gain: 0 };

    // Footstep global throttle (H3-adjacent): a sliding 100 ms budget so a
    // scramble of moving bots can't machine-gun step voices. Counts steps played
    // in the current window; update(dt) rolls the window on game time.
    this._stepWindow = 0;   // s remaining in the current 100 ms window
    this._stepCount = 0;    // steps played in this window

    // Positional listener orientation scratch — the WebAudio listener needs a
    // forward + up vector each frame. Plain numbers (no THREE import needed here).
    this._listenerReady = false;
  }

  // ---- Boot / lifecycle ----------------------------------------------------

  // Called from inside the start-click gesture (H1). Idempotent: builds the
  // graph on first call, resume()s on every call (browsers may re-suspend after
  // a tab-out). Fully guarded — a missing Web Audio impl just yields no sound.
  unlock() {
    if (!this.ctx) {
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return; // no Web Audio — run silent
        this.ctx = new Ctor();
        this._buildGraph();
        this._buildBuffers();
      } catch {
        this.ctx = null; // never throw out of audio bring-up
        return;
      }
    }
    // resume() returns a promise that can reject if there's no gesture; swallow.
    try { this.ctx.resume?.().catch(() => {}); } catch { /* ignore */ }
  }

  _buildGraph() {
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = this.masterVolume;
    this.master.connect(c.destination);

    // sfx bus → low-pass → master. Everything gameplay (shots, hits, footsteps,
    // heartbeat, incoming thuds) connects to this.sfx, so the low-hp muffle
    // (§4B) is a single filter on the whole bus. Starts wide-open (dry).
    this.sfx = c.createGain();
    this.sfx.gain.value = AUDIO.sfxVolume;
    this.sfxLowpass = c.createBiquadFilter();
    this.sfxLowpass.type = 'lowpass';
    this.sfxLowpass.frequency.value = this._lowpassCutoff;
    this.sfxLowpass.Q.value = 0.7; // gentle — no resonant "wah"
    this.sfx.connect(this.sfxLowpass);
    this.sfxLowpass.connect(this.master);

    // ui bus → master directly (NOT low-passed): menu/switch/reload clicks stay
    // crisp even when the player is dying — they're interface, not world.
    this.ui = c.createGain();
    this.ui.gain.value = AUDIO.uiVolume;
    this.ui.connect(this.master);

    // Configure the listener panning defaults (the LISTENER pose is updated every
    // frame in update(dt, camera)). Fixed reference distance for all panners.
    this._configureListener();
  }

  // Set up the WebAudio listener once. The per-frame pose (position/orientation)
  // is written in _updateListener from the camera. Guards the older
  // setPosition/setOrientation API AND the newer AudioParam API (Safari vs
  // Chrome) so it works everywhere without throwing.
  _configureListener() {
    const L = this.ctx.listener;
    if (!L) return;
    // Newer API exposes positionX/forwardX/... AudioParams; older exposes
    // setPosition/setOrientation. Detect once.
    this._listenerParamApi = 'positionX' in L;
    this._listenerReady = true;
  }

  // One shared ~1 s white-noise buffer, reused by every noise-based voice (H5:
  // length/rate from ctx.sampleRate). Precomputed once — no per-shot alloc (I1).
  _buildBuffers() {
    const c = this.ctx;
    const len = Math.floor(c.sampleRate * 1.0);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    // Deterministic PRNG (no Math.random — keeps boot reproducible; the buffer
    // is just broadband hash, exact values don't matter).
    let s = 0x2545f491;
    for (let i = 0; i < len; i++) {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      data[i] = (s / 0xffffffff) * 2 - 1;
    }
    this._noise = buf;
  }

  setMasterVolume(v) {
    this.masterVolume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.masterVolume; // H6
  }

  get ready() {
    return !!(this.ctx && this.ctx.state === 'running');
  }

  // ---- Voice management (H2/H3) -------------------------------------------

  // Track a source node so the voice cap can steal the oldest, and so it frees
  // itself on end. `node` is the terminal source (Oscillator/BufferSource).
  _register(node) {
    // Cap enforcement: over budget → stop the OLDEST live voice (H3). It's a
    // one-shot, so cutting it is the correct steal (a shot already heard).
    while (this._voices.length >= AUDIO.voiceCap) {
      const old = this._voices.shift();
      try { old.stop(); } catch { /* already stopped */ }
    }
    this._voices.push(node);
    node.onended = () => {
      const i = this._voices.indexOf(node);
      if (i !== -1) this._voices.splice(i, 1);
    };
  }

  // Envelope helper: a gain node ramping 0→peak→0 over [attack, decay] from a
  // start time. Short, one-shot; the intra-sound ramp uses ctx time (fine — it
  // fires once and is < ~250 ms; the GAME-time rule is about gameplay timers).
  _env(bus, t0, peak, attack, decay) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    g.connect(bus);
    return g;
  }

  // A band-limited noise burst → the workhorse for shots/whooshes/impacts.
  // Fire-and-forget: builds a source→(filter)→env→bus graph that stops itself.
  // No return value — a 600 RPM rifle calls this 10×/s, so no per-shot object.
  _noiseBurst(bus, { peak, attack, decay, type = 'bandpass', freq, q = 1, playbackRate = 1 }) {
    const c = this.ctx;
    const t0 = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    src.playbackRate.value = playbackRate;

    const g = this._env(bus, t0, peak, attack, decay);
    if (freq) {
      const filt = c.createBiquadFilter();
      filt.type = type;
      filt.frequency.value = freq;
      filt.Q.value = q;
      src.connect(filt);
      filt.connect(g);
    } else {
      src.connect(g);
    }
    src.start(t0);
    src.stop(t0 + attack + decay + 0.02);
    this._register(src);
  }

  // A short oscillator "tone" → clicks, ticks, bells, thumps. Fire-and-forget.
  _tone(bus, { wave = 'sine', freq, toFreq, peak, attack, decay }) {
    const c = this.ctx;
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, t0);
    if (toFreq && toFreq !== freq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, toFreq), t0 + attack + decay);
    }
    const g = this._env(bus, t0, peak, attack, decay);
    osc.connect(g);
    osc.start(t0);
    osc.stop(t0 + attack + decay + 0.02);
    this._register(osc);
  }

  // ---- Positional audio (PannerNode; register H, §4B) ----------------------

  // Make a PannerNode positioned at (x,y,z) that feeds the sfx bus. Cheap
  // 'equalpower' model (task brief) with arena-scaled distance falloff. The
  // caller connects its voice graph INTO the returned panner. Guards the older
  // setPosition API so it works on Safari too. Zero long-lived refs — the panner
  // is part of the one-shot graph and GCs when the source ends.
  _panner(x, y, z) {
    const c = this.ctx;
    const p = c.createPanner();
    p.panningModel = AUDIO.panningModel; // 'equalpower' — cheaper than HRTF
    p.distanceModel = 'inverse';
    p.refDistance = AUDIO.panRefDistance;
    p.maxDistance = AUDIO.panMaxDistance;
    p.rolloffFactor = AUDIO.panRolloff;
    if ('positionX' in p) {
      p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
    } else if (p.setPosition) {
      p.setPosition(x, y, z); // legacy (Safari)
    }
    p.connect(this.sfx);
    return p;
  }

  // Positional noise burst — like _noiseBurst but routed through a panner at
  // (x,y,z) instead of straight to a bus. Fire-and-forget, self-stopping.
  _noiseBurstAt(x, y, z, opts) {
    const c = this.ctx;
    const t0 = c.currentTime;
    const dest = this._panner(x, y, z);
    const src = c.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    src.playbackRate.value = opts.playbackRate ?? 1;
    const g = this._env(dest, t0, opts.peak, opts.attack, opts.decay);
    if (opts.freq) {
      const filt = c.createBiquadFilter();
      filt.type = opts.type ?? 'bandpass';
      filt.frequency.value = opts.freq;
      filt.Q.value = opts.q ?? 1;
      src.connect(filt); filt.connect(g);
    } else {
      src.connect(g);
    }
    src.start(t0);
    src.stop(t0 + opts.attack + opts.decay + 0.02);
    this._register(src);
  }

  // Positional tone — like _tone but through a panner at (x,y,z).
  _toneAt(x, y, z, { wave = 'sine', freq, toFreq, peak, attack, decay }) {
    const c = this.ctx;
    const t0 = c.currentTime;
    const dest = this._panner(x, y, z);
    const osc = c.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, t0);
    if (toFreq && toFreq !== freq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, toFreq), t0 + attack + decay);
    }
    const g = this._env(dest, t0, peak, attack, decay);
    osc.connect(g);
    osc.start(t0);
    osc.stop(t0 + attack + decay + 0.02);
    this._register(osc);
  }

  // Move the WebAudio listener to the camera each frame (position + orientation)
  // so positional sources pan correctly as the player turns. Called from
  // update(dt, camera). fwd/up come from the camera's world matrix. Guarded for
  // both the AudioParam API and the legacy setPosition/setOrientation.
  _updateListener(camera) {
    if (!this._listenerReady || !camera) return;
    const L = this.ctx.listener;
    const p = camera.position;
    // Camera looks down its local −Z; up is local +Y. Pull both from the world
    // matrix (rotation only). Read matrix elements directly (no alloc, I1).
    const e = camera.matrixWorld.elements;
    const fx = -e[8], fy = -e[9], fz = -e[10]; // −Z axis (forward)
    const ux = e[4], uy = e[5], uz = e[6];      // +Y axis (up)
    if (this._listenerParamApi) {
      L.positionX.value = p.x; L.positionY.value = p.y; L.positionZ.value = p.z;
      L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
      L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz;
    } else {
      L.setPosition?.(p.x, p.y, p.z);
      L.setOrientation?.(fx, fy, fz, ux, uy, uz);
    }
  }

  // ---- SFX (all synthesized; short + non-fatiguing at high repetition) -----

  // Rifle: punchy noise crack + a low body thump. Two voices (they overlap, H2).
  rifleShot() {
    if (!this.ready) return;
    this._noiseBurst(this.sfx, { peak: 0.55, attack: 0.001, decay: 0.09, type: 'bandpass', freq: 1700, q: 0.7 });
    this._tone(this.sfx, { wave: 'sine', freq: 150, toFreq: 60, peak: 0.5, attack: 0.001, decay: 0.10 }); // thump
  }

  // Pistol: shorter, brighter crack, less body.
  pistolShot() {
    if (!this.ready) return;
    this._noiseBurst(this.sfx, { peak: 0.5, attack: 0.001, decay: 0.06, type: 'bandpass', freq: 2600, q: 0.8 });
    this._tone(this.sfx, { wave: 'sine', freq: 200, toFreq: 90, peak: 0.35, attack: 0.001, decay: 0.05 });
  }

  // Knife swing: airy filtered-noise whoosh, no transient.
  knifeSwing() {
    if (!this.ready) return;
    this._noiseBurst(this.sfx, { peak: 0.28, attack: 0.02, decay: 0.14, type: 'bandpass', freq: 900, q: 1.4, playbackRate: 0.9 });
  }

  // Knife connect: a dull thunk.
  knifeHit() {
    if (!this.ready) return;
    this._tone(this.sfx, { wave: 'triangle', freq: 240, toFreq: 90, peak: 0.5, attack: 0.001, decay: 0.12 });
    this._noiseBurst(this.sfx, { peak: 0.22, attack: 0.001, decay: 0.05, type: 'lowpass', freq: 500, q: 0.7 });
  }

  // Dry fire: a tiny mechanical click (no shot). G6 pairs it with the HUD flash.
  dryClick() {
    if (!this.ready) return;
    this._tone(this.ui, { wave: 'square', freq: 320, toFreq: 180, peak: 0.14, attack: 0.001, decay: 0.03 });
  }

  // Reload stage clicks — three distinct mechanical timbres so the reload reads
  // as a sequence, not one blob. Driven by the game-time sequencer below.
  magOut() {
    if (!this.ready) return;
    this._tone(this.ui, { wave: 'square', freq: 260, toFreq: 150, peak: 0.16, attack: 0.001, decay: 0.04 });
  }
  magIn() {
    if (!this.ready) return;
    this._tone(this.ui, { wave: 'square', freq: 200, toFreq: 320, peak: 0.18, attack: 0.001, decay: 0.045 });
  }
  rack() {
    if (!this.ready) return;
    this._noiseBurst(this.ui, { peak: 0.22, attack: 0.001, decay: 0.05, type: 'highpass', freq: 1800, q: 0.6 });
    this._tone(this.ui, { wave: 'square', freq: 420, toFreq: 260, peak: 0.16, attack: 0.001, decay: 0.03 });
  }

  // Weapon switch: soft mechanical click on the ui bus.
  switchClick() {
    if (!this.ready) return;
    this._tone(this.ui, { wave: 'square', freq: 380, toFreq: 240, peak: 0.14, attack: 0.001, decay: 0.035 });
  }

  // OUTGOING hit confirm — crisp HIGH tick (H4). The most-played combat sound;
  // kept very short so a spray of them stays clean.
  hitTick() {
    if (!this.ready) return;
    this._tone(this.sfx, { wave: 'triangle', freq: 1400, toFreq: 1100, peak: 0.3, attack: 0.001, decay: 0.05 });
  }

  // THE dopamine bell — headshot. Slightly musical (two-note up-ring) + distinct
  // from the body tick so a headshot is unmistakable by ear alone.
  headshotDing() {
    if (!this.ready) return;
    this._tone(this.sfx, { wave: 'sine', freq: 1568, peak: 0.34, attack: 0.001, decay: 0.16 });      // G6
    this._tone(this.sfx, { wave: 'sine', freq: 2093, peak: 0.24, attack: 0.03, decay: 0.14 });        // C7 shimmer
  }

  // Kill confirm — deeper, fuller, satisfying (a downward two-tone).
  killConfirm() {
    if (!this.ready) return;
    this._tone(this.sfx, { wave: 'triangle', freq: 520, toFreq: 300, peak: 0.4, attack: 0.002, decay: 0.18 });
    this._tone(this.sfx, { wave: 'sine', freq: 780, toFreq: 500, peak: 0.26, attack: 0.002, decay: 0.16 });
  }

  // INCOMING hit (§4B/H4) — a LOW thud, deliberately a different register from
  // the outgoing high hitTick so dealing vs receiving is never confusable. A
  // muffled body thump + a short low-noise slap. `critical` (hpAfter ≤ critical
  // threshold) swaps in a sharper, higher-tension variant — the "you're almost
  // dead" punch. Non-positional: it's happening TO you, centered.
  incomingHit(critical = false) {
    if (!this.ready) return;
    if (critical) {
      // Sharper, tenser: a quick down-chirp + a bright noise slap.
      this._tone(this.sfx, { wave: 'triangle', freq: 330, toFreq: 120, peak: 0.5, attack: 0.001, decay: 0.14 });
      this._noiseBurst(this.sfx, { peak: 0.34, attack: 0.001, decay: 0.07, type: 'bandpass', freq: 1400, q: 0.8 });
    } else {
      // Dull low thud — clearly "I got hit", well below the 1400 Hz hitTick.
      this._tone(this.sfx, { wave: 'sine', freq: 190, toFreq: 80, peak: 0.5, attack: 0.001, decay: 0.16 });
      this._noiseBurst(this.sfx, { peak: 0.24, attack: 0.001, decay: 0.06, type: 'lowpass', freq: 380, q: 0.6 });
    }
  }

  // ONE heartbeat "lub-dub" — two soft low thumps a beat apart. Played by the
  // heartbeat loop (update), NOT called directly. gain scales the whole beat.
  _heartbeatOnce(gain) {
    if (!this.ready || gain <= 0) return;
    const c = this.ctx;
    const t0 = c.currentTime;
    // "lub" (stronger) then "dub" (softer, slightly higher) ~150 ms later.
    this._heartThump(t0, 58, gain);
    this._heartThump(t0 + 0.15, 72, gain * 0.7);
  }

  // A single dull heart thump at ctx-time `when` (a sub-bass sine blip). Uses
  // ctx scheduling for the two-beat spacing WITHIN one lub-dub (it's < 250 ms
  // and fires once — same rule as the reload envelopes); the LOOP cadence is
  // game-time in update() so pausing pauses the heartbeat (B6/F9).
  _heartThump(when, freq, gain) {
    const c = this.ctx;
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, when);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freq * 0.6), when + 0.14);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);
    g.connect(this.sfx);
    osc.connect(g);
    osc.start(when);
    osc.stop(when + 0.18);
    this._register(osc);
  }

  // ---- Positional bot combat sounds (Phase 3) ------------------------------

  // A bot's rifle shot, positional at (x,y,z). Same timbre family as the player
  // rifle (symmetric weapon) but scaled by AUDIO.botShotGain and panned.
  botShot(x, y, z) {
    if (!this.ready) return;
    this._noiseBurstAt(x, y, z, { peak: 0.55 * AUDIO.botShotGain, attack: 0.001, decay: 0.09, type: 'bandpass', freq: 1700, q: 0.7 });
    this._toneAt(x, y, z, { wave: 'sine', freq: 150, toFreq: 60, peak: 0.5 * AUDIO.botShotGain, attack: 0.001, decay: 0.10 });
  }

  // A bot death sound, positional. Bugs get a crunchy squelch (noise + down
  // chirp); SEs get a sadder falling beep (a downed teammate).
  botDeath(x, y, z, team) {
    if (!this.ready) return;
    const g = AUDIO.botDeathGain;
    if (team === 'bug') {
      // Crunchy: broadband splat + a guttural down-chirp.
      this._noiseBurstAt(x, y, z, { peak: 0.5 * g, attack: 0.001, decay: 0.16, type: 'lowpass', freq: 900, q: 0.8, playbackRate: 0.85 });
      this._toneAt(x, y, z, { wave: 'sawtooth', freq: 260, toFreq: 70, peak: 0.34 * g, attack: 0.001, decay: 0.2 });
    } else {
      // Sadder: a soft falling two-note beep (a friend went down).
      this._toneAt(x, y, z, { wave: 'square', freq: 620, toFreq: 300, peak: 0.28 * g, attack: 0.003, decay: 0.22 });
      this._toneAt(x, y, z, { wave: 'sine', freq: 420, toFreq: 210, peak: 0.2 * g, attack: 0.02, decay: 0.24 });
    }
  }

  // A single positional footstep tick. `enemy` picks the (loud vs quiet) gain
  // (§4B). Globally throttled + voice-cap-aware by the CALLER (footstep()); this
  // is the raw sound. A short filtered-noise scuff, low and soft.
  botFootstep(x, y, z, enemy) {
    if (!this.ready) return;
    const gain = enemy ? AUDIO.footstepEnemyGain : AUDIO.footstepAllyGain;
    this._noiseBurstAt(x, y, z, { peak: gain, attack: 0.002, decay: 0.05, type: 'lowpass', freq: 520, q: 0.9, playbackRate: 0.9 });
  }

  // Throttled footstep entry the frontend calls per stride. Enforces the global
  // 100 ms budget AND yields to combat: if the voice pool is nearly full, steps
  // (lowest priority) are dropped so a firefight never loses a shot to a step.
  // Returns true if it actually played (lets the caller reset its stride phase
  // only on a real step — optional).
  footstep(x, y, z, enemy) {
    if (!this.ready) return false;
    if (this._stepCount >= AUDIO.footstepMaxPer100ms) return false; // window budget spent
    if (this._voices.length > AUDIO.voiceCap - AUDIO.footstepVoiceHeadroom) return false; // yield to combat (H3)
    this._stepCount++;
    this.botFootstep(x, y, z, enemy);
    return true;
  }

  // ---- Low-hp audio controls (vitals.js drives these each frame) -----------

  // Set the sfx-bus low-pass target cutoff (Hz). update(dt) smooths the actual
  // filter frequency toward it (no zipper). vitals passes an hp-derived value
  // between FEEL.lowPassCutoffWet (dying) and lowPassCutoffDry (healthy).
  setSfxLowpass(cutoffHz) {
    this._lowpassTarget = cutoffHz;
  }

  // Set the heartbeat loop's target rate (bpm) and peak gain. vitals derives
  // both from observed hp; gain 0 ⇒ silent (healthy/dead → nothing plays, F9).
  setHeartbeat(bpm, gain) {
    this._heart.rate = bpm;
    this._heart.gain = gain;
  }

  // ---- Reload stage sequencer (game-time; B6/E15) --------------------------

  // Armed by onReloadStart. Cues advance in update(dt); paused pauses (no dt),
  // switch-cancel drops the rest. The final "rack" lands ~just before the
  // atomic ammo swap the weapon system does at reloadTime.
  startReloadSequence(weapon) {
    const spec = COMBAT[weapon];
    if (!spec || !spec.reloadTime) return;
    this.magOut(); // stage 0 fires immediately on the R press (feels responsive)
    this._reload.active = true;
    this._reload.weapon = weapon;
    this._reload.total = spec.reloadTime;
    this._reload.t = 0;
    this._reload.next = 1; // stage 0 already played; next scheduled cue index
  }

  // completed is unused for audio (the atomic ammo swap is the weapon system's
  // job) — but a cancel (switch) must stop pending clicks; a completion just
  // lets the natural last cue stand. Either way the sequencer goes idle.
  stopReloadSequence() {
    this._reload.active = false;
    this._reload.weapon = null;
    this._reload.next = 0;
  }

  // ---- Per-frame tick (game dt) -------------------------------------------
  // dt is GAME time (pauses with the sim, B6). camera is the THREE camera the
  // listener follows (optional — practice mode may omit it). Everything here is
  // guarded on a running context so it's a cheap no-op before unlock.
  update(dt, camera) {
    if (!this.ready) return;

    // 1) Listener follows the camera every frame (positional panning stays true
    //    as the player turns). §4B: "the LISTENER must follow the camera".
    if (camera) this._updateListener(camera);

    // 2) Smooth the sfx-bus low-pass cutoff toward its target (no zipper noise).
    //    Exp smoothing (B2) — dt is game time, so it pauses cleanly.
    if (Math.abs(this._lowpassCutoff - this._lowpassTarget) > 1) {
      const k = 1 - Math.exp(-FEEL.lowPassSmooth * dt);
      this._lowpassCutoff += (this._lowpassTarget - this._lowpassCutoff) * k;
      if (this.sfxLowpass) this.sfxLowpass.frequency.value = this._lowpassCutoff;
    }

    // 3) Heartbeat loop (game-time cadence, F9). Gain 0 ⇒ don't schedule beats;
    //    reset the timer so the FIRST beat after re-arming lands promptly.
    const h = this._heart;
    if (h.gain > 0 && h.rate > 0) {
      h.timer -= dt;
      if (h.timer <= 0) {
        this._heartbeatOnce(h.gain);
        h.timer += 60 / h.rate; // seconds per beat
        if (h.timer <= 0) h.timer = 60 / h.rate; // guard a huge dt (never negative-loop)
      }
    } else {
      h.timer = 0; // silent → next re-arm beats immediately
    }

    // 4) Footstep throttle window (100 ms budget). Roll it on game time.
    this._stepWindow -= dt;
    if (this._stepWindow <= 0) { this._stepWindow = 0.1; this._stepCount = 0; }

    // 5) Reload stage sequencer (unchanged — game-time cues, B6/E15).
    const r = this._reload;
    if (!r.active) return;
    r.t += dt; // game time — stops when paused, so remaining clicks pause too (B6)
    while (r.next < RELOAD_STAGES.length && r.t >= RELOAD_STAGES[r.next].at * r.total) {
      const cue = RELOAD_STAGES[r.next].cue;
      if (cue === 'magIn') this.magIn();
      else if (cue === 'rack') this.rack();
      r.next++;
    }
    // Once all stages have played, retire the sequencer (the weapon system's
    // own timer completes the reload; onReloadEnd will also idle us).
    if (r.next >= RELOAD_STAGES.length) this.stopReloadSequence();
  }
}
