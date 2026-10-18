// Crew manager: every project and agent in one bigger window. Customise each project's crew (colour,
// hat, landmark, spot, hidden), rename projects, see what's new, and jump to any agent.
// Data: SSE /events (v1–v4 contract) + GET /logbook?days=30. Writes: POST /name, /custom, /seen, /reviewed.
import * as THREE from 'three';
import { PALETTE } from './colors.js';
import { ACCENTS, HATS, hashStr, describe, SLEEP_MS } from './astronaut.js';
import { THEMES, guessTheme } from './landmarks.js';
import { createPreview, createGlobe, autoSpots, renderOnce } from './crew-3d.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const nk = (s) => String(s ?? '').trim().toLowerCase();
const qs = new URLSearchParams(location.search);
const BASE = (qs.get('api') || '').replace(/\/$/, '');
window.__crewRender = renderOnce; // tests: rAF is paused in hidden windows

const HAT_INFO = { cap: ['🧢', 'Cap'], beanie: ['🧶', 'Beanie'], crown: ['👑', 'Crown'], headphones: ['🎧', 'Headphones'], propeller: ['🌀', 'Propeller'], tophat: ['🎩', 'Top hat'], bow: ['🎀', 'Bow'], flower: ['🌸', 'Flower'] };
const THEME_INFO = { lighthouse: ['🗼', 'Lighthouse'], printshop: ['🖨️', 'Print shop'], server: ['🖥️', 'Server'], vault: ['🏦', 'Vault'], windmill: ['🌾', 'Windmill'] };
const STATUS = { help: ['needs you', 0], working: ['working', 1], done: ['your turn', 2], idle: ['idle', 3] };
const MAX_PLOTS = 14, IDLE_DAYS = 60; // same as village.js

// ── state ─────────────────────────────────────────────────────────────
const S = { sessions: [], village: null, cowork: [], names: {}, custom: {}, seen: {}, reviewed: {}, work: {}, usage: null, privacy: false, logbook: null, connected: false, got: false };
let projects = [], byKey = new Map();
let view = 'projects', selKey = null, sortBy = 'active', filter = '';
let agentSort = { col: 'status', dir: 1 };
try { sortBy = localStorage.getItem('bp-crew-sort') || sortBy; selKey = localStorage.getItem('bp-crew-sel'); } catch {}

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
    color: PALETTE.includes(c.color) ? c.color : autoColor(p.key),
    hat: HATS.includes(c.hat) ? c.hat : autoHat(p.key),
    theme: THEMES.includes(c.theme) ? c.theme : guessTheme(p.name, p.rawKey),
    hidden: !!c.hidden,
    spot: Array.isArray(c.spot) && c.spot.length === 3 ? c.spot : null,
  };
};
const isNew = (k) => (S.seen[k] ?? 0) > (S.reviewed[k] ?? 0);
const priv = (text) => (S.privacy ? '<span class="hiddenpriv">hidden</span>' : esc(text));

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
const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

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
/** Optimistic: apply the patch locally (preview updates instantly), then save. */
function patchCustom(key, patch) {
  const cur = { ...(S.custom[key] || {}) };
  for (const [f, v] of Object.entries(patch)) { if (v === null) delete cur[f]; else cur[f] = v; }
  S.custom = { ...S.custom };
  if (Object.keys(cur).length) S.custom[key] = cur; else delete S.custom[key];
  render();
  return post('/custom', { key, patch });
}

function connect() {
  const es = new EventSource(BASE + '/events' + (qs.has('privacy') || qs.has('host') ? `?${qs}` : ''));
  es.onopen = () => { S.connected = true; renderHeader(); };
  es.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    S.sessions = m.sessions || [];
    if ('village' in m) S.village = m.village;
    if (m.cowork) S.cowork = m.cowork.groups || [];
    S.names = m.names || S.names;
    S.custom = m.custom || {};
    S.seen = m.seenProjects || {};
    S.reviewed = m.reviewed || {};
    S.work = m.work || {};
    S.usage = m.usage ?? null;
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
function foldCowork(groups) {
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
  const by = new Map();
  const get = (name) => {
    const k = nk(name);
    if (!k) return null;
    let p = by.get(k);
    if (!p) by.set(k, (p = {
      key: k, name: String(name).trim(), rawKey: '', sources: new Set(),
      villageKeys: new Set(), sessionKeys: new Set(), coworkKeys: new Set(),
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

// Where every project's home is (or would be): custom spots exactly, the rest approximated like village.js.
// If the planet ever publishes its real plot directions to localStorage 'bp-spots' ({ nameKey: [x,y,z] }), use those.
function spots() {
  let real = {};
  try { real = JSON.parse(localStorage.getItem('bp-spots') || '{}') || {}; } catch {}
  const now = Date.now();
  const onPlanet = projects
    .filter((p) => !lookOf(p).hidden && (p.turns > 0 || p.cowork.length || p.live.length))
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
  if (selKey && !byKey.has(selKey)) selKey = null;
  if (!selKey && projects.length) selKey = sorted()[0]?.key ?? null;
  renderHeader();
  if (view === 'projects') { renderList(); renderDetail(); } else renderAgents();
}

function renderHeader() {
  const fresh = projects.filter((p) => isNew(p.key));
  const news = $('news');
  if (!S.got) news.innerHTML = `<span class="txt calm">${S.connected ? 'Loading…' : 'Connecting to Bot Planet…'}</span>`;
  else if (fresh.length) news.innerHTML = `<span class="txt new">✨ ${plural(fresh.length, 'new project')} since your last look</span><button class="btn primary small" id="markall">Mark all seen</button>`;
  else news.innerHTML = `<span class="txt calm">All caught up ✓</span>`;
  $('markall')?.addEventListener('click', () => review(fresh.map((p) => p.key)));
  $('n-projects').textContent = projects.length;
  const crew = allAgents();
  const help = crew.filter((a) => a.status === 'help').length;
  $('n-agents').textContent = help ? `${help} need${help === 1 ? 's' : ''} you` : crew.length;
  $('n-agents').classList.toggle('alert', help > 0);
  const u = S.usage;
  const uel = $('usage');
  uel.hidden = !u || (u.fiveHour == null && u.sevenDay == null);
  if (!uel.hidden) {
    const one = (lab, v) => v == null ? '' : `<span class="u" title="${lab === '5h' ? 'Current 5-hour window' : 'This week'}: ${Math.round(v)}% of your plan">${lab}<span class="bar"><i class="${v >= 85 ? 'hot' : v >= 60 ? 'warn' : ''}" style="width:${Math.min(100, v)}%"></i></span>${Math.round(v)}%</span>`;
    uel.innerHTML = one('5h', u.fiveHour) + one('7d', u.sevenDay);
  }
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
  const list = projects.filter((p) => !f || p.key.includes(f));
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
    p.sources.has('history') ? '<span class="chip hist">History</span>' : '',
    hidden ? '<span class="chip hid">hidden</span>' : '',
  ].join('');
}
function liveBadge(p) {
  if (p.help) return `<span class="live help">${p.help} need${p.help === 1 ? 's' : ''} you</span>`;
  if (p.working) return `<span class="live working">${p.working} working</span>`;
  if (p.agents) return `<span class="live idle">${plural(p.agents, 'agent')}</span>`;
  return '';
}

function renderList() {
  const list = sorted();
  const el = $('plist');
  if (!list.length) { el.innerHTML = `<li class="empty-list">${S.got ? (filter ? 'No projects match.' : 'No projects yet — start a Claude session.') : 'Loading projects…'}</li>`; return; }
  el.innerHTML = list.map((p) => {
    const L = lookOf(p);
    return `<li class="row${p.key === selKey ? ' sel' : ''}${L.hidden ? ' hidden-p' : ''}" data-k="${esc(p.key)}">
      <span class="sw${L.hidden ? ' off' : ''}" style="--c:${L.color}"></span>
      <span class="nm"><span>${esc(p.name)}</span>${isNew(p.key) ? '<span class="newb">NEW</span>' : ''}</span>
      ${liveBadge(p) || '<span></span>'}
      <span class="sub">${chips(p, L.hidden)}<span>· ${ago(p.lastAt)}</span></span>
    </li>`;
  }).join('');
  el.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
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

function renderDetail() {
  const p = byKey.get(selKey);
  $('empty').hidden = !!p; $('dwrap').hidden = !p;
  if (!p) return;
  ensure3d();
  const L = lookOf(p);
  const c = S.custom[p.key] || {};
  const first = shownKey !== p.key;
  shownKey = p.key;

  preview.setLook({ key: p.key, name: p.name, color: L.color, hat: L.hat });
  $('pvcap').textContent = `${HAT_INFO[L.hat][1]} · ${THEME_INFO[L.theme][1].toLowerCase()} crew`;
  $('dsw').style.setProperty('--c', L.color);
  $('dsw').classList.toggle('off', L.hidden);
  const nameEl = $('dname');
  if (document.activeElement !== nameEl || first) nameEl.value = p.name;
  $('dnew').hidden = $('dgotit').hidden = !isNew(p.key);
  const firstSeen = S.seen[p.key];
  $('dmeta').innerHTML = `${chips(p, false)}<span>· last active ${ago(p.lastAt)}</span>${firstSeen ? `<span>· on the planet since ${new Date(firstSeen).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>` : ''}`;

  // colour: 8 palette swatches + Auto (a small ring marks colours other projects already wear)
  const usedBy = new Map();
  for (const q of projects) if (q.key !== p.key && !lookOf(q).hidden) usedBy.set(lookOf(q).color, (usedBy.get(lookOf(q).color) || []).concat(q.name));
  $('fcolor').innerHTML = PALETTE.map((h) => `<button data-color="${h}" class="${c.color === h ? 'on' : ''}${usedBy.has(h) ? ' taken' : ''}" style="--c:${h}" title="${h}${usedBy.has(h) ? ' · also ' + esc(usedBy.get(h).slice(0, 3).join(', ')) : ''}"></button>`).join('')
    + `<button class="opt${c.color ? '' : ' on'}" data-color="" style="margin-left:4px"><span class="sw" style="--c:${autoColor(p.key)};width:12px;height:12px;border-radius:4px;display:inline-block;grid-row:auto"></span>Auto</button>`;
  $('fhat').innerHTML = HATS.map((h) => `<button class="opt${c.hat === h ? ' on' : ''}" data-hat="${h}" title="${HAT_INFO[h][1]}"><span class="e">${HAT_INFO[h][0]}</span>${HAT_INFO[h][1]}</button>`).join('')
    + `<button class="opt auto${c.hat ? '' : ' on'}" data-hat="">Auto · ${HAT_INFO[autoHat(p.key)][1]}</button>`;
  const autoTheme = guessTheme(p.name, p.rawKey);
  $('ftheme').innerHTML = THEMES.map((t) => `<button class="opt${c.theme === t ? ' on' : ''}" data-theme="${t}"><span class="e">${THEME_INFO[t][0]}</span>${THEME_INFO[t][1]}</button>`).join('')
    + `<button class="opt auto${c.theme ? '' : ' on'}" data-theme="">Auto · ${THEME_INFO[autoTheme][1]}</button>`;
  $('fhidden').checked = L.hidden;
  $('fhiddenlab').textContent = L.hidden ? 'Hidden on the planet' : 'Shown on the planet';

  // spot globe
  const sp = spots();
  globe.setPins([...sp].map(([k, s]) => ({ key: k, name: byKey.get(k).name, color: lookOf(byKey.get(k)).color, dir: s.dir, manual: s.manual, selected: k === p.key })));
  const mine = sp.get(p.key);
  if (first && mine) globe.focus(mine.dir);
  $('spotreset').disabled = !L.spot;
  $('spotreset').style.opacity = L.spot ? 1 : 0.4;
  $('spothint').innerHTML = L.hidden
    ? 'Hidden projects have no home. Click the planet to place it (and show it again).'
    : !mine ? 'No home yet (only the 14 most active projects get one). Click to pin it anyway.'
    : `${L.spot ? 'Placed by you.' : 'Placed automatically.'} Click or drag the pin to move it · drag to turn.`
      + '<span class="lg"><i></i>by you</span><span class="lg"><i class="ghost"></i>auto</span>';

  renderStats(p, L);
  renderProjectAgents(p, L);
}

function renderStats(p, L) {
  const lb = p.lb;
  if (!S.logbook) { $('dstats').innerHTML = '<p class="muted">Reading your history…</p>'; return; }
  const days = dayList(S.logbook.today, 30);
  const max = Math.max(1, ...days.map((d) => lb.days[d] || 0));
  const active = days.filter((d) => lb.days[d]).length;
  const hours = lb.activeMin / 60;
  $('dstats').innerHTML = `<div class="tiles">
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
    ${lb.allTurns ? `<div class="alltime">${fmtNum(lb.allTurns)} tasks all time${isFinite(lb.allFirst) ? ` · since ${new Date(lb.allFirst).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}` : ''} · ${fmtNum(lb.edits)} edits, ${fmtNum(lb.commands)} commands this month</div>` : (p.sources.has('history') ? '' : '<div class="alltime">No Claude Code history for this project — Cowork work isn\'t logged.</div>')}`;
}

function renderProjectAgents(p) {
  const all = allAgents().filter((a) => a.projectKey === p.key).sort(agentCmp('status', 1));
  // idle Cowork sessions all look the same: fold them into one line
  const list = foldIdleCowork(all);
  $('dagentsn').textContent = all.length ? plural(all.length, 'agent') : '';
  if (!list.length) { $('dagents').innerHTML = '<li class="muted" style="display:block">Nobody here right now.</li>'; return; }
  const show = list.slice(0, 8);
  $('dagents').innerHTML = show.map((a) => `<li>
      <span class="dot ${a.status}"></span>
      <span class="what">${esc(a.doing)}<small>${a.task ? priv(a.task) : a.kind === 'cowork' ? 'no live status from Cowork' : '&nbsp;'}</small></span>
      <span class="when">${a.status === 'help' ? '<b style="color:#ffb08a">needs you</b>' : a.since ? since(a.since) : ''}${openBtn(a)}</span>
    </li>`).join('') + (list.length > show.length ? `<li class="muted" style="display:block">…and ${list.length - show.length} more in the Agents tab</li>` : '');
}

// ── agents ────────────────────────────────────────────────────────────
function allAgents() {
  const out = [];
  for (const s of S.sessions) {
    const k = nk(s.name || s.project);
    out.push({
      id: s.id, kind: 'code', projectKey: k, project: s.name || s.project, status: STATUS[s.status] ? s.status : 'idle',
      doing: describe(s), task: s.task || s.title || '', since: s.since || s.updated, hostId: s.hostId, cwd: s.cwd,
      subagents: (s.subagents || []).length, message: s.status === 'help' ? s.message : '',
    });
  }
  for (const p of projects) for (const c of p.cowork) {
    const d = { cowork: true, manual: !!c.work, task: c.work?.label || '' };
    out.push({
      id: c.sid, kind: 'cowork', cowork: true, projectKey: p.key, project: p.name, status: c.work ? 'working' : 'idle',
      doing: describe(d).replace(/: .*$/, ''), task: c.work ? (c.work.label || 'marked as working') : '', since: c.work?.since || 0,
    });
  }
  return out;
}
function agentCmp(col, dir) {
  const val = {
    status: (a) => STATUS[a.status][1] * 1e13 - (a.since || 0) / 1e3,
    project: (a) => nk(a.project),
    doing: (a) => nk(a.doing),
    since: (a) => -(a.since || 0),
  }[col];
  return (a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; };
}
function openBtn(a) {
  if (a.kind === 'cowork') return '';
  return a.hostId
    ? `<button class="btn small" data-open="${esc(a.id)}" title="Open this session in the Claude app">Open</button>`
    : `<button class="btn small" data-open="${esc(a.id)}" title="Copy a command that resumes it in your terminal">Copy resume</button>`;
}
/** Idle Cowork sessions look identical: one row per project ("5 Cowork sessions · at home"). */
function foldIdleCowork(list) {
  const out = [], groups = new Map();
  for (const a of list) {
    if (a.kind !== 'cowork' || a.status !== 'idle') { out.push(a); continue; }
    let g = groups.get(a.projectKey);
    if (!g) { g = { ...a, id: '', n: 0, group: true }; groups.set(a.projectKey, g); out.push(g); }
    g.n++;
    g.doing = g.n > 1 ? `${g.n} Cowork sessions · at home` : 'Cowork session · at home';
  }
  return out;
}
function renderAgents() {
  const list = foldIdleCowork(allAgents()).sort(agentCmp(agentSort.col, agentSort.dir));
  for (const th of document.querySelectorAll('#v-agents th[data-col]')) {
    th.classList.toggle('sorted', th.dataset.col === agentSort.col);
    th.classList.toggle('asc', th.dataset.col === agentSort.col && agentSort.dir < 0);
  }
  $('atable').innerHTML = list.length ? list.map((a) => {
    const p = byKey.get(a.projectKey);
    const color = p ? lookOf(p).color : '#b9b3cc';
    const sub = a.message ? priv(a.message) : a.task ? priv(a.task) : a.group ? 'Cowork reports no live status' : '';
    return `<tr>
      <td><span class="st ${a.status}"><span class="dot ${a.status}"></span>${STATUS[a.status][0]}</span></td>
      <td><span class="proj" style="--c:${color}"><i></i><span>${esc(a.project)}${a.kind === 'cowork' ? ' <small>· Cowork</small>' : ''}</span></span></td>
      <td class="doing"><b>${esc(a.doing)}</b>${a.subagents ? ` <small style="display:inline">· ${plural(a.subagents, 'helper')}</small>` : ''}${sub ? `<small>${sub}</small>` : ''}</td>
      <td class="when">${a.since ? since(a.since) : '—'}</td>
      <td class="act">${openBtn(a)}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="5" class="muted" style="text-align:center;padding:30px">${S.got ? 'No agents right now.' : 'Loading…'}</td></tr>`;
}

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

let toastT = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2200);
}

// ── rename: one name for every raw key behind the project; carry its looks over ──
async function rename(p, next) {
  next = next.trim();
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

// ── events ────────────────────────────────────────────────────────────
$('plist').addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  selKey = row.dataset.k; saveSel();
  renderList(); renderDetail();
});
$('filter').addEventListener('input', (e) => { filter = e.target.value; renderList(); });
$('sort').value = sortBy;
$('sort').addEventListener('change', (e) => { sortBy = e.target.value; try { localStorage.setItem('bp-crew-sort', sortBy); } catch {} renderList(); });
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  view = b.dataset.view;
  for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x === b);
  $('v-projects').hidden = view !== 'projects';
  $('v-agents').hidden = view !== 'agents';
  render();
});
document.querySelector('#v-agents thead').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-col]');
  if (!th) return;
  agentSort = agentSort.col === th.dataset.col ? { col: th.dataset.col, dir: -agentSort.dir } : { col: th.dataset.col, dir: 1 };
  renderAgents();
});
document.addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]');
  if (o) { e.stopPropagation(); openAgent(o.dataset.open); }
});
const nameEl = $('dname');
nameEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
  if (e.key === 'Escape') { nameEl.value = byKey.get(selKey)?.name || ''; nameEl.blur(); }
});
nameEl.addEventListener('blur', () => { const p = byKey.get(selKey); if (p) rename(p, nameEl.value); });
$('dgotit').addEventListener('click', () => review([selKey]));
const sel = () => byKey.get(selKey);
$('fcolor').addEventListener('click', (e) => { const b = e.target.closest('[data-color]'); if (b && sel()) patchCustom(selKey, { color: b.dataset.color || null }); });
$('fhat').addEventListener('click', (e) => { const b = e.target.closest('[data-hat]'); if (b && sel()) patchCustom(selKey, { hat: b.dataset.hat || null }); });
$('ftheme').addEventListener('click', (e) => { const b = e.target.closest('[data-theme]'); if (b && sel()) patchCustom(selKey, { theme: b.dataset.theme || null }); });
$('fhidden').addEventListener('change', (e) => { if (sel()) patchCustom(selKey, { hidden: e.target.checked || null }); });
$('spotreset').addEventListener('click', () => { if (sel()) patchCustom(selKey, { spot: null }).then(() => { const s = spots().get(selKey); if (s) globe.focus(s.dir); }); });
setInterval(() => { if (!document.hidden && document.activeElement?.tagName !== 'INPUT') render(); }, 30000); // keep "2h ago" fresh

if (window.botPlanet) document.documentElement.classList.add('electron');
render();
connect();
loadLogbook();
