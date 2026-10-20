// web/js/util.js without a browser: node --test test/ui/app-util.test.mjs
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
const { store, roemText, cap, playerName } = await import('../../web/js/util.js');

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
