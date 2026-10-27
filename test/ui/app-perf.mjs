// A benchmark of the frontend on two emulated phones: how much the main
// thread works per second in the app's steady states, and how long a
// keystroke in the chat takes. Profiles: fairphone (412×915, DPR 2.625, the
// CPU 4× slower) and oldiphone (375×667, DPR 2, 6× slower); the CPU is
// slowed only while measuring.
//
//   node test/ui/mock/server.mjs --rig &      (or the real server: --url)
//   scripts/chrome 9301
//   cd test/ui && node app-perf.mjs [--url http://127.0.0.1:18100] [--profile fairphone] [--only turn,keys] [--secs 3] [--json]
//
// Per scenario: busy ms/s (the main thread's TaskDuration), style recalcs
// and layouts per second, script ms/s, the animations running at the end,
// and for typing the Event Timing mean and p90 of keydown (compositionupdate
// for a phone keyboard's IME) over the keys that took 16 ms or more, the
// least Event Timing reports, with how many did. Headless Chromium draws at
// 60 Hz without a GPU: compare runs with each other (counts are steadier
// than milliseconds), not with a phone. On the real server, alone at the
// table, the hand summary has no countdown.
import { args, connect, openPage, press, waitFor, sleep, playLegal, addressProxy, ownAddress } from './app-lib.mjs';

const A = args();
const opt = (name, def) => { const i = process.argv.indexOf('--' + name); return i < 0 ? def : process.argv[i + 1]; };
const SECS = Number(opt('secs', 3));
const PROFILES = {
  fairphone: { vp: { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true }, cpu: 4 },
  oldiphone: { vp: { width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, cpu: 6 },
};
const SCENARIOS = ['home', 'turn', 'manual', 'keys', 'ime', 'botturn', 'summary', 'next', 'advice'];
const want = name => !A.only || A.only.split(',').includes(name);
const TEXT = 'Mooi gespeeld partner, en door'; // 30 characters
const proxy = await addressProxy(A.url);
const BASE = proxy.url;
const browser = await connect(A.cdp);
const rows = [];
const errors = [];

// In the page before the app: Event Timing entries, and kjHoldWhen(s),
// which holds the server's messages from the first update it is true for,
// so the game stays in that state until kjRelease().
function init() {
  try {
    localStorage.setItem('kj.prefs', JSON.stringify({ tap: 'one' }));
    localStorage.setItem('kj.lessons', '0');
  } catch {}
  window.kjEvents = [];
  new PerformanceObserver(l => {
    for (const e of l.getEntries()) window.kjEvents.push({ name: e.name, t: e.startTime, dur: e.duration });
  }).observe({ type: 'event', durationThreshold: 16 });
  window.kjCount = { keydown: 0, compositionupdate: 0 };
  for (const name of Object.keys(window.kjCount)) addEventListener(name, () => window.kjCount[name]++, true);
  const held = [];
  let hold = false;
  window.kjHeld = () => hold;
  window.kjRelease = () => { hold = false; for (const [f, e] of held.splice(0)) f(e); };
  window.WebSocket = class extends window.WebSocket {
    set onmessage(f) {
      super.onmessage = e => {
        if (hold) { held.push([f, e]); return; }
        f(e);
        if (!window.kjHoldWhen) return;
        const m = JSON.parse(e.data);
        if (m.t === 'update' && window.kjHoldWhen(m.s)) { hold = true; window.kjHoldWhen = null; }
      };
    }
  };
}

async function page(name) {
  const prof = PROFILES[name];
  const P = await openPage(browser, prof.vp, name);
  await ownAddress(P, BASE);
  await P.page.evaluateOnNewDocument(init);
  P.cdp = await P.page.createCDPSession();
  await P.cdp.send('Performance.enable');
  P.prof = prof;
  await P.page.goto(BASE + '/', { waitUntil: 'networkidle0' });
  await waitFor(P, () => document.querySelector('#btn-quick'), { label: 'home' });
  return P;
}

async function metrics(P) {
  const { metrics: m } = await P.cdp.send('Performance.getMetrics');
  return Object.fromEntries(m.map(x => [x.name, x.value]));
}

// Measures while act() runs (by default: nothing happens for SECS), at the profile's CPU speed.
async function measure(P, scenario, act = () => sleep(SECS * 1000)) {
  await P.cdp.send('Emulation.setCPUThrottlingRate', { rate: P.prof.cpu });
  const m0 = await metrics(P);
  const t0 = Date.now();
  const extra = await act();
  const s = (Date.now() - t0) / 1000;
  const m1 = await metrics(P);
  await P.cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const per = k => (m1[k] - m0[k]) / s;
  const row = {
    profile: P.name, scenario,
    'busy ms/s': Math.round(per('TaskDuration') * 1000),
    'style/s': +per('RecalcStyleCount').toFixed(1),
    'layout/s': +per('LayoutCount').toFixed(1),
    'script ms/s': Math.round(per('ScriptDuration') * 1000),
    anims: await P.page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length),
    ...extra,
  };
  rows.push(row);
  if (!A.has('json')) console.log(JSON.stringify(row));
}

// Types TEXT into the focused chat field, as key events or as a phone
// keyboard does (the word a growing composition, committed at a space).
async function typing(P, ime) {
  const name = ime ? 'compositionupdate' : 'keydown';
  const [t0, n0] = await P.page.evaluate(name => [performance.now(), window.kjCount[name]], name);
  if (!ime) await P.page.keyboard.type(TEXT, { delay: 150 });
  else {
    let word = '';
    for (const ch of TEXT) {
      if (ch === ' ') { await P.cdp.send('Input.insertText', { text: word + ' ' }); word = ''; }
      else { word += ch; await P.cdp.send('Input.imeSetComposition', { text: word, selectionStart: word.length, selectionEnd: word.length }); }
      await sleep(150);
    }
    await P.cdp.send('Input.insertText', { text: word });
  }
  await sleep(300);
  const [d, n] = await P.page.evaluate((t0, name) => [window.kjEvents.filter(e => e.t >= t0 && e.name === name).map(e => e.dur), window.kjCount[name]], t0, name);
  d.sort((a, b) => a - b);
  await P.page.evaluate(() => { document.querySelector('.chat-input').value = ''; });
  return {
    'ET mean': d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : 0,
    'ET p90': d.length ? d[Math.min(d.length - 1, Math.floor(d.length * 0.9))] : 0,
    'ET ≥16': `${d.length}/${n - n0}`,
  };
}

// Plays (trump, bid, cards, the next hand) until stop holds in the page;
// with choose false it leaves trump and bids alone (training: they wait
// for the advice).
async function playUntil(P, stop, choose = true) {
  const t0 = Date.now();
  while (!(await P.page.evaluate(stop))) {
    if (Date.now() - t0 > 300000) throw new Error(`[${P.name}] timeout playing until ${stop}`);
    const st = await P.page.evaluate(() => ({
      trump: !!document.querySelector('.panel-trump .suit-btn:not(:disabled)'),
      bid: !!document.querySelector('.panel-bid .btn-go:not(:disabled)'),
      play: !!document.querySelector('.hand.my-turn .card.legal'),
      next: !!document.querySelector('.m-summary.open .btn-go:not(:disabled)'),
    }));
    if (st.trump && choose) await press(P, '.panel-trump .suit-btn:not(:disabled)');
    else if (st.bid && choose) await press(P, '.panel-bid .btn-go');
    else if (st.play) await playLegal(P);
    else if (st.next) await press(P, '.m-summary .btn-go');
    await sleep(150);
  }
}

async function game(name) {
  const P = await page(name);
  const prof = P.prof;
  if (want('home')) { await sleep(1500); await measure(P, 'home'); }
  await press(P, '#btn-quick');
  const myTurn = () => !!document.querySelector('.hand.my-turn .card.legal');
  await playUntil(P, myTurn);
  await sleep(1500);
  if (want('turn')) await measure(P, 'turn');
  if (want('manual')) {
    await press(P, '.topbar .tb-menu');
    await press(P, '.m-menu .dlg-body > .menu-item:nth-child(3)');
    await waitFor(P, () => document.querySelector('.m-manual.open'), { label: 'manual' });
    await sleep(1000);
    await measure(P, 'manual');
    await P.page.keyboard.press('Escape');
    await sleep(500);
  }
  if (want('keys') || want('ime')) {
    // The chat drawer over the table, the field focused, the keyboard up (40% of the screen).
    await press(P, '.topbar .tb-chat');
    await waitFor(P, () => document.body.classList.contains('chat-open'), { label: 'chat' });
    await press(P, '.chat-input');
    await P.page.setViewport({ ...prof.vp, height: Math.round(prof.vp.height * 0.6) });
    await sleep(1000);
    for (const ime of [false, true]) if (want(ime ? 'ime' : 'keys')) await measure(P, ime ? 'ime' : 'keys', () => typing(P, ime));
    await P.page.setViewport(prof.vp);
    await P.page.keyboard.press('Escape');
    await sleep(800);
  }
  if (want('botturn')) {
    await P.page.evaluate(() => { window.kjHoldWhen = s => s.phase === 'play' && s.turn >= 0 && s.turn !== s.you; });
    const t0 = Date.now();
    while (!(await P.page.evaluate(() => window.kjHeld()))) {
      if (Date.now() - t0 > 300000) throw new Error(`[${P.name}] timeout holding a bot's turn`);
      if (await P.page.evaluate(myTurn)) await playLegal(P);
      await sleep(150);
    }
    await sleep(1500);
    await measure(P, 'botturn');
    await P.page.evaluate(() => window.kjRelease());
  }
  if (want('summary') || want('next')) {
    await playUntil(P, () => !!document.querySelector('.m-summary.open'));
    await sleep(1000);
    if (want('summary')) await measure(P, 'summary');
    // Ready at once: the summary goes while its countdown runs; the next hand held at its first update.
    await P.page.evaluate(() => { window.kjHoldWhen = s => s.phase !== 'handEnd'; });
    await press(P, '.m-summary .btn-go');
    await waitFor(P, () => window.kjHeld(), { label: 'next hand' });
    await sleep(2000);
    if (want('next')) await measure(P, 'next');
    await P.page.evaluate(() => window.kjRelease());
  }
  await P.ctx.close();
  errors.push(...P.errors);
}

async function training(name) {
  const P = await page(name);
  await press(P, '#btn-train');
  // A tap while the sheet still slides in can miss.
  await waitFor(P, () => document.querySelector('.m-train.open') && !document.querySelector('.m-train').getAnimations({ subtree: true }).some(a => a.effect.getComputedTiming().endTime < Infinity), { label: 'training sheet in place' });
  await press(P, '#btn-train-go');
  await waitFor(P, () => document.body.dataset.screen === 'game', { label: 'training table' });
  // The trump or bid choice with Juf Jannie's advice glowing on a button.
  await playUntil(P, () => !!document.querySelector('.panel .advised:not(:disabled)'), false);
  await sleep(1500);
  await measure(P, 'advice');
  await P.ctx.close();
  errors.push(...P.errors);
}

try {
  for (const name of opt('profile', '') ? [opt('profile')] : Object.keys(PROFILES)) {
    if (SCENARIOS.slice(0, -1).some(want)) await game(name);
    if (want('advice')) await training(name);
  }
} catch (e) {
  errors.push(e.message || String(e));
} finally {
  await browser.disconnect();
  proxy.close();
}
if (A.has('json')) console.log(JSON.stringify(rows, null, 1));
else console.table(rows);
if (errors.length) {
  console.error('FAILED:\n' + errors.join('\n'));
  process.exit(1);
}
process.exit(0); // the proxy may still hold keep-alive connections
