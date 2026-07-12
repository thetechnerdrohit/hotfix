// ============================================================================
// src/net/avatars.js — render-side pool of REMOTE entity figures for online
// mode. Visual only: lightweight low-poly bodies (guard red / tracksuit green
// by team) + billboarded name labels, positioned from net.entities each frame.
// No AI, no colliders, no per-frame allocation (pooled; sync() reuses).
// ============================================================================

import * as THREE from 'three';
import { PERF } from '../config.js';

const SUIT = { bug: 0xc2314e, se: 0x2f9d7f };
const HOOD = { bug: 0x992743, se: 0x26816a };
const HEAD = { bug: 0x101014, se: 0xd8b48f };
const LABEL_BG = { bug: '#2a0508', se: '#12303a' };
const LABEL_FG = { bug: '#ff6f63', se: '#9fe8d6' };
const BODY = { x: 0.55, y: 1.15, z: 0.35 };
const HEAD_EDGE = 0.34;

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

class Avatar {
  constructor(scene, team, name) {
    this.group = new THREE.Group();
    const torso = new THREE.Mesh(
      new THREE.BoxGeometry(BODY.x, BODY.y * 0.72, BODY.z),
      new THREE.MeshLambertMaterial({ color: SUIT[team] }),
    );
    torso.position.y = BODY.y * 0.5;
    torso.castShadow = PERF.shadows;
    const hood = new THREE.Mesh(
      new THREE.BoxGeometry(BODY.x * 1.02, BODY.y * 0.2, BODY.z * 1.04),
      new THREE.MeshLambertMaterial({ color: HOOD[team] }),
    );
    hood.position.y = BODY.y * 0.92;
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(HEAD_EDGE, HEAD_EDGE, HEAD_EDGE),
      new THREE.MeshLambertMaterial({ color: HEAD[team] }),
    );
    head.position.y = BODY.y + 0.06 + HEAD_EDGE / 2;
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.24),
      new THREE.MeshBasicMaterial({ map: nameTexture(name, LABEL_BG[team], LABEL_FG[team]), transparent: true, side: THREE.DoubleSide }),
    );
    label.position.y = BODY.y + 0.06 + HEAD_EDGE + 0.16;
    this.label = label;
    this.group.add(torso, hood, head, label);
    scene.add(this.group);
  }
  set(x, y, z, yaw, dead) {
    this.group.visible = !dead;
    this.group.position.set(x, y, z);
    this.group.rotation.y = yaw + Math.PI;
    this.label.rotation.y = -(yaw + Math.PI); // stays camera-agnostic upright
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
      if (!a) { a = new Avatar(this.scene, e.team, e.name); this.avatars.set(id, a); }
      a.set(e.pos.x, e.pos.y, e.pos.z, e.yaw, e.dead);
    }
    for (const [id, a] of this.avatars) {
      if (!entities.has(id)) { a.dispose(this.scene); this.avatars.delete(id); }
    }
  }
}
