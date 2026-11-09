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
  store, cap, playerName, keyboardOpen, textField, DEFAULT_NAME, countWord, versionText, supportURL, isMyTurn,
  turnOpens,
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

test('cap upper-cases the first letter', () => {
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

test('countWord says a count in Dutch words', () => {
  assert.equal(countWord(1), 'één');
  assert.equal(countWord(3), 'drie');
});

test('a player without a name is "Speler", as the server calls one', () => {
  assert.equal(DEFAULT_NAME, 'Speler');
});

test('versionText: the commit shortened, -dirty kept, "dev" when not filled in', () => {
  assert.equal(versionText('a05a087d1f9ff827b5d8c4f9de0bc387d2c23957'), 'a05a087');
  assert.equal(versionText('a05a087d1f9ff827b5d8c4f9de0bc387d2c23957-dirty'), 'a05a087-dirty');
  // A game of the overlay: both commits.
  assert.equal(versionText('a05a087d1f9ff827b5d8c4f9de0bc387d2c23957.0b1c2d3e4f5a'), 'a05a087.0b1c2d3');
  assert.equal(versionText('a05a087d1f9ff827b5d8c4f9de0bc387d2c23957.0b1c2d3e4f5a-dirty'), 'a05a087.0b1c2d3-dirty');
  assert.equal(versionText('a05a087d1f9ff827b5d8c4f9de0bc387d2c23957.'), 'dev');
  assert.equal(versionText('@VERSION@'), 'dev');
  assert.equal(versionText('dev'), 'dev');
  assert.equal(versionText(''), 'dev');
  assert.equal(versionText(undefined), 'dev');
});

test('supportURL: an https link as it is, nothing when not filled in or not one', () => {
  assert.equal(supportURL('https://pay.example/r/AbC123'), 'https://pay.example/r/AbC123');
  assert.equal(supportURL('https://pay.example/r?a=1&b=2'), 'https://pay.example/r?a=1&b=2');
  for (const v of ['@SUPPORT_URL@', '', undefined, 'https://', 'http://pay.example/r', 'javascript:alert(1)',
    ' https://pay.example/r', 'https://pay.example/a b', 'https://pay.example/"x', 'https://pay.example/<x>']) {
    assert.equal(supportURL(v), '', String(v));
  }
});

test('isMyTurn: without a hook the own seat on turn in a phase of play; a hook decides both ways', () => {
  const plain = { PLAYING: new Set(['play', 'bid']) };
  const st = (turn, phase) => ({ you: 2, turn, phase });
  assert.equal(isMyTurn(plain, st(2, 'play')), true);
  assert.equal(isMyTurn(plain, st(2, 'bid')), true);
  assert.equal(isMyTurn(plain, st(1, 'play')), false, 'another seat');
  assert.equal(isMyTurn(plain, st(2, 'lobby')), false, 'not a phase of play');
  // A hook overrides the default test either way, even outside PLAYING.
  const never = { ...plain, myTurn: () => false };
  const always = { ...plain, myTurn: () => true };
  assert.equal(isMyTurn(never, st(2, 'play')), false);
  assert.equal(isMyTurn(always, st(1, 'play')), true);
  assert.equal(isMyTurn(always, st(1, 'lobby')), true);
  const held = { ...plain, myTurn: s => !s.lesson && s.turn === s.you };
  assert.equal(isMyTurn(held, { ...st(2, 'play'), lesson: { step: 1 } }), false);
  assert.equal(isMyTurn(held, st(2, 'play')), true);
});

test('turnOpens: a turn opens when it becomes the player\'s, or theirs again in another phase', () => {
  const plain = { PLAYING: new Set(['play', 'bid']) };
  const st = (turn, phase) => ({ you: 0, turn, phase });
  assert.equal(turnOpens(plain, null, st(0, 'play')), true, 'the first state');
  assert.equal(turnOpens(plain, st(3, 'play'), st(0, 'play')), true, 'from another seat');
  assert.equal(turnOpens(plain, st(0, 'play'), st(0, 'play')), false, 'still the same turn');
  assert.equal(turnOpens(plain, st(0, 'bid'), st(0, 'play')), true, 'across a phase change');
  assert.equal(turnOpens(plain, st(0, 'lobby'), st(0, 'bid')), true, 'out of the lobby');
  assert.equal(turnOpens(plain, st(0, 'play'), st(1, 'play')), false, 'not theirs');
  assert.equal(turnOpens(plain, st(0, 'play'), st(0, 'lobby')), false, 'not a phase of play');
  // With a hook: the turn opens when the hook turns true, also on the same seat and phase.
  const held = { ...plain, myTurn: s => !s.lesson && s.turn === s.you && plain.PLAYING.has(s.phase) };
  const lesson = { ...st(0, 'play'), lesson: { step: 2 } };
  assert.equal(turnOpens(held, st(3, 'play'), lesson), false, 'held while the step shows');
  assert.equal(turnOpens(held, lesson, st(0, 'play')), true, 'opens when the step goes');
  assert.equal(turnOpens(held, st(0, 'play'), st(0, 'play')), false);
});
