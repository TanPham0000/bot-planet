// A Claude session as a little astronaut: model, jobs (props), drones for subagents, and all the poses.
import * as THREE from 'three';
import { groundR, offsetDir, surfaceQuat, UP } from './world.js';
import { emojiTexture, bubbleTexture, speechTexture, sprite } from './fx.js';
import { colorFor, customFor, setCustom } from './colors.js';

export const ACCENTS = ['#f59bae', '#8cc8f5', '#ffc96b', '#b49cf5', '#7fd9b4', '#f7a979', '#d97757', '#9be0e8'];
export const hashStr = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
export const SLEEP_MS = 20 * 60 * 1000;
export const STUCK_MS = 8 * 60 * 1000;

// ── what a tool looks like as a job on the planet ─────────────────────────
export const ACTIVITY = {
  build: { emoji: '🔨', label: 'building' },
  terminal: { emoji: '💻', label: 'at the terminal' },
  signal: { emoji: '📡', label: 'calling out' },
  explore: { emoji: '🔍', label: 'exploring' },
  plan: { emoji: '📋', label: 'planning' },
  delegate: { emoji: '🛰️', label: 'directing helpers' },
  think: { emoji: '💭', label: 'thinking' },
};
const SITE = { build: true, terminal: true, signal: true }; // jobs done at a spot with a prop

export function activityOf(tool) {
  if (!tool) return 'think';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'build';
  if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(tool)) return 'explore';
  if (/^(Bash|BashOutput|KillShell|KillBash)$/.test(tool)) return 'terminal';
  if (/^(WebFetch|WebSearch)$/.test(tool) || tool.startsWith('mcp__')) return 'signal';
  if (/^(TodoWrite|Task(Create|Update|List|Get)|Skill)$/.test(tool)) return 'plan';
  if (/^(Task|Agent)$/.test(tool)) return 'delegate';
  return 'build';
}
export function describe(d) {
  if (d.cowork) return d.manual ? `Cowork · working${d.task ? ': ' + d.task : ''}` : 'Cowork session · at home';
  if (d.status === 'help') return 'needs you';
  if (d.status === 'done') return Date.now() - d.since > SLEEP_MS ? 'napping at camp' : 'your turn';
  if (d.status === 'idle') return Date.now() - d.since > SLEEP_MS ? 'napping at camp' : 'resting at camp';
  const a = activityOf(d.tool);
  return ACTIVITY[a].label + (d.tool ? ` · ${d.tool.replace(/^mcp__([^_]+)__.*/, '$1')}` : '');
}

// ── shared geometry & materials (created once for the whole crew) ─────────
let G, M;
function shared() {
  if (G) return;
  G = {
    torso: new THREE.CapsuleGeometry(0.11, 0.09, 6, 16),
    badge: new THREE.CircleGeometry(0.03, 10),
    pack: new THREE.BoxGeometry(0.17, 0.17, 0.08),
    helmet: new THREE.SphereGeometry(0.155, 28, 20),
    visor: new THREE.SphereGeometry(0.12, 32, 24),           // smooth: the visor edge is the face
    eye: new THREE.SphereGeometry(0.021, 16, 12),
    sparkle: new THREE.SphereGeometry(0.0065, 8, 6),
    arcEye: new THREE.TorusGeometry(0.018, 0.0055, 6, 14, Math.PI), // ∩: happy ^ ^ (flipped ∪: asleep)
    antenna: new THREE.CylinderGeometry(0.006, 0.006, 0.08, 4),
    bulb: new THREE.SphereGeometry(0.025, 8, 6),
    arm: new THREE.CapsuleGeometry(0.034, 0.08, 3, 6),
    glove: new THREE.SphereGeometry(0.042, 12, 10),
    leg: new THREE.CapsuleGeometry(0.043, 0.05, 3, 6),
    boot: new THREE.SphereGeometry(0.054, 12, 10),
    ring: new THREE.RingGeometry(0.22, 0.27, 32),
    flame: new THREE.ConeGeometry(0.04, 0.14, 6),
    handle: new THREE.CylinderGeometry(0.007, 0.007, 0.12, 4),
    hammerHead: new THREE.BoxGeometry(0.055, 0.028, 0.028),
    clip: new THREE.BoxGeometry(0.085, 0.11, 0.008),
    paper: new THREE.PlaneGeometry(0.068, 0.085),
    lens: new THREE.TorusGeometry(0.03, 0.007, 5, 14),
    glass: new THREE.CircleGeometry(0.028, 12),
    crate: new THREE.BoxGeometry(0.085, 0.085, 0.085),
    consoleBase: new THREE.BoxGeometry(0.13, 0.11, 0.08),
    screen: new THREE.PlaneGeometry(0.105, 0.07),
    dishPole: new THREE.CylinderGeometry(0.008, 0.012, 0.22, 5),
    dish: new THREE.SphereGeometry(0.085, 12, 6, 0, Math.PI * 2, 0, 0.95),
    tip: new THREE.SphereGeometry(0.012, 6, 4),
    droneBody: new THREE.SphereGeometry(0.042, 10, 8),
    droneRing: new THREE.TorusGeometry(0.062, 0.008, 4, 16),
    droneEye: new THREE.SphereGeometry(0.011, 6, 4),
  };
  M = {
    white: new THREE.MeshPhongMaterial({ color: '#fdfbf7', shininess: 40, specular: '#444' }),
    visor: new THREE.MeshPhongMaterial({ color: '#2a2b45', shininess: 120, specular: '#9ab' }),
    eye: new THREE.MeshBasicMaterial({ color: '#c8fbff' }),
    sparkle: new THREE.MeshBasicMaterial({ color: '#ffffff' }),
    wood: new THREE.MeshLambertMaterial({ color: '#c49a6c', flatShading: true }),
    wood2: new THREE.MeshLambertMaterial({ color: '#a97c54', flatShading: true }),
    metal: new THREE.MeshLambertMaterial({ color: '#c9c6d8', flatShading: true }),
    dark: new THREE.MeshLambertMaterial({ color: '#4b4766', flatShading: true }),
    paper: new THREE.MeshBasicMaterial({ color: '#fffaf0', side: THREE.DoubleSide }),
    glass: new THREE.MeshBasicMaterial({ color: '#bfe9ff', transparent: true, opacity: 0.55 }),
    flame: new THREE.MeshBasicMaterial({ color: '#ffb347' }),
  };
}
// Every project gets its own look: suit accent + a signature hat, so you can tell crews apart.
export const lookKeyOf = (d) => String(d.name || d.projectKey || d.project || d.id).trim().toLowerCase();
// Projects with a continent wear its colour; everyone else gets a pastel from their name.
export const accentFor = (key) => colorFor(key) || ACCENTS[hashStr(key) % ACCENTS.length];
const HATS = ['cap', 'beanie', 'crown', 'headphones', 'propeller', 'tophat', 'bow', 'flower'];
export { HATS };
/** The crew's hat: the one picked in the crew manager, else one derived from the name. */
export const hatFor = (key) => {
  const h = customFor(key).hat;
  return HATS.includes(h) ? h : HATS[hashStr(key + '#hat') % HATS.length];
};
/** Same store as colors.setCustom (one call updates colours, hats, themes, spots). */
export const setCustomLooks = setCustom;
/** Everything that decides how a crew looks; astronauts re-skin when it changes. */
export const lookSig = (key) => `${accentFor(key)}|${hatFor(key)}`;

let H;
function hatGeos() {
  if (H) return H;
  H = {
    dome: new THREE.SphereGeometry(0.105, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    brim: new THREE.CylinderGeometry(0.08, 0.08, 0.012, 14, 1, false, -Math.PI / 2, Math.PI),
    pom: new THREE.SphereGeometry(0.03, 8, 6),
    band: new THREE.CylinderGeometry(0.09, 0.1, 0.06, 5, 1, true),
    spike: new THREE.ConeGeometry(0.02, 0.05, 4),
    gem: new THREE.OctahedronGeometry(0.015, 0),
    arc: new THREE.TorusGeometry(0.16, 0.014, 6, 18, Math.PI),
    cup: new THREE.CylinderGeometry(0.045, 0.045, 0.035, 12),
    hub: new THREE.CylinderGeometry(0.015, 0.015, 0.05, 6),
    blade: new THREE.BoxGeometry(0.16, 0.006, 0.035),
    tall: new THREE.CylinderGeometry(0.075, 0.075, 0.12, 14),
    disc: new THREE.CylinderGeometry(0.12, 0.12, 0.012, 16),
    bowCone: new THREE.ConeGeometry(0.035, 0.07, 6),
    petal: new THREE.SphereGeometry(0.022, 6, 5),
  };
  return H;
}
const HAT_GOLD = new THREE.MeshLambertMaterial({ color: '#ffd166', flatShading: true });
const HAT_DARK = new THREE.MeshLambertMaterial({ color: '#3b3552', flatShading: true });
const HAT_WHITE = new THREE.MeshLambertMaterial({ color: '#fffaf0', flatShading: true });

/** Build a hat for the head group (head-local coords: helmet top is at y≈0.215). */
function makeHat(kind, acc) {
  const h = hatGeos();
  const g = new THREE.Group();
  const m = (geo, mat, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); g.add(o); return o; };
  switch (kind) {
    case 'cap': m(h.dome, acc, 0, 0.18, 0).scale.set(1.25, 0.8, 1.25); m(h.brim, acc, 0, 0.185, 0.1).scale.set(1.1, 1, 1.4); break;
    case 'beanie': m(h.dome, acc, 0, 0.17, 0).scale.set(1.35, 1.05, 1.35); m(h.pom, HAT_WHITE, 0, 0.29, 0); break;
    case 'crown': {
      m(h.band, HAT_GOLD, 0, 0.225, 0);
      for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; m(h.spike, HAT_GOLD, Math.sin(a) * 0.085, 0.27, Math.cos(a) * 0.085); }
      m(h.gem, acc, 0, 0.23, 0.1);
      break;
    }
    case 'headphones': m(h.arc, acc, 0, 0.07, 0).rotation.z = 0; m(h.cup, HAT_DARK, -0.16, 0.06, 0).rotation.z = Math.PI / 2; m(h.cup, HAT_DARK, 0.16, 0.06, 0).rotation.z = Math.PI / 2; break;
    case 'propeller': {
      m(h.dome, acc, 0, 0.18, 0).scale.set(1.2, 0.7, 1.2); m(h.hub, HAT_DARK, 0, 0.27, 0);
      const prop = new THREE.Group(); prop.position.y = 0.3;
      prop.add(new THREE.Mesh(h.blade, HAT_GOLD)); const b2 = new THREE.Mesh(h.blade, acc); b2.rotation.y = Math.PI / 2; prop.add(b2);
      g.add(prop); g.userData.spin = prop;
      break;
    }
    case 'tophat': m(h.disc, HAT_DARK, 0, 0.215, 0); m(h.tall, HAT_DARK, 0, 0.28, 0); m(h.disc, acc, 0, 0.245, 0).scale.set(0.64, 1.6, 0.64); break;
    case 'bow': { const l = m(h.bowCone, acc, -0.04, 0.215, 0.02); l.rotation.z = Math.PI / 2; const r = m(h.bowCone, acc, 0.04, 0.215, 0.02); r.rotation.z = -Math.PI / 2; m(h.pom, acc, 0, 0.215, 0.02).scale.setScalar(0.6); g.rotation.z = 0.35; g.position.set(0.05, -0.02, 0); break; }
    case 'flower': for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; m(h.petal, acc, 0.09 + Math.cos(a) * 0.028, 0.18 + Math.sin(a) * 0.028, 0.06); } m(h.pom, HAT_GOLD, 0.09, 0.18, 0.065).scale.setScalar(0.6); break;
  }
  g.userData.kind = kind;
  return g;
}

const EYE_H = 1.28; // eyes are slightly taller than wide
const accentMats = new Map();
const accentMat = (c) => accentMats.get(c) ?? accentMats.set(c, new THREE.MeshLambertMaterial({ color: c })).get(c);

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const right = new THREE.Vector3();
const fwd = new THREE.Vector3();
const damp = (k, dt) => 1 - Math.exp(-k * dt);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const ease = (x) => x * x * (3 - 2 * x);

/** Rotate `obj` to stand on normal `up` facing tangent direction `forward` (slerped by k). */
function orient(obj, up, forward, k) {
  fwd.copy(forward).projectOnPlane(up);
  if (fwd.lengthSq() < 1e-8) return;
  fwd.normalize();
  right.crossVectors(up, fwd);
  tmpM.makeBasis(right, up, fwd);
  tmpQ.setFromRotationMatrix(tmpM);
  if (k >= 1) obj.quaternion.copy(tmpQ); else obj.quaternion.slerp(tmpQ, k);
}

export class Astronaut {
  /** env: { world, fx, campDir, campRadius, seatDir(i) } */
  constructor(data, env, startDir) {
    shared();
    this.env = env;
    this.id = data.id;
    this.data = data;
    this.lookKey = lookKeyOf(data);
    this.accent = accentFor(this.lookKey);
    this.lookSig = lookSig(this.lookKey);
    this.build();

    this.p = startDir.clone().normalize();
    this.h = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).projectOnPlane(this.p).normalize();
    this.phase = Math.random() * 10;
    this.walkPhase = 0;
    this.turn = 0;
    this.seat = -1;
    this.site = null;       // { kind, dir, propDir, prop, grow }
    this.relocateAt = 0;
    this.pauseUntil = 0;
    this.nextPause = 3 + Math.random() * 4;
    this.greet = null;      // { partner, until }
    this.greetCooldown = 0;
    this.fidget = null;     // { kind, until, side }
    this.nextFidget = 2 + Math.random() * 6;
    this.jumpT = -1;
    this.spawnT = 0;
    this.landed = false;
    this.leaving = 0;
    this.hammerK = 0;
    this.thoughtAt = 0;
    this.cheerUntil = 0;
    this.lift = 0;
    env.world.add(this.root);
  }

  build() {
    const acc = accentMat(this.accent);
    this.accentMeshes = [];
    const root = (this.root = new THREE.Group());
    const body = (this.body = new THREE.Group());
    root.add(body);

    const torso = (this.torso = new THREE.Mesh(G.torso, M.white));
    torso.position.y = 0.25; torso.scale.set(1.08, 1, 0.95);
    const badge = new THREE.Mesh(G.badge, acc); badge.position.set(0.045, 0.28, 0.105);
    const pack = new THREE.Mesh(G.pack, acc); pack.position.set(0, 0.29, -0.115);
    const flame = (this.flame = new THREE.Mesh(G.flame, M.flame));
    flame.position.set(0, 0.15, -0.115); flame.rotation.x = Math.PI; flame.visible = false;
    body.add(torso, badge, pack, flame);
    this.accentMeshes.push(badge, pack);

    const head = (this.head = new THREE.Group());
    head.position.y = 0.4;
    const helmet = new THREE.Mesh(G.helmet, M.white); helmet.position.y = 0.06;
    // a big, round visor: wide and tall, so the face reads from far away
    const visor = new THREE.Mesh(G.visor, M.visor); visor.position.set(0, 0.062, 0.082); visor.scale.set(1.1, 0.92, 0.7); // front bulges ~1cm past the helmet
    this.eyes = [-1, 1].map((sx) => {
      // round, glowing eyes with a tiny sparkle (blinking squashes both)
      const e = new THREE.Mesh(G.eye, M.eye); e.position.set(sx * 0.047, 0.07, 0.161); e.scale.set(1, EYE_H, 0.55);
      const sp = new THREE.Mesh(G.sparkle, M.sparkle); sp.position.set(0.007, 0.008, 0.017); e.add(sp);
      e.userData.sx = sx;
      head.add(e); return e;
    });
    this.arcs = [-1, 1].map((sx) => {
      const a = new THREE.Mesh(G.arcEye, M.eye); a.position.set(sx * 0.047, 0.066, 0.163); a.scale.setScalar(0.001); a.visible = false;
      head.add(a); return a;
    });
    // current face, eased toward the mood's target every frame
    this.face = { open: 1, w: 1, tilt: 0, dy: 0, arc: 0, flip: 0 };
    const antenna = new THREE.Mesh(G.antenna, M.white); antenna.position.y = 0.24;
    this.bulbMat = new THREE.MeshBasicMaterial({ color: this.accent });
    const bulb = (this.bulb = new THREE.Mesh(G.bulb, this.bulbMat)); bulb.position.y = 0.285;
    head.add(helmet, visor, antenna, bulb);
    body.add(head);
    this.antenna = [antenna, bulb];
    this.setHat(hatFor(this.lookKey));

    const limb = (x, y, geo, len, r, endGeo, boot) => {
      const pivot = new THREE.Group(); pivot.position.set(x, y, 0);
      const m = new THREE.Mesh(geo, M.white); m.position.y = -len / 2 - r * 0.4;
      const g = new THREE.Mesh(endGeo, acc); g.position.y = -len - r * 0.9;
      this.accentMeshes.push(g);
      if (boot) { g.scale.set(1, 0.72, 1.25); g.position.z = 0.012; }
      pivot.add(m, g); body.add(pivot);
      pivot.userData.hand = g.position.clone();
      return pivot;
    };
    this.armL = limb(-0.135, 0.33, G.arm, 0.08, 0.034, G.glove);
    this.armR = limb(0.135, 0.33, G.arm, 0.08, 0.034, G.glove);
    this.legL = limb(-0.055, 0.16, G.leg, 0.05, 0.043, G.boot, true);
    this.legR = limb(0.055, 0.16, G.leg, 0.05, 0.043, G.boot, true);

    // hand-held tools
    const hand = this.armR.userData.hand;
    this.hammer = new THREE.Group();
    const hh = new THREE.Mesh(G.handle, M.wood2); hh.rotation.x = Math.PI / 2; hh.position.z = 0.05;
    const hd = new THREE.Mesh(G.hammerHead, M.metal); hd.position.z = 0.11;
    this.hammer.add(hh, hd); this.hammer.position.copy(hand);
    this.lens = new THREE.Group();
    const lh = new THREE.Mesh(G.handle, M.dark); lh.rotation.x = Math.PI / 2; lh.position.z = 0.04;
    const lr = new THREE.Mesh(G.lens, M.dark); lr.position.z = 0.12; lr.rotation.x = Math.PI / 2;
    const lg = new THREE.Mesh(G.glass, M.glass); lg.position.z = 0.12; lg.rotation.x = -Math.PI / 2;
    this.lens.add(lh, lr, lg); this.lens.position.copy(hand);
    this.armR.add(this.hammer, this.lens);
    this.clip = new THREE.Group();
    const cb = new THREE.Mesh(G.clip, M.wood); const cp = new THREE.Mesh(G.paper, M.paper); cp.position.z = 0.005;
    this.clip.add(cb, cp); this.clip.position.copy(this.armL.userData.hand).add(new THREE.Vector3(0.02, -0.02, 0.03)); this.clip.rotation.x = -1.2;
    this.armL.add(this.clip);
    this.hammer.visible = this.lens.visible = this.clip.visible = false;

    // ground ring while waving
    this.ringMat = new THREE.MeshBasicMaterial({ color: '#d97757', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
    this.ring = new THREE.Mesh(G.ring, this.ringMat);
    this.ring.rotation.x = -Math.PI / 2; this.ring.position.y = 0.012; this.ring.visible = false;
    root.add(this.ring);

    // sprites
    this.bubble = sprite(bubbleTexture('!', '#d97757'), 0.26); this.bubble.position.y = 0.95;
    this.check = sprite(bubbleTexture('✓', '#5fbf8f'), 0.2); this.check.position.y = 0.88;
    this.toolIcon = sprite(emojiTexture('💭'), 0.17); this.toolIcon.position.y = 0.86;
    this.zzz = sprite(emojiTexture('💤'), 0.17); this.zzz.position.set(0.12, 0.3, 0.1);
    this.sweat = sprite(emojiTexture('💧'), 0.1);
    this.toolIcon.userData.emoji = '💭';
    // speech bubble: what it's touching right now ("app.js", "npm test", "“notch”")
    this.speech = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
    this.speech.center.set(0.5, 0);
    this.speech.userData.text = '';
    for (const s of [this.bubble, this.check, this.toolIcon, this.zzz, this.speech, this.sweat]) { s.visible = false; root.add(s); }

    this.drones = [];
    root.scale.setScalar(1.15);
  }

  // ── data & events ──────────────────────────────────────────────────────
  setHat(kind) {
    if (this.hat) this.head.remove(this.hat);
    this.hat = makeHat(kind, accentMat(this.accent));
    this.head.add(this.hat);
    // antenna pokes through soft hats only
    const keepAntenna = kind === 'headphones' || kind === 'bow' || kind === 'flower';
    for (const o of this.antenna) o.visible = keepAntenna;
  }

  /** Project (or its name) changed: switch suit colour and hat to that crew's look. */
  applyLook(key) {
    this.lookKey = key;
    this.lookSig = lookSig(key);
    this.accent = accentFor(key);
    const mat = accentMat(this.accent);
    for (const m of this.accentMeshes) m.material = mat;
    for (const d of this.drones) d.g.children[0].material = mat;
    this.setHat(hatFor(key));
  }

  setData(d) {
    const prev = this.data.status;
    this.data = d;
    const key = lookKeyOf(d);
    if (key !== this.lookKey || lookSig(key) !== this.lookSig) this.applyLook(key);
    if (prev === 'working' && (d.status === 'done' || (d.cowork && d.status === 'idle')) && this.landed) {
      this.env.fx.confetti(this.root.position, this.p);
      this.cheerUntil = performance.now() / 1000 + 1.6;
    }
    this.syncDrones();
  }

  syncDrones() {
    const want = Math.min(8, (this.data.subagents || []).length);
    while (this.drones.filter((d) => !d.dying).length < want) {
      const g = new THREE.Group();
      const b = new THREE.Mesh(G.droneBody, accentMat(this.accent));
      const r = new THREE.Mesh(G.droneRing, M.white); r.rotation.x = Math.PI / 2;
      const e = new THREE.Mesh(G.droneEye, M.eye); e.position.z = 0.038;
      g.add(b, r, e);
      g.position.set(0, 0.3, -0.12); // pops out of the backpack
      g.scale.setScalar(0.01);
      this.root.add(g);
      this.drones.push({ g, ring: r, born: performance.now() / 1000, a: Math.random() * 6, dying: 0 });
    }
    let extra = this.drones.filter((d) => !d.dying).length - want;
    for (const d of this.drones) if (extra > 0 && !d.dying) { d.dying = 0.001; extra--; }
  }

  leave() { if (!this.leaving) this.leaving = 0.0001; }

  poke() {
    this.jumpT = 0;
    this.env.fx.float(emojiTexture('🧡'), tmpV.copy(this.root.position).addScaledVector(this.p, 0.8), this.p, { size: 0.15 });
  }

  /** Approximate center of the astronaut in world-local space (for picking). */
  center(out) { return out.copy(this.root.position).addScaledVector(this.p, 0.32); }

  // ── jobs ───────────────────────────────────────────────────────────────
  inCamp() { return this.p.angleTo(this.env.campDir) < this.env.campRadius; }

  pickSite(kind, t) {
    this.clearSite();
    // work at home if the project has a house in the village, else near where we are — never in camp
    const home = this.env.homeDir?.(this.data.name);
    let dir = home
      ? offsetDir(home, Math.random() * Math.PI * 2, 0.13 + Math.random() * 0.1)
      : offsetDir(this.p, Math.random() * Math.PI * 2, 0.12 + Math.random() * 0.25);
    for (let i = 0; i < 8 && dir.angleTo(this.env.campDir) < this.env.campRadius + 0.1; i++) {
      dir = offsetDir(this.env.campDir, Math.random() * Math.PI * 2, this.env.campRadius + 0.25 + Math.random() * 0.5);
    }
    const propDir = offsetDir(dir, Math.random() * Math.PI * 2, 0.075);
    const prop = this.makeProp(kind);
    prop.position.copy(propDir).multiplyScalar(groundR(propDir) - 0.005);
    prop.scale.setScalar(0.001);
    // turn the prop's front (+z) toward where the astronaut will stand
    orient(prop, propDir, tmpV.copy(dir).sub(propDir), 1);
    this.env.world.add(prop);
    this.site = { kind, dir, propDir, prop, grow: 0, shrink: 0 };
    this.relocateAt = t + 22 + Math.random() * 25;
  }

  clearSite() {
    if (!this.site) return;
    const s = this.site;
    this.site = null;
    (this.oldProps ??= []).push({ prop: s.prop, k: s.grow });
  }

  makeProp(kind) {
    const g = new THREE.Group();
    if (kind === 'build') {
      const spots = [[0, 0.043, 0], [0.09, 0.043, 0.01], [0.045, 0.128, 0.004], [-0.03, 0.043, -0.07], [0.03, 0.213, 0]];
      g.userData.crates = spots.map(([x, y, z], i) => {
        const c = new THREE.Mesh(G.crate, i % 2 ? M.wood2 : M.wood);
        c.position.set(x, y, z); c.rotation.y = (i * 0.7) % 1;
        c.visible = i < 2; g.add(c); return c;
      });
      g.userData.stack = 2;
    } else if (kind === 'terminal') {
      const base = new THREE.Mesh(G.consoleBase, M.metal); base.position.y = 0.055;
      const scr = new THREE.Mesh(G.screen, new THREE.MeshBasicMaterial({ color: '#7ff0c8' }));
      scr.position.set(0, 0.105, 0.03); scr.rotation.x = -0.6;
      g.add(base, scr); g.userData.screen = scr;
    } else {
      const pole = new THREE.Mesh(G.dishPole, M.metal); pole.position.y = 0.11;
      const head = new THREE.Group(); head.position.y = 0.22;
      const dish = new THREE.Mesh(G.dish, M.white); dish.rotation.x = -2.2;
      const tip = new THREE.Mesh(G.tip, new THREE.MeshBasicMaterial({ color: '#ff8a65' })); tip.position.set(0, 0.04, 0.05);
      head.add(dish, tip);
      g.add(pole, head); g.userData.head = head; g.userData.tip = tip;
    }
    return g;
  }

  animateProps(t, dt, working) {
    const s = this.site;
    if (s) {
      s.grow = Math.min(1, s.grow + dt * (working ? 3 : 0.8));
      const k = s.grow;
      s.prop.scale.setScalar(Math.max(0.001, k < 1 ? 1 + Math.sin(k * Math.PI * 1.4) * (1 - k) * 0.5 - (1 - k) ** 2 : 1));
      if (s.kind === 'terminal') s.prop.userData.screen.material.color.setHSL(0.45, 0.7, working ? 0.65 + Math.sin(t * 17) * 0.06 : 0.5);
      if (s.kind === 'signal') {
        s.prop.userData.head.rotation.y += dt * (working ? 1.2 : 0.2);
        s.prop.userData.tip.visible = !working || Math.sin(t * 8) > -0.3;
      }
    }
    if (this.oldProps) {
      for (let i = this.oldProps.length - 1; i >= 0; i--) {
        const o = this.oldProps[i];
        o.k -= dt * 3;
        if (o.k <= 0) { this.env.world.remove(o.prop); this.oldProps.splice(i, 1); }
        else o.prop.scale.setScalar(o.k);
      }
    }
  }

  // ── per-frame ──────────────────────────────────────────────────────────
  /** ctx: { t, dt, camLocal, selected, hovered, agents } → returns false once fully gone. */
  update(ctx) {
    if (ctx.photo && this.photo) return this.updatePhoto(ctx);
    const { t, dt } = ctx;
    const d = this.data;
    const s = d.status;
    const act = s === 'working' ? activityOf(d.tool) : null;
    // Cowork sessions have no live status: they hang out at their project's house and never nap
    const sleeping = !d.cowork && (s === 'idle' || s === 'done') && Date.now() - d.since > SLEEP_MS;
    // stuck: "working" but nothing has happened for a while — sweats and slows down
    this.stuck = !d.cowork && !d.manual && s === 'working' && Date.now() - (d.updated || d.since || Date.now()) > STUCK_MS;
    const slow = this.stuck ? 0.45 : 1;
    const ph = t + this.phase;

    // arrival (jetpack drop) & departure (jetpack off)
    this.spawnT = Math.min(1, this.spawnT + dt * 1.1);
    let lift = Math.pow(1 - this.spawnT, 3) * 2.4;
    if (!this.landed && this.spawnT >= 1) { this.landed = true; this.env.fx.puff(this.root.position, this.p); }
    if (this.leaving) {
      this.leaving += dt;
      lift += this.leaving * this.leaving * 3.2;
      if (this.leaving > 1.5) { this.dispose(); return false; }
    }
    const flying = lift > 0.02;

    // ── decide what to do ──
    let mode, target = null, speed = 0;
    if (flying) mode = 'fly';
    else if (s === 'help') { mode = 'wave'; this.clearSite(); }
    else if (s === 'working') {
      if (SITE[act]) {
        if (!this.site || this.site.kind !== act || t > this.relocateAt) this.pickSite(act, t);
        if (this.p.angleTo(this.site.dir) > 0.012) { mode = 'walk'; target = this.site.dir; speed = 0.34; }
        else mode = 'work';
      } else {
        this.clearSite();
        if (this.inCamp()) { mode = 'walk'; target = this.campExit ??= offsetDir(this.env.campDir, Math.random() * 6.28, this.env.campRadius + 0.2); speed = 0.3; }
        else {
          this.campExit = null;
          if ((this.nextPause -= dt) <= 0) { this.pauseUntil = t + 1.4 + Math.random(); this.nextPause = 4 + Math.random() * 5; }
          mode = t < this.pauseUntil ? 'pause' : 'wander';
          speed = mode === 'wander' ? (act === 'think' ? 0.08 : act === 'explore' ? 0.15 : 0.11) : 0;
        }
      }
    } else {
      this.clearSite();
      this.campExit = null;
      const seat = d.cowork ? this.env.homeSpot?.(d.name, this.homeIdx ?? 0) : this.env.seatDir(this.seat);
      if (seat && this.p.angleTo(seat) > 0.01) { mode = 'walk'; target = seat; speed = 0.32; }
      else mode = sleeping ? 'sleep' : 'rest';
    }

    // say hi to passers-by
    if (this.greet && t > this.greet.until) this.greet = null;
    this.greetCooldown -= dt;
    if (!this.greet && this.greetCooldown <= 0 && (mode === 'wander' || mode === 'walk')) {
      for (const o of ctx.agents) {
        if (o === this || o.greet || o.greetCooldown > 0 || o.leaving || o.lift > 0.02) continue;
        if (this.p.angleTo(o.p) < 0.2) {
          const until = t + 1.4;
          this.greet = { partner: o, until }; o.greet = { partner: this, until };
          this.greetCooldown = o.greetCooldown = 25 + Math.random() * 15;
          break;
        }
      }
    }
    if (this.greet && (mode === 'wander' || mode === 'walk' || mode === 'pause')) mode = 'greet';

    speed *= slow;
    // ── move ──
    if (mode === 'walk' && target) {
      tmpV.copy(target).sub(this.p).projectOnPlane(this.p);
      if (tmpV.lengthSq() > 1e-10) this.h.copy(tmpV.normalize());
      const step = Math.min(speed * dt, this.p.angleTo(target));
      this.p.addScaledVector(this.h, step).normalize();
      this.walkPhase += step * 60;
    } else if (mode === 'wander') {
      this.turn += (Math.random() - 0.5) * dt * 6;
      this.turn *= 0.97;
      this.h.applyAxisAngle(this.p, this.turn * dt);
      // steer away from the camp clearing
      const toCamp = this.p.angleTo(this.env.campDir);
      if (toCamp < this.env.campRadius + 0.12) {
        tmpV.copy(this.p).sub(this.env.campDir).projectOnPlane(this.p).normalize();
        this.h.lerp(tmpV, damp(3, dt)).normalize();
      }
      this.p.addScaledVector(this.h, speed * dt).normalize();
      this.walkPhase += speed * dt * 60;
    }
    if (mode !== 'rest' && mode !== 'sleep' && mode !== 'work') {
      for (const o of ctx.agents) {
        if (o === this) continue;
        const a = this.p.angleTo(o.p);
        if (a < 0.07 && a > 0) this.p.addScaledVector(tmpV.subVectors(this.p, o.p).normalize(), (0.07 - a) * dt * 4).normalize();
      }
    }
    this.h.projectOnPlane(this.p).normalize();
    this.lift = lift;
    this.root.position.copy(this.p).multiplyScalar(groundR(this.p) + lift);

    // ── face ──
    const lookAtYou = mode === 'wave' || this.id === ctx.selected || this.id === ctx.hovered || this.jumpT >= 0;
    let face = this.h;
    if (lookAtYou) face = tmpV2.copy(ctx.camLocal).sub(this.root.position);
    else if (mode === 'greet') face = tmpV2.copy(this.greet.partner.root.position).sub(this.root.position);
    else if (mode === 'work') face = tmpV2.copy(this.site.propDir).sub(this.p);
    else if (mode === 'rest' || mode === 'sleep') face = tmpV2.copy((d.cowork && this.env.homeDir?.(d.name)) || this.env.campDir).sub(this.p);
    orient(this.root, this.p, face, damp(lookAtYou ? 7 : 4, dt));

    // ── pose ──
    const P = { aLz: -0.25, aRz: 0.25, aLx: 0, aRx: 0, lL: 0, lR: 0, y: 0, rx: 0, hy: 0, hx: 0, lie: 0, by: 0, spin: false };
    const walking = mode === 'walk' || mode === 'wander';
    if (walking) {
      const w = Math.sin(this.walkPhase);
      P.lL = w * 0.6; P.lR = -w * 0.6; P.aLx = -w * 0.5; P.aRx = w * 0.5;
      P.y = Math.abs(Math.cos(this.walkPhase)) * 0.025;
    }
    this.hammer.visible = act === 'build' && mode === 'work';
    this.lens.visible = act === 'explore';
    this.clip.visible = act === 'plan';

    switch (mode) {
      case 'fly':
        P.lL = P.lR = 0.35; P.aLz = -0.7; P.aRz = 0.7; P.y = Math.sin(ph * 6) * 0.01;
        break;
      case 'wave':
        P.aRz = 2.55 + Math.sin(ph * 13) * 0.45;
        P.aLz = -(2.55 + Math.sin(ph * 13 + 1.6) * 0.45) * (Math.sin(ph * 0.9) > 0 ? 1 : 0.12);
        P.y = Math.abs(Math.sin(ph * 5.5)) * 0.09;
        break;
      case 'greet':
        P.aRz = 2.4 + Math.sin(ph * 14) * 0.4; P.hx = -0.1;
        break;
      case 'work':
        if (act === 'build') {
          const prev = this.hammerK;
          this.hamPh = (this.hamPh ?? 0) + dt * 1.8 * slow;
          this.hammerK = this.hamPh % 1;
          const k = this.hammerK;
          P.aRx = k < 0.72 ? -1.0 - ease(k / 0.72) * 1.6 : -2.6 + ((k - 0.72) / 0.28) * 1.6;
          P.aLx = -0.75; P.rx = 0.12; P.hx = 0.25;
          if (k < prev && this.site) this.strike();
        } else if (act === 'terminal') {
          const ty = this.stuck ? ph * 6 : ph * 24;
          P.aLx = -1.15 + Math.sin(ty) * 0.1; P.aRx = -1.15 + Math.sin(ty + 3) * 0.1;
          P.aLz = -0.1; P.aRz = 0.1; P.hx = 0.22 + Math.sin(ph * 0.7) * 0.05; P.y = Math.sin(ph * 3) * 0.004;
        } else {
          P.aRz = 2.2 + Math.sin(ph * 2.5) * 0.15; P.aRx = -0.4; P.hx = -0.35; P.hy = Math.sin(ph * 0.8) * 0.2;
        }
        break;
      case 'pause':
        if (act === 'explore') { P.rx = 0.35; P.hx = 0.4; P.aRx = -1.5; }
        else if (act === 'plan') { P.aLx = -1.1; P.aRx = -0.9 + Math.sin(ph * 16) * 0.08; P.hx = 0.35; }
        else if (act === 'delegate') { P.aRz = 1.5 + Math.sin(ph * 4) * 0.2; P.aRx = -0.6; P.hx = -0.2; }
        else { P.aRx = -2.1; P.aRz = -0.25; P.hx = -0.15; P.hy = Math.sin(ph * 0.9) * 0.4; } // thinking: hand on chin
        break;
      case 'rest': {
        P.lL = P.lR = -1.45; P.y = -0.1; P.rx = -0.08; P.aLx = P.aRx = -0.5;
        this.updateFidget(t, ph, P, s, dt);
        break;
      }
      case 'sleep':
        P.lie = 1; P.aLz = -0.15; P.aRz = 0.15;
        break;
    }
    if (walking) {
      if (act === 'explore') { P.aRx = -1.1; P.hx = 0.15; }
      else if (act === 'plan') { P.aLx = -1.1; P.aRx = -0.85; P.hx = 0.2; }
      else if (act === 'think') { P.aRx = -2.1; P.aRz = -0.25; P.hy = Math.sin(ph * 0.9) * 0.3; }
    }
    // cheer after finishing a job
    if (t < this.cheerUntil && mode !== 'wave') { P.aLz = -2.7 + Math.sin(ph * 12) * 0.2; P.aRz = 2.7 - Math.sin(ph * 12) * 0.2; }
    // hovered: wave back
    if (this.id === ctx.hovered && mode !== 'wave' && mode !== 'sleep') { P.aRz = 2.4 + Math.sin(ph * 14) * 0.45; P.aRx = 0; }

    // ── noticing you: near your cursor, or under the camera when you zoom in → look up at you ──
    const near = !flying && ((ctx.focusDir && this.p.angleTo(ctx.focusDir) < 0.42)
      || (ctx.camNear && this.p.dot(ctx.camDirLocal) > ctx.camNear));
    if (near && !this.noticed) {
      this.noticed = true;
      // a little "oh, hi!": some wave, some hop, wanderers stop for a moment
      const r = Math.random();
      if (mode !== 'sleep' && mode !== 'wave') {
        if (r < 0.4) this.hiUntil = t + 1.3;
        else if (r < 0.6 && this.jumpT < 0) this.jumpT = 0;
      }
      if (mode === 'wander') this.pauseUntil = Math.max(this.pauseUntil, t + 1.8);
    } else if (!near && this.noticed && (this.noticedLeft ??= t) && t - this.noticedLeft > 0.6) {
      this.noticed = false; // small grace period so they don't twitch at the edge
    }
    if (near) this.noticedLeft = null;
    if (this.noticed && mode !== 'wave' && mode !== 'sleep') {
      // where is the camera, seen from this astronaut's head?
      tmpV.copy(ctx.camLocal).sub(this.root.position).applyQuaternion(tmpQ.copy(this.root.quaternion).invert());
      const up = tmpV.y - 0.5, flat = Math.hypot(tmpV.x, tmpV.z);
      P.hy = Math.max(-1.3, Math.min(1.3, Math.atan2(tmpV.x, tmpV.z)));
      P.hx = Math.max(-1.05, Math.min(0.15, -Math.atan2(up, flat)));
    }
    if (t < (this.hiUntil ?? 0) && mode !== 'wave' && mode !== 'sleep') { P.aRz = 2.5 + Math.sin(ph * 14) * 0.4; P.aRx = 0; }

    // click: squash, stretch & hop
    let sy = 1;
    if (this.jumpT >= 0) {
      this.jumpT += dt / 0.6;
      const u = this.jumpT;
      if (u >= 1) this.jumpT = -1;
      else {
        if (u > 0.15 && u < 0.75) { const k = (u - 0.15) / 0.6; P.y += Math.sin(k * Math.PI) * 0.22; P.aLz = -2.6; P.aRz = 2.6; P.lie = 0; }
        sy = u < 0.15 ? 1 - 0.28 * Math.sin((u / 0.15) * Math.PI / 2)
          : u < 0.75 ? 1 + 0.12 * Math.sin(((u - 0.15) / 0.6) * Math.PI)
          : 1 - 0.18 * Math.sin(((u - 0.75) / 0.25) * Math.PI);
      }
    }

    const L = damp(10, dt), fast = damp(28, dt);
    const armK = mode === 'wave' || mode === 'greet' || (mode === 'work' && act === 'build') || this.id === ctx.hovered || t < (this.hiUntil ?? 0) || this.fidget?.dance ? fast : L;
    this.armL.rotation.z += (P.aLz - this.armL.rotation.z) * armK;
    this.armR.rotation.z += (P.aRz - this.armR.rotation.z) * armK;
    this.armL.rotation.x += (P.aLx - this.armL.rotation.x) * armK;
    this.armR.rotation.x += (P.aRx - this.armR.rotation.x) * armK;
    this.legL.rotation.x += (P.lL - this.legL.rotation.x) * L;
    this.legR.rotation.x += (P.lR - this.legR.rotation.x) * L;
    if (P.spin) this.body.rotation.y = P.by;
    else this.body.rotation.y += (wrapAngle(P.by - this.body.rotation.y)) * L;
    this.head.rotation.y += (P.hy - this.head.rotation.y) * L;
    this.head.rotation.x += (P.hx - this.head.rotation.x) * L;
    const lie = (this.body.userData.lie ?? 0) + (P.lie - (this.body.userData.lie ?? 0)) * damp(3, dt);
    this.body.userData.lie = lie;
    this.body.rotation.x += (P.rx - lie * 1.5 - this.body.rotation.x) * L;
    const targetY = P.y + lie * 0.11;
    this.body.position.y += (targetY - this.body.position.y) * (mode === 'wave' || this.jumpT >= 0 ? 0.6 : L);
    const breathe = walking ? 1 : 1 + Math.sin(ph * 2.2) * 0.015;
    this.body.scale.set(1 / Math.sqrt(sy), sy * breathe, 1 / Math.sqrt(sy));

    if (this.hat?.userData.spin) this.hat.userData.spin.rotation.y += dt * (s === 'working' ? 14 : 3);

    this.updateFace(ph, dt, lie > 0.5 ? 'sleep'
      : s === 'help' ? 'worried'
      : (s === 'done' && !sleeping) || t < this.cheerUntil || this.jumpT >= 0 ? 'happy'
      : s === 'working' ? (this.stuck ? 'worried' : 'focused') : 'normal');

    // sweat drop beside the helmet while stuck: slides down, fades, repeats
    this.sweat.visible = this.stuck && !flying;
    if (this.sweat.visible) {
      const u = (ph * 0.55) % 1;
      this.sweat.position.set(0.17, 0.6 - u * 0.09, 0.07);
      this.sweat.material.opacity = Math.min(1, u * 5) * (1 - u * u);
      this.sweat.scale.setScalar(0.1 * (0.8 + Math.min(1, u * 4) * 0.2));
    }

    // antenna bulb: steady accent, blinking orange when it needs you, flicker while busy
    if (mode === 'wave') this.bulbMat.color.set(Math.sin(ph * 10) > 0 ? '#ff7a45' : '#ffd0b8');
    else if (s === 'working') this.bulbMat.color.set(this.accent).offsetHSL(0, 0, Math.sin(ph * 6) * 0.12);
    else this.bulbMat.color.set(this.accent);

    // jetpack flame
    this.flame.visible = flying;
    if (flying) this.flame.scale.set(1, 0.8 + Math.random() * 0.5, 1);

    // ring
    this.ring.visible = mode === 'wave';
    if (this.ring.visible) {
      const rp = (t * 1.2) % 1;
      this.ringMat.opacity = (1 - rp) * 0.8;
      this.ring.scale.setScalar(0.8 + rp * 0.9);
    }

    // sprites
    this.bubble.visible = mode === 'wave';
    if (this.bubble.visible) this.bubble.position.y = 0.98 + Math.abs(Math.sin(ph * 5.5)) * 0.06;
    this.check.visible = s === 'done' && !sleeping && !flying;
    if (this.check.visible) this.check.position.y = 0.66 + Math.sin(ph * 2) * 0.02;
    this.zzz.visible = mode === 'sleep';
    if (this.zzz.visible) { const z = (ph * 0.5) % 1; this.zzz.position.set(0.1 + z * 0.06, 0.25 + z * 0.25, -0.2); this.zzz.material.opacity = Math.sin(z * Math.PI); }
    // speech bubble (the app decides who gets one, so the sky doesn't fill with text)
    const say = ctx.speaking?.has(this.id) && d.detail && !flying && mode !== 'sleep';
    if (say && this.speech.userData.text !== d.detail) {
      const st = speechTexture(d.detail);
      this.speech.material.map = st.tex;
      this.speech.material.needsUpdate = true;
      this.speech.userData = { text: d.detail, aspect: st.aspect, pop: 0 };
    }
    this.speech.visible = !!say;
    if (say) {
      const u = (this.speech.userData.pop = Math.min(1, this.speech.userData.pop + dt * 5));
      const k = (u < 1 ? 0.6 + 0.4 * Math.sin(u * Math.PI * 0.5) + Math.sin(u * Math.PI) * 0.12 : 1) / 1.15; // undo root scale a bit
      const hgt = 0.27 * k;
      this.speech.scale.set(hgt * this.speech.userData.aspect, hgt, 1);
      this.speech.position.y = mode === 'wave' ? 1.2 : 1.0;
    }

    this.toolIcon.visible = s === 'working' && !flying;
    if (this.toolIcon.visible) {
      const e = ACTIVITY[act].emoji;
      if (this.toolIcon.userData.emoji !== e) { this.toolIcon.material.map = emojiTexture(e); this.toolIcon.userData.emoji = e; this.toolIcon.userData.pop = 0; }
      const pop = (this.toolIcon.userData.pop = Math.min(1, (this.toolIcon.userData.pop ?? 1) + dt * 4));
      this.toolIcon.scale.setScalar(0.17 * (1 + Math.sin(pop * Math.PI) * 0.4));
      this.toolIcon.position.y = 0.84 + Math.sin(ph * 2.4) * 0.025;
    }

    // drones orbit their astronaut
    for (let i = this.drones.length - 1; i >= 0; i--) {
      const dr = this.drones[i];
      const age = t - dr.born;
      dr.a += dt * 1.3;
      const r = 0.34 + (i % 2) * 0.06;
      const targetPos = tmpV.set(Math.cos(dr.a + i * 0.8) * r, 0.62 + Math.sin(ph * 3 + i) * 0.05 + (i % 3) * 0.05, Math.sin(dr.a + i * 0.8) * r);
      dr.g.position.lerp(targetPos, damp(age < 1 ? 4 : 10, dt));
      dr.g.rotation.y = -dr.a;
      dr.ring.rotation.z += dt * 6;
      if (dr.dying) {
        dr.dying += dt * 2.5;
        dr.g.position.addScaledVector(UP, dt * 0.8);
        dr.g.scale.setScalar(Math.max(0.001, 1 - dr.dying));
        if (dr.dying >= 1) { this.root.remove(dr.g); this.drones.splice(i, 1); }
      } else dr.g.scale.setScalar(Math.min(1, age * 2.5));
    }

    this.animateProps(t, dt, mode === 'work');
    return true;
  }

  /** Group photo: stand on the marked spot, face the camera, hold a pose. */
  updatePhoto(ctx) {
    this.spawnT = 1; this.landed = true; this.lift = 0;
    this.p.copy(this.photo.dir);
    this.root.position.copy(this.p).multiplyScalar(groundR(this.p));
    orient(this.root, this.p, tmpV2.copy(this.photo.face || ctx.camLocal).sub(this.root.position), 1);
    const P = { aLz: -0.25, aRz: 0.25, aLx: 0, aRx: 0, lL: 0, lR: 0, y: 0, hy: 0, hx: -0.05 };
    switch (this.photo.pose) {
      case 'sit': P.lL = P.lR = -1.45; P.y = -0.1; P.aLx = P.aRx = -0.5; break;
      case 'wave': P.aRz = 2.5; P.hy = 0.12; break;
      case 'cheer': P.aLz = -2.75; P.aRz = 2.75; P.hx = -0.3; break;
      case 'hips': P.aLz = -0.95; P.aRz = 0.95; P.aLx = -0.35; P.aRx = -0.35; P.hy = -0.15; break;
      case 'point': P.aRx = -1.65; P.aRz = 0.15; P.hy = 0.2; break;
      case 'peace': P.aRz = 2.05; P.aRx = -0.55; P.hy = 0.18; P.hx = -0.1; break;
      case 'jump': P.y = 0.17; P.aLz = -2.45; P.aRz = 2.45; P.lL = -0.6; P.lR = 0.35; break;
      case 'heart': P.aLz = -2.3; P.aRz = 2.3; P.aLx = -0.55; P.aRx = -0.55; break;
      case 'spin': P.aLz = -1.5; P.aRz = 1.5; P.y = 0.04; P.by = 0.9; break;            // mid-twirl
      case 'robot': P.aLz = -0.3; P.aRz = 2.9; P.aLx = -1.4; P.hy = 0.5; P.by = 0.3; break;
      case 'sway': P.aLz = -2.4; P.aRz = 2.6; P.by = -0.45; P.hy = -0.3; break;
    }
    // seen from above: lean back and look up at the camera, so you see faces, not helmet tops
    const lean = this.photo.lookUp ? (this.photo.pose === 'sit' ? 0.35 : 0.55) : 0;
    if (this.photo.lookUp) P.hx = -0.75;
    this.armL.rotation.set(P.aLx, 0, P.aLz); this.armR.rotation.set(P.aRx, 0, P.aRz);
    this.legL.rotation.set(P.lL, 0, 0); this.legR.rotation.set(P.lR, 0, 0);
    this.head.rotation.set(P.hx, P.hy, 0);
    this.body.rotation.set(-lean, P.by || 0, 0); this.body.userData.lie = 0;
    this.body.position.y = P.y; this.body.scale.set(1, 1, 1);
    this.face.open = 1; this.face.arc = 0; this.face.w = 1; this.face.tilt = 0; this.face.dy = 0;
    this.updateFace(1, 0, 'normal');
    for (const o of [this.sweat, this.bubble, this.check, this.toolIcon, this.zzz, this.speech, this.ring, this.flame, this.hammer, this.lens, this.clip]) o.visible = false;
    if (this.photo.emote) {
      // a little emote above the head (re-using the tool icon sprite)
      if (this.toolIcon.userData.emoji !== this.photo.emote) {
        this.toolIcon.material.map = emojiTexture(this.photo.emote);
        this.toolIcon.material.needsUpdate = true;
        this.toolIcon.userData.emoji = this.photo.emote;
      }
      this.toolIcon.visible = true;
      this.toolIcon.scale.setScalar(0.26);
      this.toolIcon.position.y = 0.98;
    }
    return true;
  }

  /**
   * Faces with feelings. Eyes ease toward each mood:
   * normal (blinks) · focused (narrowed) · worried (smaller, tilted inward, a tiny wobble) ·
   * happy (^ ^ arcs) · sleep (closed ∪ arcs; one eye peeks when you come close).
   */
  updateFace(ph, dt, mood) {
    const f = this.face;
    const T = { open: 1, w: 1, tilt: 0, dy: 0, arc: 0, flip: 0 };
    if (mood === 'focused') { T.open = 0.6; T.dy = -0.004; }
    else if (mood === 'worried') { T.open = 1.05; T.w = 0.8; T.tilt = 0.55; T.dy = 0.003; }
    else if (mood === 'happy') { T.open = 0; T.arc = 1; }
    else if (mood === 'sleep') { T.open = 0; T.arc = 1; T.flip = 1; }
    const peek = mood === 'sleep' && this.noticed; // napping: one eye peeks open at you
    const k = damp(9, dt);
    for (const key of ['open', 'w', 'tilt', 'dy']) f[key] += (T[key] - f[key]) * k;
    // swap ∩ ↔ ∪ only while the arcs are (nearly) hidden, so they never visibly flip
    if (f.flip !== T.flip && f.arc < 0.15) f.flip = T.flip;
    f.arc += ((f.flip === T.flip ? T.arc : 0) - f.arc) * k;
    const blink = mood === 'normal' || mood === 'focused' ? ((ph % 3.7) < 0.12 ? 0.15 : 1) : 1;
    const wob = mood === 'worried' ? Math.sin(ph * 15) * 0.0016 : 0;
    for (let i = 0; i < 2; i++) {
      const e = this.eyes[i], sx = e.userData.sx;
      const open = peek && i === 1 ? 0.55 : f.open;
      e.visible = open > 0.03;
      e.scale.set(f.w, EYE_H * Math.max(0.001, open * blink) * f.w, 0.55);
      e.rotation.z = -sx * f.tilt; // tops lean toward the middle: worried
      e.position.set(sx * 0.047 + wob, 0.07 + f.dy, 0.161);
      const a = this.arcs[i];
      const arc = peek && i === 1 ? 0 : f.arc;
      a.visible = arc > 0.03;
      a.scale.setScalar(Math.max(0.001, arc));
      a.rotation.z = f.flip ? Math.PI : 0;
      a.position.y = f.flip ? 0.074 : 0.064 + Math.sin(ph * 4) * 0.0012 * arc; // happy eyes bob a little
    }
  }

  strike() {
    const s = this.site;
    const pos = tmpV.copy(s.propDir).multiplyScalar(groundR(s.propDir) + 0.1);
    this.env.fx.sparks(pos, s.propDir, 4);
    const ud = s.prop.userData;
    ud.hits = (ud.hits ?? 0) + 1;
    if (ud.hits % 6 === 0) {
      if (ud.stack >= ud.crates.length) {
        ud.crates.forEach((c, i) => (c.visible = i < 2));
        ud.stack = 2;
        this.env.fx.puff(tmpV.copy(s.propDir).multiplyScalar(groundR(s.propDir)), s.propDir, 8);
      } else ud.crates[ud.stack++].visible = true;
    }
  }

  updateFidget(t, ph, P, status, dt) {
    if (!this.fidget && (this.nextFidget -= dt) <= 0) {
      // idle crews entertain themselves: sometimes a seated fidget, sometimes they get up and dance
      const DANCES = ['bounce', 'sway', 'spin', 'robot', 'juggle'];
      const dance = Math.random() < 0.45;
      const kinds = dance ? DANCES : status === 'done' ? ['cheer', 'look', 'wave', 'warm', 'nod'] : ['warm', 'stretch', 'look', 'nod', 'wave', 'warm'];
      const len = dance ? 3 + Math.random() * 2.5 : 1.6 + Math.random() * 1.8;
      this.fidget = { kind: kinds[Math.floor(Math.random() * kinds.length)], from: t, until: t + len, side: Math.random() < 0.5 ? -1 : 1, dance };
    }
    if (this.fidget && t > this.fidget.until) { this.fidget = null; this.nextFidget = 3 + Math.random() * 8; }
    const f = this.fidget;
    if (!f) return;
    switch (f.kind) {
      case 'warm': P.aLx = P.aRx = -1.25; P.aLz = -0.1; P.aRz = 0.1; P.hx = 0.1; break;
      case 'stretch': P.aLz = -2.85; P.aRz = 2.85; P.rx = -0.18; P.hx = -0.25; break;
      case 'look': P.hy = f.side * 0.75 * Math.min(1, Math.sin(((f.until - t) / 1.6) * Math.PI) * 1.5); break;
      case 'nod': P.hx = Math.sin(ph * 9) * 0.22; P.aRx = -0.8 + Math.sin(ph * 5) * 0.2; break;
      case 'wave': P.aRz = 2.4 + Math.sin(ph * 13) * 0.4; P.hy = f.side * 0.4; break;
      case 'cheer': P.aLz = -2.6 + Math.sin(ph * 10) * 0.2; P.aRz = 2.6 - Math.sin(ph * 10) * 0.2; break;
    }
    if (!f.dance) return;
    // ── dances: stand up first ──
    P.lL = P.lR = 0; P.y = 0; P.rx = 0; P.hx = 0;
    const u = t - f.from, beat = ph * 7;
    switch (f.kind) {
      case 'bounce': // hop on the beat, arms pumping in turn
        P.y = Math.abs(Math.sin(beat)) * 0.07;
        P.aLz = -1.2 - Math.max(0, Math.sin(beat)) * 1.4; P.aRz = 1.2 + Math.max(0, -Math.sin(beat)) * 1.4;
        P.lL = Math.max(0, Math.sin(beat)) * -0.5; P.lR = Math.max(0, -Math.sin(beat)) * -0.5;
        break;
      case 'sway': // arms up, swaying side to side
        P.aLz = -2.5 + Math.sin(beat * 0.5) * 0.3; P.aRz = 2.5 + Math.sin(beat * 0.5) * 0.3;
        P.by = Math.sin(beat * 0.5) * 0.5; P.hy = Math.sin(beat * 0.5) * 0.3; P.y = Math.abs(Math.sin(beat * 0.5)) * 0.02;
        break;
      case 'spin': // a little twirl, arms out
        P.spin = true; P.by = f.side * Math.min(1, u / 1.4) * Math.PI * 2 * Math.floor(1 + u / 1.4);
        P.aLz = -1.5; P.aRz = 1.5; P.y = Math.abs(Math.sin(u * 4.5)) * 0.03;
        break;
      case 'robot': { // stiff, snappy arm poses
        const step = Math.floor(u * 2.5) % 4;
        const poses = [[-1.6, 1.6, 0, 0], [-0.3, 2.9, -1.4, 0], [-2.9, 0.3, 0, -1.4], [-1.6, 1.6, -1.5, -1.5]];
        [P.aLz, P.aRz, P.aLx, P.aRx] = poses[step];
        P.hy = [0, 0.5, -0.5, 0][step]; P.by = [0, 0.3, -0.3, 0][step];
        break;
      }
      case 'juggle': // hands bouncing up and down in turn, eyes up
        P.aLx = -1.2 + Math.sin(beat * 1.6) * 0.5; P.aRx = -1.2 + Math.sin(beat * 1.6 + Math.PI) * 0.5;
        P.aLz = -0.3; P.aRz = 0.3; P.hx = -0.45; P.hy = Math.sin(beat * 0.8) * 0.25;
        break;
    }
  }

  dispose() {
    this.env.world.remove(this.root);
    if (this.site) this.env.world.remove(this.site.prop);
    for (const o of this.oldProps ?? []) this.env.world.remove(o.prop);
    for (const m of [this.ringMat, this.bulbMat, this.bubble.material, this.check.material, this.toolIcon.material, this.zzz.material, this.speech.material, this.sweat.material]) m.dispose();
  }
}

export { orient, surfaceQuat };
