// DOM-free parts of web/js/cards.js: node --test test/ui/cards-unit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUITS, RANKS, parseCard, cardName, cardShort } from '../../web/js/cards.js';

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
