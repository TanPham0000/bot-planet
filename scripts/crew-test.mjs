// Test harness for crew.html: serves the page + /web, /three, /assets, proxies /events, /logbook, /name and
// /assign to a real Bot Planet server, and mocks the v4/v5 endpoints (/custom incl. removed + any #rrggbb,
// /seen, /reviewed) and fields (usage, usageHistory) in memory, so the crew manager can be tried before
// server.mjs has them. Fields the upstream already sends win; add ?usage=demo for a busy fake usage week.
// Usage: BOT_PLANET_PORT=4796 node server.mjs  &  node scripts/crew-test.mjs [port=4797] [upstream=4796]
// Then open http://localhost:4797/crew.html  (add ?privacy=1 to test privacy mode, ?host=1 to fake a hostId).
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 4797;
const up = Number(process.argv[3]) || 4796;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const MOUNTS = { '/three/': 'node_modules/three', '/web/': 'web', '/assets/': 'assets' };

// a plausible week: the 5-hour window fills and resets, the weekly % climbs, extra credits show up once
const demoHistory = (() => {
  const out = [], now = Date.now();
  for (let t = now - 7 * 864e5 + 3600e3, wk = 4; t < now; t += 3.3 * 3600e3) {
    wk = Math.min(100, wk + Math.random() * 3.2);
    out.push({ t, fiveHour: Math.round(((t / 3600e3) % 5) * 19 + Math.random() * 6), sevenDay: Math.round(wk), extra: wk > 75 ? Math.round((wk - 75) * 3) : null });
  }
  return out;
})();
const mock = { custom: {}, seenProjects: {}, reviewed: {}, usage: { fiveHour: 42, sevenDay: 18, at: Date.now() }, usageHistory: demoHistory };
// pretend two projects appeared recently, so the NEW badges show up
let last = null;
const clients = new Set(); // { res, privacy, host }

function merged(c) {
  if (!last) return null;
  const m = { ...last };
  for (const k of ['custom', 'seenProjects', 'reviewed', 'usage', 'usageHistory']) if (!(k in last)) m[k] = mock[k];
  if (c.demo) { m.usageHistory = mock.usageHistory; const l = demoHistory[demoHistory.length - 1]; m.usage = { fiveHour: l.fiveHour, sevenDay: l.sevenDay, at: l.t }; }
  if (c.privacy) m.privacy = true;
  if (c.host && m.sessions?.length) m.sessions = m.sessions.map((s, i) => (i === 0 && !s.hostId ? { ...s, hostId: 'local_test-host-id' } : s));
  return m;
}
const send = (c) => { const m = merged(c); if (m) c.res.write(`data: ${JSON.stringify(m)}\n\n`); };
const broadcast = () => { for (const c of clients) send(c); };

function upstream() {
  const req = http.get({ host: '127.0.0.1', port: up, path: '/events' }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (!data) continue;
        try { last = JSON.parse(data); } catch { continue; }
        broadcast();
      }
    });
    res.on('end', () => setTimeout(upstream, 2000));
  });
  req.on('error', () => setTimeout(upstream, 2000));
}
upstream();

const body = async (req) => { const ch = []; for await (const c of req) ch.push(c); try { return JSON.parse(Buffer.concat(ch).toString() || '{}'); } catch { return {}; } };

function proxy(req, res, payload) {
  const p = http.request({ host: '127.0.0.1', port: up, path: req.url, method: req.method, headers: { 'Content-Type': 'application/json' } }, (r) => {
    res.writeHead(r.statusCode, { 'Content-Type': r.headers['content-type'] || 'application/json', 'Cache-Control': 'no-cache' });
    r.pipe(res);
  });
  p.on('error', () => res.writeHead(502).end());
  p.end(payload);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  if (req.method === 'GET' && p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const c = { res, privacy: url.searchParams.get('privacy') === '1', host: url.searchParams.get('host') === '1', demo: url.searchParams.get('usage') === 'demo' };
    clients.add(c); send(c);
    req.on('close', () => clients.delete(c));
    return;
  }
  if (req.method === 'GET' && p === '/logbook') return proxy(req, res);
  if (req.method === 'POST') {
    const b = await body(req);
    console.log('POST', p, JSON.stringify(b));
    if (p === '/name' || p === '/assign' || (last && 'custom' in last)) return proxy(req, res, JSON.stringify(b)); // upstream has v4+: let it own the writes
    if (p === '/custom' && b.key) {
      const cur = { ...(mock.custom[b.key] || {}) };
      for (const [k, v] of Object.entries(b.patch || {})) { if (v === null) delete cur[k]; else cur[k] = v; }
      if (Object.keys(cur).length) mock.custom[b.key] = cur; else delete mock.custom[b.key];
    } else if (p === '/seen') {
      const now = Date.now();
      for (const k of b.keys || []) if (!(k in mock.seenProjects)) mock.seenProjects[k] = now;
    } else if (p === '/reviewed') {
      for (const k of b.keys || []) mock.reviewed[k] = Date.now() + 1;
    } else { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    broadcast();
    return;
  }
  try {
    let file;
    if (p === '/crew.html' || p === '/') file = path.join(ROOT, 'crew.html');
    else {
      const prefix = Object.keys(MOUNTS).find((m) => p.startsWith(m));
      if (!prefix) throw new Error('404');
      const base = path.join(ROOT, MOUNTS[prefix]);
      file = path.join(base, path.normalize(p.slice(prefix.length)));
      if (!file.startsWith(base + path.sep)) throw new Error('404');
    }
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(buf);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`crew test server on http://localhost:${port}/crew.html (upstream :${up})`));
