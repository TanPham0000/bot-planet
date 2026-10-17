// Tiny static server for scripts/*-test.html pages: serves /web, /three, /assets and /scripts.
// POST /save-png (body: PNG data URL) writes it to $TEST_OUT (default: the OS temp dir).
// Usage: node scripts/serve-test.mjs [port=4794]  →  http://localhost:4794/scripts/landmarks-test.html
import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 4794;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const MOUNTS = { '/three/': 'node_modules/three', '/web/': 'web', '/assets/': 'assets', '/scripts/': 'scripts' };

http.createServer(async (req, res) => {
  // test pages can POST a PNG data URL here to inspect it on disk
  if (req.method === 'POST' && req.url === '/save-png') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const b64 = Buffer.concat(chunks).toString().replace(/^data:image\/png;base64,/, '');
    const file = path.join(process.env.TEST_OUT || os.tmpdir(), `postcard-test-${Date.now()}.png`);
    await writeFile(file, Buffer.from(b64, 'base64'));
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(file);
    return;
  }
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const prefix = Object.keys(MOUNTS).find((m) => p.startsWith(m));
    if (!prefix) throw new Error('404');
    const base = path.join(ROOT, MOUNTS[prefix]);
    const file = path.join(base, path.normalize(p.slice(prefix.length)));
    if (!file.startsWith(base + path.sep)) throw new Error('404');
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(buf);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`test server on http://localhost:${port}/scripts/landmarks-test.html`));
