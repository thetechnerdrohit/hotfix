// ============================================================================
// src/net/avatars.js — render-side pool of REMOTE player figures (online mode).
// Visual only, no AI/colliders/per-frame alloc. v2.4: each avatar is a RANDOM
// kour.io-style character derived deterministically from the fighter's synced
// (skin, team) via net/skins.js — a hooded tracksuit silhouette (Squid DNA) in
// a team-tinted random outfit, a chest badge (○△□), a random skin tone, and an
// optional blocky hat/accessory. All clients render the SAME body for a given
// fighter because the appearance is a pure function of the wire-synced seed.
//
// Positions come from net.entities each frame (remote = interpolated). A name
// label billboards above the head, tinted by team so friend/foe still reads.
// ============================================================================

import * as THREE from 'three';
import { PERF } from '../config.js';
import { deriveAppearance } from './skins.js';

const LABEL_BG = { bug: '#2a0508', se: '#12303a' };
const LABEL_FG = { bug: '#ff6f63', se: '#9fe8d6' };
const BODY = { x: 0.55, y: 1.15, z: 0.35 };
const HEAD = 0.34;

function nameTexture(text, bg, fg) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = bg; x.fillRect(0, 0, 256, 64);
  x.fillStyle = fg; x.font = 'bold 30px ui-monospace, Menlo, monospace';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text.slice(0, 16), 128, 34);
  return new THREE.CanvasTexture(c);
}

function box(w, h, d, x, y, z, color) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
  m.position.set(x, y, z);
  m.castShadow = PERF.shadows;
  return m;
}

// The Squid chest badge (○△□) as a thin front-face shape.
function badgeMesh(kind, color) {
  let geo;
  if (kind === 'triangle') geo = new THREE.CircleGeometry(0.11, 3);
  else if (kind === 'square') geo = new THREE.PlaneGeometry(0.16, 0.16);
  else geo = new THREE.CircleGeometry(0.09, 16); // circle
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
  m.position.set(0, BODY.y * 0.52, BODY.z / 2 + 0.01);
  if (kind === 'triangle') m.rotation.z = Math.PI; // point up
  return m;
}

// A blocky kour-style hat/accessory on top of the head.
function hatMesh(kind, color) {
  const g = new THREE.Group();
  const topY = BODY.y + 0.06 + HEAD; // just above the head cube
  if (kind === 'cap') {
    g.add(box(HEAD * 1.05, 0.10, HEAD * 1.05, 0, topY, 0, color));
    g.add(box(HEAD * 0.9, 0.05, 0.22, 0, topY - 0.02, -HEAD * 0.7, color)); // brim
  } else if (kind === 'cowboy') {
    g.add(box(HEAD * 1.7, 0.05, HEAD * 1.7, 0, topY - 0.04, 0, color)); // wide brim
    g.add(box(HEAD * 0.8, 0.16, HEAD * 0.8, 0, topY + 0.06, 0, color));  // crown
  } else if (kind === 'beanie') {
    g.add(box(HEAD * 1.08, 0.16, HEAD * 1.08, 0, topY - 0.02, 0, color));
  } else if (kind === 'band') {
    g.add(box(HEAD * 1.06, 0.06, HEAD * 1.06, 0, BODY.y + 0.06 + HEAD * 0.82, 0, color)); // headband
  } else if (kind === 'tophat') {
    g.add(box(HEAD * 1.5, 0.04, HEAD * 1.5, 0, topY - 0.02, 0, color)); // brim
    g.add(box(HEAD * 0.85, 0.30, HEAD * 0.85, 0, topY + 0.15, 0, color)); // tall crown
  } else {
    return null; // 'none'
  }
  return g;
}

class Avatar {
  constructor(scene, team, name, skin) {
    const a = deriveAppearance(skin >>> 0, team);
    this.group = new THREE.Group();

    // Torso (tracksuit suit color) + hood (darker) + a trim stripe (accent).
    const torso = box(BODY.x, BODY.y * 0.72, BODY.z, 0, BODY.y * 0.5, 0, a.suit);
    const stripe = box(BODY.x * 1.01, BODY.y * 0.1, BODY.z * 1.01, 0, BODY.y * 0.5, 0, a.trim);
    const hood = box(BODY.x * 1.02, BODY.y * 0.2, BODY.z * 1.04, 0, BODY.y * 0.92, 0, a.hood);
    const head = box(HEAD, HEAD, HEAD, 0, BODY.y + 0.06 + HEAD / 2, 0, a.skinTone);

    // Chest badge (Squid ○△□) in the trim accent color.
    const badge = badgeMesh(a.badge, a.trim);

    // Optional hat/accessory.
    const hat = hatMesh(a.hat, a.hatColor);

    // Name label (team-tinted) billboarded above everything.
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.24),
      new THREE.MeshBasicMaterial({ map: nameTexture(name, LABEL_BG[team], LABEL_FG[team]), transparent: true, side: THREE.DoubleSide }),
    );
    label.position.y = BODY.y + 0.06 + HEAD + (hat ? 0.5 : 0.16);
    this.label = label;

    this.group.add(torso, stripe, hood, head, badge, label);
    if (hat) this.group.add(hat);
    scene.add(this.group);
  }

  set(x, y, z, yaw, dead) {
    this.group.visible = !dead;
    this.group.position.set(x, y, z);
    this.group.rotation.y = yaw + Math.PI;
    this.label.rotation.y = -(yaw + Math.PI); // stays upright/readable
  }
  dispose(scene) { scene.remove(this.group); }
}

export class AvatarPool {
  constructor(scene) {
    this.scene = scene;
    this.avatars = new Map(); // id → Avatar
  }
  /** Sync from net.entities (Map). selfId is skipped (first-person). */
  sync(entities, selfId) {
    for (const [id, e] of entities) {
      if (id === selfId) continue;
      let a = this.avatars.get(id);
      if (!a) { a = new Avatar(this.scene, e.team, e.name, e.skin || 0); this.avatars.set(id, a); }
      a.set(e.pos.x, e.pos.y, e.pos.z, e.yaw, e.dead);
    }
    for (const [id, a] of this.avatars) {
      if (!entities.has(id)) { a.dispose(this.scene); this.avatars.delete(id); }
    }
  }
}
