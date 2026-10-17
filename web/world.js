// The planet: terrain, water, scenery (baked into one draw call), the camp, clouds, moon, stars.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const R = 3;
export const WATER = -0.04;
export const UP = new THREE.Vector3(0, 1, 0);

/** Smooth, cheap, analytic terrain so astronauts can sample the exact surface. */
export function height(n) {
  return 0.13 * Math.sin(2.7 * n.x + 1.3) * Math.sin(2.9 * n.y + 0.4) * Math.sin(2.3 * n.z + 2.1)
       + 0.06 * Math.sin(6.1 * n.x + 4.2 * n.z) * Math.cos(5.3 * n.y - 1.1)
       + 0.03 * Math.sin(11 * n.y + 7 * n.x);
}
export const groundR = (n) => R + Math.max(height(n), WATER);

export function makeRand(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

/** Point on the unit sphere `ang` radians away from `center`, in tangent direction `theta`. */
export function offsetDir(center, theta, ang, out = new THREE.Vector3()) {
  const ref = Math.abs(center.y) < 0.95 ? UP : new THREE.Vector3(1, 0, 0);
  const t1 = new THREE.Vector3().crossVectors(ref, center).normalize();
  const t2 = new THREE.Vector3().crossVectors(center, t1);
  return out.copy(center).multiplyScalar(Math.cos(ang))
    .addScaledVector(t1, Math.cos(theta) * Math.sin(ang))
    .addScaledVector(t2, Math.sin(theta) * Math.sin(ang))
    .normalize();
}

/** Orientation that stands an object on the surface at `n`, rotated `yaw` about the normal. */
export function surfaceQuat(n, yaw = 0, out = new THREE.Quaternion()) {
  out.setFromUnitVectors(UP, n);
  return yaw ? out.multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw)) : out;
}

// ── baking: many little meshes → one vertex-colored geometry ─────────────
const tmpM = new THREE.Matrix4();
export function piece(geo, color, local) {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.deleteAttribute('uv');
  if (local) g.applyMatrix4(local);
  const c = new THREE.Color(color);
  const arr = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < arr.length; i += 3) { arr[i] = c.r; arr[i + 1] = c.g; arr[i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
export const at = (x, y, z, rx = 0, ry = 0, rz = 0, s = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    typeof s === 'number' ? new THREE.Vector3(s, s, s) : s);

export function place(pieces, n, yaw, scale, sink = 0.01) {
  const pos = n.clone().multiplyScalar(groundR(n) - sink);
  tmpM.compose(pos, surfaceQuat(n, yaw), new THREE.Vector3(scale, scale, scale));
  return pieces.map((p) => p.applyMatrix4(tmpM));
}

// Shared primitive geometries for scenery
const P = {
  trunk: new THREE.CylinderGeometry(0.025, 0.035, 0.13, 5),
  cone1: new THREE.ConeGeometry(0.14, 0.24, 6),
  cone2: new THREE.ConeGeometry(0.1, 0.18, 6),
  blob: new THREE.IcosahedronGeometry(0.13, 0),
  rock: new THREE.DodecahedronGeometry(0.08, 0),
  bud: new THREE.IcosahedronGeometry(0.022, 0),
  log: new THREE.CylinderGeometry(0.03, 0.03, 0.2, 6),
  stone: new THREE.DodecahedronGeometry(0.03, 0),
  tent: new THREE.ConeGeometry(0.17, 0.2, 4, 1),
  tentDoor: new THREE.PlaneGeometry(0.07, 0.1),
  seat: new THREE.CylinderGeometry(0.035, 0.035, 0.14, 6),
  dome: new THREE.SphereGeometry(0.2, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
  pole: new THREE.CylinderGeometry(0.008, 0.008, 0.38, 5),
  post: new THREE.CylinderGeometry(0.012, 0.012, 0.3, 5),
  board: new THREE.BoxGeometry(0.2, 0.12, 0.015),
};
const C = {
  pine: '#5fb879', pine2: '#79c98a', trunk: '#b48a6a', rock: '#b9b3cc',
  blossom: ['#f7b6c8', '#ffd59a', '#c9b5f5'], flower: ['#ff9aa8', '#fff1a8', '#ffffff', '#a8d8ff'],
  log: '#9c6b4e', stone: '#a7a1bb', tent: ['#f6a6b2', '#9ad0f5', '#ffd27f', '#b9a6f6', '#8fe0c0'], dome: '#f2a481', door: '#7a4b3a',
};

function tree(rand) {
  const kind = rand();
  if (kind < 0.55) {
    const c = rand() < 0.5 ? C.pine : C.pine2;
    return [piece(P.trunk, C.trunk, at(0, 0.065, 0)), piece(P.cone1, c, at(0, 0.2, 0)), piece(P.cone2, c, at(0, 0.32, 0))];
  }
  return [piece(P.trunk, C.trunk, at(0, 0.07, 0)), piece(P.blob, C.blossom[Math.floor(rand() * 3)], at(0, 0.22, 0))];
}

// What grows on each continent (one look per palette colour — the secondary cue besides the name)
const BP = {
  cap: new THREE.ConeGeometry(0.05, 0.07, 6),
  leaf: new THREE.ConeGeometry(0.03, 0.16, 4),
  stem: new THREE.CylinderGeometry(0.006, 0.006, 0.12, 4),
  bush: new THREE.ConeGeometry(0.02, 0.07, 5),
  palmTrunk: new THREE.CylinderGeometry(0.014, 0.022, 0.3, 5),
};
function biomePieces(biome, r, small) {
  const trunk = (h = 0.065) => piece(P.trunk, C.trunk, at(0, h, 0));
  if (small) {
    // little ground cover in the biome's colours
    const c = { snowpine: '#ffffff', autumn: '#f0a04b', palm: '#ffd36b', sunflower: '#ffcc33', blossom: '#ffb7d0', pine: '#7fc48f', lavender: '#9b7fe0', maple: '#e0584f' }[biome];
    return Array.from({ length: 4 }, () => piece(P.bud, c, at((r() - 0.5) * 0.16, 0.025, (r() - 0.5) * 0.16)));
  }
  switch (biome) {
    case 'snowpine': return [trunk(), piece(P.cone1, '#5f8f7a', at(0, 0.2, 0)), piece(P.cone2, '#6fa08a', at(0, 0.32, 0)), piece(BP.cap, '#ffffff', at(0, 0.39, 0))];
    case 'autumn': return [trunk(0.07), piece(P.blob, r() < 0.5 ? '#f0a04b' : '#e07b39', at(0, 0.22, 0))];
    case 'palm': {
      const p = [piece(BP.palmTrunk, '#b48a6a', at(0, 0.15, 0, 0, 0, 0.12))];
      for (let k = 0; k < 5; k++) p.push(piece(BP.leaf, '#3fae6a', at(Math.sin(k * 1.26) * 0.06 + 0.02, 0.3, Math.cos(k * 1.26) * 0.06, Math.cos(k * 1.26) * 1.1, 0, -Math.sin(k * 1.26) * 1.1)));
      return p;
    }
    case 'sunflower': return Array.from({ length: 3 }, (_, k) => [
      piece(BP.stem, '#5f9e4f', at((k - 1) * 0.04, 0.06, (r() - 0.5) * 0.05)),
      piece(P.bud, '#ffcc33', at((k - 1) * 0.04, 0.125, 0, 0, 0, 0, 1.4)),
    ]).flat();
    case 'blossom': return [trunk(0.07), piece(P.blob, '#ffb7d0', at(0, 0.22, 0)), piece(P.bud, '#ffe1ec', at(0.05, 0.28, 0.03, 0, 0, 0, 2))];
    case 'pine': return [trunk(), piece(P.cone1, '#2f7d55', at(0, 0.2, 0)), piece(P.cone2, '#3a8f60', at(0, 0.32, 0))];
    case 'lavender': return Array.from({ length: 5 }, () => {
      const x = (r() - 0.5) * 0.12, z = (r() - 0.5) * 0.12;
      return [piece(BP.stem, '#6f9e5f', at(x, 0.03, z, 0, 0, 0, new THREE.Vector3(1, 0.5, 1))), piece(BP.bush, '#9b7fe0', at(x, 0.08, z))];
    }).flat();
    case 'maple': return [trunk(0.07), piece(P.blob, '#e0584f', at(0, 0.22, 0)), piece(P.bud, '#c4453d', at(-0.05, 0.27, 0.02, 0, 0, 0, 2))];
  }
  return tree(r);
}

export function buildWorld(scene, camera, { stars = 400, starRadius = [12, 40] } = {}) {
  const rand = makeRand(7);
  const randomDir = () => new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
  const world = new THREE.Group();
  scene.add(world);

  // ── terrain ──
  const terrain = { attr: null, base: null, tris: [] };
  // Countries are coloured per pixel (not per triangle) so borders stay smooth and crisp:
  // each fragment finds its nearest project "capital" (power distance: angle − radius). Inside a radius it
  // takes that country's colour; ink lines mark country edges and shared borders. Index 0 is the camp (neutral).
  const MAXC = 10;
  const cUniforms = {
    uSeedDir: { value: Array.from({ length: MAXC }, () => new THREE.Vector4(0, 1, 0, 0)) },
    uSeedCol: { value: Array.from({ length: MAXC }, () => new THREE.Color('#ffffff')) },
    uCount: { value: 0 },
  };
  const terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  terrainMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, cUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDirP;\nvarying float vH;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvDirP = normalize(position);\nvH = length(position) - ${R.toFixed(1)};`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vDirP; varying float vH;
        uniform vec4 uSeedDir[${MAXC}]; uniform vec3 uSeedCol[${MAXC}]; uniform int uCount;
        // wobbly, organic coastlines instead of perfect circles (same formula as coastJS)
        float coast(vec3 n, float k) {
          return 0.045 * sin(6.0 * n.x + 2.1 * k + 1.0) * sin(7.0 * n.y + 1.3 * k) * sin(5.0 * n.z + 0.7 * k + 2.0)
               + 0.018 * sin(17.0 * n.x + 13.0 * n.z + k) ;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // fade the country colour out softly towards the waterline (no hard cut-offs or beige holes)
        float shore = smoothstep(${(WATER - 0.004).toFixed(3)}, ${(WATER + 0.03).toFixed(3)}, vH);
        if (uCount > 0 && shore > 0.0) {
          float b1 = 1e3, b2 = 1e3; int bi = -1;
          for (int i = 0; i < ${MAXC}; i++) {
            if (i >= uCount) break;
            float d = acos(clamp(dot(vDirP, uSeedDir[i].xyz), -1.0, 1.0)) - uSeedDir[i].w + coast(vDirP, float(i));
            if (d < b1) { b2 = b1; b1 = d; bi = i; } else if (d < b2) { b2 = d; }
          }
          if (bi > 0 && b1 < 0.0) {
            vec3 c = uSeedCol[0];
            for (int i = 1; i < ${MAXC}; i++) { if (i == bi) c = uSeedCol[i]; }
            // keep a little of the terrain's own light/dark variation, so hills still read
            float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
            vec3 tint = mix(c, vec3(1.0), clamp((lum - 0.72) * 1.4, 0.0, 0.45));
            diffuseColor.rgb = mix(diffuseColor.rgb, tint, 0.78 * shore);
            // ink: the country's outline, and the line where two countries meet
            float edge = -b1;                       // distance inside its own coast
            float shared = (b2 < 0.0) ? (b2 - b1) : 1.0; // distance to the neighbour's territory
            float line = min(edge, shared * 0.5);
            float ink = 1.0 - smoothstep(0.016, 0.024, line);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.17, 0.15, 0.27), ink * 0.82 * shore);
          }
        }`);
  };
  {
    const geo = new THREE.IcosahedronGeometry(R, 7);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).normalize();
      v.multiplyScalar(R + height(v));
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    const colors = new Float32Array(pos.count * 3);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const col = new THREE.Color();
    const sand = new THREE.Color('#f4e2b8'), grass = new THREE.Color('#a6d98f'), grass2 = new THREE.Color('#8bcc7f'),
      hill = new THREE.Color('#c3e6a4'), peak = new THREE.Color('#f6f1ea');
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
    world.add(new THREE.Mesh(geo, terrainMat));
    // remember every triangle (direction, height, original colour) so continents can recolour the land
    terrain.attr = geo.attributes.color;
    terrain.base = colors.slice();
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
      const h = (a.length() + b.length() + c.length()) / 3 - R;
      terrain.tris.push({ i, n: a.clone().add(b).add(c).normalize(), h, jit: Math.sin(i * 78.233) * 0.5 + 0.5 });
    }
    world.add(new THREE.Mesh(
      new THREE.IcosahedronGeometry(R + WATER, 6), // fine enough that the waterline doesn't step
      new THREE.MeshLambertMaterial({ color: '#8fd5e6', flatShading: true, transparent: true, opacity: 0.88 }),
    ));
  }

  // ── atmosphere ──
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.16, 40, 40), new THREE.ShaderMaterial({
    transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
    uniforms: { color: { value: new THREE.Color('#b7d6ff') } },
    vertexShader: `varying vec3 vN; varying vec3 vV;
      void main(){ vec4 mv = modelViewMatrix * vec4(position,1.); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 color; varying vec3 vN; varying vec3 vV;
      void main(){ float f = pow(1. - abs(dot(vN, vV)), 2.2); gl_FragColor = vec4(color, f * 0.55); }`,
  }));
  scene.add(atmo);

  // ── camp: pick the flattest dry spot so nobody sits in a lake ──
  let campDir = new THREE.Vector3(0.3, 0.8, 0.5).normalize(), best = -1;
  for (let i = 0; i < 160; i++) {
    const d = i === 0 ? campDir.clone() : randomDir();
    if (Math.abs(d.y) > 0.85) continue; // avoid the poles (awkward to orbit to)
    let lo = Infinity;
    for (let k = 0; k < 10; k++) for (const ang of [0, 0.2, 0.36]) lo = Math.min(lo, height(offsetDir(d, (k / 10) * Math.PI * 2, ang)));
    if (lo > best) { best = lo; campDir = d; }
  }
  const CAMP_RADIUS = 0.62;
  const seats = [];
  for (const [count, ang] of [[7, 0.16], [11, 0.27], [15, 0.38]]) {
    for (let k = 0; k < count; k++) seats.push({ dir: offsetDir(campDir, (k / count) * Math.PI * 2 + ang * 3, ang) });
  }

  const baked = [];
  // fire pit: ring of stones + crossed logs
  for (let k = 0; k < 9; k++) {
    const d = offsetDir(campDir, (k / 9) * Math.PI * 2, 0.045);
    baked.push(...place([piece(P.stone, C.stone, at(0, 0.015, 0, rand(), rand(), rand()))], d, rand() * 6, 1));
  }
  baked.push(...place([
    piece(P.log, C.log, at(0, 0.03, 0, Math.PI / 2, 0, 0.25)),
    piece(P.log, C.log, at(0, 0.03, 0, Math.PI / 2, Math.PI / 2, -0.25)),
  ], campDir, 0, 1));
  // log seats around the inner ring
  for (let k = 0; k < 6; k++) {
    const d = offsetDir(campDir, (k / 6) * Math.PI * 2 + 0.3, 0.215);
    baked.push(...place([piece(P.seat, C.log, at(0, 0.03, 0, 0, 0, Math.PI / 2))], d, (k / 6) * Math.PI * 2, 1));
  }
  // tents on the outside
  for (let k = 0; k < 5; k++) {
    const theta = (k / 5) * Math.PI * 2 + 0.6;
    const d = offsetDir(campDir, theta, 0.5);
    const color = C.tent[k % C.tent.length];
    baked.push(...place([piece(P.tent, color, at(0, 0.1, 0, 0, Math.PI / 4, 0)), piece(P.tentDoor, C.door, at(0, 0.05, 0.085, -0.2, 0, 0))], d, rand() * 6, 1));
  }
  // home dome + task board post
  const domeDir = offsetDir(campDir, 4.0, 0.5);
  baked.push(...place([piece(P.dome, C.dome), piece(P.pole, '#ffffff', at(0.15, 0.19, 0))], domeDir, 1.2, 1, 0.02));
  const boardDir = offsetDir(campDir, 2.2, 0.47);
  baked.push(...place([piece(P.post, C.log, at(0, 0.15, 0)), piece(P.board, '#e9d5b5', at(0, 0.27, 0))], boardDir, 0, 1));

  // ── scenery: trees, rocks, flowers — kept out of the camp clearing ──
  // Stored as records so each continent can grow its own vegetation (re-baked when continents change).
  const wild = [];
  let placed = 0, tries = 0;
  while (placed < 75 && tries++ < 2000) {
    const n = randomDir();
    if (height(n) < WATER + 0.04 || n.angleTo(campDir) < CAMP_RADIUS) continue;
    wild.push({ n, kind: rand(), s: 0.7 + rand() * 0.6, yaw: rand() * 6, seed: Math.floor(rand() * 1e9) });
    placed++;
  }
  // a few trees ringing the camp, for coziness
  for (let k = 0; k < 8; k++) {
    const d = offsetDir(campDir, (k / 8) * Math.PI * 2 + 0.2, 0.66 + rand() * 0.08);
    if (height(d) > WATER + 0.03) baked.push(...place(tree(rand), d, rand() * 6, 0.9 + rand() * 0.3));
  }
  const sceneryMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  world.add(new THREE.Mesh(mergeGeometries(baked), sceneryMat)); // camp: never changes
  let wildMesh = null;
  function bakeWild(biomeAt = () => null) {
    const geos = [];
    for (const w of wild) {
      const r = makeRand(w.seed);
      const biome = biomeAt(w.n);
      let pieces;
      if (w.kind >= 0.62 && w.kind < 0.8) pieces = [piece(P.rock, C.rock, at(0, 0.02, 0, r() * 3, r() * 3, r() * 3, new THREE.Vector3(1, 0.7, 1)))];
      else if (biome) pieces = biomePieces(biome, r, w.kind >= 0.8);
      else if (w.kind < 0.62) pieces = tree(r);
      else pieces = Array.from({ length: 4 }, () => piece(P.bud, C.flower[Math.floor(r() * 4)], at((r() - 0.5) * 0.16, 0.025, (r() - 0.5) * 0.16)));
      geos.push(...place(pieces, w.n, w.yaw, w.s));
    }
    if (wildMesh) { world.remove(wildMesh); wildMesh.geometry.dispose(); }
    wildMesh = new THREE.Mesh(mergeGeometries(geos), sceneryMat);
    world.add(wildMesh);
  }
  bakeWild();

  // ── continents: tint the land around each project's home, rivers between them ──
  let continentKey = '';
  const coastJS = (n, k) => 0.045 * Math.sin(6 * n.x + 2.1 * k + 1) * Math.sin(7 * n.y + 1.3 * k) * Math.sin(5 * n.z + 0.7 * k + 2)
    + 0.018 * Math.sin(17 * n.x + 13 * n.z + k);
  function regionAt(n, all) {
    let b1 = Infinity, b2 = Infinity, best = null;
    for (let i = 0; i < all.length; i++) {
      const s = all[i];
      const d = n.angleTo(s.dir) - s.weight + coastJS(n, i);
      if (d < b1) { b2 = b1; b1 = d; best = s; } else if (d < b2) b2 = d;
    }
    return { best, b1, gap: b2 - b1 };
  }
  /**
   * seeds: [{ name, dir, color, weight (country radius in radians), biome }].
   * Updates the shader's capitals (cheap) and re-grows vegetation only when the map really changed.
   */
  function setContinents(seeds) {
    const list = seeds.slice(0, MAXC - 1);
    const all = [{ dir: campDir, weight: CAMP_RADIUS * 0.75, neutral: true }, ...list];
    all.forEach((sd, i) => {
      cUniforms.uSeedDir.value[i].set(sd.dir.x, sd.dir.y, sd.dir.z, sd.weight);
      if (sd.color) cUniforms.uSeedCol.value[i].set(sd.color);
    });
    cUniforms.uCount.value = all.length;
    const key = list.map((x) => `${x.name}:${x.color}:${x.dir.x.toFixed(3)}:${x.weight.toFixed(2)}`).join('|');
    if (key === continentKey) return;
    continentKey = key;
    bakeWild((n) => {
      const { best, b1 } = regionAt(n, all);
      return best && !best.neutral && b1 < -0.03 ? best.biome : null; // inside the country, clear of its border
    });
  }

  // ── animated bits: fire, dome flag ──
  const fire = new THREE.Group();
  const flameA = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.14, 6), new THREE.MeshBasicMaterial({ color: '#ff9f43' }));
  const flameB = new THREE.Mesh(new THREE.ConeGeometry(0.026, 0.09, 6), new THREE.MeshBasicMaterial({ color: '#ffe08a' }));
  flameA.position.y = 0.09; flameB.position.y = 0.075;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#ffb36b', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.scale.setScalar(0.7); glow.position.y = 0.1;
  fire.add(flameA, flameB, glow);
  fire.position.copy(campDir).multiplyScalar(groundR(campDir) - 0.01);
  fire.quaternion.copy(surfaceQuat(campDir));
  world.add(fire);

  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.08), new THREE.MeshLambertMaterial({ color: '#d97757', side: THREE.DoubleSide }));
  const flagHolder = new THREE.Group();
  flagHolder.position.copy(domeDir).multiplyScalar(groundR(domeDir) - 0.02);
  flagHolder.quaternion.copy(surfaceQuat(domeDir, 1.2));
  flag.position.set(0.215, 0.33, 0);
  flagHolder.add(flag);
  world.add(flagHolder);

  const boardAnchor = new THREE.Object3D();
  boardAnchor.position.copy(boardDir).multiplyScalar(groundR(boardDir) + 0.45);
  world.add(boardAnchor);

  // ── clouds ──
  const cloudGeo = mergeGeometries([
    piece(new THREE.IcosahedronGeometry(0.16, 0), '#ffffff', at(0, 0, 0)),
    piece(new THREE.IcosahedronGeometry(0.12, 0), '#ffffff', at(0.17, -0.02, 0.03)),
    piece(new THREE.IcosahedronGeometry(0.11, 0), '#ffffff', at(-0.16, -0.03, -0.02)),
    piece(new THREE.IcosahedronGeometry(0.09, 0), '#ffffff', at(0.05, 0.08, 0.06)),
  ]);
  const cloudMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, transparent: true, opacity: 0.92 });
  const clouds = Array.from({ length: 7 }, () => {
    const m = new THREE.Mesh(cloudGeo, cloudMat);
    const base = randomDir();
    const axis = new THREE.Vector3().crossVectors(base, randomDir()).normalize();
    const c = { m, base, axis, speed: 0.025 + rand() * 0.03, r: R + 1.0 + rand() * 0.35, s: 0.7 + rand() * 0.5, a: rand() * 6 };
    m.scale.setScalar(c.s);
    world.add(m);
    return c;
  });

  // ── moon ──
  const moonPivot = new THREE.Group();
  const moon = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 1), new THREE.MeshLambertMaterial({ color: '#e9e1ff', flatShading: true }));
  moon.position.set(R * 1.95, 0.6, 0);
  moonPivot.add(moon);
  moonPivot.rotation.z = 0.35;
  scene.add(moonPivot);
  let moonBoing = 0;

  // ── stars ──
  {
    const p = new Float32Array(stars * 3);
    for (let i = 0; i < stars; i++) randomDir().multiplyScalar(starRadius[0] + rand() * (starRadius[1] - starRadius[0])).toArray(p, i * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xfff7d6, size: 0.09, transparent: true, opacity: 0.85, depthWrite: false })));
  }

  // ── shooting star (lives in camera space, far behind the planet) ──
  const shooter = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.025), new THREE.MeshBasicMaterial({
    map: streakTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  shooter.position.z = -30;
  shooter.visible = false;
  camera.add(shooter);
  let shootT = -1, nextShoot = 4 + rand() * 6;
  const shootFrom = new THREE.Vector3(), shootVel = new THREE.Vector3();

  // ── poked flowers ──
  const pokeGeo = { stem: new THREE.CylinderGeometry(0.006, 0.006, 0.08, 4), bloom: new THREE.IcosahedronGeometry(0.03, 0), leaf: new THREE.IcosahedronGeometry(0.018, 0) };
  const pokeMats = C.flower.concat(C.blossom).map((c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true }));
  const stemMat = new THREE.MeshLambertMaterial({ color: '#6cc79a', flatShading: true });
  const poked = [];

  const tmp = new THREE.Vector3();
  return {
    world, atmo, moon, campDir, seats, fire, boardAnchor, CAMP_RADIUS, setContinents,
    /** Plant a flower where the user poked (point in world-local space). */
    plant(localPoint) {
      const n = localPoint.clone().normalize();
      const g = new THREE.Group();
      const stem = new THREE.Mesh(pokeGeo.stem, stemMat); stem.position.y = 0.04;
      const bloom = new THREE.Mesh(pokeGeo.bloom, pokeMats[Math.floor(Math.random() * pokeMats.length)]); bloom.position.y = 0.085;
      const leaf = new THREE.Mesh(pokeGeo.leaf, stemMat); leaf.position.set(0.015, 0.03, 0); leaf.scale.set(1.4, 0.5, 0.8);
      g.add(stem, bloom, leaf);
      g.position.copy(n).multiplyScalar(groundR(n) - 0.005);
      g.quaternion.copy(surfaceQuat(n, Math.random() * 6));
      g.scale.setScalar(0.001);
      world.add(g);
      poked.push({ g, t: 0 });
      if (poked.length > 40) world.remove(poked.shift().g);
      return n;
    },
    boingMoon() { moonBoing = 1; },
    /** Returns true while something is still mid-animation that needs frames. */
    update(t, dt) {
      // fire flicker
      const f = 1 + Math.sin(t * 13) * 0.12 + Math.sin(t * 23.7) * 0.08;
      flameA.scale.set(1, f, 1); flameB.scale.set(1, 2 - f, 1);
      flameA.rotation.y = t * 2;
      glow.material.opacity = 0.55 + Math.sin(t * 9) * 0.08;
      flag.rotation.y = Math.sin(t * 3) * 0.25;

      for (const c of clouds) {
        c.a += c.speed * dt;
        tmp.copy(c.base).applyAxisAngle(c.axis, c.a);
        c.m.position.copy(tmp).multiplyScalar(c.r + Math.sin(t * 0.7 + c.a * 9) * 0.03);
        c.m.quaternion.setFromUnitVectors(UP, tmp);
      }

      moonPivot.rotation.y += dt * 0.15;
      moon.rotation.y += dt * (0.3 + moonBoing * 12);
      if (moonBoing > 0) {
        moonBoing = Math.max(0, moonBoing - dt * 1.4);
        const k = Math.sin(moonBoing * 14) * moonBoing * 0.35;
        moon.scale.set(1 + k, 1 - k, 1 + k);
      }

      // shooting star now and then
      if (shootT < 0 && (nextShoot -= dt) <= 0) {
        shootT = 0;
        const sx = (Math.random() < 0.5 ? -1 : 1);
        shootFrom.set(sx * (6 + Math.random() * 6), 4 + Math.random() * 6, -30);
        shootVel.set(-sx * (14 + Math.random() * 6), -(5 + Math.random() * 3), 0);
        shooter.rotation.z = Math.atan2(shootVel.y, shootVel.x);
        shooter.visible = true;
      }
      if (shootT >= 0) {
        shootT += dt;
        shooter.position.copy(shootFrom).addScaledVector(shootVel, shootT);
        shooter.material.opacity = Math.sin(Math.min(1, shootT / 0.9) * Math.PI);
        if (shootT > 0.9) { shootT = -1; shooter.visible = false; nextShoot = 7 + Math.random() * 10; }
      }

      for (let i = poked.length - 1; i >= 0; i--) {
        const p = poked[i];
        if (p.t >= 1) continue;
        p.t = Math.min(1, p.t + dt * 2.2);
        const k = p.t;
        p.g.scale.setScalar(Math.max(0.001, 1 + Math.sin(k * Math.PI * 1.5) * (1 - k) * 0.6 - (1 - k) * (1 - k)));
      }
    },
  };
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
function streakTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 4;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 128, 0);
  grd.addColorStop(0, 'rgba(255,255,255,0)');
  grd.addColorStop(1, 'rgba(255,250,220,1)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 4);
  return new THREE.CanvasTexture(c);
}
