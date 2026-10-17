// Scheduled cloud routines as satellites: each orbits the planet, blinks when it's about to fire,
// and beams down to its project's house while it runs. Data: routines.json snapshot (server → SSE),
// with next runs computed locally from each cron so countdowns stay right between snapshots.
import * as THREE from 'three';
import { R, makeRand, groundR } from './world.js';
import { hashStr } from './astronaut.js';

// ── cron ─────────────────────────────────────────────────────────────
function field(spec, min, max) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const [range, stepS] = part.split('/');
    const step = Number(stepS) || 1;
    let a, b;
    if (range === '*') { a = min; b = max; }
    else if (range.includes('-')) [a, b] = range.split('-').map(Number);
    else { a = Number(range); b = stepS ? max : a; }
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}
const cronCache = new Map();
function parseCron(expr) {
  if (cronCache.has(expr)) return cronCache.get(expr);
  const [m, h, dom, mon, dow] = expr.trim().split(/\s+/);
  const c = {
    m: [...field(m, 0, 59)].sort((a, b) => a - b), h: field(h, 0, 23), dom: field(dom, 1, 31), mon: field(mon, 1, 12),
    dow: new Set([...field(dow, 0, 7)].map((d) => d % 7)), domAny: dom === '*', dowAny: dow === '*',
  };
  cronCache.set(expr, c);
  return c;
}
const fmtCache = new Map();
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function partsIn(tz, t) {
  let f = fmtCache.get(tz);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', month: 'numeric', day: 'numeric', hour: 'numeric', weekday: 'short' }); }
    catch { f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', month: 'numeric', day: 'numeric', hour: 'numeric', weekday: 'short' }); }
    fmtCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(t)) o[p.type] = p.value;
  return { mon: +o.month, day: +o.day, hour: +o.hour % 24, dow: WD[o.weekday] };
}
/** Next fire time (ms) strictly after `from`, scanning hour by hour (≤ 45 days). */
export function nextRun(expr, tz, from = Date.now()) {
  const c = parseCron(expr);
  let t = Math.floor(from / 3600000) * 3600000;
  for (let i = 0; i < 24 * 45; i++, t += 3600000) {
    const p = partsIn(tz, t);
    if (!c.mon.has(p.mon) || !c.h.has(p.hour)) continue;
    const domOk = c.dom.has(p.day), dowOk = c.dow.has(p.dow);
    const dayOk = c.domAny && c.dowAny ? true : c.domAny ? dowOk : c.dowAny ? domOk : domOk || dowOk;
    if (!dayOk) continue;
    for (const m of c.m) { const at = t + m * 60000; if (at > from) return at; }
  }
  return null;
}

// ── wording ──────────────────────────────────────────────────────────
export const shortName = (n) => String(n).replace(/^PHAM\s+(Outreach|Rhythm)\s*[:—-]\s*/i, '').replace(/\s*\(.*\)\s*$/, '');
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "weekdays · 09:00, 14:00" in *your* local time, read off the next fires. */
export function describeSchedule(r) {
  const runs = [];
  let t = Date.now();
  for (let i = 0; i < 12; i++) { const n = nextRun(r.cron, r.tz, t); if (!n) break; runs.push(n); t = n; }
  if (!runs.length) return r.cron;
  // describe from the coming week only: a DST change later on (UTC crons) would show two times
  const week = runs.filter((x) => x - runs[0] < 7 * 86400000);
  const times = [...new Set(week.map(hhmm))].sort();
  const days = [...new Set(week.map((x) => new Date(x).getDay()))].sort();
  const c = parseCron(r.cron);
  let when;
  if (!c.domAny) when = `monthly on the ${[...c.dom][0]}${[...c.dom][0] === 1 ? 'st' : 'th'}`;
  else if (days.length === 7) when = 'daily';
  else if (days.join() === '1,2,3,4,5') when = 'weekdays';
  else when = days.map((d) => DAY[d]).join('/');
  return `${when} · ${times.slice(0, 3).join(', ')}`;
}
export function relTime(t, now = Date.now()) {
  const s = Math.round((t - now) / 1000), a = Math.abs(s);
  const txt = a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${Math.floor(a / 3600)}h ${Math.round((a % 3600) / 60)}m` : `${Math.round(a / 86400)}d`;
  return s >= 0 ? `in ${txt}` : `${txt} ago`;
}

/** Live state of one routine right now. */
export function stateOf(r, now = Date.now()) {
  const next = r.enabled ? nextRun(r.cron, r.tz, now) : null;
  const justFired = r.enabled ? nextRun(r.cron, r.tz, now - 25 * 60000) : null; // a fire in the last ~25 min?
  const lastAt = r.lastRun?.at ? Date.parse(r.lastRun.at) : 0;
  const lastBusy = ['pending', 'running'].includes(r.lastRun?.status) && now - lastAt < 45 * 60000;
  const running = r.enabled && (lastBusy || (justFired && justFired <= now));
  return { next, running, soon: !!next && next - now < 15 * 60000, lastAt };
}

// ── satellites ───────────────────────────────────────────────────────
export function createSatellites({ world, scene }) {
  const group = new THREE.Group();
  world.add(group);
  const geo = {
    body: new THREE.BoxGeometry(0.1, 0.1, 0.13),
    panel: new THREE.BoxGeometry(0.2, 0.006, 0.07),
    dish: new THREE.ConeGeometry(0.045, 0.035, 10, 1, true),
    light: new THREE.SphereGeometry(0.02, 8, 6),
    beam: new THREE.CylinderGeometry(0.012, 0.05, 1, 8, 1, true),
  };
  const mats = {
    body: new THREE.MeshLambertMaterial({ color: '#e8e4f4', flatShading: true }),
    off: new THREE.MeshLambertMaterial({ color: '#8a849e', flatShading: true }),
    panel: new THREE.MeshLambertMaterial({ color: '#5b8def', flatShading: true }),
    panelOff: new THREE.MeshLambertMaterial({ color: '#56536a', flatShading: true }),
    dish: new THREE.MeshLambertMaterial({ color: '#ffffff', side: THREE.DoubleSide }),
  };
  /** id → { r, g, light, beam, axis, base, speed, radius, state } */
  const sats = new Map();
  const tmp = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);

  function make(r) {
    const rand = makeRand((hashStr(r.id) % 2147483646) + 3);
    const g = new THREE.Group();
    const body = new THREE.Mesh(geo.body, mats.body);
    const pL = new THREE.Mesh(geo.panel, mats.panel); pL.position.x = -0.16;
    const pR = new THREE.Mesh(geo.panel, mats.panel); pR.position.x = 0.16;
    const dish = new THREE.Mesh(geo.dish, mats.dish); dish.position.y = -0.07; dish.rotation.x = Math.PI;
    const light = new THREE.Mesh(geo.light, new THREE.MeshBasicMaterial({ color: '#7fffd4' })); light.position.y = 0.065;
    g.add(body, pL, pR, dish, light);
    g.userData = { body, panels: [pL, pR] };
    group.add(g);
    const beam = new THREE.Mesh(geo.beam, new THREE.MeshBasicMaterial({ color: '#ffb36b', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    beam.visible = false;
    group.add(beam);
    const base = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
    const axis = new THREE.Vector3().crossVectors(base, new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5)).normalize();
    return { r, g, light, beam, base, axis, angle: rand() * 6.28, speed: 0.05 + rand() * 0.05, radius: R + 1.55 + rand() * 0.45, state: {} };
  }

  const api = {
    sats,
    /** Sync with the latest routines snapshot. */
    update(list) {
      const seen = new Set();
      for (const r of list || []) {
        seen.add(r.id);
        const s = sats.get(r.id) ?? make(r);
        s.r = r;
        const on = r.enabled;
        s.g.userData.body.material = on ? mats.body : mats.off;
        for (const p of s.g.userData.panels) p.material = on ? mats.panel : mats.panelOff;
        sats.set(r.id, s);
      }
      for (const [id, s] of sats) if (!seen.has(id)) { group.remove(s.g, s.beam); sats.delete(id); }
    },
    /** Recompute running/soon flags (cheap enough to do every few seconds). */
    refresh(now = Date.now()) {
      const started = [];
      for (const s of sats.values()) {
        const was = s.state.running;
        s.state = stateOf(s.r, now);
        if (s.state.running && !was && was !== undefined) started.push(s.r);
      }
      return started;
    },
    /** homeOf(routine) → world-local point of its house (or null). */
    tick(t, dt, homeOf) {
      for (const s of sats.values()) {
        const st = s.state;
        s.angle += dt * s.speed * (s.r.enabled ? 1 : 0.35);
        tmp.copy(s.base).applyAxisAngle(s.axis, s.angle).multiplyScalar(s.radius);
        s.g.position.copy(tmp);
        s.g.quaternion.setFromUnitVectors(up, tmp.clone().normalize()); // dish faces the planet
        s.g.rotateY(t * 0.4);
        // light: steady green, blinking amber when about to fire, orange when running, off when disabled
        const lm = s.light.material;
        if (!s.r.enabled) lm.color.set('#4b4766');
        else if (st.running) lm.color.set(Math.sin(t * 8) > 0 ? '#ff7a45' : '#ffd0b8');
        else if (st.soon) lm.color.set(Math.sin(t * 5) > 0 ? '#ffc96b' : '#3b3552');
        else lm.color.set('#7fffd4');
        // beam to its house while running
        const home = st.running ? homeOf(s.r) : null;
        s.beam.visible = !!home;
        if (home) {
          const from = s.g.position, to = home;
          const mid = tmp.copy(from).add(to).multiplyScalar(0.5);
          s.beam.position.copy(mid);
          const dir = to.clone().sub(from);
          s.beam.scale.set(1, dir.length(), 1);
          s.beam.quaternion.setFromUnitVectors(up, dir.normalize().negate());
          s.beam.material.opacity = 0.35 + Math.sin(t * 6) * 0.15;
        }
      }
    },
    /** Satellite under a ray, for hover/click: returns { sat, t } or null. */
    pick(ray, world) {
      let best = null;
      const c = new THREE.Vector3();
      for (const s of sats.values()) {
        world.localToWorld(c.copy(s.g.position));
        const d = ray.ray.distanceSqToPoint(c);
        if (d < 0.3 * 0.3) { // generous: they are small and moving
          const t = ray.ray.origin.distanceTo(c);
          if (!best || t < best.t) best = { sat: s, t };
        }
      }
      return best;
    },
  };
  return api;
}

// ── schedule sheet ───────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export function renderSchedule(snapshot, { highlight = null } = {}) {
  const now = Date.now();
  const rows = (snapshot?.routines || []).map((r) => ({ r, st: stateOf(r, now) }))
    .sort((a, b) => (b.st.running - a.st.running) || (b.r.enabled - a.r.enabled) || ((a.st.next ?? Infinity) - (b.st.next ?? Infinity)));
  const age = snapshot?.updatedAt ? relTime(snapshot.updatedAt, now) : 'never';
  const last = (r) => {
    if (!r.lastRun?.at) return '';
    const s = r.lastRun.status;
    const icon = s === 'succeeded' ? '✓' : s === 'failed' ? '✗' : '⏳';
    return `<span class="last ${s}">${icon} ${relTime(Date.parse(r.lastRun.at), now)}${r.lastRun.failure ? ` · ${esc(r.lastRun.failure)}` : ''}</span>`;
  };
  return `
    <div class="lb-head"><span class="emoji">📡</span><h3>Schedule</h3><span class="pill">${rows.filter((x) => x.r.enabled).length} active</span></div>
    <ul class="sched">${rows.map(({ r, st }) => `
      <li class="${r.enabled ? '' : 'off'}${st.running ? ' running' : ''}${r.id === highlight ? ' hl' : ''}">
        <i></i>
        <div class="what"><b>${esc(shortName(r.name))}</b><small>${esc(describeSchedule(r))}</small></div>
        <div class="when">${st.running ? '<b class="run">running now</b>' : r.enabled && st.next ? `<b>${relTime(st.next, now)}</b><small>${new Date(st.next).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</small>` : '<small>paused</small>'}${last(r)}</div>
      </li>`).join('')}</ul>
    <p class="sub">Runs in Claude's cloud. Next runs are computed live; last-run results are from the snapshot taken ${age}.</p>`;
}
