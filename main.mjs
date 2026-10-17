// Bot Planet notch app: a black Dynamic-Island-style panel that drops out of the MacBook
// camera notch on hover, plus a menu bar status item. Hosts the hook server (server.mjs).
// See docs/CONTRACT.md for the bridge, URL params and geometry.
import { app, BrowserWindow, Tray, Menu, Notification, ipcMain, screen, nativeImage, clipboard, shell } from 'electron';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { startServer, PORT } from './server.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(DIR, 'assets');
const DEBUG = !!process.env.BOT_PLANET_DEBUG;
const log = (...a) => DEBUG && console.log(new Date().toISOString().slice(11, 23), ...a);

const PW = 440, PH = 480;         // panel size (window = PW × (mb + PH))
const OPEN_DELAY = 110;           // cursor must rest in the zone this long to open
const CLOSE_DELAY = 350;          // …and be outside the window this long to close
const ZONE_SLACK = 4, WIN_SLACK = 8;
const STICKY_MS = 8000;           // tray/notification opens stay up until entered+left, or this long

let win, tray, srv, hooks;
let geo;                          // { display, nw, mb, left, x, y }
let zone = null;                  // renderer-reported hover rect (window CSS px)
const state = { expanded: false, hold: false, pinned: false, interactive: false };
let sticky = null;                // { until, entered }
let sessions = [];
const notified = new Map();       // session id → `since` of the help request we already pinged about

// ── prefs ────────────────────────────────────────────────────────────────────
const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
let prefs = { sound: true, notifications: true, ticker: true };
function loadPrefs() {
  try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) }; } catch {}
}
function setPref(key, value) {
  prefs[key] = value;
  try { fs.writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2)); } catch {}
  win?.webContents.send('prefs', { sound: prefs.sound, ticker: prefs.ticker });
}

// ── notch geometry ───────────────────────────────────────────────────────────
// NSScreen knows the notch: the menu bar strips left and right of it are the "auxiliary" areas.
const JXA = `ObjC.import("AppKit");
var s = $.NSScreen.screens, out = [];
for (var i = 0; i < s.count; i++) {
  var sc = s.objectAtIndex(i), f = sc.frame;
  out.push({ w: f.size.width, h: f.size.height, x: f.origin.x,
    l: sc.auxiliaryTopLeftArea.size.width, r: sc.auxiliaryTopRightArea.size.width, top: sc.safeAreaInsets.top });
}
JSON.stringify(out);`;

function measureScreens() {
  try { return JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', JXA], { encoding: 'utf8', timeout: 3000 })); }
  catch (err) { console.warn('Notch measurement failed:', err.message); return []; }
}

function measure() {
  const displays = screen.getAllDisplays();
  const display = displays.find((d) => d.internal) || screen.getPrimaryDisplay();
  const b = display.bounds;
  const ns = measureScreens().find((s) => s.top > 0 && Math.round(s.w) === b.width && Math.round(s.h) === b.height);
  let nw = 0, mb = display.workArea.y - b.y || 25, left = b.width / 2;
  if (ns && ns.l > 0 && ns.r > 0) {
    nw = Math.round(ns.w - ns.l - ns.r);
    mb = Math.round(ns.top);
    left = ns.l;
  }
  const cx = nw ? b.x + left + nw / 2 : b.x + b.width / 2;
  return { display, nw, mb, x: Math.round(cx - PW / 2), y: b.y };
}

const pageURL = () =>
  `http://localhost:${PORT}/?notch=1&mb=${geo.mb}&nw=${geo.nw}&pw=${PW}&ph=${PH}&sound=${prefs.sound ? 1 : 0}`;

function place() {
  win.setBounds({ x: geo.x, y: geo.y, width: PW, height: geo.mb + PH });
}

function remeasure() {
  if (!win) return;
  const prev = geo;
  geo = measure();
  place();
  log('display changed →', { nw: geo.nw, mb: geo.mb, x: geo.x, y: geo.y });
  if (prev.mb !== geo.mb || prev.nw !== geo.nw) { zone = null; win.loadURL(pageURL()); }
}

// ── window ───────────────────────────────────────────────────────────────────
function createWindow() {
  geo = measure();
  win = new BrowserWindow({
    x: geo.x, y: geo.y, width: PW, height: geo.mb + PH,
    type: 'panel',                // non-activating: hovering/clicking never steals focus
    frame: false, transparent: true, hasShadow: false, backgroundColor: '#00000000',
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, show: false,
    enableLargerThanScreen: true, // frameless + this = macOS won't push us below the menu bar
    webPreferences: { preload: path.join(DIR, 'preload.cjs') },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.setIgnoreMouseEvents(true, { forward: true });

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    log('load failed', code, desc, '— retrying');
    setTimeout(() => win?.loadURL(pageURL()), 1000);
  });
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('prefs', { sound: prefs.sound, ticker: prefs.ticker });
    if (state.expanded) win.webContents.send('expanded', true);
    // Test aid: BOT_PLANET_OPEN=1 starts pinned open so the panel can be screenshotted.
    if (process.env.BOT_PLANET_OPEN) { state.pinned = true; setTimeout(() => setExpanded(true), 800); }
    // Test aid: BOT_PLANET_TEST_POSTCARD=1 makes one postcard ~8s after launch.
    if (process.env.BOT_PLANET_TEST_POSTCARD) setTimeout(() => win?.webContents.send('focus-agent', '@postcard'), 8000);
  });
  win.once('ready-to-show', () => {
    win.showInactive();
    place(); // macOS may have constrained the initial frame; re-apply now that it's on screen
    const [, y] = win.getPosition();
    log('shown at', win.getBounds(), y === geo.y ? '(over the menu bar ✓)' : `(pushed down to y=${y}!)`);
  });
  win.loadURL(pageURL());
}

// ── hover: open/close from cursor polling ────────────────────────────────────
function setExpanded(open) {
  if (state.expanded === open) return;
  state.expanded = open;
  if (!open) sticky = null;
  log('→ expanded', open);
  win?.webContents.send('expanded', open);
}

function openPanel() {
  sticky = { until: Date.now() + STICKY_MS, entered: false };
  setExpanded(true);
}

function zoneRect() {
  const b = win.getBounds();
  const z = zone || (() => { const w = (geo.nw || 120) + 80; return { x: (PW - w) / 2, y: 0, w, h: geo.mb }; })();
  return { x: b.x + z.x - ZONE_SLACK, y: b.y + z.y - ZONE_SLACK, w: z.w + 2 * ZONE_SLACK, h: z.h + 2 * ZONE_SLACK };
}
const inRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

let enteredAt = 0, leftAt = 0, pollTimer;
function poll() {
  pollTimer = setTimeout(poll, nextDelay());
  if (!win || win.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  const now = Date.now();

  // Only the notch's own display counts. A monitor placed above the MacBook shares the top edge's
  // x-range; treating it as "the top edge" made the island open/close in a loop (flicker).
  const onNotchDisplay = inRect(p, rectOf(geo.display.bounds));

  if (!state.expanded) {
    if (!onNotchDisplay || now < reopenAfter) { enteredAt = 0; return; }
    const z = zoneRect();
    // The very top row of this display counts too: flinging the cursor up into the notch overshoots the zone's y.
    const hit = inRect(p, z) || (p.y <= geo.y + 1 && p.x >= z.x && p.x <= z.x + z.w);
    if (!hit) { enteredAt = 0; return; }
    if (!enteredAt) enteredAt = now;
    // With a screen above, the cursor often just passes through the notch on its way up: wait a bit longer.
    if (now - enteredAt >= (screenAbove() ? OPEN_DELAY_PASS_THROUGH : OPEN_DELAY)) { enteredAt = 0; setExpanded(true); }
    return;
  }

  // Cursor went to another display (e.g. up onto the monitor above): fold away right away.
  if (!onNotchDisplay && !state.hold && !state.pinned && !(sticky && !sticky.entered && now < sticky.until)) {
    leftAt = 0;
    reopenAfter = now + 500;
    setExpanded(false);
    return;
  }

  const b = win.getBounds();
  const inside = inRect(p, { x: b.x - WIN_SLACK, y: b.y - WIN_SLACK, w: b.width + 2 * WIN_SLACK, h: b.height + 2 * WIN_SLACK });
  if (inside) {
    leftAt = 0;
    if (sticky) sticky.entered = true;
    return;
  }
  if (state.hold || state.pinned) { leftAt = 0; return; }
  if (sticky && !sticky.entered && now < sticky.until) return;
  if (!leftAt) leftAt = now;
  if (now - leftAt >= CLOSE_DELAY) { leftAt = 0; setExpanded(false); }
}

// Fast while open or while the cursor is near the top of the built-in display; lazy otherwise.
let reopenAfter = 0;
const rectOf = (b) => ({ x: b.x, y: b.y, w: b.width, h: b.height }); // Electron bounds → inRect shape
const OPEN_DELAY_PASS_THROUGH = 260;
/** True when another display sits directly above the notch display (its bottom edge touches our top). */
function screenAbove() {
  const b = geo.display.bounds;
  return screen.getAllDisplays().some((d) => d.id !== geo.display.id
    && Math.abs(d.bounds.y + d.bounds.height - b.y) <= 2
    && d.bounds.x < b.x + b.width && d.bounds.x + d.bounds.width > b.x);
}
function nextDelay() {
  if (state.expanded || enteredAt) return 50;
  if (!geo) return 150;
  const p = screen.getCursorScreenPoint();
  const b = geo.display.bounds;
  const near = inRect(p, rectOf(b)) && p.y < b.y + geo.mb + 160 && p.x > geo.x - 60 && p.x < geo.x + PW + 60;
  return near ? 50 : 150;
}

// ── IPC (window.botPlanet) ───────────────────────────────────────────────────
ipcMain.on('set-interactive', (_e, on) => {
  state.interactive = !!on;
  log('set-interactive', !!on);
  win?.setIgnoreMouseEvents(!on, { forward: true });
});
ipcMain.on('set-zone', (_e, r) => {
  if (r && [r.x, r.y, r.w, r.h].every(Number.isFinite)) {
    zone = { x: r.x, y: r.y, w: r.w, h: r.h };
    log('set-zone', zone);
  }
});
ipcMain.on('set-hold', (_e, on) => { state.hold = !!on; log('set-hold', state.hold); });
ipcMain.on('set-pinned', (_e, on) => { state.pinned = !!on; log('set-pinned', state.pinned); });
ipcMain.on('copy', (_e, text) => clipboard.writeText(String(text ?? '')));
ipcMain.on('focus', () => { if (win && !win.isDestroyed()) { win.setIgnoreMouseEvents(false); win.focus(); } });
// Weekly postcard: PNG data URL → ~/Downloads/bot-planet-postcard-YYYY-MM-DD.png (never overwrites), shown in Finder.
ipcMain.handle('save-postcard', async (_e, dataUrl) => {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
  if (!m) throw new Error('save-postcard expects a PNG data URL');
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dir = app.getPath('downloads');
  let file = path.join(dir, `bot-planet-postcard-${day}.png`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `bot-planet-postcard-${day}-${i}.png`);
  await fs.promises.writeFile(file, Buffer.from(m[1], 'base64'));
  shell.showItemInFolder(file);
  log('save-postcard', file);
  return file;
});

// ── sessions → tray + notifications ──────────────────────────────────────────
const ICONS = {};
function loadIcons() {
  ICONS.normal = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
  ICONS.normal.setTemplateImage(true);
  ICONS.alert = nativeImage.createFromPath(path.join(ASSETS, 'trayAlert.png'));
}

function updateTray() {
  if (!tray) return;
  const n = sessions.filter((s) => s.status === 'help').length;
  tray.setImage(n ? ICONS.alert : ICONS.normal);
  tray.setTitle(n ? ` ${n}` : '');
  tray.setToolTip(n ? `Bot Planet — ${n} need${n === 1 ? 's' : ''} you` : 'Bot Planet');
}

function focusAgent(id) {
  openPanel();
  win?.webContents.send('focus-agent', id);
}

function onSessions(list) {
  sessions = list;
  updateTray();
  const help = list.filter((s) => s.status === 'help');
  for (const s of help) {
    if (notified.get(s.id) === s.since) continue;
    notified.set(s.id, s.since);
    if (!prefs.notifications || !Notification.isSupported()) continue;
    const note = new Notification({ title: `👋 ${s.name || s.project} needs you`, body: s.message || 'Needs your attention', silent: !prefs.sound });
    note.on('click', () => focusAgent(s.id));
    note.show();
  }
  for (const id of notified.keys()) if (!help.some((s) => s.id === id)) notified.delete(id);
}

// ── menu bar menu (rebuilt each time it opens) ───────────────────────────────
const DOT = { help: '🟠', working: '🔵', done: '🟢', idle: '⚪' };
const ORDER = { help: 0, working: 1, done: 2, idle: 3 };

async function sendHook(evt) {
  if (srv?.inject) return srv.inject(evt);
  try {
    await fetch(`http://127.0.0.1:${PORT}/event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evt) });
  } catch {}
}

let waveTimer;
function testWave() {
  const base = { session_id: 'test-wave', cwd: '/tmp/test astronaut' };
  sendHook({ ...base, hook_event_name: 'SessionStart' });
  sendHook({ ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash (this is just a test 👋)' });
  clearTimeout(waveTimer);
  waveTimer = setTimeout(() => sendHook({ ...base, hook_event_name: 'SessionEnd' }), 25000);
}

function hooksItem() {
  let installed = false;
  try { installed = !!hooks?.hooksInstalled(); } catch {}
  if (installed) return { label: 'Claude hooks: connected ✓', enabled: false };
  return {
    label: 'Connect Claude Code…',
    enabled: !!hooks?.installHooks,
    click: () => {
      try { hooks.installHooks(); new Notification({ title: 'Bot Planet', body: 'Claude Code hooks installed. New sessions will show up on the planet.' }).show(); }
      catch (err) { new Notification({ title: 'Bot Planet', body: `Couldn't install hooks: ${err.message}` }).show(); }
    },
  };
}

function buildMenu() {
  const list = [...sessions].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.updated - a.updated);
  const n = list.filter((s) => s.status === 'help').length;
  const header = `Bot Planet — ${list.length} crew${n ? ` · ${n} need${n === 1 ? 's' : ''} you` : ''}`;
  const rows = list.map((s) => ({
    label: `${DOT[s.status] || '⚪'}  ${s.name || s.project}${s.status === 'working' && s.tool ? `  ·  ${s.tool.replace(/^mcp__([^_]+)__.*/, '$1')}` : ''}`,
    toolTip: s.message || s.task || '',
    click: () => focusAgent(s.id),
  }));
  return Menu.buildFromTemplate([
    { label: header, enabled: false },
    ...(rows.length ? rows : [{ label: 'No astronauts yet', enabled: false }]),
    { type: 'separator' },
    { label: 'Open planet', click: openPanel },
    { label: 'Weekly recap 📒', click: () => { openPanel(); win?.webContents.send('focus-agent', '@logbook'); } },
    { label: 'Weekly postcard 📮', click: () => { openPanel(); win?.webContents.send('focus-agent', '@postcard'); } },
    { label: 'Schedule 📡', click: () => { openPanel(); win?.webContents.send('focus-agent', '@schedule'); } },
    { label: 'Send a test wave 👋', click: testWave },
    { type: 'separator' },
    { label: 'Sound', type: 'checkbox', checked: prefs.sound, click: (i) => setPref('sound', i.checked) },
    { label: 'Live ticker in the notch', type: 'checkbox', checked: prefs.ticker, click: (i) => setPref('ticker', i.checked) },
    { label: 'Notifications', type: 'checkbox', checked: prefs.notifications, click: (i) => setPref('notifications', i.checked) },
    { label: 'Open at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { type: 'separator' },
    hooksItem(),
    { type: 'separator' },
    { label: 'Quit Bot Planet', accelerator: 'Command+Q', click: () => app.quit() },
  ]);
}

function createTray() {
  loadIcons();
  tray = new Tray(ICONS.normal);
  const pop = () => tray.popUpContextMenu(buildMenu());
  tray.on('click', pop);
  tray.on('right-click', pop);
  updateTray();
}

// ── boot ─────────────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', openPanel);
  app.whenReady().then(async () => {
    app.dock?.hide();
    loadPrefs();
    srv = startServer({ onChange: onSessions, statePath: path.join(app.getPath('userData'), 'sessions.json'), seedTranscripts: true, villageCache: path.join(app.getPath('userData'), 'village.json'), namesPath: path.join(app.getPath('userData'), 'names.json'), routinesPath: path.join(app.getPath('userData'), 'routines.json') });
    srv.server.on('error', (err) => {
      // Another Bot Planet (or `npm run serve`) already owns the port: show its page, skip native notifications.
      if (err.code === 'EADDRINUSE') { srv = null; console.warn(`Port ${PORT} in use; using the existing server.`); }
      else throw err;
    });
    try { hooks = await import('./hooks.mjs'); } catch (err) { console.warn('hooks.mjs unavailable:', err.message); }
    try { onSessions(srv?.list?.() || []); } catch {}
    createWindow();
    createTray();
    poll();
    for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, remeasure);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => clearTimeout(pollTimer));
}
