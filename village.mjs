// village.mjs — work-history scanner for Bot Planet's growing village.
// Turns Claude Code transcripts (~/.claude/projects/<dir>/<session>.jsonl) into
// per-project totals. Node built-ins only; incremental via a JSON cache.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CACHE_VERSION = 3;
const KEEP_DAYS = 120;
const ACTIVE_GAP_MS = 5 * 60 * 1000;
const REPLY_MAX_MS = 12 * 3600 * 1000;
const DAY_MS = 86400000;
const CHUNK = 1 << 20; // 1 MiB reads
const TOUCH_DEBOUNCE_MS = 3000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/;
const TOOL_RE = /"type":"tool_use"[^}]*?"name":"([A-Za-z0-9_]+)"/g;
const NL = 10;
const HOME = os.homedir();
const PATH_RE = /"(?:file_path|notebook_path|path)":"((?:[^"\\]|\\.)*)"/g;
const CD_RE = /\bcd (?:\\"|')?(~?\/[^\s"'\\;&|]*)/g;
const CONTAINERS = [['Documents', 'Code'], ['Code'], ['Projects'], ['Developer'], ['src'], ['Documents'], ['Desktop']];
const MIN_SHARE = 0.3;

// Map an absolute path to a project root dir, or null.
export function rootOf(p) {
  if (p.startsWith('~/')) p = HOME + p.slice(1);
  if (!p.startsWith(HOME + '/')) return null;
  const seg = p.slice(HOME.length + 1).split('/').filter(Boolean);
  if (seg.length < 2 || seg[0].startsWith('.') || seg[0] === 'Library') return null;
  for (const c of CONTAINERS) {
    if (c.every((x, i) => seg[i] === x)) {
      return seg.length > c.length + 1 && !seg[c.length].startsWith('.')
        ? path.join(HOME, ...c, seg[c.length]) : null;
    }
  }
  return path.join(HOME, seg[0]);
}

function pickRoot(e) {
  let best = '', n = 0, total = 0;
  for (const [r, c] of Object.entries(e.roots || {})) { total += c; if (c > n) { n = c; best = r; } }
  return total && n / total >= MIN_SHARE ? best : '';
}

const pad = (n) => (n < 10 ? '0' : '') + n;
export function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
let dayCache = { start: 0, end: 0, key: '' };
function dayOf(ts) {
  if (ts >= dayCache.start && ts < dayCache.end) return dayCache.key;
  const d = new Date(ts);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  dayCache = { start, end, key: dayKey(ts) };
  return dayCache.key;
}
function bucket(e, ts) {
  const k = dayOf(ts || e.lastTs || Date.now());
  return e.days[k] || (e.days[k] = { turns: 0, prompts: 0, edits: 0, commands: 0, activeMin: 0, tokIn: 0, tokOut: 0, replyMs: 0, replies: 0 });
}
const ID_RE = /"id":"(msg_[^"]+)"/;
const IN_RE = /"input_tokens":(\d+)/;
const OUT_RE = /"output_tokens":(\d+)/;
const CC_RE = /"cache_creation_input_tokens":(\d+)/;
const CR_RE = /"cache_read_input_tokens":(\d+)/;
const num = (re, line) => { const m = re.exec(line); return m ? +m[1] : 0; };

function emptyEntry() {
  return { size: 0, mtimeMs: 0, offset: 0, cwd: '', lastTs: 0, lastEndTurnTs: 0, lastMsgId: '', lastOut: 0, tokIn: 0, tokOut: 0, activeMin: 0, days: {}, root: '', roots: {}, npaths: 0, turns: 0, edits: 0, commands: 0, firstAt: 0, lastAt: 0 };
}

function parseTs(line) {
  const i = line.indexOf('"timestamp":"');
  if (i < 0) return 0;
  const s = i + 13;
  const e = line.indexOf('"', s);
  if (e < 0) return 0;
  const t = Date.parse(line.slice(s, e));
  return Number.isFinite(t) ? t : 0;
}

function processLine(line, e) {
  if (!e.cwd && line.includes('"cwd"')) {
    const m = CWD_RE.exec(line);
    if (m) {
      try { e.cwd = JSON.parse('"' + m[1] + '"'); } catch { e.cwd = m[1]; }
    }
  }
  const ts = parseTs(line);
  if (ts) {
    if (!e.firstAt || ts < e.firstAt) e.firstAt = ts;
    if (ts > e.lastAt) e.lastAt = ts;
    if (e.lastTs) {
      const gap = ts - e.lastTs;
      if (gap > 0 && gap <= ACTIVE_GAP_MS) {
        e.activeMin += gap / 60000;
        bucket(e, ts).activeMin += gap / 60000;
      }
    }
    e.lastTs = ts;
  }
  if (!line.includes('"type":"assistant"')) {
    // real user prompt: string content not starting with '<', not a tool result
    if (ts && line.includes('"type":"user"') && !line.includes('"tool_result"') && !line.includes('"isMeta":true')) {
      let c;
      try { c = JSON.parse(line)?.message?.content; } catch { return; }
      if (typeof c === 'string' && c && c[0] !== '<') {
        const b = bucket(e, ts);
        b.prompts++;
        if (e.lastEndTurnTs) {
          const d = ts - e.lastEndTurnTs;
          if (d >= 0 && d <= REPLY_MAX_MS) { b.replyMs += d; b.replies++; }
          e.lastEndTurnTs = 0;
        }
      }
    }
    return;
  }
  if (line.includes('"stop_reason":"end_turn"')) {
    e.turns++;
    bucket(e, ts).turns++;
    if (ts) e.lastEndTurnTs = ts;
  }
  if (line.includes('"usage"')) {
    const id = (ID_RE.exec(line) || [])[1] || '';
    const out = num(OUT_RE, line);
    const b = bucket(e, ts);
    if (id && id === e.lastMsgId) {
      // same message streamed as several entries: only add growth in output tokens
      if (out > e.lastOut) { b.tokOut += out - e.lastOut; e.tokOut += out - e.lastOut; e.lastOut = out; }
    } else {
      const inn = num(IN_RE, line) + num(CC_RE, line) + num(CR_RE, line);
      b.tokIn += inn; e.tokIn += inn; b.tokOut += out; e.tokOut += out;
      e.lastMsgId = id; e.lastOut = out;
    }
  }
  if (line.includes('"type":"tool_use"')) {
    if (e.cwd === HOME) {
      let pm;
      PATH_RE.lastIndex = 0;
      while ((pm = PATH_RE.exec(line))) {
        let p; try { p = JSON.parse('"' + pm[1] + '"'); } catch { continue; }
        e.npaths++;
        const r = rootOf(p);
        if (r) e.roots[r] = (e.roots[r] || 0) + 1;
      }
      if (line.includes('"name":"Bash"')) {
        CD_RE.lastIndex = 0;
        while ((pm = CD_RE.exec(line))) {
          const r = rootOf(pm[1]);
          if (r) { e.npaths++; e.roots[r] = (e.roots[r] || 0) + 1; }
        }
      }
    }
    TOOL_RE.lastIndex = 0;
    let m;
    while ((m = TOOL_RE.exec(line))) {
      if (m[1] === 'Bash') { e.commands++; bucket(e, ts).commands++; }
      else if (EDIT_TOOLS.has(m[1])) { e.edits++; bucket(e, ts).edits++; }
    }
  }
}

// Read [e.offset, size) of file, advancing e.offset to just past the last full line.
async function scanFile(file, size, e) {
  const fh = await fs.promises.open(file, 'r');
  try {
    let pos = e.offset;
    let carry = null;
    const buf = Buffer.allocUnsafe(CHUNK);
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      let chunk = buf.subarray(0, bytesRead);
      if (carry) chunk = Buffer.concat([carry, chunk]);
      const last = chunk.lastIndexOf(NL);
      if (last < 0) { carry = Buffer.from(chunk); continue; }
      const text = chunk.toString('utf8', 0, last);
      carry = last + 1 < chunk.length ? Buffer.from(chunk.subarray(last + 1)) : null;
      e.offset += last + 1; // chunk (carry + new bytes) starts at e.offset
      let start = 0;
      while (start <= text.length) {
        let end = text.indexOf('\n', start);
        if (end < 0) end = text.length;
        if (end > start) processLine(text.slice(start, end), e);
        start = end + 1;
      }
    }
  } finally {
    await fh.close();
  }
}

export function createVillage({ cacheFile, projectsDir, onChange, quiet } = {}) {
  projectsDir = projectsDir || path.join(os.homedir(), '.claude', 'projects');
  const home = os.homedir();
  const log = (...a) => { if (!quiet) console.error('[village]', ...a); };
  let files = {}; // path -> entry
  let snapshot = { projects: [], scannedAt: 0, scanning: false };
  let queue = Promise.resolve();
  let closed = false;
  const timers = new Map();
  let saveTimer = null;

  try {
    if (cacheFile) {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c && c.version === CACHE_VERSION && c.files) files = c.files;
    }
  } catch {}

  function rebuild(scannedAt) {
    const by = new Map();
    for (const e of Object.values(files)) {
      if (!e.cwd || !e.turns) continue;
      const key = (e.cwd === home && (e.root = pickRoot(e))) || e.cwd;
      let p = by.get(key);
      if (!p) {
        p = {
          key,
          name: key === home ? 'home' : path.basename(key) || key,
          turns: 0, edits: 0, commands: 0, sessions: 0, firstAt: 0, lastAt: 0,
        };
        by.set(key, p);
      }
      p.turns += e.turns; p.edits += e.edits; p.commands += e.commands; p.sessions++;
      if (e.firstAt && (!p.firstAt || e.firstAt < p.firstAt)) p.firstAt = e.firstAt;
      if (e.lastAt > p.lastAt) p.lastAt = e.lastAt;
    }
    snapshot = {
      projects: [...by.values()].sort((a, b) => b.turns - a.turns),
      scannedAt: scannedAt ?? snapshot.scannedAt,
      scanning: snapshot.scanning,
    };
  }

  function saveSoon(immediate) {
    if (!cacheFile) return;
    clearTimeout(saveTimer);
    const run = () => {
      try {
        const tmp = cacheFile + '.tmp';
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, files }));
        fs.renameSync(tmp, cacheFile);
      } catch (err) { log('cache write failed', err.message); }
    };
    if (immediate) run(); else { saveTimer = setTimeout(run, 2000); saveTimer.unref?.(); }
  }

  async function updateFile(file) {
    let st;
    try { st = await fs.promises.stat(file); } catch { delete files[file]; return false; }
    if (!st.isFile()) return false;
    let e = files[file];
    if (!e) e = files[file] = emptyEntry();
    if (st.size === e.size && st.mtimeMs === e.mtimeMs && e.offset <= st.size) return false;
    if (st.size < e.offset) { Object.assign(e, emptyEntry()); }
    const before = e.offset;
    try {
      await scanFile(file, st.size, e);
    } catch (err) {
      log('scan failed', file, err.message);
      return false;
    }
    const cut = dayKey(Date.now() - KEEP_DAYS * DAY_MS);
    for (const k of Object.keys(e.days)) if (k < cut) delete e.days[k];
    e.size = st.size; e.mtimeMs = st.mtimeMs;
    return e.offset !== before;
  }

  async function doScan() {
    snapshot.scanning = true;
    let changed = false;
    try {
      let dirs = [];
      try { dirs = await fs.promises.readdir(projectsDir, { withFileTypes: true }); } catch (err) { log('readdir', err.message); }
      const seen = new Set();
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const dir = path.join(projectsDir, d.name);
        let names = [];
        try { names = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const n of names) {
          if (!n.isFile() || !n.name.endsWith('.jsonl')) continue;
          const f = path.join(dir, n.name);
          seen.add(f);
          if (await updateFile(f)) changed = true;
          await new Promise((r) => setImmediate(r)); // keep the host responsive
        }
      }
      for (const f of Object.keys(files)) {
        if (!seen.has(f) && f.startsWith(projectsDir + path.sep)) { delete files[f]; changed = true; }
      }
    } catch (err) {
      log('scan error', err.message);
    }
    snapshot.scanning = false;
    rebuild(Date.now());
    saveSoon(true);
    return changed;
  }

  const enqueue = (fn) => (queue = queue.then(fn, fn).catch((err) => { log(err.message); }));

  return {
    data: () => snapshot,
    logbook({ days = 14 } = {}) {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (Math.max(1, days) - 1));
      const cutoff = dayKey(first.getTime());
      const by = new Map();
      for (const e of Object.values(files)) {
        if (!e.cwd || !e.turns) continue;
        const key = (e.cwd === home && pickRoot(e)) || e.cwd;
        let p = by.get(key);
        if (!p) {
          p = {
            key, name: key === home ? 'home' : path.basename(key) || key, days: {},
            allTime: { turns: 0, edits: 0, commands: 0, sessions: 0, firstAt: 0, lastAt: 0, tokIn: 0, tokOut: 0, activeMin: 0 },
          };
          by.set(key, p);
        }
        const a = p.allTime;
        a.turns += e.turns; a.edits += e.edits; a.commands += e.commands; a.sessions++;
        a.tokIn += e.tokIn || 0; a.tokOut += e.tokOut || 0; a.activeMin += e.activeMin || 0;
        if (e.firstAt && (!a.firstAt || e.firstAt < a.firstAt)) a.firstAt = e.firstAt;
        if (e.lastAt > a.lastAt) a.lastAt = e.lastAt;
        for (const [k, b] of Object.entries(e.days || {})) {
          if (k < cutoff) continue;
          const d = p.days[k] || (p.days[k] = { turns: 0, prompts: 0, edits: 0, commands: 0, activeMin: 0, tokIn: 0, tokOut: 0, replyMs: 0, replies: 0 });
          for (const f in d) d[f] += b[f] || 0;
        }
      }
      for (const p of by.values()) {
        p.allTime.activeMin = Math.round(p.allTime.activeMin);
        for (const d of Object.values(p.days)) d.activeMin = Math.round(d.activeMin * 10) / 10;
      }
      return {
        generatedAt: Date.now(),
        today: dayKey(Date.now()),
        projects: [...by.values()].sort((a, b) => b.allTime.turns - a.allTime.turns),
      };
    },
    scan() {
      return enqueue(async () => {
        if (closed) return;
        const changed = await doScan();
        if (changed && onChange) { try { onChange(snapshot); } catch {} }
      });
    },
    touch(transcriptPath) {
      if (closed || !transcriptPath || !transcriptPath.endsWith('.jsonl')) return;
      // top-level session files only: <projectsDir>/<dir>/<file>.jsonl
      const rel = path.relative(projectsDir, transcriptPath);
      if (rel.startsWith('..') || rel.split(path.sep).length !== 2) return;
      clearTimeout(timers.get(transcriptPath));
      const t = setTimeout(() => {
        timers.delete(transcriptPath);
        enqueue(async () => {
          if (closed) return;
          const changed = await updateFile(transcriptPath);
          if (!changed) return;
          rebuild(Date.now());
          saveSoon(false);
          if (onChange) { try { onChange(snapshot); } catch {} }
        });
      }, TOUCH_DEBOUNCE_MS);
      timers.set(transcriptPath, t);
    },
    close() {
      closed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      clearTimeout(saveTimer);
      saveSoon(true);
    },
  };
}
