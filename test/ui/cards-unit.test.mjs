// web/shared/js/cards.js without a browser: node --test test/ui/cards-unit.test.mjs
// (a minimal stand-in DOM for the faces; cards-shot.mjs checks how they render).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUITS, RANKS, parseCard, cardName, cardShort, createCard } from '../../web/shared/js/cards.js';

// Just enough DOM for the faces: attributes, classes, dataset, children and deep clones.
class FakeElement {
  constructor(tag) {
    Object.assign(this, { tagName: tag, attrs: {}, dataset: {}, children: [] });
    this.classList = { add: (...c) => { this.className = [this.className, ...c].join(' ').trim(); } };
  }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = v; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { this.children.push(c); return c; }
  cloneNode(deep) {
    const n = new FakeElement(this.tagName);
    Object.assign(n.attrs, this.attrs);
    Object.assign(n.dataset, this.dataset);
    if (deep) n.children = this.children.map(c => c.cloneNode(true));
    return n;
  }
}
globalThis.document = { createElement: tag => new FakeElement(tag), createElementNS: (ns, tag) => new FakeElement(tag) };

const ALL = Object.keys(SUITS).flatMap(s => Object.keys(RANKS).map(r => r + s));
const has = (el, cls) => el.className.split(' ').includes(cls);
const markup = el => `<${el.tagName}${Object.entries(el.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}>${el.children.map(markup).join('')}</${el.tagName}>`;
// The rank glyph of a face's top-left index.
const glyph = code => createCard(code).children[0].children.find(g => has(g, 'card-index')).children[0].children[0];

test('SUITS and RANKS match the contract', () => {
  assert.deepEqual(Object.keys(SUITS).sort(), ['C', 'D', 'H', 'S']);
  assert.deepEqual(SUITS.C, { name: 'klaveren', symbol: '♣', color: 'black' });
  assert.deepEqual(SUITS.D, { name: 'ruiten', symbol: '♦', color: 'red' });
  assert.deepEqual(SUITS.H, { name: 'harten', symbol: '♥', color: 'red' });
  assert.deepEqual(SUITS.S, { name: 'schoppen', symbol: '♠', color: 'black' });
  assert.deepEqual({ ...RANKS }, { 7: '7', 8: '8', 9: '9', T: '10', J: 'B', Q: 'V', K: 'H', A: 'A' });
  assert.ok(Object.isFrozen(SUITS) && Object.isFrozen(SUITS.H) && Object.isFrozen(RANKS));
});

test('cardName gives the Dutch name', () => {
  assert.equal(cardName('JH'), 'harten boer');
  assert.equal(cardName('TS'), 'schoppen 10');
  assert.equal(cardName('QD'), 'ruiten vrouw');
  assert.equal(cardName('KC'), 'klaveren heer');
  assert.equal(cardName('AH'), 'harten aas');
  assert.equal(cardName('7C'), 'klaveren 7');
});

test('cardShort gives symbol and face letter', () => {
  assert.equal(cardShort('JH'), '♥B');
  assert.equal(cardShort('TS'), '♠10');
  assert.equal(cardShort('QD'), '♦V');
  assert.equal(cardShort('KC'), '♣H');
  assert.equal(cardShort('9H'), '♥9');
});

test('all 32 codes parse and have unique names', () => {
  const names = new Set();
  for (const s of Object.keys(SUITS)) {
    for (const r of Object.keys(RANKS)) {
      assert.deepEqual(parseCard(r + s), { rank: r, suit: s });
      names.add(cardName(r + s));
    }
  }
  assert.equal(names.size, 32);
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
  for (const code of ['7H', '8H', '9H', 'TH', 'QH', 'KH', 'AH']) assert.equal(glyph(code).getAttribute('stroke-linejoin'), 'round', code);
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
