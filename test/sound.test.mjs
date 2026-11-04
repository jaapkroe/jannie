// Unit tests for platform/web/js/sound.js against a strict fake WebAudio API.
//   node --test test/sound.test.mjs

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const MODULE = new URL('../platform/web/js/sound.js', import.meta.url).href;
const NAMES = ['card', 'deal', 'shuffle', 'trick', 'trickWon', 'roem', 'trump', 'turn', 'chat',
  'nat', 'pit', 'handWon', 'handLost', 'win', 'lose', 'click', 'error', 'join', 'knock'];
const MAX_LENGTH = {
  card: 0.15, deal: 0.1, shuffle: 0.85, trick: 0.4, trickWon: 0.75, roem: 0.9,
  trump: 1.4, turn: 0.6, chat: 0.2, nat: 1.4, pit: 1.4, handWon: 1.2,
  handLost: 1.1, win: 1.6, lose: 1.15, click: 0.06, error: 0.35, join: 0.6, knock: 0.3,
};

// ---- strict fake WebAudio --------------------------------------------------
// Throws where browsers throw (bad times, exponential ramps to 0, double
// start, ...) and also on out-of-range values and unknown enum strings,
// which browsers would silently clamp or ignore.

const checkNumber = (...xs) => {
  for (const x of xs) if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError(`non-finite ${x}`);
};
const checkTime = (t) => {
  checkNumber(t);
  if (t < 0) throw new RangeError(`negative time ${t}`);
};

class FakeParam {
  constructor(owner, value, min = -3.4e38, max = 3.4e38) {
    Object.assign(this, { owner, min, max, events: [] });
    this.value = value;
  }
  get value() { return this._v; }
  set value(x) { this.check(x); this._v = x; }
  check(x) {
    checkNumber(x);
    if (x < this.min || x > this.max) throw new RangeError(`${x} outside [${this.min}, ${this.max}]`);
  }
  setValueAtTime(v, t) { this.check(v); checkTime(t); this.events.push({ kind: 'set', v, t }); return this; }
  linearRampToValueAtTime(v, t) { this.check(v); checkTime(t); this.events.push({ kind: 'linear', v, t }); return this; }
  exponentialRampToValueAtTime(v, t) {
    this.check(v); checkTime(t);
    if (v <= 0) throw new RangeError('exponential ramp to a value <= 0');
    this.events.push({ kind: 'exp', v, t });
    return this;
  }
  setTargetAtTime(v, t, tc) {
    this.check(v); checkTime(t); checkNumber(tc);
    if (tc < 0) throw new RangeError('negative time constant');
    this.events.push({ kind: 'target', v, t });
    return this;
  }
  cancelScheduledValues(t) { checkTime(t); this.events.push({ kind: 'cancel', t }); return this; }
}

class FakeNode {
  constructor(ctx) {
    this.context = ctx;
    this.outputs = [];
    ctx.nodes.push(this);
  }
  connect(target) {
    const owner = target instanceof FakeParam ? target.owner : target;
    if (!(owner instanceof FakeNode)) throw new TypeError('connect to a non-node');
    if (owner.context !== this.context) throw new Error('InvalidAccessError: other context');
    this.outputs.push(target);
    return target instanceof FakeNode ? target : undefined;
  }
  disconnect() { this.outputs = []; this.disconnected = true; }
  params() { return Object.values(this).filter((x) => x instanceof FakeParam); }
}

const enumProp = (obj, name, allowed, initial) => {
  let value = initial;
  Object.defineProperty(obj, name, {
    get: () => value,
    set: (x) => { if (!allowed.includes(x)) throw new TypeError(`bad ${name} ${x}`); value = x; },
  });
};

class FakeSource extends FakeNode {
  start(when = 0) {
    checkTime(when);
    if (this.startAt !== undefined) throw new Error('InvalidStateError: started twice');
    this.startAt = when;
  }
  stop(when = 0) {
    checkTime(when);
    if (this.startAt === undefined) throw new Error('InvalidStateError: stop before start');
    this.stopAt = when;
  }
}

class FakeOscillator extends FakeSource {
  constructor(ctx) {
    super(ctx);
    this.frequency = new FakeParam(this, 440, -24000, 24000);
    this.detune = new FakeParam(this, 0, -153600, 153600);
    enumProp(this, 'type', ['sine', 'square', 'sawtooth', 'triangle'], 'sine');
  }
}

class FakeBufferSource extends FakeSource {
  constructor(ctx) {
    super(ctx);
    this.loop = false;
    this.playbackRate = new FakeParam(this, 1);
    let buffer = null;
    Object.defineProperty(this, 'buffer', {
      get: () => buffer,
      set: (b) => {
        if (!(b instanceof FakeBuffer)) throw new TypeError('not an AudioBuffer');
        if (buffer) throw new Error('InvalidStateError: buffer set twice');
        buffer = b;
      },
    });
  }
  start(when = 0, offset = 0) {
    checkTime(offset);
    super.start(when);
  }
}

class FakeBuffer {
  constructor(channels, length, sampleRate) {
    if (!(channels >= 1 && length >= 1 && sampleRate >= 3000 && sampleRate <= 768000)) {
      throw new Error('NotSupportedError: bad buffer');
    }
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
    Object.assign(this, { numberOfChannels: channels, length, sampleRate });
  }
  getChannelData(i) { return this.data[i]; }
}

class FakeContext extends EventTarget {
  constructor(sampleRate = 48000) {
    super();
    this.nodes = [];
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.state = 'suspended';
    this.destination = new FakeNode(this);
  }
  createGain() { const n = new FakeNode(this); n.gain = new FakeParam(n, 1); return n; }
  createOscillator() { return new FakeOscillator(this); }
  createBufferSource() { return new FakeBufferSource(this); }
  createBuffer(ch, len, rate) { return new FakeBuffer(ch, len, rate); }
  createBiquadFilter() {
    const n = new FakeNode(this);
    n.frequency = new FakeParam(n, 350, 0, 24000);
    n.Q = new FakeParam(n, 1, -770, 770);
    n.gain = new FakeParam(n, 0, -40, 40);
    n.detune = new FakeParam(n, 0);
    enumProp(n, 'type', ['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass'], 'lowpass');
    return n;
  }
  createDynamicsCompressor() {
    const n = new FakeNode(this);
    n.threshold = new FakeParam(n, -24, -100, 0);
    n.knee = new FakeParam(n, 30, 0, 40);
    n.ratio = new FakeParam(n, 12, 1, 20);
    n.attack = new FakeParam(n, 0.003, 0, 1);
    n.release = new FakeParam(n, 0.25, 0, 1);
    return n;
  }
  createWaveShaper() {
    const n = new FakeNode(this);
    let curve = null;
    Object.defineProperty(n, 'curve', {
      get: () => curve,
      set: (c) => {
        if (!(c instanceof Float32Array) || c.length < 2) throw new Error('InvalidStateError: bad curve');
        curve = c;
      },
    });
    enumProp(n, 'oversample', ['none', '2x', '4x'], 'none');
    return n;
  }
  createStereoPanner() { const n = new FakeNode(this); n.pan = new FakeParam(n, 0, -1, 1); return n; }
}

class FakeAudioContext extends FakeContext {
  static instances = [];
  constructor(opts) {
    super();
    this.opts = opts;
    this.resumes = 0;
    FakeAudioContext.instances.push(this);
  }
  setState(state) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
  resume() { this.resumes += 1; this.setState('running'); return Promise.resolve(); }
  suspend() { this.setState('suspended'); return Promise.resolve(); }
  close() { this.setState('closed'); return Promise.resolve(); }
}

class FakeOfflineAudioContext extends FakeContext {
  constructor(channels, length, sampleRate) {
    super(sampleRate);
    Object.assign(this, { channels, length });
  }
}

// ---- helpers ---------------------------------------------------------------

class MemoryStorage {
  constructor(init = {}) { this.map = new Map(Object.entries(init)); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

// A fresh module, which sleeps after `idle` ms of silence (and `muted` ms
// once muted) instead of 30 s and 0.4 s.
let instance = 0;
async function freshSound({ idle = 60, muted = 20 } = {}) {
  instance += 1;
  const { sound } = await import(`${MODULE}?i=${instance}`);
  Object.assign(sound._napMs, { idle, muted });
  return sound;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sources = (ctx) => ctx.nodes.filter((n) => n instanceof FakeSource);

// Does audio from `node` reach the context's destination?
function reaches(node, dest, seen = new Set()) {
  if (node === dest) return true;
  if (seen.has(node)) return false;
  seen.add(node);
  return node.outputs.some((o) => reaches(o instanceof FakeParam ? o.owner : o, dest, seen));
}

function masterOf(ctx) {
  const shaper = ctx.nodes.find((n) => 'curve' in n);
  return ctx.nodes.find((n) => n.outputs.includes(shaper));
}

// The page, where the module listens for gestures.
let page;
const gesture = (type) => page.dispatchEvent(new Event(type));

beforeEach(() => {
  FakeAudioContext.instances = [];
  setGlobal('AudioContext', FakeAudioContext);
  setGlobal('localStorage', new MemoryStorage());
  page = new EventTarget();
  setGlobal('addEventListener', page.addEventListener.bind(page));
});

// ---- tests -----------------------------------------------------------------

test('exposes exactly the contract sounds', async () => {
  const sound = await freshSound();
  assert.deepEqual([...sound._names].sort(), [...NAMES].sort());
  for (const fn of ['unlock', 'play', 'setMuted', 'isMuted', 'setVolume', 'getVolume', 'setCall', '_renderTo']) {
    assert.equal(typeof sound[fn], 'function', fn);
  }
});

for (const name of NAMES) {
  test(`${name}: renders valid, connected, bounded nodes`, async () => {
    const sound = await freshSound();
    const ctx = new FakeOfflineAudioContext(2, 48000 * 3, 48000);
    const before = ctx.nodes.length;
    const at = 0.25;
    const length = sound._renderTo(ctx, name, { volume: 1, at });
    assert.ok(length > 0 && length <= MAX_LENGTH[name], `length ${length}`);
    assert.ok(ctx.nodes.length > before, 'created nodes');
    const srcs = sources(ctx);
    assert.ok(srcs.length > 0, 'has sources');
    for (const s of srcs) {
      assert.ok(s.startAt >= at - 1e-9, `starts at ${s.startAt}`);
      assert.ok(s.stopAt !== undefined && s.stopAt <= at + length + 1e-9, `stops at ${s.stopAt}`);
      assert.ok(reaches(s, ctx.destination), 'source reaches the speakers');
    }
    for (const node of ctx.nodes) {
      for (const p of node.params()) {
        for (const e of p.events) assert.ok(e.t <= at + length + 0.05, `automation at ${e.t}`);
      }
    }
  });
}

test('_renderTo ignores unknown names and shares one chain per context', async () => {
  const sound = await freshSound();
  const ctx = new FakeOfflineAudioContext(2, 48000, 48000);
  assert.equal(sound._renderTo(ctx, 'boem'), 0);
  assert.equal(sound._renderTo(ctx, 'toString'), 0);
  sound._renderTo(ctx, 'card');
  sound._renderTo(ctx, 'click', { at: 0.1 });
  assert.equal(ctx.nodes.filter((n) => 'curve' in n).length, 1);
});

test('play is a no-op before unlock and for unknown names', async () => {
  const sound = await freshSound();
  for (const name of NAMES) sound.play(name);
  assert.equal(FakeAudioContext.instances.length, 0, 'no context without a gesture');
  await sound.unlock();
  const ctx = FakeAudioContext.instances[0];
  const before = ctx.nodes.length;
  for (const bad of ['boem', '', undefined, null, 42, {}, 'constructor', '__proto__', 'hasOwnProperty']) sound.play(bad);
  assert.equal(ctx.nodes.length, before);
});

test('unlock creates one running context; play schedules every sound', async () => {
  const sound = await freshSound();
  await sound.unlock();
  await sound.unlock();
  assert.equal(FakeAudioContext.instances.length, 1);
  const ctx = FakeAudioContext.instances[0];
  assert.equal(ctx.state, 'running');
  assert.equal(ctx.opts?.latencyHint, 'interactive');
  for (const name of NAMES) {
    const before = sources(ctx).length;
    ctx.currentTime += 0.5;
    sound.play(name);
    const added = sources(ctx).slice(before);
    assert.ok(added.length > 0, `${name} scheduled sources`);
    assert.ok(added.every((s) => s.startAt >= ctx.currentTime && reaches(s, ctx.destination)), name);
  }
});

test('throttles repeats, lets deal run quickly', async () => {
  const sound = await freshSound();
  await sound.unlock();
  const ctx = FakeAudioContext.instances[0];
  const count = () => sources(ctx).length;
  sound.play('card');
  const one = count();
  sound.play('card');
  assert.equal(count(), one, 'second card within 40 ms dropped');
  await wait(45);
  sound.play('card');
  assert.ok(count() > one, 'plays again after 40 ms');
  sound.play('deal');
  const dealt = count();
  await wait(20);
  sound.play('deal');
  assert.ok(count() > dealt, 'deal may repeat after 15 ms');
});

test('caps simultaneous voices and fades out the oldest', async () => {
  const sound = await freshSound();
  await sound.unlock();
  const ctx = FakeAudioContext.instances[0];
  for (const name of NAMES) sound.play(name);
  assert.equal(sound._voiceCount(), 10);
  const stolen = ctx.nodes.filter((n) => n.gain?.events.some((e) => e.kind === 'linear' && e.v === 0 && e.t <= 0.05)
    && n.gain.events.some((e) => e.kind === 'cancel'));
  assert.equal(stolen.length, NAMES.length - 10, 'oldest voices faded out');
});

test('voices are released after they end', async () => {
  const sound = await freshSound();
  await sound.unlock();
  const ctx = FakeAudioContext.instances[0];
  const before = ctx.nodes.length;
  sound.play('click');
  assert.equal(sound._voiceCount(), 1);
  const out = ctx.nodes[before];
  await wait(400);
  assert.equal(sound._voiceCount(), 0);
  assert.ok(out.disconnected, 'voice output disconnected');
});

test('muted: nothing is scheduled and the master fades to 0', async () => {
  const sound = await freshSound();
  await sound.unlock();
  const ctx = FakeAudioContext.instances[0];
  sound.setMuted(true);
  assert.equal(sound.isMuted(), true);
  const before = ctx.nodes.length;
  sound.play('win');
  assert.equal(ctx.nodes.length, before);
  const master = masterOf(ctx);
  assert.deepEqual(master.gain.events.at(-1).v, 0);
  sound.setMuted(false);
  sound.setVolume(0.25);
  assert.ok(Math.abs(master.gain.events.at(-1).v - 0.125) < 1e-9, 'volume 0.25 → gain 0.125');
  sound.play('win');
  assert.ok(ctx.nodes.length > before);
});

test('settings persist in localStorage kj.sound', async () => {
  let sound = await freshSound();
  assert.equal(sound.isMuted(), false);
  assert.equal(sound.getVolume(), 0.6);
  sound.setMuted(true);
  sound.setVolume(0.3);
  assert.deepEqual(JSON.parse(localStorage.getItem('kj.sound')), { muted: true, volume: 0.3 });
  sound = await freshSound();
  assert.equal(sound.isMuted(), true);
  assert.equal(sound.getVolume(), 0.3);
  sound.setVolume(7);
  assert.equal(sound.getVolume(), 1);
  sound.setVolume(-1);
  assert.equal(sound.getVolume(), 0);
  for (const junk of ['veel', '', NaN, Infinity, null, undefined, true, {}, [0.5]]) sound.setVolume(junk);
  assert.equal(sound.getVolume(), 0);
  sound.setVolume('0.5');
  assert.equal(sound.getVolume(), 0.5);
  sound.setMuted(0);
  assert.equal(sound.isMuted(), false);
  assert.deepEqual(JSON.parse(localStorage.getItem('kj.sound')), { muted: false, volume: 0.5 });
});

test('bad stored settings fall back to defaults', async () => {
  for (const raw of ['{kapot', 'null', '42', '{"muted":"ja","volume":"hard"}', '{"volume":3}']) {
    setGlobal('localStorage', new MemoryStorage({ 'kj.sound': raw }));
    const sound = await freshSound();
    assert.equal(sound.isMuted(), false, raw);
    assert.equal(sound.getVolume(), raw === '{"volume":3}' ? 1 : 0.6, raw);
  }
});

test('blocked storage never throws', async () => {
  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); } };
  setGlobal('localStorage', blocked);
  const sound = await freshSound();
  assert.equal(sound.getVolume(), 0.6);
  sound.setMuted(true);
  sound.setVolume(0.2);
  assert.equal(sound.isMuted(), true);
  assert.equal(sound.getVolume(), 0.2);
  Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('SecurityError'); }, configurable: true });
  const again = await freshSound();
  assert.equal(again.isMuted(), false);
  again.setMuted(true);
});

test('without WebAudio everything is a quiet no-op', async () => {
  setGlobal('AudioContext', undefined);
  const sound = await freshSound();
  await sound.unlock();
  for (const name of NAMES) sound.play(name);
  sound.setVolume(0.4);
  sound.setMuted(true);
  assert.equal(sound.isMuted(), true);

  setGlobal('AudioContext', class { constructor() { throw new Error('NotAllowedError'); } });
  const other = await freshSound();
  await other.unlock();
  other.play('card');
});

test('a failing graph never escapes play()', async () => {
  class Broken extends FakeAudioContext {
    createOscillator() { throw new Error('boom'); }
  }
  setGlobal('AudioContext', Broken);
  const sound = await freshSound();
  await sound.unlock();
  for (const name of NAMES) sound.play(name);
  assert.ok(sound._voiceCount() <= 10);
});

test('while resume() is pending sounds queue briefly, then stop', async () => {
  class Hanging extends FakeAudioContext {
    resume() { return new Promise(() => {}); }
  }
  setGlobal('AudioContext', Hanging);
  const sound = await freshSound();
  sound.unlock();
  const ctx = Hanging.instances[0];
  const before = sources(ctx).length;
  sound.play('card');
  assert.ok(sources(ctx).length > before, 'queued during the grace period');
  await wait(1100);
  const later = sources(ctx).length;
  sound.play('click');
  assert.equal(sources(ctx).length, later, 'suspended context: skipped');
});

test('a closed context is replaced on the next unlock', async () => {
  const sound = await freshSound();
  await sound.unlock();
  await FakeAudioContext.instances[0].close();
  await sound.unlock();
  assert.equal(FakeAudioContext.instances.length, 2);
  assert.equal(FakeAudioContext.instances[1].state, 'running');
});

test('iOS audio session: ambient for the game, play-and-record in a call', async () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const audioSession = { type: 'auto' };
  setGlobal('navigator', { audioSession });
  try {
    const sound = await freshSound();
    sound.setCall(false);
    assert.equal(audioSession.type, 'auto', 'untouched before the first sound and outside a call');
    await sound.unlock();
    assert.equal(audioSession.type, 'ambient');
    sound.setCall(true);
    assert.equal(audioSession.type, 'play-and-record');
    await FakeAudioContext.instances[0].close();
    await sound.unlock();
    assert.equal(audioSession.type, 'play-and-record', 'a new context during the call keeps the call\'s session');
    sound.setCall(false);
    assert.equal(audioSession.type, 'ambient');
  } finally {
    Object.defineProperty(globalThis, 'navigator', nav);
  }
});

test('a silent context sleeps, and the next sound wakes it', async () => {
  const sound = await freshSound();
  await sound.unlock();
  const ctx = FakeAudioContext.instances[0];
  sound.play('click');
  await wait(120);
  assert.equal(ctx.state, 'running', 'not while the click still sounds');
  await wait(400);
  assert.equal(ctx.state, 'suspended', 'asleep once silent');
  assert.equal(sound._voiceCount(), 0);
  const before = sources(ctx).length;
  sound.play('turn');
  assert.equal(ctx.state, 'running', 'woken by the sound');
  const added = sources(ctx).slice(before);
  assert.ok(added.length > 0 && added.every((s) => s.startAt >= ctx.currentTime && reaches(s, ctx.destination)));
});

test('keys and taps leave a sleeping context asleep; iOS interruptions still recover', async () => {
  const sound = await freshSound();
  await sound.unlock(); // a new context starts suspended (iOS): unlock() resumes it
  const ctx = FakeAudioContext.instances[0];
  assert.equal(ctx.state, 'running');
  await wait(100);
  assert.equal(ctx.state, 'suspended', 'asleep after a gesture without a sound');
  const resumes = ctx.resumes;
  for (const type of ['keydown', 'click', 'touchend', 'pointerup']) gesture(type);
  await sound.unlock(); // the app's own unlock() on a tap
  assert.equal(ctx.state, 'suspended', 'still asleep');
  assert.equal(ctx.resumes, resumes, 'not resumed');

  ctx.setState('interrupted'); // a phone call while asleep
  gesture('click');
  assert.equal(ctx.state, 'running', 'the next tap resumes it');

  ctx.setState('interrupted'); // a phone call while running
  await wait(100); // the nap falls in the interruption
  assert.equal(ctx.state, 'interrupted');
  ctx.setState('running'); // over: iOS resumes it by itself
  await wait(100);
  assert.equal(ctx.state, 'suspended', 'asleep again once silent');

  ctx.setState('interrupted'); // a phone call while asleep
  ctx.setState('suspended'); // over: iOS puts back the state of before
  sound.play('card');
  assert.equal(ctx.state, 'running', 'the next sound wakes it');
});

test('muted: the context sleeps soon after the first gesture and after muting', async () => {
  setGlobal('localStorage', new MemoryStorage({ 'kj.sound': '{"muted":true,"volume":0.6}' }));
  let sound = await freshSound({ idle: 1000 });
  await sound.unlock();
  let ctx = FakeAudioContext.instances[0];
  assert.equal(ctx.state, 'running');
  await wait(50);
  assert.equal(ctx.state, 'suspended', 'asleep, not after the idle wait');
  sound.play('card');
  gesture('keydown');
  assert.equal(ctx.state, 'suspended', 'stays asleep while muted');
  sound.setMuted(false);
  sound.play('click');
  assert.equal(ctx.state, 'running', 'unmuted, the next sound wakes it');

  sound = await freshSound({ idle: 1000 });
  await sound.unlock();
  ctx = FakeAudioContext.instances[1];
  sound.play('click');
  sound.setMuted(true);
  await wait(50);
  assert.equal(ctx.state, 'running', 'not while the click still sounds');
  await wait(350);
  assert.equal(ctx.state, 'suspended', 'asleep once muted and silent');
});

test('a short sound that wakes the context is not cut off while it resumes', async () => {
  class Slow extends FakeAudioContext { // after the first time, as an iPhone may
    resume() {
      if (this.resumes === 0) return super.resume();
      this.resumes += 1;
      return new Promise((done) => setTimeout(() => { this.setState('running'); done(); }, 300));
    }
  }
  setGlobal('AudioContext', Slow);
  const sound = await freshSound();
  await sound.unlock();
  const ctx = Slow.instances[0];
  await wait(100);
  assert.equal(ctx.state, 'suspended');
  const before = ctx.nodes.length;
  sound.play('click'); // its own length plus 250 ms would end it at 290 ms
  const out = ctx.nodes[before];
  await wait(350);
  assert.equal(ctx.state, 'running');
  assert.equal(sound._voiceCount(), 1);
  assert.ok(!out.disconnected, 'voice still connected after the resume');
});

test('a context that cannot sleep never throws', async () => {
  const kinds = [
    class extends FakeAudioContext { suspend = undefined; },
    class extends FakeAudioContext { suspend() { throw new Error('InvalidStateError'); } },
    class extends FakeAudioContext { suspend() { return Promise.reject(new Error('InvalidStateError')); } },
  ];
  for (const AC of kinds) {
    setGlobal('AudioContext', AC);
    const sound = await freshSound();
    await sound.unlock();
    await wait(100);
    const ctx = AC.instances.at(-1);
    assert.equal(ctx.state, 'running');
    const before = sources(ctx).length;
    sound.play('card');
    assert.ok(sources(ctx).length > before, 'still plays');
  }
});

test('the context stays awake during a call, and sleeps once silent after it', async () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const audioSession = { type: 'auto' };
  setGlobal('navigator', { audioSession });
  try {
    const sound = await freshSound();
    await sound.unlock();
    const ctx = FakeAudioContext.instances[0];
    sound.setCall(true);
    sound.play('click');
    await wait(400);
    assert.equal(sound._voiceCount(), 0);
    assert.equal(ctx.state, 'running', 'awake in the call, silent past the wait');
    sound.setMuted(true);
    await wait(100);
    assert.equal(ctx.state, 'running', 'also when muted');
    sound.setMuted(false);
    sound.setCall(false);
    assert.equal(audioSession.type, 'ambient');
    await wait(100);
    assert.equal(ctx.state, 'suspended', 'asleep once the call is over');

    const resumes = ctx.resumes;
    sound.setCall(true);
    assert.equal(audioSession.type, 'play-and-record', 'the session changes while the context sleeps');
    assert.equal(ctx.state, 'suspended', 'the call alone does not wake it');
    assert.equal(ctx.resumes, resumes);
    sound.play('join');
    assert.equal(ctx.state, 'running', 'the next sound does');
    await wait(150);
    assert.equal(ctx.state, 'running', 'and it stays awake in the call');
    sound.setCall(false);
    assert.equal(audioSession.type, 'ambient');
  } finally {
    Object.defineProperty(globalThis, 'navigator', nav);
  }
});
