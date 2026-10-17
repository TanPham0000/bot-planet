import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createVillage } from '../village.mjs';
const cache = path.join(os.tmpdir(), 'village-lb-cache.json'); try { fs.unlinkSync(cache) } catch {}
let v = createVillage({ cacheFile: cache }); let t = Date.now(); await v.scan(); console.log('cold ms', Date.now() - t); v.close();
v = createVillage({ cacheFile: cache }); t = Date.now(); await v.scan(); console.log('warm ms', Date.now() - t);
const lb = v.logbook({ days: 7 });
console.log('today', lb.today);
const rows = lb.projects.map(p => { const s = { turns: 0, prompts: 0, activeMin: 0, tokIn: 0, tokOut: 0, replyMs: 0, replies: 0 }; for (const d of Object.values(p.days)) for (const k in s) s[k] += d[k]; return { name: p.name, ...s, activeH: +(s.activeMin / 60).toFixed(1), tokInK: Math.round(s.tokIn / 1000), tokOutK: Math.round(s.tokOut / 1000), avgReplyMin: s.replies ? +(s.replyMs / s.replies / 60000).toFixed(1) : null, allTurns: p.allTime.turns }; }).filter(r => r.turns || r.prompts);
console.table(rows.map(({ activeMin, tokIn, tokOut, replyMs, ...r }) => r));
v.close();
