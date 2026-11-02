// web/toepen/js/rules.js without a browser: node --test test/ui/toepen.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  strength, wasKind, seatAngle, onEllipse, seatStatus, prompt, roundHeadline, standings, variantText, manual, isOut, washes,
} from '../../web/toepen/js/rules.js';

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
  assert.equal(prompt(table({ canToep: false, tricks: 3 })).sub, 'De laatste slag: wie die haalt, wint het potje.');
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
  assert.equal(prompt(table({ canToep: false, koning: true, size: 8, tricks: 7 })).sub, 'De laatste slag: wie die haalt, wint het potje.');
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
  const lost = roundHeadline(s, { winner: 1, stake: 2, tricks: false, gains: [1, 0, 1, 0] });
  assert.equal(lost.title, 'Opa Dirk (AI) wint het potje');
  assert.equal(lost.sub, 'De anderen pasten, bij inzet 2. Jij krijgt 1 strafpunt.');
  assert.equal(lost.cls, 'bad');
  assert.deepEqual(standings(s).map(x => x.seat), [1, 3, 0, 2]);
  assert.equal(roundHeadline(s, { winner: 0, stake: 1, tricks: true, boer: true, gains: [-1, 1, 1, 1] }).sub,
    'Met de boer als laatste slag, bij inzet 1: een strafpunt eraf.');
  assert.equal(roundHeadline(s, { winner: 2, stake: 1, tricks: true, koning: true, gains: [1, 1, 0, 1] }).sub,
    'Het koningsspel: Sjaak (AI) haalde de laatste slag. Jij krijgt 1 strafpunt.');
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
  assert.deepEqual(tabs.map(t => t.title), ['Spelregels', 'Extra regels', 'Begrippen', 'Bediening']);
  const part = (id, title) => Object.fromEntries(tabs.find(t => t.id === id).parts)[title];
  assert.deepEqual(part('extra', 'Vuile was'), ['Aan deze tafel speel je zonder vuile was.']);
  assert.match(part('extra', 'Armoede')[0], /14 strafpunten/);
  assert.match(part('extra', 'Anti-lijntoep')[0], /hoogstens twee keer/);
  assert.deepEqual(part('extra', 'Boer: een punt eraf'), ['Aan deze tafel levert de boer niets op.']);
  assert.match(part('regels', 'Eruit en winnen')[0], /^Wie 15 strafpunten/);
  assert.ok(part('regels', 'Toepen').some(p => /overtoepen/.test(p)));
  // Every term once, in alphabetical order.
  const terms = tabs.find(t => t.id === 'begrippen').parts.map(([t]) => t);
  assert.deepEqual(terms, [...terms].sort((a, b) => a.localeCompare(b, 'nl')));
  assert.match(manual({}, { touch: true }).at(-1).parts[0][1][0], /^Tik een kaart/);
  // Away from a table: every extra rule explained, with its default.
  const home = Object.fromEntries(manual({}, { table: false }).find(t => t.id === 'extra').parts);
  assert.match(home['Anti-lijntoep'][0], /^Lijntoepen/);
  assert.equal(home['Anti-lijntoep'].at(-1), 'Dit kies je bij een nieuw spel; standaard staat het uit.');
  assert.equal(home.Koningsspel.at(-1), 'Dit kies je bij een nieuw spel; standaard staat het aan.');
  assert.ok(home['Vuile was'].some(p => /open uit/.test(p)));
});
