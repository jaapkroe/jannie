// platform/web/js/cards.js without a browser: node --test test/ui/cards-unit.test.mjs
// (a minimal stand-in DOM for the faces; cards-shot.mjs checks how they render).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SUITS, RANKS, parseCard, cardName, cardShort, createCard, createBack } from '../../platform/web/js/cards.js';

// Just enough DOM for the faces: namespace, attributes, classes, dataset,
// children and deep clones.
const XHTML = 'http://www.w3.org/1999/xhtml';
class FakeElement {
  constructor(tag, ns) {
    Object.assign(this, { tagName: tag, ns, attrs: {}, dataset: {}, children: [] });
    this.classList = { add: (...c) => { this.className = [this.className, ...c].join(' ').trim(); } };
  }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = v; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { this.children.push(c); return c; }
  cloneNode(deep) {
    const n = new FakeElement(this.tagName, this.ns);
    Object.assign(n.attrs, this.attrs);
    Object.assign(n.dataset, this.dataset);
    // Any other property set on it (textContent, say) comes along, as in a browser.
    for (const [k, v] of Object.entries(this)) if (!(k in n)) n[k] = v;
    if (deep) n.children = this.children.map(c => c.cloneNode(true));
    return n;
  }
}
globalThis.document = { createElement: tag => new FakeElement(tag, XHTML), createElementNS: (ns, tag) => new FakeElement(tag, ns) };

const ALL = Object.keys(SUITS).flatMap(s => Object.keys(RANKS).map(r => r + s));
const has = (el, cls) => el.className.split(' ').includes(cls);
// An element as HTML, its dataset as the data- attributes a browser would give it.
const attrsOf = el => [...Object.entries(el.attrs), ...Object.entries(el.dataset).map(([k, v]) => ['data-' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), v])];
const markup = el => `<${el.tagName}${attrsOf(el).map(([k, v]) => ` ${k}="${v}"`).join('')}>${el.children.map(markup).join('')}</${el.tagName}>`;
// The inner group of a face's top-left index (rank glyph, suit) and its rank glyph.
const indexOf = code => createCard(code).children[0].children.find(g => has(g, 'card-index')).children[0];
const glyph = code => indexOf(code).children[0];

// The points that bound a path of absolute M, L, H, V, C, S and Z: every end
// and control point, S's reflected one too, as a curve stays inside them.
function outline(d) {
  assert.match(d, /^M[MLHVCSZ\d. ]*$/, 'absolute commands only');
  const pts = [];
  let at = [0, 0], start = at, ctrl = null;
  for (const [, c, args] of d.matchAll(/([A-Z])([^A-Z]*)/g)) {
    const n = (args.match(/[\d.]+/g) || []).map(Number);
    const step = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Z: 0 }[c];
    if (!step) { at = start; ctrl = null; continue; }
    assert.equal(n.length % step, 0, `${c}${args}`);
    for (let i = 0; i < n.length; i += step) {
      const a = n.slice(i, i + step);
      if (c === 'C' || c === 'S') {
        pts.push(c === 'C' ? a.slice(0, 2) : ctrl ? [2 * at[0] - ctrl[0], 2 * at[1] - ctrl[1]] : at);
        pts.push(ctrl = a.slice(-4, -2));
      } else ctrl = null;
      at = c === 'H' ? [a[0], at[1]] : c === 'V' ? [at[0], a[0]] : a.slice(-2);
      if (c === 'M' && i === 0) start = at;
      pts.push(at);
    }
  }
  return pts;
}

// The markup (data- attributes included) of klaverjas's and toepen's 32 faces
// (ranks 7 to A) at every size and of both backs, as cards.js built them
// before the ranks 2 to 6 were added (commit d7d97be): a new rank or a new
// card game may add faces but never change these. The guard has its own
// serializer, which no other test shares and which nobody edits: an element
// in another namespace than its parent's says so (as XML would), and any
// other property set on an element shows. GOLDEN_32 may only be recomputed
// from `git show d7d97be:platform/web/js/cards.js`, never from the cards.js
// of the day.
const FACES_32 = [...'CDHS'].flatMap(s => [...'789TJQKA'].map(r => r + s));
const GOLDEN_32 = '2baceed46ab49a32dee5cc90a2a36065b90d18eed07cc4635adef8a8de682799';
const FAKE_OWN = new Set(['tagName', 'ns', 'attrs', 'dataset', 'children', 'classList']);
function goldenMarkup(el, parentNS = null) {
  const attrs = [
    ...(el.ns !== parentNS ? [['xmlns', el.ns]] : []),
    ...Object.entries(el.attrs),
    ...Object.entries(el.dataset).map(([k, v]) => ['data-' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), v]),
    ...Object.keys(el).filter(k => !FAKE_OWN.has(k)).map(k => ['.' + k, el[k]]),
  ];
  const kids = el.children.map(c => goldenMarkup(c, el.ns)).join('');
  return `<${el.tagName}${attrs.map(([k, v]) => ` ${k}="${v}"`).join('')}>${kids}</${el.tagName}>`;
}

test('the 32 faces of klaverjas and toepen and the backs keep their markup', () => {
  const parts = [];
  for (const code of FACES_32) {
    parts.push(goldenMarkup(createCard(code)));
    for (const size of ['sm', 'md', 'lg']) parts.push(goldenMarkup(createCard(code, { size })));
  }
  for (const color of ['blue', 'red']) {
    parts.push(goldenMarkup(createBack({ color })));
    for (const size of ['sm', 'md', 'lg']) parts.push(goldenMarkup(createBack({ color, size })));
  }
  assert.equal(createHash('sha256').update(parts.join('\n')).digest('hex'), GOLDEN_32);
});

test('SUITS and RANKS match the contract', () => {
  assert.deepEqual(Object.keys(SUITS).sort(), ['C', 'D', 'H', 'S']);
  assert.deepEqual(SUITS.C, { name: 'klaveren', symbol: '♣', color: 'black' });
  assert.deepEqual(SUITS.D, { name: 'ruiten', symbol: '♦', color: 'red' });
  assert.deepEqual(SUITS.H, { name: 'harten', symbol: '♥', color: 'red' });
  assert.deepEqual(SUITS.S, { name: 'schoppen', symbol: '♠', color: 'black' });
  assert.deepEqual({ ...RANKS }, { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', T: '10', J: 'B', Q: 'V', K: 'H', A: 'A' });
  // From low to high, for whoever lays them out in order.
  assert.deepEqual(Object.keys(RANKS), [...'23456789TJQKA']);
  assert.ok(Object.isFrozen(SUITS) && Object.isFrozen(SUITS.H) && Object.isFrozen(RANKS));
});

test('cardName gives the Dutch name', () => {
  assert.equal(cardName('JH'), 'harten boer');
  assert.equal(cardName('TS'), 'schoppen 10');
  assert.equal(cardName('QD'), 'ruiten vrouw');
  assert.equal(cardName('KC'), 'klaveren heer');
  assert.equal(cardName('AH'), 'harten aas');
  assert.equal(cardName('7C'), 'klaveren 7');
  assert.equal(cardName('2S'), 'schoppen 2');
  assert.equal(cardName('6D'), 'ruiten 6');
});

test('cardShort gives symbol and face letter', () => {
  assert.equal(cardShort('JH'), '♥B');
  assert.equal(cardShort('TS'), '♠10');
  assert.equal(cardShort('QD'), '♦V');
  assert.equal(cardShort('KC'), '♣H');
  assert.equal(cardShort('9H'), '♥9');
  assert.equal(cardShort('2H'), '♥2');
  assert.equal(cardShort('5C'), '♣5');
});

test('all 52 codes parse and have unique names', () => {
  const names = new Set();
  for (const s of Object.keys(SUITS)) {
    for (const r of Object.keys(RANKS)) {
      assert.deepEqual(parseCard(r + s), { rank: r, suit: s });
      names.add(cardName(r + s));
    }
  }
  assert.equal(names.size, 52);
  assert.deepEqual(parseCard('2H'), { rank: '2', suit: 'H' });
  const two = createCard('2H');
  assert.deepEqual({ ...two.dataset }, { card: '2H', suit: 'H', rank: '2' });
  assert.equal(two.getAttribute('aria-label'), 'harten 2');
});

test('anything else is rejected without throwing', () => {
  for (const bad of ['', 'J', 'JHX', 'jh', '1H', 'JX', 'HJ', null, undefined, 42, {}, 'constructorH', 'toString']) {
    assert.equal(parseCard(bad), null, String(bad));
    assert.equal(cardName(bad), '');
    assert.equal(cardShort(bad), '');
  }
});

test('every face is its picture with the index in both corners (no compact face)', () => {
  for (const code of ALL) {
    const svg = createCard(code).children[0];
    const art = code[0] === 'A' ? 'card-ace' : 'JQK'.includes(code[0]) ? 'card-court' : 'card-pips';
    // The picture, then the two indices over it; no second, compact face.
    assert.deepEqual(svg.children.map(g => g.className), [art, 'card-index', 'card-index'], code);
    const [, top, bottom] = svg.children;
    assert.equal(top.getAttribute('transform'), null, code);
    assert.equal(bottom.getAttribute('transform'), 'rotate(180 100 140)', code);
    // One inner group (what cards.css scales on narrow cards): rank glyph over suit.
    for (const idx of [top, bottom]) {
      assert.equal(idx.children.length, 1, code);
      const [rank, suit] = idx.children[0].children;
      assert.equal(rank.getAttribute('stroke'), 'currentColor', code);
      assert.equal(suit.getAttribute('fill'), 'currentColor', code);
    }
    const turned = top.cloneNode(true);
    turned.setAttribute('transform', 'rotate(180 100 140)');
    assert.equal(markup(bottom), markup(turned), code);
  }
});

test('the boer\'s B has a straight stem with square corners, so it never reads as an 8', () => {
  const b = glyph('JH');
  assert.equal(b.getAttribute('stroke-linejoin'), 'miter');
  const loops = b.getAttribute('d').split('M').slice(1);
  assert.equal(loops.length, 2);
  assert.ok(loops.every(l => l.endsWith('Z')), 'closed loops: no line ends to round off');
  assert.match(loops[0], /^1 47\.5V3H/, 'the upper loop starts up the stem at x = 1');
  assert.match(loops[1], /H1Z$/, 'the lower loop ends back on the stem');
  for (const code of ['2H', '3H', '4H', '5H', '6H', '7H', '8H', '9H', 'TH', 'QH', 'KH', 'AH']) assert.equal(glyph(code).getAttribute('stroke-linejoin'), 'round', code);
});

test('every rank has a glyph of its own in the box of the others, no wider than the 10', () => {
  const ranks = Object.keys(RANKS);
  const paths = new Set(ranks.map(r => glyph(r + 'S').getAttribute('d')));
  assert.equal(paths.size, ranks.length, 'two ranks share a glyph');
  // translate(left top) scale(s), the glyph centred over the index's suit:
  // its width in its own units is 2 (centre - left) / s.
  const box = el => el.getAttribute('transform').match(/^translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)$/).slice(1).map(Number);
  const width = code => {
    const [rank, suit] = indexOf(code).children;
    const [suitLeft, , suitScale] = box(suit);
    const [left, , s] = box(rank);
    return (2 * (suitLeft + 50 * suitScale - left)) / s;
  };
  for (const r of ranks) {
    const g = glyph(r + 'S');
    const [, top, scale] = box(g);
    assert.deepEqual([top, scale], [12, 0.54], r);
    // Drawn inside its width and from 3 to 100 like every glyph, so the index never grows.
    const pts = outline(g.getAttribute('d'));
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    assert.ok(Math.min(...xs) >= 0 && Math.max(...xs) <= width(r + 'S') + 0.01, `the ${r} is drawn outside its width`);
    assert.deepEqual([Math.min(...ys), Math.max(...ys)], [3, 100], r);
  }
  for (const r of '23456') {
    const g = glyph(r + 'S');
    assert.ok(width(r + 'S') <= width('TS'), `the ${r} is wider than the 10`);
    assert.equal(g.getAttribute('stroke-width'), '15', r);
    assert.equal(g.getAttribute('stroke-linecap'), 'round', r);
  }
});

test('a pip card has as many pips as its rank, in the standard layout', () => {
  // Pip centres: suitAt puts a pip of size 32 at translate(x - 16, y - 16),
  // turned about its centre when it stands in the lower half.
  const pips = code => {
    const g = createCard(code).children[0].children.find(c => has(c, 'card-pips'));
    return g.children.map(p => {
      const t = p.getAttribute('transform');
      const turned = t.match(/^rotate\(180 ([\d.]+) ([\d.]+)\) /);
      const [x, y] = turned ? turned.slice(1).map(Number) : t.match(/translate\(([\d.]+) ([\d.]+)\)/).slice(1).map(n => Number(n) + 16);
      return [x, y, !!turned];
    });
  };
  for (const s of Object.keys(SUITS)) {
    for (const r of '23456789T') {
      const ps = pips(r + s);
      assert.equal(ps.length, r === 'T' ? 10 : Number(r), r + s);
      for (const [, y, turned] of ps) assert.equal(turned, y > 140, `${r + s}: a pip in the lower half is turned, no other`);
    }
  }
  const at = code => pips(code).map(([x, y]) => `${x} ${y}`).sort();
  assert.deepEqual(at('2D'), ['100 228', '100 52']);
  assert.deepEqual(at('3D'), ['100 140', '100 228', '100 52']);
  assert.deepEqual(at('4D'), ['128 228', '128 52', '72 228', '72 52']);
  assert.deepEqual(at('5D'), ['100 140', '128 228', '128 52', '72 228', '72 52']);
  assert.deepEqual(at('6D'), ['128 140', '128 228', '128 52', '72 140', '72 228', '72 52']);
});

test('every court has garments that cards.css colours by suit, and no other face has', () => {
  const accents = el => (has(el, 'court-accent') ? [el] : []).concat(...el.children.map(accents));
  for (const code of ALL) {
    const found = accents(createCard(code));
    // Drawn once per half: the heer's tunic, the vrouw's bodice, the boer's doublet and beret.
    assert.equal(found.length, { K: 2, Q: 2, J: 4 }[code[0]] || 0, code);
    // A fill of its own for the suits and decks that leave it alone.
    for (const g of found) assert.ok(![null, 'none'].includes(g.getAttribute('fill')), code);
  }
});
