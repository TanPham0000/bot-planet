// Bot Planet renderer: wires the world, the crew, live data and the notch UI together.
// Battery: nothing renders while the island is collapsed; when open it runs at 30fps
// (60 only while you're dragging or the camera is flying), with low-power GPU preference.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { buildWorld, R, offsetDir } from './world.js';
import { Astronaut, describe, ACTIVITY, activityOf } from './astronaut.js';
import { makeFX } from './fx.js';
import { createUI } from './ui.js';
import { createVillage, levelOf, LEVEL_NAMES, LEVELS } from './village.js';
import { fetchLogbook, renderHouse, renderRecap, weekId } from './logbook.js';
import { createSatellites, renderSchedule, shortName, relTime } from './routines.js';
import { assignColors, colorFor, setCustom } from './colors.js';
import * as LandmarkMod from './landmarks.js';
import { createLandmarks } from './landmarks.js';
import { makePostcard } from './postcard.js';

const params = new URLSearchParams(location.search);
const bridge = window.botPlanet ?? null;
const NOTCH = params.has('notch');
const G = {
  mb: +params.get('mb') || 32,
  nw: params.has('nw') ? +params.get('nw') : 185,
  pw: +params.get('pw') || 440,
  ph: +params.get('ph') || 480,
};

const ui = createUI(
  { notch: NOTCH, ...G, bridge, fake: NOTCH && !bridge, sound: params.get('sound') !== '0' },
  { expanded: onExpanded, postcard: () => postcard(), focus: (id) => openCard(id), ack, closeCard, cycleHelp, rename, move, work: setWork, projects: () => coworkGroups, recap: () => openRecap(), busy: () => openBusyList() },
);

// ── renderer / camera ───────────────────────────────────────────────
const viewW = () => (NOTCH ? G.pw : innerWidth);
const viewH = () => (NOTCH ? G.ph : innerHeight);
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'low-power' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(viewW(), viewH());
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.getElementById('stage').appendChild(renderer.domElement);

const labels = new CSS2DRenderer({ element: document.getElementById('labels') });
labels.setSize(viewW(), viewH());

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, viewW() / viewH(), 0.1, 200);
const CAM_DIST = NOTCH ? 13.4 : 12;
const HOME = new THREE.Vector3(0, 3.4, CAM_DIST).setLength(CAM_DIST);
camera.position.copy(HOME);
scene.add(camera);

// Lights ride with the camera: whichever side you orbit to is the sunny side.
const hemi = new THREE.HemisphereLight(0xfff4e0, 0x7d70b8, 1.35);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0dc, 2.0);
sun.position.set(6, 7, 5);
camera.add(sun);
const rim = new THREE.DirectionalLight(0xa9c8ff, 0.7);
rim.position.set(-6, -2, -6);
camera.add(rim);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 4.4; // close enough to see faces; astronauts look up at you
controls.maxDistance = 19;
controls.rotateSpeed = 0.6;
controls.zoomSpeed = 0.7;

// ── world, fx, crew ──────────────────────────────────────────────────
const W = buildWorld(scene, camera, { stars: NOTCH ? 260 : 420 });
const world = W.world;
// Start with the camp in view, a little off-center
world.rotation.y = -Math.atan2(W.campDir.x, W.campDir.z) + 0.55;
const fx = makeFX(world);

const village = createVillage({ world, fx, campDir: W.campDir, campRadius: W.CAMP_RADIUS });
const env = {
  world, fx,
  campDir: W.campDir,
  campRadius: W.CAMP_RADIUS,
  seatDir: (i) => (i >= 0 ? W.seats[i]?.dir : null),
  homeDir: (name) => village.homeOf(name),
  homeSpot: (name, i) => village.homeSpot(name, i),
};
// Continent names, floating over each coloured landmass (shown when zoomed out)
// Busy name plates: every working (or waiting) astronaut wears a little tag at its feet: colour · name · job
const busyTags = new Map(); // agent id → CSS2DObject
function syncBusyTags() {
  for (const a of agents.values()) {
    const s = a.data.status;
    const busy = !a.leaving && (s === 'working' || s === 'help');
    let o = busyTags.get(a.id);
    if (!busy) { if (o) { a.root.remove(o); o.element.remove(); busyTags.delete(a.id); } continue; }
    if (!o) {
      const el = document.createElement('div');
      o = new CSS2DObject(el);
      o.position.y = -0.02;
      a.root.add(o);
      busyTags.set(a.id, o);
    }
    const job = s === 'help' ? '👋' : ACTIVITY[activityOf(a.data.tool)].emoji;
    const html = `<i style="background:${a.accent}"></i><b>${escapeHtml(a.data.name || a.data.project)}</b><span>${job}</span>`;
    if (o.element.dataset.html !== html) { o.element.innerHTML = html; o.element.dataset.html = html; }
    o.element.className = 'busytag' + (s === 'help' ? ' hot' : '');
  }
  for (const [id, o] of busyTags) if (!agents.has(id)) { o.element.remove(); busyTags.delete(id); }
}

/** "Who's busy?" — everyone working or waiting on you, tap one to fly there. */
function openBusyList() {
  closeCard();
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };
  const list = [...agents.values()].filter((a) => !a.leaving && (a.data.status === 'help' || a.data.status === 'working'))
    .sort((a, b) => (b.data.status === 'help') - (a.data.status === 'help') || a.data.since - b.data.since);
  ui.openLog(`
    <div class="lb-head"><span class="emoji">⚙️</span><h3>Busy now</h3><span class="pill">${list.length} agent${list.length === 1 ? '' : 's'}</span></div>
    ${list.length ? `<ul class="sched busy">${list.map((a) => `
      <li data-agent="${escapeHtml(a.id)}" class="${a.data.status === 'help' ? 'running' : ''}">
        <i style="background:${a.accent}"></i>
        <div class="what"><b>${escapeHtml(a.data.name || a.data.project)}</b><small>${escapeHtml(privacy ? describe(a.data).split(' · ')[0] : a.data.detail && !a.data.manual ? `${describe(a.data)} · ${a.data.detail}` : describe(a.data))}</small></div>
        <div class="when"><b>${a.data.status === 'help' ? 'needs you' : a.stuck ? '💧 stuck?' : ago(a.data.since)}</b><small>${a.data.manual ? 'marked by you' : privacy ? '' : escapeHtml(a.data.task || '')}</small></div>
      </li>`).join('')}</ul>` : '<p class="sub">Nobody is working right now. Everyone is resting at camp or at home.</p>'}`);
}

const continentLabels = new Map(); // name → CSS2DObject
function syncContinentLabels() {
  const seeds = village.seeds();
  const seen = new Set();
  for (const sd of seeds) {
    seen.add(sd.name);
    let o = continentLabels.get(sd.name);
    if (!o) {
      const el = document.createElement('div');
      el.className = 'continent';
      o = new CSS2DObject(el);
      world.add(o);
      continentLabels.set(sd.name, o);
    }
    o.element.innerHTML = `<i style="background:${sd.color}"></i>${escapeHtml(sd.name)}`;
    o.position.copy(sd.dir).multiplyScalar(R + 0.7);
    o.userData.dir = sd.dir;
  }
  for (const [name, o] of continentLabels) if (!seen.has(name)) { world.remove(o); o.element.remove(); continentLabels.delete(name); }
}

// Scheduled cloud routines → satellites
const sats = createSatellites({ world, scene });
const landmarks = createLandmarks({ world, fx });
let routinesSnap = null;
/** Which house a routine belongs to: the Cowork project sharing its folder, else the outreach house. */
function routineHome(r) {
  const byFolder = coworkGroups.find((g) => (g.folders || []).some((f) => (r.folders || []).includes(f)));
  if (byFolder) return byFolder.name;
  if (/outreach|rhythm|monday brief|friday review/i.test(r.name)) {
    const out = coworkGroups.find((g) => (g.folders || []).some((f) => /\/OUTREACH$/i.test(f)));
    if (out) return out.name;
  }
  return null;
}
function routineHomePoint(r) {
  // beam into the project's landmark (the OUTREACH lighthouse lamp), else its house
  const name = routineHome(r);
  const lm = name ? landmarks.pointFor(name) : null;
  if (lm) return lm;
  const d = village.homeOf(name);
  return d ? d.clone().multiplyScalar(R + 0.35) : null;
}
function openSchedule(highlight = null) {
  closeCard();
  ui.openLog(routinesSnap?.routines?.length
    ? renderSchedule(routinesSnap, { highlight })
    : '<p class="sub">No scheduled routines yet. Ask Claude to refresh the Bot Planet routines snapshot.</p>');
}
// failed routines: tell you once per failed run
const alertedFails = new Set();
function checkRoutineFailures() {
  for (const sat of sats.sats.values()) {
    const r = sat.r, st = sat.state || {};
    const failed = st.failed || r.lastRun?.status === 'failed';
    const key = r.id + ':' + (r.lastRun?.at || '');
    if (!failed || alertedFails.has(key)) continue;
    alertedFails.add(key);
    ui.ticker({ name: '📡 ' + shortName(r.name), detail: 'last run failed' }, '⚠️', '#e66767', { force: true });
    ui.toast?.(`⚠️ Routine "${shortName(r.name)}" failed its last run`);
  }
}
setInterval(checkRoutineFailures, 60000);

// day & night follow your clock (lights, sky, lit windows)
function nightFactor(d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60;
  const ramp = (a, b, x) => Math.min(1, Math.max(0, (x - a) / (b - a)));
  return h < 12 ? 1 - ramp(6, 8, h) : ramp(19, 21.5, h); // dawn 6–8, dusk 19–21:30
}
function applyClock() {
  const now = new Date();
  W.setTimeOfDay?.(now, { sun, rim, hemi });
  village.setNight?.(nightFactor(now));
  wake(300);
}
setInterval(applyClock, 60000);

// every 15s: who just started? (no rendering needed for this)
setInterval(() => {
  for (const r of sats.refresh()) {
    const home = routineHome(r);
    if (home) landmarks.pulse(home);
    ui.ticker({ name: '📡 ' + shortName(r.name), detail: 'started' }, '🛰️', '#ffb36b');
    ui.sfx('plink');
    wake(1500);
  }
}, 15000);

// ── activity: how much you've used each project lately → country size; 60 days idle → it vanishes ──
let activity = null;
let coworkSeen = {};
let activityTimer = 0, activityAt = 0;
function scheduleActivity() {
  if (activityTimer) return;
  const wait = Math.max(1500, 30000 - (Date.now() - activityAt)); // at most every 30s
  activityTimer = setTimeout(() => { activityTimer = 0; refreshActivity(); }, activityAt ? wait : 1500);
}
setInterval(scheduleActivity, 10 * 60 * 1000);
async function refreshActivity() {
  activityAt = Date.now();
  const m = new Map();
  const add = (name, score, lastAt) => {
    const k = String(name || '').trim().toLowerCase();
    if (!k) return;
    const c = m.get(k) || { score: 0, lastAt: 0 };
    c.score += score; c.lastAt = Math.max(c.lastAt, lastAt || 0);
    m.set(k, c);
  };
  const decay = (ageDays) => Math.pow(0.5, Math.max(0, ageDays) / 14); // a day's work counts half after 2 weeks
  try {
    const r = await fetch('/logbook?days=60');
    if (r.ok) {
      const lb = await r.json();
      const today = Date.parse(lb.today + 'T12:00');
      for (const p of lb.projects) for (const [d, st] of Object.entries(p.days || {})) {
        const t = Date.parse(d + 'T12:00');
        add(p.name, ((st.turns || 0) + 0.5 * (st.prompts || 0)) * decay((today - t) / 864e5), t);
      }
    }
  } catch {}
  for (const g of coworkGroups) for (const sid of g.sessions) {
    const t = coworkSeen[sid] || 0;
    if (t) add(g.name, 2 * decay((Date.now() - t) / 864e5), t);
    if (coworkWork[sid]) add(g.name, 6, Date.now());
  }
  for (const s of live) add(s.name, s.status === 'working' ? 4 : 1, s.updated || Date.now());
  activity = m;
  syncVillage();
}

let villageSeen = false;
let lastVillage = null, coworkGroups = [], names = {};
// v4: custom looks/spots from the crew manager, privacy, plan usage, first-seen projects
let custom = {}, privacy = false, seenProjects = {};
const hiddenName = (n) => !!custom[String(n || '').trim().toLowerCase()]?.hidden;
const postedSeen = new Set();
function reportSeen() {
  const fresh = [...village.plots.keys()].filter((k) => !seenProjects[k] && !postedSeen.has(k));
  if (!fresh.length) return;
  fresh.forEach((k) => postedSeen.add(k));
  fetch('/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: fresh }) }).catch(() => {});
}
function syncVillage(v) {
  if (v) lastVillage = v;
  if (!lastVillage && !coworkGroups.length) return;
  const opts = { animate: villageSeen, cowork: coworkGroups, names, activity, custom };
  const grew = village.update(lastVillage, opts);
  // colours stick to projects (biggest first get one); then repaint roofs + continents
  const byTurns = [...village.plots.values()].sort((a, b) => (b.turns || 0) - (a.turns || 0)).map((p) => p.name);
  if (assignColors(byTurns)) village.update(lastVillage, { ...opts, animate: false });
  W.setContinents(village.seeds());
  // one themed landmark per living project, beside its house
  landmarks.update([...village.plots.values()].filter((p) => !p.vanishing)
    .map((p) => ({ key: p.key, name: p.name, dir: p.dir, level: p.level, color: colorFor(p.name) || p.color || '#d97757' })));
  syncContinentLabels();
  reportSeen();
  villageSeen = true;
  if (grew.length) { ui.sfx('chime'); wake(2500); }
}

/**
 * Cowork sessions outside a Cowork project are grouped by folder, which gives lots of tiny groups.
 * Fold each one-session folder group (that you haven't named) into the group owning its parent
 * folder, e.g. "Projects/Maria 01" → "Projects". Groups that end up with the same name share a house.
 */
function foldCowork(groups) {
  const out = groups.map((g) => ({ ...g, sessions: [...g.sessions], folders: [...(g.folders || [])] }));
  const owner = (folder, self) => {
    let best = null;
    for (const g of out) {
      if (g === self || !g.sessions.length) continue;
      for (const f of g.folders) if (folder.startsWith(f + '/') && (!best || f.length > best.f.length)) best = { g, f };
    }
    return best?.g;
  };
  for (const g of out) {
    if (g.named || g.sessions.length > 1 || !g.key.startsWith('folder:')) continue;
    const home = owner(g.folders[0] || '', g);
    if (home) { home.sessions.push(...g.sessions); g.sessions = []; }
  }
  return out.filter((g) => g.sessions.length);
}

// Cowork sessions (no live status): one astronaut per session, at most a few per project.
const COWORK_PER_PROJECT = 6;
let coworkWork = {}; // sessionId → { label, since } — "Working on it", set by hand on the card
function coworkCrew(groups) {
  const out = [];
  const perName = new Map(); // groups that share a name share a house: number their residents together
  for (const g of groups) {
    const k = g.name.trim().toLowerCase();
    const total = groups.filter((x) => x.name.trim().toLowerCase() === k).reduce((n, x) => n + x.sessions.length, 0);
    // sessions you marked as working come first, so they're always among the astronauts shown
    const ordered = [...g.sessions].sort((a, b) => !!coworkWork[b] - !!coworkWork[a]);
    for (const sid of ordered) {
      const i = perName.get(k) ?? 0;
      if (i >= COWORK_PER_PROJECT) break;
      perName.set(k, i + 1);
      out.push({
      id: 'cw:' + sid, coworkId: sid, cowork: true, homeIdx: i, projectSize: total,
      name: g.name, project: g.name, projectKey: g.key, named: g.named, groupSize: g.sessions.length, folders: g.folders,
      cwd: g.folders?.[0] || '', status: 'idle', tool: '', message: '', task: '', title: '', subagents: [],
      since: Date.now(), updated: Date.now(),
      // marked "Working on it": goes to work by its house, label as speech bubble
      ...(coworkWork[sid] ? {
        status: 'working', tool: 'Write', manual: true,
        task: coworkWork[sid].label, detail: coworkWork[sid].label || 'working on it',
        detailAt: coworkWork[sid].since, since: coworkWork[sid].since,
      } : {}),
      });
    }
  }
  return out;
}
function demoVillage() {
  const turns = [620, 260, 120, 48, 18, 7, 2, 90, 30];
  return { projects: DEMO_CREW.map(([name], i) => ({ key: '~/Documents/Code/' + name, name, turns: turns[i], edits: turns[i] * 3, commands: turns[i], sessions: 3, firstAt: Date.now() - 864e6, lastAt: Date.now() - (i % 3) * 7e7 })) };
}
/** @type {Map<string, Astronaut>} */
const agents = new Map();
const accentOf = (id) => agents.get(id)?.accent ?? '#8cc8f5';

// Hover name tag (one element, moved to whoever is hovered)
const tagEl = document.createElement('div');
tagEl.className = 'tag';
const tag = new CSS2DObject(tagEl);
tag.position.y = 1.08;
tag.visible = false;

const board = new CSS2DObject(ui.board);
board.center.set(0.5, 1);
W.boardAnchor.add(board);

// ── data: live sessions, or a demo crew when there are none ─────────
let live = [];
let demo = [];
let demoTimer = 0;
let current = [];
const forceDemo = params.has('demo');

const DEMO_CREW = [
  ['phamcreative-site', 'Tighten the /helsinki hero spacing', 'working', 'Edit'],
  ['medieval-rts', 'Pathfinding for cavalry units', 'help', ''],
  ['taste-shift', 'Stage 4: drift timeline chart', 'working', 'Bash'],
  ['sticker-smash', 'Render the promo video frames', 'done', ''],
  ['linkedin-network', 'Cluster labels overlap fix', 'idle', ''],
  ['bot-planet', 'Notch island + camp board', 'working', 'Task'],
  ['pham-outreach', 'Draft Slush follow-ups', 'working', 'WebSearch'],
  ['knowledge', 'Update pricing rules', 'done', ''],
  ['castle-tracker', 'Fix the save-slot bug', 'working', 'Read'],
];
const DEMO_TOOLS = ['Edit', 'Bash', 'Read', 'Grep', 'WebSearch', 'TodoWrite', 'Task', 'Write', 'mcp__figma__get_screenshot', ''];
const DEMO_DETAIL = {
  Edit: 'hero.tsx', Bash: 'npm test', Read: 'README.md', Grep: '“notch”', WebSearch: '“slush 2026 exhibitors”',
  TodoWrite: 'Wiring the camp board', Task: 'Explore the repo', Write: 'village.mjs', mcp__figma__get_screenshot: 'figma: get_screenshot',
};
const DEMO_ASKS = ['Claude needs your permission to use Bash', 'Has a question for you', 'Wants you to approve a plan', 'Claude needs your permission to use Write'];

function startDemo() {
  if (demoTimer) return;
  const now = Date.now();
  demo = DEMO_CREW.map(([name, task, status, tool], i) => ({
    id: 'demo-' + i, name, project: name, cwd: '~/Documents/Code/' + name, task, title: task, status, tool,
    message: status === 'help' ? DEMO_ASKS[0] : status === 'done' ? 'Finished — your turn' : '',
    subagents: tool === 'Task' ? [{ id: 'a', description: 'Explore repo', since: now }, { id: 'b', description: 'Write tests', since: now }] : [],
    since: i === 4 ? now - 30 * 60 * 1000 : now, updated: now, demo: true,
  }));
  demoTimer = setInterval(() => {
    const s = demo[Math.floor(Math.random() * demo.length)];
    const r = Math.random();
    const next = s.status === 'help' ? 'working' : r < 0.12 ? 'help' : r < 0.26 ? 'done' : r < 0.3 ? 'idle' : 'working';
    if (next !== s.status) s.since = Date.now();
    s.status = next;
    s.tool = next === 'working' ? DEMO_TOOLS[Math.floor(Math.random() * DEMO_TOOLS.length)] : '';
    s.detail = DEMO_DETAIL[s.tool] || (next === 'help' ? 'npm run deploy' : '');
    s.detailAt = Date.now();
    s.subagents = s.tool === 'Task' ? Array.from({ length: 1 + Math.floor(Math.random() * 3) }, (_, k) => ({ id: 'x' + k, description: 'helper ' + (k + 1), since: Date.now() })) : [];
    s.message = next === 'help' ? DEMO_ASKS[Math.floor(Math.random() * DEMO_ASKS.length)] : next === 'done' ? 'Finished — your turn' : '';
    sync(demo.map((d) => ({ ...d })));
  }, 3500);
}
function stopDemo() { clearInterval(demoTimer); demoTimer = 0; demo = []; }

let firstSync = true;
const prevStatus = new Map();
function connect() {
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    live = msg.sessions || [];
    names = msg.names || {};
    coworkGroups = foldCowork(msg.cowork?.groups || []);
    coworkWork = msg.work || {};
    custom = msg.custom || {};
    seenProjects = msg.seenProjects || {};
    if (setCustom(custom)) { (LandmarkMod.setCustom || LandmarkMod.setCustomThemes || (() => {}))(custom); }
    privacy = !!msg.privacy;
    ui.setPrivacy?.(privacy);
    ui.setUsage?.(msg.usage);
    coworkSeen = msg.coworkSeen || {};
    scheduleActivity();
    if (msg.routines) { routinesSnap = msg.routines; sats.update(routinesSnap.routines); sats.refresh(); if (!firstSync) checkRoutineFailures(); }
    const crew = live.concat(coworkCrew(coworkGroups)).filter((s) => !hiddenName(s.name));
    if (crew.length && !forceDemo) { stopDemo(); syncVillage(msg.village); sync(crew); }
    else { startDemo(); coworkGroups = []; syncVillage(forceDemo || !msg.village?.projects?.length ? demoVillage() : msg.village); sync(demo.map((d) => ({ ...d }))); }
  };
  es.onerror = () => { if (!live.length && !demoTimer) { startDemo(); sync(demo.map((d) => ({ ...d }))); } };
}

const resting = (s) => s.status === 'done' || s.status === 'idle';

function spawnDir(s) {
  if (s.cowork) { const h = village.homeSpot(s.name, s.homeIdx); if (h) return h; }
  if (resting(s)) return offsetDir(W.campDir, Math.random() * 6.28, 0.3);
  // somewhere you can see, but outside the camp
  const camLocal = world.worldToLocal(camera.position.clone()).normalize();
  for (let i = 0; i < 10; i++) {
    const d = offsetDir(camLocal, Math.random() * 6.28, 0.25 + Math.random() * 0.7);
    if (d.angleTo(W.campDir) > W.CAMP_RADIUS + 0.15) return d;
  }
  return offsetDir(W.campDir, Math.random() * 6.28, W.CAMP_RADIUS + 0.4);
}

function assignSeats(newcomers) {
  const taken = new Set();
  // camp is for Claude Code sessions; Cowork crews hang out at their own project's house
  const rest = [...agents.values()].filter((a) => !a.leaving && resting(a.data) && !a.data.cowork);
  for (const a of agents.values()) if (!resting(a.data) || a.leaving || a.data.cowork) a.seat = -1;
  for (const a of rest) if (a.seat >= 0 && !taken.has(a.seat)) taken.add(a.seat); else a.seat = -1;
  // more resting crew than seats: add an extra ring
  let k = 0;
  while (W.seats.length < rest.length) W.seats.push({ dir: offsetDir(W.campDir, (k++ * 2.4) % 6.28, 0.47 + (k % 2) * 0.04) });
  for (const a of rest) {
    if (a.seat >= 0) continue;
    let i = 0;
    while (taken.has(i)) i++;
    a.seat = i; taken.add(i);
    if (newcomers.has(a)) a.p.copy(W.seats[i].dir); // newcomers drop straight onto their seat
  }
}

function sync(raw) {
  // Astronauts carry their project's name; several sessions of one project share it (and its look).
  const sessions = raw;
  current = sessions;
  // newest tool call (if any) → the collapsed notch's live ticker
  let fresh = null;
  for (const s of sessions) {
    const prev = agents.get(s.id)?.data;
    if (s.status === 'working' && s.detail && s.detailAt && (!prev || s.detailAt > (prev.detailAt || 0)) && (!fresh || s.detailAt > fresh.detailAt)) fresh = s;
  }
  if (fresh && !firstSync) ui.ticker(fresh, ACTIVITY[activityOf(fresh.tool)].emoji, accentOf(fresh.id));
  const seen = new Set();
  const newcomers = new Set();
  for (const s of sessions) {
    seen.add(s.id);
    const a = agents.get(s.id);
    if (a) { a.setData(s); a.homeIdx = s.homeIdx; }
    else {
      const n = new Astronaut(s, env, spawnDir(s));
      n.homeIdx = s.homeIdx;
      n.syncDrones();
      agents.set(s.id, n);
      newcomers.add(n);
    }
  }
  for (const [id, a] of agents) if (!seen.has(id)) a.leave();
  assignSeats(newcomers);
  if (!firstSync) for (const s of sessions) {
    const before = prevStatus.get(s.id);
    if (before === 'working' && (s.status === 'done' || (s.cowork && s.status === 'idle'))) landmarks.pulse(s.name);
  }
  prevStatus.clear();
  for (const s of sessions) prevStatus.set(s.id, s.status);
  syncBusyTags();
  const { newHelp } = ui.update(sessions, accentOf, { fresh: firstSync });
  ui.renderBoard(sessions);
  document.getElementById('demo-note').style.display = sessions.length && sessions[0].demo ? '' : 'none';
  if (newHelp.length) spinTo = newHelp[0].id;
  if (firstSync && sessions.some((s) => s.status === 'help')) spinTo = sessions.find((s) => s.status === 'help').id;
  firstSync = false;
  wake(1500);
}

// ── selection, card, camera ──────────────────────────────────────────
let selected = null;
let hovered = null;
let flyTo = null;        // camera target position (world space)
let spinTo = null;       // agent id the planet should turn toward
let lastInteract = -10;

function openCard(id) {
  const a = agents.get(id);
  if (!a) return;
  selected = id;
  ui.openCard(a.data, a.accent);
  const dirW = a.root.getWorldPosition(new THREE.Vector3()).normalize();
  const dist = Math.min(Math.max(camera.position.length(), 9.5), NOTCH ? 11.5 : 12);
  flyTo = camera.position.clone().normalize().lerp(dirW, 0.62).normalize().multiplyScalar(dist);
  wake(2000);
}
function closeCard() { selected = null; ui.closeCard(); wake(300); }
function ack(id) {
  const a = agents.get(id);
  if (!a) return;
  if (a.data.demo) { const d = demo.find((x) => x.id === id); if (d) { d.status = 'working'; d.since = Date.now(); d.tool = 'Edit'; } sync(demo.map((x) => ({ ...x }))); }
  else fetch('/ack?id=' + encodeURIComponent(id), { method: 'POST' });
}
/** Name a project (Claude Code project key or Cowork group key). */
function rename(key, name) {
  if (!key) return;
  fetch('/name', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, name }) });
}
/** Mark a Cowork session as working (with an optional label) or done. */
function setWork(coworkId, on, label = '') {
  fetch('/work', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: coworkId, on, label }) });
}
/** Move one Cowork session to another project group. */
function move(coworkId, key) {
  fetch('/assign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: coworkId, key: key || null }) });
}
// ── logbook ──
async function openHouse(plot) {
  closeCard();
  ui.openLog('<p class="sub">Reading the logbook…</p>');
  const dirW = world.localToWorld(plot.dir.clone().multiplyScalar(R)).normalize();
  flyTo = camera.position.clone().normalize().lerp(dirW, 0.55).normalize().multiplyScalar(Math.min(Math.max(camera.position.length(), 9.5), 12));
  wake(2000);
  try { ui.openLog(renderHouse(await fetchLogbook(), plot)); }
  catch (e) { ui.openLog(`<p class="sub">${e.message}</p>`); }
}
/**
 * Group photo for the postcard, seen from above: everyone spreads out over the front of the planet,
 * leans back to look up at the camera, and waves or dances.
 */
const POSES = ['wave', 'cheer', 'spin', 'robot', 'jump', 'heart', 'peace', 'hips', 'sway', 'point'];
let photoMode = false;
function arrangePhoto(crew) {
  world.updateMatrixWorld();
  const eye = world.worldToLocal(camera.position.clone());
  const c = eye.clone().normalize();                                                         // planet point facing the camera
  const upL = new THREE.Vector3(0, 1, 0).applyQuaternion(world.quaternion.clone().invert()); // screen-up, in planet space
  const up = upL.projectOnPlane(c).normalize();
  const right = new THREE.Vector3().crossVectors(up, c).normalize();
  // a sunflower spiral: evenly spread, denser in the middle, all on the visible face
  const n = crew.length, spread = Math.min(0.78, 0.26 + 0.095 * Math.sqrt(n));
  crew.forEach((a, i) => {
    const r = spread * Math.sqrt((i + 0.5) / n), th = i * 2.39996;
    const dir = c.clone().addScaledVector(right, Math.cos(th) * r).addScaledVector(up, Math.sin(th) * r).normalize();
    const pose = a.data.status === 'help' ? 'wave' : POSES[(i * 7 + 3) % POSES.length];
    a.photo = { dir, pose, face: eye, lookUp: true }; // no emotes: the poses say enough (emotes cluttered the picture)
  });
}

async function postcard() {
  const crew = [...agents.values()].filter((a) => !a.leaving);
  const camSave = camera.position.clone();
  try {
    // say cheese: line up, frame the group, let a few frames settle
    // a clean top-down view of the planet's front, then everyone spreads out on it and looks up
    camera.position.setLength(12.6);
    controls.update();
    arrangePhoto(crew);
    photoMode = true;
    closeCard(); ui.closeLog?.();
    controls.enabled = false;
    for (let i = 0; i < 3; i++) step(1 / 30);   // let everyone snap into place
    const lb = await fetchLogbook().catch(() => null);
    const palette = {};
    for (const p of village.plots.values()) palette[p.name] = colorFor(p.name) || p.color;
    const d = new Date();
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    const weekLabel = 'Week of ' + monday.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    const url = await makePostcard({ renderer, scene, camera, logbook: lb, palette, weekLabel });
    if (bridge?.savePostcard) {
      const file = await bridge.savePostcard(url);
      ui.toast?.(`📮 Saved to Downloads: ${file.split('/').pop()}`);
    } else {
      const a = document.createElement('a'); a.href = url; a.download = 'bot-planet-postcard.png'; a.click();
    }
    ui.sfx('chime');
  } catch (e) { ui.toast?.('Postcard failed: ' + e.message); }
  finally {
    // back to work: they'll stroll back to their seats and sites from the photo spot
    photoMode = false;
    for (const a of crew) a.photo = null;
    camera.up.set(0, 1, 0);
    camera.position.copy(camSave);
    controls.enabled = true;
    controls.update();
    wake(2000);
  }
}

async function openRecap() {
  closeCard();
  ui.openLog('<p class="sub">Reading the logbook…</p>');
  try {
    const waiting = [...agents.values()].filter((a) => a.data.status === 'help').length;
    ui.openLog(renderRecap(await fetchLogbook(), { waiting }));
    try { localStorage.setItem('bp-recap-week', weekId()); } catch {}
  } catch (e) { ui.openLog(`<p class="sub">${e.message}</p>`); }
}
/** First time the planet opens in a new week: show the recap once. */
function maybeWeeklyRecap() {
  let seen = null;
  try { seen = localStorage.getItem('bp-recap-week'); } catch { return; }
  if (seen !== weekId() && !current[0]?.demo) setTimeout(openRecap, 700);
}

function cycleHelp() {
  const waiting = [...agents.values()].filter((a) => a.data.status === 'help' && !a.leaving);
  if (!waiting.length) return;
  const i = waiting.findIndex((a) => a.id === selected);
  openCard(waiting[(i + 1) % waiting.length].id);
}
bridge?.onFocusAgent?.((id) => { ui.open(); setTimeout(() => (id === '@logbook' ? openRecap() : id === '@schedule' ? openSchedule() : id === '@postcard' ? postcard() : openCard(id)), 50); });

function onExpanded(open) {
  if (open) {
    start();
    maybeWeeklyRecap();
    const h = [...agents.values()].find((a) => a.data.status === 'help' && !a.leaving);
    if (h && !selected) spinTo = h.id;
  } else {
    wake(600); // let the close animation finish, then stop rendering
  }
}

// ── picking ──────────────────────────────────────────────────────────
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
let pointerDirty = false;

function setRay(clientX, clientY) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
}
/** Distance along the ray to a sphere at the origin, or Infinity. */
function hitSphere(center, radius) {
  const o = ray.ray.origin, d = ray.ray.direction;
  tmp2.subVectors(o, center);
  const b = tmp2.dot(d), c = tmp2.lengthSq() - radius * radius, disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : Infinity;
}
function pick() {
  const planetT = hitSphere(tmp.set(0, 0, 0), R + 0.02);
  let best = null, bestT = Infinity;
  for (const a of agents.values()) {
    if (a.leaving) continue;
    world.localToWorld(a.center(tmp));
    const t = hitSphere(tmp, 0.3);
    if (t < bestT && t < planetT + 0.25) { best = a; bestT = t; }
  }
  return { agent: best, planetT };
}

const canvas = renderer.domElement;
let pointerInside = false;
canvas.addEventListener('pointermove', () => { pointerDirty = true; pointerInside = true; });
canvas.addEventListener('pointerleave', () => {
  pointerInside = false; hovered = null; hoverKey = null; tag.visible = false; });
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  setRay(e.clientX, e.clientY);
  const { agent, planetT } = pick();
  if (agent) { agent.poke(); ui.sfx('pop'); openCard(agent.id); return; }
  const sh = sats.pick(ray, world);
  if (sh && sh.t < planetT) { ui.sfx('pop'); openSchedule(sh.sat.r.id); return; }
  W.moon.getWorldPosition(tmp);
  if (hitSphere(tmp, 0.4) < planetT) { W.boingMoon(); ui.sfx('boing'); wake(1500); return; }
  if (planetT < Infinity) {
    const local = world.worldToLocal(ray.ray.at(planetT, new THREE.Vector3()));
    const plot = village.pick(local);
    if (plot) { ui.sfx('pop'); openHouse(plot); return; }
    const n = W.plant(local);
    fx.puff(local.clone().setLength(R + 0.01), n, 5);
    ui.sfx('plink');
    wake(1200);
    return;
  }
  closeCard();
  ui.closeLog();
});
canvas.addEventListener('dblclick', () => { flyTo = HOME.clone(); closeCard(); });
controls.addEventListener('start', () => { flyTo = null; spinTo = null; interacting = true; lastInteract = clock; });
controls.addEventListener('end', () => { interacting = false; lastInteract = clock; });

function updateHover() {
  if (!pointerDirty) return;
  pointerDirty = false;
  const p = ui.pointer;
  setRay(p.x, p.y);
  const { agent: a, planetT } = pick();
  // houses: hover shows whose it is and how far it has grown
  let plot = null, sat = null;
  if (!a) { const sh = sats.pick(ray, world); if (sh && sh.t < planetT) sat = sh.sat; }
  if (!a && !sat && planetT < Infinity) plot = village.pick(world.worldToLocal(ray.ray.at(planetT, new THREE.Vector3())));
  const id = a?.id ?? (sat ? 'sat:' + sat.r.id : plot ? 'plot:' + plot.key : null);
  if (id === hoverKey) return;
  hoverKey = id;
  hovered = a?.id ?? null;
  canvas.style.cursor = a ? 'pointer' : '';
  if (a) {
    a.root.add(tag);
    tag.position.y = 1.08;
    tag.visible = true;
    tagEl.innerHTML = `<b>${escapeHtml(a.data.name || a.data.project)}</b><span>${escapeHtml(describe(a.data))}</span>`;
  } else if (sat) {
    canvas.style.cursor = 'pointer';
    sat.g.add(tag);
    tag.position.y = 0.32;
    tag.visible = true;
    const st = sat.state;
    tagEl.innerHTML = `<b>📡 ${escapeHtml(shortName(sat.r.name))}</b><span>${!sat.r.enabled ? 'paused' : st.running ? 'running now' : st.next ? 'next ' + relTime(st.next) : ''}</span>`;
  } else if (plot) {
    plotAnchor.position.copy(plot.dir).multiplyScalar(R + 0.5);
    plotAnchor.add(tag);
    tag.position.y = 0;
    tag.visible = true;
    const next = LEVELS[plot.level];
    tagEl.innerHTML = `<b>${escapeHtml(plot.name)}</b><span>${LEVEL_NAMES[plot.level - 1]} · ${plot.turns} tasks done${next ? ` · ${next - plot.turns} to grow` : ''}</span>`;
  } else tag.visible = false;
}
let hoverKey = null;
const plotAnchor = new THREE.Object3D();
world.add(plotAnchor);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ── loop (battery-aware) ─────────────────────────────────────────────
let running = false;
let interacting = false;
let lastFrame = 0;
let wakeUntil = 0;
let clock = 0;
let emberT = 0;
const camLocal = new THREE.Vector3();
const shouldRun = () => !document.hidden && (!NOTCH || ui.state === 'open');

function wake(ms = 500) {
  wakeUntil = Math.max(wakeUntil, performance.now() + ms);
  if (shouldRun()) start();
}
function start() {
  if (running) return;
  running = true;
  lastFrame = performance.now();
  requestAnimationFrame(loop);
}

function loop(now) {
  if (!running) return;
  const fast = interacting || flyTo || pointerDirty || spinTo;
  if (now - lastFrame < (fast ? 1000 / 60 : 1000 / 30) - 2) { requestAnimationFrame(loop); return; }
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
  clock += dt;
  step(dt);
  if (shouldRun() || now < wakeUntil) requestAnimationFrame(loop);
  else running = false;
}

function step(dt) {
  const t = clock;
  updateHover();

  // planet turns: toward whoever needs you, otherwise a lazy spin
  const anyHelp = [...agents.values()].some((a) => a.data.status === 'help' && !a.leaving);
  const userRecently = t - lastInteract < 3 || interacting;
  if (spinTo && !userRecently) {
    const a = agents.get(spinTo);
    if (!a || a.lift > 0.05) { if (!a) spinTo = null; }
    else {
      const wp = tmp.copy(a.p).applyQuaternion(world.quaternion);
      const err = wrap(Math.atan2(camera.position.x, camera.position.z) - Math.atan2(wp.x, wp.z));
      world.rotation.y += err * (1 - Math.exp(-dt * 2.5));
      if (Math.abs(err) < 0.01) spinTo = null;
    }
  } else if (!anyHelp && !selected && !userRecently) {
    if (!photoMode) world.rotation.y += dt * 0.045;
  }

  if (flyTo && !photoMode) {
    camera.position.lerp(flyTo, 1 - Math.exp(-dt * 3));
    if (camera.position.distanceTo(flyTo) < 0.02) flyTo = null;
  }
  if (!photoMode) controls.update(); // the group-photo camera is placed by hand

  world.updateMatrixWorld();
  camLocal.copy(camera.position);
  world.worldToLocal(camLocal);
  const crew = [...agents.values()];
  // what "you" are near: the spot under your cursor, and (zoomed in) the spot under the camera
  let focusDir = null;
  if (pointerInside) {
    setRay(ui.pointer.x, ui.pointer.y);
    const pt = hitSphere(tmp.set(0, 0, 0), R + 0.02);
    if (pt < Infinity) focusDir = world.worldToLocal(ray.ray.at(pt, new THREE.Vector3())).normalize();
  }
  const camDist = camera.position.length();
  const camNear = camDist < 9.5 ? 0.985 - (9.5 - camDist) * 0.02 : null; // closer → a wider circle notices you
  const camDirLocal = camLocal.clone().normalize();
  const ctx = { t, dt, camLocal, camDirLocal, camNear, focusDir, selected, hovered, agents: crew, speaking: whoSpeaks(crew), photo: photoMode };
  for (const a of crew) {
    if (!a.update(ctx)) {
      agents.delete(a.id);
      if (selected === a.id) closeCard();
      if (hovered === a.id) { hovered = null; tag.visible = false; }
    }
  }

  W.update(t, dt);
  village.tick(t, dt);
  landmarks.tick(t, dt);
  sats.tick(t, dt, routineHomePoint);
  if ((emberT -= dt) <= 0) {
    emberT = 0.18 + Math.random() * 0.2;
    fx.embers(tmp.copy(W.campDir).multiplyScalar(R + 0.12), W.campDir);
  }
  fx.update(dt);

  // busy plates only on the side facing you
  const camDirW = tmp2.copy(camera.position).normalize();
  for (const [id, o] of busyTags) {
    const a = agents.get(id);
    o.visible = !!a && id !== hovered && !photoMode && tmp.copy(a.p).applyQuaternion(world.quaternion).dot(camDirW) > 0.25;
  }

  // continent names: only zoomed out, and only for continents facing you
  const zoomedOut = camera.position.length() > 10.5;
  for (const o of continentLabels.values()) {
    o.visible = zoomedOut && tmp.copy(o.userData.dir).applyQuaternion(world.quaternion).dot(tmp2.copy(camera.position).normalize()) > 0.35;
  }

  // camp board only when the camp faces you
  const campW = tmp.copy(W.campDir).applyQuaternion(world.quaternion);
  board.visible = campW.dot(tmp2.copy(camera.position).normalize()) > 0.3;

  renderer.render(scene, camera);
  labels.render(scene, camera);
}
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Speech bubbles: whoever is hovered/selected, anyone asking for you, plus the 3 freshest bits of news.
const SPEECH_MS = 4500;
function whoSpeaks(crew) {
  if (privacy) return new Set(); // privacy mode: no file names or commands floating around
  const now = Date.now();
  const ids = new Set();
  if (hovered) ids.add(hovered);
  if (selected) ids.add(selected);
  for (const a of crew) if (a.data.status === 'help' && a.data.detail) ids.add(a.id);
  crew.filter((a) => a.data.status === 'working' && a.data.detail && now - (a.data.detailAt || 0) < SPEECH_MS)
    .sort((a, b) => b.data.detailAt - a.data.detailAt).slice(0, 3).forEach((a) => ids.add(a.id));
  return ids;
}

addEventListener('resize', () => {
  if (NOTCH) return;
  camera.aspect = viewW() / viewH();
  camera.updateProjectionMatrix();
  renderer.setSize(viewW(), viewH());
  labels.setSize(viewW(), viewH());
  wake(100);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(300); });

// keep "waiting 3m" / napping states fresh without rendering
setInterval(() => {
  if (selected) { const a = agents.get(selected); if (a) ui.refreshCard(a.data, a.accent); }
  ui.renderBoard(current);
}, 10000);

connect();
applyClock();
setTimeout(checkRoutineFailures, 4000);
wake(1000);

// Debug handle for the console / automated checks
if (params.has("debug")) window.__bp = { agents, world, camera, openCard, openHouse, openRecap, openSchedule, sats, landmarks, postcard, village, ui, W, get running() { return running; } };
