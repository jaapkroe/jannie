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
const { store, roemText, cap, playerName, keyboardOpen, textField, handHeadline, DEFAULT_NAME } = await import('../../web/js/util.js');

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

test('a player without a name is "Speler", as the server calls one', () => {
  assert.equal(DEFAULT_NAME, 'Speler');
});
