// Little effects: confetti, dust puffs, hammer sparks, emoji sprites.
// Everything is pooled in a single InstancedMesh so bursts cost one draw call.
import * as THREE from 'three';

const MAX = 260;
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpS = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

const CONFETTI = ['#f59bae', '#8cc8f5', '#ffc96b', '#b49cf5', '#7fd9b4', '#f7a979', '#ffffff'];

// ── emoji / glyph textures (cached) ──────────────────────────────────
const texCache = new Map();
export function glyphTexture(key, draw) {
  if (texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  draw(g, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  texCache.set(key, tex);
  return tex;
}
export function emojiTexture(char) {
  return glyphTexture('e:' + char, (g, s) => {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `${s * 0.72}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    g.fillText(char, s / 2, s / 2 + s * 0.05);
  });
}
export function bubbleTexture(text, bg, fg = '#fff') {
  return glyphTexture(`b:${text}:${bg}`, (g, s) => {
    g.fillStyle = bg;
    g.beginPath();
    g.arc(s / 2, s * 0.44, s * 0.36, 0, Math.PI * 2);
    g.moveTo(s * 0.4, s * 0.74); g.lineTo(s / 2, s * 0.92); g.lineTo(s * 0.6, s * 0.74);
    g.fill();
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `900 ${s * 0.48}px ui-rounded, -apple-system, sans-serif`;
    g.fillText(text, s / 2, s * 0.46);
  });
}
/** Comic speech bubble with text. Returns { tex, aspect }. Small LRU so changing text doesn't leak. */
const speechCache = new Map();
export function speechTexture(text) {
  const hit = speechCache.get(text);
  if (hit) { speechCache.delete(text); speechCache.set(text, hit); return hit; }
  const font = '700 30px ui-rounded, "SF Pro Rounded", -apple-system, sans-serif';
  const m = document.createElement('canvas').getContext('2d');
  m.font = font;
  const tw = Math.min(560, Math.ceil(m.measureText(text).width));
  const w = tw + 44, h = 76, r = 24, tail = 14;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255, 252, 246, 0.96)';
  g.beginPath();
  g.roundRect(2, 2, w - 4, h - tail - 4, r);
  g.moveTo(w / 2 - 12, h - tail - 3); g.lineTo(w / 2, h - 2); g.lineTo(w / 2 + 12, h - tail - 3);
  g.fill();
  g.fillStyle = '#3b3552';
  g.font = font;
  g.textBaseline = 'middle';
  let t = text;
  while (g.measureText(t).width > tw && t.length > 2) t = t.slice(0, -2) + '…';
  g.fillText(t, 22, (h - tail) / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const out = { tex, aspect: w / h };
  speechCache.set(text, out);
  if (speechCache.size > 60) { const [k, v] = speechCache.entries().next().value; v.tex.dispose(); speechCache.delete(k); }
  return out;
}

/** A sprite with its own material (so it can fade independently) but a shared texture. */
export function sprite(tex, size = 0.2) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.setScalar(size);
  s.userData.size = size;
  return s;
}

// ── particle pool ────────────────────────────────────────────────────
export function makeFX(parent) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  for (let i = 0; i < MAX; i++) { mesh.setMatrixAt(i, ZERO); mesh.setColorAt(i, new THREE.Color(1, 1, 1)); }
  parent.add(mesh);

  const parts = []; // { i, pos, vel, rot, spin, life, max, size, grow, gravity, drag }
  const free = Array.from({ length: MAX }, (_, i) => MAX - 1 - i);
  const color = new THREE.Color();
  let dirty = false;

  function emit(pos, vel, { size = 0.03, life = 1, col = '#fff', grow = 0, gravity = 2.2, drag = 0.4 } = {}) {
    const i = free.pop();
    if (i === undefined) return;
    mesh.setColorAt(i, color.set(col));
    mesh.instanceColor.needsUpdate = true;
    parts.push({
      i, pos: pos.clone(), vel: vel.clone(),
      rot: new THREE.Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6),
      spin: new THREE.Vector3((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12),
      life: 0, max: life * (0.75 + Math.random() * 0.5), size, grow, gravity, drag,
    });
  }

  // Random tangent vector at a surface normal
  function tangent(n) {
    tmpV.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
    return tmpV.projectOnPlane(n).normalize().clone();
  }

  // Sprites that float up and fade (hearts, ✓, sparkles)
  const floaters = [];

  const api = {
    get busy() { return parts.length > 0 || floaters.length > 0; },
    confetti(pos, n, count = 26) {
      for (let k = 0; k < count; k++) {
        const v = n.clone().multiplyScalar(1.1 + Math.random() * 0.9).addScaledVector(tangent(n), 0.4 + Math.random() * 0.6);
        emit(pos.clone().addScaledVector(n, 0.45), v, { size: 0.028, life: 1.7, col: CONFETTI[k % CONFETTI.length], gravity: 2.4, drag: 0.6 });
      }
    },
    puff(pos, n, count = 10) {
      for (let k = 0; k < count; k++) {
        const t = tangent(n);
        emit(pos.clone().addScaledVector(n, 0.03).addScaledVector(t, 0.08), t.multiplyScalar(0.35 + Math.random() * 0.25).addScaledVector(n, 0.12),
          { size: 0.035, life: 0.7, col: '#f6f1ea', grow: 0.09, gravity: 0, drag: 2.2 });
      }
    },
    sparks(pos, n, count = 5) {
      for (let k = 0; k < count; k++) {
        emit(pos, n.clone().multiplyScalar(0.6 + Math.random() * 0.6).addScaledVector(tangent(n), 0.6),
          { size: 0.014, life: 0.35, col: k % 2 ? '#ffe28a' : '#ffffff', gravity: 3, drag: 0.2 });
      }
    },
    embers(pos, n) {
      emit(pos, n.clone().multiplyScalar(0.25 + Math.random() * 0.2).addScaledVector(tangent(n), 0.08),
        { size: 0.012, life: 1.1, col: Math.random() < 0.5 ? '#ffb347' : '#ff7a45', gravity: -0.15, drag: 0.3 });
    },
    smoke(pos, n) {
      emit(pos, n.clone().multiplyScalar(0.1).addScaledVector(tangent(n), 0.03),
        { size: 0.025, life: 1.8, col: '#ebe7f3', grow: 0.07, gravity: -0.05, drag: 0.6 });
    },
    float(tex, pos, n, { size = 0.16, rise = 0.45, life = 1.1 } = {}) {
      const s = sprite(tex, size);
      s.position.copy(pos);
      parent.add(s);
      floaters.push({ s, from: pos.clone(), n: n.clone(), life: 0, max: life, rise, size, drift: tangent(n).multiplyScalar(0.12) });
    },
    update(dt) {
      for (let k = parts.length - 1; k >= 0; k--) {
        const p = parts[k];
        p.life += dt;
        if (p.life >= p.max) {
          mesh.setMatrixAt(p.i, ZERO);
          free.push(p.i);
          parts.splice(k, 1);
          dirty = true;
          continue;
        }
        // gravity pulls toward the planet's center
        tmpV.copy(p.pos).normalize();
        p.vel.addScaledVector(tmpV, -p.gravity * dt);
        p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
        p.pos.addScaledVector(p.vel, dt);
        p.rot.addScaledVector(p.spin, dt);
        const k01 = p.life / p.max;
        const s = (p.size + p.grow * k01) * (k01 > 0.7 ? 1 - (k01 - 0.7) / 0.3 : 1);
        tmpM.compose(p.pos, tmpQ.setFromEuler(tmpE.set(p.rot.x, p.rot.y, p.rot.z)), tmpS.setScalar(Math.max(0.0001, s)));
        mesh.setMatrixAt(p.i, tmpM);
        dirty = true;
      }
      if (dirty) { mesh.instanceMatrix.needsUpdate = true; dirty = parts.length > 0; }

      for (let k = floaters.length - 1; k >= 0; k--) {
        const f = floaters[k];
        f.life += dt;
        const u = f.life / f.max;
        if (u >= 1) { parent.remove(f.s); f.s.material.dispose(); floaters.splice(k, 1); continue; }
        f.s.position.copy(f.from).addScaledVector(f.n, f.rise * (1 - (1 - u) * (1 - u))).addScaledVector(f.drift, u);
        f.s.material.opacity = u < 0.15 ? u / 0.15 : 1 - Math.max(0, (u - 0.6) / 0.4);
        f.s.scale.setScalar(f.size * (u < 0.15 ? 0.6 + (u / 0.15) * 0.4 : 1));
      }
    },
  };
  return api;
}
