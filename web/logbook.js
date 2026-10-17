// The logbook: per-house stats (click a house) and a weekly recap (camp board / menu bar / first open of the week).
// Data: GET /logbook?days=14 → { today, projects: [{ key, name, days: { 'YYYY-MM-DD': DayStats }, allTime }] }.
import { accentFor, lookKeyOf } from './astronaut.js';
import { LEVELS, LEVEL_NAMES } from './village.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ZERO = { turns: 0, prompts: 0, edits: 0, commands: 0, activeMin: 0, tokIn: 0, tokOut: 0, replyMs: 0, replies: 0 };

let cache = null, cacheAt = 0;
export async function fetchLogbook(force = false) {
  if (!force && cache && Date.now() - cacheAt < 60_000) return cache;
  const r = await fetch('/logbook?days=14');
  if (!r.ok) throw new Error(r.status === 503 ? 'Still reading your history — try again in a moment.' : 'The logbook is unavailable.');
  cache = await r.json();
  cacheAt = Date.now();
  return cache;
}

// ── dates & sums ─────────────────────────────────────────────────────
function dates(today, n) {
  const [y, m, d] = today.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const t = new Date(y, m - 1, d - (n - 1 - i));
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  });
}
function sum(projects, days) {
  const out = { ...ZERO };
  for (const p of projects) for (const d of days) {
    const s = p.days?.[d];
    if (s) for (const k in out) out[k] += s[k] || 0;
  }
  return out;
}
const perDay = (projects, days) => days.map((d) => ({ d, ...sum(projects, [d]) }));

// ── formatting ───────────────────────────────────────────────────────
const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
const fmtMin = (m) => (m >= 90 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`);
const avgReply = (s) => (s.replies ? s.replyMs / s.replies / 60000 : null);
const weekday = (d) => new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' });
const dayLabel = (d) => new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const monthYear = (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

/** "+12%" / "−8%"; lowerIsBetter flips which direction reads as good. */
function delta(now, before, lowerIsBetter = false) {
  if (before == null || now == null || !isFinite(before) || before === 0) return '';
  const pct = Math.round(((now - before) / before) * 100);
  if (!pct) return '<span class="d">same as last week</span>';
  const good = lowerIsBetter ? pct < 0 : pct > 0;
  return `<span class="d ${good ? 'up' : 'down'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%</span>`;
}

function tile(label, value, extra = '') {
  return `<div class="tile"><span class="lab">${label}</span><b>${value}</b>${extra}</div>`;
}

/** 14 thin bars of finished tasks per day; today highlighted; every bar has a hover tooltip. */
function bars(rows, today) {
  const max = Math.max(1, ...rows.map((r) => r.turns));
  const W = 100 / rows.length;
  return `<div class="bars" role="img" aria-label="Finished tasks per day, last ${rows.length} days">${rows.map((r) => {
    const h = r.turns ? Math.max(6, (r.turns / max) * 100) : 0;
    const tip = `${dayLabel(r.d)} · ${r.turns} task${r.turns === 1 ? '' : 's'} · ${fmtMin(r.activeMin)} active`;
    return `<i data-tip="${esc(tip)}" style="width:${W}%"><span class="${r.d === today ? 'today' : ''}" style="height:${h}%"></span></i>`;
  }).join('')}</div><div class="axis"><span>${weekday(rows[0].d)}</span><span>today</span></div>`;
}

/** Projects behind one house: every logbook project whose display name matches. */
export const projectsFor = (lb, name) => lb.projects.filter((p) => lookKeyOf({ name: p.name }) === lookKeyOf({ name }));

// ── house card ───────────────────────────────────────────────────────
export function renderHouse(lb, plot) {
  const ps = projectsFor(lb, plot.name);
  const d14 = dates(lb.today, 14), d7 = d14.slice(7), prev7 = d14.slice(0, 7);
  const wk = sum(ps, d7), last = sum(ps, prev7);
  const all = ps.reduce((a, p) => { for (const k in p.allTime) a[k] = k === 'firstAt' ? Math.min(a[k] ?? Infinity, p.allTime[k]) : k === 'lastAt' ? Math.max(a[k] || 0, p.allTime[k]) : (a[k] || 0) + p.allTime[k]; return a; }, {});
  const next = LEVELS[plot.level];
  const prevNeed = LEVELS[plot.level - 1] || 0;
  const progress = next ? Math.min(1, (plot.turns - prevNeed) / (next - prevNeed)) : 1;
  const r = avgReply(wk), rLast = avgReply(last);
  return `
    <div class="lb-head"><span class="dot" style="background:${accentFor(lookKeyOf({ name: plot.name }))}"></span>
      <h3>${esc(plot.name)}</h3><span class="pill">${LEVEL_NAMES[plot.level - 1] || 'plot'}</span></div>
    <div class="grow"><span style="width:${Math.round(progress * 100)}%"></span></div>
    <p class="sub">${next ? `${next - plot.turns} more finished task${next - plot.turns === 1 ? '' : 's'} until it becomes a ${LEVEL_NAMES[plot.level]}` : 'Fully grown 🔭'}${plot.project?.coworkSessions ? ` · ${plot.project.coworkSessions} Cowork session${plot.project.coworkSessions === 1 ? '' : 's'}` : ''}</p>
    <h4>Last 7 days</h4>
    <div class="tiles">
      ${tile('Tasks done', wk.turns, delta(wk.turns, last.turns))}
      ${tile('Claude worked', fmtMin(wk.activeMin), delta(wk.activeMin, last.activeMin))}
      ${tile('Your reply time', r == null ? '—' : fmtMin(r), delta(r, rLast, true))}
      ${tile('Tokens written', fmtNum(wk.tokOut), `<span class="d">${fmtNum(wk.tokIn)} read (mostly cache)</span>`)}
    </div>
    ${bars(perDay(ps, d14), lb.today)}
    <p class="sub">${ps.length && all.firstAt && isFinite(all.firstAt)
      ? `Since ${monthYear(all.firstAt)}: ${fmtNum(all.turns || 0)} tasks · ${fmtNum(all.edits || 0)} edits · ${fmtNum(all.commands || 0)} commands · ${fmtMin(all.activeMin || 0)} of Claude time`
      : 'No Claude Code history for this project yet: Cowork sessions don’t leave stats on this Mac.'}</p>`;
}

// ── weekly recap ─────────────────────────────────────────────────────
export function renderRecap(lb, { waiting = 0 } = {}) {
  const d14 = dates(lb.today, 14), d7 = d14.slice(7), prev7 = d14.slice(0, 7);
  const wk = sum(lb.projects, d7), last = sum(lb.projects, prev7);
  const r = avgReply(wk), rLast = avgReply(last);
  // streak: consecutive days with ≥1 finished task, counting back from today (or yesterday if today is still empty)
  const all = perDay(lb.projects, d14);
  let streak = 0;
  for (let i = all.length - 1 - (all[all.length - 1].turns ? 0 : 1); i >= 0 && all[i].turns; i--) streak++;
  const busiest = all.slice(7).reduce((a, b) => (b.turns > a.turns ? b : a), { turns: 0 });
  const top = lb.projects
    .map((p) => ({ name: p.name, ...sum([p], d7) }))
    .filter((p) => p.turns)
    .sort((a, b) => b.turns - a.turns);
  // projects that share a display name are one house: merge them for the ranking
  const merged = [];
  for (const p of top) {
    const k = lookKeyOf({ name: p.name });
    const m = merged.find((x) => x.k === k);
    if (m) { m.turns += p.turns; m.activeMin += p.activeMin; } else merged.push({ ...p, k });
  }
  merged.sort((a, b) => b.turns - a.turns);
  const shown = merged.slice(0, 5), rest = merged.slice(5);
  const max = Math.max(1, ...shown.map((p) => p.turns));
  return `
    <div class="lb-head"><span class="emoji">📒</span><h3>Your week</h3><span class="pill">last 7 days</span></div>
    <div class="tiles">
      ${tile('Tasks done', wk.turns, delta(wk.turns, last.turns))}
      ${tile('Claude worked', fmtMin(wk.activeMin), delta(wk.activeMin, last.activeMin))}
      ${tile('Your reply time', r == null ? '—' : fmtMin(r), delta(r, rLast, true))}
      ${tile('Tokens written', fmtNum(wk.tokOut), `<span class="d">${fmtNum(wk.tokIn)} read (mostly cache)</span>`)}
    </div>
    <h4>Busiest houses</h4>
    ${shown.length ? `<ul class="rank">${shown.map((p) => `
      <li data-tip="${esc(`${p.name} · ${p.turns} tasks · ${fmtMin(p.activeMin)} active`)}"><i style="background:${accentFor(p.k)}"></i><span class="nm">${esc(p.name)}</span>
        <span class="bar"><span style="width:${Math.max(4, (p.turns / max) * 100)}%"></span></span><b>${p.turns}</b></li>`).join('')}
      ${rest.length ? `<li class="more"><span class="nm">+${rest.length} more · ${rest.reduce((n, p) => n + p.turns, 0)} tasks</span></li>` : ''}</ul>`
      : '<p class="sub">No finished Claude Code tasks this week yet.</p>'}
    <div class="facts">
      <span>🔥 <b>${streak}</b>-day streak</span>
      ${busiest.turns ? `<span>📅 Busiest: <b>${weekday(busiest.d)}</b> (${busiest.turns})</span>` : ''}
      ${waiting ? `<span class="hot">👋 <b>${waiting}</b> waiting on you</span>` : ''}
    </div>
    ${bars(all, lb.today)}
    <div class="lb-actions"><button data-postcard>📮 Make a postcard of this week</button></div>`;
}

/** Monday-based week id, for "show the recap once per week". */
export function weekId(d = new Date()) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return `${t.getFullYear()}-${t.getMonth() + 1}-${t.getDate()}`;
}
