// Bot Planet — tiny local bridge between Claude Code hooks and the 3D planet.
// No dependencies. Standalone: `node server.mjs` → http://localhost:4711
// Inside Electron, main.mjs calls startServer() itself. See docs/CONTRACT.md.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import { createVillage, rootOf } from './village.mjs';
import { createCowork } from './cowork.mjs';

export const PORT = Number(process.env.BOT_PLANET_PORT) || 4711;
const DIR = path.dirname(fileURLToPath(import.meta.url));
const THREE_DIR = path.join(DIR, 'node_modules', 'three');
const WEB_DIR = path.join(DIR, 'web');
const ASSETS_DIR = path.join(DIR, 'assets');

// Timings (env overrides exist so the rules can be tested quickly).
const num = (k, d) => Number(process.env[k]) || d;
const STALE_MS = num('BOT_PLANET_STALE_MS', 1000 * 60 * 60 * 6); // forget sessions silent for 6h
const SWEEP_MS = num('BOT_PLANET_SWEEP_MS', 30 * 1000);
const QUIET_MS = num('BOT_PLANET_QUIET_MS', 90 * 1000);          // working this long without events → check transcript
const TRANSCRIPT_IDLE_MS = num('BOT_PLANET_TRANSCRIPT_IDLE_MS', 10 * 60 * 1000);
const SEED_WINDOW_MS = num('BOT_PLANET_SEED_WINDOW_MS', 20 * 60 * 1000);
const SEED_IDLE_MS = 5 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 500;
const MAX_SUBAGENTS = 8;
const MAX_ROOTS = 24;
const MAX_NAME = 40;
const CD_RE = /\bcd (?:\\"|')?(~?\/[^\s"'\\;&|]*)/g;
const INTERRUPT = '[Request interrupted by user';

const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.icns': 'image/icns',
};
const WORKING = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'PreCompact']);

const clip = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const isRealPrompt = (s) => !!s && !String(s).trimStart().startsWith('<');

function displayName(s) {
  const home = os.homedir();
  const base = s.cwd ? path.basename(s.cwd) : '';
  if (s.cwd && path.resolve(s.cwd) === home) {
    const words = clip(s.title, 80).split(' ').filter(Boolean).slice(0, 3).join(' ').slice(0, 22).trim();
    return words || 'home';
  }
  return base || 'session';
}

const isHome = (cwd) => !!cwd && path.resolve(cwd) === os.homedir();

/** Project key: cwd unless it is $HOME; for home sessions the most common root of the touched paths (>=2 seen). */
function projectKeyOf(s) {
  const roots = s.roots || {};
  if (!s.cwd || isHome(s.cwd)) {
    let best = '', n = 0, total = 0;
    for (const [r, c] of Object.entries(roots)) { total += c; if (c > n) { n = c; best = r; } }
    if (total >= 2 && best) return best;
  }
  return s.cwd || '';
}

/** Count the project roots a PreToolUse touches (file paths, plus `cd <dir>` in Bash). */
function collectRoots(s, tool, input) {
  const paths = [];
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof input[k] === 'string') paths.push(input[k]);
  if (tool === 'Bash' && typeof input.command === 'string') {
    for (const m of input.command.matchAll(CD_RE)) paths.push(m[1]);
  }
  for (const p of paths) {
    let r = null;
    try { r = rootOf(p); } catch {}
    if (!r) continue;
    s.roots = s.roots || {};
    s.roots[r] = (s.roots[r] || 0) + 1;
    const keys = Object.keys(s.roots);
    if (keys.length > MAX_ROOTS) {
      const drop = keys.sort((a, b) => s.roots[a] - s.roots[b])[0];
      delete s.roots[drop];
    }
  }
}

/** A few words on what a tool call is touching, for the astronauts' speech bubbles. */
export function summarize(tool, input = {}) {
  const base = (f) => (f ? path.basename(String(f)) : '');
  let text = '';
  try {
    switch (tool) {
      case 'Bash': text = input.description || input.command; break;
      case 'Edit': case 'MultiEdit': case 'Write': case 'Read': case 'NotebookEdit':
        text = base(input.file_path || input.notebook_path); break;
      case 'Grep': text = input.pattern ? `“${input.pattern}”` : ''; break;
      case 'Glob': text = input.pattern; break;
      case 'WebFetch': try { text = new URL(input.url).hostname; } catch { text = input.url; } break;
      case 'WebSearch': text = input.query ? `“${input.query}”` : ''; break;
      case 'Task': case 'Agent': text = input.description || input.subagent_type; break;
      case 'TodoWrite': {
        const t = (input.todos || []).find((x) => x.status === 'in_progress') || (input.todos || [])[0];
        text = t ? t.activeForm || t.content : '';
        break;
      }
      default:
        if (tool.startsWith('mcp__')) { const [, server, name] = tool.split('__'); text = `${server}: ${name}`; }
    }
  } catch {}
  return clip(text, 48);
}

function newSession(id) {
  const now = Date.now();
  return { id, name: 'session', project: 'session', cwd: '', status: 'idle', tool: '', message: '', title: '', task: '', subagents: [], since: now, updated: now };
}

function setStatus(s, next, message, now) {
  if (next !== s.status) s.since = now;
  s.status = next;
  if (message !== undefined) s.message = message;
}

/** Apply one hook event to the session map. Returns true if anything changed. */
function applyHook(sessions, evt, now = Date.now()) {
  const id = evt && evt.session_id;
  if (!id) return false;
  const name = evt.hook_event_name;
  if (name === 'SessionEnd') return sessions.delete(id);

  const s = sessions.get(id) ?? newSession(id);
  if (evt.cwd) { s.cwd = String(evt.cwd); s.project = path.basename(s.cwd) || s.project; }
  // the Claude desktop app's own id for this session (from the hook's environment) → "Open in Claude" links
  if (typeof evt.__hostId === 'string' && /^local_[0-9a-f-]{36}$/.test(evt.__hostId)) s.hostId = evt.__hostId;
  if (evt.transcript_path) s.transcript = String(evt.transcript_path);

  const tool = evt.tool_name ? String(evt.tool_name) : '';
  const toolInput = evt.tool_input && typeof evt.tool_input === 'object' ? evt.tool_input : {};
  const isSub = tool === 'Task' || tool === 'Agent';

  if (name === 'UserPromptSubmit') {
    if (isRealPrompt(evt.prompt)) {
      s.task = clip(evt.prompt);
      if (!s.title) s.title = s.task;
    }
    s.tool = '';
    setStatus(s, 'working', 'Working on it', now);
  } else if (name === 'Notification') {
    const msg = String(evt.message || '');
    if (evt.notification_type === 'idle_prompt' || /waiting for your input/i.test(msg)) {
      // The 60s nudge only means "your turn" — never downgrade a real blocker.
      if (s.status !== 'help') { s.tool = ''; setStatus(s, 'done', 'Finished — your turn', now); }
    } else {
      setStatus(s, 'help', msg || 'Needs your attention', now);
    }
  } else if (name === 'PermissionRequest') {
    if (tool) s.tool = tool;
    const detail = summarize(tool, toolInput);
    setStatus(s, 'help', tool ? `Wants to use ${tool}${detail ? `: ${detail}` : ''}` : 'Needs your permission', now);
  } else if (name === 'PreToolUse' && tool === 'AskUserQuestion') {
    s.tool = tool;
    setStatus(s, 'help', 'Has a question for you', now);
  } else if (name === 'PreToolUse' && tool === 'ExitPlanMode') {
    s.tool = tool;
    setStatus(s, 'help', 'Wants you to approve a plan', now);
  } else if (WORKING.has(name)) {
    if (tool) s.tool = tool;
    if (name === 'PreToolUse' && tool) {
      const detail = summarize(tool, toolInput);
      if (detail) { s.detail = detail; s.detailAt = now; }
      collectRoots(s, tool, toolInput);
    }
    if (name === 'PreToolUse' && isSub) {
      const sid = evt.tool_use_id || crypto.randomUUID();
      if (!s.subagents.some((a) => a.id === sid)) {
        s.subagents.push({ id: sid, description: clip(toolInput.description || toolInput.subagent_type || 'subagent', 80), since: now });
        if (s.subagents.length > MAX_SUBAGENTS) s.subagents.splice(0, s.subagents.length - MAX_SUBAGENTS);
      }
    } else if (name === 'PostToolUse' && isSub && evt.tool_use_id) {
      s.subagents = s.subagents.filter((a) => a.id !== evt.tool_use_id);
    } else if (name === 'SubagentStop') {
      const i = evt.tool_use_id ? s.subagents.findIndex((a) => a.id === evt.tool_use_id) : -1;
      if (i >= 0) s.subagents.splice(i, 1); else s.subagents.shift();
    }
    setStatus(s, 'working', tool ? `Using ${tool}` : s.message || 'Working', now);
  } else if (name === 'Stop') {
    s.tool = '';
    s.detail = '';
    s.subagents = [];
    setStatus(s, 'done', 'Finished — your turn', now);
  } else if (name === 'SessionStart') {
    s.tool = '';
    s.subagents = [];
    setStatus(s, 'idle', s.message, now);
  }

  s.name = displayName(s);
  s.updated = now;
  sessions.set(id, s);
  return true;
}

// ---- transcripts ----------------------------------------------------------------------------

function readRange(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

/** Parsed JSON lines from the last `bytes` of a file (partial first line dropped). */
function tailEntries(file, size, bytes = 64 * 1024) {
  const start = Math.max(0, size - bytes);
  let text = readRange(file, start, size - start);
  if (start > 0) { const nl = text.indexOf('\n'); text = nl < 0 ? '' : text.slice(nl + 1); }
  return parseLines(text);
}
function headEntries(file, size, bytes = 64 * 1024) {
  return parseLines(readRange(file, 0, Math.min(size, bytes)));
}
function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && typeof o === 'object') out.push(o); } catch {}
  }
  return out;
}

/** First text of a user message (string content or first text block). */
function userText(e) {
  const c = e?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) { const b = c.find((x) => x && x.type === 'text' && typeof x.text === 'string'); return b ? b.text : ''; }
  return '';
}
const userStringText = (e) => (typeof e?.message?.content === 'string' ? e.message.content : userText(e));
const mentionsInterrupt = (e) => JSON.stringify(e?.message?.content ?? '').includes(INTERRUPT);

/** True when the transcript's last turn ended: the final assistant message has stop_reason end_turn
 *  and nothing (no tool result, no new prompt) came after it. Catches turns whose Stop hook was missed. */
function lastTurnEnded(file) {
  try {
    const size = fs.statSync(file).size;
    const entries = tailEntries(file, size, 16 * 1024);
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === 'assistant') return e.message?.stop_reason === 'end_turn';
      if (e.type === 'user' && !e.isMeta) return false;
    }
  } catch {}
  return false;
}

/** True when the last user entry in the tail of a transcript is a user interrupt. */
function lastUserInterrupted(file) {
  try {
    const size = fs.statSync(file).size;
    const entries = tailEntries(file, size, 8 * 1024);
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === 'user') return mentionsInterrupt(entries[i]);
    }
  } catch {}
  return false;
}

function seedFromTranscripts(sessions) {
  const found = [];
  try {
    const root = path.join(os.homedir(), '.claude', 'projects');
    const now = Date.now();
    for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const dir = path.join(root, dirent.name);
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const id = f.slice(0, -'.jsonl'.length);
        if (sessions.has(id)) continue;
        const file = path.join(dir, f);
        try {
          const st = fs.statSync(file);
          if (!st.isFile() || now - st.mtimeMs > SEED_WINDOW_MS || st.size === 0) continue;
          const tail = tailEntries(file, st.size);
          let cwd = '';
          for (let i = tail.length - 1; i >= 0 && !cwd; i--) if (typeof tail[i].cwd === 'string') cwd = tail[i].cwd;
          let status = 'working';
          for (let i = tail.length - 1; i >= 0; i--) {
            const e = tail[i];
            if (e.type === 'assistant') { if (e.message?.stop_reason === 'end_turn') status = 'done'; break; }
            if (e.type === 'user') { if (mentionsInterrupt(e)) status = 'done'; break; }
          }
          if (status === 'working' && now - st.mtimeMs > SEED_IDLE_MS) status = 'idle';
          let title = '';
          for (const e of headEntries(file, st.size)) {
            if (e.type !== 'user') continue;
            const t = userText(e);
            if (typeof e.message?.content === 'string' || t) { if (isRealPrompt(t)) { title = clip(t); break; } }
          }
          let task = '';
          for (let i = tail.length - 1; i >= 0 && !task; i--) {
            const e = tail[i];
            if (e.type === 'user' && !e.isMeta) { const t = userStringText(e); if (isRealPrompt(t) && !mentionsInterrupt(e)) task = clip(t); }
          }
          const s = newSession(id);
          s.cwd = cwd; s.project = cwd ? path.basename(cwd) : 'session';
          s.status = status;
          s.message = status === 'done' ? 'Finished — your turn' : status === 'working' ? 'Working' : '';
          s.title = title; s.task = task || title;
          s.since = s.updated = Math.round(st.mtimeMs);
          s.transcript = file;
          s.name = displayName(s);
          sessions.set(id, s);
          found.push({ id, name: s.name, status, cwd, title: s.title });
        } catch {}
      }
    }
  } catch {}
  return found;
}

// ---- server ---------------------------------------------------------------------------------

export function startServer({ port = PORT, onChange, statePath, seedTranscripts, villageCache, namesPath, routinesPath, cowork: coworkOpt = true, quiet } = {}) {
  /** @type {Map<string, any>} */
  const sessions = new Map();
  const clients = new Set();
  const log = (...a) => { if (!quiet) console.log(...a); };

  // Load persisted state.
  if (statePath) {
    try {
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const now = Date.now();
      for (const s of Array.isArray(saved?.sessions) ? saved.sessions : []) {
        if (s && s.id && now - (s.updated || 0) <= STALE_MS) sessions.set(s.id, { ...newSession(s.id), ...s, pending: [] });
      }
    } catch {}
  }
  if (seedTranscripts) {
    const found = seedFromTranscripts(sessions);
    log(`🪐 seeded ${found.length} session(s) from transcripts`);
    for (const f of found) log(`   ${f.status.padEnd(7)} ${f.name} — ${f.title.slice(0, 50)}`);
  }

  // User-chosen names (projectKey / cowork key → name) and Cowork session re-assignments.
  let names = {};
  let assign = {};
  // Manually marked Cowork work (Cowork reports no live status): sessionId → { label, since }
  let work = {};
  // When Bot Planet first saw each Cowork session (Cowork gives no timestamps) → recency for footprints
  let seen = {};
  // v4: per-project custom looks/spots (crew manager), project first-seen + reviewed stamps
  let custom = {}, seenProjects = {}, reviewed = {};
  let privacy = false;
  if (namesPath) {
    try {
      const j = JSON.parse(fs.readFileSync(namesPath, 'utf8'));
      if (j?.names && typeof j.names === 'object') for (const [k, v] of Object.entries(j.names)) if (typeof v === 'string' && v) names[k] = v;
      if (j?.assign && typeof j.assign === 'object') for (const [k, v] of Object.entries(j.assign)) if (typeof v === 'string' && v) assign[k] = v;
      if (j?.seen && typeof j.seen === 'object') for (const [k, v] of Object.entries(j.seen)) if (typeof v === 'number') seen[k] = v;
      if (j?.custom && typeof j.custom === 'object') custom = j.custom;
      if (j?.seenProjects && typeof j.seenProjects === 'object') seenProjects = j.seenProjects;
      if (j?.reviewed && typeof j.reviewed === 'object') reviewed = j.reviewed;
      if (j?.work && typeof j.work === 'object') for (const [k, v] of Object.entries(j.work)) if (v && typeof v.since === 'number') work[k] = { label: String(v.label || '').slice(0, 60), since: v.since };
    } catch {}
  }
  let namesTimer = null;
  const saveNamesNow = () => {
    namesTimer = null;
    if (!namesPath) return;
    try {
      const tmp = `${namesPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ names, assign, work, seen, custom, seenProjects, reviewed }));
      fs.renameSync(tmp, namesPath);
    } catch {}
  };
  const scheduleNamesSave = () => {
    if (!namesPath || namesTimer) return;
    namesTimer = setTimeout(saveNamesNow, SAVE_DEBOUNCE_MS);
    namesTimer.unref?.();
  };

  let cowork = null;
  if (coworkOpt) { // on by default; pass cowork:false to disable, or { baseDir }
    try { cowork = createCowork({ ...(typeof coworkOpt === 'object' ? coworkOpt : {}), onChange: () => changed() }); }
    catch (e) { log(`cowork unavailable: ${e.message}`); cowork = null; }
  }

  let saveTimer = null;
  const saveNow = () => {
    saveTimer = null;
    if (!statePath) return;
    try {
      const tmp = `${statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ sessions: [...sessions.values()].map(({ pending, ...rest }) => rest) }));
      fs.renameSync(tmp, statePath);
    } catch {}
  };
  const scheduleSave = () => {
    if (!statePath || saveTimer) return;
    saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
    saveTimer.unref?.();
  };

  const prune = () => {
    const now = Date.now();
    let removed = false;
    for (const [id, s] of sessions) if (now - s.updated > STALE_MS) { sessions.delete(id); removed = true; }
    return removed;
  };
  /** Session as the page sees it: projectKey + name resolved through user names. */
  const resolve = (s) => {
    const projectKey = projectKeyOf(s);
    const inferred = projectKey && projectKey !== s.cwd;
    const custom = names[projectKey];
    const name = custom || (inferred ? path.basename(projectKey) : s.name);
    return { ...s, projectKey, name: name || s.name };
  };
  const list = () => { prune(); return [...sessions.values()].map(resolve); };
  // The growing village: per-project work history, backfilled from transcripts.
  let village = null;
  // Scheduled cloud routines: a snapshot file (written by scripts/routines-snapshot.mjs or a sync task).
  // The app can't reach claude.ai itself; it computes next runs from each cron locally.
  let routines = null;
  const loadRoutines = () => {
    if (!routinesPath) return;
    try { routines = JSON.parse(fs.readFileSync(routinesPath, 'utf8')); } catch { routines = null; }
  };
  loadRoutines();
  if (routinesPath) {
    fs.watchFile(routinesPath, { interval: 5000 }, () => { loadRoutines(); changed(); });
  }

  // Plan usage, as the Claude desktop app last recorded it (5-hour and 7-day % used)
  let usage = null;
  const USAGE_FILE = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'plan-usage-history.json');
  const loadUsage = () => {
    try {
      const samples = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'))?.samples || [];
      const last = samples[samples.length - 1];
      usage = last ? { fiveHour: typeof last.u?.fh === 'number' ? last.u.fh : null, sevenDay: typeof last.u?.sd === 'number' ? last.u.sd : null, at: last.t } : null;
    } catch { usage = null; }
  };
  loadUsage();
  fs.watchFile(USAGE_FILE, { interval: 15000 }, () => { loadUsage(); changed(); });

  const payload = (all) => {
    const o = { sessions: all };
    if (village) o.village = village.data();
    if (cowork) {
      o.cowork = cowork.groups(assign, names);
      let fresh = false;
      for (const g of o.cowork.groups) for (const id of g.sessions) if (!seen[id]) { seen[id] = Date.now(); fresh = true; }
      if (fresh) scheduleNamesSave();
      o.coworkSeen = seen;
    }
    if (routines) o.routines = routines;
    o.names = names;
    o.work = work;
    o.custom = custom; o.seenProjects = seenProjects; o.reviewed = reviewed;
    o.usage = usage; o.privacy = privacy;
    return JSON.stringify(o);
  };
  const changed = () => {
    const all = list();
    const data = `data: ${payload(all)}\n\n`;
    for (const res of clients) { try { res.write(data); } catch {} }
    scheduleSave();
    try { onChange?.(all); } catch {}
  };
  const inject = (evt) => {
    try {
      // a finished turn grows that project's house
      if (village && evt?.hook_event_name === 'Stop' && evt.transcript_path) village.touch(String(evt.transcript_path));
      if (applyHook(sessions, evt)) changed();
    } catch {}
  };
  if (villageCache) {
    try {
      village = createVillage({ cacheFile: villageCache, quiet, onChange: () => changed() });
      village.scan().then(() => { log(`🏡 village: ${village.data().projects.length} project(s)`); changed(); }).catch(() => {});
    } catch (e) { log(`village unavailable: ${e.message}`); village = null; }
  }

  // Sweep: catch sessions whose Stop hook never fired (interrupts, crashes, closed terminals).
  const sweep = () => {
    const now = Date.now();
    let dirty = prune();
    for (const s of sessions.values()) {
      if (s.status !== 'working' || now - s.updated <= QUIET_MS) continue;
      let mtime = 0;
      if (s.transcript) { try { mtime = fs.statSync(s.transcript).mtimeMs; } catch {} }
      if (s.transcript && lastUserInterrupted(s.transcript)) {
        s.tool = ''; s.subagents = [];
        setStatus(s, 'done', 'Interrupted — your turn', now); dirty = true;
      } else if (s.transcript && lastTurnEnded(s.transcript)) {
        s.tool = ''; s.subagents = [];
        setStatus(s, 'done', 'Finished — your turn', now); dirty = true;
      } else if (!mtime || now - mtime > TRANSCRIPT_IDLE_MS) {
        // No transcript to vouch for it (or it has gone cold): stop claiming it's working.
        if (now - (mtime || s.updated) > TRANSCRIPT_IDLE_MS) { s.tool = ''; s.subagents = []; setStatus(s, 'idle', '', now); dirty = true; }
      }
    }
    if (dirty) changed();
  };
  const sweepTimer = setInterval(sweep, SWEEP_MS);
  sweepTimer.unref?.();
  setTimeout(sweep, 1500).unref?.(); // fix up anything stale we loaded from disk right away

  const readBody = (req, cb) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => cb(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Browsers attach Origin to cross-site POSTs; hooks (curl) send none and our own page matches.
    // This keeps web pages from poking the local server — above all from answering permissions.
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://localhost:${port}` && origin !== `http://127.0.0.1:${port}`) {
        res.writeHead(403).end();
        return;
      }
    }

    // v4: crew manager customisations + what's-new bookkeeping
    if (req.method === 'POST' && (url.pathname === '/custom' || url.pathname === '/seen' || url.pathname === '/reviewed')) {
      readBody(req, (body) => {
        let j = null;
        try { j = JSON.parse(body); } catch {}
        const okKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= 80;
        if (url.pathname === '/custom') {
          if (!okKey(j?.key) || !j.patch || typeof j.patch !== 'object') { res.writeHead(400).end(); return; }
          const cur = { ...(custom[j.key] || {}) };
          const allowed = { color: 'string', hat: 'string', theme: 'string', spot: 'object', hidden: 'boolean' };
          for (const [f, v] of Object.entries(j.patch)) {
            if (!(f in allowed)) continue;
            if (v === null) delete cur[f];
            else if (f === 'spot') { if (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) cur.spot = v.map(Number); }
            else if (typeof v === allowed[f]) cur[f] = typeof v === 'string' ? v.slice(0, 40) : v;
          }
          if (Object.keys(cur).length) custom[j.key] = cur; else delete custom[j.key];
        } else {
          const keys = Array.isArray(j?.keys) ? j.keys.filter(okKey).slice(0, 200) : [];
          const now = Date.now();
          for (const k of keys) {
            if (url.pathname === '/seen') { if (!seenProjects[k]) seenProjects[k] = now; }
            else reviewed[k] = now;
          }
        }
        scheduleNamesSave();
        changed();
        res.writeHead(204).end();
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/event') {
      readBody(req, (body) => {
        try { const evt = JSON.parse(body); evt.__hostId = String(req.headers['x-host-session'] || ''); inject(evt); } catch {}
        res.writeHead(204).end();
      });
      return;
    }


    // Naming / moving from the UI: JSON bodies, 204 on success, 400 on bad input.
    // "Working on it": mark a Cowork session as busy (optionally with a label), or done.
    if (req.method === 'POST' && url.pathname === '/work') {
      readBody(req, (body) => {
        let j = null;
        try { j = JSON.parse(body); } catch {}
        const id = typeof j?.session === 'string' ? j.session : null;
        if (!id) { res.writeHead(400).end(); return; }
        if (j.on) work[id] = { label: String(j.label || '').replace(/\s+/g, ' ').trim().slice(0, 60), since: work[id]?.since || Date.now() };
        else delete work[id];
        scheduleNamesSave();
        changed();
        res.writeHead(204).end();
      });
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/name' || url.pathname === '/assign')) {
      readBody(req, (body) => {
        let j = null;
        try { j = JSON.parse(body); } catch {}
        const str = (v) => typeof v === 'string' ? v : null;
        if (!j || typeof j !== 'object') { res.writeHead(400).end(); return; }
        if (url.pathname === '/name') {
          const key = str(j.key);
          const name = j.name == null ? '' : str(j.name);
          if (!key || name === null) { res.writeHead(400).end(); return; }
          const n = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
          if (n) names[key] = n; else delete names[key];
        } else {
          const id = str(j.session);
          const key = j.key == null || j.key === '' ? null : str(j.key);
          if (!id || (j.key != null && key === null)) { res.writeHead(400).end(); return; }
          if (key) assign[id] = key; else delete assign[id];
        }
        scheduleNamesSave();
        changed();
        res.writeHead(204).end();
      });
      return;
    }

    // "Got it" from the UI: you saw it, stop waving.
    if (req.method === 'POST' && url.pathname === '/ack') {
      const s = sessions.get(url.searchParams.get('id'));
      if (s && s.status === 'help') { s.tool = ''; setStatus(s, 'idle', '', Date.now()); changed(); }
      res.writeHead(204).end();
      return;
    }

    // Logbook: per-project day stats for the house cards and the weekly recap (fetched on demand,
    // never pushed over SSE, so hook events stay cheap).
    if (req.method === 'GET' && url.pathname === '/logbook') {
      if (!village?.logbook || village.data().scanning) { res.writeHead(503).end(); return; }
      try {
        const days = Math.min(120, Math.max(1, Number(url.searchParams.get('days')) || 14));
        const lb = village.logbook({ days });
        for (const p of lb.projects) p.name = names[p.key] || p.name;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }).end(JSON.stringify(lb));
      } catch (e) {
        res.writeHead(500).end(String(e?.message || e));
      }
      return;
    }

    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${payload(list())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    try {
      let file;
      const p = decodeURIComponent(url.pathname);
      const under = (base, prefix) => {
        const f = path.join(base, path.normalize(p.slice(prefix.length)));
        if (!f.startsWith(base + path.sep)) throw new Error('nope');
        return f;
      };
      if (p === '/' || p === '/index.html') file = path.join(DIR, 'index.html');
      else if (p === '/crew.html') file = path.join(DIR, 'crew.html');
      else if (p.startsWith('/three/')) file = under(THREE_DIR, '/three/');
      else if (p.startsWith('/web/')) file = under(WEB_DIR, '/web/');
      else if (p.startsWith('/assets/')) file = under(ASSETS_DIR, '/assets/');
      else throw new Error('404');
      const buf = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(buf);
    } catch {
      res.writeHead(404).end();
    }
  });

  server.on('error', (err) => log(`Bot Planet server error: ${err.message}`));
  server.listen(port, '127.0.0.1', () => log(`🪐 Bot Planet listening on http://localhost:${port}`));

  const close = () => {
    if (routinesPath) fs.unwatchFile(routinesPath);
    clearInterval(sweepTimer);
    try { village?.close(); } catch {}
    try { cowork?.close(); } catch {}
    if (namesTimer) { clearTimeout(namesTimer); saveNamesNow(); }
    if (saveTimer) { clearTimeout(saveTimer); saveNow(); }
    for (const res of clients) { try { res.end(); } catch {} }
    clients.clear();
    try { server.close(); server.closeAllConnections?.(); } catch {}
  };

  const setPrivacy = (on) => { privacy = !!on; changed(); };
  return { server, list, inject, close, setPrivacy };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = startServer({
    statePath: path.join(os.tmpdir(), `bot-planet-state-${PORT}.json`),
    seedTranscripts: true,
    villageCache: path.join(os.tmpdir(), `bot-planet-village-${PORT}.json`),
    namesPath: process.env.BOT_PLANET_NAMES || path.join(os.tmpdir(), `bot-planet-names-${PORT}.json`),
    routinesPath: process.env.BOT_PLANET_ROUTINES || path.join(os.homedir(), 'Library', 'Application Support', 'Bot Planet', 'routines.json'),
    cowork: process.env.BOT_PLANET_COWORK_DIR ? { baseDir: process.env.BOT_PLANET_COWORK_DIR } : true,
  });
  server.on('error', (e) => { if (e.code === 'EADDRINUSE') process.exit(1); });
}
