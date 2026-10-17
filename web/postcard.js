// Weekly postcard: renders the planet once into an offscreen target and composes a 1200×1500 card.
import * as THREE from 'three';

const W = 1200, H = 1500, SHOT = 1024;
const FONT = 'ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif';
const font = (weight, px) => `${weight} ${px}px ${FONT}`;

// Render targets skip tone mapping + sRGB output, so a tiny pass re-applies them (same maths as three's ACES).
const POST_FRAG = /* glsl */`
  uniform sampler2D tex; uniform float exposure; uniform bool aces; varying vec2 vUv;
  vec3 RRTAndODTFit(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
  vec3 acesFilmic(vec3 c) {
    const mat3 IN = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
    const mat3 OUT = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
    c *= exposure / 0.6; c = IN * c; c = RRTAndODTFit(c); c = OUT * c; return clamp(c, 0., 1.);
  }
  vec3 toSRGB(vec3 c) { return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308)))); }
  void main() {
    vec4 c = texture2D(tex, vUv);
    vec3 rgb = aces ? acesFilmic(c.rgb) : clamp(c.rgb * exposure, 0., 1.);
    gl_FragColor = vec4(toSRGB(rgb), clamp(c.a, 0., 1.));
  }`;

/** Render the scene square and return an ImageData-backed canvas (transparent background). */
function shoot(renderer, scene, camera) {
  const hdr = new THREE.WebGLRenderTarget(SHOT, SHOT, { type: THREE.HalfFloatType, samples: 4 });
  const ldr = new THREE.WebGLRenderTarget(SHOT, SHOT);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: {
      tex: { value: hdr.texture },
      exposure: { value: renderer.toneMapping === THREE.NoToneMapping ? 1 : renderer.toneMappingExposure },
      aces: { value: renderer.toneMapping === THREE.ACESFilmicToneMapping },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
    fragmentShader: POST_FRAG,
    depthTest: false, depthWrite: false,
  }));
  const postScene = new THREE.Scene();
  postScene.add(quad);
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const prev = {
    target: renderer.getRenderTarget(), aspect: camera.aspect, autoClear: renderer.autoClear,
    clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(),
  };
  const px = new Uint8Array(SHOT * SHOT * 4);
  try {
    camera.aspect = 1;
    camera.updateProjectionMatrix();
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(hdr);
    renderer.render(scene, camera);
    renderer.setRenderTarget(ldr);
    renderer.render(postScene, postCam);
    renderer.readRenderTargetPixels(ldr, 0, 0, SHOT, SHOT, px);
  } finally {
    renderer.setRenderTarget(prev.target);
    renderer.autoClear = prev.autoClear;
    renderer.setClearColor(prev.clear, prev.alpha);
    camera.aspect = prev.aspect;
    camera.updateProjectionMatrix();
    hdr.dispose(); ldr.dispose(); quad.geometry.dispose(); quad.material.dispose();
  }
  // GL rows are bottom-up
  const c = document.createElement('canvas');
  c.width = c.height = SHOT;
  const img = c.getContext('2d').createImageData(SHOT, SHOT);
  const row = SHOT * 4;
  for (let y = 0; y < SHOT; y++) img.data.set(px.subarray((SHOT - 1 - y) * row, (SHOT - y) * row), y * row);
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

// ── logbook maths ────────────────────────────────────────────────────
const ymd = (t) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
function lastDays(today, n) {
  const [y, m, d] = String(today || ymd(new Date())).split('-').map(Number);
  return Array.from({ length: n }, (_, i) => ymd(new Date(y, m - 1, d - i)));
}
function weekStats(logbook) {
  const days = lastDays(logbook.today, 7);
  const tot = { turns: 0, activeMin: 0, tokOut: 0 };
  const per = [];
  for (const p of logbook.projects || []) {
    let turns = 0;
    for (const d of days) {
      const s = p.days?.[d];
      if (!s) continue;
      turns += s.turns || 0;
      tot.turns += s.turns || 0; tot.activeMin += s.activeMin || 0; tot.tokOut += s.tokOut || 0;
    }
    if (turns > 0) per.push({ name: p.name || p.key, turns });
  }
  per.sort((a, b) => b.turns - a.turns);
  return { ...tot, top: per.slice(0, 3) };
}
const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
function fmtTime(min) {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

// ── drawing ──────────────────────────────────────────────────────────
function fitText(g, text, maxW) {
  let t = String(text);
  if (g.measureText(t).width <= maxW) return t;
  while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

function background(g, starsTo = H * 0.92) {
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#2a2650');
  bg.addColorStop(0.55, '#1a1835');
  bg.addColorStop(1, '#0f0e24');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  // stars (deterministic, so every postcard has the same sky)
  let s = 1234567;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 140; i++) {
    const x = rnd() * W, y = rnd() * starsTo, r = rnd() < 0.12 ? 2.4 : 0.8 + rnd() * 1.2;
    g.globalAlpha = 0.35 + rnd() * 0.6;
    g.fillStyle = rnd() < 0.2 ? '#ffe7b0' : '#fff7d6';
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
}

function glow(g, cx, cy, r) {
  const grd = g.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
  grd.addColorStop(0, 'rgba(120, 110, 220, 0.45)');
  grd.addColorStop(1, 'rgba(120, 110, 220, 0)');
  g.fillStyle = grd;
  g.fillRect(cx - r, cy - r, r * 2, r * 2);
}

function tile(g, x, y, w, h, value, label, accent) {
  g.fillStyle = 'rgba(255, 252, 246, 0.08)';
  g.strokeStyle = 'rgba(255, 252, 246, 0.14)';
  g.lineWidth = 2;
  g.beginPath(); g.roundRect(x, y, w, h, 28); g.fill(); g.stroke();
  g.fillStyle = accent;
  g.beginPath(); g.roundRect(x + 28, y + 26, 34, 8, 4); g.fill();
  g.fillStyle = '#ffffff';
  g.font = font(800, 58);
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillText(fitText(g, value, w - 56), x + 28, y + 104);
  g.fillStyle = 'rgba(255, 255, 255, 0.62)';
  g.font = font(600, 26);
  g.fillText(label, x + 28, y + 142);
}

export async function makePostcard({ renderer, scene, camera, logbook = null, palette = {}, weekLabel = '', photo = false }) {
  const shot = shoot(renderer, scene, camera);
  try { await document.fonts?.ready; } catch {}

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const stats = logbook ? weekStats(logbook) : null;
  background(g, stats ? 1050 : H * 0.92);
  // header
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.fillStyle = '#ffffff';
  g.font = font(800, 76);
  g.fillText('My Bot Planet', W / 2, 128);
  if (weekLabel) {
    g.fillStyle = 'rgba(255, 255, 255, 0.6)';
    g.font = font(600, 34);
    g.fillText(weekLabel, W / 2, 182);
  }

  if (photo) {
    // group photo: a rounded, framed picture (cropped from the square shot) above the stats
    const px = 60, py = 214, pw = W - 120, ph = stats ? 820 : 1180;
    const sw = SHOT, sh = Math.round(SHOT * ph / pw), sy = Math.round((SHOT - sh) * 0.5);
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 40; g.shadowOffsetY = 12;
    g.fillStyle = '#ffffff';
    g.beginPath(); g.roundRect(px - 10, py - 10, pw + 20, ph + 20, 44); g.fill();
    g.restore();
    g.save();
    g.beginPath(); g.roundRect(px, py, pw, ph, 36); g.clip();
    g.drawImage(shot, 0, sy, sw, sh, px, py, pw, ph);
    g.restore();
  } else {
    // the planet
    const size = stats ? 900 : 1120;
    const top = stats ? 190 : 250;
    glow(g, W / 2, top + size / 2, size * 0.5);
    g.drawImage(shot, (W - size) / 2, top, size, size);
  }

  if (stats) {
    const y = 1062, gap = 24, tw = (W - 120 - gap * 2) / 3;
    tile(g, 60, y, tw, 168, fmtNum(stats.turns), 'tasks done', '#f59bae');
    tile(g, 60 + tw + gap, y, tw, 168, fmtTime(stats.activeMin), 'Claude worked', '#8cc8f5');
    tile(g, 60 + (tw + gap) * 2, y, tw, 168, fmtNum(stats.tokOut), 'tokens written', '#ffc96b');

    if (stats.top.length) {
      g.textAlign = 'left';
      g.fillStyle = 'rgba(255, 255, 255, 0.5)';
      g.font = font(700, 24);
      g.fillText('BUSIEST CONTINENTS', 76, 1278);
      stats.top.forEach((p, i) => {
        const ry = 1322 + i * 44;
        g.fillStyle = palette?.[p.name] || '#d97757';
        g.beginPath(); g.arc(88, ry - 10, 12, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#ffffff';
        g.font = font(700, 34);
        g.textAlign = 'left';
        g.fillText(fitText(g, p.name, W - 420), 116, ry);
        g.fillStyle = 'rgba(255, 255, 255, 0.6)';
        g.font = font(600, 30);
        g.textAlign = 'right';
        g.fillText(`${fmtNum(p.turns)} ${p.turns === 1 ? 'task' : 'tasks'}`, W - 76, ry);
      });
    }
  }

  // footer
  g.textAlign = 'center';
  g.fillStyle = 'rgba(255, 255, 255, 0.42)';
  g.font = font(600, 24);
  g.fillText('made with Claude · PHAM. Creative', W / 2, H - 34);

  return c.toDataURL('image/png');
}
