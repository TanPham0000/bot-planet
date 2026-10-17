// Turn the claude.ai routines list (RemoteTrigger `list` output, saved to a file) into the small
// routines.json Bot Planet reads. Usage: node scripts/routines-snapshot.mjs <api-output.txt> [outFile]
// Default out: ~/Library/Application Support/Bot Planet/routines.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [src, outArg] = process.argv.slice(2);
const raw = fs.readFileSync(src, 'utf8');
const api = JSON.parse(raw.slice(raw.indexOf('{')));
const out = outArg || path.join(os.homedir(), 'Library', 'Application Support', 'Bot Planet', 'routines.json');

const routines = (api.data || [])
  .filter((r) => r.cron_expression) // scheduled routines only (not one-off auto-continues)
  .map((r) => {
    const m = /^CRON_TZ=(\S+)\s+(.*)$/.exec(r.cron_expression.trim());
    return {
      id: r.id,
      name: r.name || r.id,
      cron: m ? m[2] : r.cron_expression.trim(),
      tz: m ? m[1] : 'UTC',
      enabled: !!r.enabled,
      nextRunAt: r.next_run_at || null,
      lastRun: r.last_run ? {
        at: r.last_run.fired_at || r.last_fired_at || null,
        status: String(r.last_run.status || '').replace('ROUTINE_RUN_STATUS_', '').toLowerCase(),
        failure: /UNSPECIFIED/.test(r.last_run.failure_reason || '') ? '' : String(r.last_run.failure_reason || '').replace('ROUTINE_RUN_FAILURE_REASON_', '').toLowerCase(),
      } : null,
      folders: r.derived_state?.folders || [],
    };
  });

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ updatedAt: Date.now(), source: 'claude.ai routines', routines }, null, 2));
console.log(`wrote ${routines.length} routines → ${out}`);
for (const r of routines) console.log(`  ${r.enabled ? '●' : '○'} ${r.name} — ${r.cron} (${r.tz}) next ${r.nextRunAt} last ${r.lastRun?.status || '-'}`);
