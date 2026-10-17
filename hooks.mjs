// Install / uninstall Bot Planet hooks in ~/.claude/settings.json (backs it up first).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARK = 'bot-planet';
const settingsFile = () => path.join(process.env.BOT_PLANET_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json'));
const port = () => Number(process.env.BOT_PLANET_PORT) || 4711;
// Fire-and-forget: 1s cap, never fails, never prints — Claude is unaffected when the widget is closed.
const command = () => `curl -s -m 1 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${port()}/event >/dev/null 2>&1 || true # ${MARK}`;

export const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification',
  'PermissionRequest', 'SubagentStop', 'PreCompact', 'Stop', 'SessionEnd',
];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);

const read = () => {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
};

/** True when every event in HOOK_EVENTS has a Bot Planet hook installed. */
export function hooksInstalled() {
  const hooks = read().hooks || {};
  return HOOK_EVENTS.every((ev) =>
    (hooks[ev] || []).some((m) => (m.hooks || []).some((h) => String(h.command || '').includes(MARK))));
}

/** Returns the resulting settings JSON text; writes it (with a backup) unless dryRun. */
export function installHooks({ uninstall = false, dryRun = false } = {}) {
  const file = settingsFile();
  const settings = read();
  settings.hooks ??= {};

  // Remove any previous Bot Planet entries so this is idempotent.
  for (const ev of Object.keys(settings.hooks)) {
    settings.hooks[ev] = settings.hooks[ev]
      .map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !String(h.command || '').includes(MARK)) }))
      .filter((m) => m.hooks.length);
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  if (!uninstall) {
    for (const ev of HOOK_EVENTS) {
      const entry = { hooks: [{ type: 'command', command: command(), timeout: 2 }] };
      if (TOOL_EVENTS.has(ev)) entry.matcher = '*';
      (settings.hooks[ev] ??= []).push(entry);
    }
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;

  const out = JSON.stringify(settings, null, 2) + '\n';
  if (!dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
    fs.writeFileSync(file, out);
  }
  return out;
}
