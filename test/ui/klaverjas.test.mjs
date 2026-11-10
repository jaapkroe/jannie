// games/klaverjas/web/js/rules.js without a browser: node --test test/ui/klaverjas.test.mjs
// (it imports the shell's util.js and cards.js, which site.mjs's siteImports
// finds as the browser does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteImports } from './site.mjs';

// util.js reads media queries and kj.prefs when it loads; reviewHistory
// keeps kj.reviews.
const data = new Map();
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.localStorage = {
  getItem: k => (data.has(k) ? data.get(k) : null),
  setItem: (k, v) => data.set(k, String(v)),
  removeItem: k => data.delete(k),
};
siteImports();
const {
  roemText, handHeadline, posOf, sideOf, isWij, teamName, scorerOf, scorerOrder, scorerName, variantText,
  reviewVerdict, luckText, momentWhere, strongLine, missedLine, fineLine, outcomeLine, handSum, timeText, reviewHistory,
  MANUAL_SECTIONS, chartSpec,
} = await import('../../games/klaverjas/web/js/rules.js');
const { store } = await import('../../platform/web/js/util.js');
const { SECTIONS } = await import('../../games/klaverjas/web/js/manual.js');

test('roem reads lower case mid-sentence', () => {
  assert.equal(roemText([{ kind: 'drie', points: 20 }, { kind: 'stuk', points: 20 }]), 'driekaart (20), stuk (20)');
  assert.equal(roemText([]), '');
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

test('the chart of a match: Wij and Zij in their colours, a ring where a side went nat', () => {
  assert.equal(chartSpec({ ...table(4, 1), scores: [] }), null);
  const row = o => ({ players: 4, nat: false, pit: false, pitTeam: -1, bid: 0, roem: [0, 0], ...o, gains: o.score });
  const s = { ...table(4, 1), scores: [
    row({ hand: 1, playingTeam: 0, trumpBy: 2, trump: 'H', points: [104, 58], roem: [20, 0], score: [124, 58] }),
    row({ hand: 2, playingTeam: 1, trumpBy: 1, trump: 'S', points: [162, 0], roem: [20, 0], score: [182, 0], nat: true }),
    row({ hand: 3, playingTeam: 1, trumpBy: 3, trump: 'C', points: [0, 162], roem: [0, 100], score: [0, 262], pit: true, pitTeam: 1 }),
  ] };
  const c = chartSpec(s);
  assert.deepEqual(c.names, ['Wij', 'Zij']);
  assert.deepEqual(c.colors, ['var(--wij)', 'var(--zij)']);
  assert.deepEqual(c.pts, [[0, 0], [58, 124], [58, 306], [320, 306]]);
  assert.deepEqual(c.rings, [[2], []]);
  assert.equal(c.ringLabel, 'nat');
  assert.equal(c.limit, undefined);
  assert.deepEqual(c.tips[1], { title: 'Na potje 1 · ♥ Zij', rows: [{ k: 1, note: '+124, 20 roem', value: 124 }, { k: 0, note: '+58', value: 58 }] });
  assert.deepEqual(c.tips[2], { title: 'Na potje 2 · ♠ jij', rows: [{ k: 1, note: '+182', value: 306 }, { k: 0, note: 'nat', value: 58 }] });
  assert.deepEqual(c.tips[3], { title: 'Na potje 3 · ♣ Wij', rows: [{ k: 0, note: '+262, pit, 100 roem', value: 320 }, { k: 1, note: '+0', value: 306 }] });
  assert.match(c.label, /3 potjes/);
  // Three players: a line each, the soloist's bid in the tooltip.
  const three = { ...table(3, 0), scores: [{ hand: 1, players: 3, playingTeam: 0, trumpBy: 2, bid: 100, trump: 'D', points: [110, 52],
    roem: [0, 0], score: [110, 52], gains: [26, 26, 110], nat: false, pit: false, pitTeam: -1 }] };
  const c3 = chartSpec(three);
  assert.deepEqual(c3.names, ['Jij', 'Opa Dirk (AI)', 'Kees']);
  assert.deepEqual(c3.colors, ['var(--wij)', 'var(--zij)', '#9085e9']);
  assert.deepEqual(c3.pts, [[0, 0, 0], [26, 26, 110]]);
  assert.equal(c3.tips[1].title, 'Na potje 1 · ♦ Kees voor 100');
});

test('the variant names the table size where it matters', () => {
  assert.equal(variantText({ players: 4, trumpMode: 'gedraaid', rules: 'rotterdams' }), 'Gedraaid/Rotterdams');
  assert.equal(variantText({ players: 3, trumpMode: 'gedraaid', rules: 'rotterdams' }), 'Met z\'n drieën, Rotterdams');
  assert.equal(variantText({ players: 2, trumpMode: 'gedraaid', rules: 'rotterdams' }), 'Met z\'n tweeën, Gedraaid');
  assert.equal(variantText({ trumpMode: 'utrechts', rules: 'amsterdams' }), 'Utrechts/Amsterdams');
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

test('the manual\'s sections are manual.js\'s, for the lesson link before it loads', () => {
  assert.deepEqual(MANUAL_SECTIONS, SECTIONS);
});
