// The course of a score sheet as a line chart (score.js): every player's
// penalty points after each round, the limit as a dashed line, the rounds
// in which a lijntoeper went away again as open rings. A crosshair and a
// tooltip follow the pointer (or the arrow keys); the rounds table beside
// it is the chart's table view. Inline SVG, no libraries, no inline styles
// (the CSP): colours are attributes, the rest is in toepen.css (.sc-chart).
import { h } from './util.js';
import { course, streaks, LIJN } from './scorecalc.js';

// The categorical slots, in their fixed order, stepped for the dark chart
// surface (--panel-solid, #0f2433): checked for colour-blind separation,
// the normal-vision floor and 3:1 contrast on it. Player k keeps slot k.
export const COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const SURFACE = '#0f2433';

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

const roundWord = i => (i ? `Na potje ${i}` : 'Begin');

// The chart of sheet, width px wide. Returns its element (legend, svg and
// tooltip); null before the first round.
export function chart(sheet, width) {
  const n = sheet.names.length;
  const rounds = sheet.rounds || [];
  const N = rounds.length;
  if (!N || !n) return null;
  const pts = course(sheet);
  const runs = streaks(sheet);
  const limit = sheet.limit;
  // Where a line ends: the round its player reached the limit, else the last.
  const ends = sheet.names.map((_, k) => {
    const i = pts.findIndex(p => p[k] >= limit);
    return i < 0 ? N : i;
  });
  const all = pts.flat();
  const yMin = Math.min(0, ...all);
  const yMax = Math.max(limit, ...all);

  const labelled = n <= 4; // direct labels at the line ends
  const W = Math.max(260, Math.round(width));
  const H = Math.round(Math.min(280, Math.max(190, W * 0.56)));
  const m = { l: 30, r: labelled ? 76 : 14, t: 14, b: 26 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const x = i => m.l + (N ? (i / N) * pw : 0);
  const y = v => m.t + ((yMax - v) / (yMax - yMin || 1)) * ph;
  // Equal lines lie side by side, a ribbon, instead of hiding each other.
  const dodge = k => (k - (n - 1) / 2) * 1.5;

  const svg = s('svg', {
    class: 'sc-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, tabindex: 0, role: 'img',
    'aria-label': `Grafiek van de strafpunten na elk potje, ${N} ${N === 1 ? 'potje' : 'potjes'}. De tabel eronder heeft dezelfde cijfers.`,
  });

  // Grid and axes: recessive.
  const step = yMax - yMin > 24 ? 10 : yMax - yMin > 10 ? 5 : 2;
  const grid = s('g', { class: 'sc-grid' });
  for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) {
    grid.append(s('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }),
      s('text', { class: 'sc-tick', x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, document.createTextNode(String(v))));
  }
  const every = [1, 2, 5, 10, 20, 50, 100].find(e => (pw / N) * e >= 26) || 100;
  for (let i = 0; i <= N; i += every) {
    grid.append(s('text', { class: 'sc-tick', x: x(i), y: H - 8, 'text-anchor': 'middle' }, document.createTextNode(String(i))));
  }
  svg.append(grid);

  // The limit: whoever reaches it is out.
  svg.append(s('line', { class: 'sc-limit', x1: m.l, x2: W - m.r, y1: y(limit), y2: y(limit) }),
    s('text', { class: 'sc-limit-lbl', x: m.l + 4, y: y(limit) - 5 }, document.createTextNode(`eruit bij ${limit}`)));

  // The lines, the rings of a lijntoep, and a dot at each line's end.
  const lines = s('g', { class: 'sc-lines' });
  for (let k = 0; k < n; k++) {
    const c = COLORS[k % COLORS.length];
    const d = pts.slice(0, ends[k] + 1).map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${(y(p[k]) + dodge(k)).toFixed(1)}`).join('');
    lines.append(s('path', { class: 'sc-line', d, stroke: c }));
  }
  for (let k = 0; k < n; k++) {
    const c = COLORS[k % COLORS.length];
    for (let i = 0; i < Math.min(N, ends[k]); i++) {
      if (runs[i][k] >= LIJN) {
        lines.append(s('circle', { class: 'sc-ring', cx: x(i + 1), cy: y(pts[i + 1][k]) + dodge(k), r: 4.5, stroke: c, fill: SURFACE }));
      }
    }
    const e = ends[k];
    lines.append(s('circle', { class: 'sc-end', cx: x(e), cy: y(pts[e][k]) + dodge(k), r: 4.5, fill: c, stroke: SURFACE }));
  }
  svg.append(lines);

  // Direct labels for up to four players, pushed apart where they meet.
  if (labelled) {
    const labels = sheet.names.map((name, k) => ({ k, name, at: y(pts[ends[k]][k]) + dodge(k), x: x(ends[k]) }))
      .sort((a, b) => a.at - b.at);
    for (let j = 1; j < labels.length; j++) labels[j].at = Math.max(labels[j].at, labels[j - 1].at + 14);
    const over = labels.length ? labels.at(-1).at - (H - m.b) : 0;
    if (over > 0) for (const l of labels) l.at -= over;
    const g = s('g', { class: 'sc-labels' });
    for (const l of labels) {
      g.append(s('text', { class: 'sc-name', x: l.x + 8, y: l.at + 4 }, document.createTextNode(short(l.name))));
    }
    svg.append(g);
  }

  // The hover layer: a crosshair at the nearest round, a dot per player.
  const hair = s('line', { class: 'sc-hair', y1: m.t, y2: H - m.b, visibility: 'hidden' });
  const dots = sheet.names.map((_, k) => s('circle', { class: 'sc-dot', r: 4.5, fill: COLORS[k % COLORS.length], stroke: SURFACE, visibility: 'hidden' }));
  svg.append(hair, ...dots);
  const hit = s('rect', { class: 'sc-hit', x: m.l - 10, y: 0, width: pw + 20, height: H, fill: 'transparent' });
  svg.append(hit);

  const tip = h('div', { class: 'sc-tip', hidden: true, role: 'status' });
  const legend = h('div', { class: 'sc-legend' }, sheet.names.map((name, k) => h('span', { class: 'sc-key' + (pts[N][k] >= limit ? ' out' : '') },
    swatch(k), h('span', { text: name }))),
  runs.some(r => r.some(c => c >= LIJN)) ? h('span', { class: 'sc-key sc-key-ring' }, h('i', { class: 'sc-ring-key', 'aria-hidden': 'true' }),
    h('span', { text: `${LIJN}× of vaker achter elkaar weg` })) : null);
  const box = h('div', { class: 'sc-plot' }, svg, tip);
  const root = h('div', { class: 'sc-chart' }, legend, box);

  let at = -1;
  const show = i => {
    i = Math.max(0, Math.min(N, i));
    at = i;
    hair.setAttribute('x1', x(i));
    hair.setAttribute('x2', x(i));
    hair.setAttribute('visibility', 'visible');
    dots.forEach((dot, k) => {
      const live = i <= ends[k];
      dot.setAttribute('cx', x(i));
      dot.setAttribute('cy', y(pts[i][k]) + dodge(k));
      dot.setAttribute('visibility', live ? 'visible' : 'hidden');
    });
    const r = i ? rounds[i - 1] : null;
    const order = sheet.names.map((name, k) => ({ k, name, p: pts[i][k] })).sort((a, b) => a.p - b.p || a.k - b.k);
    tip.replaceChildren(h('b', { class: 'sc-tip-h', text: roundWord(i) + (r?.stake ? ` · inzet ${r.stake}` : '') }),
      ...order.map(o => {
        const g = r?.gains?.[o.k] || 0;
        const note = !r ? '' : r.winner === o.k ? (g < 0 ? '🏆 −1' : '🏆') : r.passed?.[o.k] ? `weg${runs[i - 1][o.k] >= LIJN ? ` (${runs[i - 1][o.k]}×)` : ''}${g ? `, +${g}` : ''}` : g ? `+${g}` : '';
        const out = i > ends[o.k];
        return h('div', { class: 'sc-tip-row' + (out ? ' out' : '') }, swatch(o.k), h('span', { class: 'sc-tip-name', text: o.name }),
          h('small', { text: out ? '' : note }), h('b', { text: out ? 'eruit' : String(o.p) }));
      }));
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
  svg.addEventListener('keydown', e => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: -N, End: N }[e.key];
    if (step == null) { if (e.key === 'Escape' && at >= 0) { hide(); e.stopPropagation(); } return; }
    e.preventDefault();
    show(at < 0 ? (step > 0 ? 0 : N) : at + step);
  });
  root.hide = hide;
  return root;
}

// A player's colour as a small mark beside the name (legend, tooltip,
// standings): the colour is the identity, the name stays in ink.
export function swatch(k) {
  const el = h('i', { class: 'sc-sw', 'aria-hidden': 'true' });
  el.style.setProperty('--c', COLORS[k % COLORS.length]);
  return el;
}

const short = name => (name.length > 9 ? name.slice(0, 8) + '…' : name);
