// Crew manager: every project and agent in one bigger window. Customise each project's crew (colour,
// hat, landmark, spot, hidden), rename or remove projects, name agents and sort them into projects,
// see what's new, jump to any agent or fly to it on the planet, and look back at a week of usage.
// Data: SSE /events (v1–v5 contract) + GET /logbook?days=30. Writes: POST /name, /assign, /custom, /seen, /reviewed.
import * as THREE from 'three';
import { PALETTE, setCustom } from './colors.js';
import { ACCENTS, HATS, hashStr, describe } from './astronaut.js';
import { THEMES, guessTheme } from './landmarks.js';
import { createPreview, createGlobe, autoSpots, renderOnce } from './crew-3d.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const nk = (s) => String(s ?? '').trim().toLowerCase();
const slug = (s) => nk(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
const isHex = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
const base = (f) => String(f || '').replace(/\/+$/, '').split('/').pop() || f;
const qs = new URLSearchParams(location.search);
const BASE = (qs.get('api') || '').replace(/\/$/, '');
window.__crewRender = renderOnce; // tests: rAF is paused in hidden windows

const HAT_INFO = { cap: ['🧢', 'Cap'], beanie: ['🧶', 'Beanie'], crown: ['👑', 'Crown'], headphones: ['🎧', 'Headphones'], propeller: ['🌀', 'Propeller'], tophat: ['🎩', 'Top hat'], bow: ['🎀', 'Bow'], flower: ['🌸', 'Flower'] };
const THEME_INFO = { lighthouse: ['🗼', 'Lighthouse'], printshop: ['🖨️', 'Print shop'], server: ['🖥️', 'Server'], vault: ['🏦', 'Vault'], windmill: ['🌾', 'Windmill'] };
const STATUS = { help: ['needs you', 0], working: ['working', 1], done: ['your turn', 2], idle: ['idle', 3] };
const MAX_PLOTS = 14, IDLE_DAYS = 60; // same as village.js
// Projects Tân sorts Cowork chats into; offered under "New project" until they exist. Folder hints suggest one.
const STARTERS = ['Proposals', 'Facturen', 'Slush', 'Future ready'];
const FOLDER_HINTS = [[/\/financ|factu|invoice|boekhoud/i, 'Facturen'], [/proposal|offerte|quote/i, 'Proposals'], [/slush/i, 'Slush'], [/future.?ready/i, 'Future ready']];

// ── state ─────────────────────────────────────────────────────────────
const S = { sessions: [], village: null, cowork: [], sessionFolders: {}, coworkSeen: {}, names: {}, custom: {}, seen: {}, reviewed: {}, work: {}, usage: null, usageHistory: [], privacy: false, logbook: null, connected: false, got: false };
let projects = [], byKey = new Map();
let view = 'projects', selKey = null, sortBy = 'active', filter = '', showRemoved = false;
let aFilter = '', aSeg = 'all';
const picked = new Set();      // agent ids ticked in the Agents grid
let newFor = null;             // agent id (or 'bulk') whose "New project…" box is open
let focusNew = false;          // focus that box once, right after it opens
try {
  sortBy = localStorage.getItem('bp-crew-sort') || sortBy;
  selKey = localStorage.getItem('bp-crew-sel') || null;
  view = localStorage.getItem('bp-crew-view') || view;
} catch {}
if (!['projects', 'agents', 'usage'].includes(view)) view = 'projects';

// The planet's sticky colour slots (colors.js registry, shared localStorage). Re-read when the planet changes it.
let slots = {};
const readSlots = () => { try { slots = JSON.parse(localStorage.getItem('bp-continent-colors') || '{}') || {}; } catch { slots = {}; } };
readSlots();
window.addEventListener('storage', (e) => { if (e.key === 'bp-continent-colors' || e.key === 'bp-spots') { readSlots(); render(); } });

const autoColor = (k) => (Number.isInteger(slots[k]) && PALETTE[slots[k]]) || ACCENTS[hashStr(k) % ACCENTS.length];
const autoHat = (k) => HATS[hashStr(k + '#hat') % HATS.length];
const lookOf = (p) => {
  const c = S.custom[p.key] || {};
  return {
    color: isHex(c.color) ? c.color.toLowerCase() : autoColor(p.key),
    hat: HATS.includes(c.hat) ? c.hat : autoHat(p.key),
    theme: THEMES.includes(c.theme) ? c.theme : guessTheme(p.name, p.rawKey),
    hidden: !!c.hidden,
    removed: Number(c.removed) || 0,
    spot: Array.isArray(c.spot) && c.spot.length === 3 ? c.spot : null,
  };
};
const isNew = (k) => (S.seen[k] ?? 0) > (S.reviewed[k] ?? 0);
const priv = (text) => (S.privacy ? '<span class="hiddenpriv">hidden in privacy mode</span>' : esc(text));

function ago(ts) {
  if (!ts || !isFinite(ts)) return '—';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
const since = (ts) => ago(ts).replace(' ago', '');
const fmtNum = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const shortDate = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// Perceptual colour distance (CIE76 ΔE): under ~14 two continents read as the same colour.
function lab(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), y = f(r * 0.2126 + g * 0.7152 + b * 0.0722), z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const deltaE = (a, b) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };

// ── API ───────────────────────────────────────────────────────────────
async function post(path, body) {
  try {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(r.status);
    return true;
  } catch {
    toast("Couldn't save — is Bot Planet running?");
    return false;
  }
}
/** Optimistic: apply the patch locally (preview updates instantly), then save (unless local). */
function patchCustom(key, patch, { local = false } = {}) {
  const cur = { ...(S.custom[key] || {}) };
  for (const [f, v] of Object.entries(patch)) { if (v === null) delete cur[f]; else cur[f] = v; }
  S.custom = { ...S.custom };
  if (Object.keys(cur).length) S.custom[key] = cur; else delete S.custom[key];
  render();
  return local ? Promise.resolve(true) : post('/custom', { key, patch });
}
/** Optimistic name change (agents, projects): show it at once, then save. */
function setName(key, name) {
  S.names = { ...S.names };
  if (name) S.names[key] = name; else delete S.names[key];
  return post('/name', { key, name });
}

let colorDraft = null; // { key, color } while the colour picker is being dragged: wins over SSE until saved
function connect() {
  const es = new EventSource(BASE + '/events' + (qs.has('privacy') || qs.has('host') || qs.has('usage') ? `?${qs}` : ''));
  es.onopen = () => { S.connected = true; renderHeader(); };
  es.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    S.sessions = m.sessions || [];
    if ('village' in m) S.village = m.village;
    if (m.cowork) { S.cowork = m.cowork.groups || []; S.sessionFolders = m.cowork.sessionFolders || {}; }
    S.coworkSeen = m.coworkSeen || S.coworkSeen;
    S.names = m.names || S.names;
    S.custom = m.custom || {};
    if (colorDraft) S.custom = { ...S.custom, [colorDraft.key]: { ...(S.custom[colorDraft.key] || {}), color: colorDraft.color } };
    S.seen = m.seenProjects || {};
    S.reviewed = m.reviewed || {};
    S.work = m.work || {};
    S.usage = m.usage ?? null;
    if (Array.isArray(m.usageHistory)) S.usageHistory = m.usageHistory;
    S.privacy = !!m.privacy;
    S.connected = S.got = true;
    render();
    markSeen();
  };
  es.onerror = () => { S.connected = false; renderHeader(); };
}
async function loadLogbook() {
  try {
    const r = await fetch(BASE + '/logbook?days=30', { cache: 'no-store' });
    if (r.status === 503) { setTimeout(loadLogbook, 3000); return; }
    if (!r.ok) throw new Error(r.status);
    S.logbook = await r.json();
    render();
  } catch { setTimeout(loadLogbook, 15000); }
}
setInterval(loadLogbook, 5 * 60 * 1000);

// Tell the server about every project we know, so it can stamp first-seen times.
const told = new Set();
function markSeen() {
  if (!S.village && !S.cowork.length && !S.sessions.length) return;
  const keys = projects.map((p) => p.key).filter((k) => !told.has(k));
  if (!keys.length) return;
  keys.forEach((k) => told.add(k));
  post('/seen', { keys });
}

// ── projects: one entry per nameKey (same merge as the planet) ─────────
let homeOf = new Map(); // Cowork session id → the group key it really sits in on the server
function foldCowork(groups) {
  homeOf = new Map();
  for (const g of groups) for (const sid of g.sessions || []) homeOf.set(sid, g.key);
  // a lone, unnamed folder group inside another group's folder joins that group (as app.js does)
  const out = groups.map((g) => ({ ...g, sessions: [...(g.sessions || [])], folders: [...(g.folders || [])] }));
  const owner = (folder, self) => {
    let best = null;
    for (const g of out) {
      if (g === self || !g.sessions.length) continue;
      for (const f of g.folders) if (folder.startsWith(f + '/') && (!best || f.length > best.f.length)) best = { g, f };
    }
    return best?.g;
  };
  for (const g of out) {
    if (g.named || g.sessions.length > 1 || !String(g.key).startsWith('folder:')) continue;
    const home = owner(g.folders[0] || '', g);
    if (home) { home.sessions.push(...g.sessions); g.sessions = []; }
  }
  return out.filter((g) => g.sessions.length);
}

function dayList(today, n) {
  const [y, m, d] = today.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const t = new Date(y, m - 1, d - (n - 1 - i));
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  });
}

function buildProjects() {
  setCustom(S.custom); // landmarks.themeOf (preview) reads the same store as the planet
  const by = new Map();
  const get = (name) => {
    const k = nk(name);
    if (!k) return null;
    let p = by.get(k);
    if (!p) by.set(k, (p = {
      key: k, name: String(name).trim(), rawKey: '', sources: new Set(),
      villageKeys: new Set(), sessionKeys: new Set(), coworkKeys: new Set(), folders: new Set(),
      turns: 0, firstAt: Infinity, lastAt: 0, live: [], cowork: [],
      lb: { turns: 0, activeMin: 0, tokOut: 0, edits: 0, commands: 0, days: {}, allTurns: 0, allFirst: Infinity },
    }));
    return p;
  };
  for (const v of S.village?.projects || []) {
    const p = get(S.names[v.key] || v.name);
    if (!p) continue;
    p.sources.add('history'); p.villageKeys.add(v.key); p.rawKey ||= v.key;
    p.turns += v.turns || 0;
    if (v.firstAt) p.firstAt = Math.min(p.firstAt, v.firstAt);
    p.lastAt = Math.max(p.lastAt, v.lastAt || 0);
  }
  for (const g of foldCowork(S.cowork)) {
    const p = get(g.name);
    if (!p) continue;
    p.sources.add('cowork'); p.coworkKeys.add(g.key); p.rawKey ||= g.folders?.[0] || '';
    for (const f of g.folders || []) p.folders.add(f);
    for (const sid of g.sessions) {
      const w = S.work[sid];
      p.cowork.push({ sid, group: g, work: w });
      if (w?.since) p.lastAt = Math.max(p.lastAt, w.since);
    }
  }
  for (const s of S.sessions) {
    const p = get(s.name || s.project);
    if (!p) continue;
    p.sources.add('code'); if (s.projectKey) p.sessionKeys.add(s.projectKey); p.rawKey ||= s.projectKey || s.cwd || '';
    p.live.push(s);
    p.lastAt = Math.max(p.lastAt, s.updated || 0);
  }
  if (S.logbook?.today) {
    const days = new Set(dayList(S.logbook.today, 30));
    for (const lp of S.logbook.projects || []) {
      const p = by.get(nk(lp.name));
      if (!p) continue;
      for (const [d, st] of Object.entries(lp.days || {})) {
        if (!days.has(d)) continue;
        p.lb.turns += st.turns || 0; p.lb.activeMin += st.activeMin || 0; p.lb.tokOut += st.tokOut || 0;
        p.lb.edits += st.edits || 0; p.lb.commands += st.commands || 0;
        p.lb.days[d] = (p.lb.days[d] || 0) + (st.turns || 0);
      }
      p.lb.allTurns += lp.allTime?.turns || 0;
      if (lp.allTime?.firstAt) p.lb.allFirst = Math.min(p.lb.allFirst, lp.allTime.firstAt);
      p.lastAt = Math.max(p.lastAt, lp.allTime?.lastAt || 0);
    }
  }
  for (const p of by.values()) {
    p.help = p.live.filter((s) => s.status === 'help').length;
    p.working = p.live.filter((s) => s.status === 'working').length + p.cowork.filter((c) => c.work).length;
    p.agents = p.live.length + p.cowork.length;
  }
  projects = [...by.values()];
  byKey = by;
}
const isRemoved = (p) => !!lookOf(p).removed;

// Where every project's home is (or would be): custom spots exactly, the rest approximated like village.js.
// If the planet ever publishes its real plot directions to localStorage 'bp-spots' ({ nameKey: [x,y,z] }), use those.
function spots() {
  let real = {};
  try { real = JSON.parse(localStorage.getItem('bp-spots') || '{}') || {}; } catch {}
  const now = Date.now();
  const onPlanet = projects
    .filter((p) => !lookOf(p).hidden && !isRemoved(p) && (p.turns > 0 || p.cowork.length || p.live.length))
    .filter((p) => now - p.lastAt < IDLE_DAYS * 864e5 || p.live.length || p.cowork.length)
    .sort((a, b) => (b.lb.turns - a.lb.turns) || (b.turns + b.cowork.length * 6) - (a.turns + a.cowork.length * 6))
    .slice(0, MAX_PLOTS);
  const auto = autoSpots(onPlanet.map((p) => ({ key: p.key, spot: lookOf(p).spot })));
  const out = new Map();
  for (const p of onPlanet) {
    const s = lookOf(p).spot;
    const dir = s ? new THREE.Vector3(...s).normalize() : Array.isArray(real[p.key]) ? new THREE.Vector3(...real[p.key]).normalize() : auto.get(p.key);
    out.set(p.key, { dir, manual: !!s });
  }
  return out;
}

// ── rendering ─────────────────────────────────────────────────────────
function render() {
  buildProjects();
  const live = projects.filter((p) => !isRemoved(p));
  if (selKey && (!byKey.has(selKey) || isRemoved(byKey.get(selKey)))) selKey = null;
  if (!selKey && live.length) selKey = sorted()[0]?.key ?? null;
  renderHeader();
  if (view === 'projects') { renderList(); renderDetail(); }
  else if (view === 'agents') renderAgents();
  else renderUsage();
}

function renderHeader() {
  const live = projects.filter((p) => !isRemoved(p));
  const fresh = live.filter((p) => isNew(p.key));
  const news = $('news');
  if (!S.got) news.innerHTML = `<span class="txt calm">${S.connected ? 'Loading…' : 'Connecting to Bot Planet…'}</span>`;
  else if (fresh.length) news.innerHTML = `<span class="txt new" title="${plural(fresh.length, 'new project')} since your last look">✨ ${fresh.length} new<span class="long"> project${fresh.length === 1 ? '' : 's'} since your last look</span></span><button class="btn primary small" id="markall">Mark all seen</button>`;
  else news.innerHTML = `<span class="txt calm">All caught up ✓</span>`;
  $('markall')?.addEventListener('click', () => review(fresh.map((p) => p.key)));
  $('n-projects').textContent = S.got ? live.length : '–';
  const crew = allAgents();
  const help = crew.filter((a) => a.status === 'help').length;
  $('n-agents').textContent = !S.got ? '–' : help ? `${help} need${help === 1 ? 's' : ''} you` : crew.length;
  $('n-agents').classList.toggle('alert', help > 0);
  const u = S.usage;
  const one = (lab, title, v) => `<span class="u" title="${title}: ${v == null ? 'no reading yet' : Math.round(v) + '% of your plan used'}">${lab}<span class="bar"><i class="${v >= 85 ? 'hot' : v >= 60 ? 'warn' : ''}" style="width:${Math.min(100, v || 0)}%"></i></span><b>${v == null ? '—' : Math.round(v) + '%'}</b></span>`;
  $('usage').innerHTML = one('5h', 'Current 5-hour window', u?.fiveHour) + one('Week', 'This week', u?.sevenDay);
  const c = $('conn');
  c.classList.toggle('on', S.connected);
  c.title = S.connected ? 'Live' : 'Not connected — is Bot Planet running?';
}

function review(keys) {
  if (!keys.length) return;
  const now = Date.now();
  S.reviewed = { ...S.reviewed };
  for (const k of keys) S.reviewed[k] = Math.max(now, (S.seen[k] ?? 0) + 1);
  render();
  post('/reviewed', { keys });
}

function sorted() {
  const f = nk(filter);
  const list = projects.filter((p) => !isRemoved(p) && (!f || p.key.includes(f)));
  const cmp = {
    active: (a, b) => b.lb.turns - a.lb.turns || b.agents - a.agents || b.lastAt - a.lastAt,
    newest: (a, b) => (S.seen[b.key] ?? (isFinite(b.firstAt) ? b.firstAt : 0)) - (S.seen[a.key] ?? (isFinite(a.firstAt) ? a.firstAt : 0)) || b.lastAt - a.lastAt,
    name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    agents: (a, b) => b.agents - a.agents || b.working - a.working || b.lastAt - a.lastAt,
  }[sortBy] || (() => 0);
  return list.sort(cmp);
}

function chips(p, hidden) {
  return [
    p.sources.has('code') ? '<span class="chip code">Claude Code</span>' : '',
    p.sources.has('cowork') ? '<span class="chip cowork">Cowork</span>' : '',
    p.sources.has('history') && !p.sources.has('code') ? '<span class="chip hist">History</span>' : '',
    hidden ? '<span class="chip hid">hidden</span>' : '',
  ].join('');
}
function liveBadge(p) {
  if (p.help) return `<span class="live help">${p.help} need${p.help === 1 ? 's' : ''} you</span>`;
  if (p.working) return `<span class="live working">${p.working} working</span>`;
  if (p.agents) return `<span class="live idle">${plural(p.agents, 'agent')}</span>`;
  return '<span></span>';
}

let scrolledToSel = false;
function renderList() {
  const list = sorted();
  const el = $('plist');
  const top = el.scrollTop;
  const gone = projects.filter(isRemoved).sort((a, b) => lookOf(b).removed - lookOf(a).removed);
  let html = '';
  if (!list.length) html = `<li class="empty-list">${S.got ? (filter ? 'No projects match.' : 'No projects yet — start a Claude session.') : 'Loading projects…'}</li>`;
  else html = list.map((p) => {
    const L = lookOf(p);
    return `<li class="row${p.key === selKey ? ' sel' : ''}${L.hidden ? ' hidden-p' : ''}" data-k="${esc(p.key)}" tabindex="0">
      <span class="sw${L.hidden ? ' off' : ''}" style="--c:${L.color}"></span>
      <span class="nm"><span>${esc(p.name)}</span>${isNew(p.key) ? '<span class="newb" title="New since your last look">NEW</span>' : ''}</span>
      ${liveBadge(p)}
      <span class="sub">${chips(p, L.hidden)}<span>· ${ago(p.lastAt)}</span></span>
    </li>`;
  }).join('');
  if (gone.length) {
    html += `<li class="rm-head${showRemoved ? ' open' : ''}" data-rmtoggle><span class="car">▸</span>Removed (${gone.length})<span style="margin-left:auto;font-weight:600">files untouched</span></li>`;
    if (showRemoved) html += gone.map((p) => `<li class="row removed" data-gone="${esc(p.key)}">
      <span class="sw" style="--c:${lookOf(p).color}"></span>
      <span class="nm"><span>${esc(p.name)}</span></span>
      <button class="btn small" data-restore="${esc(p.key)}">Restore</button>
      <span class="sub">removed ${ago(lookOf(p).removed)}</span>
    </li>`).join('');
  }
  if (el.innerHTML !== html) el.innerHTML = html;
  el.scrollTop = top;
  if (!scrolledToSel && el.querySelector('.row.sel')) { scrolledToSel = true; el.querySelector('.row.sel').scrollIntoView({ block: 'nearest' }); }
}

// ── detail ────────────────────────────────────────────────────────────
let preview = null, globe = null, shownKey = null;
function ensure3d() {
  if (preview) return;
  preview = createPreview($('preview3d'));
  globe = createGlobe($('globe3d'), $('pinlabels'), {
    onPlace: (dir) => {
      const p = byKey.get(selKey);
      if (!p) return;
      patchCustom(p.key, { spot: [dir.x, dir.y, dir.z].map((v) => +v.toFixed(4)), ...(lookOf(p).hidden ? { hidden: null } : {}) });
    },
  });
}

/** Other visible projects' colours, for the "taken" rings and the too-close warning. */
function colorsInUse(p) {
  const used = new Map();
  for (const q of projects) {
    if (q.key === p.key || lookOf(q).hidden || isRemoved(q)) continue;
    const c = lookOf(q).color;
    used.set(c, (used.get(c) || []).concat(q.name));
  }
  return used;
}
function closeTo(p, color) {
  let best = null;
  for (const q of projects) {
    if (q.key === p.key || lookOf(q).hidden || isRemoved(q) || !(q.agents || q.turns)) continue;
    const d = deltaE(color, lookOf(q).color);
    if (d < 14 && (!best || d < best.d)) best = { d, name: q.name };
  }
  return best;
}

function renderDetail() {
  const p = byKey.get(selKey);
  $('empty').hidden = !!p; $('dwrap').hidden = !p;
  if (!p) { $('empty').textContent = S.got ? 'Pick a project on the left.' : 'Loading…'; return; }
  ensure3d();
  const L = lookOf(p);
  const c = S.custom[p.key] || {};
  const first = shownKey !== p.key;
  shownKey = p.key;

  preview.setLook({ key: p.key, name: p.name, color: L.color, hat: L.hat, theme: L.theme });
  $('pvcap').innerHTML = `<span class="pc">${HAT_INFO[L.hat][0]} ${HAT_INFO[L.hat][1]}</span><span class="plus">+</span><span class="pc">${THEME_INFO[L.theme][0]} ${THEME_INFO[L.theme][1]}</span>`;
  $('dsw').style.setProperty('--c', L.color);
  $('dsw').classList.toggle('off', L.hidden);
  const nameEl = $('dname');
  if (document.activeElement !== nameEl || first) nameEl.value = p.name;
  $('dnew').hidden = $('dgotit').hidden = !isNew(p.key);
  const firstSeen = S.seen[p.key];
  $('dmeta').innerHTML = `${chips(p, false)}<span>· last active ${ago(p.lastAt)}</span>${firstSeen ? `<span>· on the planet since ${shortDate(firstSeen)}</span>` : ''}`;

  // colour: 8 presets + your own (colour picker) + Auto. A ring marks presets other projects already wear.
  const used = colorsInUse(p);
  const chosen = isHex(c.color) ? c.color.toLowerCase() : '';
  const presets = PALETTE.map((h) => `<button class="c${chosen === h ? ' on' : ''}${used.has(h) ? ' taken' : ''}" data-color="${h}" style="--c:${h}" title="${h}${used.has(h) ? ' · also ' + esc(used.get(h).slice(0, 3).join(', ')) : ''}" aria-label="Colour ${h}"></button>`).join('');
  if ($('fpresets').innerHTML !== presets) $('fpresets').innerHTML = presets;
  const own = chosen && !PALETTE.includes(chosen);
  $('fcustomwrap').classList.toggle('on', own);
  $('fcustomwrap').style.setProperty('--c', own ? chosen : 'transparent');
  if (document.activeElement !== $('fcustom')) $('fcustom').value = L.color;
  $('fauto').className = `opt${chosen ? '' : ' on'}`;
  $('fauto').innerHTML = `<span class="sw" style="--c:${autoColor(p.key)};width:12px;height:12px;border-radius:4px;display:inline-block;grid-row:auto"></span>Auto`;
  const near = closeTo(p, L.color);
  $('cwarn').className = `cwarn${near ? ' on' : ''}`;
  $('cwarn').title = $('cwarn').textContent = near ? `Looks a lot like ${near.name}'s colour on the planet — fine, just harder to tell apart.` : own ? `Your own colour: ${chosen}` : '';

  const hats = HATS.map((h) => `<button class="opt${c.hat === h ? ' on' : ''}" data-hat="${h}" title="${HAT_INFO[h][1]}"><span class="e">${HAT_INFO[h][0]}</span>${HAT_INFO[h][1]}</button>`).join('')
    + `<button class="opt${c.hat ? '' : ' on'}" data-hat="">Auto · ${HAT_INFO[autoHat(p.key)][1]}</button>`;
  if ($('fhat').innerHTML !== hats) $('fhat').innerHTML = hats;
  const autoTheme = guessTheme(p.name, p.rawKey);
  const themes = THEMES.map((t) => `<button class="opt${c.theme === t ? ' on' : ''}" data-theme="${t}"><span class="e">${THEME_INFO[t][0]}</span>${THEME_INFO[t][1]}</button>`).join('')
    + `<button class="opt${c.theme ? '' : ' on'}" data-theme="">Auto · ${THEME_INFO[autoTheme][1]}</button>`;
  if ($('ftheme').innerHTML !== themes) $('ftheme').innerHTML = themes;
  $('fhidden').checked = L.hidden;
  $('fhiddenlab').textContent = L.hidden ? 'Hidden on the planet' : 'Shown on the planet';

  // spot globe
  const sp = spots();
  globe.setPins([...sp].map(([k, s]) => ({ key: k, name: byKey.get(k).name, color: lookOf(byKey.get(k)).color, dir: s.dir, manual: s.manual, selected: k === p.key })));
  const mine = sp.get(p.key);
  if (first && mine) globe.focus(mine.dir);
  $('spotreset').disabled = !L.spot;
  $('dshow').disabled = L.hidden;
  $('dshow').title = L.hidden ? 'Hidden projects have no home on the planet' : 'Fly the planet camera to this project';
  $('spothint').innerHTML = L.hidden
    ? 'Hidden projects have no home. Click the planet to place it (and show it again).'
    : !mine ? 'No home yet (only the 14 most active projects get one). Click to pin it anyway.'
    : `${L.spot ? 'Placed by you.' : 'Placed automatically.'} Click or drag the pin to move it · drag to turn.`
      + '<span class="lg"><i></i>by you</span><span class="lg"><i class="ghost"></i>auto</span>';

  renderStats(p, L);
  renderProjectAgents(p);
}

function renderStats(p, L) {
  const lb = p.lb;
  if (!S.logbook) { $('dstats').innerHTML = '<p class="muted">Reading your history…</p>'; return; }
  const days = dayList(S.logbook.today, 30);
  const max = Math.max(1, ...days.map((d) => lb.days[d] || 0));
  const active = days.filter((d) => lb.days[d]).length;
  const hours = lb.activeMin / 60;
  const html = `<div class="tiles">
      <div class="tile"><b>${fmtNum(lb.turns)}</b><span>tasks done</span></div>
      <div class="tile"><b>${hours >= 10 ? Math.round(hours) : hours.toFixed(1)}</b><span>hours</span></div>
      <div class="tile"><b>${fmtNum(lb.tokOut)}</b><span>tokens written</span></div>
      <div class="tile"><b>${active}</b><span>active days</span></div>
    </div>
    <div class="bars" style="--c:${L.color}" role="img" aria-label="Tasks per day, last 30 days">${days.map((d) => {
      const n = lb.days[d] || 0;
      const label = new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      return `<i title="${label} · ${plural(n, 'task')}"><span class="${n ? '' : 'zero'}" style="height:${n ? Math.max(8, (n / max) * 100) : 4}%"></span></i>`;
    }).join('')}</div>
    <div class="axis"><span>30 days ago</span><span>today</span></div>
    <div class="alltime">${lb.allTurns ? `${fmtNum(lb.allTurns)} tasks all time${isFinite(lb.allFirst) ? ` · since ${new Date(lb.allFirst).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}` : ''} · ${fmtNum(lb.edits)} edits, ${fmtNum(lb.commands)} commands this month` : (p.sources.has('history') ? '' : 'No Claude Code history for this project — Cowork work isn\'t logged.')}</div>`;
  if ($('dstats').innerHTML !== html) $('dstats').innerHTML = html;
}

function renderProjectAgents(p) {
  const all = allAgents().filter((a) => a.projectKey === p.key).sort(agentCmp);
  $('dagentsn').innerHTML = all.length ? `${plural(all.length, 'agent')} · <a href="#" data-goagents="${esc(p.key)}" style="color:var(--sky)">sort them</a>` : '';
  if (!all.length) { $('dagents').innerHTML = '<li class="muted" style="display:block;min-height:0">Nobody here right now.</li>'; return; }
  const show = all.slice(0, 6);
  $('dagents').innerHTML = show.map((a) => `<li>
      <span class="dot ${a.status}"></span>
      <span class="what">${esc(a.name)}<small>${esc(a.doing)}${a.detail ? ' · ' + priv(a.detail) : ''}</small></span>
      <span class="when">${a.status === 'help' ? '<b style="color:#ffb08a">needs you</b>' : a.last ? since(a.last) : ''}${showBtn(a)}${openBtn(a)}</span>
    </li>`).join('') + (all.length > show.length ? `<li class="muted" style="display:block;min-height:0">…and ${all.length - show.length} more in the Agents tab</li>` : '');
}

// ── agents ────────────────────────────────────────────────────────────
function agentName(id, fallback) { const n = S.names['agent:' + id]; return { name: n || fallback, named: !!n, fallback }; }
function allAgents() {
  const out = [];
  for (const s of S.sessions) {
    const k = nk(s.name || s.project);
    const title = String(s.title || '').replace(/\s+/g, ' ').trim();
    const fallback = !S.privacy && title ? (title.length > 44 ? title.slice(0, 42).trimEnd() + '…' : title) : `${s.name || s.project} session`;
    out.push({
      id: s.id, kind: 'code', projectKey: k, project: s.name || s.project, status: STATUS[s.status] ? s.status : 'idle',
      ...agentName(s.id, fallback),
      doing: describe(s), detail: s.status === 'help' ? (s.message || '') : (s.detail || s.task || ''), since: s.since || s.updated, last: s.updated || s.since,
      hostId: s.hostId, cwd: s.cwd, rawKey: s.projectKey || s.cwd, folders: s.cwd ? [s.cwd] : [], subagents: (s.subagents || []).length,
    });
  }
  for (const p of projects) for (const c of p.cowork) {
    const folders = S.sessionFolders[c.sid] || c.group.folders || [];
    const d = { cowork: true, manual: !!c.work, task: c.work?.label || '' };
    out.push({
      id: c.sid, kind: 'cowork', projectKey: p.key, project: p.name, status: c.work ? 'working' : 'idle',
      ...agentName(c.sid, `Cowork chat · ${c.sid.slice(-4)}`),
      doing: c.work ? describe(d).replace(/: .*$/, '') : 'Cowork chat · at home', detail: c.work ? (c.work.label || 'marked as working') : `in ${folders.slice(0, 2).map(base).join(', ') || 'no folder'}`,
      since: c.work?.since || 0, last: c.work?.since || S.coworkSeen[c.sid] || 0, lastLabel: c.work ? '' : 'seen',
      groupKey: homeOf.get(c.sid) || c.group.key, folders,
    });
  }
  return out;
}
// stable: naming an agent must not make its card jump
const agentCmp = (a, b) => STATUS[a.status][1] - STATUS[b.status][1] || (b.last || 0) - (a.last || 0) || (a.id < b.id ? -1 : 1);
function openBtn(a) {
  if (a.kind === 'cowork') return '';
  return a.hostId
    ? `<button class="btn small" data-open="${esc(a.id)}" title="Open this session in the Claude app">Open</button>`
    : `<button class="btn small" data-open="${esc(a.id)}" title="Copy a command that resumes it in your terminal">Resume</button>`;
}
const showBtn = (a) => `<button class="btn small icon" data-show="${esc(a.id)}" title="Show ${esc(a.name)} on the planet" aria-label="Show on planet">📍</button>`;

/** Which projects an agent could move to: suggested (by folder), existing, then starter names. */
function moveOptions(a) {
  const live = projects.filter((p) => !isRemoved(p)).sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
  const hints = new Set();
  for (const f of a?.folders || []) for (const [re, name] of FOLDER_HINTS) if (re.test(f)) hints.add(name);
  const sugg = [...hints].filter((n) => nk(n) !== a?.projectKey);
  const starters = STARTERS.filter((n) => !byKey.has(nk(n)) && !hints.has(n));
  const opt = (n) => byKey.has(nk(n)) && !isRemoved(byKey.get(nk(n))) ? `<option value="p:${esc(nk(n))}">★ ${esc(byKey.get(nk(n)).name)}</option>` : `<option value="n:${esc(n)}">✨ New: ${esc(n)}</option>`;
  return `<option value="" selected>${a ? 'Move to project…' : 'Choose a project…'}</option>`
    + (sugg.length ? `<optgroup label="Suggested">${sugg.map(opt).join('')}</optgroup>` : '')
    + `<optgroup label="Projects">${live.filter((p) => p.key !== a?.projectKey).map((p) => `<option value="p:${esc(p.key)}">${esc(p.name)}</option>`).join('')}</optgroup>`
    + `<optgroup label="New project">${starters.map((n) => `<option value="n:${esc(n)}">✨ ${esc(n)}</option>`).join('')}<option value="new">New project…</option></optgroup>`
    + (a?.kind === 'cowork' && String(a.groupKey).startsWith('project:') ? '<option value="home">↩ Back to its own folder</option>' : '');
}

function agentCard(a) {
  const p = byKey.get(a.projectKey);
  const color = p ? lookOf(p).color : '#b9b3cc';
  const foot = newFor === a.id
    ? `<span class="newp"><input class="field-in" data-newname="${esc(a.id)}" placeholder="Project name, e.g. Facturen" maxlength="40" /><button class="btn small primary" data-newok="${esc(a.id)}">Create</button><button class="btn small ghost" data-newcancel>✕</button></span>`
    : `<select class="field-in move" data-move="${esc(a.id)}" aria-label="Move ${esc(a.name)} to a project">${moveOptions(a)}</select>
       <span class="when" title="${a.lastLabel === 'seen' ? 'First seen by Bot Planet' : 'Last activity'}">${a.lastLabel === 'seen' && a.last ? 'seen ' + ago(a.last) : ago(a.last)}</span>`;
  const sub = a.detail ? priv(a.detail) : a.kind === 'cowork' ? 'Cowork reports no live status' : '&nbsp;';
  return `<div class="acard ${a.status}${picked.has(a.id) ? ' picked' : ''}" data-a="${esc(a.id)}" style="--c:${color}">
    <div class="ac-top">
      <label class="pick" title="Select"><input type="checkbox" data-pick="${esc(a.id)}"${picked.has(a.id) ? ' checked' : ''} aria-label="Select ${esc(a.name)}" /></label>
      <span class="st ${a.status}"><span class="dot ${a.status}"></span>${STATUS[a.status][0]}</span>
      <span class="sp"></span>${showBtn(a)}${openBtn(a)}
    </div>
    <input class="aname" data-aname="${esc(a.id)}" value="${a.named ? esc(a.name) : ''}" placeholder="${esc(a.fallback)}" maxlength="60" spellcheck="false" title="Name this agent (Enter to save)" aria-label="Agent name" />
    <div class="ac-doing"><b>${a.kind === 'code' ? '<span class="chip code">Code</span> ' : ''}${esc(a.doing)}${a.subagents ? ` · ${plural(a.subagents, 'helper')}` : ''}</b><small>${sub}</small></div>
    <div class="ac-foot">${foot}</div>
  </div>`;
}

const SEGS = [['all', 'All'], ['help', 'Needs you'], ['working', 'Working'], ['code', 'Claude Code'], ['cowork', 'Cowork']];
let agentsDirty = false;
const groupSlots = new Map(), cardSlots = new Map(); // first-seen positions in the Agents grid
/** Sort helper: unseen items get a slot from `cmp` order among themselves, after everything already placed. */
function slotOf(slots, cmp, x, y) {
  const sx = slots.get(x.id), sy = slots.get(y.id);
  if (sx != null && sy != null) return sx - sy;
  if (sx != null) return -1;
  if (sy != null) return 1;
  return cmp(x, y);
}
/** Don't swap out an input/select the user is typing in or has open; catch up when they leave it. */
function agentsBusy() {
  const a = document.activeElement;
  return !!a && $('v-agents').contains(a) && a.id !== 'afilter' && (a.tagName === 'INPUT' && a.type !== 'checkbox' || a.tagName === 'SELECT');
}
function renderAgents() {
  const all = allAgents();
  const counts = { all: all.length, help: 0, working: 0, code: 0, cowork: 0 };
  for (const a of all) { if (a.status === 'help') counts.help++; if (a.status === 'working') counts.working++; counts[a.kind]++; }
  const seg = SEGS.map(([k, l]) => `<button data-seg="${k}" class="${aSeg === k ? 'on' : ''}">${l}<span class="n">${counts[k]}</span></button>`).join('');
  if ($('aseg').innerHTML !== seg) $('aseg').innerHTML = seg;
  for (const id of [...picked]) if (!all.some((a) => a.id === id)) picked.delete(id);
  renderBar(all);
  if (agentsBusy()) { agentsDirty = true; return; }
  agentsDirty = false;

  const f = nk(aFilter);
  const list = all.filter((a) => (aSeg === 'all' || a.status === aSeg || a.kind === aSeg)
    && (!f || [a.name, a.project, a.doing, ...(a.folders || [])].some((x) => nk(x).includes(f))));
  // Order is fixed the first time a group/card shows up (most urgent first then), and new ones join at the
  // end: a status change or a live update never makes the grid jump under your cursor.
  const groups = new Map();
  for (const a of list.sort((x, y) => slotOf(cardSlots, agentCmp, x, y))) {
    if (!groups.has(a.projectKey)) groups.set(a.projectKey, []);
    groups.get(a.projectKey).push(a);
  }
  const rank = (xs) => (xs.some((a) => a.status === 'help') ? 0 : xs.some((a) => a.status === 'working') ? 1 : 2);
  const fresh = [...groups].filter(([k]) => !groupSlots.has(k)).sort(([ka, xa], [kb, xb]) => rank(xa) - rank(xb) || xb.length - xa.length || ka.localeCompare(kb));
  for (const [k] of fresh) groupSlots.set(k, groupSlots.size);
  for (const xs of groups.values()) for (const a of xs) if (!cardSlots.has(a.id)) cardSlots.set(a.id, cardSlots.size);
  const order = [...groups].sort(([ka], [kb]) => groupSlots.get(ka) - groupSlots.get(kb));
  const html = order.length ? order.map(([k, xs]) => {
    const p = byKey.get(k);
    const L = p ? lookOf(p) : { color: '#b9b3cc' };
    const folders = p ? [...p.folders].slice(0, 2).map(base) : [];
    const allPicked = xs.every((a) => picked.has(a.id));
    return `<section class="agroup">
      <h4><span class="sq" style="--c:${L.color}"></span>${esc(p?.name || xs[0].project)}<span class="cnt">${xs.length}</span>
        ${p && isRemoved(p) ? '<span class="chip hid">removed</span>' : ''}
        ${folders.length && nk(folders[0]) !== k ? `<span class="fold">· ${esc(folders.join(', '))}</span>` : ''}
        <span class="r"><button class="btn small ghost" data-selall="${esc(k)}">${allPicked ? 'Clear' : 'Select all'}</button>${p && !L.hidden && !isRemoved(p) ? `<button class="btn small icon" data-showp="${esc(k)}" title="Show ${esc(p.name)} on the planet">📍</button>` : ''}</span>
      </h4>
      <div class="cards">${xs.map(agentCard).join('')}</div>
    </section>`;
  }).join('') : `<div class="empty-agents">${!S.got ? 'Loading…' : all.length ? 'No agents match.' : 'No agents right now. Start a Claude Code or Cowork session.'}</div>`;
  const el = $('agrid');
  const top = el.scrollTop;
  if (el.innerHTML !== html) el.innerHTML = html;
  el.scrollTop = top;
  if (focusNew && newFor && newFor !== 'bulk') { focusNew = false; el.querySelector(`[data-newname="${CSS.escape(newFor)}"]`)?.focus(); }
}

function renderBar(all) {
  const bar = $('abar');
  bar.hidden = !picked.size;
  if (!picked.size) { if (newFor === 'bulk') newFor = null; return; }
  if (bar.contains(document.activeElement)) return;
  const n = picked.size;
  const sel = all.filter((a) => picked.has(a.id));
  const folders = [...new Set(sel.flatMap((a) => a.folders || []))];
  bar.innerHTML = `<span>${plural(n, 'agent')} selected</span>`
    + (newFor === 'bulk'
      ? `<input class="field-in" data-newname="bulk" placeholder="New project name" maxlength="40" /><button class="btn small primary" data-newok="bulk">Create & move</button><button class="btn small ghost" data-newcancel>✕</button>`
      : `<select class="field-in" data-move="bulk" aria-label="Move the selected agents">${moveOptions({ folders, kind: 'bulk' })}</select>`)
    + `<button class="btn small ghost" data-clearpick>Clear</button>`;
  if (focusNew && newFor === 'bulk') { focusNew = false; bar.querySelector('input')?.focus(); }
}

/**
 * Move agents into a project. Cowork chats are re-assigned one by one (POST /assign); a Claude Code
 * session moves its whole folder (POST /name on its project key), since that's how its project is found.
 * target: { key: nameKey } for an existing project, or { name } for a new one.
 */
async function moveAgents(ids, target) {
  let p = target.key ? byKey.get(target.key) : byKey.get(nk(target.name));
  const name = p ? p.name : String(target.name || '').replace(/\s+/g, ' ').trim();
  if (!name) return;
  const agents = allAgents().filter((a) => ids.includes(a.id) && a.projectKey !== nk(name));
  if (!agents.length) { toast(`Already in “${name}”`); return; }
  const undo = [];
  const cowork = agents.filter((a) => a.kind === 'cowork');
  if (cowork.length) {
    const prefer = (k) => (k.startsWith('project:') ? 0 : k.startsWith('space:') ? 1 : 2);
    let key = p && [...p.coworkKeys].sort((x, y) => prefer(x) - prefer(y))[0];
    if (!key) {
      key = 'project:' + slug(name);
      if (S.names[key] !== name) { undo.push(['/name', { key, name: S.names[key] || '' }]); await setName(key, name); }
    }
    for (const a of cowork) undo.push(['/assign', { session: a.id, key: a.groupKey }]);
    await Promise.all(cowork.map((a) => post('/assign', { session: a.id, key })));
  }
  const folders = [...new Set(agents.filter((a) => a.kind === 'code').map((a) => a.rawKey).filter(Boolean))];
  for (const k of folders) { undo.push(['/name', { key: k, name: S.names[k] || '' }]); await setName(k, name); }
  for (const id of ids) picked.delete(id);
  newFor = null;
  const what = cowork.length && folders.length ? `${plural(cowork.length, 'Cowork chat')} and ${plural(folders.length, 'Code folder')}` : cowork.length ? plural(cowork.length, 'Cowork chat') : `the ${base(folders[0])} folder`;
  toast(`Moved ${what} to “${name}”`, { label: 'Undo', fn: async () => { for (const [path, body] of undo.reverse()) await post(path, body); toast('Moved back'); } });
  render();
}
function onMove(ids, value, bulk = false) {
  if (!value) return;
  if (value === 'new') { newFor = bulk ? 'bulk' : ids[0]; focusNew = true; render(); return; }
  if (value === 'home') {
    Promise.all(ids.map((id) => post('/assign', { session: id, key: null }))).then(() => toast('Back in its own folder'));
    return;
  }
  moveAgents(ids, value.startsWith('p:') ? { key: value.slice(2) } : { name: value.slice(2) });
}

// ── usage ─────────────────────────────────────────────────────────────
const svgEl = (w, h, inner) => `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" preserveAspectRatio="xMidYMid meet">${inner}</svg>`;
function dayTicks(t0, t1) {
  const out = [];
  const d = new Date(t0); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1);
  for (; d.getTime() <= t1; d.setDate(d.getDate() + 1)) out.push(d.getTime());
  return out;
}
function renderUsage() {
  // plan percentages
  const H = (S.usageHistory || []).filter((x) => x && isFinite(x.t));
  const u = S.usage;
  const last = H[H.length - 1];
  const extraNow = [...H].reverse().find((x) => x.extra != null)?.extra ?? null;
  const tile = (lab, v, sub) => `<div class="tile"><b>${v == null ? '—' : Math.round(v) + '%'}</b><span>${lab}</span><div class="bar"><i class="${v >= 85 ? 'hot' : v >= 60 ? 'warn' : ''}" style="width:${Math.min(100, v || 0)}%"></i></div>${sub ? `<span style="display:block;margin-top:4px;font-weight:600">${sub}</span>` : ''}</div>`;
  $('unow').innerHTML = tile('5-hour window', u?.fiveHour ?? last?.fiveHour, 'resets every 5 hours')
    + tile('This week', u?.sevenDay ?? last?.sevenDay, 'of your weekly plan')
    + tile('Extra-usage credits', extraNow, extraNow == null ? 'not reported in the last 7 days' : '% of extra usage used');
  $('uasof').textContent = u?.at || last?.t ? `last reading ${ago(u?.at || last.t)} · ${plural(H.length, 'reading')}` : '';

  const W = 760, Ht = 230, m = { l: 40, r: 14, t: 12, b: 28 };
  const t1 = Date.now(), t0 = t1 - 7 * 864e5;
  const X = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - v / 100) * (Ht - m.t - m.b);
  const fmtT = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const series = [
    { k: 'sevenDay', label: 'Week', color: '#ff9a6a', dash: '', w: 2.5 },
    { k: 'fiveHour', label: '5-hour window', color: '#8cc8f5', dash: '5 4', w: 2 },
    { k: 'extra', label: 'Extra-usage credits', color: '#6fd3a0', dash: '2 3', w: 2 },
  ].filter((s) => H.some((x) => x[s.k] != null));
  $('ulegend').innerHTML = series.map((s) => `<span><svg width="26" height="10"><line x1="1" y1="5" x2="25" y2="5" stroke="${s.color}" stroke-width="${s.w + 0.5}" stroke-dasharray="${s.dash}" stroke-linecap="round"/></svg>${s.label}</span>`).join('')
    || '<span>No plan readings in the last 7 days yet</span>';
  let g = '';
  for (const v of [0, 25, 50, 75, 100]) g += `<line class="gl" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${v}%</text>`;
  for (const t of dayTicks(t0, t1)) g += `<line class="gl" x1="${X(t)}" x2="${X(t)}" y1="${m.t}" y2="${Ht - m.b}" stroke-dasharray="2 4"/><text x="${X(t) + 4}" y="${Ht - 8}">${new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</text>`;
  for (const s of series) {
    const pts = H.filter((x) => x[s.k] != null && x.t >= t0);
    if (!pts.length) continue;
    g += `<polyline fill="none" stroke="${s.color}" stroke-width="${s.w}" stroke-dasharray="${s.dash}" stroke-linejoin="round" stroke-linecap="round" points="${pts.map((x) => `${X(x.t).toFixed(1)},${Y(Math.min(100, x[s.k])).toFixed(1)}`).join(' ')}"/>`;
    g += pts.map((x) => `<circle class="pt" cx="${X(x.t).toFixed(1)}" cy="${Y(Math.min(100, x[s.k])).toFixed(1)}" r="3.5" fill="${s.color}" stroke="#24214a" stroke-width="1.5"><title>${fmtT(x.t)} · ${s.label}: ${Math.round(x[s.k])}%</title></circle>`).join('');
  }
  if (!H.length) g += `<text x="${W / 2}" y="${Ht / 2}" text-anchor="middle">${S.got ? 'No readings yet — the Claude app records them while it is open.' : 'Loading…'}</text>`;
  $('uchart').innerHTML = svgEl(W, Ht, g);

  // Claude Code tokens per day (logbook)
  if (!S.logbook?.today) {
    $('ttiles').innerHTML = ['tokens', 'written', 'tasks', 'hours'].map((l) => `<div class="tile"><b>—</b><span>${l}</span></div>`).join('');
    $('tlegend').innerHTML = '<span>Reading your history…</span>';
    $('tchart').innerHTML = svgEl(W, 200, '');
    return;
  }
  const days = dayList(S.logbook.today, 7);
  const per = new Map(); // project name → { color, days: {d: tokens}, total }
  let tokIn = 0, tokOut = 0, turns = 0, mins = 0;
  for (const lp of S.logbook.projects || []) {
    for (const d of days) {
      const st = lp.days?.[d];
      if (!st) continue;
      const n = (st.tokIn || 0) + (st.tokOut || 0);
      tokIn += st.tokIn || 0; tokOut += st.tokOut || 0; turns += st.turns || 0; mins += st.activeMin || 0;
      const k = nk(lp.name);
      if (!per.has(k)) { const p = byKey.get(k); per.set(k, { name: p?.name || lp.name, color: p ? lookOf(p).color : '#b9b3cc', days: {}, total: 0 }); }
      const e = per.get(k);
      e.days[d] = (e.days[d] || 0) + n; e.total += n;
    }
  }
  const ranked = [...per.values()].sort((a, b) => b.total - a.total);
  const top = ranked.slice(0, 5);
  if (ranked.length > 5) {
    const other = { name: `${ranked.length - 5} more`, color: '#7d7799', days: {}, total: 0 };
    for (const e of ranked.slice(5)) for (const [d, n] of Object.entries(e.days)) { other.days[d] = (other.days[d] || 0) + n; other.total += n; }
    top.push(other);
  }
  const hours = mins / 60;
  $('ttiles').innerHTML = `<div class="tile"><b>${fmtNum(tokIn + tokOut)}</b><span>tokens (7 days)</span></div>
    <div class="tile"><b>${fmtNum(tokOut)}</b><span>written by Claude</span></div>
    <div class="tile"><b>${fmtNum(turns)}</b><span>tasks done</span></div>
    <div class="tile"><b>${hours >= 10 ? Math.round(hours) : hours.toFixed(1)}</b><span>active hours</span></div>`;
  $('tasof').textContent = `${plural(per.size, 'project')}`;
  $('tlegend').innerHTML = top.map((e) => `<span><i class="sq" style="--c:${e.color}"></i>${esc(e.name)} · ${fmtNum(e.total)}</span>`).join('') || '<span>No Claude Code work in the last 7 days</span>';
  const TH = 200, tm = { l: 48, r: 14, t: 10, b: 28 };
  const totals = days.map((d) => top.reduce((s, e) => s + (e.days[d] || 0), 0));
  const max = Math.max(1, ...totals);
  const nice = (() => { const p = 10 ** Math.floor(Math.log10(max)); return Math.ceil(max / p) * p; })();
  const bw = (W - tm.l - tm.r) / days.length;
  const TY = (v) => tm.t + (1 - v / nice) * (TH - tm.t - tm.b);
  let tg = '';
  for (const k of [0, 0.5, 1]) tg += `<line class="gl" x1="${tm.l}" x2="${W - tm.r}" y1="${TY(nice * k)}" y2="${TY(nice * k)}"/><text x="${tm.l - 8}" y="${TY(nice * k) + 4}" text-anchor="end">${fmtNum(nice * k)}</text>`;
  days.forEach((d, i) => {
    let acc = 0;
    const x = tm.l + i * bw + bw * 0.18, w = bw * 0.64;
    const label = new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    for (const e of top) {
      const n = e.days[d] || 0;
      if (!n) continue;
      const y0 = TY(acc), y1 = TY(acc + n);
      tg += `<rect class="seg" x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(1, y0 - y1 - 1).toFixed(1)}" rx="3" fill="${e.color}"><title>${label} · ${esc(e.name)}: ${fmtNum(n)} tokens</title></rect>`;
      acc += n;
    }
    tg += `<text x="${(x + w / 2).toFixed(1)}" y="${TH - 8}" text-anchor="middle">${new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' })}</text>`;
    if (totals[i]) tg += `<text x="${(x + w / 2).toFixed(1)}" y="${(TY(totals[i]) - 5).toFixed(1)}" text-anchor="middle" style="fill:var(--ink-soft);font-weight:700">${fmtNum(totals[i])}</text>`;
  });
  $('tchart').innerHTML = svgEl(W, TH, tg);
}

// ── actions ───────────────────────────────────────────────────────────
async function openAgent(id) {
  const a = allAgents().find((x) => x.id === id);
  if (!a) return;
  if (a.hostId && window.botPlanet?.openExternal) { window.botPlanet.openExternal('claude://claude.ai/epitaxy/' + a.hostId); toast('Opening in Claude…'); return; }
  const cmd = `${a.cwd ? `cd ${shq(a.cwd)} && ` : ''}claude --resume ${a.id}`;
  try {
    if (window.botPlanet?.copy) window.botPlanet.copy(cmd);
    else await navigator.clipboard.writeText(cmd);
    toast(a.hostId ? 'Copied — open the Bot Planet app to jump straight in' : 'Copied the resume command');
  } catch { toast('Copy failed'); }
}
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Fly the planet camera to an agent (its id) or a project ('project:' + nameKey). */
function showOnPlanet(target, label) {
  if (window.botPlanet?.showOnPlanet) {
    try { window.botPlanet.showOnPlanet(target); toast(`📍 Showing ${label} on the planet`); } catch { toast("Couldn't reach the planet"); }
  } else toast(`📍 ${label} — open this page from the Bot Planet app to fly there`);
}

let toastT = 0, toastAct = null;
function toast(text, action) {
  const t = $('toast');
  toastAct = action || null;
  t.innerHTML = `<span>${esc(text)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  t.classList.add('on'); t.classList.toggle('act', !!action);
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on', 'act'), action ? 7000 : 2600);
}
$('toast').addEventListener('click', (e) => {
  if (!e.target.closest('button') || !toastAct) return;
  const fn = toastAct.fn; toastAct = null;
  $('toast').classList.remove('on', 'act');
  fn();
});

// ── rename: one name for every raw key behind the project; carry its looks over ──
async function rename(p, next) {
  next = next.replace(/\s+/g, ' ').trim();
  if (!next || next === p.name) { $('dname').value = p.name; return; }
  const newKey = nk(next);
  const keys = [...p.villageKeys, ...p.sessionKeys, ...p.coworkKeys];
  if (!keys.length) return;
  if (newKey !== p.key) {
    // looks follow the project (incl. its colour, so the continent doesn't change hue under a new name)
    const carry = { ...(S.custom[p.key] || {}) };
    if (!carry.color && Number.isInteger(slots[p.key])) carry.color = PALETTE[slots[p.key]];
    if (Object.keys(carry).length && !byKey.has(newKey)) await post('/custom', { key: newKey, patch: carry });
    if (S.custom[p.key]) await post('/custom', { key: p.key, patch: Object.fromEntries(Object.keys(S.custom[p.key]).map((f) => [f, null])) });
    // a renamed project isn't "new"
    await post('/seen', { keys: [newKey] }); told.add(newKey);
    await post('/reviewed', { keys: [newKey] });
  }
  const ok = (await Promise.all(keys.map((key) => post('/name', { key, name: next })))).every(Boolean);
  if (ok) { selKey = newKey; saveSel(); toast(`Renamed to “${next}”`); }
}
const saveSel = () => { try { localStorage.setItem('bp-crew-sel', selKey || ''); } catch {} };

function removeProject(p) {
  const list = sorted();
  const i = list.findIndex((q) => q.key === p.key);
  const next = list[i + 1] || list[i - 1];
  selKey = next?.key ?? null; saveSel();
  patchCustom(p.key, { removed: Date.now() });
  toast(`Removed “${p.name}” — files and chats untouched`, { label: 'Undo', fn: () => { selKey = p.key; saveSel(); patchCustom(p.key, { removed: null }); } });
}

function setView(v) {
  view = v;
  try { localStorage.setItem('bp-crew-view', v); } catch {}
  for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x.dataset.view === v);
  $('v-projects').hidden = v !== 'projects';
  $('v-agents').hidden = v !== 'agents';
  $('v-usage').hidden = v !== 'usage';
  render();
}

// ── events ────────────────────────────────────────────────────────────
$('plist').addEventListener('click', (e) => {
  const r = e.target.closest('[data-restore]');
  if (r) { const k = r.dataset.restore; patchCustom(k, { removed: null }); selKey = k; saveSel(); toast(`Restored “${byKey.get(k)?.name || k}”`); return; }
  if (e.target.closest('[data-rmtoggle]')) { showRemoved = !showRemoved; renderList(); return; }
  const row = e.target.closest('.row[data-k]');
  if (!row) return;
  selKey = row.dataset.k; saveSel();
  renderList(); renderDetail();
});
$('plist').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
  const rows = [...$('plist').querySelectorAll('.row[data-k]')];
  const i = rows.findIndex((r) => r.dataset.k === selKey);
  const n = e.key === 'Enter' ? rows.indexOf(e.target.closest('.row')) : Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
  if (n < 0 || !rows[n]) return;
  e.preventDefault();
  selKey = rows[n].dataset.k; saveSel();
  renderList(); renderDetail();
  $('plist').querySelector('.row.sel')?.focus();
  $('plist').querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
});
$('filter').addEventListener('input', (e) => { filter = e.target.value; renderList(); });
$('sort').value = sortBy;
$('sort').addEventListener('change', (e) => { sortBy = e.target.value; try { localStorage.setItem('bp-crew-sort', sortBy); } catch {} renderList(); });
document.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) setView(b.dataset.view); });
$('usage').addEventListener('click', () => setView('usage'));
document.addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]');
  if (o) { e.stopPropagation(); openAgent(o.dataset.open); return; }
  const s = e.target.closest('[data-show]');
  if (s) { const a = allAgents().find((x) => x.id === s.dataset.show); showOnPlanet(s.dataset.show, a?.name || 'this agent'); return; }
  const sp = e.target.closest('[data-showp]');
  if (sp) { showOnPlanet('project:' + sp.dataset.showp, byKey.get(sp.dataset.showp)?.name || 'this project'); return; }
  const ga = e.target.closest('[data-goagents]');
  if (ga) { e.preventDefault(); aFilter = byKey.get(ga.dataset.goagents)?.name || ''; $('afilter').value = aFilter; aSeg = 'all'; setView('agents'); }
});
const nameEl = $('dname');
nameEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
  if (e.key === 'Escape') { nameEl.value = byKey.get(selKey)?.name || ''; nameEl.blur(); }
});
nameEl.addEventListener('blur', () => { const p = byKey.get(selKey); if (p) rename(p, nameEl.value); });
$('dgotit').addEventListener('click', () => review([selKey]));
const sel = () => byKey.get(selKey);
$('fpresets').addEventListener('click', (e) => { const b = e.target.closest('[data-color]'); if (b && sel()) patchCustom(selKey, { color: b.dataset.color }); });
$('fauto').addEventListener('click', () => { if (sel()) patchCustom(selKey, { color: null }); });
// own colour: live preview while dragging (local only), saved once when the picker settles
let colorT = 0;
$('fcustom').addEventListener('input', (e) => {
  if (!sel()) return;
  colorDraft = { key: selKey, color: e.target.value.toLowerCase() };
  patchCustom(selKey, { color: colorDraft.color }, { local: true });
  clearTimeout(colorT);
  colorT = setTimeout(() => { if (colorDraft) post('/custom', { key: colorDraft.key, patch: { color: colorDraft.color } }); }, 600);
});
$('fcustom').addEventListener('change', (e) => {
  clearTimeout(colorT);
  const d = colorDraft || (sel() && { key: selKey, color: e.target.value.toLowerCase() });
  colorDraft = null;
  if (d) patchCustom(d.key, { color: d.color });
});
$('fhat').addEventListener('click', (e) => { const b = e.target.closest('[data-hat]'); if (b && sel()) patchCustom(selKey, { hat: b.dataset.hat || null }); });
$('ftheme').addEventListener('click', (e) => { const b = e.target.closest('[data-theme]'); if (b && sel()) patchCustom(selKey, { theme: b.dataset.theme || null }); });
$('fhidden').addEventListener('change', (e) => { if (sel()) patchCustom(selKey, { hidden: e.target.checked || null }); });
$('spotreset').addEventListener('click', () => { if (sel()) patchCustom(selKey, { spot: null }).then(() => { const s = spots().get(selKey); if (s) globe.focus(s.dir); }); });
$('dshow').addEventListener('click', () => { const p = sel(); if (p) showOnPlanet('project:' + p.key, p.name); });
$('dremove').addEventListener('click', () => { const p = sel(); if (p) removeProject(p); });

// agents view
$('afilter').addEventListener('input', (e) => { aFilter = e.target.value; renderAgents(); });
$('aseg').addEventListener('click', (e) => { const b = e.target.closest('[data-seg]'); if (b) { aSeg = b.dataset.seg; renderAgents(); } });
const av = $('v-agents');
av.addEventListener('change', (e) => {
  const pk = e.target.closest('[data-pick]');
  if (pk) { if (pk.checked) picked.add(pk.dataset.pick); else picked.delete(pk.dataset.pick); pk.closest('.acard')?.classList.toggle('picked', pk.checked); renderBar(allAgents()); return; }
  const mv = e.target.closest('[data-move]');
  if (mv) { const v = mv.value; mv.blur(); onMove(mv.dataset.move === 'bulk' ? [...picked] : [mv.dataset.move], v, mv.dataset.move === 'bulk'); }
});
av.addEventListener('click', (e) => {
  const sa = e.target.closest('[data-selall]');
  if (sa) {
    const ids = allAgents().filter((a) => a.projectKey === sa.dataset.selall).map((a) => a.id);
    const all = ids.every((id) => picked.has(id));
    for (const id of ids) all ? picked.delete(id) : picked.add(id);
    renderAgents(); return;
  }
  if (e.target.closest('[data-clearpick]')) { picked.clear(); newFor = null; renderAgents(); return; }
  if (e.target.closest('[data-newcancel]')) { newFor = null; document.activeElement?.blur(); renderAgents(); return; }
  const ok = e.target.closest('[data-newok]');
  if (ok) {
    const id = ok.dataset.newok;
    const input = av.querySelector(`[data-newname="${CSS.escape(id)}"]`);
    const name = input?.value.trim();
    if (!name) { input?.focus(); return; }
    newFor = null;
    input.blur();
    moveAgents(id === 'bulk' ? [...picked] : [id], { name });
  }
});
av.addEventListener('keydown', (e) => {
  const nn = e.target.closest('[data-newname]');
  if (nn) {
    if (e.key === 'Enter') { e.preventDefault(); av.querySelector(`[data-newok="${CSS.escape(nn.dataset.newname)}"]`)?.click(); }
    if (e.key === 'Escape') { newFor = null; nn.blur(); renderAgents(); }
    return;
  }
  const an = e.target.closest('[data-aname]');
  if (an) {
    if (e.key === 'Enter') { e.preventDefault(); an.blur(); }
    if (e.key === 'Escape') { an.value = S.names['agent:' + an.dataset.aname] || ''; an.blur(); }
  }
});
av.addEventListener('focusout', (e) => {
  const an = e.target.closest?.('[data-aname]');
  if (an) {
    const key = 'agent:' + an.dataset.aname;
    const next = an.value.replace(/\s+/g, ' ').trim();
    if (next !== (S.names[key] || '')) setName(key, next).then((ok) => ok && toast(next ? `Named “${next}”` : 'Back to its default name'));
  }
  setTimeout(() => { if (agentsDirty && !agentsBusy()) renderAgents(); }, 0);
});

setInterval(() => { if (!document.hidden && !['INPUT', 'SELECT'].includes(document.activeElement?.tagName)) render(); }, 30000); // keep "2h ago" fresh

if (window.botPlanet) document.documentElement.classList.add('electron');
setView(view);
connect();
loadLogbook();
