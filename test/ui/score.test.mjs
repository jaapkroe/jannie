// games/toepen/web/js/scorecalc.js without a browser: node --test test/ui/score.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  course, points, matchWinner, streaks, runs, passes, startStake, defaultGain, validRound, standings, namesError, cleanName, cleanCode, chartSpec, LIJN,
} from '../../games/toepen/web/js/scorecalc.js';

// A round of n players: w won, gains as given, who went away.
const round = (winner, gains, passed = gains.map(() => false)) => ({ winner, gains, passed });
const sheet = (names, rounds, limit = 10) => ({ code: 'ABCD', limit, names, rounds, version: 1 });

test('the points after every round, the boer taking one off', () => {
  const s = sheet(['Jaap', 'Kees', 'Truus'], [round(0, [0, 2, 1], [false, false, true]), round(1, [3, -1, 3])]);
  assert.deepEqual(course(s), [[0, 0, 0], [0, 2, 1], [3, 1, 4]]);
  assert.deepEqual(points(s), [3, 1, 4]);
  assert.deepEqual(points(sheet(['A', 'B'], [])), [0, 0]);
});

test('the match is won by the one left under the limit', () => {
  const two = sheet(['A', 'B', 'C'], [round(0, [0, 9, 4])]);
  assert.equal(matchWinner(two), -1);
  const won = sheet(['A', 'B', 'C'], [round(0, [0, 9, 4]), round(0, [0, 2, 6])]);
  assert.equal(matchWinner(won), 0);
  // A round that puts everyone out: the fewest points win.
  const all = sheet(['A', 'B'], [round(-1, [12, 11])]);
  assert.equal(matchWinner(all), 1);
  assert.equal(matchWinner(sheet(['A', 'B'], [])), -1);
});

test('lijntoepers: going away rounds in a row', () => {
  const s = sheet(['A', 'B', 'C'], [
    round(0, [0, 1, 1], [false, true, false]),
    round(0, [0, 1, 2], [false, true, false]),
    round(2, [2, 1, 0], [false, true, false]),
    round(1, [1, 0, 1], [false, false, true]),
    round(0, [0, 1, 1], [false, true, true]),
  ]);
  assert.deepEqual(streaks(s).map(r => r[1]), [1, 2, 3, 0, 1]);
  assert.deepEqual(streaks(s).map(r => r[2]), [0, 0, 0, 1, 2]);
  assert.deepEqual(runs(s), [0, 1, 2]);
  assert.deepEqual(passes(s), [0, 4, 2]);
  assert.ok(runs(s)[2] >= LIJN);
});

test('rounds after a player is out leave the streak be', () => {
  const s = sheet(['A', 'B', 'C'], [
    round(0, [0, 4, 9], [false, false, true]),
    round(0, [0, 3, 2], [false, false, true]), // C goes out going away
    round(0, [0, 2, 0]),
  ]);
  assert.deepEqual(streaks(s).map(r => r[2]), [1, 2, 0]);
  assert.equal(runs(s)[2], 2);
});

test('what a round is worth by default', () => {
  const at = (k, o) => defaultGain({ stake: 3, winner: 0, passed: false, out: false, ...o }, k);
  assert.equal(at(0), 0, 'the winner');
  assert.equal(at(1), 3, 'played to the end and lost');
  assert.equal(at(1, { passed: true }), 2, 'went away on the last toep');
  assert.equal(defaultGain({ stake: 1, winner: 0, passed: true, out: false }, 1), 1, 'at least a point');
  assert.equal(at(1, { out: true }), 0, 'out');
  assert.equal(startStake([3, 4, 9], 10), 2, 'armoede');
  assert.equal(startStake([3, 4, 8], 10), 1);
  assert.equal(startStake([3, 13, 12], 15), 1);
  assert.equal(startStake([3, 14, 12], 15), 2);
});

test('a round needs a winner who stayed, and points within bounds', () => {
  assert.ok(validRound(round(1, [1, 0, 2]), 3));
  assert.ok(!validRound(round(-1, [1, 0, 2]), 3));
  assert.ok(!validRound(round(3, [1, 0, 2]), 3));
  assert.ok(!validRound(round(1, [1, 0, 2], [false, true, false]), 3));
  assert.ok(!validRound(round(1, [1, 0, 31]), 3));
  assert.ok(!validRound(round(1, [1, 0]), 3));
});

test('the standings: in before out, fewest points first, the winner on top', () => {
  const s = sheet(['A', 'B', 'C', 'D'], [round(1, [4, 0, 11, 2])]);
  assert.deepEqual(standings(s).map(x => x.name), ['B', 'D', 'A', 'C']);
  assert.deepEqual(standings(s).map(x => x.out), [false, false, false, true]);
  const won = sheet(['A', 'B', 'C'], [round(2, [10, 12, 0])]);
  assert.deepEqual(standings(won).map(x => x.name), ['C', 'A', 'B']);
});

test('the chart: a line ends where its player went out, a ring where a lijntoeper went away again', () => {
  assert.equal(chartSpec(sheet(['A', 'B'], [])), null);
  const s = sheet(['A', 'B', 'C'], [
    round(0, [0, 1, 1], [false, true, false]),
    round(0, [0, 1, 9], [false, true, false]),
    { ...round(1, [2, -1, 0]), stake: 2 },
  ]);
  const c = chartSpec(s);
  assert.deepEqual(c.names, ['A', 'B', 'C']);
  assert.deepEqual(c.pts, [[0, 0, 0], [0, 1, 1], [0, 2, 10], [2, 1, 10]]);
  assert.deepEqual(c.ends, [3, 3, 2]);
  assert.deepEqual(c.rings, [[], [2], []]);
  assert.equal(c.ringLabel, `${LIJN}× of vaker achter elkaar weg`);
  assert.deepEqual(c.out, [false, false, true]);
  assert.deepEqual(c.limit, { value: 10, label: 'eruit bij 10' });
  assert.equal(c.colors, undefined);
  assert.deepEqual(c.tips[0], { title: 'Begin', rows: [0, 1, 2].map(k => ({ k, note: '', value: 0 })) });
  assert.deepEqual(c.tips[2], { title: 'Na potje 2', rows: [
    { k: 0, note: '🏆', value: 0 }, { k: 1, note: 'weg (2×), +1', value: 2 }, { k: 2, note: '+9', value: 10 }] });
  // Out: the row says so, without the round's note.
  assert.deepEqual(c.tips[3], { title: 'Na potje 3 · inzet 2', rows: [
    { k: 1, note: '🏆 −1', value: 1 }, { k: 0, note: '+2', value: 2 }, { k: 2, note: '', value: 'eruit', out: true }] });
  assert.match(c.label, /3 potjes/);
});

test('names and codes', () => {
  assert.equal(cleanName('  Jaap   de  Vries '), 'Jaap de Vries');
  assert.equal(cleanName('x'.repeat(30)).length, 20);
  assert.equal(namesError(['Jaap']), 'Vul minstens twee namen in.');
  assert.equal(namesError(['Jaap', 'jaap ']), 'jaap staat er twee keer in.');
  assert.equal(namesError(['Jaap', ' ']), 'Geef iedereen een naam.');
  assert.equal(namesError(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']), 'Hoogstens 8 spelers.');
  assert.equal(namesError(['Jaap', 'Kees']), '');
  assert.equal(cleanCode(' ab-cd '), 'ABCD');
  assert.equal(cleanCode('oixyzw'), 'XYZW');
});
