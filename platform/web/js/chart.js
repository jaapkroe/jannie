// The course of a match as a line chart (docs/frontend.md#the-score-chart):
// a line per player or side of its score after every round, a limit as a
// dashed line, open rings at the rounds a game marks. A crosshair and a
// tooltip follow the pointer (or the arrow keys); the game's table of
// rounds beside it is the chart's table view. The game gives the data and
// every word (a spec, below); this module knows no game. Inline SVG, no
// libraries, no inline styles (the CSP): the shapes' colours are set from
// JS, the rest is in app.css (.chart). Imported when first needed: by
// the first chartBox (util.js) to get a spec, or by a module loaded on
// demand that uses its colours (toepen's score.js).
import { h } from './util.js';

// The categorical slots, in their fixed order, stepped for the dark chart
// surfaces (--panel-solid: toepen's #0f2433, klaverjas's #10261f): checked
// for colour-blind separation, the normal-vision floor and 3:1 contrast
// on both. A game gives line k slot k, unless it has colours of its own.
export const COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const SURFACE = 'var(--panel-solid)';

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}
const paint = (el, stroke, fill) => {
  if (stroke) el.style.stroke = stroke;
  if (fill) el.style.fill = fill;
  return el;
};
const text = str => document.createTextNode(str);

// The grid's step: 1, 2 or 5 times a power of ten, at most five steps
// over the range.
function gridStep(range) {
  for (let p = 1; ; p *= 10) {
    for (const m of [1, 2, 5]) if (range / (m * p) <= 5) return m * p;
  }
}

// The chart of spec, width px wide. Returns its element (legend, svg and
// tooltip); null before the first round. spec:
//   names     the lines, in the legend's order
//   colors    per line its CSS colour (default: COLORS in order)
//   pts       pts[i][k]: line k's score after i rounds (pts[0]: before the first)
//   ends      per line the last i it reaches, as for a player out of the match (default: all)
//   out       per line: greyed in the legend (out of the match)
//   limit     {value, label}: a dashed line across
//   rings     per line the rounds i (1 or more) that get an open ring; ringLabel names them in the legend
//   tips      per i, 0 to the last: {title, rows: [{k, note, value, out}]}, the tooltip, rows in its order
//   label     the svg's aria-label
export function chart(spec, width) {
  const { names, pts, tips = [] } = spec;
  const n = names.length;
  const N = pts.length - 1;
  if (N < 1 || !n) return null;
  const color = k => spec.colors?.[k] || COLORS[k % COLORS.length];
  const ends = names.map((_, k) => Math.min(N, spec.ends?.[k] ?? N));
  const rings = names.map((_, k) => (spec.rings?.[k] || []).filter(i => i >= 1 && i <= ends[k]));
  const limit = spec.limit;
  const all = pts.flat();
  const yMin = Math.min(0, ...all);
  const yMax = Math.max(limit ? limit.value : 0, ...all);
  const step = gridStep(yMax - yMin || 1);
  const ticks = [];
  for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) ticks.push(v);

  const labelled = n <= 4; // direct labels at the line ends
  const W = Math.max(260, Math.round(width));
  const H = Math.round(Math.min(280, Math.max(190, W * 0.56)));
  const widest = Math.max(...ticks.map(v => String(v).length));
  const m = { l: Math.max(30, 10 + 7 * widest), r: labelled ? 76 : 14, t: 14, b: 26 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const x = i => m.l + (i / N) * pw;
  const y = v => m.t + ((yMax - v) / (yMax - yMin || 1)) * ph;
  // Equal lines lie side by side, a ribbon, instead of hiding each other.
  const dodge = k => (k - (n - 1) / 2) * 1.5;

  const svg = s('svg', {
    class: 'chart-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, tabindex: 0, role: 'img', 'aria-label': spec.label || '',
  });

  // Grid and axes: recessive.
  const grid = s('g', { class: 'chart-grid' });
  for (const v of ticks) {
    grid.append(s('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }),
      s('text', { class: 'chart-tick', x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, text(String(v))));
  }
  const every = [1, 2, 5, 10, 20, 50, 100].find(e => (pw / N) * e >= 26) || 100;
  for (let i = 0; i <= N; i += every) {
    grid.append(s('text', { class: 'chart-tick', x: x(i), y: H - 8, 'text-anchor': 'middle' }, text(String(i))));
  }
  svg.append(grid);

  if (limit) {
    svg.append(s('line', { class: 'chart-limit', x1: m.l, x2: W - m.r, y1: y(limit.value), y2: y(limit.value) }),
      s('text', { class: 'chart-limit-lbl', x: m.l + 4, y: y(limit.value) - 5 }, text(limit.label || '')));
  }

  // The lines, a dot at each line's end, and the rings, over the dot where
  // a ring falls on the last round.
  const lines = s('g', { class: 'chart-lines' });
  for (let k = 0; k < n; k++) {
    const d = pts.slice(0, ends[k] + 1).map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${(y(p[k]) + dodge(k)).toFixed(1)}`).join('');
    lines.append(paint(s('path', { class: 'chart-line', d }), color(k)));
  }
  for (let k = 0; k < n; k++) {
    const e = ends[k];
    lines.append(paint(s('circle', { class: 'chart-end', cx: x(e), cy: y(pts[e][k]) + dodge(k), r: 4.5 }), SURFACE, color(k)));
  }
  for (let k = 0; k < n; k++) {
    for (const i of rings[k]) {
      lines.append(paint(s('circle', { class: 'chart-ring', cx: x(i), cy: y(pts[i][k]) + dodge(k), r: 4.5 }), color(k), SURFACE));
    }
  }
  svg.append(lines);

  // Direct labels for up to four lines, pushed apart where they meet.
  if (labelled) {
    const labels = names.map((name, k) => ({ k, name, at: y(pts[ends[k]][k]) + dodge(k), x: x(ends[k]) }))
      .sort((a, b) => a.at - b.at);
    for (let j = 1; j < labels.length; j++) labels[j].at = Math.max(labels[j].at, labels[j - 1].at + 14);
    const over = labels.length ? labels.at(-1).at - (H - m.b) : 0;
    if (over > 0) for (const l of labels) l.at -= over;
    const g = s('g', { class: 'chart-labels' });
    for (const l of labels) g.append(s('text', { class: 'chart-label', x: l.x + 8, y: l.at + 4 }, text(short(l.name))));
    svg.append(g);
  }

  // The hover layer: a crosshair at the nearest round, a dot per line.
  const hair = s('line', { class: 'chart-hair', y1: m.t, y2: H - m.b, visibility: 'hidden' });
  const dots = names.map((_, k) => paint(s('circle', { class: 'chart-dot', r: 4.5, visibility: 'hidden' }), SURFACE, color(k)));
  svg.append(hair, ...dots);
  const hit = s('rect', { class: 'chart-hit', x: m.l - 10, y: 0, width: pw + 20, height: H, fill: 'transparent' });
  svg.append(hit);

  const tip = h('div', { class: 'chart-tip', hidden: true, role: 'status' });
  const legend = h('div', { class: 'chart-legend' }, names.map((name, k) => h('span', { class: 'chart-key' + (spec.out?.[k] ? ' out' : '') },
    swatch(color(k)), h('span', { text: name }))),
  rings.some(r => r.length) && spec.ringLabel ? h('span', { class: 'chart-key chart-key-ring' }, h('i', { class: 'chart-ring-key', 'aria-hidden': 'true' }),
    h('span', { text: spec.ringLabel })) : null);
  const box = h('div', { class: 'chart-plot' }, svg, tip);
  const root = h('div', { class: 'chart' }, legend, box);

  let at = -1;
  const show = i => {
    i = Math.max(0, Math.min(N, i));
    at = i;
    hair.setAttribute('x1', x(i));
    hair.setAttribute('x2', x(i));
    hair.setAttribute('visibility', 'visible');
    dots.forEach((dot, k) => {
      dot.setAttribute('cx', x(i));
      dot.setAttribute('cy', y(pts[i][k]) + dodge(k));
      dot.setAttribute('visibility', i <= ends[k] ? 'visible' : 'hidden');
    });
    const t = tips[i] || { title: '', rows: [] };
    // The values' column is as wide as the widest value here.
    tip.style.setProperty('--chart-digits', String(Math.max(0, ...t.rows.map(r => (r.out ? 0 : String(r.value).length)))));
    tip.replaceChildren(h('b', { class: 'chart-tip-h', text: t.title }),
      ...t.rows.map(r => h('div', { class: 'chart-tip-row' + (r.out ? ' out' : '') }, swatch(color(r.k)), h('span', { class: 'chart-tip-name', text: names[r.k] }),
        h('small', { text: r.out ? '' : r.note || '' }), h('b', { text: String(r.value) }))));
    tip.hidden = false;
    // In the top corner away from the crosshair.
    tip.classList.toggle('left', x(i) > m.l + pw / 2);
  };
  const hide = () => {
    at = -1;
    hair.setAttribute('visibility', 'hidden');
    dots.forEach(d => d.setAttribute('visibility', 'hidden'));
    tip.hidden = true;
  };
  const fromEvent = e => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    return Math.round(((px - m.l) / pw) * N);
  };
  hit.addEventListener('pointermove', e => show(fromEvent(e)));
  hit.addEventListener('pointerdown', e => show(fromEvent(e)));
  hit.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide(); });
  svg.addEventListener('blur', hide);
  // The arrows step from the round shown (from none: right to the first,
  // left to the last); Home and End go to the first and the last.
  svg.addEventListener('keydown', e => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    const to = { Home: 0, End: N }[e.key] ?? (step == null ? null : at < 0 ? (step > 0 ? 0 : N) : at + step);
    if (to == null) { if (e.key === 'Escape' && at >= 0) { hide(); e.stopPropagation(); } return; }
    e.preventDefault();
    show(to);
  });
  return root;
}

// A line's colour as a small mark beside a name (legend, tooltip, a
// game's own lists): the colour is the identity, the name stays in ink.
export function swatch(color) {
  const el = h('i', { class: 'chart-sw', 'aria-hidden': 'true' });
  el.style.setProperty('--c', color);
  return el;
}

const short = name => (name.length > 9 ? name.slice(0, 8) + '…' : name);
