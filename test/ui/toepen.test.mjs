// web/js/toepen-rules.js without a browser: node --test test/ui/toepen.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  strength, wasKind, seatAngle, onEllipse, seatStatus, prompt, roundHeadline, standings, variantText, rules, isOut,
} from '../../web/js/toepen-rules.js';

const player = name => ({ name, bot: false, connected: true });
const bot = name => ({ name: `${name} (AI)`, bot: true, connected: true });

// A table of four in phase play, you at seat 0 on turn.
function table(over = {}) {
  return {
    game: 'toepen', phase: 'play', you: 0, turn: 0, stake: 1, toeper: -1, claimant: -1, nextAt: 0, tricks: 0,
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
  assert.deepEqual(q.actions.map(a => [a.t, a.play, a.kind]), [['was', true, 'go'], ['was', false, 'ghost']]);
  assert.equal(q.countdown, 99);
  // No was in hand: claiming one is a bluff; with the stock empty only "Geen was".
  assert.equal(prompt(table({ phase: 'was', turn: -1, nextAt: 99, canClaim: true })).actions[0].kind, 'bluff');
  assert.deepEqual(prompt(table({ phase: 'was', turn: -1, nextAt: 99 })).actions.map(a => a.label), ['Geen was']);
  assert.equal(prompt(table({ phase: 'was', turn: -1, nextAt: 0 })).text, 'Er wordt gedeeld…');
  // A toep: go along or pass, at the stake before it.
  q = prompt(table({ phase: 'toep', turn: 0, toeper: 2, stake: 3 }));
  assert.equal(q.text, 'Sjaak (AI) toept: de inzet is nu 3. Ga je mee?');
  assert.equal(q.actions[1].sub, '2 strafpunten');
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
});

test('variant and rules follow the options', () => {
  assert.equal(variantText({ limit: 15, was: true, armoede: false }), 'Toepen tot 15 strafpunten, met was');
  assert.equal(variantText({ limit: 10 }), 'Toepen tot 10 strafpunten');
  const parts = Object.fromEntries(rules({ limit: 15, was: false, armoede: true }));
  assert.deepEqual(parts['Witte en vuile was'], ['Aan deze tafel speel je zonder was.']);
  assert.match(parts.Armoede[0], /14 strafpunten/);
  assert.match(parts['Eruit en winnen'][0], /^Wie 15 strafpunten/);
});
