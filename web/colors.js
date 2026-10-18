// One colour per project, everywhere: its continent, suits, roofs, logbook dots.
// The 8 hues are the dataviz reference palette's dark steps (validated: adjacent CVD ΔE ≥ 8.4,
// normal-vision ΔE ≥ 19.3 against a dark surface). Colour is never the only cue: continents also
// carry their name label and their own vegetation.
// Assignment is sticky (follows the project, never its rank) and saved per viewer.

export const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
// What grows on each colour's continent (secondary encoding)
export const BIOMES = ['snowpine', 'autumn', 'palm', 'sunflower', 'blossom', 'pine', 'lavender', 'maple'];

const KEY = 'bp-continent-colors';
const norm = (name) => String(name || '').trim().toLowerCase();
let map = {};
try { map = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { map = {}; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(map)); } catch {} };

/**
 * Give colours to projects. `names` should be sorted biggest-first so the first eight projects you
 * ever see get colours. Projects that no longer exist release their colour.
 */
export function assignColors(names) {
  const wanted = new Set(names.map(norm).filter(Boolean));
  let changed = false;
  for (const k of Object.keys(map)) if (!wanted.has(k)) { delete map[k]; changed = true; }
  // a custom colour reserves its slot: auto-assigned projects steer clear of it where they can
  const reserved = new Set(Object.keys(custom).filter((k) => wanted.has(k)).map((k) => customSlot(k)).filter((i) => i >= 0));
  // projects with their own colour don't hold a sticky slot; a sticky slot someone chose gets freed
  for (const k of Object.keys(map)) if (customSlot(k) >= 0 || reserved.has(map[k])) { delete map[k]; changed = true; }
  const used = new Set([...Object.values(map), ...reserved]);
  for (const n of names.map(norm)) {
    if (!n || n in map || customSlot(n) >= 0) continue;
    const free = PALETTE.findIndex((_, i) => !used.has(i));
    if (free < 0) break; // more than 8 projects: the rest stay on neutral "wild lands"
    map[n] = free; used.add(free); changed = true;
  }
  if (changed) save();
  return changed;
}

// Custom looks from the crew manager (server `custom`, keyed by nameKey): a chosen colour wins over the
// sticky assignment. Only palette hexes count, so continents stay distinguishable.
let custom = {};
/** custom: Record<nameKey, { color?, hat?, theme?, spot?, hidden? }>. Returns true when anything changed. */
export function setCustom(next) {
  const c = next && typeof next === 'object' ? next : {};
  const changed = JSON.stringify(c) !== JSON.stringify(custom);
  custom = c;
  return changed;
}
/** The custom entry for a project name (or {}). Hats, themes, spots and hidden flags read this too. */
export const customFor = (name) => custom[norm(name)] || {};
const customSlot = (name) => {
  const c = custom[norm(name)]?.color;
  return c ? PALETTE.indexOf(String(c).toLowerCase()) : -1;
};

/** Palette slot: the custom colour first, then the sticky assignment, else -1. */
export const slotFor = (name) => { const c = customSlot(name); return c >= 0 ? c : norm(name) in map ? map[norm(name)] : -1; };
export const colorFor = (name) => { const s = slotFor(name); return s >= 0 ? PALETTE[s] : null; };
export const biomeFor = (name) => { const s = slotFor(name); return s >= 0 ? BIOMES[s] : null; };
