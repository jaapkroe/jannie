// Drives the app through every screen at six viewport sizes and saves
// screenshots to test/ui/out/. Fails on console errors, uncaught exceptions,
// failed requests or horizontal overflow.
//
//   GAME=klaverjas scripts/dev-server 18300 -fast
//   scripts/chrome 9301
//   cd test/ui && node app-screens.mjs [--url http://127.0.0.1:18300] [--only phone,desktop] [--parallel 2] [--dpr 2]
//
// The first game has a seed (SEED) and we sit at seat 0 (Zuid in the
// lobby, which seats us at random), so its first hand is the same on every
// run: we are voorhand, choose hearts and lead the king, and the first
// trick has roem.
import {
  args, VIEWPORTS, press, type, snap, has, closeModal, waitFor, sleep, playLegal, addressProxy, countdownPatch,
  scenario, perViewport, finish,
} from './app-lib.mjs';

const A = args();
const proxy = await addressProxy(A.url);
const BASE = proxy.url;
const names = A.only ? A.only.split(',') : Object.keys(VIEWPORTS);

// The first game's seed (docs/server.md#the-seed). With four players its
// first hand has seat 3 as the dealer, so seat 0, ours, is voorhand, and the hearts
// K 10 9 8 7 with us, the jack, the ace and the queen one each with the
// others: with hearts trump the king led draws all three, and J Q K A are
// a vierkaart with stuk, 70 roem.
const SEED = '69610';

const isNarrow = P => P.vp.width < 600;

// Presses what may lie under its scroller's edge or a sheet's foot while
// still inside the viewport, where press sees no reason to scroll.
async function pressRow(P, sel) {
  const el = await P.page.waitForSelector(sel);
  await el.evaluate(e => e.scrollIntoView({ block: 'center', inline: 'center' }));
  await sleep(150);
  await press(P, sel);
}

async function openTool(P, tool, menuIndex) {
  if (isNarrow(P) && ['score', 'last', 'help', 'settings'].includes(tool)) {
    await press(P, '.topbar .tb-menu');
    await waitFor(P, () => document.querySelector('.m-menu.open'), { label: 'menu' });
    const items = await P.page.$$('.m-menu .menu-item');
    const box = await items[menuIndex].boundingBox();
    if (P.touch) await P.page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    else await P.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  } else {
    await press(P, `.topbar .tb-${tool}`);
  }
}

// Plays (trump, bid, cards, ready) until `stop` matches in the DOM.
async function playUntil(P, stop, { timeout = 180000, ready = true } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await has(P, stop)) return;
    const st = await P.page.evaluate(() => ({
      trump: !!document.querySelector('.panel-trump .suit-btn:not(:disabled)'),
      bid: !!document.querySelector('.panel-bid .btn-go:not(:disabled)'),
      play: !!document.querySelector('.hand.my-turn .card.legal'),
      summary: !!document.querySelector('.m-summary.open .btn-go:not(:disabled)'),
    }));
    if (st.trump) await press(P, '.panel-trump .suit-btn.advised:not(:disabled), .panel-trump .suit-btn:not(:disabled)');
    else if (st.bid) await press(P, '.panel-bid .btn-go');
    else if (st.play) await playLegal(P);
    else if (st.summary && ready) await press(P, '.m-summary .btn-go');
    await sleep(140);
  }
  throw new Error(`[${P.name}] timeout playing until ${stop}`);
}

async function newGame(P, { players = 4, hands = 4, tempo = 'snel', trumpMode = '', seed = '' } = {}, label = '') {
  await press(P, '#btn-new');
  await waitFor(P, () => document.querySelector('.m-new.open'), { label: 'new game sheet' });
  const pickOpt = async (row, value) => {
    const btns = await P.page.$$(`.m-new .opt-row:nth-child(${row}) .seg-btn`);
    for (const b of btns) {
      if ((await b.evaluate(e => e.textContent)) === value) {
        await b.evaluate(e => e.scrollIntoView({ block: 'center' }));
        await sleep(200);
        const box = await b.boundingBox();
        if (P.touch) await P.page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        else await P.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return;
      }
    }
    throw new Error(`option ${value} not found`);
  };
  await sleep(300);
  if (label) await snap(P, label);
  await pickOpt(1, String(players));
  await pickOpt(2, String(hands));
  if (trumpMode) await pickOpt(3, trumpMode);
  await pickOpt(6, tempo[0].toUpperCase() + tempo.slice(1));
  if (seed) await type(P, '.m-new .seed-field', seed);
  await press(P, '#btn-create');
  await waitFor(P, () => document.body.dataset.screen === 'lobby' && document.querySelector('.code-big span'), { label: 'lobby' });
}

async function home(P) {
  await P.page.goto(BASE + '/', { waitUntil: 'networkidle0' });
  await waitFor(P, () => document.querySelector('#btn-quick'), { label: 'home' });
  await type(P, '#name', 'Piet');
}

// The host moves to Zuid, seat 0, unless the lobby put them there: a tap
// on the empty place, then Zelf hier gaan zitten. The lobby is back at its
// top after, as for a host seated there at once.
async function sitSouth(P) {
  if (await has(P, '.ls-bottom.me')) return;
  await pressRow(P, '.ls-bottom .ls-main');
  await waitFor(P, () => document.querySelector('.m-bots.open .bot-item.sit'), { label: 'the bot picker' });
  await sleep(300);
  await press(P, '.m-bots .bot-item.sit');
  await waitFor(P, () => document.querySelector('.ls-bottom.me') && !document.querySelector('.m-bots'), { label: 'seated at Zuid' });
  await P.page.$eval('.lobby-main', e => e.scrollTo(0, 0));
}

// Home, new game, lobby, a full short game with all overlays.
async function mainFlow(P) {
  const { page } = P;
  // Request budget (docs/frontend.md#request-budget): at most 17 requests per
  // page load with the websocket, so 16 over HTTP (a headed browser adds the
  // favicon and a PNG icon for its install check; headless fetches neither).
  const requests = [];
  const count = r => { if (!r.url().includes('/ws')) requests.push(r.url()); };
  page.on('request', count);
  await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
  await waitFor(P, () => document.querySelector('#btn-quick'), { label: 'home' });
  page.off('request', count);
  if (requests.length > 16) throw new Error(`${requests.length} requests on page load:\n${requests.join('\n')}`);
  await snap(P, '01-home');
  await type(P, '#name', 'Piet');

  // New game sheet → lobby → start.
  await newGame(P, { hands: 4, tempo: 'snel', seed: SEED }, '02-new-game');
  await sitSouth(P);
  await sleep(300);
  await snap(P, '03-lobby');
  await press(P, '#btn-start:not(:disabled)');

  // The seed's first hand: we are voorhand, so the trump choice comes at once.
  await waitFor(P, () => document.querySelector('.panel-trump .suit-btn:not(:disabled)'), { label: 'the trump choice' });
  await sleep(400);
  await snap(P, '04-trump');
  await press(P, '.suit-btn[aria-label^="harten"]');
  await waitFor(P, () => document.querySelector('.hand.my-turn .card.legal'), { label: 'my turn' });
  await sleep(300);
  await snap(P, '05-my-turn');
  // The server's messages are held twice (holdHook), so these two shots do
  // not depend on its pace: at the trick's second card, and at its end.
  await P.page.evaluate(() => { window.kjHoldWhen = s => s.trick?.cards.length === 2; });
  if ((await playLegal(P, 'KH')) !== 'KH') throw new Error('the seed dealt no king of hearts to lead');
  await waitFor(P, () => window.kjHeld() && document.querySelectorAll('.trick .slot .card').length === 2, { label: 'mid trick' });
  await snap(P, '06-mid-trick');
  await P.page.evaluate(() => {
    window.kjHoldWhen = (s, m) => m.ev?.type === 'trick';
    window.kjRelease();
  });
  await waitFor(P, () => document.querySelector('.roem-burst'), { label: 'the roem of the first trick' });
  await sleep(400);
  await snap(P, '07-roem');
  await P.page.evaluate(() => window.kjRelease());

  // The summary with its countdown ring, as at a table of more people.
  await P.page.evaluate(countdownPatch);
  await playUntil(P, '.m-summary.open', { ready: false });
  await sleep(1500);
  await snap(P, '08-summary');
  await P.page.evaluate(() => { window.kjPatch = null; });

  await openTool(P, 'last', 1);
  await waitFor(P, () => document.querySelector('.m-last.open'), { label: 'last trick' });
  await sleep(300);
  await snap(P, '09-last-trick');
  await closeModal(P);

  await openTool(P, 'score', 0);
  await waitFor(P, () => document.querySelector('.m-score.open'), { label: 'score sheet' });
  await sleep(300);
  await snap(P, '10-score');
  await closeModal(P);

  if (await page.$eval('.topbar .tb-chat', e => getComputedStyle(e).display !== 'none')) {
    await press(P, '.topbar .tb-chat');
    await waitFor(P, () => document.body.classList.contains('chat-open'), { label: 'chat drawer' });
    await sleep(350);
  }
  await type(P, '.chat-input', 'Hoi allemaal!');
  await page.keyboard.press('Enter');
  await sleep(1600);
  await snap(P, '11-chat');
  if (await has(P, 'body.chat-open')) await closeModal(P);

  await openTool(P, 'help', 2);
  await waitFor(P, () => document.querySelector('.m-manual.open .man'), { label: 'manual' });
  await sleep(300);
  await snap(P, '12-manual');
  await closeModal(P);

  await openTool(P, 'settings', 3);
  await waitFor(P, () => document.querySelector('.m-settings.open'), { label: 'settings' });
  await sleep(300);
  await snap(P, '13-settings');
  await closeModal(P);

  await playUntil(P, '.m-over.open');
  await sleep(1200);
  await waitFor(P, () => document.querySelector('.m-over .review-line:not([hidden]):not(:disabled)'), { label: 'review line' });
  await snap(P, '14-game-over');

  await pressRow(P, '.m-over .review-line');
  await waitFor(P, () => document.querySelector('.m-review.open'), { label: 'review' });
  await sleep(300);
  await snap(P, '14b-review');
  await page.evaluate(() => document.querySelector('.m-review .dlg-body').scrollTo(0, 1e6));
  await sleep(300);
  await snap(P, '14b-review-end');
  await pressRow(P, '.m-review .rv-moment:not(:disabled)');
  await waitFor(P, () => document.querySelector('.m-replay.open .rp-moment.now'), { label: 'replay at the moment' });
  await sleep(300);
  await snap(P, '14c-replay-moment');
  await pressRow(P, '.m-replay .rp-tn:last-child');
  await waitFor(P, () => /Uitslag/.test(document.querySelector('.m-replay .rp-stand')?.textContent), { label: 'replay at the end of the hand' });
  await snap(P, '14d-replay-end');

  // The score sheet's last potje: a trick of it, and the hand in the
  // replay (handReview).
  await closeModal(P);
  await closeModal(P);
  await pressRow(P, '.m-over .btn-row .btn:first-child');
  await waitFor(P, () => document.querySelector('.m-score.open tr.tap'), { label: 'score sheet' });
  await pressRow(P, '.m-score tr.tap');
  await waitFor(P, () => document.querySelector('.m-score .review .mt'), { label: 'the last potje' });
  await pressRow(P, '.m-score .review .mt');
  await waitFor(P, () => document.querySelector('.m-last.open .last-replay'), { label: 'a trick of the last potje' });
  await sleep(300);
  await snap(P, '14e-trick');
  await pressRow(P, '.m-last.open .last-replay');
  // The hand's line; the replay lists a choice only from the player's first
  // one on, and a forced card is none.
  await waitFor(P, () => document.querySelector('.m-replay.open .rp-sum'), { label: 'the last potje in the replay' });
  await sleep(300);
  await snap(P, '14f-replay-hand');
}

// Gedraaid: the bidding panel.
async function bidFlow(P) {
  await home(P);
  await newGame(P, { hands: 4, tempo: 'snel', trumpMode: 'Gedraaid' });
  await press(P, '#btn-start:not(:disabled)');
  await playUntil(P, '.panel-bid .btn-go:not(:disabled)');
  await sleep(500);
  await snap(P, '15-bid');
}

// Vrij spelen with open cards: hint bubble and advised card.
async function trainingFlow(P) {
  await home(P);
  await press(P, '#btn-train');
  await waitFor(P, () => document.querySelector('.m-train.open'), { label: 'training sheet' });
  // A tap while the sheet still slides in can miss the switch.
  await waitFor(P, () => !document.querySelector('.m-train').getAnimations({ subtree: true }).some(a => a.effect.getComputedTiming().endTime < Infinity), { label: 'training sheet in place' });
  await pressRow(P, '#train-lesson-vrij');
  await waitFor(P, () => document.querySelector('#train-lesson-vrij[aria-checked="true"]'), { label: 'Vrij spelen chosen' });
  await pressRow(P, '.train-opts > summary');
  await waitFor(P, () => document.querySelector('.train-opts').open, { label: 'Spelopties open' });
  await pressRow(P, '#train-open');
  await waitFor(P, () => document.querySelector('#train-open:checked'), { label: 'open cards switched on' });
  await press(P, '#btn-train-go');
  await playUntil(P, '.hand.my-turn .card.hint', { timeout: 60000 });
  await sleep(500);
  await snap(P, '16-training');
}

const errors = await perViewport(A.cdp, names, async (browser, name) => {
  const errors = [];
  for (const flow of [mainFlow, bidFlow, trainingFlow]) errors.push(...(await scenario(browser, name, BASE, flow, { dpr: A.dpr })));
  return errors;
});
proxy.close();
finish(errors, `ok: ${names.length} viewports, screenshots in test/ui/out/`);
