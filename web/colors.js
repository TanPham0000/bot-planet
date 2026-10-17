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
  const used = new Set(Object.values(map));
  for (const n of names.map(norm)) {
    if (!n || n in map) continue;
    const free = PALETTE.findIndex((_, i) => !used.has(i));
    if (free < 0) break; // more than 8 projects: the rest stay on neutral "wild lands"
    map[n] = free; used.add(free); changed = true;
  }
  if (changed) save();
  return changed;
}

export const slotFor = (name) => (norm(name) in map ? map[norm(name)] : -1);
export const colorFor = (name) => { const s = slotFor(name); return s >= 0 ? PALETTE[s] : null; };
export const biomeFor = (name) => { const s = slotFor(name); return s >= 0 ? BIOMES[s] : null; };
