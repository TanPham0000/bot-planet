// DOM side: the notch island (collapsed ears → peek banner → open panel), browser pill,
// detail card, camp task board, and tiny synthesized sounds.
import { describe, SLEEP_MS } from './astronaut.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const STATUS_COLOR = { help: '#ff7a45', working: '#8cc8f5', done: '#5fbf8f', idle: '#b9b3cc' };

export function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

/**
 * opts: { notch, mb, nw, pw, ph, bridge, fake }
 * on:   { expanded(open), focus(id), ack(id), pin(on), closeCard() }
 */
export function createUI(opts, on) {
  const { notch, mb, nw, pw, ph, bridge } = opts;
  const body = document.body;
  const island = $('island');
  let state = 'collapsed'; // collapsed | peek | open
  let alert = false;
  let pinned = false;
  let peekTimer = 0;

  // ── layout ──
  if (!notch) body.classList.add('browser');
  else {
    if (opts.fake) body.classList.add('fake');
    const root = document.documentElement.style;
    root.setProperty('--mb', mb + 'px');
    root.setProperty('--nw', nw + 'px');
    root.setProperty('--pw', pw + 'px');
    root.setProperty('--ph', ph + 'px');
    // the canvas, labels, card and demo note live inside the panel
    $('panel').append($('stage'), $('labels'), $('demo-note'), $('card'), $('log'));
  }

  let ticking = false;
  function size(s = state) {
    const ear = s === 'collapsed' && ticking ? 122 : alert ? 44 : 34;
    const base = nw ? nw + ear * 2 : ear * 2 + 70;
    if (s === 'open') return { w: pw, h: mb + ph, r: 30 };
    if (s === 'peek') return { w: Math.max(base, 392), h: mb + 46, r: 20 };
    return { w: base, h: mb, r: 11 };
  }
  function apply() {
    if (!notch) return;
    const z = size();
    island.style.setProperty('--w', z.w + 'px');
    island.style.setProperty('--h', z.h + 'px');
    island.style.setProperty('--r', z.r + 'px');
    island.classList.toggle('open', state === 'open');
    island.classList.toggle('peek', state === 'peek');
    island.classList.toggle('alert', alert);
    island.classList.toggle('ticker', ticking && state === 'collapsed');
    // tell main where hovering should open us (window coords: the window is pw wide, centered)
    bridge?.setZone?.({ x: (pw - z.w) / 2, y: 0, w: z.w, h: z.h });
  }

  function setState(s) {
    if (s === state) return;
    if (s !== 'collapsed') ticking = false;
    const was = state;
    state = s;
    apply();
    if (s === 'open' || was === 'open') on.expanded(s === 'open');
  }

  // ── hover / click-through ──
  let pointer = { x: -1, y: -1 };
  let openTimer = 0, closeTimer = 0;
  const inIsland = (x, y, pad = 0) => {
    const r = island.getBoundingClientRect();
    return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  };
  let interactive = null;
  function hitTest(x, y) {
    if (!bridge?.setInteractive) return;
    const want = notch ? inIsland(x, y, 2) : true;
    if (want !== interactive) { interactive = want; bridge.setInteractive(want); }
  }
  addEventListener('pointermove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    hitTest(e.clientX, e.clientY);
    if (!notch || bridge?.onExpanded) return; // inside Electron, main decides open/close by cursor polling
    // plain-browser notch testing: do the hover logic here
    if (state !== 'open') {
      clearTimeout(closeTimer);
      if (inIsland(e.clientX, e.clientY, 4)) { if (!openTimer) openTimer = setTimeout(() => { openTimer = 0; setState('open'); }, 110); }
      else { clearTimeout(openTimer); openTimer = 0; }
    } else if (!pinned && !holding) {
      if (!inIsland(e.clientX, e.clientY, 8)) { if (!closeTimer) closeTimer = setTimeout(() => { closeTimer = 0; setState('collapsed'); }, 350); }
      else { clearTimeout(closeTimer); closeTimer = 0; }
    }
  });
  let holding = false;
  addEventListener('pointerdown', () => { holding = true; bridge?.setHold?.(true); });
  addEventListener('pointerup', () => { holding = false; bridge?.setHold?.(false); });
  bridge?.onExpanded?.((open) => {
    if (open) { clearTimeout(peekTimer); setState('open'); }
    else setState('collapsed');
  });

  island.addEventListener('click', (e) => {
    if (state !== 'open' && !e.target.closest('#peek')) setState('open');
  });
  $('peek').addEventListener('click', () => { const id = $('peek').dataset.id; setState('open'); if (id) on.focus(id); });
  $('pin').addEventListener('click', (e) => {
    e.stopPropagation();
    pinned = !pinned;
    $('pin').classList.toggle('on', pinned);
    bridge?.setPinned?.(pinned);
  });
  $('pill').addEventListener('click', () => on.cycleHelp());

  // ── sound ──
  let soundOn = opts.sound !== false;
  let ac;
  function tone(freqs, { type = 'sine', gap = 0.11, len = 0.22, vol = 0.09 } = {}) {
    if (!soundOn) return;
    try {
      ac ??= new AudioContext();
      const t = ac.currentTime;
      freqs.forEach((f, i) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = type; o.frequency.setValueAtTime(f, t + i * gap);
        g.gain.setValueAtTime(0.0001, t + i * gap);
        g.gain.exponentialRampToValueAtTime(vol, t + i * gap + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * gap + len);
        o.connect(g).connect(ac.destination);
        o.start(t + i * gap); o.stop(t + i * gap + len + 0.05);
      });
    } catch {}
  }
  const SFX = {
    help: () => tone([660, 880]),
    pop: () => tone([520, 780], { gap: 0.05, len: 0.1, vol: 0.05, type: 'triangle' }),
    plink: () => tone([1180 + Math.random() * 200], { len: 0.18, vol: 0.04, type: 'triangle' }),
    chime: () => tone([523, 659, 784], { gap: 0.08, len: 0.3, vol: 0.05, type: 'triangle' }),
    boing: () => tone([220, 330, 180], { gap: 0.06, len: 0.14, vol: 0.05, type: 'square' }),
  };
  bridge?.onPrefs?.((p) => { soundOn = !!p.sound; });

  // ── card ──
  const card = $('card');
  let cardId = null;
  $('c-close').onclick = () => on.closeCard();
  $('c-copy').onclick = async () => {
    const text = $('c-cmd').textContent;
    if (bridge?.copy) bridge.copy(text); else await navigator.clipboard?.writeText(text).catch(() => {});
    $('c-copy').textContent = 'Copied'; setTimeout(() => ($('c-copy').textContent = 'Copy'), 1200);
  };

  // ── naming: click ✏️ (or an unnamed Cowork project) to name the project ──
  let editing = false;
  let cardData = null;
  function startEdit() {
    if (!cardData || cardData.demo) return;
    editing = true;
    const input = $('c-name-input');
    input.value = cardData.name || '';
    input.hidden = false; $('c-name').hidden = true; $('c-edit').hidden = true;
    bridge?.focus?.();       // the notch panel doesn't take keys unless asked
    bridge?.setHold?.(true); // and shouldn't fold away mid-typing
    input.focus(); input.select();
  }
  function endEdit(save) {
    if (!editing) return;
    editing = false;
    const input = $('c-name-input');
    const name = input.value.trim();
    input.hidden = true; $('c-name').hidden = false; $('c-edit').hidden = false;
    bridge?.setHold?.(false);
    if (save && cardData && name !== cardData.name) {
      $('c-name').textContent = name || cardData.name;
      on.rename(cardData.projectKey || cardData.cwd, name);
    }
  }
  $('c-edit').onclick = startEdit;
  $('c-name').ondblclick = startEdit;
  $('c-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') endEdit(true);
    if (e.key === 'Escape') endEdit(false);
    e.stopPropagation();
  });
  $('c-name-input').addEventListener('blur', () => endEdit(true));
  // ── "Working on it" (Cowork) ──
  const workLabel = $('c-work-label');
  const submitWork = (toggle) => {
    if (!cardData?.coworkId) return;
    const on = toggle ? !cardData.manual : true;
    on_work(cardData.coworkId, on, workLabel.value.trim());
    workLabel.blur();
  };
  const on_work = (...a) => on.work?.(...a);
  $('c-work-btn').onclick = () => submitWork(true);
  workLabel.addEventListener('focus', () => { bridge?.focus?.(); bridge?.setHold?.(true); });
  workLabel.addEventListener('blur', () => bridge?.setHold?.(false));
  workLabel.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitWork(false); e.stopPropagation(); });

  $('c-move').addEventListener('change', (e) => {
    const v = e.target.value;
    if (cardData?.coworkId && v !== cardData.projectKey) on.move(cardData.coworkId, v);
  });

  function fillCard(d, accent) {
    cardData = d;
    $('c-dot').style.background = accent;
    if (!editing) $('c-name').textContent = d.name || d.project;
    const st = $('c-status');
    st.className = 'status ' + d.status;
    st.textContent = `${describe(d)} · ${ago(d.since)}`;
    $('c-msg').textContent = d.status === 'help' || d.status === 'done' ? d.message || '' : '';
    const task = d.task || d.title;
    $('c-task').textContent = task ? `“${task}”` : '';
    const subs = d.subagents || [];
    $('c-subs').textContent = subs.length ? `🛰️ ${subs.length} helper${subs.length > 1 ? 's' : ''}: ${subs.map((s) => s.description).join(' · ')}` : '';
    $('c-cwd').textContent = d.cowork ? (d.folders || []).slice(0, 2).join(' · ') : d.cwd || '';
    $('c-cmd').textContent = d.demo ? 'claude --resume (demo)' : `cd ${JSON.stringify(d.cwd || '.')} && claude --resume ${d.id}`;
    $('c-cmd-row').hidden = !!d.cowork;
    $('c-move-row').hidden = !d.cowork;
    $('c-work-row').hidden = !d.cowork || !!d.demo;
    if (d.cowork) {
      if (document.activeElement !== workLabel) workLabel.value = d.manual ? d.task || '' : workLabel.dataset.for === d.id ? workLabel.value : '';
      workLabel.dataset.for = d.id;
      $('c-work-btn').textContent = d.manual ? '✓ Done' : '▶ Working on it';
      $('c-work-btn').classList.toggle('done', !!d.manual);
    }
    $('c-edit').hidden = editing || !!d.demo;
    if (d.cowork) {
      const n = d.projectSize ?? d.groupSize;
      $('c-task').textContent = `${n} Cowork session${n === 1 ? '' : 's'} in this project`;
      const groups = on.projects();
      $('c-move').innerHTML = groups.map((g) => `<option value="${esc(g.key)}"${g.key === d.projectKey ? ' selected' : ''}>${esc(g.name)}</option>`).join('');
    }
    const actions = $('c-actions');
    if (d.status === 'help') {
      if (!actions.firstChild) {
        const b = document.createElement('button');
        b.className = 'primary'; b.textContent = 'Got it 👋';
        b.onclick = () => on.ack(cardId);
        actions.append(b);
      }
    } else actions.replaceChildren();
  }

  // ── camp board ──
  const board = document.createElement('div');
  board.className = 'board';
  board.innerHTML = '<h4>🏕 Camp <span></span><button class="week" title="Weekly recap">📒 Week</button></h4><ul></ul>';
  board.addEventListener('click', (e) => {
    if (e.target.closest('.week')) { on.recap(); return; }
    const li = e.target.closest('li'); if (li) on.focus(li.dataset.id);
  });
  board.addEventListener('pointerdown', (e) => e.stopPropagation());
  let boardKey = '';
  function renderBoard(sessions) {
    const resting = sessions.filter((s) => (s.status === 'done' || s.status === 'idle') && !s.cowork)
      .sort((a, b) => (a.status === b.status ? b.since - a.since : a.status === 'done' ? -1 : 1));
    const key = resting.map((s) => s.id + s.status + (s.task || s.title) + Math.floor((Date.now() - s.since) / SLEEP_MS)).join('|');
    if (key === boardKey) return resting.length;
    boardKey = key;
    board.querySelector('h4 span').textContent = resting.length ? `${resting.length} resting` : 'empty';
    board.querySelector('ul').innerHTML = resting.map((s) => {
      const napping = Date.now() - s.since > SLEEP_MS;
      const color = napping ? '#b9b3cc' : STATUS_COLOR[s.status];
      const note = (s.status === 'done' && !napping ? '✓ ' : napping ? '💤 ' : '') + (s.task || s.title || 'no task yet');
      return `<li data-id="${esc(s.id)}"><i style="background:${color}"></i><b>${esc(s.name || s.project)}</b><small>${esc(note)}</small></li>`;
    }).join('');
    return resting.length;
  }

  // ── status → island/pill ──
  let lastHelp = new Set();
  let lastDone = new Set();
  let flashTimer = 0;
  function update(sessions, accentOf, { fresh = false } = {}) {
    const help = sessions.filter((s) => s.status === 'help');
    const working = sessions.filter((s) => s.status === 'working');
    const done = sessions.filter((s) => s.status === 'done');
    const helpIds = new Set(help.map((s) => s.id));
    const newHelp = fresh ? [] : help.filter((s) => !lastHelp.has(s.id));
    const newDone = fresh ? [] : done.filter((s) => !lastDone.has(s.id));
    lastHelp = helpIds;
    lastDone = new Set(done.map((s) => s.id));

    alert = help.length > 0;
    $('badge').hidden = !alert;
    $('badge').textContent = help.length;
    $('dots').innerHTML = alert ? '' : working.slice(0, 3).map((s) => `<i style="background:${accentOf(s.id)}"></i>`).join('');
    // the ear beside the notch is ~85px of text: keep it to the one thing that matters most
    // compact: the ear beside the notch has ~85px; tap it for the full busy list
    $('counts').innerHTML = help.length
      ? `<b class="hot">${help.length}</b> 👋 · <b>${working.length}</b> busy`
      : `<b>${working.length}</b> busy · <b>${sessions.length}</b> crew`;
    $('counts').title = `${help.length} need you · ${working.length} busy · ${sessions.length} crew`;
    $('pill').classList.toggle('alert', alert);
    $('pill-text').textContent = help.length ? `${help.length} need${help.length === 1 ? 's' : ''} you` : `${sessions.length} crew · ${working.length} busy`;
    document.title = help.length ? `(${help.length}) Bot Planet` : 'Bot Planet';

    if (newHelp.length) {
      SFX.help();
      if (state !== 'open' && notch) {
        const s = newHelp[0];
        $('peek').dataset.id = s.id;
        $('peek-who').textContent = s.name || s.project;
        $('peek-what').textContent = s.message || 'needs your attention';
        setState('peek');
        clearTimeout(peekTimer);
        peekTimer = setTimeout(() => { if (state === 'peek') setState('collapsed'); }, 6000);
      }
    }
    if (newDone.length) {
      SFX.chime();
      island.classList.add('flash-done');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => island.classList.remove('flash-done'), 2600);
    }
    apply();
    if (cardId) { const d = sessions.find((s) => s.id === cardId); if (d) fillCard(d, accentOf(d.id)); }
    return { help, newHelp };
  }

  // ── live ticker: the collapsed notch briefly widens to say what someone just started ──
  let lastTick = 0, tickTimer = 0;
  let tickerOn = opts.ticker !== false;
  bridge?.onPrefs?.((p) => { if (p.ticker !== undefined) tickerOn = !!p.ticker; });
  function ticker(s, emoji, accent) {
    if (!notch || !tickerOn || state !== 'collapsed' || alert || document.hidden) return;
    const now = Date.now();
    if (now - lastTick < 7000) return;
    lastTick = now;
    $('tick-name').textContent = s.name || s.project;
    $('tick-name').style.color = accent;
    $('tick-what').textContent = `${emoji} ${s.detail}`;
    ticking = true;
    apply();
    clearTimeout(tickTimer);
    tickTimer = setTimeout(() => { ticking = false; apply(); }, 3400);
  }

  // ── logbook sheet ──
  const log = $('log');
  $('log-close').onclick = () => closeLog();
  log.addEventListener('click', (e) => {
    if (e.target.closest('[data-postcard]')) on.postcard?.();
    const row = e.target.closest('[data-agent]');
    if (row) on.focus(row.dataset.agent);
  });
  $('counts').addEventListener('click', (e) => { e.stopPropagation(); on.busy?.(); });
  // small toast at the bottom of the panel
  let toastTimer = 0;
  function toast(msg) {
    let t = $('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; (notch ? $('panel') : document.body).append(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }
  function openLog(html) {
    $('log-body').innerHTML = html;
    log.classList.add('open');
    body.classList.add('carded');
  }
  function closeLog() { log.classList.remove('open'); if (!cardId) body.classList.remove('carded'); }
  // one shared tooltip for anything with data-tip (logbook bars and ranks)
  const tip = $('tip');
  addEventListener('pointerover', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    const r = t.getBoundingClientRect();
    tip.textContent = t.dataset.tip;
    tip.hidden = false;
    // keep it inside the window (it's centred on the bar via translateX(-50%))
    const half = tip.offsetWidth / 2, pad = 6;
    tip.style.left = `${Math.min(innerWidth - half - pad, Math.max(half + pad, r.left + r.width / 2))}px`;
    tip.style.top = `${r.top}px`;
  });

  apply();
  return {
    openLog, closeLog, toast,
    ticker,
    get state() { return state; },
    get pointer() { return pointer; },
    board, renderBoard, update, sfx: (k) => SFX[k]?.(),
    open() { setState('open'); },
    openCard(d, accent) {
      closeLog();
      cardId = d.id;
      endEdit(false);
      fillCard(d, accent);
      card.classList.add('open');
      body.classList.add('carded');
    },
    refreshCard(d, accent) { if (cardId === d?.id) fillCard(d, accent); },
    closeCard() { endEdit(false); cardId = null; card.classList.remove('open'); body.classList.remove('carded'); },
    isUI: (el) => !!el?.closest?.('#card, .board, #row, #peek, #pill'),
  };
}
