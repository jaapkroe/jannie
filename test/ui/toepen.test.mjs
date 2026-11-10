// games/toepen/web/js/rules.js without a browser: node --test test/ui/toepen.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  strength, wasKind, seatAngle, onEllipse, seatStatus, prompt, roundHeadline, standings, variantText, manual, isOut, washes, yours, alone, cardLabel, whyRows,
  courseView,
} from '../../games/toepen/web/js/rules.js';

const player = name => ({ name, bot: false, connected: true });
const bot = name => ({ name: `${name} (AI)`, bot: true, connected: true });

// A table of four in phase play, you at seat 0 on turn.
function table(over = {}) {
  return {
    phase: 'play', you: 0, turn: 0, stake: 1, toeper: -1, claimant: -1, nextAt: 0, tricks: 0,
    opts: { limit: 10, was: true, armoede: true },
    players: [player('Jaap'), bot('Opa Dirk'), bot('Sjaak'), bot('Truus')],
    points: [0, 0, 0, 0], status: ['in', 'in', 'in', 'in'], answered: [false, false, false, false],
    claims: [false, false, false, false], armoede: [false, false, false, false], checks: [],
    hand: ['JH', 'TS', '7C', 'AD'], legal: ['JH', 'TS', '7C', 'AD'], canToep: true, canClaim: false,
    rule: 'Je komt uit: speel wat je wilt', rounds: [],
    ...over,
  };
}

test('the order of a suit: boer lowest, 10 highest', () => {
  const order = ['JH', 'QH', 'KH', 'AH', '7H', '8H', '9H', 'TH'];
  order.forEach((c, i) => assert.equal(strength(c), i));
});

test('witte and vuile was', () => {
  assert.equal(wasKind(['JH', 'QS', 'KD', 'AC']), 'witte');
  assert.equal(wasKind(['JH', 'QS', 'KD', '7C']), 'vuile');
  assert.equal(wasKind(['JH', 'QS', '7D', '7C']), '');
  assert.equal(wasKind(['JH', 'QS', 'KD', '8C']), '');
  assert.equal(wasKind(['JH', 'QS', 'KD']), '');
});

test('seats: you at the bottom, the others clockwise over the top', () => {
  const s = table({ you: 2 });
  assert.equal(seatAngle(s, 2), 270);
  assert.deepEqual([3, 0, 1].map(k => seatAngle(s, k)), [150, 90, 30]);
  // Alone with one other: opposite, at the top.
  assert.equal(seatAngle({ you: 1, players: [{}, {}] }, 0), 90);
  // Six: evenly over the arc, left to right.
  const six = { you: 0, players: Array(6).fill({}) };
  assert.deepEqual([1, 2, 3, 4, 5].map(k => seatAngle(six, k)), [170, 130, 90, 50, 10]);
  assert.deepEqual(onEllipse(90, 40, 40), { x: 50, y: 10 });
  assert.deepEqual(onEllipse(270, 40, 40), { x: 50, y: 90 });
});

test('seat status', () => {
  const s = table({ status: ['in', 'gepast', 'betrapt', 'in'], points: [0, 3, 1, 9], armoede: [false, false, false, true] });
  assert.equal(seatStatus(s, 1), 'gepast');
  assert.equal(seatStatus(s, 2), 'betrapt');
  assert.equal(seatStatus(s, 3), 'armoede');
  assert.equal(seatStatus({ ...s, points: [0, 10, 0, 0] }, 1), 'eruit');
  assert.ok(isOut({ ...s, points: [0, 10, 0, 0] }, 1));
  assert.equal(seatStatus({ ...s, phase: 'was', nextAt: 1, answered: [false, true, false, false], status: ['in', 'in', 'in', 'in'] }, 1), 'klaar');
  assert.equal(seatStatus({ ...s, players: [s.players[0], { ...s.players[1], left: true }, ...s.players.slice(2)] }, 1), 'vertrokken');
});

test('the prompt asks what the round awaits', () => {
  // Your turn to play: toep first, or a card.
  let q = prompt(table());
  assert.equal(q.text, 'Je komt uit: speel wat je wilt');
  assert.deepEqual(q.actions.map(a => [a.t, a.label]), [['toep', 'Toep!']]);
  assert.equal(prompt(table({ canToep: false, tricks: 3 })).sub,
    'De laatste slag: wie die haalt, wint het potje. Toepen heeft geen zin: wie nog meedoet, kan niet meer passen.');
  assert.equal(prompt(table({ canToep: true, tricks: 3 })).sub, 'De laatste slag: wie die haalt, wint het potje.');
  // Someone else's turn.
  assert.equal(prompt(table({ turn: 1 })).text, 'Opa Dirk (AI) is aan de beurt.');
  // The time for a was, with a vuile was in hand.
  q = prompt(table({ phase: 'was', turn: -1, nextAt: 99, canClaim: true, hand: ['JH', 'QS', 'KD', '7C'] }));
  assert.match(q.text, /vuile was/);
  assert.deepEqual(q.actions.map(a => [a.t, a.play, a.kind, a.label]), [['was', true, 'go', 'Vuile was!'], ['was', false, 'ghost', 'Geen']]);
  assert.equal(q.countdown, 99);
  // No was in hand: claiming one is a bluff; with the stock empty only "Geen was".
  assert.equal(prompt(table({ phase: 'was', turn: -1, nextAt: 99, canClaim: true })).actions[0].kind, 'bluff');
  assert.deepEqual(prompt(table({ phase: 'was', turn: -1, nextAt: 99 })).actions.map(a => a.label), ['Geen']);
  assert.equal(prompt(table({ phase: 'was', turn: -1, nextAt: 0 })).text, 'Er wordt gedeeld…');
  // A toep: go along or pass, at the stake before it; or toep again.
  q = prompt(table({ phase: 'toep', turn: 0, toeper: 2, stake: 3 }));
  assert.equal(q.text, 'Sjaak (AI) toept: de inzet is nu 3. Ga je mee?');
  assert.deepEqual(q.actions.map(a => a.label), ['Meegaan', 'Passen']);
  assert.equal(q.actions[1].sub, '2 strafpunten');
  // Passing costs the stake you last agreed to: here 1, from before the first toep.
  q = prompt(table({ phase: 'toep', turn: 0, toeper: 2, stake: 3, passCost: 1 }));
  assert.equal(q.actions[1].sub, '1 strafpunt');
  assert.match(q.sub, /Passen kost 1 strafpunt,/);
  // A vuile was the stock has no new cards for.
  assert.match(prompt(table({ hand: ['JH', 'QS', 'KD', '7C'], stock: 0, opts: { was: true } })).sub, /^Een vuile was, maar de stapel is op/);
  q = prompt(table({ phase: 'toep', turn: 0, toeper: 2, stake: 3, canRaise: true }));
  assert.deepEqual(q.actions.map(a => [a.t, a.label, a.sub]), [['answer', 'Meegaan', undefined], ['overtoep', 'Overtoepen', 'inzet 3 → 4'], ['answer', 'Passen', '2 strafpunten']]);
  // Anti-lijntoep: no passing.
  q = prompt(table({ phase: 'toep', turn: 0, toeper: 2, stake: 2, mustStay: true }));
  assert.deepEqual(q.actions.map(a => a.label), ['Meegaan']);
  assert.match(q.sub, /^Anti-lijntoep/);
  // No toep: on armoede, or out at the stake already, or the koningsspel.
  assert.equal(prompt(table({ canToep: false, armoede: [true, false, false, false], points: [9, 0, 0, 0] })).sub, 'Op armoede kun je niet toepen.');
  assert.match(prompt(table({ canToep: false, points: [8, 0, 0, 0], stake: 2 })).sub, /lig je er bij verlies al uit/);
  assert.equal(prompt(table({ canToep: false, koning: true, size: 8, tricks: 3 })).sub, 'Koningsspel: er wordt niet getoept.');
  assert.equal(prompt(table({ canToep: false, koning: true, size: 8, tricks: 7 })).sub,
    'De laatste slag: wie die haalt, wint het potje. Koningsspel: er wordt niet getoept.');
  // You raised last: someone else first.
  assert.equal(prompt(table({ canToep: false, toeper: 0, stake: 5, points: [1, 6, 0, 0], tricks: 3 })).sub,
    'De laatste slag: wie die haalt, wint het potje. Jij toepte het laatst: eerst moet een ander toepen.');
  // The koningsspel: lay away.
  q = prompt(table({ phase: 'discard', koning: true, size: 8, lay: 3, hand: Array(11).fill('7H') }));
  assert.equal(q.text, 'Koningsspel: leg 3 kaarten dicht weg.');
  assert.equal(q.lay, 3);
  assert.equal(prompt(table({ phase: 'discard', turn: 1, lay: 0 })).text, 'Koningsspel: Opa Dirk (AI) legt kaarten weg…');
  // A was again, with the new cards.
  q = prompt(table({ phase: 'was', turn: -1, nextAt: 99, canClaim: true, wasRound: 2, hand: ['JH', 'QS', 'KD', '7C'] }));
  assert.equal(q.text, 'Je hebt weer een vuile was: ruil je hem voor vier nieuwe kaarten?');
  assert.equal(prompt(table({ phase: 'was', turn: -1, nextAt: 99, canClaim: true, wasRound: 2 })).text, 'Je nieuwe kaarten: weer een vuile was?');
  assert.match(prompt(table({ phase: 'toep', turn: 0, toeper: -1, stake: 2 })).text, /^Armoede/);
  // A was claimed by someone else: check it or not.
  q = prompt(table({ phase: 'check', turn: 0, claimant: 3 }));
  assert.deepEqual(q.actions.map(a => a.label), ['Controleren', 'Laten gaan']);
  assert.equal(prompt(table({ phase: 'check', turn: 1, claimant: 0 })).actions.length, 0);
  // Out of the round: look on.
  assert.match(prompt(table({ status: ['gepast', 'in', 'in', 'in'] })).text, /^Je hebt gepast/);
  assert.equal(prompt(table({ phase: 'handEnd' })), null);
});

test('the summary of a round, from your seat', () => {
  const s = table({ phase: 'handEnd', points: [2, 0, 3, 1] });
  assert.deepEqual(roundHeadline(s, { winner: 0, stake: 2, tricks: true, gains: [0, 2, 2, 1] }),
    { title: 'Jij wint het potje!', sub: 'Met de laatste slag, bij inzet 2.', cls: 'good' });
  const lost = roundHeadline({ ...s, status: ['gepast', 'in', 'gepast', 'uit'] }, { winner: 1, stake: 2, tricks: false, gains: [1, 0, 1, 0] });
  assert.equal(lost.title, 'Opa Dirk (AI) wint het potje');
  assert.equal(lost.sub, 'De anderen pasten, bij inzet 2. Jij krijgt 1 strafpunt.');
  assert.equal(lost.cls, 'bad');
  // A bluff caught (rule bluf off) left one seat in: nobody passed.
  assert.equal(roundHeadline({ ...s, status: ['in', 'betrapt', 'gepast', 'uit'] }, { winner: 0, stake: 1, tricks: false, gains: [0, 1, 1, 0] }).sub,
    'Niemand anders doet nog mee, bij inzet 1.');
  assert.equal(roundHeadline({ ...s, status: ['in', 'eruit', 'gepast', 'uit'] }, { winner: 0, stake: 1, tricks: false, gains: [0, 1, 1, 0] }).sub,
    'Niemand anders doet nog mee, bij inzet 1.');
  assert.deepEqual(standings(s).map(x => x.seat), [1, 3, 0, 2]);
  assert.equal(roundHeadline(s, { winner: 0, stake: 1, tricks: true, boer: true, gains: [-1, 1, 1, 1] }).sub,
    'Met de boer in de laatste slag, bij inzet 1: een strafpunt eraf.');
  assert.equal(roundHeadline(s, { winner: 2, stake: 1, tricks: true, koning: true, gains: [1, 1, 0, 1] }).sub,
    'Het koningsspel: Sjaak (AI) haalde de laatste slag. Jij krijgt 1 strafpunt.');
});

test('the overview of a round at game over: only what was on the table', () => {
  const s = table({
    phase: 'gameOver', turn: -1,
    rounds: [
      { hand: 1, dealer: 3, winner: 2, stake: 2, tricks: true, boer: false, koning: false, gains: [2, 1, 0, 1], points: [3, 8, 0, 9], out: [false, false, false, false] },
      { hand: 2, dealer: 0, winner: 1, stake: 2, tricks: false, boer: false, koning: false, gains: [1, 0, 1, 1], points: [4, 8, 1, 10], out: [false, false, false, true] },
    ],
    courses: [
      [
        { type: 'claims', seats: [1, 2] },
        { type: 'wasDone', claimant: 1, checker: -1, kind: '', cards: [], genuine: false, washed: true, shown: false },
        { type: 'wasDone', claimant: 2, checker: 0, kind: 'vuile', cards: ['JH', 'QS', 'KD', '7C'], genuine: true, washed: true, shown: false },
        { type: 'play', seat: 0, card: 'TS' }, { type: 'play', seat: 1, card: '7S' },
        { type: 'toep', seat: 2, stake: 2, over: false },
        { type: 'answer', seat: 3, stay: false, points: 1 }, { type: 'answer', seat: 0, stay: true, points: 0 },
        { type: 'answer', seat: 1, stay: false, points: 1 },
        { type: 'play', seat: 2, card: '8S' }, { type: 'trick', winner: 0, last: false },
        { type: 'play', seat: 0, card: '9H' }, { type: 'play', seat: 2, card: 'TH' }, { type: 'trick', winner: 2, last: true },
      ],
      [
        { type: 'armoede', seats: [1], stake: 2 },
        { type: 'answer', seat: 2, stay: false, points: 1 }, { type: 'answer', seat: 3, stay: false, points: 1 },
        { type: 'answer', seat: 0, stay: false, points: 1 },
      ],
    ],
  });
  const v = courseView(s, 0);
  assert.equal(v.title, 'Potje 1 van 2');
  assert.equal(v.sub, 'Gever: Truus (AI).');
  assert.deepEqual(v.parts.map(p => p.title), ['Voor de eerste kaart', 'Slag 1', 'Slag 2', 'Uitslag']);
  assert.deepEqual(v.parts[0].items.map(i => i.text), [
    'Opa Dirk (AI) en Sjaak (AI) melden een vuile was.',
    'Niemand controleert: Opa Dirk (AI) krijgt vier nieuwe kaarten.',
    'Jij controleert Sjaak (AI): een echte vuile was, ♥B ♠V ♦H ♣7. Jij krijgt een strafpunt, Sjaak (AI) vier nieuwe kaarten.',
  ]);
  // Trick 1: the cards in the order played, the toep and answers between
  // them; Opa Dirk passed after his card, which no longer counts.
  const t1 = v.parts[1].items;
  assert.deepEqual(t1.map(i => i.text ?? i.cards.map(c => `${c.card}${c.win ? '+' : ''}${c.void ? '-' : ''}`).join(' ')), [
    'TS+ 7S-', 'Sjaak (AI) toept: inzet 2.', 'Truus (AI) past: 1 strafpunt.', 'Jij gaat mee.', 'Opa Dirk (AI) past: 1 strafpunt.', '8S', 'Jij haalt de slag.',
  ]);
  assert.equal(t1[0].cards[0].name, 'Jij');
  assert.deepEqual(v.parts[3].items.map(i => i.text), [
    'Sjaak (AI) haalt de laatste slag en wint het potje, bij inzet 2.', 'Strafpunten: jij +2, Opa Dirk (AI) +1, Truus (AI) +1.',
  ]);
  const w = courseView(s, 1);
  assert.deepEqual(w.parts.map(p => p.title), ['Voor de eerste kaart', 'Uitslag']);
  // A toep before the first card of a trick belongs to that trick.
  const lead = courseView({ ...s, courses: [[
    { type: 'play', seat: 0, card: 'TS' }, { type: 'play', seat: 1, card: '7S' }, { type: 'play', seat: 2, card: '8S' },
    { type: 'play', seat: 3, card: '9S' }, { type: 'trick', winner: 0, last: false },
    { type: 'toep', seat: 0, stake: 2, over: false }, { type: 'answer', seat: 1, stay: true, points: 0 },
    { type: 'play', seat: 0, card: 'AH' },
  ], []] }, 0);
  assert.deepEqual(lead.parts.map(p => p.title), ['Slag 1', 'Slag 2', 'Uitslag']);
  assert.deepEqual(lead.parts[1].items.map(i => i.text ?? i.cards.map(c => c.card).join(' ')), ['Jij toept: inzet 2.', 'Opa Dirk (AI) gaat mee.', 'AH']);
  assert.equal(w.parts[0].items[0].text, 'Armoede: Opa Dirk (AI) staat op 9 strafpunten. De inzet is 2.');
  assert.deepEqual(w.parts[1].items.map(i => i.text), [
    'De anderen pasten: Opa Dirk (AI) wint het potje, bij inzet 2.', 'Strafpunten: jij +1, Sjaak (AI) +1, Truus (AI) +1.', 'Truus (AI) ligt eruit.',
  ]);
  assert.equal(courseView(s, 2), null);
  // A caught bluff: its cards were shown; the claimant plays on face up.
  const bluff = table({ phase: 'gameOver', rounds: s.rounds.slice(0, 1), courses: [[
    { type: 'claims', seats: [0] },
    { type: 'wasDone', claimant: 0, checker: 3, kind: '', cards: ['JH', 'QS', 'KD', '8C'], genuine: false, washed: false, shown: false },
  ]] });
  assert.equal(courseView(bluff, 0).parts[0].items[1].text, 'Truus (AI) controleert jou: bluf, ♥B ♠V ♦H ♣8. Jij krijgt een strafpunt en speelt open verder.');
  // Rule bluf off: the claimant sits out; at the limit, out of the match.
  assert.match(courseView({ ...bluff, opts: { ...bluff.opts, bluf: false } }, 0).parts[0].items[1].text, /Jij krijgt een strafpunt en doet dit potje niet meer mee\.$/);
  const atNine = { ...bluff, opts: { ...bluff.opts, armoede: false }, rounds: [s.rounds[0], { ...s.rounds[0], hand: 2 }], courses: [[], bluff.courses[0]] };
  atNine.rounds[0] = { ...s.rounds[0], points: [9, 8, 0, 9] };
  assert.match(courseView(atNine, 1).parts[0].items[1].text, /Jij krijgt een strafpunt en ligt eruit\.$/);
  // A checker on armoede who checks a genuine witte was goes out.
  const checkOut = { ...atNine, opts: bluff.opts, courses: [[], [
    { type: 'claims', seats: [2] },
    { type: 'wasDone', claimant: 2, checker: 3, kind: 'witte', cards: ['JH', 'QS', 'KD', 'AC'], genuine: true, washed: true, shown: false },
  ]] };
  assert.equal(courseView(checkOut, 1).parts[0].items[1].text,
    'Truus (AI) controleert Sjaak (AI): een echte witte was, ♥B ♠V ♦H ♣A. Truus (AI) krijgt een strafpunt en ligt eruit; Sjaak (AI) krijgt vier nieuwe kaarten.');
  // A second claim after new cards, and nobody passed when the others sat out.
  const again = courseView({ ...bluff, courses: [[
    { type: 'claims', seats: [2] }, { type: 'wasDone', claimant: 2, checker: -1, kind: '', cards: [], genuine: false, washed: true, shown: false },
    { type: 'claims', seats: [2] },
  ]], rounds: [{ ...s.rounds[0], winner: 2, tricks: false }] }, 0);
  assert.equal(again.parts[0].items[2].text, 'Sjaak (AI) meldt weer een vuile was.');
  assert.equal(again.parts.at(-1).items[0].text, 'Niemand anders doet nog mee: Sjaak (AI) wint het potje, bij inzet 2.');
});

test('the piles of a vuile was: handed in, not a caught bluff', () => {
  const s = table({ checks: [{ claimant: 1, checker: -1, kind: '' }, { claimant: 1, checker: 2, kind: 'vuile' }, { claimant: 3, checker: 0, kind: '' }] });
  assert.deepEqual([0, 1, 2, 3].map(k => washes(s, k)), [0, 2, 0, 0]);
});

test('variant and manual follow the options', () => {
  assert.equal(variantText({ limit: 15, was: true, armoede: false }), 'Toepen tot 15 strafpunten, met vuile was');
  assert.equal(variantText({ limit: 10 }), 'Toepen tot 10 strafpunten');
  assert.equal(variantText({ limit: 10, was: true, armoede: true, koning: true, boer: true, lijntoep: true }),
    'Toepen tot 10 strafpunten, met vuile was, armoede, koningsspel, boer eraf en anti-lijntoep');
  const tabs = manual({ limit: 15, was: false, armoede: true, koning: true, boer: false, lijntoep: true });
  assert.deepEqual(tabs.map(t => t.title), ['Spelregels', 'Extra regels', 'Tips', 'Begrippen', 'Bediening']);
  assert.ok(tabs.find(t => t.id === 'tips').parts.flatMap(([, ps]) => ps).some(p => /hoogste kaart voor de laatste slag/.test(p)));
  const part = (id, title) => Object.fromEntries(tabs.find(t => t.id === id).parts)[title];
  assert.deepEqual(part('extra', 'Vuile was'), ['Aan deze tafel speel je zonder vuile was.']);
  assert.match(part('extra', 'Armoede')[0], /14 strafpunten/);
  // Who is on armoede leads; without the rule only voorhand is named.
  assert.ok(part('extra', 'Armoede').some(p => /^Wie op armoede staat, komt uit\. .*de eerste na de gever/.test(p)));
  assert.ok(part('extra', 'Armoede').some(p => /^Wie niet op armoede staat, zegt vóór de eerste kaart om de beurt of die meegaat, te beginnen links van wie uitkomt\./.test(p)));
  assert.match(part('regels', 'Een potje')[0], /komt uit, tenzij iemand anders op armoede staat\.$/);
  assert.match(part('begrippen', 'Voorhand')[0], /tenzij iemand anders op armoede staat\.$/);
  const poorOff = manual({ armoede: false });
  const offPart = (id, title) => Object.fromEntries(poorOff.find(t => t.id === id).parts)[title];
  assert.match(offPart('regels', 'Een potje')[0], /De speler links van de gever komt uit\.$/);
  assert.equal(offPart('begrippen', 'Voorhand')[0], 'Wie links van de gever zit. Die komt het eerst uit.');
  assert.match(part('extra', 'Anti-lijntoep')[0], /hoogstens twee keer/);
  assert.deepEqual(part('extra', 'Boer: een punt eraf'), ['Aan deze tafel levert de boer niets op.']);
  assert.match(part('regels', 'Eruit en winnen')[0], /^Wie 15 strafpunten/);
  assert.ok(part('regels', 'Toepen').some(p => /overtoepen/.test(p)));
  // Every term once, in alphabetical order.
  const terms = tabs.find(t => t.id === 'begrippen').parts.map(([t]) => t);
  assert.deepEqual(terms, [...terms].sort((a, b) => a.localeCompare(b, 'nl')));
  assert.match(manual({}, { touch: true }).at(-1).parts[0][1][0], /^Tik een kaart/);
  // Bediening ends with what the server keeps, at a table and away from one.
  for (const t of [tabs, manual({}, { table: false })]) {
    const [title, [text]] = t.find(tab => tab.id === 'bediening').parts.at(-1);
    assert.equal(title, 'Privacy');
    assert.match(text, /statistieken en om het spel te verbeteren.*12 maanden/);
  }
  // Away from a table: every extra rule explained, with its default.
  const home = Object.fromEntries(manual({}, { table: false }).find(t => t.id === 'extra').parts);
  assert.match(home['Anti-lijntoep'][0], /^Lijntoepen/);
  assert.equal(home['Anti-lijntoep'].at(-1), 'Dit kies je bij een nieuw spel; standaard staat het uit.');
  assert.equal(home.Koningsspel.at(-1), 'Dit kies je bij een nieuw spel; standaard staat het aan.');
  assert.ok(home['Vuile was'].some(p => /open uit/.test(p)));
});

test('the reasoning of the AI: your decision, alone, and the sheet', () => {
  assert.ok(yours(table()));
  assert.ok(!yours(table({ turn: 1 })));
  assert.ok(yours(table({ phase: 'was', turn: -1, nextAt: 9 })));
  assert.ok(!yours(table({ phase: 'was', turn: -1, nextAt: 9, answered: [true, false, false, false] })));
  assert.ok(!yours(table({ status: ['gepast', 'in', 'in', 'in'] })));
  assert.ok(alone(table()));
  assert.ok(!alone(table({ players: [player('Jaap'), player('Kees'), bot('Sjaak'), bot('Truus')] })));
  assert.equal(cardLabel('TH'), '♥10');
  assert.equal(cardLabel('JS'), '♠B');
  const r = whyRows({ decision: 'kaart', advice: 'Speel ♥10', why: 'Omdat.', rule: 'Kom laag uit.', ruleCard: '7C', worlds: 240,
    options: [{ cards: ['TH'], value: 0.62, best: true }, { cards: ['7C'], value: 0.3 }, { label: 'Toepen', value: 0.62 }] });
  assert.deepEqual(r.options, [
    { label: '♥10', value: '62% kans op de laatste slag', best: true },
    { label: '♣7', value: '30% kans op de laatste slag', best: false },
    { label: 'Toepen', value: '62% kans op de laatste slag', best: false }]);
  assert.equal(r.rule, 'Vuistregel: Kom laag uit.');
  assert.equal(r.ruleCard, 'De vuistregel speelt ♣7.');
  assert.match(r.note, /^240 verdelingen/);
  const a = whyRows({ decision: 'antwoord', options: [{ label: 'Meegaan', value: 1.5, points: true }, { label: 'Passen', value: 1, points: true, best: true }] });
  assert.deepEqual(a.options.map(o => o.value), ['1,5 strafpunten verwacht', '1 strafpunt verwacht']);
  const c = whyRows({ decision: 'controle', options: [{ label: 'Controleren', value: 0.7, best: true }, { label: 'Laten gaan', value: 0.3 }] });
  assert.deepEqual(c.options.map(o => o.value), ['70% kans op bluf', '30% kans dat die echt is']);
  assert.equal(whyRows({ decision: 'wegleggen', options: [{ cards: ['7C', '8C', 'JD'], value: 0.5, best: true }] }).options[0].label, '♣7 ♣8 ♦B');
});
