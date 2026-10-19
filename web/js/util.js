// Shared helpers: app context, DOM building, icons, storage, preferences,
// toasts, motion timing and seat geometry.
import { SUITS } from './cards.js';

// Mutable application context shared by all modules (filled by main.js).
export const app = {
  s: null,        // last rendered server state
  code: '',       // room code we are in (or joining)
  ff: false,      // fast-forward: skip animations while the queue catches up
  hurry: false,   // a few updates are waiting: animate faster
  send: () => false,
  leave: () => {},
};

// ---------- DOM ----------

// h('button', {class:'btn', text:'Ok', onclick}, child, ...)
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k.startsWith('aria-') || k.startsWith('data-') || k === 'role' || k === 'for') el.setAttribute(k, v === true ? 'true' : String(v));
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  add(el, kids);
  return el;
}

function add(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) add(el, k);
    else el.append(k instanceof Node ? k : String(k));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

// Stroke icons on a 24×24 grid, built as SVG elements (CSP-safe).
const ICONS = {
  history: ['M3.5 12a8.5 8.5 0 1 0 2.5-6', 'M3.5 4.5V9H8', 'M12 8v4.2l3 1.8'],
  score: ['M7 4h10a2 2 0 0 1 2 2v14H5V6a2 2 0 0 1 2-2z', 'M9 9h6', 'M9 13h6', 'M9 17h3'],
  chat: ['M20.5 11.5a8 8 0 0 1-11.7 7.1L4 20l1.3-4.4A8 8 0 1 1 20.5 11.5z'],
  help: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9.6 9.3a2.5 2.5 0 1 1 3.6 2.3c-.7.4-1.2.9-1.2 1.7v.4', 'M12 17h.01'],
  settings: ['M4 7h8', 'M18 7h2', 'M15 4.5v5', 'M4 17h2', 'M12 17h8', 'M9 14.5v5'],
  soundOn: ['M11 5 6.5 9H3.5v6h3L11 19z', 'M15.5 9a4.5 4.5 0 0 1 0 6', 'M18.5 6a8.5 8.5 0 0 1 0 12'],
  soundOff: ['M11 5 6.5 9H3.5v6h3L11 19z', 'M16 9.5l5 5', 'M21 9.5l-5 5'],
  menu: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  copy: ['M9 9h10v11H9z', 'M5 15V4h10'],
  share: ['M12 3v12', 'M8 7l4-4 4 4', 'M5 12v7a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-7'],
  back: ['M15 18l-6-6 6-6'],
  plus: ['M12 5v14', 'M5 12h14'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 7.8h.01'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  send: ['M4 12 20 4l-4 16-4-7z', 'M12 13l8-9'],
  leave: ['M14 4h5v16h-5', 'M10 8l-4 4 4 4', 'M6 12h10'],
  bot: ['M7 8h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3z', 'M12 4v4', 'M9 13h.01', 'M15 13h.01'],
  play: ['M8 5v14l11-7z'],
  shuffle: ['M4 17h3l9-10h4', 'M17 4l3 3-3 3', 'M4 7h3l2.5 2.8', 'M13.5 14.2 16 17h4', 'M17 14l3 3-3 3'],
  school: ['M2.5 9 12 4.5 21.5 9 12 13.5z', 'M6.5 11v5c1.5 1.5 3.4 2.2 5.5 2.2s4-.7 5.5-2.2v-5', 'M21.5 9v5.5'],
  book: ['M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z', 'M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5'],
  users: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M2.5 20a6.5 6.5 0 0 1 13 0', 'M16 4.3a3.5 3.5 0 0 1 0 6.4', 'M18 14a6.5 6.5 0 0 1 3.5 6'],
  enter: ['M10 4h9v16h-9', 'M3 12h11', 'M10 8l4 4-4 4'],
  bolt: ['M13 2 4 14h7l-1 8 9-12h-7z'],
};

export function icon(name, cls = '') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
  for (const d of ICONS[name] || []) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

// ---------- storage (all keys prefixed kj.) ----------

export const store = {
  get(key, def = null) {
    try { const v = localStorage.getItem('kj.' + key); return v == null ? def : v; } catch { return def; }
  },
  set(key, val) {
    try { localStorage.setItem('kj.' + key, String(val)); } catch { /* storage unavailable */ }
  },
  del(key) {
    try { localStorage.removeItem('kj.' + key); } catch { /* storage unavailable */ }
  },
  json(key, def) {
    try { const v = JSON.parse(store.get(key, 'null')); return v ?? def; } catch { return def; }
  },
  setJSON(key, val) { store.set(key, JSON.stringify(val)); },
};

const coarse = matchMedia('(pointer: coarse)').matches;

// Per-device preferences (kj.prefs).
export const prefs = Object.assign(
  { fourColor: false, tap: coarse ? 'two' : 'one', reduced: false, tab: 'bediening' },
  store.json('prefs', {}),
);
export function savePrefs() { store.setJSON('prefs', prefs); }

// ---------- toasts ----------

let toastRoot;
export function toast(text, { sub = '', kind = '', ms = 2800 } = {}) {
  toastRoot ??= document.getElementById('toasts');
  if (!toastRoot) return;
  const same = [...toastRoot.children].find(t => t.dataset.text === text + '|' + sub);
  if (same) {
    clearTimeout(same.timer);
    same.timer = setTimeout(() => dismiss(same), ms);
    return;
  }
  const el = h('div', { class: 'toast' + (kind ? ' toast-' + kind : ''), role: 'status', dataset: { text: text + '|' + sub } },
    h('div', { class: 'toast-main' }, suitify(text)), sub ? h('div', { class: 'toast-sub' }, suitify(sub)) : null);
  toastRoot.append(el);
  while (toastRoot.children.length > 3) toastRoot.firstChild.remove();
  requestAnimationFrame(() => el.classList.add('show'));
  el.timer = setTimeout(() => dismiss(el), ms);
}

function dismiss(el) {
  el.classList.remove('show');
  setTimeout(() => el.remove(), 300);
}

// ---------- motion ----------

export const EASE = 'cubic-bezier(.2,.8,.2,1)';
const reducedMQ = matchMedia('(prefers-reduced-motion: reduce)');

// Multiplier for every animation: 0 skips, 0.35 for "minder animaties".
export function motion() {
  if (app.ff || document.hidden) return 0;
  return (prefs.reduced || reducedMQ.matches ? 0.35 : 1) * (app.hurry ? 0.55 : 1);
}
export const dur = ms => Math.round(ms * motion());
export function wait(ms) {
  const d = dur(ms);
  return d > 0 ? new Promise(r => setTimeout(r, d)) : Promise.resolve();
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Runs el.animate unless motion is off; always resolves.
export function anim(el, frames, ms, opts = {}) {
  const d = dur(ms);
  if (!d || !el.animate) return Promise.resolve();
  const a = el.animate(frames, { duration: d, easing: EASE, ...opts, delay: opts.delay ? dur(opts.delay) : 0 });
  return a.finished.catch(() => {});
}

export function vibrate(ms) {
  try { navigator.vibrate?.(ms); } catch { /* not supported */ }
}

// ---------- game helpers ----------

export const POS = ['bottom', 'left', 'top', 'right'];
export const posOf = (seat, you) => POS[(seat - you + 4) % 4];
export const myTeam = s => s.you % 2;
export const isWij = (s, seat) => seat % 2 === s.you % 2;
export const teamCls = (s, seat) => (isWij(s, seat) ? 'wij' : 'zij');
export const teamName = (s, team) => (team === s.you % 2 ? 'Wij' : 'Zij');

// Display name; "Jij" for yourself when `jij` is set.
export function nameOf(s, seat, jij = true) {
  if (seat == null || seat < 0) return '';
  if (jij && seat === s.you) return 'Jij';
  return s.players?.[seat]?.name || 'Speler';
}

export const suitSym = c => SUITS[c]?.symbol ?? '';
export const suitName = c => SUITS[c]?.name ?? '';
export const suitText = c => `${suitSym(c)} ${suitName(c)}`;
export const isRed = c => SUITS[c]?.color === 'red';

// Text with its suit symbols wrapped for colouring (built safely, no HTML).
const SUIT_OF = { '♣': 'C', '♦': 'D', '♥': 'H', '♠': 'S' };
export function suitify(text) {
  const frag = document.createDocumentFragment();
  for (const part of String(text).split(/([♣♦♥♠])/)) {
    if (!part) continue;
    const suit = SUIT_OF[part];
    frag.append(suit ? h('span', { class: 'ss' + (isRed(suit) ? ' red' : ''), dataset: { suit }, text: part }) : part);
  }
  return frag;
}

export const ROEM_NAMES = { drie: 'Driekaart', vier: 'Vierkaart', stuk: 'Stuk', vierGelijk: 'Vier gelijke', vierBoeren: 'Vier boeren' };
export const roemTotal = roem => (roem || []).reduce((n, r) => n + (r.points || 0), 0);
export const roemText = roem => (roem || []).map(r => `${ROEM_NAMES[r.kind] || r.kind} ${r.points}`).join(', ');

export const variantText = o =>
  `${o.trumpMode === 'gedraaid' ? 'Gedraaid' : 'Utrechts'}/${o.rules === 'rotterdams' ? 'Rotterdams' : 'Amsterdams'}`;

// Avatar circle for a player: emoji for bots, initial for humans.
export function avatar(p, cls = '') {
  const el = h('span', { class: 'avatar ' + cls });
  fillAvatar(el, p);
  return el;
}
export function fillAvatar(el, p) {
  const face = p?.bot ? (p.emoji || '🤖') : (p?.name || '?').trim().charAt(0).toUpperCase() || '?';
  if (el.dataset.face !== face) {
    el.dataset.face = face;
    el.textContent = face;
  }
  el.classList.toggle('is-bot', !!p?.bot);
  el.style.setProperty('--persona', p?.bot && p.color ? p.color : '');
}

// Animated number count-up.
export function countUp(el, to, ms = 900) {
  const from = Number(el.dataset.n ?? el.textContent) || 0;
  el.dataset.n = to;
  const d = dur(ms);
  if (!d || from === to) { el.textContent = to; return; }
  const t0 = performance.now();
  const step = now => {
    const k = Math.min(1, (now - t0) / d);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(from + (to - from) * e);
    if (k < 1 && el.dataset.n == to) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { value: text, readOnly: true, class: 'offscreen' });
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}
