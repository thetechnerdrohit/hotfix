// ============================================================================
// Menu overlay. One overlay, four panels; pause and pointer-lock loss are the
// SAME transition (A1/G4). Sliders apply live (G5) and persist via the
// settings module. The lock hint exists because Chrome's re-lock cooldown
// (A2) must read as "wait a moment", never as a dead button.
//
// The START panel is the real front door: besides Enter Prod it owns two
// persisted (settings v2) controls in the sliders' visual language —
//   • DIFFICULTY (easy/normal/hard segmented) → sets BOTS.difficulty. It applies
//     on the NEXT match start/restart; main.js shows the "applies next match"
//     hint via setDifficultyHint() when a live match is running.
//   • GRAPHICS FAST toggle (Krunker-style preset) → boot-time (shadows/DPR/FX),
//     so flipping it offers a one-click "apply & reload" via setFastHint().
// Both are plain callback fields wired in main.js (onDifficulty / onFast) — no
// event bus, same pattern as the sliders. Text writes only; no per-frame work.
// ============================================================================

export class Menus {
  constructor(settings) {
    this.overlay = document.getElementById('overlay');
    this.panels = {
      start: document.getElementById('panel-start'),
      paused: document.getElementById('panel-paused'),
      unsupported: document.getElementById('panel-unsupported'),
      ctxlost: document.getElementById('panel-ctxlost'),
    };
    this.hints = [
      document.getElementById('hint-start'),
      document.getElementById('hint-paused'),
    ];

    this.sens = document.getElementById('sens');
    this.sensVal = document.getElementById('sens-val');
    this.fov = document.getElementById('fov');
    this.fovVal = document.getElementById('fov-val');
    this.vol = document.getElementById('vol');
    this.volVal = document.getElementById('vol-val');

    this.sens.value = settings.sensitivity;
    this.fov.value = settings.fov;
    this.vol.value = settings.volume; // H6 — persisted volume restores here
    this.renderSliderValues();

    // -- Start-panel options (Fast toggle; difficulty removed v2.4 online-only) -
    // The difficulty segmented control was removed from the DOM (the server owns
    // bot difficulty now). Guard every reference so the menu still constructs.
    this.diffSeg = document.getElementById('difficulty-seg');
    this.diffBtns = this.diffSeg ? Array.from(this.diffSeg.querySelectorAll('.seg-btn')) : [];
    this.diffHintEl = document.getElementById('difficulty-hint');
    this.fastToggle = document.getElementById('fast-toggle');
    this.fastHintEl = document.getElementById('fast-hint');

    this.playCb = null;    // (mode) => start — 'tdm' | 'ffa' (v2.7)
    this.sensCb = null;
    this.fovCb = null;
    this.volCb = null;
    this.difficultyCb = null;
    this.fastCb = null;

    // Reflect persisted state at construction (settings v2 fields).
    this.setDifficulty(settings.difficulty);
    this.setFast(settings.fast);

    // v2.7: two Play buttons pass the chosen mode; Resume replays the last mode.
    this._lastMode = 'tdm';
    document.getElementById('btn-play').addEventListener('click', () => { this._lastMode = 'tdm'; this.playCb?.('tdm'); });
    const ffaBtn = document.getElementById('btn-play-ffa');
    if (ffaBtn) ffaBtn.addEventListener('click', () => { this._lastMode = 'ffa'; this.playCb?.('ffa'); });
    document.getElementById('btn-resume').addEventListener('click', () => this.playCb?.(this._lastMode));

    this.sens.addEventListener('input', () => {
      this.renderSliderValues();
      this.sensCb?.(parseFloat(this.sens.value));
    });
    this.fov.addEventListener('input', () => {
      this.renderSliderValues();
      this.fovCb?.(parseFloat(this.fov.value));
    });
    this.vol.addEventListener('input', () => {
      this.renderSliderValues();
      this.volCb?.(parseFloat(this.vol.value));
    });

    // Difficulty: click a segment → reflect it immediately + notify main (which
    // decides persistence + whether to show the "applies next match" hint).
    for (const btn of this.diffBtns) {
      btn.addEventListener('click', () => {
        const value = btn.dataset.difficulty;
        this.setDifficulty(value);
        this.difficultyCb?.(value);
      });
    }

    // Fast toggle: flip the visual state + notify main (persist + reload hint).
    this.fastToggle.addEventListener('click', () => {
      const next = this.fastToggle.getAttribute('aria-checked') !== 'true';
      this.setFast(next);
      this.fastCb?.(next);
    });
  }

  renderSliderValues() {
    this.sensVal.textContent = `${parseFloat(this.sens.value).toFixed(2)}×`;
    this.fovVal.textContent = `${this.fov.value}°`;
    this.volVal.textContent = `${Math.round(parseFloat(this.vol.value) * 100)}%`;
  }

  // Reflect the active difficulty in the segmented control (no callback — pure
  // view update, so main can call it to sync without recursing into onDifficulty).
  setDifficulty(value) {
    for (const btn of this.diffBtns) {
      btn.classList.toggle('active', btn.dataset.difficulty === value);
    }
  }

  // Reflect the Fast toggle's on/off state (aria-checked drives the CSS knob).
  setFast(on) {
    this.fastToggle.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  // Difficulty hint under the segmented control (main shows "applies next match"
  // when a live match is mid-flight; '' clears it).
  setDifficultyHint(text) {
    if (this.diffHintEl) this.diffHintEl.textContent = text || ''; // removed v2.4 (online-only)
  }

  // Fast-preset hint. When `onReload` is provided, append a one-click "apply &
  // reload" affordance (the ONLY place a reload is offered — an explicit user
  // action, never a timer). Passing '' clears the whole hint.
  setFastHint(text, onReload) {
    this.fastHintEl.textContent = '';
    if (!text) return;
    this.fastHintEl.appendChild(document.createTextNode(text + ' '));
    if (onReload) {
      const link = document.createElement('button');
      link.className = 'link-inline';
      link.textContent = 'apply & reload';
      link.addEventListener('click', onReload);
      this.fastHintEl.appendChild(link);
    }
  }

  // panel: 'start' | 'paused' | 'unsupported' | 'ctxlost' | null (playing)
  show(panel) {
    this.overlay.classList.toggle('hidden', panel === null);
    for (const [name, el] of Object.entries(this.panels)) {
      el.classList.toggle('hidden', name !== panel);
    }
    if (panel !== null) this.setLockHint('');
  }

  setLockHint(text) {
    for (const el of this.hints) el.textContent = text;
  }

  onPlay(cb) { this.playCb = cb; }
  onSensitivity(cb) { this.sensCb = cb; }
  onFov(cb) { this.fovCb = cb; }
  onVolume(cb) { this.volCb = cb; }
  onDifficulty(cb) { this.difficultyCb = cb; }
  onFast(cb) { this.fastCb = cb; }
}
