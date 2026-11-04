// platform/web/js/util.js without a browser: node --test test/ui/app-util.test.mjs
// (a minimal stand-in DOM for the element builders).
import { test } from 'node:test';
import assert from 'node:assert/strict';

// util.js reads media queries and kj.prefs when it loads.
let mode = 'ok'; // 'ok', 'blocked' (every access throws) or 'full' (writes throw)
const data = new Map();
const blocked = () => { throw new Error('SecurityError: storage is blocked'); };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.localStorage = {
  getItem: k => (mode === 'blocked' ? blocked() : data.has(k) ? data.get(k) : null),
  setItem: (k, v) => (mode === 'ok' ? data.set(k, String(v)) : blocked()),
  removeItem: k => (mode === 'blocked' ? blocked() : data.delete(k)),
};
// Just enough DOM for h(): elements with properties, attributes and children.
class FakeNode {
  constructor(tag) { Object.assign(this, { tagName: tag.toUpperCase(), className: '', textContent: '', title: '', attrs: {}, kids: [] }); }
  setAttribute(k, v) { this.attrs[k] = v; }
  append(...k) { this.kids.push(...k); }
  addEventListener() {}
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: tag => new FakeNode(tag) };
const {
  store, roemText, cap, playerName, keyboardOpen, textField, handHeadline, DEFAULT_NAME,
  posOf, sideOf, isWij, teamName, scorerOf, scorerOrder, scorerName, variantText, countWord,
  reviewVerdict, luckText, momentWhere, strongLine, missedLine, fineLine, outcomeLine, handSum, timeText, reviewHistory,
  versionText,
} = await import('../../platform/web/js/util.js');

test('store keeps values in memory when localStorage is blocked', () => {
  mode = 'blocked';
  assert.equal(store.get('name', ''), '');
  store.set('name', 'Privé');
  store.set('token.ABCD', 'tok');
  assert.equal(store.get('name', ''), 'Privé');
  assert.equal(store.get('token.ABCD', ''), 'tok');
  store.setJSON('opts', { hands: 8 });
  assert.deepEqual(store.json('opts', {}), { hands: 8 });
  store.del('token.ABCD');
  assert.equal(store.get('token.ABCD', ''), '');
  store.del('name');
  store.del('opts');
});

test('store uses localStorage when it works, and sees other tabs write', () => {
  mode = 'ok';
  store.set('name', 'Anna');
  assert.equal(data.get('kj.name'), 'Anna');
  data.set('kj.name', 'Bert'); // another tab
  assert.equal(store.get('name'), 'Bert');
  store.del('name');
  assert.equal(data.has('kj.name'), false);
  assert.equal(store.get('name', 'x'), 'x');
});

test('a write that fails (storage full) wins over the stale stored value', () => {
  mode = 'ok';
  store.set('token.WXYZ', 'old');
  mode = 'full';
  store.set('token.WXYZ', 'new');
  assert.equal(store.get('token.WXYZ'), 'new');
  mode = 'ok';
  store.set('token.WXYZ', 'newer'); // stored again: memory is dropped
  data.set('kj.token.WXYZ', 'from another tab');
  assert.equal(store.get('token.WXYZ'), 'from another tab');
  store.del('token.WXYZ');
});

test('roem reads lower case mid-sentence; cap upper-cases the first letter', () => {
  assert.equal(roemText([{ kind: 'drie', points: 20 }, { kind: 'stuk', points: 20 }]), 'driekaart (20), stuk (20)');
  assert.equal(roemText([]), '');
  assert.equal(cap('harten is troef'), 'Harten is troef');
  assert.equal(cap(''), '');
});

test('playerName keeps " (AI)" apart from the name that may shorten', () => {
  const bot = playerName('Kees de Visser (AI)', { cls: 'ls-name', title: true });
  assert.equal(bot.className, 'pname ls-name');
  assert.equal(bot.title, 'Kees de Visser (AI)');
  assert.deepEqual(bot.kids.map(k => [k.className, k.textContent]), [['pname-base', 'Kees de Visser'], ['pname-ai', ' (AI)']]);
  const human = playerName('Anna');
  assert.equal(human.className, 'pname');
  assert.equal(human.title, '');
  assert.deepEqual(human.kids.map(k => [k.className, k.textContent]), [['pname-base', 'Anna']]);
  // Only a trailing marker is one.
  assert.deepEqual(playerName('(AI) fan').kids.map(k => k.textContent), ['(AI) fan']);
  assert.deepEqual(playerName('').kids.map(k => k.textContent), ['']);
});

test('the on-screen keyboard counts as open only on an upright touch screen that it makes short', () => {
  const up = { touch: true, upright: true, focused: true, full: 844, height: 420, wasOn: false, sinceBlur: Infinity };
  assert.equal(keyboardOpen(up), true);
  assert.equal(keyboardOpen({ ...up, height: 330 }), true);
  assert.equal(keyboardOpen({ ...up, touch: false }), false, 'a mouse and a real keyboard');
  assert.equal(keyboardOpen({ ...up, upright: false }), false, 'a phone on its side keeps its landscape layout');
  assert.equal(keyboardOpen({ ...up, height: 790 }), false, 'focused, but the keyboard is down (back button, hardware keyboard)');
  assert.equal(keyboardOpen({ ...up, full: 0 }), true, 'no full height measured yet: a focused field will do');
  // After a blur the keyboard slides away: the layout holds until the
  // viewport has grown back, or for a short while at most.
  const blurred = { ...up, focused: false, wasOn: true, sinceBlur: 150 };
  assert.equal(keyboardOpen(blurred), true);
  assert.equal(keyboardOpen({ ...blurred, height: 844 }), false);
  assert.equal(keyboardOpen({ ...blurred, sinceBlur: 5000 }), false);
  assert.equal(keyboardOpen({ ...blurred, wasOn: false }), false);
});

test('textField knows which fields bring up the keyboard', () => {
  const input = (type, extra = {}) => ({ tagName: 'INPUT', type, ...extra });
  assert.equal(textField(input('text')), true);
  assert.equal(textField(input('search')), true);
  assert.equal(textField(input('text', { readOnly: true })), false, 'the link to copy by hand');
  assert.equal(textField(input('text', { disabled: true })), false);
  assert.equal(textField(input('checkbox')), false);
  assert.equal(textField(input('range')), false);
  assert.equal(textField({ tagName: 'TEXTAREA' }), true);
  assert.equal(textField({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(textField({ tagName: 'BUTTON' }), false);
  assert.equal(textField(null), false);
});

test('the hand summary headline speaks from our side', () => {
  // r as the server sends it: playingTeam and pitTeam are 0 or 1 (pitTeam -1: no pit).
  const r = (playingTeam, nat, pitTeam = -1) => ({ playingTeam, nat, pit: pitTeam >= 0, pitTeam });
  const seen = (res, w) => { const { t, cls } = handHeadline(res, w); return `${t} [${cls}]`; };
  for (const w of [0, 1]) {
    const wij = w;
    const zij = 1 - w;
    assert.equal(seen(r(wij, false), w), 'Gehaald! [good]');
    assert.equal(seen(r(wij, true), w), 'Nat! [nat bad]');
    assert.equal(seen(r(zij, false), w), 'Zij halen het [neutral]', 'they made it: not our "Gehaald!"');
    assert.equal(seen(r(zij, true), w), 'Zij gaan nat! [nat good]');
    assert.equal(seen(r(wij, false, wij), w), 'Pit! [pit good]');
    assert.equal(seen(r(zij, true, wij), w), 'Pit! [pit good]', 'they went nat and we took every trick');
    assert.equal(seen(r(zij, false, zij), w), 'Zij halen pit [pit bad]');
    assert.equal(seen(r(wij, true, zij), w), 'Nat! [nat bad]', 'we played and took no trick');
  }
  assert.equal(handHeadline(r(0, false), 0).sub, 'Wij spelen en halen het.');
  assert.equal(handHeadline(r(0, false), 1).sub, 'Zij spelen en halen meer dan de helft van de punten.');
  assert.equal(handHeadline(r(1, true, 0), 0).sub, 'Zij gaan nat en wij halen alle acht slagen: 100 roem extra.');
  assert.equal(handHeadline(r(0, true, 1), 0).sub, 'Wij spelen en halen geen slag. Zij krijgen alles, plus 100 roem voor pit.');
  // Good news for us is never shown as bad, and the other way round.
  for (const pl of [0, 1]) for (const nat of [false, true]) for (const pt of [-1, 0, 1]) {
    const { cls } = handHeadline(r(pl, nat, pt), 0);
    const goodForUs = pt === 0 || (pt === -1 && (pl === 0) !== nat);
    if (goodForUs) assert.match(cls, /\bgood\b/, `${pl} ${nat} ${pt}`);
    else assert.doesNotMatch(cls, /\bgood\b/, `${pl} ${nat} ${pt}`);
  }
});

// A state with n seats, seen from seat you; soloist for three players.
const table = (n, you, soloist = -1) => ({
  you, soloist, players: Array.from({ length: n }, (_, i) => ({ name: ['Anna', 'Opa Dirk (AI)', 'Kees', 'Bram (AI)'][i] })),
});

test('seats sit around the table by its size, you at the bottom', () => {
  const where = (n, you) => Array.from({ length: n }, (_, seat) => posOf(table(n, you), seat)).join(' ');
  assert.equal(where(4, 0), 'bottom left top right');
  assert.equal(where(4, 2), 'top right bottom left');
  assert.equal(where(3, 0), 'bottom left right');
  assert.equal(where(3, 1), 'right bottom left');
  assert.equal(where(2, 1), 'top bottom');
});

test('sides: teams of four, each for themselves with two, the soloist alone with three', () => {
  const four = table(4, 1);
  assert.deepEqual([0, 1, 2, 3].map(s => isWij(four, s)), [false, true, false, true]);
  assert.equal(teamName(four, 1), 'Wij');
  const two = table(2, 1);
  assert.deepEqual([0, 1].map(s => isWij(two, s)), [false, true]);
  assert.equal(teamName(two, 0), 'Anna');
  assert.equal(teamName(two, 1), 'Jij');
  // During the auction nobody plays together yet.
  const bidding = table(3, 0);
  assert.deepEqual([0, 1, 2].map(s => sideOf(bidding, s)), [-1, -1, -1]);
  assert.deepEqual([0, 1, 2].map(s => isWij(bidding, s)), [true, false, false]);
  // Seat 2 plays alone: 0 and 1 play together.
  const three = table(3, 0, 2);
  assert.deepEqual([0, 1, 2].map(s => isWij(three, s)), [true, true, false]);
  assert.equal(teamName(three, 0), 'Kees');
  assert.equal(teamName(three, 1), 'Wij');
  assert.equal(teamName(table(3, 2, 2), 0), 'Jij');
});

test('scores: per team with four players, else per player, ours first', () => {
  assert.deepEqual(scorerOrder(table(4, 3)), [1, 0]);
  assert.equal(scorerOf(table(4, 3), 2), 0);
  assert.equal(scorerName(table(4, 3), 1), 'Wij');
  assert.deepEqual(scorerOrder(table(3, 1)), [1, 2, 0]);
  assert.equal(scorerOf(table(3, 1), 2), 2);
  assert.equal(scorerName(table(3, 1), 1), 'Jij');
  assert.equal(scorerName(table(3, 1), 2), 'Kees');
  assert.deepEqual(scorerOrder(table(2, 0)), [0, 1]);
});

test('the variant names the table size where it matters', () => {
  assert.equal(variantText({ players: 4, trumpMode: 'gedraaid', rules: 'rotterdams' }), 'Gedraaid/Rotterdams');
  assert.equal(variantText({ players: 3, trumpMode: 'gedraaid', rules: 'rotterdams' }), 'Met z\'n drieën, Rotterdams');
  assert.equal(variantText({ players: 2, trumpMode: 'gedraaid', rules: 'rotterdams' }), 'Met z\'n tweeën, Gedraaid');
  assert.equal(variantText({ trumpMode: 'utrechts', rules: 'amsterdams' }), 'Utrechts/Amsterdams');
  assert.equal(countWord(1), 'één');
  assert.equal(countWord(3), 'drie');
});

test('the headline with two and three players names who played', () => {
  const s3 = table(3, 0, 2);
  const solo = (nat, made, pitTeam = -1) => ({
    players: 3, playingTeam: 0, trumpBy: 2, bid: 100, nat, pit: pitTeam >= 0, pitTeam,
    points: [made, 162 - made], roem: [0, 0],
  });
  assert.deepEqual(handHeadline(solo(false, 110), 1, s3),
    { t: 'Kees haalt het', sub: 'Kees speelde alleen voor 100 en haalde 110. Jullie delen de rest.', cls: 'neutral' });
  assert.deepEqual(handHeadline(solo(true, 90), 1, s3),
    { t: 'Kees gaat nat!', sub: 'Kees speelde alleen voor 100 en haalde 90. Jullie krijgen alles, ieder de helft.', cls: 'nat good' });
  const s3me = table(3, 2, 2);
  assert.equal(handHeadline(solo(false, 110), 0, s3me).t, 'Gehaald!');
  assert.equal(handHeadline(solo(false, 110), 0, s3me).sub, 'Jij speelde alleen voor 100 en haalde 110.');
  assert.equal(handHeadline(solo(true, 90), 0, s3me).cls, 'nat bad');
  assert.equal(handHeadline(solo(false, 162, 0), 0, s3me).cls, 'pit good');
  const duo = (playingTeam, nat, pitTeam = -1) => ({ players: 2, playingTeam, nat, pit: pitTeam >= 0, pitTeam, points: [0, 0], roem: [0, 0] });
  const s2 = table(2, 1);
  assert.equal(handHeadline(duo(1, false), 1, s2).t, 'Gehaald!');
  assert.equal(handHeadline(duo(0, false), 1, s2).t, 'Anna haalt het');
  assert.equal(handHeadline(duo(0, true), 1, s2).t, 'Anna gaat nat!');
  assert.equal(handHeadline(duo(0, true), 1, s2).cls, 'nat good');
  assert.equal(handHeadline(duo(1, false, 1), 1, s2).sub, 'Jij haalt alle zestien slagen: 100 roem extra.');
});

test('a player without a name is "Speler", as the server calls one', () => {
  assert.equal(DEFAULT_NAME, 'Speler');
});

test('the review states its numbers plainly', () => {
  assert.equal(reviewVerdict(100), 'sterk gespeeld');
  assert.equal(reviewVerdict(95), 'sterk gespeeld');
  assert.equal(reviewVerdict(87), 'goed gespeeld');
  assert.equal(reviewVerdict(82), 'goed gespeeld');
  assert.equal(reviewVerdict(65), 'kan beter');
  assert.equal(luckText(-6), 'Onder gemiddeld\u00a0(−6)');
  assert.equal(luckText(8), 'Boven gemiddeld\u00a0(+8)');
  assert.equal(luckText(1), 'Gemiddeld\u00a0(+1)');
  assert.equal(luckText(0), 'Gemiddeld\u00a0(0)');
  assert.equal(luckText(-4), 'Gemiddeld\u00a0(−4)');
  assert.equal(momentWhere({ hand: 5, trick: 3 }), 'Potje 5, slag 3');
  assert.equal(momentWhere({ hand: 9, trick: 0 }), 'Potje 9');
});

test('a review moment names the choice, the better one and the reason', () => {
  const why = 'je maat heeft de slag nog niet en de aas is hoog';
  assert.equal(missedLine({ played: { card: 'TS' }, better: { card: 'AS' }, points: 18, why, text: `Speel ♠A: ${why}` }),
    `♠10 gespeeld, ♠A 18\u00a0punten beter: ${why}`);
  assert.equal(missedLine({ played: { suit: 'H' }, better: { suit: 'C' }, points: 14, why: 'je hebt de boer.', text: '' }),
    '♥ als troef, ♣ 14\u00a0punten beter: je hebt de boer.');
  assert.equal(missedLine({ played: { play: false }, better: { play: true }, points: 12, why: 'x.' }), 'Gepast, spelen 12\u00a0punten beter: x.');
  assert.equal(missedLine({ played: { play: true }, better: { play: false }, points: 1, why: 'x.' }), 'Gespeeld, passen 1\u00a0punt beter: x.');
  // A hint that opens otherwise follows as a sentence of its own.
  assert.equal(missedLine({ played: { card: '7H' }, better: { card: 'TH' }, points: 9, why: '', text: 'Je maat heeft de slag: spek hem.' }),
    '♥7 gespeeld, ♥10 9\u00a0punten beter. Je maat heeft de slag: spek hem.');
  assert.deepEqual(strongLine({ played: { card: 'AS' }, why: 'de aas is hoog.' }), { what: '♠A', rest: ': de aas is hoog.' });
  assert.deepEqual(strongLine({ played: { suit: 'C' }, why: '', text: 'Kies dit.' }), { what: '♣ als troef', rest: '. Kies dit.' });
  assert.deepEqual(strongLine({ played: { play: true }, why: 'x.' }), { what: 'Gespeeld', rest: ': x.' });
});

test('a choice that lost and gained nothing says so plainly', () => {
  assert.equal(fineLine({ trick: 3, played: { card: '8S' } }), '♠8 gespeeld: geen duidelijk betere keuze volgens Juf Jannie');
  assert.equal(fineLine({ trick: 0, played: { suit: 'H' } }), '♥ als troef: geen duidelijk betere keuze volgens Juf Jannie');
  assert.equal(fineLine({ trick: 0, played: { play: false } }), 'Gepast: geen duidelijk betere keuze volgens Juf Jannie');
  assert.equal(fineLine({ trick: 0, played: { play: true } }), 'Gespeeld: geen duidelijk betere keuze volgens Juf Jannie');
});

test('the line over a hand counts its choices, strong moves and points left, and what is still being graded', () => {
  const fine = { trick: 1, played: { card: '7H' } };
  const strong = { trick: 2, played: { card: 'AS' }, alt: { card: '8S' }, points: 12, us: 6, them: -6 };
  const missed = (trick, points) => ({ trick, played: { card: 'TS' }, better: { card: 'AS' }, points, us: points, them: 0 });
  assert.equal(handSum([fine, fine, strong, missed(4, 18), fine, fine, fine]),
    'Volgens Juf Jannie: 7\u00a0keuzes · 1\u00a0sterke zet · 18\u00a0punten laten liggen in 1\u00a0zet');
  assert.equal(handSum([fine, strong, strong, missed(4, 9), missed(6, 7)]),
    'Volgens Juf Jannie: 5\u00a0keuzes · 2\u00a0sterke zetten · 16\u00a0punten laten liggen in 2\u00a0zetten');
  // Parts of 0 are left out; the grades still out come last.
  assert.equal(handSum([fine]), 'Volgens Juf Jannie: 1\u00a0keuze');
  assert.equal(handSum([fine, fine], 2), 'Volgens Juf Jannie: 2\u00a0keuzes · nog 2\u00a0keuzes in berekening');
  assert.equal(handSum([], 1), 'Volgens Juf Jannie: nog 1\u00a0keuze in berekening');
  // Nothing graded and nothing on its way: no line.
  assert.equal(handSum([], 0), '');
  assert.equal(handSum(), '');
});

test('a review moment splits its points over the teams, with the chance of nat where it moved', () => {
  assert.equal(outcomeLine({ us: 37, them: -23, nat: [69, 37], natThem: [0, 0] }), 'Jullie +37, zij −23; kans dat jullie nat gaan 69% → 37%');
  assert.equal(outcomeLine({ us: 22, them: -24, nat: [0, 0], natThem: [30, 51] }), 'Jullie +22, zij −24; kans dat zij nat gaan 30% → 51%');
  // A shift under 5 points of chance is left out; zero has no sign.
  assert.equal(outcomeLine({ us: 0, them: -12, nat: [10, 14], natThem: [2, 0] }), 'Jullie 0, zij −12');
  assert.equal(outcomeLine({ us: 6, them: -6, nat: [0, 0], natThem: [0, 0], alt: { card: '8S' } }), 'Tegenover ♠8: jullie +6, zij −6');
  assert.equal(outcomeLine({ us: 8, them: 3, alt: { suit: 'C' } }), 'Tegenover ♣ als troef: jullie +8, zij +3');
  assert.equal(outcomeLine({ us: 8, them: -3, alt: { play: false } }), 'Tegenover passen: jullie +8, zij −3');
});

test('think times read as seconds, then minutes', () => {
  assert.equal(timeText(840), '0,8\u00a0s');
  assert.equal(timeText(9940), '9,9\u00a0s');
  assert.equal(timeText(9960), '10\u00a0s');
  assert.equal(timeText(48200), '48\u00a0s');
  assert.equal(timeText(59600), '1\u00a0min');
  assert.equal(timeText(370000), '6\u00a0min 10\u00a0s');
});

test('the review history on the device lists the earlier percentages once', () => {
  mode = 'ok';
  store.del('reviews');
  assert.deepEqual(reviewHistory({ id: 'a', pct: 79 }), []);
  assert.deepEqual(reviewHistory({ id: 'b', pct: 83 }), [79]);
  assert.deepEqual(reviewHistory({ id: 'b', pct: 83 }), [79], 'the same match is kept once');
  assert.deepEqual(reviewHistory({ id: 'c', pct: 87 }), [79, 83]);
  assert.deepEqual(reviewHistory({ id: 'b', pct: 83 }), [79], 'an earlier match sees only the ones before it');
  for (let i = 0; i < 30; i++) reviewHistory({ id: 'x' + i, pct: i });
  assert.equal(store.json('reviews', []).length, 20);
  assert.deepEqual(reviewHistory({ id: 'new', pct: 50 }), [25, 26, 27, 28, 29]);
  store.set('reviews', '{"broken":');
  assert.deepEqual(reviewHistory({ id: 'z', pct: 1 }), []);
  store.del('reviews');
});

test('versionText: the commit shortened, -dirty kept, "dev" when not filled in', () => {
  assert.equal(versionText('a05a087d1f9ff827b5d8c4f9de0bc387d2c23957'), 'a05a087');
  assert.equal(versionText('a05a087d1f9ff827b5d8c4f9de0bc387d2c23957-dirty'), 'a05a087-dirty');
  assert.equal(versionText('@VERSION@'), 'dev');
  assert.equal(versionText('dev'), 'dev');
  assert.equal(versionText(''), 'dev');
  assert.equal(versionText(undefined), 'dev');
});
