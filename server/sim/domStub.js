// ============================================================================
// server/sim/domStub.js — a headless `global.document` just rich enough for the
// client map/bot modules to BUILD their CanvasTexture labels/signs without a
// browser. The server never renders, so the texture pixels are irrelevant — we
// only need document.createElement('canvas').getContext('2d') to exist and its
// measureText/gradient calls to return the right SHAPE (not throw).
//
// This is approach (a) from the netcode brief: a tiny global stub that makes
// bots.js + decor.js (which do `document.createElement('canvas')` → 2d ctx →
// `new THREE.CanvasTexture(canvas)`) load clean, so the server reuses the REAL
// Bot class and the REAL battleMap.js — no forked AI, no forked geometry.
//
// Import this ONCE, before importing any src/world or src/game module.
// ============================================================================

// A 2d-context stand-in: every method is a no-op, except the couple that the
// map/label builders READ a value back from. CanvasTexture just stores the
// canvas reference; it never touches these pixels on a headless server.
function makeContext() {
  const ctx = {
    // read-back methods the builders depend on:
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    // everything else is a no-op draw call:
    save() {}, restore() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, arc() {}, arcTo() {}, rect() {}, ellipse() {},
    fill() {}, stroke() {}, fillRect() {}, strokeRect() {}, clearRect() {},
    fillText() {}, strokeText() {}, translate() {}, rotate() {}, scale() {},
    setTransform() {}, transform() {}, clip() {}, drawImage() {},
    quadraticCurveTo() {}, bezierCurveTo() {}, setLineDash() {},
  };
  return ctx;
}

function makeCanvas() {
  return {
    width: 0,
    height: 0,
    style: {},
    getContext: () => makeContext(),
    // toDataURL/etc. never called by the map/bot builders, but harmless:
    toDataURL: () => 'data:,',
  };
}

export function installDomStub() {
  if (globalThis.document && globalThis.document.__hotfixStub) return;
  globalThis.document = {
    __hotfixStub: true,
    createElement: (tag) => (tag === 'canvas' ? makeCanvas() : { style: {}, appendChild() {}, setAttribute() {} }),
    createElementNS: () => ({ style: {}, setAttribute() {} }),
  };
}
