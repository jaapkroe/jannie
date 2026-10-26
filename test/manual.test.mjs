// Checks the handleiding: section contract, rendering, and that every number and
// worked example agrees with the rules in docs/design.md §2 (independent checker).
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const manualPath = `${root}web/js/manual.js`;
const cardsPath = `${root}web/js/cards.js`;
const homePath = `${root}web/js/home.js`;

// ---- Minimal DOM, enough for the renderer ----

class Text {
  constructor(data) { this.data = String(data); }
  get textContent() { return this.data; }
}

class Container {
  constructor() { this.childNodes = []; }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') this.childNodes.push(new Text(n));
      else if (n instanceof Fragment) this.childNodes.push(...n.childNodes.splice(0));
      else this.childNodes.push(n);
    }
  }
  appendChild(n) { this.append(n); return n; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes = v === '' ? [] : [new Text(v)]; }
}

class Fragment extends Container {}

class Element extends Container {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this.style = {};
  }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (...c) => { this.className = [...new Set([...names(), ...c])].join(' '); },
      contains: (c) => names().includes(c),
    };
  }
  get children() { return this.childNodes.filter((n) => n instanceof Element); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ type, target: this }); }
  scrollIntoView(opts) { this.scrolledWith = opts; }
  focus() { this.focused = true; }
}

globalThis.document = {
  createElement: (tag) => new Element(tag),
  createTextNode: (t) => new Text(t),
  createDocumentFragment: () => new Fragment(),
};

// cards.js is replaced by a stub so this test depends only on the section 9 contract.
const STUB = `
export const SUITS = { C:{name:'klaveren',symbol:'♣',color:'black'}, D:{name:'ruiten',symbol:'♦',color:'red'},
  H:{name:'harten',symbol:'♥',color:'red'}, S:{name:'schoppen',symbol:'♠',color:'black'} };
export const RANKS = { '7':'7','8':'8','9':'9','T':'10','J':'B','Q':'V','K':'H','A':'A' };
const VALID = /^[789TJQKA][CDHS]$/;
export function cardShort(code) {
  if (!VALID.test(code)) throw new Error('bad card ' + code);
  return SUITS[code[1]].symbol + RANKS[code[0]];
}
export function cardName(code) { return code; }
export function createCard(code, opts = {}) {
  if (!VALID.test(code)) throw new Error('bad card ' + code);
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.card = code;
  el.dataset.size = opts.size || 'md';
  return el;
}
export function createBack() { const el = document.createElement('div'); el.className = 'card back'; return el; }
`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './cards.js' && context.parentURL?.endsWith('/web/js/manual.js')) {
      return { url: `data:text/javascript,${encodeURIComponent(STUB)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const manual = await import(manualPath);
const { SECTIONS, CONTENT, CARD_VALUES, ROEM_VALUES, BLOCK_TYPES, renderManual } = manual;

// ---- Independent rules checker (design.md §2) ----

const NATURAL = ['7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const TRUMP_LOW_HIGH = ['7', '8', 'Q', 'K', 'T', 'A', '9', 'J'];
const PLAIN_LOW_HIGH = ['7', '8', '9', 'J', 'Q', 'K', 'T', 'A'];
const TRUMP_POINTS = { J: 20, 9: 14, A: 11, T: 10, K: 4, Q: 3, 8: 0, 7: 0 };
const PLAIN_POINTS = { A: 11, T: 10, K: 4, Q: 3, J: 2, 9: 0, 8: 0, 7: 0 };
const CLOCKWISE = ['jij', 'links', 'maat', 'rechts'];
const CARD = /^[789TJQKA][CDHS]$/;

const nextRole = (r) => CLOCKWISE[(CLOCKWISE.indexOf(r) + 1) % 4];
const points = (c, trump) => (c[1] === trump ? TRUMP_POINTS : PLAIN_POINTS)[c[0]];
const trumpRank = (c) => TRUMP_LOW_HIGH.indexOf(c[0]);

function beats(a, b, led, trump) {
  if (a[1] === trump || b[1] === trump) {
    if (a[1] !== trump) return false;
    if (b[1] !== trump) return true;
    return trumpRank(a) > trumpRank(b);
  }
  if (a[1] !== led) return false;
  if (b[1] !== led) return true;
  return PLAIN_LOW_HIGH.indexOf(a[0]) > PLAIN_LOW_HIGH.indexOf(b[0]);
}

function winnerIndex(cards, trump) {
  let w = 0;
  for (let i = 1; i < cards.length; i++) if (beats(cards[i], cards[w], cards[0][1], trump)) w = i;
  return w;
}

// played: [[role, card]...] in play order; the player to move is 'jij'.
function legalMoves(hand, played, trump, rules) {
  if (played.length === 0) return hand;
  const cards = played.map(([, c]) => c);
  const led = cards[0][1];
  const trumps = hand.filter((c) => c[1] === trump);
  const highest = cards.filter((c) => c[1] === trump).sort((a, b) => trumpRank(b) - trumpRank(a))[0];
  const higher = trumps.filter((c) => !highest || trumpRank(c) > trumpRank(highest));
  if (led === trump) return trumps.length ? (higher.length ? higher : trumps) : hand;
  const follow = hand.filter((c) => c[1] === led);
  if (follow.length) return follow;
  if (!trumps.length) return hand;
  const others = hand.filter((c) => c[1] !== trump);
  if (rules === 'amsterdams' && played[winnerIndex(cards, trump)][0] === 'maat') {
    const free = [...others, ...higher];
    return free.length ? free : trumps;
  }
  if (higher.length) return higher;
  if (rules === 'rotterdams') return trumps; // always trump, undertrumping if need be
  return others.length ? others : trumps;
}

function roemKinds(cards, trump) {
  const kinds = [];
  for (const s of 'CDHS') {
    const idx = cards.filter((c) => c[1] === s).map((c) => NATURAL.indexOf(c[0])).sort((a, b) => a - b);
    let run = idx.length ? 1 : 0;
    let best = run;
    for (let i = 1; i < idx.length; i++) {
      run = idx[i] === idx[i - 1] + 1 ? run + 1 : 1;
      best = Math.max(best, run);
    }
    if (best >= 4) kinds.push('vier');
    else if (best === 3) kinds.push('drie');
  }
  if (cards.includes(`K${trump}`) && cards.includes(`Q${trump}`)) kinds.push('stuk');
  if (cards.length === 4 && cards.every((c) => c[0] === cards[0][0])) {
    if (cards[0][0] === 'J') kinds.push('vierBoeren');
    else if ('ATKQ'.includes(cards[0][0])) kinds.push('vierGelijk');
  }
  return kinds.sort();
}

function scoreHand([pp, pr], [dp, dr]) {
  const total = pp + pr + dp + dr;
  const nat = !(pp + pr > total / 2);
  return { nat, score: nat ? [0, 162 + pr + dr] : [pp + pr, dp + dr] };
}

// Smallest card-point total the playing team needs, given both teams' roem.
function minNeeded(roemP, roemD) {
  for (let p = 0; p <= 162; p++) if (!scoreHand([p, roemP], [162 - p, roemD]).nat) return p;
  return Infinity;
}

// ---- Helpers over content and rendered trees ----

const blocksOf = (type) => Object.values(CONTENT).flat().filter((b) => type in b).map((b) => b[type]);

function* walk(node) {
  yield node;
  for (const c of node.childNodes || []) yield* walk(c);
}

const elements = (rootEl) => [...walk(rootEl)].filter((n) => n instanceof Element);
const byTag = (rootEl, tag) => elements(rootEl).filter((n) => n.tagName === tag.toUpperCase());
const byClass = (rootEl, cls) => elements(rootEl).filter((n) => n.classList.contains(cls));

function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => allStrings(v, out));
  return out;
}

// ---- Tests ----

test('sections match the section 9 contract', () => {
  assert.deepEqual(SECTIONS, [
    { id: 'bediening', title: 'Bediening' }, { id: 'regels', title: 'Spelregels' },
    { id: 'twee-drie', title: 'Met 2 of 3' },
    { id: 'punten', title: 'Kaartwaarden' }, { id: 'roem', title: 'Roem' },
    { id: 'seinen', title: 'Seinen' }, { id: 'tips', title: 'Tips' },
    { id: 'woorden', title: 'Woordenlijst' },
  ]);
  assert.deepEqual(Object.keys(CONTENT), SECTIONS.map((s) => s.id));
});

test('every block has exactly one known type', () => {
  const extras = { tip: ['title'], note: ['title'], warn: ['title'], dl: ['chips'], cards: ['caption'] };
  for (const [id, blocks] of Object.entries(CONTENT)) {
    assert.ok(blocks.length > 0, id);
    for (const block of blocks) {
      const types = Object.keys(block).filter((k) => BLOCK_TYPES.includes(k));
      assert.equal(types.length, 1, `${id}: ${JSON.stringify(block).slice(0, 80)}`);
      const rest = Object.keys(block).filter((k) => k !== types[0]);
      for (const k of rest) assert.ok((extras[types[0]] || []).includes(k), `${id}: unexpected key ${k}`);
    }
  }
});

test('every section renders with headings and clean text', () => {
  for (const { id } of SECTIONS) {
    const el = renderManual(id);
    assert.equal(el.tagName, 'ARTICLE');
    assert.ok(el.classList.contains('man'));
    assert.equal(el.dataset.section, id);
    const text = el.textContent;
    assert.ok(text.length > 300, `${id} has content`);
    for (const bad of ['**', '{', '}', '[', ']', 'undefined', 'NaN', 'null', 'TODO']) {
      assert.ok(!text.includes(bad), `${id} contains ${bad}`);
    }
    assert.ok(!/ {2}/.test(text), `${id}: double space`);
    assert.ok(!/ [,.:;!?]/.test(text.replace(/ :/g, '')), `${id}: space before punctuation`);
    if (id !== 'woorden') assert.ok(byTag(el, 'h3').length >= 1, `${id} has h3 headings`);
    for (const h of byTag(el, 'h3')) assert.ok(h.id.startsWith(`man-${id}-`), h.id);
    const ids = byTag(el, 'h3').map((h) => h.id);
    assert.equal(new Set(ids).size, ids.length, `${id}: unique heading ids`);
    for (const n of elements(el)) assert.ok(!('innerHTML' in n.attrs) && !('style' in n.attrs));
  }
});

test('unknown section falls back to the first one', () => {
  assert.equal(renderManual('bestaat-niet').dataset.section, 'bediening');
});

test('renderer never parses HTML or sets inline style attributes', () => {
  const src = readFileSync(manualPath, 'utf8');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', "setAttribute('style'", 'style=']) {
    assert.ok(!src.includes(bad), bad);
  }
});

test('card values: order and points match the rules, sums are right', () => {
  assert.deepEqual(CARD_VALUES.trump.map(([r]) => r), [...TRUMP_LOW_HIGH].reverse());
  assert.deepEqual(CARD_VALUES.plain.map(([r]) => r), [...PLAIN_LOW_HIGH].reverse());
  for (const [r, p] of CARD_VALUES.trump) assert.equal(p, TRUMP_POINTS[r], `troef ${r}`);
  for (const [r, p] of CARD_VALUES.plain) assert.equal(p, PLAIN_POINTS[r], `geen troef ${r}`);
  const sum = (list) => list.reduce((t, [, p]) => t + p, 0);
  assert.equal(sum(CARD_VALUES.trump), 62);
  assert.equal(sum(CARD_VALUES.plain), 30);
  assert.equal(sum(CARD_VALUES.trump) + 3 * sum(CARD_VALUES.plain), 152);
  assert.equal(sum(CARD_VALUES.trump) + 3 * sum(CARD_VALUES.plain) + 10, 162);

  const el = renderManual('punten');
  const cards = elements(el).filter((n) => n.dataset.card);
  assert.equal(cards.length, 16, 'one card image per table cell');
  assert.ok(cards.every((c) => c.dataset.size === 'sm'));
  const tfoot = byTag(el, 'tfoot')[0];
  assert.match(tfoot.textContent, /62.*30/);
  assert.match(el.textContent, /62 \+ 3 × 30 = 152/);
  assert.match(el.textContent, /laatste slag erbij is er in elk potje 162/);
});

test('roem values match the rules', () => {
  assert.deepEqual(
    ROEM_VALUES.map((r) => [r.kind, r.points]),
    [['drie', 20], ['vier', 50], ['stuk', 20], ['vierGelijk', 100], ['vierBoeren', 200]],
  );
  const text = renderManual('roem').textContent;
  assert.match(text, /7‑8‑9‑10‑B‑V‑H‑A/);
});

test('all card codes in the content are valid', () => {
  const strings = allStrings(CONTENT);
  for (const s of strings) {
    for (const m of s.matchAll(/\{([^}]*)\}/g)) assert.match(m[1], /^([789TJQKA]?[CDHS])$/, `bad inline card ${m[0]} in "${s}"`);
  }
  for (const b of blocksOf('cards')) {
    for (const item of b) assert.match(Array.isArray(item) ? item[0] : item, CARD);
  }
});

test('legal-move examples agree with the rules', () => {
  const examples = blocksOf('legal');
  assert.ok(examples.length >= 4);
  for (const ex of examples) {
    const seen = [...ex.table.map(([, c]) => c), ...ex.hand];
    seen.forEach((c) => assert.match(c, CARD));
    assert.equal(new Set(seen).size, seen.length, `${ex.title}: duplicate card`);
    for (let i = 1; i < ex.table.length; i++) assert.equal(ex.table[i][0], nextRole(ex.table[i - 1][0]), `${ex.title}: clockwise`);
    assert.equal(nextRole(ex.table.at(-1)[0]), 'jij', `${ex.title}: jij is next`);
    assert.equal(ex.table[winnerIndex(ex.table.map(([, c]) => c), ex.trump)][0], ex.winning, `${ex.title}: who has the trick`);
    for (const v of ex.variants) {
      const rulesets = v.rules === 'beide' ? ['amsterdams', 'rotterdams'] : [v.rules];
      for (const rules of rulesets) {
        const legal = legalMoves(ex.hand, ex.table, ex.trump, rules);
        assert.deepEqual([...v.allowed].sort(), [...legal].sort(), `${ex.title} (${rules})`);
      }
    }
  }
  // The examples together show both Amsterdams/Rotterdams differences: the
  // partner has the trick without trump in it, or with a trump you can beat.
  const differs = examples.filter((ex) => {
    const a = legalMoves(ex.hand, ex.table, ex.trump, 'amsterdams');
    const r = legalMoves(ex.hand, ex.table, ex.trump, 'rotterdams');
    return a.join() !== r.join();
  });
  assert.ok(differs.length >= 2);
});

test('rendered legal examples dim exactly the forbidden cards', () => {
  const el = renderManual('regels');
  const exNodes = byClass(el, 'man-ex').filter((n) => byClass(n, 'man-ok').length || byClass(n, 'man-no').length);
  const examples = blocksOf('legal');
  assert.equal(exNodes.length, examples.length);
  exNodes.forEach((node, i) => {
    const ex = examples[i];
    const ok = byClass(node, 'man-ok').map((f) => f.children[0].dataset.card);
    const expected = ex.variants.flatMap((v) => v.allowed);
    assert.deepEqual(ok, ex.variants.flatMap((v) => ex.hand.filter((c) => v.allowed.includes(c))));
    assert.equal(ok.length, expected.length);
    assert.equal(byClass(node, 'man-no').length, ex.variants.length * ex.hand.length - expected.length);
  });
});

test('trick examples: clockwise order, winner and points', () => {
  const tricks = blocksOf('trick');
  assert.ok(tricks.length >= 3);
  for (const t of tricks) {
    const cards = t.cards.map(([, c]) => c);
    assert.equal(cards.length, 4);
    assert.equal(new Set(cards).size, 4);
    for (let i = 1; i < 4; i++) assert.equal(t.cards[i][0], nextRole(t.cards[i - 1][0]));
    assert.equal(t.cards[winnerIndex(cards, t.trump)][0], t.winner, t.text);
    assert.equal(cards.reduce((s, c) => s + points(c, t.trump), 0), t.points, t.text);
  }
});

test('roem examples are counted correctly', () => {
  const examples = blocksOf('roem');
  assert.ok(examples.length >= 6);
  const kindsShown = new Set();
  for (const ex of examples) {
    assert.equal(new Set(ex.cards).size, 4);
    ex.cards.forEach((c) => assert.match(c, CARD));
    assert.deepEqual([...ex.items].sort(), roemKinds(ex.cards, ex.trump), ex.text);
    ex.items.forEach((k) => kindsShown.add(k));
  }
  assert.deepEqual([...kindsShown].sort(), ROEM_VALUES.map((r) => r.kind).sort(), 'every roem kind has an example');

  const el = renderManual('roem');
  const totals = byClass(el, 'man-roemex-total').map((n) => n.textContent);
  const expected = examples.map((ex) => ex.items.reduce((t, k) => t + ROEM_VALUES.find((r) => r.kind === k).points, 0));
  assert.deepEqual(totals, expected.map((t) => `${t} roem`));
  assert.ok(expected.includes(40) && expected.includes(70), 'stuk combined with a sequence');
});

test('score examples follow the nat rule', () => {
  const examples = blocksOf('score');
  assert.ok(examples.some((e) => e.nat) && examples.some((e) => !e.nat));
  for (const ex of examples) {
    assert.equal(ex.playing[0] + ex.defending[0], 162, `${ex.title}: card points total 162`);
    const r = scoreHand(ex.playing, ex.defending);
    assert.equal(ex.nat, r.nat, ex.title);
    assert.deepEqual(ex.score, r.score, ex.title);
    const total = ex.playing[0] + ex.playing[1] + ex.defending[0] + ex.defending[1];
    for (const n of ex.text.match(/\d+/g)) {
      const v = Number(n);
      const known = [total, total / 2, ...ex.playing, ...ex.defending, ...ex.score, ex.playing[0] + ex.playing[1], 162];
      assert.ok(known.includes(v), `${ex.title}: unexplained number ${v}`);
    }
  }
});

test('numbers in the rules text are right', () => {
  assert.equal(minNeeded(0, 0), 82);
  assert.equal(scoreHand([81, 0], [81, 0]).nat, true, 'tie is nat');
  assert.equal(minNeeded(0, 20) - minNeeded(0, 0), 10, '20 opponent roem costs 10 points');
  assert.equal(minNeeded(0, 0) - minNeeded(20, 0), 10, 'own roem works the other way round');
  const regels = renderManual('regels').textContent;
  assert.match(regels, /minstens 82 van de 162/);
  assert.match(regels, /Bij 81 tegen 81 ga je nat/);
  assert.match(regels, /162 \+ 100 = 262/);
  assert.equal(scoreHand([162, 100], [0, 0]).score[0], 262);
  assert.match(regels, /standaard 16: een boom,/);
  assert.match(regels, /pit \(ook wel doormars\)/);
  assert.match(regels, /drie, twee en drie/);
  const text = [regels, renderManual('roem').textContent, renderManual('tips').textContent].join('\n');
  assert.match(text, /Elke 20 roem voor de tegenstander kost je 10 punten extra/);
  const punten = renderManual('punten').textContent;
  assert.match(punten, /20 punten/);
  assert.match(punten, /nel: 14 punten/);
});

test('glossary has the required words, sorted, and search filters it', () => {
  const terms = blocksOf('glossary')[0].map(([t]) => t);
  const sorted = [...terms].sort((a, b) => a.localeCompare(b, 'nl'));
  assert.deepEqual(terms, sorted, 'alphabetical');
  const lower = terms.join(' | ').toLowerCase();
  const required = ['aas', 'boer', 'jas', 'nel', 'maat', 'voorhand', 'achterhand', 'bekennen', 'troeven',
    'overtroeven', 'ondertroeven', 'verzaken', 'roem', 'stuk', 'nat', 'pit', 'doormars', 'potje', 'boom',
    'spekken (ook wel smeren)', 'seinen (voorkaarten)', 'slag', 'spelende partij', 'gedraaid', 'verplicht'];
  for (const w of required) assert.ok(lower.includes(w), w);

  const el = renderManual('woorden');
  const input = byTag(el, 'input')[0];
  const items = byClass(el, 'man-dl-item');
  const empty = byClass(el, 'man-empty')[0];
  assert.equal(items.length, terms.length);
  input.value = 'NEL';
  input.fire('input');
  const shown = items.filter((i) => !i.hidden).map((i) => i.children[0].textContent);
  assert.ok(shown.includes('Nel') && shown.length < items.length, shown.join());
  assert.equal(empty.hidden, true);
  input.value = 'op een na';
  input.fire('input');
  assert.ok(items.some((i) => !i.hidden && i.children[0].textContent === 'Nel'), 'accent-insensitive: matches “op één na”');
  input.value = 'xyzzy';
  input.fire('input');
  assert.ok(items.every((i) => i.hidden));
  assert.equal(empty.hidden, false);
  input.value = '';
  input.fire('input');
  assert.ok(items.every((i) => !i.hidden));
});

test('long sections get quick links that scroll to their heading', () => {
  for (const { id } of SECTIONS) {
    const el = renderManual(id);
    const h3 = byTag(el, 'h3');
    const nav = byTag(el, 'nav')[0];
    if (h3.length < 4) {
      assert.equal(nav, undefined, id);
      continue;
    }
    const buttons = byTag(nav, 'button');
    assert.deepEqual(buttons.map((b) => b.textContent), h3.map((h) => h.textContent));
    buttons.at(-1).fire('click');
    assert.ok(h3.at(-1).scrolledWith, `${id}: scrolls`);
    assert.ok(h3.at(-1).focused, `${id}: focuses heading`);
  }
});

test('bediening covers the whole interface', () => {
  const text = renderManual('bediening').textContent;
  for (const w of ['Snel spelen', 'Nieuw spel', 'Meedoen', 'Oefenen', '(AI)', 'Kopieer link', 'Delen', 'Start',
    'Spelen', 'Passen', 'Wij – Zij', 'Laatste slag', 'Scorebord', 'Chat', 'Instellingen', 'vierkleurenspel',
    'minder animaties', 'Juf Jannie', 'Utrechts/Amsterdams', '16', 'donkerder', 'veeg omhoog', 'Enter']) {
    assert.ok(text.includes(w), w);
  }
});

test('bediening names the game options exactly as the new-game sheet does', { skip: !existsSync(homePath) && 'home.js not written yet' }, () => {
  // OPTS in home.js holds the option rows of both the new-game sheet and the lobby.
  const home = readFileSync(homePath, 'utf8');
  const start = home.indexOf('const OPTS');
  const labels = [...home.slice(start, home.indexOf('\n];', start)).matchAll(/\blabel: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(labels.length >= 6, `option labels in home.js: ${labels.join()}`);
  const blocks = CONTENT.bediening;
  const at = blocks.findIndex((b) => b.h4 === 'Spelregels bij Nieuw spel');
  assert.ok(at >= 0 && blocks[at + 1].dl, 'option list follows its heading');
  assert.deepEqual(blocks[at + 1].dl.map(([term]) => term), labels);
});

test('bediening only promises a review of the last potje', () => {
  // The state keeps the tricks of the last finished hand only (design section 7,
  // prevHand), so the score sheet makes just that row tappable.
  const entry = blocksOf('dl').flat().find(([term]) => term === 'Scorebord');
  assert.ok(entry, 'Scorebord is explained');
  assert.match(entry[1], /Tik op het laatste potje/);
  assert.doesNotMatch(entry[1], /een potje/);
});

test('bediening chips show the pictograms of the real buttons', () => {
  // The top-bar buttons show only an icon (panels.js TOOLS), so the manual
  // puts that icon in front of each name; util.js must have it.
  const util = readFileSync(`${root}web/js/util.js`, 'utf8');
  const panels = readFileSync(`${root}web/js/panels.js`, 'utf8');
  const tools = Object.fromEntries([...panels.matchAll(/^ {2}\w+: \['(\w+)', '([^']+)'/gm)].map((m) => [m[2], m[1]]));
  assert.ok(Object.keys(tools).length >= 6, `TOOLS in panels.js: ${Object.keys(tools).join()}`);
  const rows = blocksOf('dl').flat().filter((row) => row[2]);
  assert.ok(rows.length >= 10);
  for (const [term, , name] of rows) assert.match(util, new RegExp(`\\n  ${name}: \\[`), `${term}: icon ${name} in util.js`);
  const blocks = CONTENT.bediening;
  const buttons = blocks[blocks.findIndex((b) => b.h === 'Knoppen tijdens het spel') + 2].dl;
  for (const label of ['Laatste slag', 'Scorebord', 'Chat', 'Handleiding', 'Instellingen', 'Geluid', 'Meer']) {
    const row = buttons.find(([term]) => term === label);
    assert.ok(row, `${label} is listed`);
    assert.equal(row[2], tools[label], `${label} shows the button's icon`);
  }
  const made = [];
  const el = renderManual('bediening', { icon: (n) => { made.push(n); const i = document.createElement('i'); i.className = 'icon'; return i; } });
  const chips = byClass(el, 'man-ui').filter((c) => c.children.some((k) => k.classList.contains('icon')));
  assert.equal(chips.length, rows.length);
  assert.deepEqual(made, rows.map((r) => r[2]));
  assert.ok(renderManual('bediening').textContent.includes('⋯ (Meer)'));
});

test('card value headers keep "(hier ♠)" together when they wrap', () => {
  const th = byTag(byTag(renderManual('punten'), 'thead')[0], 'th');
  assert.deepEqual(th.map((h) => h.textContent), ['#', 'Troef (hier ♥)', 'Geen troef (hier ♠)']);
});

test('seinen covers every signal from design section 8', () => {
  const el = renderManual('seinen');
  const heads = byTag(el, 'h3').map((h) => h.textContent.toLowerCase());
  for (const w of ['aas vraagt 10', 'kleintje boer', 'boer over boer', 'hoog of laag', 'tegenkleur', 'spekken (ook wel smeren)', 'maat heeft de slag']) {
    assert.ok(heads.some((h) => h.includes(w)), w);
  }
  assert.match(el.textContent, /geen valsspelen/);
});

test('bediening says Snel spelen and Oefenen need no name', () => {
  const text = renderManual('bediening').textContent;
  assert.match(text, /Voor Snel spelen en Oefenen hoef je geen naam in te vullen\./);
  assert.doesNotMatch(text, /naam vul je maar één keer in/);
});

test('bediening says an AI plays for someone who is gone only when everyone agrees', () => {
  const text = renderManual('bediening').textContent;
  assert.match(text, /Niemand speelt zomaar voor je\. Ben je weg terwijl je aan de beurt bent, dan wacht het spel op je\. Na tien seconden vraagt het de anderen of een AI-speler zolang voor je mag spelen\. Dat gebeurt alleen als iedereen akkoord is\./);
  assert.match(text, /Kies je Spel verlaten, dan blijft je plaats vrij voor wie met de spelcode aanschuift\./);
  assert.match(text, /Tik op AI laten spelen of Wachten\./);
  assert.match(text, /het spel wacht tot je terug bent/);
  // Nothing of the AI that used to take over by itself.
  assert.doesNotMatch(text, /seconden een AI-speler voor je|neemt een AI-speler je plaats in|neemt de plaats over/);
});

test('bediening says when Juf Jannie tells what she had advised', () => {
  const text = renderManual('bediening').textContent;
  assert.match(text, /Speel je een andere kaart, dan vertelt Juf Jannie na de slag welke kaart zij had aangeraden en waarom\./);
  assert.match(text, /Kies je een andere troef, of speel of pas je tegen haar advies in, dan hoor je dat na de eerste slag\./);
});

test('seinen keeps its short title and names voorkaarten in the text', () => {
  assert.equal(SECTIONS.find((s) => s.id === 'seinen').title, 'Seinen');
  assert.match(renderManual('seinen').textContent,
    /^Met seinen \(ook wel voorkaarten\) vertel je je maat iets over je hand, alleen met de kaart die je speelt\./);
  assert.ok(blocksOf('glossary')[0].some(([t]) => t === 'Seinen (voorkaarten)'));
});

test('seinen explains aas vraagt 10 and hoog of laag as the house agrees them', () => {
  const text = renderManual('seinen').textContent;
  assert.match(text, /Heeft je maat de slag, .*gooi dan een aas bij van een bijkleur .*“ik heb ook de 10 van deze kleur”/);
  assert.match(text, /Je maat speelt die kleur later naar je toe, en dan pak jij de slag met je 10\./);
  assert.match(text, /Uitkomen met een aas zegt niets\./);
  assert.match(text, /klein kaartje \(7, 8 of 9: kaarten zonder punten\) bijspelen zegt: “speel deze kleur, daar heb ik de hoogste van”/);
  assert.match(text, /10 of een plaatje .*“ik heb weinig in deze kleur/);
});

test('the words of the house: spekken, boom and doormars', () => {
  const home = existsSync(homePath) ? readFileSync(homePath, 'utf8') : '';
  const text = [...SECTIONS.map(({ id }) => renderManual(id).textContent), home].join('\n');
  assert.doesNotMatch(text, /boompje/i);
  assert.doesNotMatch(text, /(?<!door)mars/i);
  // Smeren only as the other name of spekken.
  assert.doesNotMatch(text.replaceAll('(ook wel smeren)', ''), /smee?r|gesmeerd/i);
  assert.match(text, /spek de slag met/);
  assert.match(home, /Zestien potjes heet een boom\./);
});

test('cards.js (when present) exports what manual.js imports', { skip: !existsSync(cardsPath) && 'cards.js not written yet' }, () => {
  const src = readFileSync(manualPath, 'utf8');
  const names = src.match(/import \{([^}]+)\} from '\.\/cards\.js'/)[1].split(',').map((s) => s.trim());
  const cards = readFileSync(cardsPath, 'utf8');
  for (const n of names) assert.match(cards, new RegExp(`export (const|function|let) ${n}\\b`), n);
});
