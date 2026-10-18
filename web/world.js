// The planet: terrain, water, scenery (baked into one draw call), the camp, clouds (clouds.js), moon, stars.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeClouds } from './clouds.js';

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
  // Cartoon-planet look, all per pixel: palette from height (sand → lush green → pale hilltops) with stacked
  // darker-green ridge lines, then a stylised light pass (warm yellow-green key on the lit side, teal shade,
  // darker terminator rim). The real lights still do the lighting, so setTimeOfDay keeps working.
  // Countries are coloured per pixel (not per triangle) so borders stay smooth and crisp:
  // each fragment finds its nearest project "capital" (power distance: angle − radius). Inside a radius it
  // takes that country's colour; ink lines mark country edges and shared borders. Index 0 is the camp (neutral).
  const MAXC = 10;
  const cUniforms = {
    uSeedDir: { value: Array.from({ length: MAXC }, () => new THREE.Vector4(0, 1, 0, 0)) },
    uSeedCol: { value: Array.from({ length: MAXC }, () => new THREE.Color('#ffffff')) },
    uCount: { value: 0 },
  };
  // shared by terrain, water and clouds: the key light's direction in view space, its colour, and daylight
  const look = {
    uKeyDir: { value: new THREE.Vector3(0.35, 0.4, 0.85).normalize() },
    uKeyCol: { value: new THREE.Color(1, 1, 1) },
    uDay: { value: 1 },
  };
  const GLSL_HEIGHT = `float hgt(vec3 n) {
      return 0.13 * sin(2.7 * n.x + 1.3) * sin(2.9 * n.y + 0.4) * sin(2.3 * n.z + 2.1)
           + 0.06 * sin(6.1 * n.x + 4.2 * n.z) * cos(5.3 * n.y - 1.1)
           + 0.03 * sin(11.0 * n.y + 7.0 * n.x);
    }`;
  const sphereVaryings = (sh) => {
    Object.assign(sh.uniforms, look);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDirP;\nvarying float vH;\nvarying vec3 vSphN;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vDirP = normalize(position);
        vH = length(position) - ${R.toFixed(1)};
        vSphN = normalize(normalMatrix * vDirP);`);
  };
  const LOOK_DECL = `varying vec3 vDirP; varying float vH; varying vec3 vSphN;
    uniform vec3 uKeyDir; uniform vec3 uKeyCol; uniform float uDay;
    ${GLSL_HEIGHT}
    float hash1(float x) { return fract(sin(x * 91.17) * 43758.55); }`;
  // the planet-scale light pass every surface shares: kS = how much this spot faces the key light
  const LOOK_LIGHT = `
    vec3 sN = normalize(vSphN);
    float kS = dot(sN, uKeyDir);
    float lit = smoothstep(-0.35, 0.8, kS);
    float fres = 1.0 - clamp(dot(sN, normalize(vViewPosition)), 0.0, 1.0);`;

  const terrainMat = new THREE.MeshLambertMaterial({ color: '#ffffff' });
  terrainMat.onBeforeCompile = (sh) => {
    sphereVaryings(sh);
    Object.assign(sh.uniforms, cUniforms);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        ${LOOK_DECL}
        uniform vec4 uSeedDir[${MAXC}]; uniform vec3 uSeedCol[${MAXC}]; uniform int uCount;
        // wobbly, organic coastlines instead of perfect circles (same formula as coastJS)
        float coast(vec3 n, float k) {
          return 0.045 * sin(6.0 * n.x + 2.1 * k + 1.0) * sin(7.0 * n.y + 1.3 * k) * sin(5.0 * n.z + 0.7 * k + 2.0)
               + 0.018 * sin(17.0 * n.x + 13.0 * n.z + k) ;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // ── palette from height ──
        float h = vH;
        vec3 sand = vec3(0.97, 0.88, 0.58), deep = vec3(0.10, 0.44, 0.22), lush = vec3(0.33, 0.68, 0.18), top = vec3(0.66, 0.82, 0.26);
        vec3 land = mix(deep, lush, smoothstep(${(WATER + 0.02).toFixed(3)}, 0.075, h));
        land = mix(land, top, smoothstep(0.09, 0.17, h));
        // stacked ridges: wobbly contour layers, each a touch lighter, with a darker-green ledge line under it
        float lv = (h - ${WATER.toFixed(3)}) * 30.0 + 0.55 * sin(9.0 * vDirP.x + 5.0 * vDirP.z) * sin(7.0 * vDirP.y + 1.7);
        float band = fract(lv), lvl = floor(lv);
        land *= 0.95 + 0.07 * hash1(lvl);
        float ledge = (1.0 - smoothstep(0.0, 0.16, band)) * smoothstep(${(WATER + 0.03).toFixed(3)}, ${(WATER + 0.06).toFixed(3)}, h);
        land = mix(land, land * vec3(0.66, 0.78, 0.70), ledge * 0.85);
        // a soft pale beach where land meets the sea
        land = mix(sand, land, smoothstep(${(WATER + 0.002).toFixed(3)}, ${(WATER + 0.009).toFixed(3)}, h));
        diffuseColor.rgb = land;
        float country = 0.0;
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
            // ink: the country's outline, and the line where two countries meet
            float edge = -b1;                       // distance inside its own coast
            float shared = (b2 < 0.0) ? (b2 - b1) : 1.0; // distance to the neighbour's territory
            float line = min(edge, shared * 0.5);
            float ink = 1.0 - smoothstep(0.016, 0.024, line);
            // a light wash over the green land, deepening into a band just inside the border, so the cartoon
            // terrain stays dominant even with a dozen countries while each one still reads by border + tint
            float lum = dot(land, vec3(0.299, 0.587, 0.114));
            vec3 tint = c * (0.75 + 0.5 * lum);
            float rimBand = 1.0 - smoothstep(0.025, 0.085, line);
            country = (0.34 + 0.38 * rimBand) * shore;
            diffuseColor.rgb = mix(diffuseColor.rgb, tint, country);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.17, 0.15, 0.27), ink * 0.82 * shore);
          }
        }`)
      .replace('#include <opaque_fragment>', `${LOOK_LIGHT}
        // teal-tinted shade away from the key light, warm yellow-green glow on the lit side, darker rim at the edge
        outgoingLight = mix(outgoingLight * vec3(0.42, 0.6, 0.7), outgoingLight * 0.82, lit);
        float warm = pow(max(kS, 0.0), 2.2) * (0.35 + 0.65 * uDay) * (1.0 - 0.6 * country);
        outgoingLight += uKeyCol * vec3(0.26, 0.22, -0.02) * warm * smoothstep(${WATER.toFixed(3)}, ${(WATER + 0.03).toFixed(3)}, h);
        outgoingLight *= 1.0 - smoothstep(0.4, 1.0, fres) * (0.7 - 0.4 * lit);
        #include <opaque_fragment>`);
  };

  // ocean: turquoise shallows hugging the coasts → saturated teal → deep blue, shading to navy on the night side
  const waterMat = new THREE.MeshLambertMaterial({ color: '#ffffff' });
  waterMat.onBeforeCompile = (sh) => {
    sphereVaryings(sh);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${LOOK_DECL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float depth = ${WATER.toFixed(3)} - hgt(vDirP);
        vec3 shallow = vec3(0.24, 0.80, 0.74), teal = vec3(0.03, 0.62, 0.72), sea = vec3(0.03, 0.44, 0.78), abyss = vec3(0.05, 0.22, 0.62);
        vec3 w = mix(shallow, teal, smoothstep(0.002, 0.016, depth));
        w = mix(w, sea, smoothstep(0.03, 0.09, depth));
        w = mix(w, abyss, smoothstep(0.12, 0.22, depth));
        // a thin cream surf line right at the coast
        w = mix(w, vec3(0.99, 0.96, 0.88), 1.0 - smoothstep(0.0008, 0.0035, depth));
        diffuseColor.rgb = w;`)
      .replace('#include <opaque_fragment>', `${LOOK_LIGHT}
        outgoingLight = mix(outgoingLight * vec3(0.3, 0.42, 0.9), outgoingLight * vec3(0.58, 0.64, 0.68), lit);
        outgoingLight += uKeyCol * vec3(0.10, 0.16, 0.06) * pow(max(kS, 0.0), 2.0) * (0.35 + 0.65 * uDay);
        outgoingLight *= 1.0 - smoothstep(0.4, 1.0, fres) * (0.65 - 0.35 * lit);
        #include <opaque_fragment>`);
  };
  {
    // indexed + smooth normals: soft rolling hills instead of facets; the shader draws the detail
    let geo = new THREE.IcosahedronGeometry(R, 22);
    geo.deleteAttribute('normal'); geo.deleteAttribute('uv');
    geo = mergeVertices(geo);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).normalize();
      v.multiplyScalar(R + height(v));
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    world.add(new THREE.Mesh(geo, terrainMat));
    world.add(new THREE.Mesh(new THREE.IcosahedronGeometry(R + WATER, 12), waterMat));
  }

  // ── atmosphere ──
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.16, 40, 40), new THREE.ShaderMaterial({
    transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
    uniforms: { color: { value: new THREE.Color('#a9e6ff') } },
    vertexShader: `varying vec3 vN; varying vec3 vV;
      void main(){ vec4 mv = modelViewMatrix * vec4(position,1.); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 color; varying vec3 vN; varying vec3 vV;
      void main(){
        // fades to nothing right at its own silhouette, so the shell never draws a hard bright line over the clouds
        float a = abs(dot(vN, vV)); float f = pow(1. - a, 2.2) * smoothstep(0.0, 0.45, a);
        gl_FragColor = vec4(color, f * 0.62); }`,
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

  // ── clouds: thick cream bands hugging the planet (clouds.js) ──
  const clouds = makeClouds(world, R, look);

  // ── moon ──
  const moonPivot = new THREE.Group();
  const moon = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 1), new THREE.MeshLambertMaterial({ color: '#e9e1ff', flatShading: true }));
  moon.position.set(R * 1.95, 0.6, 0);
  moonPivot.add(moon);
  moonPivot.rotation.z = 0.35;
  scene.add(moonPivot);
  let moonBoing = 0;

  // ── stars ──
  const starMat = new THREE.PointsMaterial({ color: 0xfff7d6, size: 0.09, transparent: true, opacity: 0.85, depthWrite: false });
  {
    const p = new Float32Array(stars * 3);
    for (let i = 0; i < stars; i++) randomDir().multiplyScalar(starRadius[0] + rand() * (starRadius[1] - starRadius[0])).toArray(p, i * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    scene.add(new THREE.Points(g, starMat));
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

  // ── time of day ──
  const tod = { day: 1, night: 0, golden: 0, hour: 12 };
  const base = new WeakMap(); // each light's own (daytime) colour + intensity, captured on first use
  const baseOf = (l) => {
    if (!base.has(l)) base.set(l, { color: l.color.clone(), intensity: l.intensity, ground: l.groundColor?.clone() });
    return base.get(l);
  };
  const atmoDay = atmo.material.uniforms.color.value.clone();
  const mixC = (out, day, golden, night, k) => out.copy(day).lerp(golden, k.golden).lerp(night, k.night);
  const TOD = {
    sun: { golden: new THREE.Color('#ffbf85'), night: new THREE.Color('#b4bcf5'), gI: 0.95, nI: 0.42 },
    rim: { golden: new THREE.Color('#d1a6ff'), night: new THREE.Color('#8d8cff'), gI: 1.1, nI: 1.25 },
    hemi: { golden: new THREE.Color('#ffdcb8'), night: new THREE.Color('#7a7fc4'), gG: new THREE.Color('#8a68a8'), nG: new THREE.Color('#2c2556'), gI: 0.92, nI: 0.62 },
    atmo: { golden: new THREE.Color('#ffb98c'), night: new THREE.Color('#5e55d6') },
  };
  /** Where the lights live when the caller doesn't pass them: hemisphere in the scene, sun + rim on the camera. */
  function findLights() {
    let hemi = null;
    scene.traverse((o) => { if (!hemi && o.isHemisphereLight) hemi = o; });
    const dirs = camera.children.filter((o) => o.isDirectionalLight).sort((a, b) => baseOf(b).intensity - baseOf(a).intensity);
    return { hemi, sun: dirs[0] ?? null, rim: dirs[1] ?? null };
  }

  // the stylised light pass follows the real key light (the sun riding on the camera): direction in view space
  let keyLight;
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
  function updateLook() {
    if (keyLight === undefined) keyLight = findLights().sun;
    if (!keyLight) return;
    tmpA.setFromMatrixPosition(keyLight.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
    tmpB.setFromMatrixPosition(keyLight.target.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
    if (tmpA.distanceToSquared(tmpB) > 1e-8) {
      // exaggerate the off-axis part so the warm highlight sits towards the lit limb, like an illustration
      const k = look.uKeyDir.value.subVectors(tmpA, tmpB).normalize();
      k.set(k.x * 1.9, k.y * 1.9, k.z).normalize();
    }
    look.uKeyCol.value.copy(keyLight.color).multiplyScalar(keyLight.intensity / (baseOf(keyLight).intensity || 1));
  }

  return {
    world, atmo, moon, campDir, seats, fire, boardAnchor, CAMP_RADIUS, setContinents, clouds,
    /** Shared stylised-light uniforms { uKeyDir, uKeyCol, uDay } (terrain, water, clouds). */
    look,
    /** Last computed { day, night, golden, hour } (0…1 each). */
    timeOfDay: tod,
    /**
     * Light the planet for the local clock: day (sunrise ~7:00), golden hour around sunrise and sunset
     * (~19:30), deep blue-violet night with brighter stars and a stronger campfire.
     * lights: { sun, rim, hemi } — found in the scene/camera when omitted. Returns { day, night, golden, hour }.
     * Cheap; call it every minute or so (and pass `night` on to village.setNight).
     */
    setTimeOfDay(date = new Date(), lights = {}) {
      const d = date instanceof Date ? date : new Date(date);
      const h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
      const ss = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
      const day = ss(6.2, 7.8, h) * (1 - ss(18.9, 20.4, h));
      const bump = (c, w) => Math.max(0, 1 - Math.abs(h - c) / w);
      // golden hour: warm around sunrise and the hour before sunset, fading as night takes over
      const golden = Math.min(1, ss(0, 1, bump(7.4, 1.3)) + ss(0, 1, bump(19.0, 1.6))) * (0.35 + 0.65 * day);
      const night = 1 - day;
      Object.assign(tod, { day, night, golden: 0.8 * golden * (1 - night * 0.6), hour: h });
      const L = { ...findLights(), ...lights };
      if (L.sun) {
        const b = baseOf(L.sun);
        mixC(L.sun.color, b.color, TOD.sun.golden, TOD.sun.night, tod);
        L.sun.intensity = b.intensity * (1 + (TOD.sun.gI - 1) * tod.golden) * (1 + (TOD.sun.nI - 1) * night);
      }
      if (L.rim) {
        const b = baseOf(L.rim);
        mixC(L.rim.color, b.color, TOD.rim.golden, TOD.rim.night, tod);
        L.rim.intensity = b.intensity * (1 + (TOD.rim.gI - 1) * tod.golden) * (1 + (TOD.rim.nI - 1) * night);
      }
      if (L.hemi) {
        const b = baseOf(L.hemi);
        mixC(L.hemi.color, b.color, TOD.hemi.golden, TOD.hemi.night, tod);
        if (b.ground) mixC(L.hemi.groundColor, b.ground, TOD.hemi.gG, TOD.hemi.nG, tod);
        L.hemi.intensity = b.intensity * (1 + (TOD.hemi.gI - 1) * tod.golden) * (1 + (TOD.hemi.nI - 1) * night);
      }
      mixC(atmo.material.uniforms.color.value, atmoDay, TOD.atmo.golden, TOD.atmo.night, tod);
      starMat.opacity = 0.6 + 0.4 * night;
      starMat.size = 0.085 + 0.035 * night;
      look.uDay.value = day;
      clouds.setNight(night);
      if (L.sun) keyLight = L.sun;
      return { ...tod };
    },
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
      glow.material.opacity = (0.55 + Math.sin(t * 9) * 0.08) * (1 + tod.night * 0.6);
      glow.scale.setScalar(0.7 + tod.night * 0.45);
      flag.rotation.y = Math.sin(t * 3) * 0.25;

      updateLook();
      clouds.tick(dt, t);

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
