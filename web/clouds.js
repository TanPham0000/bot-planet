// Thick, soft cream clouds hugging the planet in puffy bands, plus a few small floating puffs.
// One merged mesh, one draw call. Puffs on the side facing the camera melt away in the vertex shader,
// so the bands frame the silhouette (and never cover the camp) while the camera orbits.
// Battery: everything is static except one slow group rotation; no per-frame allocations.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const UP = new THREE.Vector3(0, 1, 0);

function seeded(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

/**
 * parent: scene or group (the planet's group, so clouds turn with it). radius: planet radius.
 * look (optional): { uKeyDir, uKeyCol, uDay } uniforms shared with the terrain so clouds follow the same key light.
 * → { group, tick(dt, t), setNight(k) }
 */
export function makeClouds(parent, radius, look = {}) {
  const rand = seeded(31);
  const unit = new THREE.IcosahedronGeometry(1, 2);
  unit.deleteAttribute('uv');
  const pieces = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();

  /** One puff: a sphere squashed along the planet normal (flat-ish bottom), centred at `c`. */
  function puff(c, r, squash, fade) {
    const g = unit.clone();
    q.setFromUnitVectors(UP, p.copy(c).normalize());
    m.compose(c, q, sc.set(r, r * squash, r));
    g.applyMatrix4(m);
    const n = g.attributes.position.count;
    const ctr = new Float32Array(n * 3), fd = new Float32Array(n);
    for (let i = 0; i < n; i++) { c.toArray(ctr, i * 3); fd[i] = fade; }
    g.setAttribute('aCenter', new THREE.BufferAttribute(ctr, 3));
    g.setAttribute('aFade', new THREE.BufferAttribute(fd, 1));
    pieces.push(g);
  }

  /** A cluster: one big puff, two smaller flanking ones a bit lower, sometimes a little one on top. */
  function cluster(dir, tangent, alt, r, fade) {
    const c = dir.clone().multiplyScalar(alt);
    puff(c, r, 0.78, fade);
    for (const side of [-1, 1]) {
      const rr = r * (0.58 + rand() * 0.2);
      puff(c.clone().addScaledVector(tangent, side * r * (0.85 + rand() * 0.25)).addScaledVector(dir, -r * 0.22), rr, 0.8, fade);
    }
    if (rand() < 0.55) puff(c.clone().addScaledVector(dir, r * 0.45).addScaledVector(tangent, (rand() - 0.5) * r * 0.6), r * 0.55, 0.85, fade);
  }

  // bands: arcs along tilted great circles, wobbling a little in latitude, fattest in the middle
  const bands = [
    { axis: [0.25, 1, 0.1], from: 0.2, len: 2.6 },
    { axis: [1, 0.35, -0.3], from: 2.4, len: 2.2 },
    { axis: [-0.4, 0.3, 1], from: 4.1, len: 1.9 },
    { axis: [0.6, -0.8, 0.5], from: 1.0, len: 1.4 },
    // thinner bands that melt away less, so a few puffy streaks cross the face
    { axis: [-0.7, 0.9, 0.2], from: 3.3, len: 1.7, fade: 0.55, size: 0.6 },
    { axis: [0.2, 0.4, -1], from: 0.6, len: 1.5, fade: 0.55, size: 0.6 },
    { axis: [1, -0.1, 0.8], from: 5.0, len: 1.3, fade: 0.6, size: 0.55 },
  ];
  const axis = new THREE.Vector3(), base = new THREE.Vector3(), dir = new THREE.Vector3(), tan = new THREE.Vector3(), lat = new THREE.Vector3();
  for (const b of bands) {
    axis.set(...b.axis).normalize();
    base.set(1, 0, 0).projectOnPlane(axis);
    if (base.lengthSq() < 1e-3) base.set(0, 0, 1).projectOnPlane(axis);
    base.normalize();
    const step = 0.17;
    for (let a = 0; a <= b.len; a += step * (0.8 + rand() * 0.4)) {
      const u = a / b.len;
      const env = Math.sin(Math.PI * Math.min(1, Math.max(0, u))); // taper at the ends
      dir.copy(base).applyAxisAngle(axis, b.from + a);
      lat.crossVectors(axis, dir); // along the band
      dir.addScaledVector(axis, Math.sin(a * 2.3 + b.from) * 0.12).normalize();
      tan.copy(lat).projectOnPlane(dir).normalize();
      const r = (0.12 + 0.19 * env) * (0.85 + rand() * 0.3) * (b.size ?? 1);
      cluster(dir.clone(), tan.clone(), radius + 0.36 + r * 0.4 + rand() * 0.05 + (b.fade ? 0.12 : 0), r, b.fade ?? 1);
    }
  }
  // a few small puffs floating higher up (they melt away less, so some drift across the face)
  for (let i = 0; i < 12; i++) {
    dir.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
    tan.set(rand() - 0.5, rand() - 0.5, rand() - 0.5).projectOnPlane(dir).normalize();
    cluster(dir.clone(), tan.clone(), radius + 0.95 + rand() * 0.35, 0.07 + rand() * 0.05, 0.75);
  }

  const geo = mergeGeometries(pieces);
  pieces.forEach((g) => g.dispose());
  unit.dispose();

  const uniforms = {
    uKeyDir: look.uKeyDir ?? { value: new THREE.Vector3(0.35, 0.4, 0.85).normalize() },
    uKeyCol: look.uKeyCol ?? { value: new THREE.Color(1, 1, 1) },
    uCream: { value: new THREE.Color('#fdf3e3') },
    uShade: { value: new THREE.Color('#e3cfc0') },
    uNight: { value: 0 },
    uNightTint: { value: new THREE.Color('#7f80b8') },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    toneMapped: false, // keep the cream exactly cream
    vertexShader: `
      attribute vec3 aCenter; attribute float aFade;
      varying vec3 vN; varying vec3 vV; varying float vSide;
      uniform vec3 uKeyDir;
      void main() {
        vec3 cW = (modelMatrix * vec4(aCenter, 1.0)).xyz;
        // the planet sits at the origin: puffs between it and the camera shrink to nothing
        float facing = dot(normalize(cW), normalize(cameraPosition));
        float s = 1.0 - aFade * smoothstep(0.5, 0.86, facing);
        vec3 p = aCenter + (position - aCenter) * s;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        vSide = dot(normalize((viewMatrix * vec4(cW, 0.0)).xyz), uKeyDir);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uKeyDir; uniform vec3 uKeyCol; uniform vec3 uCream; uniform vec3 uShade;
      uniform float uNight; uniform vec3 uNightTint;
      varying vec3 vN; varying vec3 vV; varying float vSide;
      void main() {
        vec3 n = normalize(vN);
        float l = smoothstep(-0.45, 0.7, dot(n, uKeyDir));
        vec3 col = mix(uShade, uCream, l);
        // clouds round the planet's shadow side go a soft blue-grey
        col = mix(col * vec3(0.74, 0.8, 0.94), col, smoothstep(-0.7, 0.2, vSide));
        col += uCream * 0.1 * pow(1.0 - max(dot(n, normalize(vV)), 0.0), 3.0);
        col *= mix(vec3(1.0), uKeyCol, 0.25);
        col = mix(col, col * uNightTint, uNight);
        gl_FragColor = vec4(min(col, vec3(1.0)), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; // the vertex shader moves puffs; the bounds are the whole shell anyway
  const group = new THREE.Group();
  group.add(mesh);
  parent.add(group);

  return {
    group,
    tick(dt) { group.rotation.y += dt * 0.012; },
    setNight(k) { uniforms.uNight.value = Math.min(1, Math.max(0, k)) * 0.85; },
  };
}
