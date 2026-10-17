// cowork.mjs — read-only view of Claude desktop's Cowork sessions, grouped by project.
// The only local trace is <baseDir>/*/*/remote-session-spaces.json:
//   { entries: [{ sessionId, spaceId|null, folders: string[] }] }
// No titles or status exist there, so each session is just "an astronaut at home".
// Never writes into the Claude app's folders; never throws.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BASE = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');
const FILE = 'remote-session-spaces.json';
const WATCH_MS = 5000;
const RESCAN_MS = 60000;

function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name)); }
  catch { return []; }
}
const sortedByCount = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);

export function createCowork({ baseDir = DEFAULT_BASE, onChange } = {}) {
  /** file → entries[] */
  const files = new Map();
  /** sessionId → { spaceId, folders } (merged) */
  let sessions = new Map();
  let updatedAt = 0;
  let closed = false;

  const parse = (file) => {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return (Array.isArray(j?.entries) ? j.entries : []).filter((e) => e && typeof e.sessionId === 'string' && e.sessionId);
    } catch { return []; }
  };

  const merge = () => {
    const next = new Map();
    for (const entries of files.values()) {
      for (const e of entries) {
        const cur = next.get(e.sessionId) || { spaceId: null, folders: [] };
        if (typeof e.spaceId === 'string' && e.spaceId) cur.spaceId = e.spaceId;
        for (const f of Array.isArray(e.folders) ? e.folders : []) {
          if (typeof f === 'string' && f && !cur.folders.includes(f)) cur.folders.push(f);
        }
        next.set(e.sessionId, cur);
      }
    }
    sessions = next;
    updatedAt = Date.now();
  };

  const watched = new Set();
  const reload = (file) => {
    files.set(file, parse(file));
    merge();
    try { onChange?.(); } catch {}
  };
  const rescan = () => {
    if (closed) return;
    let added = false;
    for (const acct of listDirs(baseDir)) {
      for (const sub of listDirs(acct)) {
        const file = path.join(sub, FILE);
        if (watched.has(file)) continue;
        if (!fs.existsSync(file)) continue;
        watched.add(file);
        files.set(file, parse(file));
        added = true;
        fs.watchFile(file, { interval: WATCH_MS, persistent: false }, () => reload(file));
      }
    }
    if (added) { merge(); try { onChange?.(); } catch {} }
  };
  rescan();
  const timer = setInterval(rescan, RESCAN_MS);
  timer.unref?.();

  /** Groups per the v2 contract. assign: sessionId → group key; names: key → display name. */
  function groups(assign = {}, names = {}) {
    // 1. Natural group key per session.
    const keyOf = new Map();
    for (const [id, s] of sessions) {
      if (s.spaceId) keyOf.set(id, `space:${s.spaceId}`);
      else if (s.folders.length) {
        // most specific folder = deepest path
        const deepest = [...s.folders].sort((a, b) => b.split('/').length - a.split('/').length || b.length - a.length)[0];
        keyOf.set(id, `folder:${deepest}`);
      } else keyOf.set(id, 'folder:');
    }
    // 2. Folder frequencies per natural group (before re-assignment, so a moved session
    //    doesn't change its origin group's identity).
    const byKey = new Map();
    const bucket = (key) => {
      if (!byKey.has(key)) byKey.set(key, { key, sessions: [], folderCount: new Map(), movedCount: new Map() });
      return byKey.get(key);
    };
    for (const [id, nat] of keyOf) {
      const key = typeof assign?.[id] === 'string' && assign[id] ? assign[id] : nat;
      const g = bucket(key);
      g.sessions.push(id);
      if (nat === key) for (const f of sessions.get(id).folders) g.folderCount.set(f, (g.folderCount.get(f) || 0) + 1);
      else for (const f of sessions.get(id).folders) g.movedCount.set(f, (g.movedCount.get(f) || 0) + 1);
    }
    const out = [];
    for (const g of byKey.values()) {
      // folders of re-assigned-in sessions only count when the group has no natural members
      const folders = sortedByCount(g.folderCount.size ? g.folderCount : g.movedCount);
      let defaultName = folders.length ? path.basename(folders[0]) : '';
      if (!defaultName) defaultName = g.key.startsWith('folder:') ? path.basename(g.key.slice(7)) || 'Cowork' : 'Cowork';
      const n = typeof names?.[g.key] === 'string' ? names[g.key].trim() : '';
      out.push({ key: g.key, name: n || defaultName, defaultName, named: !!n, sessions: g.sessions.sort(), folders });
    }
    out.sort((a, b) => b.sessions.length - a.sessions.length || (a.key < b.key ? -1 : 1));
    return { updatedAt, groups: out };
  }

  const close = () => {
    closed = true;
    clearInterval(timer);
    for (const f of watched) { try { fs.unwatchFile(f); } catch {} }
    watched.clear();
  };

  return { groups, close, count: () => sessions.size };
}
