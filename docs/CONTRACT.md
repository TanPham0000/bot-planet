# Bot Planet — shared contract

Three parts are built in parallel, each owning its own files. Code to this contract and don't edit another part's files.

| Part | Owner files |
| --- | --- |
| **Server** (live session tracking) | `server.mjs`, `hooks.mjs`, `scripts/install-hooks.mjs` |
| **Shell** (Electron notch app, menu bar, icons, packaging) | `main.mjs`, `preload.cjs`, `package.json`, `assets/**`, `scripts/make-*.mjs`, `scripts/package.mjs` |
| **Renderer** (planet scene + notch island UI) | `index.html` (and any `web/**` modules) |

## Server API (`server.mjs`)

```js
export const PORT; // 4711, or env BOT_PLANET_PORT
export function startServer({
  port = PORT,
  onChange,           // (sessions[]) => void, called after every state change
  statePath,          // optional: JSON file to persist sessions across restarts
  seedTranscripts,    // optional bool: on start, seed sessions active in the last ~20 min from ~/.claude/projects/*/*.jsonl
  quiet,              // optional bool: no console log
}) → { server, list(): Session[], inject(hookEvent): void, close(): void }
```

HTTP: `POST /event` (Claude Code hook JSON on the body), `POST /ack?id=` ("got it", which stops the waving), `GET /events` (SSE; each message is `{"sessions": Session[]}`, sent on connect and after every change), plus static files: `/` → `index.html`, `/web/*` → `web/*`, `/three/*` → `node_modules/three/*`, `/assets/*` → `assets/*`.

```ts
type Session = {
  id: string;            // Claude session_id
  name: string;          // display name: cwd basename, or the first words of the title when cwd is $HOME
  project: string;       // cwd basename
  cwd: string;
  status: 'working' | 'help' | 'done' | 'idle';
  tool: string;          // current/last tool name while working ('' otherwise), e.g. 'Edit', 'Bash', 'Read', 'Grep', 'WebFetch', 'Task', 'mcp__x__y'
  message: string;       // human line: "Using Edit", "Claude needs your permission to use Bash", "Finished — your turn"
  title: string;         // first real user prompt of the session (≤160 chars)
  task: string;          // latest user prompt (≤160 chars)
  subagents: { id: string; description: string; since: number }[]; // running Task/Agent subagents
  since: number;         // ms timestamp of the last status change
  updated: number;       // ms timestamp of the last event
};
```

Status rules: `help` = blocked on the human (Notification permission/question, PermissionRequest, PreToolUse of AskUserQuestion / ExitPlanMode). `done` = Stop, user interrupt, or the idle_prompt nudge (which never downgrades `help`). `working` = prompt/tool activity. `idle` = SessionStart, ack, or a quiet transcript.

## Electron bridge (`window.botPlanet`, from `preload.cjs`)

```js
window.botPlanet = {
  setInteractive(on: boolean),             // false → clicks pass through the window
  setZone({ x, y, w, h }),                 // the island's current hover rect in window CSS px (collapsed or peek size)
  setHold(on: boolean),                    // true while dragging/orbiting: don't auto-collapse
  setPinned(on: boolean),                  // keep the panel open until unpinned
  copy(text: string),
  onExpanded(cb: (open: boolean) => void), // main decides open/close from cursor polling
  onFocusAgent(cb: (id: string) => void),  // from tray/notification clicks: open + focus that astronaut
  onPrefs(cb: (prefs: { sound: boolean }) => void),
};
```

The page URL main loads is `http://localhost:4711/?notch=1&mb=<menubar px>&nw=<notch width px>&pw=<panel w>&ph=<panel h>&sound=<0|1>`.
Window size = `pw` × (`mb` + `ph`), placed at the very top of the built-in display, horizontally centered on the notch. The defaults are `pw=440` and `ph=480`.
On this Mac the notch measures `nw=185`, `mb=32` (from NSScreen auxiliaryTopLeft/RightArea).

Without `window.botPlanet` (a plain browser), the page handles hover itself, so `?notch=1&mb=32&nw=185` can be tested in a browser.

## v2: projects, Cowork astronauts, naming

### Server → page (SSE message)
```ts
{
  sessions: Session[],          // Session gains: projectKey: string, plus `name` resolved through names (below)
  village?: Village,
  cowork?: { updatedAt: number, groups: CoworkGroup[] },
  names?: Record<string, string>, // projectKey → user-chosen display name
}
type CoworkGroup = {
  key: string;          // 'space:<spaceId>' or 'folder:<abs path>' (sessions with no Cowork project)
  name: string;         // names[key] ?? defaultName
  defaultName: string;  // basename of the group's most common folder ("PHAM. Creative", "OUTREACH")
  named: boolean;       // true when the user has named it
  sessions: string[];   // remote Cowork session ids (session_01…), after user re-assignments
  folders: string[];    // distinct folders, most common first
};
```
**`Session.projectKey`:** the cwd when it isn't $HOME. Otherwise it's the project root inferred from the file paths this session's tools touched, using `rootOf()` from village.mjs and the most common root once at least 2 paths are seen. Failing that it's the cwd. `name` = names[projectKey] ?? the old displayName rule.

### Page → server
- `POST /name` with JSON body `{ key, name }`: set the display name for a project key (Claude Code project or Cowork group). An empty name clears it.
- `POST /assign` with JSON body `{ session, key }`: move one Cowork session (`session_01…`) into another group key, or back with `key: null`.

Both are persisted in `namesPath` (a startServer option; JSON `{ names, assign }`) and broadcast at once. They're same-origin only; the existing Origin check covers it.

### Cowork source
`~/Library/Application Support/Claude/local-agent-mode-sessions/*/*/remote-session-spaces.json` → `{ entries: [{ sessionId, spaceId|null, folders: string[] }] }`. Read every account dir and merge. Re-read whenever any of them changes (fs.watchFile at ~5s is fine), and broadcast. There's no status or title per session. Cowork astronauts are always "idle at home".

## v3: logbook (per-project stats + weekly recap)

### village.mjs adds
```ts
logbook({ days = 14 } = {}): {
  generatedAt: number,
  today: 'YYYY-MM-DD',            // local date
  projects: Array<{
    key: string, name: string,    // same key/name as Village projects (home-dir sessions re-attributed)
    days: Record<'YYYY-MM-DD', DayStats>,   // only days with activity, within the last `days` days
    allTime: { turns, edits, commands, sessions, firstAt, lastAt, tokIn, tokOut, activeMin },
  }>,
}
type DayStats = {
  turns: number,      // assistant end_turn entries
  prompts: number,    // real user prompts (string content, not starting with '<', not tool results)
  edits: number, commands: number,
  activeMin: number,  // sum of gaps between consecutive entries of a transcript that are ≤ 5 min, credited to the later entry's day
  tokIn: number,      // input_tokens + cache_creation_input_tokens + cache_read_input_tokens of assistant usage
  tokOut: number,     // output_tokens
  replyMs: number,    // Σ (user prompt ts − previous end_turn ts) when that gap ≤ 12h
  replies: number,    // count of those gaps
};
```
Days are local-time dates. The per-file cache keeps at most the last 120 days of buckets. `data()` (SSE) stays as it is: day buckets are not sent over SSE.

### server.mjs adds
`GET /logbook?days=14` → `village.logbook({ days })`, with `names` applied (name = names[key] ?? name), as JSON with `Cache-Control: no-cache`. It returns 503 while the first scan is running.

## v4: crew manager, custom looks, jump links, alerts, privacy, usage, day/night

Ownership this round:
- **Lead:** `server.mjs`, `hooks.mjs`, `main.mjs`, `preload.cjs`, `web/app.js`, `web/ui.js`, `index.html`
- **Crew session:** `crew.html` (new), `web/crew.js` (new)
- **Visuals session:** `web/world.js`, `web/village.js`, `web/astronaut.js`, `web/routines.js`, `web/colors.js`, `web/landmarks.js`

`nameKey` = a project's display name, trimmed and lower-cased. Houses, colours and continents are already keyed this way.

### Server → page (SSE additions)
```ts
{
  // …everything from v1–v3, plus:
  custom: Record<nameKey, {
    color?: string,          // one of colors.js PALETTE hexes
    hat?: 'cap'|'beanie'|'crown'|'headphones'|'propeller'|'tophat'|'bow'|'flower',
    theme?: 'lighthouse'|'printshop'|'server'|'vault'|'windmill',
    spot?: [number, number, number], // unit vector in planet space: where the project's home/continent sits
    hidden?: boolean,        // not shown on the planet at all
  }>,
  seenProjects: Record<nameKey, number>, // first time Bot Planet saw that project (ms)
  reviewed: Record<nameKey, number>,     // when you last acknowledged it in the crew manager
  usage: { fiveHour: number|null, sevenDay: number|null, at: number } | null, // % of plan used, from the Claude app's plan-usage-history.json
}
// Session gains: hostId?: string — the Claude desktop session id ('local_…') when the hook ran inside the desktop app.
```
### Page → server
- `POST /custom` with `{ key: nameKey, patch: {...} }` merges the patch. A field set to `null` removes it.
- `POST /seen` with `{ keys: nameKey[] }` records a first-seen time for unknown keys. It's idempotent, and any page may call it with the project names it knows.
- `POST /reviewed` with `{ keys: nameKey[] }` stamps those keys as reviewed now. "New" means `seenProjects[k] > (reviewed[k] ?? 0)`.
- `GET /crew.html` serves the crew manager page.

### Bridge additions (`window.botPlanet`)
- `openExternal(url)`: only `claude://` links. It opens a desktop session (`claude://claude.ai/epitaxy/<hostId>`).
- `openCrew()`: opens or focuses the Crew manager window (1100×760, a normal window).

### Renderer contracts (Visuals session exports, Lead wires)
- `colors.js`: `setCustom(custom)`. It makes `colorFor(name)` honour `custom[nameKey].color` before the sticky assignment.
- `astronaut.js`:
  - `hatFor(key)` honours `custom[key].hat`. Export `setCustomLooks(custom)`, or reuse `colors.setCustom`.
  - Faces with feelings by status: help = worried, done = happy (^ ^), napping = closed, working = focused, idle = normal.
  - Stuck: working, but `Date.now() - data.updated > 8 min`. It shows a sweat-drop sprite and moves slower, and `Astronaut.stuck` is readable.
- `landmarks.js`: `themeOf` honours `custom.theme`. Export a setter.
- `village.js`:
  - `update(..., { custom })`. `custom.spot` overrides `plotDir` (snapped to land nearby), and `hidden` projects get no plot.
  - `setNight(k /*0 day … 1 night*/)`: windows of houses whose project is active glow at night.
- `world.js`: `setTimeOfDay(date)` covers sun colour and intensity, hemisphere tint, and a soft night sky.
- `routines.js`: a satellite whose `lastRun.status === 'failed'` shows a red light and a red-tinted body.
