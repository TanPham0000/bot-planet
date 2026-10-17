import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createVillage } from '../village.mjs';
const real = path.join(os.homedir(), '.claude/projects');
const cache = path.join(os.tmpdir(), 'village-test-cache.json');
try { fs.unlinkSync(cache); } catch {}
let v = createVillage({ cacheFile: cache, projectsDir: real });
let t = Date.now(); await v.scan();
console.log('cold ms', Date.now() - t);
const d = v.data();
let nfiles = 0; for (const x of fs.readdirSync(real)) try { nfiles += fs.readdirSync(path.join(real, x)).filter(f => f.endsWith('.jsonl')).length } catch {}
console.log('files', nfiles, 'projects', d.projects.length);
console.table(d.projects.slice(0, 10).map(p => ({ ...p, firstAt: new Date(p.firstAt).toISOString().slice(0,10), lastAt: new Date(p.lastAt).toISOString().slice(0,10) })));
v.close();
v = createVillage({ cacheFile: cache, projectsDir: real });
t = Date.now(); await v.scan(); console.log('warm ms', Date.now() - t, 'same turns', v.data().projects[0]?.turns === d.projects[0]?.turns);
v.close();
// touch test on a copy
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vtouch-'));
const top = d.projects[0]; 
const src = fs.readdirSync(real).flatMap(x => { try { return fs.readdirSync(path.join(real, x)).filter(f => f.endsWith('.jsonl')).map(f => path.join(real, x, f)) } catch { return [] } })[0];
fs.mkdirSync(path.join(tmp, 'p')); const cp = path.join(tmp, 'p', 'a.jsonl'); fs.copyFileSync(src, cp);
let changes = 0;
v = createVillage({ projectsDir: tmp, onChange: () => changes++ });
await v.scan(); const b = v.data().projects.reduce((s, p) => s + p.turns, 0);
fs.appendFileSync(cp, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), cwd: '/x', message: { stop_reason: 'end_turn', content: [] } }) + '\n');
v.touch(cp); v.touch(cp);
await new Promise(r => setTimeout(r, 4500));
const a = v.data().projects.reduce((s, p) => s + p.turns, 0);
console.log('touch: turns', b, '->', a, 'onChange calls', changes);
v.close(); fs.rmSync(tmp, { recursive: true });
