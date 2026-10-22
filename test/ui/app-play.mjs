// Plays complete short games (4 potjes, tempo snel) through the UI only:
// trump choice, bidding, tapping legal cards, "Volgend potje", until the game
// is over. Then checks the score sheet and totals.
//
//   cd test/ui && node app-play.mjs [--url http://127.0.0.1:18100] [--cdp URL] [--only phone,desktop] [--gedraaid] [--multi] [--training]
//     [--players 2|3|4]
//
// Phone uses touch with two taps per card; desktop uses single mouse clicks.
// --multi: a host (desktop) and a guest who opens the /CODE link (phone)
// chat, the host seats a bot, and both play one game to the end.
// --training: two potjes of Oefenen, checking hints and tips.
// --players: the table size for the solo games (default 4): with three the
// auction and laying away, with two the piles.
import {
  args, connect, openPage, VIEWPORTS, press, pressEl, type, shot, waitFor, sleep, playLegal, addressProxy, ownAddress,
} from './app-lib.mjs';

const A = args();
const names = A.only ? A.only.split(',') : ['phone', 'desktop'];
const PLAYERS = Number(process.argv[process.argv.indexOf('--players') + 1]) || 4;
const proxy = await addressProxy(A.url);
const BASE = proxy.url;

async function pick(P, row, value) {
  const btns = await P.page.$$(`.m-new .opt-row:nth-child(${row}) .seg-btn`);
  for (const b of btns) {
    if ((await b.evaluate(e => e.textContent)) !== value) continue;
    await b.evaluate(e => e.scrollIntoView({ block: 'center' }));
    await sleep(150);
    const box = await b.boundingBox();
    if (P.touch) await P.page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    else await P.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return;
  }
  throw new Error(`option ${value} not found`);
}

async function newGame(P, players) {
  await press(P, '#btn-new');
  await waitFor(P, () => document.querySelector('.m-new.open'), { label: 'new game sheet' });
  await sleep(300);
  await pick(P, 1, String(players));
  await pick(P, 2, '4');
  if (A.has('gedraaid')) await pick(P, 3, 'Gedraaid');
  await pick(P, 6, 'Snel');
  await press(P, '#btn-create');
  await waitFor(P, () => document.querySelector('#btn-start, .lb-wait'), { label: 'lobby' });
  await sleep(300);
}

// Acts whenever the UI asks us to, until the game-over overlay shows.
// With `reloadAfter`, reloads the page once after that many cards to check
// that the stored seat token brings us straight back into the game.
async function playLoop(P, stats, reloadAfter = 0) {
  let lastSummary = 0;
  const deadline = Date.now() + 8 * 60000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`[${P.name}] game did not finish in time`);
    const st = await P.page.evaluate(() => ({
      over: !!document.querySelector('.m-over.open'),
      trump: !!document.querySelector('.panel-trump .suit-btn:not(:disabled)'),
      bid: !!document.querySelector('.panel-bid .btn-go:not(:disabled)'),
      auction: !!document.querySelector('.panel-auction .btn-pass:not(:disabled)'),
      discard: !!document.querySelector('.panel-discard'),
      play: !!document.querySelector('.hand.my-turn .card.legal'),
      summary: !!document.querySelector('.m-summary.open .btn-go:not(:disabled)'),
    }));
    if (st.over) return;
    if (st.auction) {
      await press(P, Math.random() < 0.4 ? '.panel-auction .btn-go' : '.panel-auction .btn-pass');
      stats.bids++;
      await sleep(120);
      continue;
    }
    if (st.discard) {
      // Two cards, then Wegleggen; the button only works with two chosen.
      for (const el of (await P.page.$$('.hand .card:not(.picked)')).slice(0, 2 - (await P.page.$$('.hand .card.picked')).length)) {
        await pressEl(P, el);
        await sleep(150);
      }
      await press(P, '.panel-discard .btn-go:not(:disabled)', { timeout: 3000 }).catch(() => {});
      stats.discards = (stats.discards || 0) + 1;
      await sleep(120);
      continue;
    }
    if (st.trump) {
      await press(P, '.panel-trump .suit-btn.advised:not(:disabled), .panel-trump .suit-btn:not(:disabled)');
      stats.trumps++;
    } else if (st.bid) {
      await press(P, Math.random() < 0.5 ? '.panel-bid .btn-go' : '.panel-bid .btn-pass');
      stats.bids++;
    } else if (st.play) {
      const before = await P.page.$$eval('.hand .card', els => els.length);
      const code = await playLegal(P);
      if (code) {
        await waitFor(P, (n, c) => document.querySelectorAll('.hand .card').length < n || !document.querySelector(`.hand .card[data-card="${c}"]`),
          { label: `card ${code} leaves the hand`, timeout: 10000 }, before, code);
        stats.plays++;
        if (stats.plays === reloadAfter) await reload(P);
      }
    } else if (st.summary && Date.now() - lastSummary > 1500) {
      lastSummary = Date.now();
      await sleep(700);
      // With -fast pacing the summary may already have moved on by itself.
      if (await press(P, '.m-summary .btn-go:not(:disabled)', { timeout: 1500 }).catch(() => null)) stats.hands++;
    }
    await sleep(120);
  }
}

async function reload(P) {
  const before = await P.page.evaluate(() => ({ path: location.pathname, hand: document.querySelectorAll('.hand .card').length }));
  await P.page.reload({ waitUntil: 'networkidle0' });
  await waitFor(P, () => document.body.dataset.screen === 'game' && document.querySelector('.hand .card'), { label: 'back in the game after reload' });
  const after = await P.page.evaluate(() => ({ path: location.pathname, hand: document.querySelectorAll('.hand .card').length }));
  if (after.path !== before.path) throw new Error(`[${P.name}] reload went to ${after.path}, want ${before.path}`);
  if (Math.abs(after.hand - before.hand) > 1) throw new Error(`[${P.name}] hand had ${before.hand} cards, ${after.hand} after reload`);
  console.log(`  ${P.name}: reloaded mid-game, rejoined ${after.path}`);
}

// After game over: one score-sheet row per potje, totals agree everywhere.
async function checkTotals(P) {
  const pill = await P.page.$$eval('.sp-num', els => els.map(e => Number(e.dataset.n ?? e.textContent)));
  const over = await P.page.$$eval('.os b', els => els.map(e => Number(e.textContent)));
  await press(P, '.m-over .btn-row .btn-ghost');
  await waitFor(P, () => document.querySelector('.m-score.open'), { label: 'score sheet' });
  const rows = await P.page.$$eval('.m-score tbody tr', els => els.length);
  const foot = await P.page.$$eval('.m-score tfoot td.num b', els => els.map(e => Number(e.textContent)));
  if (rows !== 4) throw new Error(`[${P.name}] score sheet has ${rows} rows, want 4`);
  if (String(pill) !== String(over) || String(foot) !== String(over)) {
    throw new Error(`[${P.name}] totals differ: pill ${pill}, game over ${over}, sheet ${foot}`);
  }
  return over.join('-');
}

const newStats = () => ({ plays: 0, trumps: 0, bids: 0, hands: 0 });

async function run(name) {
  const browser = await connect(A.cdp);
  const P = await openPage(browser, VIEWPORTS[name], 'play-' + name);
  await ownAddress(P, BASE);
  const t0 = Date.now();
  const stats = newStats();
  try {
    await P.page.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await type(P, '#name', 'Tester');
    await newGame(P, PLAYERS);
    await press(P, '#btn-start:not(:disabled)');
    await playLoop(P, stats, 3);
    await sleep(800);
    await shot(P, 'game-over');
    const totals = await checkTotals(P);
    if (stats.plays < 8) throw new Error(`only ${stats.plays} cards played`);

    // Rematch: the host starts a new match with the same table.
    await P.page.keyboard.press('Escape');
    await sleep(300);
    await press(P, '.m-over .btn-go');
    await waitFor(P, () => !document.querySelector('.m-over') && document.querySelector('.hand .card') && document.querySelector('.potje-n b')?.textContent === '1',
      { label: 'rematch dealt' });
    const fresh = await P.page.$$eval('.sp-num', els => els.map(e => Number(e.dataset.n ?? e.textContent)));
    if (fresh.some(n => n !== 0)) throw new Error(`rematch starts at ${fresh}, want all 0`);
    console.log(`  ${P.name}: game over in ${Math.round((Date.now() - t0) / 1000)} s, ${stats.plays} cards, ${stats.trumps} trump choices, ${stats.bids} bids${stats.discards ? `, ${stats.discards} discards` : ''}, totals ${totals}`);
  } catch (e) {
    await shot(P, 'zz-failure').catch(() => {});
    P.errors.push(`[${P.name}] ${e.message || e}`);
  } finally {
    await P.ctx.close().catch(() => {});
    await browser.disconnect();
  }
  return P.errors;
}

// Host creates a table with Nieuw spel, the guest follows the /CODE link,
// both chat, the host seats a chosen bot (and removes and re-adds it), starts,
// a chat line shows as a speech bubble mid-game, and both play to the end.
async function multi() {
  const browser = await connect(A.cdp);
  const H = await openPage(browser, VIEWPORTS.desktop, 'multi-host');
  const G = await openPage(browser, VIEWPORTS.phone, 'multi-guest');
  await ownAddress(H, BASE);
  await ownAddress(G, BASE);
  const t0 = Date.now();
  const hs = newStats();
  const gs = newStats();
  const sees = (P, text, label) => waitFor(P, t => [...document.querySelectorAll('.chat-list .msg-text')].some(e => e.textContent === t),
    { label }, text);
  const seatNames = P => P.page.$$eval('.lseat .ls-name', els => els.map(e => e.textContent));
  try {
    await H.page.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await type(H, '#name', 'Host');
    await newGame(H, 4);
    const code = await H.page.$$eval('.code-big span', els => els.map(e => e.textContent).join(''));
    if (!/^[A-Z]{4}$/.test(code)) throw new Error(`bad code ${code}`);
    const path = await H.page.evaluate(() => location.pathname);
    if (path !== '/' + code) throw new Error(`host url ${path}, want /${code}`);

    await G.page.goto(`${BASE}/${code}`, { waitUntil: 'networkidle0' });
    await waitFor(G, () => document.querySelector('.invite:not([hidden]) .btn-hero'), { label: 'invite card' });
    await type(G, '#name', 'Gast');
    await press(G, '.invite .btn-hero');
    await waitFor(G, () => document.body.dataset.screen === 'lobby', { label: 'guest in lobby' });
    await waitFor(H, () => [...document.querySelectorAll('.lseat .ls-name')].some(e => e.textContent === 'Gast'), { label: 'host sees guest' });
    // The guest takes the first empty seat: next to the host, as an opponent.
    const partners = await H.page.$eval('.ls-top .ls-name', e => e.textContent === 'Gast');

    // Chat both ways in the lobby: the host has the side panel, the guest a drawer with an unread badge.
    await type(H, '.chat-input', 'Hoi Gast, welkom!');
    await H.page.keyboard.press('Enter');
    await sees(G, 'Hoi Gast, welkom!', 'host chat on the guest page');
    await waitFor(G, () => document.querySelector('.lobby-bar .chat-badge:not([hidden])'), { label: 'unread badge' });
    await press(G, '.lobby-bar .tb-chat');
    await waitFor(G, () => document.body.classList.contains('chat-open'), { label: 'guest chat drawer' });
    await sleep(350);
    await type(G, '.chat-input', 'Hallo! Zin in.');
    await G.page.keyboard.press('Enter');
    await sees(H, 'Hallo! Zin in.', 'guest chat on the host page');
    await G.page.keyboard.press('Escape');
    await waitFor(G, () => !document.body.classList.contains('chat-open'), { label: 'guest chat closed' });

    // The host seats Bakker Vera on an empty seat, removes her, and seats her again.
    const addVera = async () => {
      await press(H, '.lseat.empty .ls-main');
      await waitFor(H, () => document.querySelector('.m-bots.open'), { label: 'bot picker' });
      await sleep(300);
      const items = await H.page.$$('.m-bots .bot-item');
      let found = null;
      for (const it of items) if ((await it.evaluate(e => e.textContent)).includes('Bakker Vera')) found = it;
      if (!found) throw new Error('Bakker Vera not in the bot picker');
      await pressEl(H, found);
      await waitFor(H, () => [...document.querySelectorAll('.lseat .ls-name')].some(e => e.textContent === 'Bakker Vera (AI)'), { label: 'bot seated' });
    };
    await addVera();
    await press(H, '.lseat.bot .ls-x');
    await waitFor(H, () => ![...document.querySelectorAll('.lseat .ls-name')].some(e => e.textContent === 'Bakker Vera (AI)'), { label: 'bot removed' });
    await addVera();
    await waitFor(G, () => [...document.querySelectorAll('.lseat .ls-name')].some(e => e.textContent === 'Bakker Vera (AI)'), { label: 'guest sees the bot' });
    const before = await seatNames(H);
    if (before.filter(n => n === 'AI-speler').length !== 1) throw new Error(`want one empty seat before start, host sees ${before}`);

    await press(H, '#btn-start:not(:disabled)');
    await Promise.all([H, G].map(P => waitFor(P, () => document.body.dataset.screen === 'game' && document.querySelectorAll('.seat:not(.empty)').length === 4,
      { label: 'game with four players' })));
    const players = await H.page.$$eval('.seat .nm', els => els.map(e => e.textContent));
    if (!players.includes('Bakker Vera (AI)') || !players.includes('Gast') || players.filter(n => / \(AI\)$/.test(n)).length !== 2) {
      throw new Error(`unexpected players at the table: ${players}`);
    }

    // A quick reaction from the guest shows as chat and as a bubble at the guest's seat on the host page.
    await waitFor(G, () => document.querySelectorAll('.hand .card').length === 8, { label: 'guest dealt' });
    await press(G, '.topbar .tb-chat');
    await waitFor(G, () => document.body.classList.contains('chat-open'), { label: 'guest chat drawer in game' });
    await sleep(350);
    await press(G, '.chat-quick .quick');
    await G.page.keyboard.press('Escape');
    await sees(H, '👍', 'quick reaction on the host page');
    await waitFor(H, () => [...document.querySelectorAll('.seat .bubble:not([hidden])')].some(b => b.textContent === '👍'), { label: 'speech bubble' });

    await Promise.all([playLoop(H, hs), playLoop(G, gs)]);
    await sleep(800);
    await shot(H, 'game-over');
    await shot(G, 'game-over');
    const a = await checkTotals(H);
    const b = await checkTotals(G);
    const want = partners ? a : a.split('-').reverse().join('-');
    if (b !== want) throw new Error(`host sees Wij-Zij ${a}, guest sees ${b}, want ${want}`);

    // The guest leaves; the host is told by name (the seat keeps it until a rematch gives it a bot).
    await G.page.keyboard.press('Escape');
    await sleep(300);
    await press(G, '.m-over .btn-row .btn-ghost:last-child');
    await waitFor(G, () => document.body.dataset.screen === 'home' && location.pathname === '/', { label: 'guest back home' });
    await waitFor(H, () => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Gast is vertrokken')), { label: 'leave toast on the host page' });
    console.log(`  multi: game over in ${Math.round((Date.now() - t0) / 1000)} s, host ${hs.plays} cards, guest ${gs.plays} cards, totals ${a}`);
  } catch (e) {
    await shot(H, 'zz-failure').catch(() => {});
    await shot(G, 'zz-failure').catch(() => {});
    H.errors.push(`[multi] ${e.message || e}`);
  } finally {
    await H.ctx.close().catch(() => {});
    await G.ctx.close().catch(() => {});
    await browser.disconnect();
  }
  return [...H.errors, ...G.errors];
}

// Training: Juf Ans as partner, a hint on every own turn (advised suit plus
// text in the trump panel, or glowing card plus text in the coach bubble) and
// an explanation after tricks, which is done with once you play your next
// card: it must not come back over the new trick. Two potjes, then leave
// through the menu.
async function training() {
  const browser = await connect(A.cdp);
  const P = await openPage(browser, VIEWPORTS.iphone, 'train-iphone');
  await ownAddress(P, BASE);
  // Counts the "tip" messages as they arrive.
  await P.page.evaluateOnNewDocument(() => {
    window.__tips = 0;
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...a) {
        super(...a);
        this.addEventListener('message', e => { if (String(e.data).startsWith('{"t":"tip"')) window.__tips++; });
      }
    };
  });
  const seen = { turns: 0, hinted: 0, tips: new Set(), after: 0, stale: [] };
  try {
    await P.page.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await type(P, '#name', 'Leerling');
    await press(P, '#btn-train');
    await waitFor(P, () => document.querySelector('.m-train.open'), { label: 'training sheet' });
    await sleep(300);
    const fast = await P.page.$$('.m-train .opt-row:nth-child(3) .seg-btn');
    await pressEl(P, fast[2]);
    await press(P, '#btn-train-go');
    await waitFor(P, () => document.body.dataset.screen === 'game', { label: 'training table' });
    const partner = await P.page.$eval('.seat-top .nm', e => e.textContent);
    if (partner !== 'Juf Ans (AI)') throw new Error(`partner is ${partner}, want Juf Ans (AI)`);
    const deadline = Date.now() + 6 * 60000;
    while (Date.now() < deadline) {
      const st = await P.page.evaluate(() => ({
        potje: Number(document.querySelector('.potje-n b')?.textContent),
        trump: !!document.querySelector('.panel-trump .suit-btn:not(:disabled)'),
        advisedSuit: !!document.querySelector('.panel-trump .suit-btn.advised'),
        play: !!document.querySelector('.hand.my-turn .card.legal'),
        hintCard: !!document.querySelector('.hand.my-turn .card.hint.legal'),
        coach: document.querySelector('.coach:not([hidden]):not(.is-tip) .coach-txt > span')?.textContent || '',
        // Trump advice is inside the panel (the coach bubble would be under it).
        panelHint: [...document.querySelectorAll('.panel-trump .panel-hint')].find(e => e.getClientRects().length)?.textContent || '',
        tip: document.querySelector('.coach.is-tip:not([hidden]) .coach-txt > span')?.textContent || '',
        summary: !!document.querySelector('.m-summary.open .btn-go:not(:disabled)'),
      }));
      if (st.tip) seen.tips.add(st.tip);
      if (st.summary && st.potje >= 2) break;
      if (st.trump) {
        seen.turns++;
        if (st.advisedSuit && st.panelHint) seen.hinted++;
        await press(P, '.panel-trump .suit-btn.advised:not(:disabled), .panel-trump .suit-btn:not(:disabled)');
      } else if (st.play) {
        await sleep(150); // the hint arrives with the state that opens the turn
        const ok = await P.page.evaluate(() => !!document.querySelector('.hand.my-turn .card.hint.legal')
          && !!document.querySelector('.coach:not([hidden]):not(.is-tip) .coach-txt > span')?.textContent);
        seen.turns++;
        if (ok) seen.hinted++;
        const tips = await P.page.evaluate(() => window.__tips);
        const code = await playLegal(P);
        if (code) {
          await waitFor(P, c => !document.querySelector(`.hand .card[data-card="${c}"]`), { label: `card ${code} played`, timeout: 10000 }, code);
          // No explanation from before this card, until the next one arrives.
          const stale = await P.page.evaluate(async n => {
            for (let t = 0; t < 14; t++) {
              const el = document.querySelector('.coach.is-tip:not([hidden]) .coach-txt > span');
              if (el && window.__tips === n) return el.textContent;
              await new Promise(ok => setTimeout(ok, 50));
            }
            return '';
          }, tips);
          seen.after++;
          if (stale) seen.stale.push(`after ${code}: "${stale.slice(0, 70)}"`);
        }
      } else if (st.summary) {
        await press(P, '.m-summary .btn-go');
      }
      await sleep(120);
    }
    if (seen.turns < 8) throw new Error(`only ${seen.turns} own turns in two potjes`);
    if (seen.hinted !== seen.turns) throw new Error(`hints on ${seen.hinted} of ${seen.turns} turns`);
    if (seen.tips.size < 4) throw new Error(`only ${seen.tips.size} different tips after tricks`);
    if (seen.stale.length) throw new Error(`the previous trick's explanation came back after ${seen.stale.length} of ${seen.after} own cards: ${seen.stale.slice(0, 3).join('; ')}`);
    await shot(P, 'training');
    await press(P, '.topbar .tb-menu');
    await waitFor(P, () => document.querySelector('.m-menu.open'), { label: 'menu' });
    await press(P, '.m-menu .menu-item.danger');
    await press(P, '.m-confirm .btn-danger');
    await waitFor(P, () => document.body.dataset.screen === 'home' && location.pathname === '/', { label: 'back home after leaving' });
    console.log(`  training: hints on all ${seen.turns} own turns, ${seen.tips.size} tips, none stale after ${seen.after} own cards, e.g. "${[...seen.tips][0]}"`);
  } catch (e) {
    await shot(P, 'zz-failure').catch(() => {});
    P.errors.push(`[training] ${e.message || e}`);
  } finally {
    await P.ctx.close().catch(() => {});
    await browser.disconnect();
  }
  return P.errors;
}

const errors = [];
if (A.has('multi')) errors.push(...(await multi()));
else if (A.has('training')) errors.push(...(await training()));
else for (const n of names) errors.push(...(await run(n)));
proxy.close();
if (errors.length) {
  console.error('FAILED:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('ok: complete games played');
process.exit(0); // the proxy may still hold keep-alive connections
