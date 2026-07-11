// ============================================================================
// decor.js — VISUAL-ONLY set-dressing helpers for the Prod map (v1.1 MAPS pass).
// CanvasTexture builders + tiny mesh factories used by prodMap.js. NOTHING here
// creates a collider or touches nav/spawns — set-dressing is strictly cosmetic
// (the v1.1 hard rule: Prod's hitboxes/colliders/nav are FROZEN, byte-identical).
//
// Textures are CanvasTextures baked ONCE at map build (not per frame) — zero
// hot-path cost. Signs sit flush on wall faces (offset ~0.01 m) and never
// collide. The blinking-LED animation is ONE shared emissive material per color
// whose intensity is pulsed by map.update(dt) — see prodMap.js (§ brief:
// one material per color, not per-LED, ~zero cost, no per-frame allocation).
// ============================================================================

import * as THREE from 'three';

// A wall sign: text (optionally multiple lines) on a transparent panel, tinted.
// Returns a THREE.Texture (CanvasTexture) ready for a MeshBasicMaterial. Baked
// once — the canvas is discarded after upload. `w`/`h` are canvas pixels.
export function makeSignTexture(text, color, {
  w = 256, h = 128, bg = 'rgba(8,11,17,0.0)', font = 700, pad = 0.16,
} = {}) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (bg && bg !== 'transparent') { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
  // Fit the text to the canvas width (mono, uppercase — the data-center look).
  const lines = Array.isArray(text) ? text : [text];
  let size = Math.floor(h * (lines.length > 1 ? 0.4 : 0.62));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const maxW = w * (1 - pad * 2);
  // Shrink until the widest line fits.
  for (;;) {
    ctx.font = `${font} ${size}px ui-monospace, Menlo, Consolas, monospace`;
    let widest = 0;
    for (const ln of lines) widest = Math.max(widest, ctx.measureText(ln).width);
    if (widest <= maxW || size <= 8) break;
    size -= 2;
  }
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = size * 0.35;
  const lineH = size * 1.12;
  const y0 = h / 2 - (lines.length - 1) * lineH / 2;
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], w / 2, y0 + i * lineH);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// A soft vertical gradient (top → bottom) — used as a big backdrop plane so the
// void above the walls reads intentional (§ brief). `top`/`bot` are CSS colors.
export function makeGradientTexture(top, bot, { w = 4, h = 256 } = {}) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, top);
  g.addColorStop(1, bot);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Build a flat sign mesh (plane) carrying a sign texture. Non-colliding by
// nature (it's a Mesh added to the group; no collider is ever registered). The
// caller positions/orients it flush on a wall face.
export function makeSignMesh(texture, width, height) {
  const geo = new THREE.PlaneGeometry(width, height);
  const mat = new THREE.MeshBasicMaterial({
    map: texture, transparent: true, depthWrite: false,
    toneMapped: false, // keep the emissive-looking sign true under NoToneMapping
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.matrixAutoUpdate = false;
  return mesh;
}
