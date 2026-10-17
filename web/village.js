// The growing village: every project gets a plot whose house grows with the work you've done there.
// Data comes from village.mjs on the server: { projects: [{ key, name, turns, edits, commands, sessions, firstAt, lastAt }] }.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { piece, at, place, groundR, height, offsetDir, surfaceQuat, makeRand, WATER } from './world.js';
import { ACCENTS, hashStr } from './astronaut.js';
import { colorFor, biomeFor } from './colors.js';

// Finished turns needed for each level: tent, hut, cottage, house, two-storey, tower, observatory
export const LEVELS = [1, 5, 15, 40, 100, 250, 600];
export const LEVEL_NAMES = ['tent', 'hut', 'cottage', 'house', 'two-storey house', 'tower', 'observatory'];
export const levelOf = (turns) => LEVELS.reduce((l, need, i) => (turns >= need ? i + 1 : l), 0);
const MAX_PLOTS = 14;
export const IDLE_DAYS = 60; // untouched this long → the project's country and house vanish
const BUILDING_SCALE = 1.75; // buildings are modelled small; this makes a house taller than an astronaut

const G = {
  tent: new THREE.ConeGeometry(0.11, 0.15, 4, 1),
  box: new THREE.BoxGeometry(1, 1, 1),
  roof: new THREE.ConeGeometry(1, 1, 4, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 8),
  dome: new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
  stone: new THREE.CylinderGeometry(0.022, 0.026, 0.01, 6),
  bud: new THREE.IcosahedronGeometry(0.018, 0),
  post: new THREE.BoxGeometry(0.012, 0.05, 0.012),
  rail: new THREE.BoxGeometry(0.1, 0.008, 0.008),
};
const WALL = ['#fff6e8', '#f6efe2', '#fdf3f0', '#eef3ff'];
const FLOWERS = ['#ff9aa8', '#fff1a8', '#ffffff', '#a8d8ff', '#c9b5f5'];

const S = (x, y, z) => new THREE.Vector3(x, y, z);

/** All the pieces for one building at a given level (local coords, y up, door facing +z). */
function building(level, roofC, wallC, rand) {
  const p = [];
  const door = '#8a5a44', glass = '#bfe9ff', stone = '#cfc8dc';
  if (level <= 1) {
    p.push(piece(G.tent, roofC, at(0, 0.075, 0, 0, Math.PI / 4, 0)));
    p.push(piece(G.box, door, at(0, 0.035, 0.06, -0.35, 0, 0, S(0.05, 0.06, 0.005))));
    return p;
  }
  const W = [0, 0, 0.13, 0.17, 0.2, 0.22, 0.22, 0.22][level], H = [0, 0, 0.09, 0.11, 0.12, 0.2, 0.2, 0.2][level];
  p.push(piece(G.box, wallC, at(0, H / 2, 0, 0, 0, 0, S(W, H, W * 0.85))));
  p.push(piece(G.roof, roofC, at(0, H + 0.055 + level * 0.004, 0, 0, Math.PI / 4, 0, S(W * 0.78, 0.1 + level * 0.01, W * 0.7))));
  p.push(piece(G.box, door, at(0, 0.03, W * 0.43, 0, 0, 0, S(0.035, 0.06, 0.006))));
  if (level >= 3) {
    p.push(piece(G.box, glass, at(-W * 0.28, H * 0.6, W * 0.43, 0, 0, 0, S(0.028, 0.028, 0.006))));
    p.push(piece(G.box, glass, at(W * 0.28, H * 0.6, W * 0.43, 0, 0, 0, S(0.028, 0.028, 0.006))));
  }
  if (level >= 4) {
    p.push(piece(G.box, '#b9a6a0', at(W * 0.28, H + 0.09, -W * 0.15, 0, 0, 0, S(0.03, 0.09, 0.03)))); // chimney
    if (level >= 5) p.push(piece(G.box, glass, at(0, H * 0.82, W * 0.43, 0, 0, 0, S(0.04, 0.03, 0.006))));
  }
  if (level >= 6) {
    // a round tower beside the house
    const tx = -W * 0.62;
    p.push(piece(G.cyl, stone, at(tx, 0.16, -0.02, 0, 0, 0, S(0.05, 0.32, 0.05))));
    p.push(piece(G.roof, roofC, at(tx, 0.37, -0.02, 0, 0, 0, S(0.065, 0.1, 0.065))));
    p.push(piece(G.box, glass, at(tx, 0.24, 0.03, 0, 0, 0, S(0.02, 0.03, 0.006))));
  }
  if (level >= 7) {
    // observatory dome with a telescope slot on the other side
    const ox = W * 0.75;
    p.push(piece(G.cyl, wallC, at(ox, 0.05, -0.02, 0, 0, 0, S(0.07, 0.1, 0.07))));
    p.push(piece(G.dome, '#c9c6d8', at(ox, 0.1, -0.02, 0, 0, 0, S(0.07, 0.07, 0.07))));
    p.push(piece(G.cyl, '#4b4766', at(ox + 0.02, 0.16, -0.02, 0, 0, -0.8, S(0.012, 0.09, 0.012))));
  }
  return p;
}

const plotKey = (name) => String(name).trim().toLowerCase();

export function createVillage({ world, fx, campDir, campRadius }) {
  const group = new THREE.Group();
  world.add(group);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  let pathMesh = null;
  /** key → { key, name, dir, level, mesh, grow, chimney, turns, project } */
  const plots = new Map();
  const taken = [];

  /**
   * Where a project's home goes: the dry, flat-ish spot farthest from every other home (and the camp),
   * so each continent gets room to spread. Biggest projects are placed first and get the best spots.
   */
  function plotDir(key) {
    const rand = makeRand((hashStr(key) % 2147483646) + 1);
    let best = null, bestScore = -1;
    for (let i = 0; i < 90; i++) {
      const d = offsetDir(campDir, rand() * Math.PI * 2, campRadius + 0.3 + rand() * 2.1);
      if (height(d) < WATER + 0.035) continue;
      let lo = Infinity;
      for (let k = 0; k < 6; k++) lo = Math.min(lo, height(offsetDir(d, (k / 6) * Math.PI * 2, 0.07)));
      if (lo < WATER + 0.02) continue;
      const score = Math.min(d.angleTo(campDir) - campRadius * 0.6, ...taken.map((t) => t.angleTo(d)));
      if (score > bestScore) { bestScore = score; best = d; }
    }
    best ??= offsetDir(campDir, rand() * Math.PI * 2, campRadius + 0.3 + rand() * 0.8);
    taken.push(best);
    return best;
  }

  function buildPlot(p, proj) {
    const rand = makeRand((hashStr(proj.key) % 2147483646) + 7);
    const roofC = colorFor(proj.name) || ACCENTS[hashStr(proj.key) % ACCENTS.length];
    p.color = roofC;
    const wallC = WALL[hashStr(proj.key + 'w') % WALL.length];
    const geos = [];
    // face the door toward camp
    const toCamp = campDir.clone().sub(p.dir).projectOnPlane(p.dir).normalize();
    const q = surfaceQuat(p.dir);
    const localFwd = toCamp.clone().applyQuaternion(q.clone().invert());
    const yaw = Math.atan2(localFwd.x, localFwd.z);
    geos.push(...place(building(p.level, roofC, wallC, rand), p.dir, yaw, BUILDING_SCALE, 0.012));
    // garden: one flower per ~15 edits, up to 18, scattered around the house
    const flowers = Math.min(18, Math.floor((proj.edits || 0) / 15));
    for (let i = 0; i < flowers; i++) {
      const d = offsetDir(p.dir, rand() * Math.PI * 2, 0.11 + rand() * 0.07);
      if (height(d) < WATER + 0.01) continue;
      geos.push(...place([piece(G.bud, FLOWERS[i % FLOWERS.length], at(0, 0.02, 0))], d, 0, 1));
    }
    // a little fence for houses and up
    if (p.level >= 4) {
      for (let i = 0; i < 9; i++) {
        const th = yaw + Math.PI * 0.35 + (i / 8) * Math.PI * 1.3;
        const d = offsetDir(p.dir, th, 0.16);
        geos.push(...place([piece(G.post, '#e6d3b8', at(0, 0.025, 0)), piece(G.rail, '#e6d3b8', at(0, 0.035, 0))], d, th + Math.PI / 2, 1));
      }
    }
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
    return mesh;
  }

  function rebuildPaths() {
    if (pathMesh) { group.remove(pathMesh); pathMesh.geometry.dispose(); }
    const geos = [];
    for (const p of plots.values()) {
      const total = p.dir.angleTo(campDir);
      const from = campRadius - 0.12;
      for (let a = from; a < total - 0.09; a += 0.055) {
        // walk along the great circle from camp toward the plot
        const d = new THREE.Vector3().copy(campDir).multiplyScalar(Math.sin(total - a))
          .addScaledVector(p.dir, Math.sin(a)).divideScalar(Math.sin(total)).normalize();
        if (height(d) < WATER + 0.005) continue;
        geos.push(...place([piece(G.stone, '#e9dfcc')], d, a * 7, 1, 0.004));
      }
    }
    if (!geos.length) return;
    pathMesh = new THREE.Mesh(mergeGeometries(geos), mat);
    group.add(pathMesh);
  }

  let smokeT = 0;
  const api = {
    plots,
    /** Continent seeds for world.setContinents: every home whose project has a colour. */
    seeds() {
      const out = [];
      for (const p of plots.values()) {
        const color = colorFor(p.name);
        if (!color || p.vanishing) continue;
        // country radius: ~0.3 rad for a light touch, up to ~0.78 rad for your busiest project
        out.push({ name: p.name, dir: p.dir, color, biome: biomeFor(p.name), weight: 0.3 + 0.48 * (p.footprint ?? 0.3) });
      }
      return out;
    },
    /** Home plot direction for a project name (houses are keyed by display name). */
    homeOf(name) { const p = name ? plots.get(plotKey(name)) : null; return p && !p.vanishing ? p.dir : null; },
    /** A spot around a project's house for its i-th resident. */
    homeSpot(name, i = 0) {
      const home = this.homeOf(name);
      // up to 6 residents in a loose ring around the house
      return home ? offsetDir(home, i * 1.05 + 0.5, 0.16 + (i % 2) * 0.05) : null;
    },
    /**
     * Merge Claude Code history (village) and Cowork groups into one house per project name.
     * Returns the plots that just grew a level (for sound).
     */
    /**
     * activity: Map(lower-case name → { score, lastAt }) — recent use. Projects untouched for
     * IDLE_DAYS vanish; the rest get a country whose size follows their score.
     */
    update(village, { animate = true, cowork = [], names = {}, activity = null } = {}) {
      const grew = [];
      const byName = new Map();
      const add = (name, data) => {
        const k = plotKey(name);
        const cur = byName.get(k) ?? { key: k, name, turns: 0, edits: 0, commands: 0, sessions: 0, coworkSessions: 0, firstAt: Infinity, lastAt: 0 };
        cur.turns += data.turns || 0; cur.edits += data.edits || 0; cur.sessions += data.sessions || 0;
        cur.coworkSessions += data.coworkSessions || 0;
        cur.firstAt = Math.min(cur.firstAt, data.firstAt ?? Infinity); cur.lastAt = Math.max(cur.lastAt, data.lastAt || 0);
        byName.set(k, cur);
      };
      for (const p of village?.projects || []) if (p.turns > 0) add(names[p.key] || p.name, p);
      // a Cowork session counts like a few finished turns, so busy Cowork projects get real houses
      for (const g of cowork) if (g.sessions?.length) add(g.name, { turns: g.sessions.length * 6, coworkSessions: g.sessions.length, sessions: g.sessions.length });
      // every Cowork project needs a home for its crew; history-only projects fill the remaining plots
      const now = Date.now();
      const act = (p) => activity?.get(plotKey(p.name));
      const recent = (p) => {
        const a = act(p);
        const last = Math.max(p.lastAt || 0, a?.lastAt || 0);
        return now - last < IDLE_DAYS * 86400000 || (a?.score || 0) > 0.5;
      };
      const all = [...byName.values()].filter(recent).sort((a, b) => (act(b)?.score || 0) - (act(a)?.score || 0) || b.turns - a.turns);
      const projects = all.slice(0, MAX_PLOTS);
      const maxScore = Math.max(1, ...projects.map((p) => act(p)?.score || 0));
      for (const p of projects) p.footprint = Math.sqrt((act(p)?.score || 0) / maxScore); // 0…1
      // projects that went quiet: their house sinks away
      const keep = new Set(projects.map((p) => p.key));
      for (const [k, p] of plots) {
        if (keep.has(k) || p.vanishing) continue;
        p.vanishing = 1;
        const ti = taken.indexOf(p.dir);
        if (ti >= 0) taken.splice(ti, 1);
      }
      let changedPaths = false;
      for (const proj of projects) {
        const level = levelOf(proj.turns);
        let p = plots.get(proj.key);
        if (!p) {
          p = { key: proj.key, dir: plotDir(proj.key), level: 0, mesh: null, grow: animate ? 0 : 1 };
          plots.set(proj.key, p);
          changedPaths = true;
        }
        p.name = proj.name;
        p.turns = proj.turns;
        p.project = proj;
        p.footprint = proj.footprint ?? 0.3;
        if (p.vanishing) { p.vanishing = 0; p.grow = 0; } // came back: grow again
        if (level !== p.level) {
          if (p.level && level > p.level) grew.push(p);
          p.level = level;
          if (p.mesh) { group.remove(p.mesh); p.mesh.geometry.dispose(); }
          p.mesh = buildPlot(p, proj);
          group.add(p.mesh);
          if (animate && p.grow >= 1) {
            p.grow = 0;
            fx.puff(p.dir.clone().multiplyScalar(groundR(p.dir)), p.dir, 12);
            fx.confetti(p.dir.clone().multiplyScalar(groundR(p.dir)), p.dir, 20);
          }
        } else if (p.mesh && colorFor(proj.name) && colorFor(proj.name) !== p.color) {
          // project got (or changed) its colour: repaint the roof
          group.remove(p.mesh); p.mesh.geometry.dispose();
          p.mesh = buildPlot(p, proj);
          group.add(p.mesh);
        }
      }
      void changedPaths; // (stepping-stone paths removed: they made the planet look messy)
      return grew;
    },
    tick(t, dt) {
      for (const [k, p] of plots) {
        if (!p.vanishing) continue;
        p.vanishing += dt * 0.8;
        const s = Math.max(0.001, 2 - p.vanishing);
        if (p.mesh) { p.mesh.scale.setScalar(s); p.mesh.position.copy(p.dir).multiplyScalar(groundR(p.dir) * (1 - s)); }
        if (p.vanishing >= 2) { if (p.mesh) { group.remove(p.mesh); p.mesh.geometry.dispose(); } plots.delete(k); }
      }
      for (const p of plots.values()) {
        if (p.vanishing) continue;
        if (p.grow >= 1 || !p.mesh) continue;
        p.grow = Math.min(1, p.grow + dt * 1.8);
        const k = p.grow;
        // grow from the ground with a little overshoot
        const s = Math.max(0.001, 1 + Math.sin(k * Math.PI * 1.3) * (1 - k) * 0.35 - (1 - k) ** 2);
        p.mesh.scale.setScalar(s);
        p.mesh.position.copy(p.dir).multiplyScalar(groundR(p.dir) * (1 - s));
      }
      // chimney smoke from houses that saw work in the last day
      if ((smokeT -= dt) <= 0) {
        smokeT = 0.7;
        const now = Date.now();
        for (const p of plots.values()) {
          if (p.level < 4 || now - (p.project?.lastAt || 0) > 86400000) continue;
          fx.smoke?.(p.dir.clone().multiplyScalar(groundR(p.dir) + 0.24 * BUILDING_SCALE), p.dir);
        }
      }
    },
    /** Nearest plot to a world-local point within `maxAngle`, for hover/click. */
    pick(localPoint, maxAngle = 0.09) {
      const n = localPoint.clone().normalize();
      let best = null, ba = maxAngle;
      for (const p of plots.values()) { const a = p.dir.angleTo(n); if (a < ba) { ba = a; best = p; } }
      return best;
    },
  };
  return api;
}
