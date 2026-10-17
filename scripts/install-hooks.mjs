// Adds Bot Planet hooks to ~/.claude/settings.json (backs it up first).
// Usage: node scripts/install-hooks.mjs [--dry-run] [--uninstall]
import { installHooks } from '../hooks.mjs';

const dryRun = process.argv.includes('--dry-run');
const uninstall = process.argv.includes('--uninstall');
const out = installHooks({ uninstall, dryRun });
if (dryRun) console.log(out);
else console.log(`${uninstall ? 'Removed' : 'Installed'} Bot Planet hooks in ~/.claude/settings.json`);
