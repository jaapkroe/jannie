// Drives toepen's site through its screens at six viewport sizes and saves
// screenshots to test/ui/out/toepen-<viewport>-<label>.png. Fails on console
// errors, uncaught exceptions, failed requests or horizontal overflow.
//
//   GAME=toepen scripts/dev-server 18400 -fast && scripts/chrome 9301
//   cd test/ui && node toepen-screens.mjs --url http://127.0.0.1:18400 [--cdp http://127.0.0.1:9301] [--only phone,desktop] [--dpr 2]
//
// Toepen has no mock: the server from source deals and its bots play, so
// whether a bot's vuile was asks to be checked or a toep to be answered
// depends on the cards; those shots are taken when that happens. With -fast
// the time for a vuile was, a full trick and a round's summary last a
// fraction of a second: the page holds the server's next messages back for
// those shots.
import {
  args, connect, openPage, VIEWPORTS, press, pressEl, type, shot, checkOverflow, waitFor, sleep, addressProxy, ownAddress,
} from './app-lib.mjs';

const A = args();
const proxy = await addressProxy(A.url);
const BASE = proxy.url;
const names = A.only ? A.only.split(',') : Object.keys(VIEWPORTS);

const has = (P, sel) => P.page.evaluate(s => !!document.querySelector(s), sel);
const shown = (P, sel) => P.page.evaluate(s => !!document.querySelector(s)?.getClientRects().length, sel);

// Wraps the page's WebSocket: once a message matches window.__holdOn (a
// regular expression), the ones after it wait until window.__release(),
// which hands them on until one matches again.
function holdHook() {
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    set onmessage(fn) {
      const take = e => {
        if (window.__held) { window.__held.push(() => take(e)); return; }
        fn(e);
        if (window.__holdOn && new RegExp(window.__holdOn).test(e.data)) {
          window.__holdOn = '';
          window.__held = [];
        }
      };
      super.onmessage = fn && take;
    }
    get onmessage() { return super.onmessage; }
  };
  window.__release = () => {
    const q = window.__held || [];
    window.__held = null;
    while (q.length && !window.__held) q.shift()();
    if (window.__held) window.__held.unshift(...q);
  };
}
const holdOn = (P, re) => P.page.evaluate(s => { window.__holdOn = s; }, re.source);
const release = P => P.page.evaluate(() => window.__release());
// The time for a vuile was begins, a card is played, a round ends.
const WAS = /^(?=.*"phase":"was")(?=.*"nextAt":[1-9])/;
const PLAYED = /"type":"play"/;
const HAND_END = /"type":"handEnd"/;

async function snap(P, label) {
  await sleep(120);
  await shot(P, label);
  await checkOverflow(P, label);
  console.log(`  ${P.name}: ${label}`);
}

async function closeModal(P) {
  await P.page.keyboard.press('Escape');
  await sleep(320);
}

async function home(P) {
  await P.page.goto(BASE + '/', { waitUntil: 'networkidle0' });
  await waitFor(P, () => document.querySelector('#btn-quick'), { label: 'home' });
  await type(P, '#name', 'Piet');
}

// A tool of the top bar; on a phone some live in the menu (Meer).
async function openTool(P, tool, menuText) {
  if (await shown(P, `.topbar .tb-${tool}`)) {
    await press(P, `.topbar .tb-${tool}`);
    return;
  }
  await press(P, '.topbar .tb-menu');
  await waitFor(P, () => document.querySelector('.m-menu.open'), { label: 'menu' });
  await sleep(250);
  const items = await P.page.$$('.m-menu .menu-item');
  for (const it of items) {
    if ((await it.evaluate(e => e.textContent.trim())) === menuText) {
      await pressEl(P, it);
      return;
    }
  }
  throw new Error(`[${P.name}] no menu item ${menuText}`);
}

// The new-game sheet with these options, then the lobby.
async function newGame(P, opts, label = '') {
  await press(P, '#btn-new');
  await waitFor(P, () => document.querySelector('.m-new.open'), { label: 'new game sheet' });
  await sleep(300);
  if (label) await snap(P, label);
  for (const [key, text] of Object.entries(opts)) {
    const btns = await P.page.$$(`.m-new .opt-row[data-key="${key}"] .seg-btn`);
    let done = false;
    for (const b of btns) {
      if ((await b.evaluate(e => e.textContent)) !== text) continue;
      await b.evaluate(e => e.scrollIntoView({ block: 'center' }));
      await sleep(200);
      await pressEl(P, b);
      done = true;
      break;
    }
    if (!done) throw new Error(`option ${key} ${text} not found`);
  }
  await press(P, '#btn-create');
  await waitFor(P, () => document.body.dataset.screen === 'lobby' && document.querySelector('.code-big span'), { label: 'lobby' });
}

// A button of the prompt row by its label.
async function act(P, label) {
  const btns = await P.page.$$('.tp-actions .btn:not(:disabled)');
  for (const b of btns) {
    if ((await b.evaluate(e => e.querySelector('b')?.textContent)) === label) {
      await pressEl(P, b);
      return true;
    }
  }
  return false;
}

// Plays a legal card: on a touch screen the first tap lifts it, the second plays.
async function playCard(P) {
  const el = await P.page.$('.tp-hand.mine .card.legal');
  if (!el) return false;
  const code = await el.evaluate(e => e.dataset.card);
  await pressEl(P, el);
  if (P.touch) {
    await sleep(300);
    const again = await P.page.$(`.tp-hand .card.selected[data-card="${code}"]`);
    if (again) await pressEl(P, again);
  }
  return true;
}

// What the table asks now.
const state = P => P.page.evaluate(() => {
  const labels = [...document.querySelectorAll('.tp-actions .btn:not(:disabled) b')].map(b => b.textContent);
  return {
    labels,
    lay: [...document.querySelectorAll('.tp-actions .btn b')].some(b => b.textContent === 'Wegleggen'),
    play: !!document.querySelector('.tp-hand.mine .card.legal'),
    summary: !!document.querySelector('.tp-summary.open .btn-go:not(:disabled)'),
  };
});

// Plays until stop matches: answers every question of the table, toeps
// when told to, takes the shots of the prompts as they come (once each).
async function playUntil(P, stop, { timeout = 240000, toep = false, ready = true, shots = {} } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await has(P, stop)) return;
    const st = await state(P);
    const once = async (key, label) => {
      if (shots[key] && !shots[key].done) {
        shots[key].done = true;
        await sleep(400);
        await snap(P, label);
      }
    };
    if (st.labels.includes('Geen')) {
      await act(P, 'Geen');
    } else if (st.labels.includes('Laten gaan')) {
      await once('check', shots.check?.label);
      await act(P, 'Laten gaan');
    } else if (st.labels.includes('Meegaan')) {
      await once('toep', shots.toep?.label);
      await act(P, 'Meegaan');
    } else if (st.lay) {
      // The koningsspel: tap the cards to lay away (each once), then lay them away.
      await once('koning', shots.koning?.label);
      if (!(await act(P, 'Wegleggen'))) {
        const el = await P.page.$('.tp-hand .card:not(.selected)');
        if (el) await pressEl(P, el);
      }
    } else if (st.play) {
      if (!(toep && st.labels.includes('Toep!') && (await act(P, 'Toep!')))) await playCard(P);
    } else if (st.summary && ready) {
      await press(P, '.tp-summary .btn-go');
    }
    await sleep(150);
  }
  throw new Error(`[${P.name}] timeout playing until ${stop}`);
}

// Runs one scenario in its own page, each in a fresh browser context.
async function scenario(browser, name, fn) {
  const P = await openPage(browser, VIEWPORTS[name], `toepen-${name}`, A.dpr);
  await ownAddress(P, BASE);
  // Expert mode: the reasoning of the AI shows in the top bar.
  await P.page.evaluateOnNewDocument(() => localStorage.setItem('kj.expert', '1'));
  await P.page.evaluateOnNewDocument(holdHook);
  try {
    await fn(P);
  } catch (e) {
    await shot(P, 'zz-failure').catch(() => {});
    P.errors.push(`[${P.name}] ${e.message || e}`);
  } finally {
    await P.ctx.close().catch(() => {});
  }
  return P.errors;
}

// Home, new game, lobby, the table with its questions and overlays, the
// summary of a round.
async function mainFlow(P) {
  const { page } = P;
  // Request budget (design §9): at most 17 requests per page load with the
  // websocket, so 16 over HTTP.
  const requests = [];
  const count = r => { if (!r.url().includes('/ws')) requests.push(r.url()); };
  page.on('request', count);
  await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
  await waitFor(P, () => document.querySelector('#btn-quick'), { label: 'home' });
  page.off('request', count);
  if (requests.length > 16) throw new Error(`${requests.length} requests on page load:\n${requests.join('\n')}`);
  await snap(P, '01-home');
  await type(P, '#name', 'Piet');

  await newGame(P, { players: '4', tempo: 'Snel' }, '02-new-game');
  await sleep(300);
  await snap(P, '03-lobby');
  await holdOn(P, WAS);
  await press(P, '#btn-start:not(:disabled)');

  // The time for a vuile was: every hand starts with it.
  await waitFor(P, () => [...document.querySelectorAll('.tp-actions .btn b')].some(b => b.textContent === 'Geen'), { label: 'vuile was?', timeout: 60000 });
  await sleep(400);
  await snap(P, '04-was');
  await act(P, 'Geen');
  await release(P);

  const shots = { check: { label: '05-check' }, toep: { label: '06-toep' } };
  await playUntil(P, '.tp-hand.mine .card.legal', { shots });
  await sleep(400);
  await snap(P, '07-my-turn');

  if (await shown(P, '.topbar .tb-why')) {
    await press(P, '.topbar .tb-why');
    await waitFor(P, () => document.querySelector('.tp-why.open .tp-why-advice'), { label: 'the reasoning of the AI', timeout: 60000 });
    await sleep(300);
    await snap(P, '08-why');
    await closeModal(P);
  }

  // Your card, and the next ones until the trick has two or more.
  await holdOn(P, PLAYED);
  await playCard(P);
  for (let k = 0; ; k++) {
    await waitFor(P, () => Array.isArray(window.__held), { label: 'a card played' });
    await sleep(700); // its flight
    if (await P.page.evaluate(() => document.querySelectorAll('.tp-trick .card').length >= 2)) break;
    if (k >= 6) throw new Error(`[${P.name}] no trick with two cards`);
    await holdOn(P, PLAYED);
    await release(P);
  }
  await snap(P, '09-trick');
  await release(P);

  await press(P, '.tp-pill');
  await waitFor(P, () => document.querySelector('.tp-stand.open'), { label: 'standings' });
  await sleep(300);
  await snap(P, '10-stand');
  await closeModal(P);

  await openTool(P, 'help', 'Spelregels toepen');
  await waitFor(P, () => document.querySelector('.tp-rules.open .tp-man'), { label: 'rules' });
  await sleep(300);
  await snap(P, '11-rules');
  await closeModal(P);

  await openTool(P, 'settings', 'Instellingen');
  await waitFor(P, () => document.querySelector('.m-settings.open'), { label: 'settings' });
  await sleep(300);
  await snap(P, '12-settings');
  await closeModal(P);

  if (await shown(P, '.topbar .tb-chat')) {
    await press(P, '.topbar .tb-chat');
    await waitFor(P, () => document.body.classList.contains('chat-open'), { label: 'chat drawer' });
    await sleep(350);
  }
  await type(P, '.chat-input', 'Hoi allemaal!');
  await page.keyboard.press('Enter');
  await sleep(1600);
  await snap(P, '13-chat');
  if (await has(P, 'body.chat-open')) await closeModal(P);

  await holdOn(P, HAND_END);
  await playUntil(P, '.tp-summary.open', { ready: false, shots });
  await sleep(1200);
  await snap(P, '14-summary');
  await release(P);
}

// Two players to the end, toeping where it can: game over.
async function overFlow(P) {
  await home(P);
  await newGame(P, { players: '2', tempo: 'Snel' });
  await press(P, '#btn-start:not(:disabled)');
  await playUntil(P, '.m-over.open', { toep: true, timeout: 420000, shots: { koning: { label: '16-koning' } } });
  await sleep(1200);
  await snap(P, '15-game-over');
}

// Score bijhouden: a new sheet, two rounds, the players.
async function scoreFlow(P) {
  await home(P);
  await press(P, '#btn-score');
  await waitFor(P, () => document.querySelector('.sc-modal.open .sc-names'), { label: 'Score bijhouden' });
  await sleep(300);
  for (const [k, name] of [[1, 'Anna'], [2, 'Kees'], [3, 'Mia']]) {
    await P.page.$eval(`.sc-names .sc-name-row:nth-child(${k + 1}) .sc-name-in`, e => e.scrollIntoView({ block: 'center' }));
    await type(P, `.sc-names .sc-name-row:nth-child(${k + 1}) .sc-name-in`, name);
  }
  await snap(P, '20-score-start');
  await P.page.$eval('.sc-modal .btn-go.btn-big', e => e.scrollIntoView({ block: 'center' }));
  await press(P, '.sc-modal .btn-go.btn-big');
  await waitFor(P, () => document.querySelector('.sc-root .sc-live.on') && document.querySelector('[data-key="w0"]'), { label: 'the sheet' });
  await sleep(300);
  await snap(P, '21-score-sheet');
  for (const [w, weg] of [['w1', 'p2'], ['w0', '']]) {
    await P.page.$eval(`[data-key="${w}"]`, e => e.scrollIntoView({ block: 'center' }));
    await press(P, `[data-key="${w}"]`);
    if (weg) await press(P, `[data-key="${weg}"]`);
    const n = await P.page.$$eval('.sc-table tbody tr', r => r.length).catch(() => 0);
    await P.page.$eval('[data-key="save"]', e => e.scrollIntoView({ block: 'center' }));
    await press(P, '[data-key="save"]:not(:disabled)');
    await waitFor(P, k => document.querySelectorAll('.sc-table tbody tr').length > k, { label: 'a round saved' }, n);
  }
  await P.page.evaluate(() => document.querySelector('.sc-modal .sc-chart')?.scrollIntoView({ block: 'center' }));
  await sleep(400);
  await snap(P, '22-score-rounds');
  await P.page.evaluate(() => document.querySelector('.sc-modal .dlg-body').scrollTo(0, 1e6));
  await sleep(300);
  await snap(P, '23-score-end');
  await press(P, '.sc-tool-btns .btn');
  await waitFor(P, () => document.querySelector('.sc-names-m.open'), { label: 'the players' });
  await sleep(300);
  await snap(P, '24-score-names');
}

async function run(name) {
  const browser = await connect(A.cdp);
  const errors = [];
  try {
    for (const flow of [mainFlow, overFlow, scoreFlow]) errors.push(...(await scenario(browser, name, flow)));
  } finally {
    await browser.disconnect();
  }
  return errors;
}

// Sequential by default: headless Chromium in its container has little shared memory.
const parallel = Math.max(1, Number(process.argv[process.argv.indexOf('--parallel') + 1]) || 1);
const errors = [];
for (let i = 0; i < names.length; i += parallel) {
  const batch = await Promise.all(names.slice(i, i + parallel).map(run));
  errors.push(...batch.flat());
}
proxy.close();
if (errors.length) {
  console.error('FAILED:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`ok: ${names.length} viewports, screenshots in test/ui/out/toepen-*`);
process.exit(0); // the proxy may still hold keep-alive connections
