// Landmarks: one themed building per project continent, standing next to its house.
// Static parts are baked into one vertex-coloured mesh per landmark; only the moving bits
// (lighthouse lamp + beam, windmill blades, server LEDs, …) are separate. No lights, no per-frame allocations.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { piece, at, groundR, height, offsetDir, surfaceQuat, WATER } from './world.js';

const plotKey = (name) => String(name ?? '').trim().toLowerCase();

/** Which landmark a project gets. Order matters: the specific themes win over "looks like code". */
export function themeOf(name, key = '') {
  const n = String(name ?? '').toLowerCase();
  if (/outreach|crm|rhythm|leads?\b/.test(n)) return 'lighthouse';
  if (/proposal|quote|offerte/.test(n)) return 'printshop';
  if (/factur|financ|invoice|admin/.test(n)) return 'vault';
  if (/\/documents\/code\//i.test(String(key))) return 'server';
  const raw = String(name ?? '').trim();
  // no spaces + a separator or camelCase (bot-planet, my_app, fooBar) or a dev-ish word
  if ((!/\s/.test(raw) && /[-_.]|[a-z][A-Z]/.test(raw)) || /\b(app|api|bot|cli|sdk|mcp|server|plugin|code|dev|repo|site|web)\b/.test(n)) return 'server';
  return 'windmill';
}

// ── shared geometry & materials ──────────────────────────────────────
const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl8: new THREE.CylinderGeometry(1, 1, 1, 8),
  cyl12: new THREE.CylinderGeometry(1, 1, 1, 12),
  cone4: new THREE.ConeGeometry(1, 1, 4, 1),
  cone8: new THREE.ConeGeometry(1, 1, 8, 1),
  prism: new THREE.CylinderGeometry(1, 1, 1, 3),
  rock: new THREE.DodecahedronGeometry(1, 0),
  ball: new THREE.IcosahedronGeometry(1, 1),
};
const S = (x, y, z) => new THREE.Vector3(x, y, z);
const taper = new Map();
/** Cached tapered cylinder (top radius / bottom radius ratio), unit height. */
function taperGeo(ratio, seg = 8) {
  const k = `${ratio}:${seg}`;
  if (!taper.has(k)) taper.set(k, new THREE.CylinderGeometry(ratio, 1, 1, seg));
  return taper.get(k);
}

const staticMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
const lampMat = new THREE.MeshBasicMaterial({ color: '#fff1a8' });
const beamMat = new THREE.MeshBasicMaterial({
  color: '#fff3b0', transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
});
const paperMat = new THREE.MeshLambertMaterial({ color: '#ffffff', side: THREE.DoubleSide, flatShading: true });
const goldMat = new THREE.MeshLambertMaterial({ color: '#f5c542', flatShading: true });
const bladeMat = new THREE.MeshLambertMaterial({ color: '#fff6e8', flatShading: true });
const darkMat = new THREE.MeshLambertMaterial({ color: '#6d6688', flatShading: true });
const ledMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });

const BEAM_LEN = 0.55;
const beamGeo = (() => {
  const g = new THREE.ConeGeometry(0.075, BEAM_LEN, 10, 1, true);
  g.translate(0, -BEAM_LEN / 2, 0); // tip at the origin
  g.rotateZ(Math.PI / 2);           // open toward +x
  return g;
})();
const planeGeo = (() => {
  // a folded paper plane, nose along +z
  const v = [
    0, 0, 0.05, -0.032, 0.004, -0.03, 0, 0, -0.022,
    0, 0, 0.05, 0, 0, -0.022, 0.032, 0.004, -0.03,
    0, 0, 0.05, 0, 0, -0.022, 0, -0.014, -0.026,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
})();
const sheetGeo = new THREE.PlaneGeometry(0.045, 0.06);
const coinGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.006, 10).rotateX(Math.PI / 2);
const bigCoinGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.012, 14).rotateX(Math.PI / 2);
const ledGeo = new THREE.BoxGeometry(0.014, 0.008, 0.004);

const C = {
  white: '#fff8ef', cream: '#f6efe2', stone: '#cfc8dc', rock: '#b9b3cc', door: '#8a5a44', glass: '#bfe9ff',
  wood: '#b48a6a', slate: '#4b4766', slate2: '#5b5679', paper: '#ffffff', gold: '#f5c542',
};

// ── builders: each returns { pieces, beaconY, make(group, accent) → anim state } ──────────────
// Local space: y up from the ground, the door faces +z (toward the house).

function lighthouse(accent) {
  const p = [];
  p.push(piece(G.rock, C.rock, at(0.05, 0.01, -0.03, 0.4, 0.2, 0.1, S(0.1, 0.05, 0.09))));
  p.push(piece(G.rock, C.rock, at(-0.06, 0.005, 0.03, 0.1, 1.2, 0.3, S(0.07, 0.04, 0.07))));
  p.push(piece(G.cyl8, C.stone, at(0, 0.02, 0, 0, 0, 0, S(0.09, 0.05, 0.09))));
  p.push(piece(taperGeo(0.62), C.white, at(0, 0.22, 0, 0, 0, 0, S(0.07, 0.36, 0.07))));
  for (const y of [0.13, 0.27]) p.push(piece(taperGeo(0.9), accent, at(0, y, 0, 0, 0, 0, S(0.07 - y * 0.075, 0.055, 0.07 - y * 0.075))));
  p.push(piece(G.box, C.door, at(0, 0.075, 0.062, 0, 0, 0, S(0.03, 0.05, 0.006))));
  p.push(piece(G.box, C.glass, at(0, 0.2, 0.054, 0, 0, 0, S(0.016, 0.022, 0.005))));
  p.push(piece(G.cyl8, C.slate2, at(0, 0.405, 0, 0, 0, 0, S(0.065, 0.014, 0.065)))); // gallery
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    p.push(piece(G.box, C.slate2, at(Math.cos(a) * 0.04, 0.455, Math.sin(a) * 0.04, 0, -a, 0, S(0.006, 0.08, 0.006))));
  }
  p.push(piece(G.cone8, accent, at(0, 0.525, 0, 0, 0, 0, S(0.058, 0.07, 0.058))));
  p.push(piece(G.ball, accent, at(0, 0.565, 0, 0, 0, 0, 0.012)));
  return {
    pieces: p, beaconY: 0.455,
    make(g) {
      const lamp = new THREE.Mesh(G.ball, lampMat);
      lamp.scale.setScalar(0.026);
      lamp.position.y = 0.455;
      const beam = new THREE.Group();
      beam.position.y = 0.455;
      beam.add(new THREE.Mesh(beamGeo, beamMat));
      const back = new THREE.Mesh(beamGeo, beamMat);
      back.rotation.y = Math.PI;
      beam.add(back);
      const planes = [0, 1, 2].map(() => {
        const m = new THREE.Mesh(planeGeo, paperMat);
        m.visible = false;
        g.add(m);
        return m;
      });
      g.add(lamp, beam);
      return { lamp, beam, planes, flash: 0, fly: -1, spin: 0 };
    },
  };
}

function printshop(accent) {
  const p = [];
  const W = 0.22, H = 0.16, D = 0.17;
  p.push(piece(G.box, C.stone, at(0, 0.01, 0, 0, 0, 0, S(W + 0.03, 0.03, D + 0.03))));
  p.push(piece(G.box, C.cream, at(0, H / 2 + 0.02, 0, 0, 0, 0, S(W, H, D))));
  // twin-gable workshop roof (prism: rotated −90° about x → apex up, ridge front-to-back)
  for (const x of [-W / 4, W / 4]) p.push(piece(G.prism, accent, at(x, H + 0.02 + 0.04, 0, -Math.PI / 2, 0, 0, S(W / 4 / 0.87 + 0.005, D + 0.012, 0.08))));
  p.push(piece(G.box, C.door, at(-0.05, 0.06, D / 2 + 0.003, 0, 0, 0, S(0.04, 0.07, 0.006))));
  p.push(piece(G.box, C.glass, at(0.05, 0.11, D / 2 + 0.003, 0, 0, 0, S(0.07, 0.05, 0.006))));
  // shop sign on a post, like a hanging print
  p.push(piece(G.box, C.wood, at(W / 2 + 0.04, 0.17, D / 2 - 0.02, 0, 0, 0, S(0.012, 0.34, 0.012))));
  p.push(piece(G.box, C.wood, at(W / 2 + 0.01, 0.33, D / 2 - 0.02, 0, 0, 0, S(0.07, 0.01, 0.01))));
  p.push(piece(G.box, accent, at(W / 2 + 0.0, 0.29, D / 2 - 0.02, 0, 0, 0, S(0.06, 0.06, 0.008))));
  p.push(piece(G.box, C.paper, at(W / 2 + 0.0, 0.29, D / 2 - 0.014, 0, 0, 0, S(0.036, 0.04, 0.004))));
  // tall press chimney + paper stacks out front
  p.push(piece(G.box, C.stone, at(-W / 2 + 0.04, H + 0.12, -D / 4, 0, 0, 0, S(0.045, 0.2, 0.045))));
  p.push(piece(G.box, accent, at(-W / 2 + 0.04, H + 0.225, -D / 4, 0, 0, 0, S(0.055, 0.015, 0.055))));
  for (let k = 0; k < 4; k++) p.push(piece(G.box, k % 2 ? '#f3efe6' : C.paper, at(-W / 2 - 0.035, 0.012 + k * 0.012, D / 4, 0, k * 0.15, 0, S(0.045, 0.011, 0.06))));
  return {
    pieces: p, beaconY: H + 0.24, beaconX: -W / 2 + 0.04, beaconZ: -D / 4,
    make(g) {
      // the press roller turning above the door
      const roller = new THREE.Mesh(G.cyl8, darkMat);
      roller.scale.set(0.022, 0.12, 0.022);
      roller.rotation.z = Math.PI / 2;
      roller.position.set(0, H + 0.005, D / 2 + 0.02);
      g.add(roller);
      const sheets = Array.from({ length: 6 }, () => {
        const m = new THREE.Mesh(sheetGeo, paperMat);
        m.visible = false;
        g.add(m);
        return m;
      });
      return { roller, sheets, fly: -1, speed: 0 };
    },
  };
}

function server(accent) {
  const p = [];
  const towers = [[-0.085, 0.3], [0, 0.44], [0.085, 0.36]];
  p.push(piece(G.box, C.stone, at(0, 0.012, 0, 0, 0, 0, S(0.29, 0.03, 0.14))));
  for (const [x, h] of towers) {
    p.push(piece(G.box, C.slate, at(x, h / 2 + 0.02, 0, 0, 0, 0, S(0.072, h, 0.1))));
    p.push(piece(G.box, accent, at(x, h + 0.028, 0, 0, 0, 0, S(0.078, 0.016, 0.106))));
    // vent slats
    for (let y = 0.05; y < h - 0.02; y += 0.05) p.push(piece(G.box, C.slate2, at(x, y + 0.02, 0.051, 0, 0, 0, S(0.06, 0.006, 0.003))));
  }
  // antenna on the tall one
  p.push(piece(G.box, C.stone, at(0, 0.53, 0, 0, 0, 0, S(0.008, 0.14, 0.008))));
  p.push(piece(G.box, C.stone, at(0, 0.56, 0, 0, 0, 0, S(0.05, 0.006, 0.006))));
  // cables to the ground
  p.push(piece(G.box, C.slate2, at(0.145, 0.025, 0.02, 0, 0, 0, S(0.02, 0.012, 0.012))));
  return {
    pieces: p, beaconY: 0.61,
    make(g) {
      const leds = [];
      for (const [x, h] of towers) for (let y = 0.075; y < h - 0.01; y += 0.05) for (const dx of [-0.02, 0.02]) leds.push([x + dx, y + 0.02]);
      const mesh = new THREE.InstancedMesh(ledGeo, ledMat, leds.length);
      const m = new THREE.Matrix4();
      leds.forEach(([x, y], i) => {
        mesh.setMatrixAt(i, m.makeTranslation(x, y, 0.053));
        mesh.setColorAt(i, new THREE.Color(C.slate2));
      });
      mesh.instanceMatrix.needsUpdate = true;
      g.add(mesh);
      const tip = new THREE.Mesh(G.ball, lampMat);
      tip.scale.setScalar(0.014);
      tip.position.y = 0.61;
      g.add(tip);
      return { mesh, tip, ys: leds.map(([, y]) => y), n: leds.length, race: 0, step: -1, accent: new THREE.Color(accent) };
    },
  };
}

function vault(accent) {
  const p = [];
  const W = 0.24, D = 0.18;
  p.push(piece(G.box, C.stone, at(0, 0.012, 0.01, 0, 0, 0, S(W + 0.05, 0.024, D + 0.06))));
  p.push(piece(G.box, C.stone, at(0, 0.03, 0.005, 0, 0, 0, S(W + 0.02, 0.016, D + 0.03))));
  p.push(piece(G.box, C.cream, at(0, 0.13, -0.02, 0, 0, 0, S(W - 0.03, 0.18, D - 0.05))));
  for (let k = 0; k < 4; k++) {
    const x = -W / 2 + 0.025 + (k / 3) * (W - 0.05);
    p.push(piece(G.cyl8, C.white, at(x, 0.13, D / 2 - 0.02, 0, 0, 0, S(0.014, 0.18, 0.014))));
  }
  p.push(piece(G.box, accent, at(0, 0.23, 0, 0, 0, 0, S(W + 0.01, 0.025, D + 0.01))));
  // pediment: a triangular prism, ridge front-to-back so the triangle faces the door
  p.push(piece(G.prism, C.white, at(0, 0.2425 + 0.035, 0, -Math.PI / 2, 0, 0, S((W + 0.01) / 2 / 0.87, D + 0.01, 0.07))));
  p.push(piece(G.box, accent, at(0, 0.258, D / 2 + 0.004, 0, 0, 0, S(0.04, 0.02, 0.004))));
  // round vault door
  p.push(piece(G.cyl12, '#c9c6d8', at(0, 0.12, D / 2 - 0.04, Math.PI / 2, 0, 0, S(0.05, 0.012, 0.05))));
  p.push(piece(G.cyl12, C.gold, at(0, 0.12, D / 2 - 0.032, Math.PI / 2, 0, 0, S(0.012, 0.006, 0.012))));
  // coin pole on the roof
  p.push(piece(G.box, C.stone, at(0, 0.36, 0, 0, 0, 0, S(0.01, 0.12, 0.01))));
  return {
    pieces: p, beaconY: 0.47,
    make(g) {
      const coin = new THREE.Mesh(bigCoinGeo, goldMat);
      coin.position.y = 0.47;
      g.add(coin);
      const coins = Array.from({ length: 8 }, () => {
        const m = new THREE.Mesh(coinGeo, goldMat);
        m.visible = false;
        g.add(m);
        return m;
      });
      return { coin, coins, fly: -1, spin: 0 };
    },
  };
}

function windmill(accent) {
  const p = [];
  p.push(piece(G.cyl8, C.stone, at(0, 0.015, 0, 0, 0, 0, S(0.1, 0.04, 0.1))));
  p.push(piece(taperGeo(0.62), C.cream, at(0, 0.2, 0, 0, 0, 0, S(0.085, 0.34, 0.085))));
  p.push(piece(taperGeo(0.9), accent, at(0, 0.09, 0, 0, 0, 0, S(0.083, 0.02, 0.083))));
  p.push(piece(G.cone8, accent, at(0, 0.42, 0, 0, 0, 0, S(0.07, 0.12, 0.07))));
  p.push(piece(G.box, C.door, at(0, 0.06, 0.082, 0, 0, 0, S(0.035, 0.06, 0.006))));
  p.push(piece(G.box, C.glass, at(0, 0.23, 0.064, 0, 0, 0, S(0.02, 0.025, 0.005))));
  p.push(piece(G.cyl8, C.wood, at(0, 0.37, 0.07, Math.PI / 2, 0, 0, S(0.012, 0.05, 0.012)))); // axle
  return {
    pieces: p, beaconY: 0.49,
    make(g) {
      const rotor = new THREE.Group();
      rotor.position.set(0, 0.37, 0.1);
      const hub = new THREE.Mesh(G.ball, darkMat);
      hub.scale.setScalar(0.018);
      rotor.add(hub);
      for (let k = 0; k < 4; k++) {
        const arm = new THREE.Group();
        arm.rotation.z = (k / 4) * Math.PI * 2;
        const spar = new THREE.Mesh(G.box, darkMat);
        spar.scale.set(0.008, 0.2, 0.006);
        spar.position.y = 0.1;
        const sail = new THREE.Mesh(G.box, bladeMat);
        sail.scale.set(0.045, 0.15, 0.004);
        sail.position.set(0.026, 0.12, 0);
        arm.add(spar, sail);
        rotor.add(arm);
      }
      g.add(rotor);
      return { rotor, boost: 0 };
    },
  };
}

const BUILDERS = { lighthouse, printshop, server, vault, windmill };

// ── the manager ──────────────────────────────────────────────────────
const sizeFor = (level) => 0.85 + Math.min(7, Math.max(0, level || 0)) * 0.035;

export function createLandmarks({ world, fx }) {
  const group = new THREE.Group();
  world.add(group);
  /** key → entry */
  const marks = new Map();
  /** plotKey(name) → entry */
  const byName = new Map();

  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3();
  const qTmp = new THREE.Quaternion();
  const Z = new THREE.Vector3(0, 0, 1);
  const col = new THREE.Color();
  const DIM = new THREE.Color(C.slate2), GREEN = new THREE.Color('#7dffb0'), WHITE = new THREE.Color('#ffffff');

  function siteFor(plot, others) {
    const seed = [...String(plot.key)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    const start = (seed % 360) * (Math.PI / 180);
    let fallback = null;
    for (let i = 0; i < 16; i++) {
      for (const ang of [0.13, 0.15, 0.11]) {
        const d = offsetDir(plot.dir, start + i * (Math.PI / 8), ang);
        if (height(d) <= WATER + 0.03) continue;
        // keep clear of other houses and landmarks
        if (others.some((o) => o.angleTo(d) < 0.1)) { fallback ??= d; continue; }
        // all four feet on land
        let dry = true;
        for (let k = 0; k < 4; k++) if (height(offsetDir(d, (k / 4) * Math.PI * 2, 0.035)) <= WATER + 0.01) { dry = false; break; }
        if (dry) return d;
        fallback ??= d;
      }
    }
    return fallback ?? offsetDir(plot.dir, start, 0.13);
  }

  function dispose(e) {
    group.remove(e.g);
    e.staticMesh.geometry.dispose();
    e.anim.mesh?.dispose?.();
  }

  function build(plot, theme, others) {
    const dir = siteFor(plot, others);
    const accent = plot.color || '#d97757';
    const def = BUILDERS[theme](accent);
    const g = new THREE.Group();
    // face the door toward the house
    const q = surfaceQuat(dir);
    const toHouse = plot.dir.clone().sub(dir).projectOnPlane(dir).normalize().applyQuaternion(q.clone().invert());
    const yaw = Math.atan2(toHouse.x, toHouse.z);
    g.position.copy(dir).multiplyScalar(groundR(dir) - 0.012);
    g.quaternion.copy(surfaceQuat(dir, yaw));
    const staticMesh = new THREE.Mesh(mergeGeometries(def.pieces), staticMat);
    g.add(staticMesh);
    const anim = def.make(g, accent);
    const size = sizeFor(plot.level);
    const beaconLocal = new THREE.Vector3(def.beaconX || 0, def.beaconY, def.beaconZ || 0);
    const e = {
      key: plot.key, name: plot.name, theme, dir, g, staticMesh, anim, size, grow: 0,
      beaconLocal, beacon: new THREE.Vector3(), sig: '',
    };
    g.scale.setScalar(0.001);
    group.add(g);
    return e;
  }

  function refreshBeacon(e) {
    e.g.updateMatrix();
    e.beacon.copy(e.beaconLocal).applyMatrix4(e.g.matrix);
  }

  // ── per-theme animation ──
  const ease = (u) => 1 - (1 - u) * (1 - u);

  function tickLighthouse(e, t, dt) {
    const a = e.anim;
    a.flash = Math.max(0, a.flash - dt * 1.4);
    a.spin = Math.max(0, a.spin - dt * 2);
    a.beam.rotation.y += dt * (0.9 + a.spin * 7);
    a.lamp.scale.setScalar(0.026 * (1 + a.flash * 0.9 + Math.sin(t * 3) * 0.06));
    if (a.fly >= 0) {
      a.fly += dt / 2.2;
      const u = Math.min(1, a.fly);
      for (let i = 0; i < 3; i++) {
        const m = a.planes[i];
        // quadratic arc from the gallery out and away from the house (−z), fanned out
        const th = Math.PI + (i - 1) * 0.7;
        v1.set(0, 0.455, 0);
        v3.set(Math.sin(th) * 0.9, 0.55 + i * 0.08, Math.cos(th) * 0.9);
        v2.set(v3.x * 0.4, 0.95 + i * 0.05, v3.z * 0.4);
        const k = Math.min(1, Math.max(0, u * 1.15 - i * 0.07));
        const s = 1 - k;
        m.position.set(0, 0, 0)
          .addScaledVector(v1, s * s).addScaledVector(v2, 2 * s * k).addScaledVector(v3, k * k);
        // heading = derivative of the curve
        v4.set(0, 0, 0).addScaledVector(v2, 2 * s).addScaledVector(v1, -2 * s).addScaledVector(v3, 2 * k).addScaledVector(v2, -2 * k).normalize();
        m.quaternion.setFromUnitVectors(Z, v4);
        m.rotateZ(Math.sin(t * 6 + i) * 0.25);
        m.scale.setScalar(1.6 * (k < 0.08 ? k / 0.08 : k > 0.7 ? Math.max(0.001, 1 - (k - 0.7) / 0.3) : 1) + 0.001);
        m.visible = k > 0 && k < 1;
      }
      if (a.fly >= 1) { a.fly = -1; for (const m of a.planes) m.visible = false; }
    }
  }
  let lhFlash = 0;

  function tickPrintshop(e, t, dt) {
    const a = e.anim;
    a.speed = Math.max(0, a.speed - dt * 2);
    a.roller.rotation.x += dt * (0.8 + a.speed * 10);
    if (a.fly >= 0) {
      a.fly += dt / 1.8;
      for (let i = 0; i < a.sheets.length; i++) {
        const m = a.sheets[i];
        const k = Math.min(1, Math.max(0, a.fly * 1.3 - i * 0.05));
        const th = (i / a.sheets.length) * Math.PI * 2 + 0.4;
        // pop out of the chimney, flutter down around the shop
        m.position.set(-0.07 + Math.sin(th) * k * 0.32, 0.4 + 0.35 * Math.sin(k * Math.PI) - k * 0.3, -0.04 + Math.cos(th) * k * 0.32);
        m.rotation.set(t * 4 + i, t * 3 + i * 2, Math.sin(t * 7 + i) * 0.6);
        m.scale.setScalar(k > 0.75 ? Math.max(0.001, 1 - (k - 0.75) / 0.25) : Math.min(1, k * 8) + 0.001);
        m.visible = k > 0 && k < 1;
      }
      if (a.fly >= 1) { a.fly = -1; for (const m of a.sheets) m.visible = false; }
    }
  }

  function tickServer(e, t, dt) {
    const a = e.anim;
    a.race = Math.max(0, a.race - dt / 1.6);
    a.tip.scale.setScalar(0.014 * (1 + (Math.sin(t * 4) > 0.6 ? 0.5 : 0) + a.race));
    // LEDs are digital anyway: update at ~8 Hz (or 24 Hz while racing)
    const step = Math.floor(t * (a.race > 0 ? 24 : 8));
    if (step === a.step) return;
    a.step = step;
    for (let i = 0; i < a.n; i++) {
      if (a.race > 0) {
        // a bright band racing up the racks
        const band = (a.ys[i] * 9 - t * 9) % 1;
        col.copy(band > -0.25 && band < 0 || band > 0.75 ? WHITE : a.accent);
      } else {
        const on = Math.sin(step * 0.7 + i * 2.17) + Math.sin(step * 0.31 + i * 1.3) > 0.4;
        col.copy(on ? (i % 3 ? GREEN : a.accent) : DIM);
      }
      a.mesh.setColorAt(i, col);
    }
    a.mesh.instanceColor.needsUpdate = true;
  }

  function tickVault(e, t, dt) {
    const a = e.anim;
    a.spin = Math.max(0, a.spin - dt * 1.5);
    a.coin.rotation.y += dt * (1.2 + a.spin * 14);
    a.coin.position.y = e.beaconLocal.y + Math.sin(t * 2) * 0.01 + a.spin * 0.04;
    if (a.fly >= 0) {
      a.fly += dt / 1.5;
      for (let i = 0; i < a.coins.length; i++) {
        const m = a.coins[i];
        const k = Math.min(1, Math.max(0, a.fly * 1.25 - i * 0.03));
        const th = (i / a.coins.length) * Math.PI * 2;
        m.position.set(Math.sin(th) * k * 0.22, 0.47 + Math.sin(k * Math.PI) * 0.3 - k * 0.32, Math.cos(th) * k * 0.22);
        m.rotation.set(0, t * 10 + i, 0);
        m.scale.setScalar(k > 0.8 ? Math.max(0.001, 1 - (k - 0.8) / 0.2) : 1);
        m.visible = k > 0 && k < 1;
      }
      if (a.fly >= 1) { a.fly = -1; for (const m of a.coins) m.visible = false; }
    }
  }

  function tickWindmill(e, t, dt) {
    const a = e.anim;
    a.boost = Math.max(0, a.boost - dt * 0.5);
    a.rotor.rotation.z -= dt * (0.9 + a.boost * a.boost * 14);
  }

  const TICK = { lighthouse: tickLighthouse, printshop: tickPrintshop, server: tickServer, vault: tickVault, windmill: tickWindmill };

  function burstAt(e, count, kind) {
    if (!fx) return;
    refreshBeacon(e);
    if (kind === 'sparks') fx.sparks(e.beacon, e.dir, count);
    else fx.puff(e.beacon, e.dir, count);
  }

  const api = {
    /** Live landmarks, keyed by plot key (read-only). */
    marks,
    /** True while a pulse is mid-flight. */
    get busy() {
      for (const e of marks.values()) {
        const a = e.anim;
        if (e.grow < 1 || a.fly >= 0 || a.flash > 0 || a.race > 0 || a.boost > 0 || a.spin > 0 || a.speed > 0) return true;
      }
      return false;
    },
    update(plots = []) {
      const seen = new Set();
      const houses = plots.map((p) => p.dir);
      for (const plot of plots) {
        if (!plot?.dir) continue;
        seen.add(plot.key);
        const theme = themeOf(plot.name, plot.key);
        const sig = `${theme}|${plot.color}|${plot.dir.x.toFixed(4)},${plot.dir.y.toFixed(4)},${plot.dir.z.toFixed(4)}`;
        let e = marks.get(plot.key);
        if (e && e.sig !== sig) { dispose(e); byName.delete(plotKey(e.name)); e = null; }
        if (!e) {
          const others = houses.filter((d) => d !== plot.dir);
          for (const o of marks.values()) if (o.key !== plot.key) others.push(o.dir);
          e = build(plot, theme, others);
          e.sig = sig;
          marks.set(plot.key, e);
        }
        if (e.name !== plot.name) byName.delete(plotKey(e.name));
        e.name = plot.name;
        byName.set(plotKey(plot.name), e);
        const size = sizeFor(plot.level);
        if (size !== e.size) { e.size = size; if (e.grow >= 1) e.g.scale.setScalar(size); }
        refreshBeacon(e);
      }
      for (const [k, e] of marks) {
        if (seen.has(k)) continue;
        dispose(e);
        marks.delete(k);
        if (byName.get(plotKey(e.name)) === e) byName.delete(plotKey(e.name));
      }
    },
    tick(t, dt) {
      lhFlash = 0;
      for (const e of marks.values()) {
        if (e.grow < 1) {
          e.grow = Math.min(1, e.grow + dt * 1.6);
          const k = e.grow;
          e.g.scale.setScalar(e.size * Math.max(0.001, 1 + Math.sin(k * Math.PI * 1.3) * (1 - k) * 0.35 - (1 - k) ** 2));
          if (e.grow >= 1) refreshBeacon(e);
        }
        if (e.theme === 'lighthouse' && e.anim.flash > lhFlash) lhFlash = e.anim.flash;
        TICK[e.theme](e, t, dt);
      }
      beamMat.opacity = 0.14 + lhFlash * 0.3;
    },
    /** World-local position of a project's beacon (lamp, antenna tip, …), or null. Pass `out` to avoid allocating. */
    pointFor(name, out) {
      const e = byName.get(plotKey(name));
      if (!e) return null;
      return out ? out.copy(e.beacon) : e.beacon.clone();
    },
    /** Themed burst for one project. Returns false when it has no landmark. */
    pulse(name) {
      const e = byName.get(plotKey(name));
      if (!e) return false;
      const a = e.anim;
      switch (e.theme) {
        case 'lighthouse': a.flash = 1; a.spin = 1; a.fly = 0; burstAt(e, 6, 'sparks'); break;
        case 'printshop': a.speed = 1; a.fly = 0; burstAt(e, 6, 'puff'); break;
        case 'server': a.race = 1; a.step = -1; burstAt(e, 4, 'sparks'); break;
        case 'vault': a.spin = 1; a.fly = 0; burstAt(e, 8, 'sparks'); break;
        case 'windmill': a.boost = 1; burstAt(e, 6, 'puff'); break;
      }
      return true;
    },
    dispose() {
      for (const e of marks.values()) dispose(e);
      marks.clear(); byName.clear();
      world.remove(group);
    },
  };
  return api;
}
