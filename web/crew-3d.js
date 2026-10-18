// Crew manager 3D bits: a live preview of one project's astronaut, and a small globe for picking its spot.
// Both share one render loop that only runs while the window is visible.
import * as THREE from 'three';
import { Astronaut, hashStr } from './astronaut.js';
import { createLandmarks } from './landmarks.js';
import { height, groundR, offsetDir, makeRand, surfaceQuat, R, WATER } from './world.js';

const UP = new THREE.Vector3(0, 1, 0);
const FX = { confetti() {}, sparks() {}, puff() {}, smoke() {} };

function makeRenderer(el) {
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.setClearColor(0x000000, 0);
  el.appendChild(r.domElement);
  return r;
}
function lights(scene) {
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x7d70b8, 1.35));
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.0); sun.position.set(2, 3, 3); scene.add(sun);
}
const views = [];
function fit(v) {
  const w = v.el.clientWidth, h = v.el.clientHeight;
  if (!w || !h || (w === v.w && h === v.h)) return;
  v.w = w; v.h = h;
  v.renderer.setSize(w, h, false);
  v.renderer.domElement.style.width = w + 'px'; v.renderer.domElement.style.height = h + 'px';
  v.camera.aspect = w / h; v.camera.updateProjectionMatrix();
}
let last = performance.now();
function frame(now = performance.now()) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  const t = now / 1000;
  for (const v of views) { if (!v.el.clientWidth) continue; fit(v); v.tick?.(t, dt); v.renderer.render(v.scene, v.camera); v.after?.(); }
}
function loop(now) { frame(now); requestAnimationFrame(loop); }
requestAnimationFrame(loop);
/** Render every view once (rAF doesn't run in hidden windows; handy for tests). */
export const renderOnce = () => frame();

// ── astronaut preview ───────────────────────────────────────────────
const accentMats = new Map();
const accentMat = (c) => accentMats.get(c) ?? accentMats.set(c, new THREE.MeshLambertMaterial({ color: c })).get(c);

export function createPreview(el) {
  const renderer = makeRenderer(el);
  const scene = new THREE.Scene();
  lights(scene);
  const camera = new THREE.PerspectiveCamera(26, 1, 0.01, 50);
  const FOCUS = new THREE.Vector3(0.03, 0.27, 0);
  camera.position.set(0.03, 0.62, 2.25); camera.lookAt(FOCUS);

  // a little floating island to stand on: the astronaut on the left, its landmark on the right
  const island = new THREE.Group();
  const grass = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.33, 0.06, 32), new THREE.MeshLambertMaterial({ color: '#a6d98f', flatShading: true }));
  grass.position.y = -0.03;
  const dirt = new THREE.Mesh(new THREE.ConeGeometry(0.33, 0.26, 11), new THREE.MeshLambertMaterial({ color: '#c49a6c', flatShading: true }));
  dirt.rotation.x = Math.PI; dirt.position.y = -0.19;
  island.add(grass, dirt);
  island.scale.set(1.55, 1, 1.05);
  for (const [x, z, c] of [[-0.42, 0.12, '#ff9aa8'], [0.05, 0.22, '#fff1a8'], [0.42, -0.16, '#c9b5f5'], [-0.2, -0.24, '#ffffff'], [0.48, 0.12, '#ff9aa8']]) {
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.022, 0), new THREE.MeshLambertMaterial({ color: c, flatShading: true }));
    b.position.set(x, 0.02, z); scene.add(b);
  }
  scene.add(island);
  const world = new THREE.Group(); scene.add(world);
  const AX = -0.2; // astronaut x

  // landmark: landmarks.js builds it on the planet's surface; undo that placement so it stands upright here
  const lmSlot = new THREE.Group(); lmSlot.position.set(0.26, 0, -0.06); lmSlot.rotation.y = -0.35; lmSlot.scale.setScalar(1.3);
  const lmWorld = new THREE.Group(); lmSlot.add(lmWorld); scene.add(lmSlot);
  const marks = createLandmarks({ world: lmWorld, fx: FX });
  const LM_KEY = 'crew-preview';
  let lmSig = '';
  function placeLandmark() {
    const e = marks.marks.get(LM_KEY);
    if (!e) return;
    const q = e.g.quaternion.clone().invert();
    lmWorld.quaternion.copy(q);
    lmWorld.position.copy(e.g.position).applyQuaternion(q).negate();
  }

  let a = null, look = {}, hopT = -1, spin = 0, dragX = null;
  el.addEventListener('pointerdown', (e) => { dragX = e.clientX; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', (e) => { if (dragX == null) return; spin += (e.clientX - dragX) * 0.012; dragX = e.clientX; });
  el.addEventListener('pointerup', () => { dragX = null; });
  el.addEventListener('dblclick', () => { hopT = 0; marks.pulse(look.name); });

  /** theme is shown through landmarks.themeOf(name), which reads colors.setCustom — keep that store current. */
  function setLook({ key, name, color, hat, theme }) {
    if (!a || look.key !== key) {
      if (a) a.dispose();
      a = new Astronaut({ id: 'preview', name, status: 'idle', tool: '', subagents: [], since: Date.now(), updated: Date.now() },
        { world, fx: FX, campDir: UP, campRadius: 0.1, seatDir: () => null }, UP.clone());
      a.root.position.set(AX, 0, 0.04); a.root.quaternion.identity(); a.root.scale.setScalar(1);
      look = {};
    } else if (look.color !== color || look.hat !== hat || look.theme !== theme) hopT = 0; // a happy hop when the look changes
    if (look.color !== color || look.hat !== hat) {
      a.accent = color;
      const m = accentMat(color);
      for (const mesh of a.accentMeshes) mesh.material = m;
      a.bulbMat.color.set(color);
      a.setHat(hat); // uses a.accent for its colour
    }
    const sig = `${name}|${color}|${theme}`;
    if (sig !== lmSig) {
      lmSig = sig;
      marks.update([{ key: LM_KEY, name, dir: UP.clone(), level: 2, color }]);
      placeLandmark();
    }
    look = { key, name, color, hat, theme };
  }

  const tick = (t, dt) => {
    marks.tick(t, dt);
    if (!a) return;
    const cyc = t % 6;
    const waving = cyc < 2.2;
    a.armR.rotation.set(0, 0, waving ? 2.45 + Math.sin(t * 11) * 0.4 : 0.25 + Math.sin(t * 1.3) * 0.04);
    a.armL.rotation.set(0, 0, -0.25 - Math.sin(t * 1.3) * 0.04);
    a.legL.rotation.set(0, 0, 0); a.legR.rotation.set(0, 0, 0);
    a.head.rotation.set(-0.08 + Math.sin(t * 0.9) * 0.04, waving ? 0.15 : Math.sin(t * 0.6) * 0.2, waving ? Math.sin(t * 5.5) * 0.06 : 0);
    let y = Math.sin(t * 2.2) * 0.005;
    if (hopT >= 0) { hopT += dt; const k = hopT / 0.5; y += Math.sin(Math.min(1, k) * Math.PI) * 0.09; if (k >= 1) hopT = -1; }
    a.body.position.y = y;
    const blink = (t % 3.7) < 0.12 ? 0.15 : 1.28;
    a.eyes[0].scale.y = a.eyes[1].scale.y = blink;
    if (a.hat?.userData.spin) a.hat.userData.spin.rotation.y = t * 9;
    if (dragX == null) spin *= Math.exp(-dt * 1.5);
    a.root.rotation.y = 0.45 + Math.sin(t * 0.45) * 0.35 + spin;
  };
  views.push({ el, renderer, scene, camera, tick });
  return { setLook };
}

// ── spot globe ──────────────────────────────────────────────────────
// Same camp as the planet (world.js picks it with makeRand(7), before using `rand` for anything else).
export const CAMP_RADIUS = 0.62;
export const campDir = (() => {
  const rand = makeRand(7);
  const randomDir = () => new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
  let d0 = new THREE.Vector3(0.3, 0.8, 0.5).normalize(), best = -1;
  for (let i = 0; i < 160; i++) {
    const d = i === 0 ? d0.clone() : randomDir();
    if (Math.abs(d.y) > 0.85) continue;
    let lo = Infinity;
    for (let k = 0; k < 10; k++) for (const ang of [0, 0.2, 0.36]) lo = Math.min(lo, height(offsetDir(d, (k / 10) * Math.PI * 2, ang)));
    if (lo > best) { best = lo; d0 = d; }
  }
  return d0;
})();

const dryAt = (d) => {
  if (height(d) < WATER + 0.035) return false;
  for (let k = 0; k < 6; k++) if (height(offsetDir(d, (k / 6) * Math.PI * 2, 0.07)) < WATER + 0.02) return false;
  return true;
};
/** Nearest dry, flat-ish land to `d` (within ~0.3 rad), out of the camp clearing — like village.js does. */
export function snapToLand(d) {
  let best = null, bestCost = Infinity;
  const consider = (x) => {
    if (!dryAt(x)) return;
    const cost = x.angleTo(d) + (x.angleTo(campDir) > CAMP_RADIUS + 0.12 ? 0 : 1);
    if (cost < bestCost) { bestCost = cost; best = x.clone(); }
  };
  consider(d);
  if (best && bestCost < 0.001) return best;
  for (let r = 0.025; r <= 0.30001; r += 0.025) for (let k = 0, n = Math.round(6 + r * 60); k < n; k++) consider(offsetDir(d, (k / n) * Math.PI * 2, r));
  return best ?? d.clone();
}

/**
 * Approximate where the planet puts homes that weren't placed by hand: village.js's plotDir, run in the
 * same order (biggest first). The real planet also remembers older placements, so this is a best guess.
 */
export function autoSpots(list /* [{ key, spot? }] biggest first */) {
  const taken = list.filter((p) => p.spot).map((p) => new THREE.Vector3(...p.spot).normalize());
  const out = new Map();
  for (const p of list) {
    if (p.spot) continue;
    const rand = makeRand((hashStr(p.key) % 2147483646) + 1);
    let best = null, bestScore = -1;
    for (let i = 0; i < 90; i++) {
      const d = offsetDir(campDir, rand() * Math.PI * 2, CAMP_RADIUS + 0.3 + rand() * 2.1);
      if (!dryAt(d)) continue;
      const score = Math.min(d.angleTo(campDir) - CAMP_RADIUS * 0.6, ...taken.map((t) => t.angleTo(d)));
      if (score > bestScore) { bestScore = score; best = d; }
    }
    best ??= offsetDir(campDir, rand() * Math.PI * 2, CAMP_RADIUS + 0.3 + rand() * 0.8);
    taken.push(best);
    out.set(p.key, best);
  }
  return out;
}

function terrain() {
  const geo = new THREE.IcosahedronGeometry(R, 6);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).normalize(); v.multiplyScalar(R + height(v)); pos.setXYZ(i, v.x, v.y, v.z); }
  const colors = new Float32Array(pos.count * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), col = new THREE.Color();
  const sand = new THREE.Color('#f4e2b8'), grass = new THREE.Color('#a6d98f'), grass2 = new THREE.Color('#8bcc7f'), hill = new THREE.Color('#c3e6a4'), peak = new THREE.Color('#f6f1ea');
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    const h = (a.length() + b.length() + c.length()) / 3 - R;
    if (h < WATER + 0.035) col.copy(sand);
    else if (h < 0.07) col.copy(grass).lerp(grass2, (Math.sin(i * 12.9898) * 0.5 + 0.5) * 0.6);
    else if (h < 0.14) col.copy(hill);
    else col.copy(peak);
    for (let k = 0; k < 3; k++) col.toArray(colors, (i + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
}

/**
 * opts.onPlace(dir: THREE.Vector3) — the user clicked / dropped the selected pin there (already snapped to land).
 * Pins: setPins([{ key, name, color, dir, manual, selected }]).
 */
export function createGlobe(el, labelsEl, { onPlace }) {
  const renderer = makeRenderer(el);
  const scene = new THREE.Scene();
  lights(scene);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0, 13.8); camera.lookAt(0, 0, 0);
  const world = new THREE.Group(); scene.add(world);
  const land = terrain();
  const water = new THREE.Mesh(new THREE.IcosahedronGeometry(R + WATER, 5), new THREE.MeshLambertMaterial({ color: '#8fd5e6', flatShading: true, transparent: true, opacity: 0.88 }));
  world.add(land, water);
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.12, 40, 40), new THREE.ShaderMaterial({
    transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
    uniforms: { color: { value: new THREE.Color('#b7d6ff') } },
    vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }',
    fragmentShader: 'uniform vec3 color; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1. - abs(dot(vN, vV)), 2.2); gl_FragColor = vec4(color, f * 0.55); }',
  }));
  scene.add(atmo);
  // the camp: a little fire ring, so you can tell where the crew hangs out
  const camp = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.025, 5, 12), new THREE.MeshLambertMaterial({ color: '#b9b3cc', flatShading: true }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.02;
  const fire = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 6), new THREE.MeshBasicMaterial({ color: '#ffb347' }));
  fire.position.y = 0.08;
  camp.add(ring, fire);
  camp.position.copy(campDir).multiplyScalar(groundR(campDir)); camp.quaternion.copy(surfaceQuat(campDir));
  world.add(camp);

  // start looking at the camp, slightly from above
  const VIEW = new THREE.Vector3(0, 0.35, 1).normalize();
  world.quaternion.setFromUnitVectors(campDir, VIEW);
  let targetQ = null;

  // pins
  const stickGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.34, 6); stickGeo.translate(0, 0.17, 0);
  const headGeo = new THREE.SphereGeometry(0.075, 16, 12);
  const haloGeo = new THREE.RingGeometry(0.11, 0.15, 28);
  const stickMat = new THREE.MeshLambertMaterial({ color: '#fdfbf7' });
  const pinMats = new Map();
  const pinMat = (c, ghost) => {
    const k = c + (ghost ? '~' : '');
    if (!pinMats.has(k)) pinMats.set(k, new THREE.MeshLambertMaterial({ color: c, transparent: ghost, opacity: ghost ? 0.55 : 1 }));
    return pinMats.get(k);
  };
  const haloMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false });
  const pins = new Map(); // key → { g, head, data, label }
  let selected = null;

  function setPins(list) {
    const keep = new Set(list.map((p) => p.key));
    for (const [k, p] of pins) if (!keep.has(k)) { world.remove(p.g); p.label.remove(); pins.delete(k); }
    for (const d of list) {
      let p = pins.get(d.key);
      if (!p) {
        const g = new THREE.Group();
        const stick = new THREE.Mesh(stickGeo, stickMat);
        const head = new THREE.Mesh(headGeo, pinMat(d.color, !d.manual)); head.position.y = 0.37;
        const halo = new THREE.Mesh(haloGeo, haloMat); halo.rotation.x = -Math.PI / 2; halo.position.y = 0.012; halo.visible = false;
        g.add(stick, head, halo);
        const label = document.createElement('div'); label.className = 'pin-label';
        labelsEl.appendChild(label);
        p = { g, head, halo, label, data: d };
        world.add(g); pins.set(d.key, p);
      }
      p.data = d;
      p.head.material = pinMat(d.color, !d.manual);
      p.halo.visible = !!d.selected;
      p.g.scale.setScalar(d.selected ? 1.45 : 1);
      p.g.position.copy(d.dir).multiplyScalar(groundR(d.dir));
      p.g.quaternion.copy(surfaceQuat(d.dir));
      p.label.textContent = d.name;
      p.label.style.setProperty('--c', d.color);
      p.label.classList.toggle('sel', !!d.selected);
      if (d.selected) selected = p;
    }
    if (!list.some((d) => d.selected)) selected = null;
  }

  /** Turn the globe so `dir` faces you. */
  function focus(dir) {
    if (!dir) return;
    const cur = dir.clone().applyQuaternion(world.quaternion);
    targetQ = new THREE.Quaternion().setFromUnitVectors(cur.normalize(), VIEW).multiply(world.quaternion);
  }

  // ── interaction: drag to turn, click to place, drag the selected pin to move it ──
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function surfaceAt(e) {
    const r = el.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([land, water], false)[0];
    return hit ? world.worldToLocal(hit.point.clone()).normalize() : null;
  }
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    const d = surfaceAt(e);
    const onPin = selected && d && d.angleTo(selected.data.dir) < 0.14;
    drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, pin: onPin, moved: false };
    el.setPointerCapture(e.pointerId);
    targetQ = null;
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) { // hover cursor
      const d = surfaceAt(e);
      el.style.cursor = selected && d && d.angleTo(selected.data.dir) < 0.14 ? 'grab' : d ? 'crosshair' : 'default';
      return;
    }
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) drag.moved = true;
    if (drag.pin) {
      const d = surfaceAt(e);
      if (d) { selected.data.dir = d; selected.g.position.copy(d).multiplyScalar(groundR(d)); selected.g.quaternion.copy(surfaceQuat(d)); }
      el.style.cursor = 'grabbing';
    } else {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      const k = 0.006;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx * k)
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy * k));
      world.quaternion.premultiply(q);
    }
    drag.x = e.clientX; drag.y = e.clientY;
  });
  el.addEventListener('pointerup', (e) => {
    const d = drag; drag = null;
    if (!d) return;
    if (d.pin && d.moved && selected) onPlace(snapToLand(selected.data.dir));
    else if (!d.moved) { const s = surfaceAt(e); if (s) onPlace(snapToLand(s)); }
  });

  const tmp = new THREE.Vector3();
  const after = () => {
    // DOM labels: selected always (when facing us), others only on the near side, small
    const w = el.clientWidth, h = el.clientHeight;
    for (const p of pins.values()) {
      p.head.getWorldPosition(tmp);
      const facing = tmp.clone().normalize().dot(camera.position.clone().normalize());
      tmp.project(camera);
      const show = facing > 0.25;
      p.label.style.display = show ? '' : 'none';
      if (show) p.label.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px) translate(-50%, -150%)`;
      p.label.style.opacity = p.data.selected ? 1 : Math.min(0.85, (facing - 0.25) * 3);
    }
  };
  const tick = (t, dt) => {
    if (targetQ) { world.quaternion.slerp(targetQ, 1 - Math.exp(-dt * 6)); if (world.quaternion.angleTo(targetQ) < 0.002) targetQ = null; }
    fire.scale.y = 1 + Math.sin(t * 13) * 0.15;
    if (selected) selected.halo.scale.setScalar(1 + Math.sin(t * 4) * 0.12);
  };
  views.push({ el, renderer, scene, camera, tick, after });
  return { setPins, focus };
}
