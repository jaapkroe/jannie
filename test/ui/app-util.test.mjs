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
  store, cap, playerName, keyboardOpen, textField, DEFAULT_NAME, countWord, versionText, supportURL,
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
