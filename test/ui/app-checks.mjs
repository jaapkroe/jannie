// Focused regression checks for the table, overlays and connection handling,
// against the real server from source with -fast pacing:
//
//   GAME=klaverjas scripts/dev-server 18300 -fast && scripts/chrome 9303
//   cd test/ui && node app-checks.mjs --url http://127.0.0.1:18300 --cdp http://127.0.0.1:9303 [--only coach,lost]
//
// Each check runs in fresh browser contexts, each with an address of its own
// (addressProxy in app-lib.mjs), so the server's per-address limits do not
// trip over a full run.
import { WebSocket as NodeWS } from 'ws';
import {
  args, connect, openPage, VIEWPORTS, press, pressEl, type, shot, waitFor, sleep, playLegal, addressProxy, nextIP, ownAddress, checkOverflow,
} from './app-lib.mjs';

const A = args();
const VP = {
  ...VIEWPORTS,
  smallLandscape: { width: 640, height: 360, isMobile: true, hasTouch: true, isLandscape: true, deviceScaleFactor: 1 },
  // The first iPhone SE, upright and on its side: the smallest cards there are.
  oldSE: { width: 320, height: 568, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
  oldSELandscape: { width: 568, height: 320, isMobile: true, hasTouch: true, isLandscape: true, deviceScaleFactor: 1 },
};

const proxy = await addressProxy(A.url);
const BASE = proxy.url;

// Wraps the page's WebSocket: records what is sent, can drop outgoing
// messages, make a socket deaf (a half-open connection), rewrite incoming
// messages (K.rewrite: text in, text out), hold them back for a while (from
// now, or after a given event) or block new sockets.
function netHooks() {
  const Native = window.WebSocket;
  const K = (window.__kj = { socks: [], sent: [], block: false });
  class HookedWS extends Native {
    constructor(url, protocols) {
      super(K.block ? String(url).replace(/\/ws$/, '/blocked') : url, protocols);
      this.__drop = null;
      this.__deaf = false;
      K.socks.push(this);
    }
    send(data) {
      let m = null;
      try { m = JSON.parse(data); } catch { /* not ours */ }
      if (m && m.t !== 'ping') K.sent.push(m);
      if (m && this.__drop?.(m)) return;
      super.send(data);
    }
    set onmessage(fn) {
      super.onmessage = fn && (e => {
        if (this.__deaf) return;
        if (K.rewrite) e = new MessageEvent('message', { data: K.rewrite(String(e.data)) });
        if (this.__hold) { this.__hold.push(() => fn(e)); return; }
        fn(e);
        if (this.__holdAfter && String(e.data).includes(`"type":"${this.__holdAfter}"`)) {
          this.__holdAfter = null;
          this.__hold = [];
        }
      });
    }
    get onmessage() { return super.onmessage; }
  }
  window.WebSocket = HookedWS;
  K.last = () => K.socks[K.socks.length - 1];
  K.release = () => {
    const q = K.last().__hold || [];
    K.last().__hold = null;
    for (const f of q) f();
    return q.length;
  };
}

// A game with other people proposes the call (call.js) in a dialog; the
// checks about other things answer it in advance, as a player can under
// Instellingen. With `call`, the page is asked.
async function page(browser, vp, name, { hooks = false, init = null, call = false } = {}) {
  const P = await openPage(browser, vp, name);
  await ownAddress(P, BASE);
  if (hooks) await P.page.evaluateOnNewDocument(netHooks);
  if (!call) await P.page.evaluateOnNewDocument(() => localStorage.setItem('kj.call', JSON.stringify({ ask: false })));
  if (init) await P.page.evaluateOnNewDocument(init);
  return P;
}

async function home(P, name = 'Tester', path = '/') {
  await P.page.goto(BASE + path, { waitUntil: 'networkidle0' });
  await waitFor(P, () => document.querySelector('#name'), { label: 'home' });
  await type(P, '#name', name);
}

async function quick(P) {
  await press(P, '#btn-quick');
  await waitFor(P, () => document.body.dataset.screen === 'game' && document.querySelector('.hand .card'), { label: 'quick game' });
}

async function pickOpt(P, sheet, key, value) {
  const btns = await P.page.$$(`${sheet} .opt-row[data-key="${key}"] .seg-btn`);
  for (const b of btns) {
    if ((await b.evaluate(e => e.textContent)) !== value) continue;
    await b.evaluate(e => e.scrollIntoView({ block: 'center' }));
    await sleep(150);
    await pressEl(P, b);
    return;
  }
  throw new Error(`option ${value} not found`);
}

async function newGame(P, { players = 4, hands = 4 } = {}) {
  await press(P, '#btn-new');
  await waitFor(P, () => document.querySelector('.m-new.open'), { label: 'new game sheet' });
  await sleep(300);
  await pickOpt(P, '.m-new', 'players', String(players));
  await pickOpt(P, '.m-new', 'hands', String(hands));
  await pickOpt(P, '.m-new', 'tempo', 'Snel');
  await press(P, '#btn-create');
  await waitFor(P, () => document.body.dataset.screen === 'lobby' && document.querySelector('.code-big span'), { label: 'lobby' });
  return P.page.$$eval('.code-big span', els => els.map(e => e.textContent).join(''));
}

// The sheet Oefenen, at rest.
async function trainSheet(P) {
  await press(P, '#btn-train');
  await waitFor(P, () => document.querySelector('.m-train.open #btn-train-go'), { label: 'training sheet' });
  await sleep(300);
}

// Taps something in a sheet that scrolls under its foot and title, still
// inside the viewport.
async function pressRow(P, sel) {
  await P.page.$eval(sel, e => e.scrollIntoView({ block: 'center' }));
  await sleep(150);
  await press(P, sel);
}

async function pickLesson(P, lesson) {
  await pressRow(P, `#train-lesson-${lesson}`);
  await waitFor(P, l => document.querySelector(`#train-lesson-${l}`).getAttribute('aria-checked') === 'true', { label: `lesson ${lesson}` }, lesson);
}

async function openFold(P) {
  if (await P.page.$eval('.train-opts', e => e.open)) return;
  await pressRow(P, '.train-opts > summary');
  await waitFor(P, () => document.querySelector('.train-opts').open, { label: 'Spelopties open' });
}

// Starts a training game at tempo Snel, by default Vrij spelen: hints and
// explanations of tricks, no lesson.
async function training(P, trumpMode = 'Utrechts', { lesson = 'vrij' } = {}) {
  await trainSheet(P);
  await pickLesson(P, lesson);
  await openFold(P);
  if (trumpMode !== 'Utrechts') await pickOpt(P, '.m-train', 'trumpMode', trumpMode);
  await pickOpt(P, '.m-train', 'tempo', 'Snel');
  await press(P, '#btn-train-go');
  await waitFor(P, () => document.body.dataset.screen === 'game', { label: 'training table' });
}

const UI = () => ({
  trump: !!document.querySelector('.panel-trump .suit-btn:not(:disabled)'),
  bid: !!document.querySelector('.panel-bid .btn-go:not(:disabled)'),
  auction: !!document.querySelector('.panel-auction .btn-pass:not(:disabled)'),
  discard: !!document.querySelector('.panel-discard'),
  play: !!document.querySelector('.hand.my-turn .card.legal'),
  summary: !!document.querySelector('.m-summary.open .btn-go:not(:disabled)'),
  over: !!document.querySelector('.m-over.open'),
});

// Acts whenever the UI asks (advised trump, a random bid, a legal card,
// "Volgend potje") until stop() holds in the page.
async function playUntil(P, stop, { timeout = 120000, label = 'condition', ready = true } = {}, ...a) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await P.page.evaluate(stop, ...a)) return;
    const st = await P.page.evaluate(UI);
    if (st.trump) await press(P, '.panel-trump .suit-btn.advised:not(:disabled), .panel-trump .suit-btn:not(:disabled)');
    else if (st.bid) await press(P, Math.random() < 0.5 ? '.panel-bid .btn-go' : '.panel-bid .btn-pass');
    else if (st.auction) await press(P, Math.random() < 0.3 ? '.panel-auction .btn-go' : '.panel-auction .btn-pass');
    else if (st.discard) await layAway(P);
    else if (st.play) await playLegal(P);
    // -fast: the summary may be gone before the tap.
    else if (st.summary && ready) await press(P, '.m-summary .btn-go', { timeout: 1000 }).catch(() => {});
    await sleep(100);
  }
  throw new Error(`[${P.name}] timeout playing until ${label}`);
}

// Three players, playing alone: picks the first two cards and lays them away.
async function layAway(P) {
  for (const el of (await P.page.$$('.hand .card:not(.picked)')).slice(0, 2 - (await P.page.$$('.hand .card.picked')).length)) {
    await pressEl(P, el);
    await sleep(150);
  }
  await press(P, '.panel-discard .btn-go:not(:disabled)', { timeout: 3000 }).catch(() => {});
}

const toasts = P => P.page.$$eval('.toast', els => els.map(e => e.textContent));

// Points of el (fractions of its box) that are covered by something else.
function covered(P, sel, inside = sel) {
  return P.page.evaluate((s, ins) => {
    const el = document.querySelector(s);
    if (!el) return ['missing'];
    const b = el.getBoundingClientRect();
    const bad = [];
    for (const [fx, fy] of [[0.15, 0.3], [0.5, 0.5], [0.85, 0.7], [0.5, 0.2], [0.3, 0.8]]) {
      const hit = document.elementFromPoint(b.left + b.width * fx, b.top + b.height * fy);
      if (!hit?.closest(ins)) bad.push(hit ? `${hit.tagName}.${[...hit.classList].join('.')}` : 'nothing');
    }
    return bad;
  }, sel, inside);
}

// ---------- checks ----------

const CHECKS = {};

// Training: the trump/bid hint is readable (inside the panel; in short
// landscape the coach beside it), and ✕ closes a hint until the next one.
CHECKS.coach = async browser => {
  for (const vp of ['phone', 'iphone', 'desktop', 'landscape']) {
    const P = await page(browser, VP[vp], `coach-${vp}`);
    await run(P, async () => {
      await home(P, 'Leerling');
      await training(P);
      await playUntil(P, () => !!document.querySelector('.panel-trump .suit-btn:not(:disabled)'), { label: 'own trump choice', timeout: 180000 });
      await sleep(400);
      const st = await P.page.evaluate(() => {
        const hint = document.querySelector('.panel-trump .panel-hint');
        const coach = document.querySelector('.coach');
        return {
          hint: hint && getComputedStyle(hint).display !== 'none' ? hint.textContent : '',
          coach: coach && !coach.hidden && getComputedStyle(coach).display !== 'none' ? coach.textContent : '',
        };
      });
      if (vp === 'landscape') {
        if (!st.coach.startsWith('💡Tip ') || st.hint) throw new Error(`landscape: want the coach and no panel hint, got ${JSON.stringify(st)}`);
        const bad = await covered(P, '.coach .coach-body', '.coach');
        if (bad.length) throw new Error(`landscape: coach covered at ${bad}`);
      } else {
        if (!st.hint.startsWith('💡Tip ') || st.coach) throw new Error(`want the hint in the panel and no coach, got ${JSON.stringify(st)}`);
        const bad = await covered(P, '.panel-trump .panel-hint');
        if (bad.length) throw new Error(`panel hint covered at ${bad}`);
      }
      await shot(P, 'trump-hint');
      await press(P, '.panel-trump .suit-btn.advised:not(:disabled), .panel-trump .suit-btn:not(:disabled)');

      // A card hint in the coach: ✕ (tapped near its edge: a 44 px target) hides it.
      await playUntil(P, () => !!document.querySelector('.hand.my-turn .card.legal') && !document.querySelector('.coach[hidden]'), { label: 'card hint' });
      const x = await P.page.$eval('.coach-x', e => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
      const hit = await P.page.evaluate(p => document.elementFromPoint(p.x - 20, p.y)?.closest('.coach-x') != null, x);
      if (!hit) throw new Error('coach ✕ has no 44 px target');
      const before = await P.page.$eval('.coach .coach-body', e => e.textContent);
      if (P.touch) await P.page.touchscreen.tap(x.x - 20, x.y); else await P.page.mouse.click(x.x - 20, x.y);
      await sleep(250);
      if (!(await P.page.$('.coach[hidden]'))) throw new Error(`✕ did not close the hint "${before}"`);
      // The next own turn brings a hint again.
      await playLegal(P);
      await playUntil(P, () => !!document.querySelector('.hand.my-turn .card.legal') && !document.querySelector('.coach[hidden]'), { label: 'next hint', timeout: 30000 });
      // The robot: the reasoning of the decision now, as in the expert mode.
      await press(P, '.topbar .tb-expert');
      await waitFor(P, () => /Jij bent aan de beurt$/.test(document.querySelector('.m-why.open .why-head p')?.textContent || ''), { label: 'the reasoning sheet' });
      await waitFor(P, () => document.querySelector('.m-why .xp-why'), { label: 'the reasoning', timeout: 60000 });
      await checkOverflow(P, 'reasoning in training');
      await P.page.keyboard.press('Escape');
      await waitFor(P, () => !document.querySelector('.m-why.open'), { label: 'the sheet closed' });
    });
  }
  // Gedraaid: the bid advice inside the bidding panel.
  const P = await page(browser, VP.iphone, 'coach-bid');
  await run(P, async () => {
    await home(P, 'Leerling');
    await training(P, 'Gedraaid');
    await playUntil(P, () => !!document.querySelector('.panel-bid .btn-go:not(:disabled)'), { label: 'own bid', timeout: 180000 });
    await sleep(400);
    const bad = await covered(P, '.panel-bid .panel-hint');
    if (bad.length) throw new Error(`bid hint covered at ${bad}`);
    if (await P.page.$eval('.coach', e => !e.hidden && getComputedStyle(e).display !== 'none')) throw new Error('coach shows under the bid panel');
  });
};

// The lesson Basisspel, its first hand (issues #41, #45, #54): Juf Jannie's
// steps wait for Verder, a tap on the table or Enter, without a countdown,
// and light up what they are about; a double tap reads one step; the trump
// step's link opens the manual at Kaartwaarden and reads nothing; every
// trick of the first hand stays until its explanation is read; on the
// player's turn the hint follows the step; every step is a line of Juf
// Jannie in the chat, without a speech bubble at her seat.
CHECKS.lessons = async browser => {
  for (const vp of ['iphone', 'desktop']) {
    const P = await page(browser, VP[vp], `lessons-${vp}`);
    await run(P, async () => {
      await home(P, 'Leerling');
      await training(P, 'Utrechts', { lesson: 'basis' });
      const step = () => P.page.evaluate(() => {
        const c = document.querySelector('.coach');
        const go = document.querySelector('.coach-go');
        if (!c || c.hidden || !go || go.hidden || !go.classList.contains('no-ring')) return null;
        return { text: c.querySelector('.coach-txt').textContent, spot: document.querySelector('.spot')?.classList[0] || '', ring: !go.querySelector('.ring-cd').hasAttribute('hidden') };
      });
      const next = async (prev, label) => {
        await waitFor(P, p => {
          const c = document.querySelector('.coach');
          const go = document.querySelector('.coach-go');
          return c && !c.hidden && go && !go.hidden && c.querySelector('.coach-txt').textContent !== p;
        }, { label }, prev);
        await sleep(600); // past the moment in which a tap does not count yet
        return step();
      };
      // Beside the trick and the seats: the bare table.
      const feltAt = () => P.page.$eval('.table', e => { const b = e.getBoundingClientRect(); return { x: b.left + b.width * 0.5, y: b.top + b.height * 0.25 }; });
      const felt = async () => {
        const at = await feltAt();
        if (P.touch) await P.page.touchscreen.tap(at.x, at.y); else await P.page.mouse.click(at.x, at.y);
      };
      const texts = new Set(); // every step seen
      let st = await next('', 'the first step');
      texts.add(st.text);
      if (!st.text.includes('Ik ben Juf Jannie') || st.spot !== 'seat-id' || st.ring) throw new Error(`first step ${JSON.stringify(st)}`);
      await shot(P, 'lesson-intro');
      await felt();
      st = await next(st.text, 'step 2 by a tap on the table');
      texts.add(st.text);
      if (st.spot !== 'hand') throw new Error(`step 2 ${JSON.stringify(st)}`);
      // A double tap reads one step. The two taps go in the page, 80 ms
      // apart: through the DevTools protocol the second waits until the
      // page has drawn the next step, which can take longer than the
      // moment in which a tap does not count.
      const at = await feltAt();
      await P.page.evaluate(({ x, y }) => new Promise(done => {
        const el = document.elementFromPoint(x, y);
        el.click();
        setTimeout(() => { el.click(); done(); }, 80);
      }), at);
      st = await next(st.text, 'step 3');
      texts.add(st.text);
      await sleep(800);
      if (!(await step())?.text.startsWith('Om de beurt')) throw new Error(`a double tap read two steps: ${JSON.stringify(await step())}`);
      if (st.spot !== 'trick') throw new Error(`step 3 ${JSON.stringify(st)}`);
      if (!P.touch) {
        await P.page.keyboard.press('Enter');
        st = await next(st.text, 'step 4 by Enter');
        texts.add(st.text);
      }
      // On through the first hand: Verder, the advised trump, a legal card.
      let held = 0;
      let manual = false;
      let turnLesson = false;
      let read = '';
      for (let t0 = Date.now(); !(await P.page.$('.m-summary.open')); ) {
        if (Date.now() - t0 > 240000) throw new Error('first hand not over');
        const now = await step();
        if (now && now.text !== read) {
          read = now.text;
          texts.add(now.text);
          await sleep(500); // past the moment in which a tap does not count yet
          const ui = await P.page.evaluate(() => ({
            cards: document.querySelectorAll('.trick .slot .card').length,
            mine: !!document.querySelector('.hand.my-turn .card.legal'),
            glow: !!document.querySelector('.hand .card.hint'),
          }));
          if (ui.cards === 4 && held < 2) {
            // The trick waits for its explanation (at -fast it would be gone in a blink).
            await sleep(1500);
            if (await P.page.$$eval('.trick .slot .card', els => els.length) !== 4) throw new Error('the trick went before its explanation was read');
            held++;
          }
          const link = await P.page.evaluate(() => {
            const b = document.querySelector('.coach-man');
            return b && !b.hidden ? b.textContent : '';
          });
          if (link !== (now.text.includes('handleiding') ? 'Handleiding: Kaartwaarden' : '')) throw new Error(`step ${JSON.stringify(now)} with link "${link}"`);
          if (link) {
            manual = true;
            await shot(P, 'lesson-manual');
            await press(P, '.coach-man');
            await waitFor(P, () => document.querySelector('.m-manual.open .tab[aria-selected="true"]')?.textContent === 'Kaartwaarden', { label: 'the manual at Kaartwaarden' });
            await sleep(500); // the sheet slides in: a tap before it stands would miss ✕
            await press(P, '.m-manual .dlg-x');
            await waitFor(P, () => !document.querySelector('.m-manual.open'), { label: 'the manual closed' });
            if ((await step())?.text !== now.text) throw new Error('the manual link read the step');
            await sleep(500);
          }
          if (ui.mine && !turnLesson) {
            turnLesson = true;
            if (ui.glow || now.spot !== 'rule') throw new Error(`turn lesson ${JSON.stringify({ ...now, ...ui })}`);
            await shot(P, 'lesson-turn');
            await press(P, '.coach-go');
            await waitFor(P, () => document.querySelector('.coach .coach-lbl')?.textContent === 'Tip ' && document.querySelector('.hand .card.hint'), { label: 'the hint after the turn lesson' });
            continue;
          }
          await press(P, '.coach-go');
          continue;
        }
        const ui = await P.page.evaluate(UI);
        if (ui.trump) await press(P, '.panel-trump .suit-btn.advised:not(:disabled), .panel-trump .suit-btn:not(:disabled)');
        else if (ui.play && !now) await playLegal(P);
        await sleep(150);
      }
      if (held < 2 || !turnLesson || !manual || texts.size < 6 + 1 + 8 + 1) {
        throw new Error(`first hand: ${texts.size} steps, ${held} tricks held, turn lesson ${turnLesson}, manual ${manual}`);
      }
      const chat = await P.page.evaluate(() => ({
        coach: [...document.querySelectorAll('.chat-list .msg.coach-msg .msg-text')].map(e => e.textContent),
        bubbles: [...document.querySelectorAll('.seat .bubble')].map(e => e.textContent).filter(t => t.includes('Klaverjassen speel je')),
      }));
      const missing = [...texts].filter(t => !chat.coach.includes(t));
      if (missing.length || chat.bubbles.length) throw new Error(`chat lacks ${JSON.stringify(missing)}; bubbles ${JSON.stringify(chat.bubbles)}`);
    });
  }
  // The other lessons start with their own subject.
  for (const [lesson, first] of [['roem', 'In deze les leer je roem en troeven tellen.'], ['seinen', 'In deze les leer je seinen:']]) {
    const P = await page(browser, VP.iphone, `lessons-${lesson}`);
    await run(P, async () => {
      await home(P, 'Leerling');
      await training(P, 'Utrechts', { lesson });
      await waitFor(P, t => document.querySelector('.coach:not([hidden]) .coach-txt')?.textContent.startsWith(t), { label: `the first step of ${lesson}` }, first);
    });
  }
};

// The sheet Oefenen (issue #54): title, Juf Jannie's intro, the four lessons,
// the fold Spelopties and the start button, in that order. The fold is shut
// at first; Potjes shows for Vrij spelen only, Seinen for Seinen and Vrij
// spelen, and the button follows the lesson, at once. Every choice is kept
// in kj.train and read back with care: what is corrupt or stale falls back
// to its default, and who switched Speluitleg off before there were lessons
// starts on Vrij spelen. With Tips off, Open kaarten on or a seed the fold
// opens by itself. The create message carries the lesson, '' for Vrij
// spelen; the server sets a lesson's length and strength. With Tips off the
// robot still shows the decision awaited, without a hint.
CHECKS.lessonSheet = async browser => {
  for (const vp of ['oldSE', 'iphone', 'landscape', 'desktop']) {
    const P = await page(browser, VP[vp], `lesson-sheet-${vp}`);
    await run(P, async () => {
      await home(P);
      await trainSheet(P);
      await checkOverflow(P, 'the sheet Oefenen');
      await shot(P, 'sheet');
      await openFold(P);
      await pickLesson(P, 'vrij');
      await checkOverflow(P, 'the sheet Oefenen, all rows');
      await shot(P, 'sheet-open');
    });
  }
  const P = await page(browser, VP.iphone, 'lesson-sheet', { hooks: true });
  const sheet = () => P.page.evaluate(() => {
    const chosen = key => document.querySelector(`.m-train .opt-row[data-key="${key}"] [aria-checked="true"]`)?.textContent;
    return {
      lesson: document.querySelector('.train-lessons [aria-checked="true"]')?.id.replace('train-lesson-', ''),
      fold: document.querySelector('.train-opts').open,
      rows: [...document.querySelectorAll('.train-opts .opt-row')].filter(e => !e.hidden).map(e => e.dataset.key).join(),
      go: document.querySelector('#btn-train-go').textContent,
      tips: document.querySelector('#train-tips').checked,
      open: document.querySelector('#train-open').checked,
      seed: document.querySelector('.m-train .opt-row[data-key="seed"] input').value,
      tempo: chosen('tempo'), hands: chosen('hands'), ai: chosen('ai'),
      signals: [...document.querySelectorAll('.m-train .opt-row[data-key="signals"] [aria-pressed]')].map(e => e.getAttribute('aria-pressed')).join(),
    };
  });
  const stored = () => P.page.evaluate(() => JSON.parse(localStorage.getItem('kj.train') || 'null'));
  const close = async () => {
    await P.page.keyboard.press('Escape');
    await waitFor(P, () => !document.querySelector('.m-train'), { label: 'sheet closed' });
  };
  await run(P, async () => {
    await home(P);
    await trainSheet(P);
    const order = await P.page.evaluate(() => {
      const top = sel => document.querySelector(`.m-train ${sel}`)?.getBoundingClientRect().top ?? NaN;
      return {
        title: document.querySelector('.m-train h2').textContent,
        intro: document.querySelector('.m-train .train-intro p').textContent,
        lessons: [...document.querySelectorAll('.train-lessons .seg-btn')].map(e => [e.id, e.querySelector('b').textContent, e.querySelector('small').textContent]),
        heights: [...document.querySelectorAll('.train-lessons .seg-btn')].map(e => e.getBoundingClientRect().height),
        summary: document.querySelector('.train-opts > summary').textContent,
        tops: ['h2', '.train-intro', '.train-lessons', '.train-opts', '#btn-train-go'].map(top),
        sequence: [...document.querySelector('.m-train .dlg-body').children].map(e => e.className.split(' ').at(-1)),
      };
    });
    if (order.title !== 'Oefenen met Juf Jannie' || order.intro !== 'Je speelt samen met Juf Jannie tegen twee AI-spelers. Kies een les.' || order.summary !== 'Spelopties') throw new Error(`sheet texts ${JSON.stringify(order)}`);
    if (order.tops.some(Number.isNaN) || order.tops.some((t, i) => i && t <= order.tops[i - 1])) throw new Error(`sheet order ${order.tops}`);
    if (String(order.sequence) !== 'train-intro,train-lessons,train-opts,sheet-foot') throw new Error(`sheet parts ${order.sequence}`);
    const LESSONS = [
      ['train-lesson-basis', 'Basisspel', 'Kaarten, troef, bekennen en punten'],
      ['train-lesson-roem', 'Roem en tellen', 'Extra punten herkennen en troeven tellen'],
      ['train-lesson-seinen', 'Seinen', 'Je maat iets vertellen met je kaart'],
      ['train-lesson-vrij', 'Vrij spelen', 'Een heel spel met een tip bij elke beurt'],
    ];
    if (JSON.stringify(order.lessons) !== JSON.stringify(LESSONS)) throw new Error(`lessons ${JSON.stringify(order.lessons)}`);
    if (order.heights.some(x => x < 44)) throw new Error(`lesson rows of ${order.heights} px`);

    // At first: Basisspel, the fold shut, its contents out of sight.
    let st = await sheet();
    if (st.lesson !== 'basis' || st.fold || st.go !== 'Start les' || !st.tips || st.open || st.tempo !== 'Rustig' || st.seed !== '' || st.ai !== 'Normaal') throw new Error(`at first ${JSON.stringify(st)}`);
    if (await P.page.$eval('#train-tips', e => e.checkVisibility())) throw new Error('Tips shows in the shut fold');
    if (await stored()) throw new Error('kj.train stored before any choice');
    // Keyboard: the rows take the focus and answer the space bar.
    await P.page.focus('#train-lesson-roem');
    await P.page.keyboard.press('Space');
    await waitFor(P, () => document.querySelector('#train-lesson-roem').getAttribute('aria-checked') === 'true', { label: 'a lesson chosen by keyboard' });
    if ((await stored())?.lesson !== 'roem') throw new Error(`stored ${JSON.stringify(await stored())}`);

    // The rows and the button follow the lesson, in the fold too.
    await openFold(P);
    const tap = await P.page.$eval('.train-opts > summary', e => e.getBoundingClientRect().height);
    if (tap < 44) throw new Error(`Spelopties is a tap of ${tap} px`);
    const inFold = await P.page.$$eval('.train-opts > *', els => els.map(e => e.querySelector?.('input')?.id || e.className || e.tagName));
    if (String(inFold.slice(0, 4)) !== 'SUMMARY,train-tips,train-open,opts') throw new Error(`in the fold ${inFold}`);
    const small = await P.page.$$eval('.train-opts .set-txt small', els => els.map(e => e.textContent));
    if (String(small) !== 'Een tip bij elke beurt en uitleg na elke slag,Zie de kaarten van alle spelers') throw new Error(`switch texts ${small}`);
    for (const [lesson, rows, go] of [
      ['basis', 'trumpMode,rules,ai,tempo,seed', 'Start les'],
      ['roem', 'trumpMode,rules,ai,tempo,seed', 'Start les'],
      ['vrij', 'hands,trumpMode,rules,ai,tempo,signals,seed', 'Start oefenspel'],
      ['seinen', 'trumpMode,rules,ai,tempo,signals,seed', 'Start les'],
    ]) {
      await pickLesson(P, lesson);
      st = await sheet();
      if (st.rows !== rows || st.go !== go) throw new Error(`${lesson}: rows ${st.rows}, button ${st.go}`);
      if ((await stored())?.lesson !== lesson) throw new Error(`${lesson}: stored ${JSON.stringify(await stored())}`);
    }

    // The info of AI-sterkte says what the lesson does to it.
    await pressRow(P, '.m-train .opt-row[data-key="ai"] .info-btn');
    await waitFor(P, () => document.querySelector('.modal.m-info.open'), { label: 'info AI-sterkte' });
    if (!(await P.page.$eval('.modal.m-info.open', e => e.textContent)).includes('In de les over seinen spelen ze minstens op Normaal.')) throw new Error('no line on the lesson in the info of AI-sterkte');
    await P.page.keyboard.press('Escape');
    await waitFor(P, () => !document.querySelector('.modal.m-info'), { label: 'info closed' });

    // Tips off, Makkelijk: kept, and the fold opens by itself on return.
    await pressRow(P, '#train-tips');
    await waitFor(P, () => !document.querySelector('#train-tips').checked, { label: 'tips off' });
    if ((await stored()).tips !== false) throw new Error(`Tips off not stored: ${JSON.stringify(await stored())}`);
    await pickOpt(P, '.m-train', 'ai', 'Makkelijk');
    await pickOpt(P, '.m-train', 'tempo', 'Snel');
    await pickOpt(P, '.m-train', 'signals', 'Boer over boer');
    let kept = await stored();
    if (kept.lesson !== 'seinen' || kept.tips !== false || kept.open !== false || kept.ai !== 'makkelijk' || kept.tempo !== 'snel' || kept.seed !== null || !kept.signals?.boerOverBoer) throw new Error(`stored ${JSON.stringify(kept)}`);
    await close();
    await trainSheet(P);
    st = await sheet();
    if (st.lesson !== 'seinen' || !st.fold || st.tips || st.ai !== 'Makkelijk' || st.tempo !== 'Snel' || st.go !== 'Start les' || st.signals !== 'true,true,true,true') throw new Error(`reopened ${JSON.stringify(st)}`);
    await close();

    // What kj.train holds decides the fold; what makes no sense falls back.
    const put = (train, lessons = null) => P.page.evaluate((t, l) => {
      if (t == null) localStorage.removeItem('kj.train'); else localStorage.setItem('kj.train', t);
      if (l == null) localStorage.removeItem('kj.lessons'); else localStorage.setItem('kj.lessons', l);
    }, train, lessons);
    const DEFAULT = { lesson: 'basis', fold: false, tips: true, open: false, seed: '', tempo: 'Rustig', ai: 'Normaal', hands: '8', signals: 'true,true,true,false' };
    for (const [name, train, lessons, want] of [
      ['nothing to show', '{"lesson":"roem","tips":true,"open":false,"seed":null}', null, { lesson: 'roem' }],
      ['open cards', '{"open":true}', null, { fold: true, open: true }],
      ['a seed', '{"seed":4242}', null, { fold: true, seed: '4242' }],
      ['corrupt', '{"lesson":', null, {}],
      ['not an object', '5', null, {}],
      ['stale values', '{"lesson":"oud","tempo":"razend","hands":7,"ai":"max","tips":"ja","open":1,"seed":-1,"signals":3,"from":5}', null, {}],
      ['Speluitleg off before', null, '0', { lesson: 'vrij' }],
      ['Speluitleg on before', null, '1', {}],
      ['Speluitleg off, kj.train there', '{"lesson":"seinen"}', '0', { lesson: 'seinen' }],
    ]) {
      await put(train, lessons);
      await trainSheet(P);
      const got = await sheet();
      for (const [k, v] of Object.entries({ ...DEFAULT, ...want })) {
        if (got[k] !== v) throw new Error(`${name}: ${k} is ${got[k]}, want ${v}`);
      }
      await close();
    }
    await put(null);

    // A lesson at Makkelijk, with Tips off: the options as chosen go out.
    await P.page.evaluate(() => {
      const K = window.__kj;
      K.hints = 0;
      K.rewrite = data => {
        const m = data.includes('"t":"update"') ? JSON.parse(data) : null;
        if (m?.s) {
          K.opts = m.s.opts;
          if (m.s.hint) K.hints++;
        }
        return data;
      };
    });
    await put(JSON.stringify({ lesson: 'seinen', tips: false, ai: 'makkelijk', hands: 16, tempo: 'snel', signals: { aas: false, kleintjeBoer: false, hoogLaag: false, boerOverBoer: false } }));
    await trainSheet(P);
    await press(P, '#btn-train-go');
    await waitFor(P, () => document.body.dataset.screen === 'game' && window.__kj.opts, { label: 'the lesson at the table' });
    const creates = () => P.page.evaluate(() => window.__kj.sent.filter(m => m.t === 'create'));
    const first = (await creates())[0];
    if (!first.training || first.opts.lesson !== 'seinen' || first.opts.tips !== false || first.opts.ai !== 'makkelijk' || 'players' in first.opts || Object.values(first.opts.signals).some(Boolean)) throw new Error(`create ${JSON.stringify(first)}`);
    const lesson = await P.page.evaluate(() => window.__kj.opts);
    if (lesson.lesson !== 'seinen' || lesson.hands !== 8 || lesson.ai !== 'normaal' || !Object.values(lesson.signals).some(Boolean)) throw new Error(`the lesson at the table ${JSON.stringify(lesson)}`);
    await leaveTable(P);

    // Vrij spelen: lesson '', the hands as chosen; the decision awaited on
    // the robot's sheet, with Tips off and no hint.
    await P.page.evaluate(() => { window.__kj.opts = null; });
    await trainSheet(P);
    await pickLesson(P, 'vrij');
    await pickOpt(P, '.m-train', 'hands', '12');
    await press(P, '#btn-train-go');
    await waitFor(P, () => document.body.dataset.screen === 'game' && window.__kj.opts, { label: 'Vrij spelen at the table' });
    const second = (await creates())[1];
    if (second.opts.lesson !== '' || second.opts.hands !== 12 || second.opts.tips !== false) throw new Error(`create ${JSON.stringify(second)}`);
    const vrij = await P.page.evaluate(() => window.__kj.opts);
    if (vrij.lesson !== '' || vrij.hands !== 12) throw new Error(`Vrij spelen at the table ${JSON.stringify(vrij)}`);
    await playUntil(P, () => !!document.querySelector('.hand.my-turn .card.legal'), { label: 'own turn' });
    await press(P, '.tb-expert');
    await waitFor(P, () => /Jij bent aan de beurt$/.test(document.querySelector('.m-why.open .why-head p')?.textContent || ''), { label: 'the decision awaited with tips off' });
    const none = await P.page.evaluate(() => ({ hints: window.__kj.hints, marked: !!document.querySelector('.hand .card.hint') }));
    if (none.hints || none.marked) throw new Error(`help with tips off ${JSON.stringify(none)}`);
    await P.page.keyboard.press('Escape');
    await waitFor(P, () => !document.querySelector('.m-why.open'), { label: 'the sheet closed' });
  });
};

// Training on a short landscape screen: the coach in the top-left corner
// never covers the left seat (who plays after you) or the partner on top;
// a long text shows the lines that fit and "Lees verder", which opens it.
CHECKS.coachfit = async browser => {
  const LONG = 'Kees de Visser (AI) wint de slag met ♣A, de hoogste kaart in de gevraagde kleur. 27 punten. Juf Jannie had ♦10 aangeraden. Je maat had de slag al, dus gooi dan punten bij: een 10 of een aas van een kleur die je niet kunt bekennen.';
  for (const vp of ['smallLandscape', 'landscape']) {
    const P = await page(browser, VP[vp], `coachfit-${vp}`, { hooks: true });
    await run(P, async () => {
      await home(P, 'Leerling');
      await training(P);
      // Every settled coach text (hints and tips) during a few tricks.
      await P.page.evaluate(() => {
        const K = (window.__coach = { texts: new Set(), bad: [] });
        const coach = document.querySelector('.coach');
        setInterval(() => {
          if (coach.hidden || getComputedStyle(coach).display === 'none' || coach.classList.contains('open') || coach.getAnimations().length) return;
          const c = coach.getBoundingClientRect();
          const text = coach.querySelector('.coach-txt').textContent;
          K.texts.add(text);
          for (const sel of ['.seat-left .avatar', '.seat-top .avatar']) {
            const a = document.querySelector(sel).getBoundingClientRect();
            const w = Math.min(c.right, a.right) - Math.max(c.left, a.left);
            const h = Math.min(c.bottom, a.bottom) - Math.max(c.top, a.top);
            if (w > 0 && h > 0 && K.bad.length < 5) K.bad.push(`${sel} ${Math.round(w)}×${Math.round(h)} under "${text.slice(0, 60)}"`);
          }
        }, 120);
      });
      await playUntil(P, () => window.__coach.texts.size >= 10, { label: 'ten coach texts', timeout: 180000 });
      const seen = await P.page.evaluate(() => window.__coach.bad);
      if (seen.length) throw new Error(`coach covers ${seen}`);

      // A long explanation after a trick, the table held still from there.
      await P.page.evaluate(() => { window.__kj.last().__holdAfter = 'trick'; });
      await playUntil(P, () => !!window.__kj.last().__hold, { label: 'a completed trick' });
      await sleep(1500); // what came before the trick is animated by now
      await P.page.evaluate(async t => (await import('/js/table.js')).setTip(t), LONG);
      await sleep(500);
      const st = () => P.page.evaluate(() => {
        const coach = document.querySelector('.coach');
        const txt = coach.querySelector('.coach-txt');
        const c = coach.getBoundingClientRect();
        const hits = ['.seat-left .avatar', '.seat-top .avatar'].filter(sel => {
          const a = document.querySelector(sel).getBoundingClientRect();
          return Math.min(c.right, a.right) > Math.max(c.left, a.left) && Math.min(c.bottom, a.bottom) > Math.max(c.top, a.top);
        });
        const more = coach.querySelector('.coach-more');
        const m = more.getBoundingClientRect();
        const cx = m.left + m.width / 2;
        const cy = m.top + m.height / 2;
        const target = [[0, -21], [0, 21], [-21, 0], [21, 0]].every(([dx, dy]) => document.elementFromPoint(cx + dx, cy + dy)?.closest('.coach-more') === more);
        return {
          tip: coach.classList.contains('is-tip') && !coach.hidden, open: coach.classList.contains('open'),
          more: more.hidden ? '' : more.textContent, cut: txt.scrollHeight > txt.clientHeight + 1, hits, target,
        };
      });
      const shut = await st();
      if (!shut.tip || shut.open || shut.more !== 'Lees verder' || !shut.cut || shut.hits.length || !shut.target) throw new Error(`long tip, clamped: ${JSON.stringify(shut)}`);
      await shot(P, 'clamped');
      await press(P, '.coach-more');
      await sleep(300);
      const open = await st();
      if (!open.open || open.more !== 'Minder' || open.cut) throw new Error(`long tip, opened: ${JSON.stringify(open)}`);
      await shot(P, 'opened');
      await press(P, '.coach-more');
      await sleep(300);
      const again = await st();
      if (again.open || again.more !== 'Lees verder' || again.hits.length) throw new Error(`long tip, closed again: ${JSON.stringify(again)}`);
      await P.page.evaluate(() => window.__kj.release());
    });
  }
};

// A double tap on "Maak spel" must not also hit "Start spel" beneath it.
CHECKS.dbltap = async browser => {
  for (const vp of ['iphone', 'phone']) {
    const P = await page(browser, VP[vp], `dbltap-${vp}`, { hooks: true });
    await run(P, async () => {
      await home(P);
      await press(P, '#btn-new');
      await waitFor(P, () => document.querySelector('.m-new.open'), { label: 'new game sheet' });
      await sleep(400);
      const b = await (await P.page.$('#btn-create')).boundingBox();
      const x = b.x + b.width / 2;
      const y = b.y + b.height / 2;
      for (const gap of [150, 300]) {
        await P.page.touchscreen.tap(x, y);
        await sleep(gap);
        await P.page.touchscreen.tap(x, y);
        await sleep(1200);
        const st = await P.page.evaluate(() => ({ screen: document.body.dataset.screen, start: window.__kj.sent.filter(m => m.t === 'start').length }));
        if (st.screen !== 'lobby' || st.start) throw new Error(`double tap ${gap} ms: ${JSON.stringify(st)}`);
        if (await P.page.$eval('#btn-start', e => e.disabled)) throw new Error('start stays disabled');
        if (gap === 150) {
          await press(P, '.tb-back');
          await waitFor(P, () => document.body.dataset.screen === 'home', { label: 'home again' });
          await press(P, '#btn-new');
          await waitFor(P, () => document.querySelector('.m-new.open'), { label: 'new game sheet' });
          await sleep(400);
        }
      }
    });
  }
};

// The button under a trick of a finished hand that opens the hand in the
// replay: on screen without scrolling the trick view, and not covered.
const REPLAY_FIT = () => {
  const btn = document.querySelector('.m-last.open .last-replay');
  if (!btn) return ['missing'];
  const body = document.querySelector('.m-last.open .dlg-body');
  const b = btn.getBoundingClientRect();
  const bb = body.getBoundingClientRect();
  const bad = [];
  if (body.scrollTop > 0) bad.push(`scrolled ${body.scrollTop}`);
  if (b.top < 0 || b.bottom > innerHeight || b.left < 0 || b.right > innerWidth) bad.push(`outside the screen [${Math.round(b.top)}..${Math.round(b.bottom)}]`);
  if (b.bottom > bb.bottom + 1) bad.push(`below the visible body [${Math.round(b.bottom)} > ${Math.round(bb.bottom)}]`);
  const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  if (!hit?.closest('.last-replay')) bad.push(`covered by ${hit?.tagName}.${hit?.className}`);
  return bad;
};

// What the replay shows at its step: where it is, the line over the hand,
// the analysis boxes, the rings in the player's own hand and the dots in
// the trick bar.
const REPLAY_VIEW = () => ({
  title: document.querySelector('.m-replay .rp-title b')?.textContent,
  pos: document.querySelector('.m-replay .rp-pos')?.textContent,
  sum: document.querySelector('.m-replay .rp-sum')?.textContent,
  boxes: [...document.querySelectorAll('.m-replay .rp-choices > .rp-moment')].map(e => ({
    now: e.classList.contains('now'), where: e.querySelector('.rv-where')?.textContent, back: !!e.querySelector('[data-key="choice"]'),
  })),
  rings: [...document.querySelectorAll('.m-replay .rp-hands > .rp-hand:first-child .card:is(.rp-played, .rp-better)')].map(e => e.dataset.card),
  dots: [...document.querySelectorAll('.m-replay .rp-tn')].map(e => (e.classList.contains('missed') ? 'missed' : e.classList.contains('strong') ? 'strong' : '')),
  turn: !!document.querySelector('.m-replay .rp-turn')?.getClientRects().length,
});

// The replay of finished hand rh (a handReview) at the step just before
// the player's (you) card in trick t: the analysis boxes as design §9
// Terugkijken has them, the player's card ringed when graded there, a dot
// for every trick with points left or a strong move.
function replayAt(rh, you, t, v) {
  const before = d => {
    const tr = d.trick ? rh.tricks[d.trick - 1] : null;
    return tr ? 4 * (d.trick - 1) + Math.max(0, tr.cards.findIndex(pc => pc.seat === you)) : 0;
  };
  const step = before({ trick: t });
  const ti = Math.ceil(step / 4);
  const pos = step === 0 ? 'Voor de eerste kaart' : `Slag ${ti} · ${step - 4 * (ti - 1)} van 4 kaarten`;
  const now = rh.choices.filter(d => before(d) === step);
  const last = now.length ? [] : rh.choices.filter(d => before(d) < step).slice(-1);
  const boxes = [...now.map(d => ({ now: true, d })), ...last.map(d => ({ now: false, d }))]
    .map(({ now: n, d }) => ({ now: n, where: `Potje ${rh.hand}` + (d.trick ? `, slag ${d.trick}` : ''), back: !n }));
  // A card that lost and gained nothing is not ringed.
  const card = now.find(d => d.played?.card && (d.better || d.points > 0))?.played.card;
  const dots = rh.tricks.map((_, k) => {
    const d = rh.choices.find(x => x.trick === k + 1);
    return d?.better ? 'missed' : d?.points > 0 ? 'strong' : '';
  });
  const bad = [];
  if (v.pos !== pos) bad.push(`at "${v.pos}", want "${pos}"`);
  if (JSON.stringify(v.boxes) !== JSON.stringify(boxes)) bad.push(`boxes ${JSON.stringify(v.boxes)}, want ${JSON.stringify(boxes)}`);
  if (card && !v.rings.includes(card)) bad.push(`${card} not ringed: ${v.rings}`);
  if (!card && v.rings.length) bad.push(`rings ${v.rings} without a card graded here`);
  if (String(v.dots) !== String(dots)) bad.push(`dots ${v.dots}, want ${dots}`);
  return bad;
}

// Hand summary and score sheet: who played which card, running totals,
// and the review of the previous hand stays while updates arrive. The
// updates are held back while the overlays open (-fast pacing would move
// on first), then let through. A trick of the finished hand opens that
// hand in the replay (handReview): the line over the hand once its grades
// are in, the analysis at the player's card in that trick (a trick they
// led where there is one), open into the next hand until Escape. The
// score sheet's last potje offers the same.
CHECKS.review = async browser => {
  const P = await page(browser, VP.iphone, 'review', {
    hooks: true,
    init: () => localStorage.setItem('kj.opts', JSON.stringify({ hands: 4, tempo: 'snel' })),
  });
  await run(P, async () => {
    await home(P);
    await quick(P);
    // The finished hand as the state has it, and the last hand the server
    // sent to look back at.
    await P.page.evaluate(() => {
      const K = window.__kj;
      K.last().__holdAfter = 'handEnd';
      K.rewrite = data => {
        if (data.includes('"t":"handReview"')) K.handReview = JSON.parse(data);
        else if (data.includes('"phase":"handEnd"')) {
          const m = JSON.parse(data);
          if (m.s?.prevHand) K.ended = { you: m.s.you, hand: m.s.handNo, tricks: m.s.prevHand.tricks };
        }
        return data;
      };
    });
    await playUntil(P, () => !!document.querySelector('.m-summary.open'), { ready: false, label: 'summary' });
    await sleep(600);
    const tiles = await P.page.$$eval('.m-summary .mt', els => els.map(e => ({
      button: e.tagName === 'BUTTON',
      teams: [...e.querySelectorAll('.card')].map(c => c.dataset.team).join(','),
    })));
    if (tiles.length !== 8 || !tiles.every(t => t.button && /^(wij|zij)(,(wij|zij)){3}$/.test(t.teams))) throw new Error(`summary tiles ${JSON.stringify(tiles)}`);
    await press(P, '.m-summary .mt');
    await waitFor(P, () => document.querySelector('.m-last.open h2')?.textContent === 'Slag 1', { label: 'trick detail' });
    const cross = await P.page.$$eval('.m-last.open .cross-slot', els => els.map(e => e.textContent));
    if (cross.length !== 4 || cross.filter(t => t.includes('kwam uit')).length !== 1 || !cross.some(t => t.includes('Jij'))) throw new Error(`trick detail ${cross}`);
    const button = await P.page.$$eval('.m-last.open .last-replay', els => els.map(e => e.textContent.trim()));
    if (String(button) !== 'Dit potje terugkijken') throw new Error(`trick detail buttons ${button}`);
    // In short landscape the button sits beside the trick.
    for (const vp of ['landscape', 'smallLandscape']) {
      await P.page.setViewport(VP[vp]);
      await sleep(500);
      const bad = await P.page.evaluate(REPLAY_FIT);
      if (bad.length) throw new Error(`"Dit potje terugkijken" at ${vp}: ${bad.join('; ')}`);
      await shot(P, `trick-${vp}`);
    }
    await P.page.setViewport(VP.iphone);
    await sleep(500);
    await P.page.keyboard.press('Escape');
    await sleep(300);

    // A trick the player led (not the last, which has one card left), else
    // the first.
    const ended = await P.page.evaluate(() => window.__kj.ended);
    if (ended?.hand !== 1 || ended.tricks.length !== 8) throw new Error(`the end of potje 1 as seen: ${JSON.stringify(ended)}`);
    const led = ended.tricks.map((t, k) => (t.cards[0].seat === ended.you ? k + 1 : 0)).filter(t => t && t < 8);
    const trick = led.find(t => t > 1) || led[0] || 1;
    await press(P, `.m-summary .review > .mt:nth-child(${trick})`);
    await waitFor(P, t => document.querySelector('.m-last.open h2')?.textContent === `Slag ${t}`, { label: `trick ${trick}` }, trick);
    await P.page.evaluate(() => window.__kj.release());
    await press(P, '.m-last.open .last-replay');
    await waitFor(P, () => document.querySelector('.m-replay.open .rp-sum'), { label: 'the hand in the replay' });
    await waitFor(P, () => !/in berekening/.test(document.querySelector('.m-replay.open .rp-sum')?.textContent), { label: 'the grades of the hand', timeout: 90000 });
    await sleep(300);
    const hr = await P.page.evaluate(() => window.__kj.handReview);
    const asked = await P.page.evaluate(() => window.__kj.sent.filter(m => m.t === 'handReview'));
    if (asked.length !== 1 || asked[0].hand !== 1 || hr?.hand !== 1 || hr.pending !== 0 || !hr.replay.choices.length) {
      throw new Error(`handReview asked ${JSON.stringify(asked)}, answered ${JSON.stringify(hr && { hand: hr.hand, pending: hr.pending, choices: hr.replay.choices.length })}`);
    }
    const view = await P.page.evaluate(REPLAY_VIEW);
    const n = hr.replay.choices.length;
    const bad = replayAt(hr.replay, ended.you, trick, view);
    if (view.title !== 'Potje 1 van 4' || !view.sum.startsWith(`Volgens Juf Jannie: ${n}\u00a0${n === 1 ? 'keuze' : 'keuzes'}`) || view.turn) bad.push(`head ${JSON.stringify(view)}`);
    // A box once the player had a graded choice up to this trick (the card
    // there may have been the only one they could play).
    if (!view.boxes.length && hr.replay.choices.some(d => d.trick <= trick)) bad.push('no analysis at the player\'s card');
    if (bad.length) throw new Error(`replay of potje 1 at trick ${trick}: ${bad.join('; ')}`);
    const lead = led.includes(trick) && hr.replay.choices.some(d => d.trick === trick);
    if (lead && !view.boxes.some(b => b.now && b.where === `Potje 1, slag ${trick}`)) throw new Error(`the lead in trick ${trick} not at its step: ${JSON.stringify(view)}`);
    if (!lead) console.log(`    (no graded lead of the player in potje 1 besides the last trick: looked at trick ${trick})`);
    await shot(P, 'replay-hand');
    await checkOverflow(P, 'replay of a hand');

    // Ready (the summary lies under the replay): the replay stays open in
    // the next hand, says when it is the player's turn, closes with Escape.
    await P.page.evaluate(() => window.__kj.last().send(JSON.stringify({ t: 'ready' })));
    await waitFor(P, () => Number(document.querySelector('.potje-n b')?.textContent) === 2 && !document.querySelector('.m-summary'), { label: 'potje 2' });
    await waitFor(P, () => document.querySelector('.m-replay.open .rp-turn')?.getClientRects().length, { label: 'your turn, in the replay', timeout: 60000 });
    const still = await P.page.evaluate(REPLAY_VIEW);
    if (still.title !== 'Potje 1 van 4' || still.pos !== view.pos) throw new Error(`the replay in potje 2: ${JSON.stringify(still)}`);
    await P.page.keyboard.press('Escape');
    await waitFor(P, () => !document.querySelector('.m-replay.open'), { label: 'the replay closed' });

    // In the next hand: running totals per row, then the previous hand's
    // tricks, while the updates after a card of ours come in.
    await playUntil(P, () => Number(document.querySelector('.potje-n b')?.textContent) === 2 && !!document.querySelector('.hand.my-turn .card.legal'), { label: 'my turn in potje 2' });
    await P.page.evaluate(() => { window.__kj.last().__hold = []; });
    await playLegal(P);
    await press(P, '.score-pill');
    await waitFor(P, () => document.querySelector('.m-score.open .scoresheet'), { label: 'score sheet' });
    const sheet = await P.page.evaluate(() => ({
      rows: [...document.querySelectorAll('.m-score tbody tr:not(.live)')].map(tr => [...tr.querySelectorAll('td.num')].map(td => ({
        score: Number(td.querySelector('b').textContent), stand: td.querySelector('small.stand')?.textContent,
      }))),
      foot: [...document.querySelectorAll('.m-score tfoot td.num b')].map(b => Number(b.textContent)),
      names: [...document.querySelectorAll('.m-score thead .team-names')].map(e => e.textContent),
    }));
    const last = sheet.rows[sheet.rows.length - 1];
    if (!sheet.rows.length || !last.every((c, i) => c.stand === `stand ${sheet.foot[i]}`)) throw new Error(`running totals ${JSON.stringify(sheet)}`);
    if (!sheet.names.join(' ').includes('(AI)')) throw new Error(`team names without (AI): ${sheet.names}`);
    await press(P, '.m-score tr.tap');
    await waitFor(P, () => document.querySelector('.m-score .review'), { label: 'review' });
    const held = await P.page.evaluate(() => window.__kj.release());
    if (!held) throw new Error('no updates came in during the review');
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      const st = await P.page.evaluate(() => ({ review: !!document.querySelector('.m-score .review'), title: document.querySelector('.m-score h2').textContent }));
      if (!st.review || st.title !== 'Potje 1: de slagen') throw new Error(`review gone after ${(i + 1) * 500} ms: ${JSON.stringify(st)}`);
    }
    // A trick of it opens potje 1 in the replay too.
    await press(P, '.m-score .review .mt');
    await waitFor(P, () => document.querySelector('.m-last.open h2')?.textContent === 'Slag 1', { label: 'a trick of potje 1' });
    await press(P, '.m-last.open .last-replay');
    await waitFor(P, () => document.querySelector('.m-replay.open .rp-title b')?.textContent === 'Potje 1 van 4', { label: 'potje 1 in the replay, from the score sheet' });
    await P.page.keyboard.press('Escape');
    await waitFor(P, () => !document.querySelector('.m-replay.open'), { label: 'the replay closed' });
    await P.page.keyboard.press('Escape');
    await waitFor(P, () => !document.querySelector('.m-last.open'), { label: 'the trick closed' });
    await press(P, '.m-score .back-btn');
    await waitFor(P, () => document.querySelector('.m-score .scoresheet') && document.querySelector('.m-score h2').textContent === 'Scorebord', { label: 'back to the score sheet' });
  });
};

// The expert mode (issues #34, #54): five taps on the version open its
// sheet; seed 4242, potje 3 and Plaats 3 deal that hand alone with the
// player at seat 2, the chat names the seed at the start. On the player's
// turn the search button opens the sheet Redenering van de AI on the
// decision awaited, with the reasoning; ‹ goes to their card before,
// asked about and commented on (hand and trick, no seat). Over the hand
// summary the button opens the sheet again; the summary and game over
// have no replay of their own (the trick view's, as anyone) and no lobby.
CHECKS.expert = async browser => {
  const P = await page(browser, VP.iphone, 'expert', { hooks: true });
  await run(P, async () => {
    await home(P);
    for (let i = 0; i < 5; i++) await press(P, '.home-ver');
    await waitFor(P, () => document.querySelector('.m-train.open #btn-expert-go'), { label: 'expert sheet' });
    for (const [key, v] of [['seed', '4242'], ['from', '3']]) {
      await P.page.$eval(`.modal.open .opt-row[data-key="${key}"] input`, (e, v) => { e.value = v; e.dispatchEvent(new Event('change')); }, v);
    }
    if (!(await P.page.$eval('.modal.open .opt-row[data-key="hands"]', e => e.hidden))) throw new Error('the Potjes row shows with a potje');
    const rows = await P.page.$$eval('.modal.open .opt-row', els => els.map(e => e.dataset.key));
    if (rows[rows.indexOf('from') + 1] !== 'seat') throw new Error(`Plaats not right after Potje: ${rows}`);
    const seats = await P.page.$$('.modal.open .opt-row[data-key="seat"] .seg-btn');
    const labels = await Promise.all(seats.map(b => b.evaluate(e => e.textContent)));
    if (String(labels) !== '1,2,3,4') throw new Error(`Plaats ${labels}`);
    await seats[2].evaluate(e => e.scrollIntoView({ block: 'center' }));
    await sleep(150);
    await pressEl(P, seats[2]);
    await waitFor(P, () => JSON.parse(localStorage.getItem('kj.expert') || '{}').seat === 2, { label: 'Plaats 3 kept' });
    await shot(P, 'sheet');
    // The seat the server gives, and the state's.
    await P.page.evaluate(() => {
      const K = window.__kj;
      K.rewrite = data => {
        const m = data.includes('"t":"joined"') || data.includes('"t":"update"') ? JSON.parse(data) : null;
        if (m?.t === 'joined') K.seat = m.seat;
        if (m?.t === 'update' && m.s) K.you = m.s.you;
        return data;
      };
    });
    await press(P, '#btn-expert-go');
    await waitFor(P, () => document.body.dataset.screen === 'game' && document.querySelector('.potje-n b')?.textContent === '3', { label: 'potje 3' });
    const start = await P.page.$$eval('.chat-list .msg.sys', els => els.map(e => e.textContent));
    if (!start.some(t => t.includes('Spel (4242) begint: potje 3'))) throw new Error(`start line ${start}`);
    const created = await P.page.evaluate(() => window.__kj.sent.find(m => m.t === 'create'));
    if (!created?.expert || created.seat !== 2 || 'seat' in created.opts || created.opts.seed !== 4242 || created.opts.from !== 3) throw new Error(`create ${JSON.stringify(created)}`);
    const at = await P.page.evaluate(() => ({ seat: window.__kj.seat, you: window.__kj.you }));
    if (at.seat !== 2 || at.you !== 2) throw new Error(`seated at ${JSON.stringify(at)}, want 2`);

    // The decision awaited, with a choice.
    await playUntil(P, () => document.querySelectorAll('.hand .card').length <= 6 && document.querySelectorAll('.hand.my-turn .card.legal').length > 1, { label: 'my turn from trick 3 on, with a choice' });
    const trick = 9 - (await P.page.$$eval('.hand .card', els => els.length));
    const reasoning = () => P.page.evaluate(() => ({
      head: document.querySelector('.m-why .why-head p')?.textContent,
      rows: document.querySelectorAll('.m-why .xp-table tbody tr').length,
      // A heading per column, also when the engine adds a part of the value.
      columns: [...document.querySelectorAll('.m-why .xp-table tr')].every(tr => tr.children.length === document.querySelectorAll('.m-why .xp-table thead th').length),
      played: [...document.querySelectorAll('.m-why .xp-table tbody small')].map(e => e.textContent.trim()),
      lines: [...document.querySelectorAll('.m-why .xp-why > p b')].map(e => e.textContent.trim()),
      prev: document.querySelector('.m-why .why-head .icon-btn[aria-label="Vorige zet"]')?.disabled,
      next: document.querySelector('.m-why .why-head .icon-btn[aria-label="Volgende zet"]')?.disabled,
      // Sterk's card, whether a best (gold) row holds it, and its reason.
      sterk: (() => {
        const p = [...document.querySelectorAll('.m-why .xp-why > p')].find(e => e.querySelector('b')?.textContent === 'Sterk: ');
        const [card, ...why] = (p?.textContent.replace('Sterk: ', '') || '').split(' · ');
        const best = [...document.querySelectorAll('.m-why .xp-table tr.xp-best th')].map(e => e.textContent.replace(/\s*(gespeeld|gekozen)$/, '').trim());
        return { card, gold: best.includes(card), why: why.join(' · ') };
      })(),
    }));
    // Sterk on a card the search does not value most says why.
    const sterkOk = r => !r.rows || r.sterk.gold || r.sterk.why.length > 20;
    await press(P, '.tb-expert');
    await waitFor(P, t => document.querySelector('.m-why.open .why-head p')?.textContent === `Slag ${t} · Jij bent aan de beurt`, { label: 'the sheet on the decision now' }, trick);
    await waitFor(P, () => document.querySelector('.m-why .xp-why .xp-table tbody tr'), { label: 'the reasoning now', timeout: 60000 });
    const now = await reasoning();
    if (now.rows < 2 || !now.columns || now.played.length || String(now.lines) !== 'Normaal:,Sterk:,Tip:' || now.prev !== false || now.next !== true || !sterkOk(now)) throw new Error(`reasoning now ${JSON.stringify(now)}`);
    await checkOverflow(P, 'reasoning');
    await shot(P, 'why-now');

    // ‹: the card before, asked about by itself (no button); a comment on it.
    await press(P, '.m-why .why-head .icon-btn[aria-label="Vorige zet"]');
    await waitFor(P, t => document.querySelector('.m-why .why-head p')?.textContent.startsWith(`Slag ${t} · Jij speelde `) && document.querySelector('.m-why .xp-why'), { label: 'the reasoning before', timeout: 60000 }, trick - 1);
    if (await P.page.$('.m-why .why-out .btn')) throw new Error('a button in the reasoning');
    const before = await reasoning();
    if (String(before.lines) !== 'Normaal:,Sterk:,Tip:' || (before.rows && String(before.played) !== 'gespeeld') || before.next !== false || !sterkOk(before)) throw new Error(`reasoning before ${JSON.stringify(before)}`);
    // A card's row, tapped, is framed, and the line under the table says
    // why the best brings more; the best's own row says it is the best. (In
    // a near tie the gold rows, by tenths, hold the best and one even with
    // it.)
    if (before.rows) {
      const picked = () => P.page.evaluate(() => {
        const rows = [...document.querySelectorAll('.m-why .xp-table tbody tr')];
        return {
          sel: rows.findIndex(r => r.classList.contains('xp-sel')),
          other: rows.findIndex(r => !r.classList.contains('xp-best')),
          gold: rows.flatMap((r, k) => (r.classList.contains('xp-best') ? [k] : [])),
          cards: rows.map(r => r.querySelector('.xp-pick')?.textContent),
          said: document.querySelector('.m-why .xp-said')?.textContent || '',
        };
      });
      const start = await picked();
      const golds = start.gold.map(k => start.cards[k]);
      const pickRow = async k => pressEl(P, (await P.page.$$('.m-why .xp-table tbody tr'))[k]);
      if (start.other >= 0) {
        await pickRow(start.other);
        const got = await picked();
        if (got.sel !== start.other || !golds.some(c => got.said.startsWith(`${c}: volgens de berekening`) || got.said.startsWith(`${c} en `))) throw new Error(`a row picked ${JSON.stringify(got)}`);
        await shot(P, 'why-row');
      }
      let top = false;
      for (const k of start.gold) {
        await pickRow(k);
        const got = await picked();
        if (got.sel !== k || !(got.said === `${got.cards[k]} heeft de hoogste waarde.` || got.said.includes('even goed'))) throw new Error(`a gold row picked ${JSON.stringify(got)}`);
        top ||= got.said.endsWith('heeft de hoogste waarde.');
      }
      if (!top) throw new Error(`no row says it is the best: ${JSON.stringify(start)}`);
    }
    await press(P, '.m-why details.xp-fb > summary');
    await type(P, '.m-why .fb-text', 'Waarom deze kaart?');
    await press(P, '.m-why .fb .btn');
    // Saved: the text stays, marked, and Versturen waits for a change.
    const form = () => P.page.evaluate(() => ({
      text: document.querySelector('.m-why .fb-text')?.value, status: document.querySelector('.m-why .fb-status')?.textContent,
      saved: document.querySelector('.m-why .fb')?.classList.contains('saved'), send: document.querySelector('.m-why .fb .btn')?.disabled,
    }));
    await waitFor(P, () => document.querySelector('.m-why .fb-status')?.textContent === 'Bewaard.', { label: 'comment kept' });
    const kept = await form();
    if (kept.text !== 'Waarom deze kaart?' || !kept.saved || !kept.send) throw new Error(`after saving ${JSON.stringify(kept)}`);
    // ›: the decision awaited again, its answer kept, its own (empty) comment.
    await press(P, '.m-why .why-head .icon-btn[aria-label="Volgende zet"]');
    await waitFor(P, t => document.querySelector('.m-why .why-head p')?.textContent === `Slag ${t} · Jij bent aan de beurt` && document.querySelector('.m-why .xp-table tbody tr'), { label: 'the decision now again' }, trick);
    const other = await form();
    if (other.text !== '' || other.saved || other.status !== '' || other.send) throw new Error(`the comment of the decision now ${JSON.stringify(other)}`);
    // ‹ once more: the saved comment is back, no question asked again.
    await press(P, '.m-why .why-head .icon-btn[aria-label="Vorige zet"]');
    await waitFor(P, () => document.querySelector('.m-why .fb-text')?.value === 'Waarom deze kaart?' && document.querySelector('.m-why .fb.saved'), { label: 'the saved comment back' });
    await press(P, '.m-why .why-head .icon-btn[aria-label="Volgende zet"]');
    const sent = await P.page.evaluate(() => window.__kj.sent.filter(m => m.t === 'feedback' || m.t === 'why' || m.t === 'mark'));
    const fb = sent.filter(m => m.t === 'feedback');
    const whys = sent.filter(m => m.t === 'why').map(m => `${m.hand}/${m.trick}${'seat' in m ? '/seat' : ''}`);
    if (fb.length !== 1 || fb[0].hand !== 3 || fb[0].trick !== trick - 1 || 'seat' in fb[0] || String(whys) !== `3/${trick},3/${trick - 1}` || sent.some(m => m.t === 'mark')) {
      throw new Error(`sent ${JSON.stringify(sent)}`);
    }
    await P.page.keyboard.press('Escape');
    await waitFor(P, () => !document.querySelector('.m-why.open'), { label: 'the sheet closed' });

    await playUntil(P, () => !!document.querySelector('.m-summary.open'), { ready: false, label: 'the summary' });
    const foot = await P.page.$$eval('.m-summary .sum-foot button', els => els.map(e => e.textContent.trim()));
    if (!foot.includes('Naar de uitslag') || foot.some(t => t.includes('terugkijken'))) throw new Error(`summary buttons ${foot}`);
    // Over the summary, the sheet on the player's card before the last one
    // (the last had no choice).
    await press(P, '.tb-expert');
    await waitFor(P, () => /^Slag 7\b/.test(document.querySelector('.m-why.open .why-head p')?.textContent || ''), { label: 'the sheet over the summary' });
    const top = await P.page.evaluate(() => {
      const b = document.querySelector('.m-why.open .dialog').getBoundingClientRect();
      return document.elementFromPoint(b.left + b.width / 2, b.top + Math.min(b.height / 2, 40))?.closest('.modal')?.className;
    });
    if (!top?.includes('m-why')) throw new Error(`the sheet over the summary is under ${top}`);
    await P.page.keyboard.press('Escape');
    await waitFor(P, () => !document.querySelector('.m-why.open') && document.querySelector('.m-summary.open'), { label: 'back to the summary' });
    await press(P, '.m-summary .btn-go');
    await waitFor(P, () => document.querySelector('.m-over.open'), { label: 'game over' });
    const over = await P.page.$$eval('.m-over .btn-col button', els => els.filter(e => !e.hidden).map(e => e.textContent.trim()));
    if (over.some(t => t.includes('Spelers of regels') || t.includes('terugkijken'))) throw new Error(`game over buttons ${over}`);
  });
};

// Snel spelen with the last chosen options, named in its subtitle; it goes
// from home straight to the table without a lobby frame.
CHECKS.quick = async browser => {
  const P = await page(browser, VP.iphone, 'quick', {
    hooks: true,
    init: () => {
      localStorage.setItem('kj.opts', JSON.stringify({ players: 3, hands: 8, ai: 'sterk', open: true }));
      window.__screens = [];
      document.addEventListener('DOMContentLoaded', () => {
        new MutationObserver(() => window.__screens.push(document.body.dataset.screen))
          .observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
      });
    },
  });
  await run(P, async () => {
    await home(P);
    const sub = await P.page.$eval('#quick-sub', e => e.textContent);
    if (sub !== 'Twee AI-spelers · 8 potjes · AI sterk') throw new Error(`quick subtitle "${sub}"`);
    await quick(P);
    const st = await P.page.evaluate(() => ({
      screens: window.__screens, total: document.querySelector('.potje-n').textContent,
      create: window.__kj.sent.find(m => m.t === 'create'),
    }));
    if (st.screens.includes('lobby')) throw new Error(`the lobby flashed: ${st.screens}`);
    if (st.total !== '1/8' || st.create.opts.players !== 3 || 'open' in st.create.opts) throw new Error(`quick play ${JSON.stringify(st)}`);
  });
};

// Leaves the table through the ⋯ menu (phones: under 600 px wide).
async function leaveTable(P) {
  await press(P, '.topbar .tb-menu');
  await waitFor(P, () => document.querySelector('.m-menu.open'), { label: 'menu' });
  await sleep(250);
  await press(P, '.m-menu .menu-item.danger');
  await waitFor(P, () => document.querySelector('.m-confirm.open'), { label: 'leave?' });
  await sleep(250);
  await press(P, '.m-confirm .btn-danger');
  await waitFor(P, () => document.body.dataset.screen === 'home' && !document.body.classList.contains('busy'), { label: 'home again' });
  await sleep(300);
}

// Snel spelen and Oefenen start without a name: as "Speler", which is not
// kept as the player's name. Nieuw spel asks for one first (friends will
// see it), gently: the field takes the focus and a toast says why.
CHECKS.solo = async browser => {
  const P = await page(browser, VP.phone, 'solo', {
    hooks: true,
    init: () => localStorage.setItem('kj.opts', JSON.stringify({ hands: 4, tempo: 'snel' })),
  });
  await run(P, async () => {
    const st = () => P.page.evaluate(() => ({
      creates: window.__kj.sent.filter(m => m.t === 'create').map(m => [m.name, !!m.training]),
      stored: localStorage.getItem('kj.name'),
      field: document.getElementById('name').value,
      toasts: [...document.querySelectorAll('.toast-main')].map(t => t.textContent),
    }));
    await P.page.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await waitFor(P, () => document.querySelector('#btn-quick'), { label: 'home' });
    await quick(P);
    let s = await st();
    if (JSON.stringify(s.creates) !== '[["Speler",false]]' || s.stored !== null || s.toasts.length) throw new Error(`Snel spelen without a name: ${JSON.stringify(s)}`);
    // A reload goes back to the seat (its token), not to the invite that asks for a name.
    await P.page.reload({ waitUntil: 'networkidle0' });
    await waitFor(P, () => document.body.dataset.screen === 'game' && document.querySelector('.hand .card'), { label: 'back at the table after a reload' });
    const join = await P.page.evaluate(() => window.__kj.sent.find(m => m.t === 'join'));
    if (join?.name !== 'Speler' || !join.token) throw new Error(`rejoin after a reload: ${JSON.stringify(join)}`);
    await leaveTable(P);

    await press(P, '#btn-train');
    await waitFor(P, () => document.querySelector('.m-train.open'), { label: 'training sheet' });
    await sleep(300);
    await press(P, '#btn-train-go');
    await waitFor(P, () => document.body.dataset.screen === 'game', { label: 'training table' });
    s = await st();
    if (JSON.stringify(s.creates) !== '[["Speler",true]]' || s.stored !== null) throw new Error(`Oefenen without a name: ${JSON.stringify(s)}`);
    await leaveTable(P);
    s = await st();
    if (s.field !== '' || s.stored !== null) throw new Error(`the default name was kept: ${JSON.stringify(s)}`);

    await press(P, '#btn-new');
    await waitFor(P, () => document.activeElement?.id === 'name' && document.getElementById('name').classList.contains('ask'), { label: 'name field asked for' });
    await sleep(400);
    s = await st();
    if (await P.page.$('.m-new') || !s.toasts.includes('Hoe heet je?')) throw new Error(`Nieuw spel without a name: ${JSON.stringify(s)}`);
    await shot(P, 'asked');
    await P.page.keyboard.type('Anna');
    if (await P.page.$eval('#name', e => e.classList.contains('ask'))) throw new Error('the name field still asks after typing');
    await press(P, '#btn-new');
    await waitFor(P, () => document.querySelector('.m-new.open'), { label: 'new game sheet with a name' });
    s = await st();
    if (s.stored !== 'Anna') throw new Error(`typed name not kept: ${JSON.stringify(s)}`);
  });
};

// The hand summary shows the whole hand without scrolling: the headline,
// the score, all eight tricks and the button. On phones the tricks are a
// 4 × 2 grid; in landscape they sit beside the score. The result is
// rewritten to the tallest case (the opponents went nat: a long title, two
// lines under it and the "Waarom nat?" line), then to our pit; updates
// after the hand's end are held back so it stays open.
const SUMMARY_FIT = () => {
  const r = el => el.getBoundingClientRect();
  const body = document.querySelector('.m-summary .dlg-body');
  const tiles = [...document.querySelectorAll('.m-summary .mt')];
  const bad = [];
  if (body.scrollHeight > body.clientHeight + 1) bad.push(`scrolls ${body.scrollHeight} > ${body.clientHeight}`);
  const visible = (el, name) => {
    const b = r(el);
    if (b.top < 0 || b.bottom > innerHeight || b.left < 0 || b.right > innerWidth) bad.push(`${name} outside the screen`);
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    if (!hit || !(hit === el || el.contains(hit))) bad.push(`${name} covered by ${hit?.className}`);
  };
  tiles.forEach((t, i) => visible(t, `trick ${i + 1}`));
  visible(document.querySelector('.m-summary .btn-go'), 'button');
  const title = document.querySelector('.sum-title');
  if (r(title).height > parseFloat(getComputedStyle(title).fontSize) * 1.5) bad.push('the title wraps');
  const card = document.querySelector('.m-summary .mt .card');
  return {
    bad, tiles: tiles.length, title: title.textContent, cls: document.querySelector('.sum-head').className,
    sub: document.querySelector('.sum-sub').textContent, why: !!document.querySelector('.sum-why')?.getClientRects().length,
    cols: new Set(tiles.map(t => Math.round(r(t).left))).size, card: Math.round(r(card).width),
  };
};

CHECKS.summary = async browser => {
  const P = await page(browser, VP.phone, 'summary', {
    hooks: true,
    init: () => localStorage.setItem('kj.opts', JSON.stringify({ hands: 4, tempo: 'snel' })),
  });
  // Rewrites the next hand's result as seen by us (w): who played, nat, pit.
  const force = (playing, nat, pit) => P.page.evaluate((pl, na, pi) => {
    window.__kj.rewrite = data => {
      const m = JSON.parse(data);
      if (m.t !== 'update' || m.s?.phase !== 'handEnd') return data;
      const w = m.s.you % 2;
      const team = x => (x === 'wij' ? w : x === 'zij' ? 1 - w : -1);
      for (const res of [m.ev?.result, m.s.prevHand?.result]) {
        if (res) Object.assign(res, { playingTeam: team(pl), nat: na, pit: pi !== 'geen', pitTeam: team(pi) });
      }
      return JSON.stringify(m);
    };
    window.__kj.last().__holdAfter = 'handEnd';
  }, playing, nat, pit);
  const toSummary = async () => {
    await playUntil(P, () => !!document.querySelector('.m-summary.open'), { ready: false, label: 'summary' });
    await sleep(1600); // the numbers count up
  };
  await run(P, async () => {
    await home(P);
    await quick(P);
    await force('zij', true, 'geen');
    await toSummary();
    for (const vp of ['phone', 'iphone', 'landscape', 'smallLandscape']) {
      await P.page.setViewport(VP[vp]);
      await sleep(500);
      const st = await P.page.evaluate(SUMMARY_FIT);
      const wide = VP[vp].isLandscape;
      if (st.bad.length || st.tiles !== 8 || st.cols !== (wide ? 2 : 4) || st.title !== 'Zij gaan nat!' || st.cls !== 'sum-head nat good'
        || st.sub !== 'Zij spelen en halen het niet. Alle punten voor Wij!' || st.why !== !wide) {
        throw new Error(`summary at ${vp}: ${JSON.stringify(st)}`);
      }
      await shot(P, `nat-${vp}`);
    }
    await P.page.setViewport(VP.phone);
    await force('zij', true, 'wij');
    await P.page.evaluate(() => window.__kj.release());
    await press(P, '.m-summary .btn-go', { timeout: 3000 }).catch(() => {});
    await waitFor(P, () => !document.querySelector('.m-summary'), { label: 'the next hand' });
    await toSummary();
    const st = await P.page.evaluate(SUMMARY_FIT);
    if (st.bad.length || st.tiles !== 8 || st.title !== 'Pit!' || st.cls !== 'sum-head pit good') throw new Error(`our pit: ${JSON.stringify(st)}`);
    const glow = await P.page.$eval('.sum-title', e => getComputedStyle(e).textShadow);
    if (glow === 'none') throw new Error('our pit does not shine');
    await shot(P, 'pit-phone');
  });
};

// The sound button is a toggle: aria-pressed and the tooltip ("Geluid aan",
// "Geluid uit") follow the state, in the lobby bar and at the table, also
// after a reload.
CHECKS.sound = async browser => {
  const P = await page(browser, VP.desktop, 'sound');
  await run(P, async () => {
    const state = sel => P.page.$$eval(sel, els => els.map(e => `${e.getAttribute('aria-label')}|${e.getAttribute('aria-pressed')}|${e.title}|${e.classList.contains('muted')}`));
    await home(P);
    await newGame(P);
    const lobby = '.lobby-bar .tb-sound';
    let st = await state(lobby);
    if (st.join() !== 'Geluid|true|Geluid aan|false') throw new Error(`lobby, sound on: ${st}`);
    await press(P, lobby);
    await waitFor(P, () => [...document.querySelectorAll('.toast-main')].some(t => t.textContent === 'Geluid uit'), { label: 'toast Geluid uit' });
    st = await state(lobby);
    if (st.join() !== 'Geluid|false|Geluid uit|true') throw new Error(`lobby, sound off: ${st}`);
    await press(P, '#btn-start:not(:disabled)');
    await waitFor(P, () => document.body.dataset.screen === 'game', { label: 'table' });
    const table = '.topbar .tb-sound';
    st = await state(table);
    if (st.join() !== 'Geluid|false|Geluid uit|true') throw new Error(`table, sound off: ${st}`);
    await shot(P, 'off');
    await press(P, table);
    st = await state(table);
    if (st.join() !== 'Geluid|true|Geluid aan|false') throw new Error(`table, sound on: ${st}`);
    await shot(P, 'on');
    await press(P, table);
    await P.page.reload({ waitUntil: 'networkidle0' });
    await waitFor(P, () => document.body.dataset.screen === 'game', { label: 'table after a reload' });
    st = await state(table);
    if (st.join() !== 'Geluid|false|Geluid uit|true') throw new Error(`after a reload: ${st}`);
  });
};

// The home tiles at 360 px: "AI-spelers" stays whole, and each tile's line
// under its title fits on one line.
CHECKS.hometiles = async browser => {
  for (const vp of ['phone', 'iphone', 'landscape']) {
    const P = await page(browser, VP[vp], `hometiles-${vp}`);
    await run(P, async () => {
      await P.page.goto(BASE + '/', { waitUntil: 'networkidle0' });
      await waitFor(P, () => document.querySelector('#btn-quick'), { label: 'home' });
      const st = await P.page.evaluate(() => {
        const lines = el => {
          const rg = document.createRange();
          rg.selectNodeContents(el);
          return new Set([...rg.getClientRects()].map(b => Math.round(b.top))).size;
        };
        const sub = document.getElementById('quick-sub');
        const word = sub.querySelector('.nobreak');
        return {
          sub: sub.textContent, word: word?.textContent, wordLines: word ? lines(word) : 0, subLines: lines(sub),
          tiles: [...document.querySelectorAll('.btn-tile small')].map(e => [e.textContent, lines(e)]),
        };
      });
      if (st.sub !== 'Meteen aan tafel met drie AI-spelers' || st.word !== 'AI-spelers' || st.wordLines !== 1) throw new Error(`"AI-spelers" breaks: ${JSON.stringify(st)}`);
      if (vp === 'phone' && st.tiles.some(([, n]) => n !== 1)) throw new Error(`a tile wraps: ${JSON.stringify(st.tiles)}`);
      await shot(P, 'home');
    });
  }
};

// The support line beside the version, there only with the deployment's
// payment link (SUPPORT_URL, which the build puts in the meta support): a
// server from source has none, and no line. With one, as the build fills it
// in before the page reads it, its tap opens a short sheet with the link in
// a new tab, and is no tap on the version (the expert mode).
const SUPPORT_LINK = 'https://pay.example/r/AbC123?a=1&b=2';
CHECKS.support = async browser => {
  const P0 = await page(browser, VP.phone, 'support-none');
  await run(P0, async () => {
    await home(P0);
    const st = await P0.page.evaluate(() => ({ meta: document.querySelector('meta[name="support"]')?.content, btn: !!document.querySelector('#btn-support'), ver: document.querySelector('.home-ver')?.textContent }));
    if (st.btn || !st.ver?.startsWith('Versie ')) throw new Error(`without a payment link: ${JSON.stringify(st)}`);
    await shot(P0, 'home');
  });
  for (const vp of ['phone', 'oldSE']) {
    const P = await page(browser, VP[vp], `support-${vp}`);
    await P.page.evaluateOnNewDocument(url => document.addEventListener('readystatechange', () => {
      if (document.readyState === 'interactive') document.querySelector('meta[name="support"]').content = url;
    }), SUPPORT_LINK);
    await run(P, async () => {
      await home(P);
      const line = await P.page.evaluate(() => {
        const box = s => document.querySelector(s).getBoundingClientRect();
        const ver = box('.home-ver'), btn = box('#btn-support');
        const mid = btn.top + btn.height / 2;
        return { sameLine: mid > ver.top && mid < ver.bottom, gap: btn.left - ver.right, onScreen: btn.right <= innerWidth };
      });
      // 4 px of tap area either side: the two must not overlap.
      if (!line.sameLine || line.gap < 8 || !line.onScreen) throw new Error(`support line ${JSON.stringify(line)}`);
      await shot(P, 'home');
      for (let i = 0; i < 5; i++) {
        await press(P, '#btn-support');
        await waitFor(P, () => document.querySelector('.m-info.open a.btn-go'), { label: 'support sheet' });
        await P.page.keyboard.press('Escape');
        await waitFor(P, () => !document.querySelector('.modal.open'), { label: 'sheet closed' });
      }
      await press(P, '#btn-support');
      await waitFor(P, () => document.querySelector('.m-info.open a.btn-go'), { label: 'support sheet' });
      const a = await P.page.$eval('.m-info a.btn-go', e => ({ href: e.href, target: e.target, rel: e.rel, text: e.textContent }));
      if (a.href !== SUPPORT_LINK || a.target !== '_blank' || !a.rel.includes('noopener') || a.text !== 'Bijdragen met iDEAL') throw new Error(`support link ${JSON.stringify(a)}`);
      await shot(P, 'sheet');
    });
  }
};

// Touch: a lifted card says how to play it, and a tap beside the hand puts
// it down again, also one lifted while others play; a forced card plays on
// one tap. The chat badge stays dark for bot and system lines.
CHECKS.taps = async browser => {
  const P = await page(browser, VP.phone, 'taps');
  // Taps an empty spot of the felt; returns what is lifted then.
  const tapAside = async () => {
    const pt = await P.page.evaluate(() => {
      const t = document.querySelector('.table').getBoundingClientRect();
      const hand = document.querySelector('.hand');
      for (let fy = 0.35; fy < 0.7; fy += 0.05) {
        for (let fx = 0.1; fx < 0.9; fx += 0.1) {
          const x = t.left + t.width * fx;
          const y = t.top + t.height * fy;
          const el = document.elementFromPoint(x, y);
          if (el && !hand.contains(el) && !el.closest('button, a, .card, .panel, .bubble')) return { x, y };
        }
      }
      return null;
    });
    if (!pt) throw new Error('no empty spot on the felt');
    await P.page.touchscreen.tap(pt.x, pt.y);
    await sleep(250);
    return P.page.evaluate(() => ({
      lifted: [...document.querySelectorAll('.hand .card.selected')].map(e => e.dataset.card).join(),
      rule: document.querySelector('.rule').textContent,
    }));
  };
  await run(P, async () => {
    await home(P);
    await quick(P);
    let lifted = false;
    let forced = false;
    const aside = { mine: false, theirs: false };
    const t0 = Date.now();
    while ((!lifted || !forced || !aside.mine || !aside.theirs) && Date.now() - t0 < 120000) {
      const st = await P.page.evaluate(() => ({
        trump: !!document.querySelector('.panel-trump .suit-btn:not(:disabled)'),
        play: !!document.querySelector('.hand.my-turn .card.legal'),
        summary: !!document.querySelector('.m-summary.open .btn-go:not(:disabled)'),
        legal: document.querySelectorAll('.hand.my-turn .card.legal').length,
        theirs: document.querySelectorAll('.hand .card').length > 1 && !document.querySelector('.hand.my-turn')
          && document.querySelectorAll('.trick .card').length > 0 && document.querySelectorAll('.trick .card').length < 4,
      }));
      if (st.trump) await press(P, '.panel-trump .suit-btn:not(:disabled)');
      else if (st.summary) await press(P, '.m-summary .btn-go', { timeout: 1000 }).catch(() => {});
      else if (st.play) {
        const el = await P.page.$('.hand.my-turn .card.legal');
        const code = await el.evaluate(e => e.dataset.card);
        await pressEl(P, el);
        await sleep(350);
        const after = await P.page.evaluate(c => ({ hand: document.querySelectorAll('.hand .card').length, rule: document.querySelector('.rule').textContent, gone: !document.querySelector(`.hand .card[data-card="${c}"]`) }), code);
        if (st.legal === 1) {
          if (!after.gone) throw new Error(`the only legal card ${code} needed a second tap`);
          forced = true;
        } else {
          if (after.gone) throw new Error(`one tap played ${code} with ${st.legal} legal cards`);
          if (!after.rule.startsWith('Tik nog eens om ')) throw new Error(`no cue after lifting ${code}: "${after.rule}"`);
          lifted = true;
          if (!aside.mine) {
            const r = await tapAside();
            if (r.lifted || r.rule.startsWith('Tik nog eens om ')) throw new Error(`a tap beside the hand left ${r.lifted || code} lifted: "${r.rule}"`);
            aside.mine = true;
            await pressEl(P, el);
            await sleep(350);
          }
          const again = await P.page.$(`.hand .card.selected[data-card="${code}"]`);
          await pressEl(P, again);
        }
      } else if (st.theirs && !aside.theirs) {
        // Someone else's turn: a tap lifts a card, a tap beside puts it down.
        const el = await P.page.$('.hand .card');
        const code = await el.evaluate(e => e.dataset.card);
        await pressEl(P, el);
        await sleep(250);
        if (await P.page.$(`.hand .card.selected[data-card="${code}"]`)) {
          const r = await tapAside();
          if (r.lifted) throw new Error(`a tap beside the hand left ${r.lifted} lifted while others play`);
          aside.theirs = true;
        }
      }
      await sleep(120);
    }
    if (!lifted || !forced || !aside.mine || !aside.theirs) throw new Error(`saw lifted ${lifted}, forced ${forced}, put down ${JSON.stringify(aside)}`);
    const badge = await P.page.$eval('.topbar .chat-badge', e => (e.hidden ? '' : e.textContent));
    if (badge) throw new Error(`chat badge "${badge}" without anyone writing`);
  });
};

// A play, trump or answer lost on a dead socket does not freeze the table.
CHECKS.lost = async browser => {
  const P = await page(browser, VP.desktop, 'lost', { hooks: true });
  await run(P, async () => {
    await home(P);
    await quick(P);
    const myTurn = () => !!document.querySelector('.hand.my-turn .card.legal');
    const hand = () => P.page.$$eval('.hand .card', els => els.map(e => e.dataset.card));

    // (A) The play frame is lost, then the socket closes: the card comes back.
    await playUntil(P, myTurn, { label: 'my turn (A)' });
    await P.page.evaluate(() => { window.__kj.last().__drop = m => m.t === 'play'; });
    const code = await playLegal(P);
    await sleep(300);
    await P.page.evaluate(() => window.__kj.last().close());
    await waitFor(P, c => !!document.querySelector(`.hand.my-turn .card.legal[data-card="${c}"]`) && !document.querySelector('.slot-bottom .card'),
      { label: `${code} playable again after the rejoin`, timeout: 10000 }, code);
    await sleep(450); // the fan opens up again for the card that came back
    const n = (await hand()).length;
    await playLegal(P, code);
    await waitFor(P, (c, k) => !document.querySelector(`.hand .card[data-card="${c}"]`) && document.querySelectorAll('.hand .card').length === k - 1,
      { label: 'the card played after all', timeout: 10000 }, code, n).catch(async e => {
      throw new Error(`${e.message}\n  sent: ${await P.page.evaluate(() => JSON.stringify(window.__kj.sent.slice(-4)))}`);
    });

    // (B) The play arrives but no answer does (half-open socket): the
    // watchdog reconnects and the table follows the server again.
    await playUntil(P, myTurn, { label: 'my turn (B)' });
    const socks = await P.page.evaluate(() => window.__kj.socks.length);
    await P.page.evaluate(() => { window.__kj.last().__deaf = true; });
    const played = await playLegal(P);
    await waitFor(P, k => window.__kj.socks.length > k, { label: 'watchdog reconnect', timeout: 9000 }, socks);
    await waitFor(P, c => !document.querySelector(`.hand .card[data-card="${c}"]`), { label: 'resync after the reconnect', timeout: 8000 }, played);
    await playUntil(P, myTurn, { label: 'my turn after (B)' });
    const n2 = (await hand()).length;
    await playLegal(P);
    await waitFor(P, k => document.querySelectorAll('.hand .card').length === k - 1, { label: 'playing on after (B)', timeout: 10000 }, n2);

    // (C) The trump frame is lost, then the socket closes: the suits come back.
    await playUntil(P, () => !!document.querySelector('.panel-trump .suit-btn:not(:disabled)'), { label: 'own trump choice', timeout: 240000 });
    await P.page.evaluate(() => { window.__kj.last().__drop = m => m.t === 'trump'; });
    await press(P, '.panel-trump .suit-btn:not(:disabled)');
    await sleep(300);
    await P.page.evaluate(() => window.__kj.last().close());
    await waitFor(P, () => document.querySelectorAll('.panel-trump .suit-btn:not(:disabled)').length >= 3, { label: 'suit buttons back', timeout: 10000 });
    await press(P, '.panel-trump .suit-btn:not(:disabled)');
    await waitFor(P, () => !document.querySelector('.panel-trump'), { label: 'trump chosen', timeout: 10000 });
  });
};

// The update queue while the table animates, here the trump banner: a
// line we type shows at once, a bot line at our seat and another player's
// line wait for the animation, a line still queued when the socket closes
// is in the log once after the rejoin, and so is one we type while the
// rejoin's chat log waits. Leaving while the hand end animates opens no
// hand summary over the home screen.
CHECKS.queue = async browser => {
  const P = await page(browser, VP.phone, 'queue', {
    hooks: true,
    init: () => localStorage.setItem('kj.opts', JSON.stringify({ hands: 4, tempo: 'snel' })),
  });
  await run(P, async () => {
    await home(P);
    await quick(P);
    await P.page.evaluate(async () => {
      const { sound } = await import('/js/sound.js');
      const { app } = await import('/js/util.js');
      const K = window.__kj;
      const id = Math.floor(Math.random() * 1e6);
      const T = (window.__q = { mine: `eigen-${id}`, bot: `bot-${id}`, other: `ander-${id}`, late: `later-${id}` });
      const copies = t => [...document.querySelectorAll('.chat-list .msg-text')].filter(e => e.textContent === t).length;
      T.copies = () => ({ mine: copies(T.mine), bot: copies(T.bot), other: copies(T.other), late: copies(T.late) });
      const banner = () => !!document.querySelector('.fx .banner');
      K.rewrite = data => {
        const m = JSON.parse(data);
        if (m.t === 'chat' && m.msg.text === T.bot) {
          m.msg.bot = true; // the AI that played at our seat
        } else if (m.t === 'chat' && m.msg.text === T.other) {
          Object.assign(m.msg, { seat: m.msg.seat ? 0 : 1, name: 'Ander' });
          // The three echoes are in: what shows during the banner. Then the socket drops.
          setTimeout(() => { T.atOnce = T.copies(); T.echoEarly = banner(); K.last().close(); });
        } else {
          if (m.t === 'chatlog' && T.atOnce) {
            T.logEarly = banner();
            setTimeout(() => app.send({ t: 'chat', text: T.late })); // typed while the log waits its turn
          }
          if (m.t === 'chat' && m.msg.text === T.late) T.lateEarly = banner();
          return data;
        }
        return JSON.stringify(m);
      };
      const play = sound.play.bind(sound);
      sound.play = n => {
        if (n === 'trump' && !T.sent) {
          T.sent = true;
          for (const text of [T.mine, T.bot, T.other]) app.send({ t: 'chat', text });
        }
        if (T.leave && ['handWon', 'handLost', 'nat', 'pit'].includes(n)) {
          T.leave = false;
          setTimeout(() => app.leave(), 50); // a tap on Verlaten while the hand end animates
        }
        return play(n);
      };
    });
    await playUntil(P, () => !!window.__q.atOnce, { label: 'the lines during the trump banner' });
    await waitFor(P, () => !document.querySelector('.fx .banner') && window.__q.logEarly !== undefined, { label: 'the banner gone and the rejoin', timeout: 10000 });
    await sleep(1000);
    const st = await P.page.evaluate(() => {
      const T = window.__q;
      return { atOnce: T.atOnce, echoEarly: T.echoEarly, logEarly: T.logEarly, lateEarly: T.lateEarly, after: T.copies() };
    });
    if (!st.echoEarly || !st.logEarly || !st.lateEarly) throw new Error(`the echoes or the rejoin came after the banner, nothing queued to check: ${JSON.stringify(st)}`);
    if (JSON.stringify(st.atOnce) !== '{"mine":1,"bot":0,"other":0,"late":0}' || JSON.stringify(st.after) !== '{"mine":1,"bot":1,"other":1,"late":1}') {
      throw new Error(`chat lines during the banner and after the rejoin: ${JSON.stringify(st)}`);
    }

    await P.page.evaluate(() => { window.__q.leave = true; });
    await playUntil(P, () => document.body.dataset.screen === 'home', { label: 'leaving at the hand end' });
    await sleep(2500); // the hand end's animation is long over
    const left = await P.page.evaluate(async () => ({
      screen: document.body.dataset.screen,
      modals: [...document.querySelectorAll('#modals .modal.open')].map(m => m.className),
      s: !!(await import('/js/util.js')).app.s,
    }));
    if (left.screen !== 'home' || left.modals.length || left.s) throw new Error(`after leaving during the hand end: ${JSON.stringify(left)}`);
  });
};

// localStorage blocked: the seat survives a reconnect and the typed name is used.
CHECKS.nostorage = async browser => {
  const block = () => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
  const P = await page(browser, VP.iphone, 'nostorage', { hooks: true, init: block });
  const H = await page(browser, VP.desktop, 'nostorage-host');
  const G = await page(browser, VP.iphone, 'nostorage-guest', { hooks: true, init: block });
  await run(P, async () => {
    await home(P, 'Privé');
    await quick(P);
    const path = await P.page.evaluate(() => location.pathname);
    await sleep(500);
    await P.page.evaluate(() => window.__kj.last().close());
    await waitFor(P, () => window.__kj.sent.filter(m => m.t === 'join').length > 0 && document.querySelector('.hand .card'), { label: 'rejoin', timeout: 10000 });
    await sleep(800);
    const st = await P.page.evaluate(() => ({ join: window.__kj.sent.find(m => m.t === 'join'), screen: document.body.dataset.screen, path: location.pathname }));
    if (!st.join.token || st.join.name !== 'Privé' || st.screen !== 'game' || st.path !== path) throw new Error(`after a reconnect: ${JSON.stringify(st)}`);
    const t = await toasts(P);
    if (t.some(x => x.includes('begonnen'))) throw new Error(`thrown out: ${t}`);

    // A guest with blocked storage joins by link under the name typed.
    await home(H, 'Anna');
    const code = await newGame(H);
    await G.page.goto(`${BASE}/${code}`, { waitUntil: 'networkidle0' });
    await waitFor(G, () => document.querySelector('.invite:not([hidden]) .btn-hero'), { label: 'invite' });
    await type(G, '#name', 'Bert');
    await press(G, '.invite .btn-hero');
    await waitFor(H, () => [...document.querySelectorAll('.lseat .ls-name')].some(e => e.textContent === 'Bert'), { label: 'host sees Bert' });
  });
  await H.ctx.close().catch(() => {});
  await G.ctx.close().catch(() => {});
};

// A tap during a pause (turn -1) gives a proper message, not an empty name.
CHECKS.pause = async browser => {
  const P = await page(browser, VP.desktop, 'pause');
  await run(P, async () => {
    await home(P);
    await quick(P);
    // Click a hand card the moment a trick completes (in the page, so the
    // short -fast pause is not missed).
    await P.page.evaluate(() => {
      window.__clicked = 0;
      new MutationObserver(() => {
        if (!document.querySelector('.trick.done') || window.__clicked) return;
        const card = document.querySelector('.hand .card');
        if (!card) return;
        const b = card.getBoundingClientRect();
        const o = { bubbles: true, pointerId: 7, pointerType: 'mouse', clientX: b.left + 8, clientY: b.top + 8, isPrimary: true };
        card.dispatchEvent(new PointerEvent('pointerdown', o));
        card.dispatchEvent(new PointerEvent('pointerup', o));
        window.__clicked = 1;
      }).observe(document.querySelector('.trick'), { attributes: true, attributeFilter: ['class'] });
    });
    await playUntil(P, () => window.__clicked === 1, { label: 'a completed trick' });
    await sleep(100);
    const t = await toasts(P);
    if (!t.some(x => x.startsWith('Even geduld')) || t.some(x => /:\s+is aan de beurt/.test(x))) throw new Error(`toasts ${JSON.stringify(t)}`);
  });
};

// Game over: "Nog een partij" sends one rematch however fast it is tapped.
CHECKS.rematch = async browser => {
  const P = await page(browser, VP.desktop, 'rematch', {
    hooks: true,
    init: () => localStorage.setItem('kj.opts', JSON.stringify({ hands: 4, tempo: 'snel' })),
  });
  await run(P, async () => {
    await home(P);
    await quick(P);
    await playUntil(P, () => !!document.querySelector('.m-over.open'), { label: 'game over', timeout: 300000 });
    await sleep(600);
    const st = await P.page.evaluate(() => ({
      label: document.querySelector('.m-over .btn-go').textContent,
      names: [...document.querySelectorAll('.m-over .team-names')].map(e => e.textContent).join(' '),
      focus: document.activeElement?.className || '',
    }));
    if (st.label !== 'Nog een partij') throw new Error(`rematch button "${st.label}"`);
    if (!st.names.includes('(AI)')) throw new Error(`game over names without (AI): ${st.names}`);
    if (!st.focus.includes('btn-go')) throw new Error(`rematch button not focused: ${st.focus}`);
    const b = await (await P.page.$('.m-over .btn-go')).boundingBox();
    await P.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { clickCount: 2 });
    await sleep(150);
    await P.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await waitFor(P, () => !document.querySelector('.m-over') && document.querySelector('.potje-n b')?.textContent === '1', { label: 'rematch dealt' });
    const sent = await P.page.evaluate(() => window.__kj.sent.filter(m => m.t === 'rematch').length);
    const t = await toasts(P);
    if (sent !== 1 || t.some(x => x.includes('niet afgelopen'))) throw new Error(`rematch sent ${sent} times, toasts ${t}`);
  });
};

// Game over: the host takes the table back to Klaarzetten under the same
// code; the bot that filled the free seat at the start is gone, a late
// friend joins there, and Start is guarded again.
CHECKS.setup = async browser => {
  const H = await page(browser, VP.phone, 'setup');
  let friend = null;
  await run(H, async () => {
    await home(H, 'Anna');
    // Two seats: the one a bot filled at the start is free again after.
    const code = await newGame(H, { players: 2 });
    await press(H, '#btn-start:not(:disabled)');
    await waitFor(H, () => document.body.dataset.screen === 'game', { label: 'game' });
    await playUntil(H, () => !!document.querySelector('.m-over.open'), { label: 'game over', timeout: 300000 });
    await sleep(600);
    if (!await H.page.$('.m-over .btn-setup:not([hidden])')) throw new Error('no "Spelers of regels wijzigen" for the host');
    await press(H, '.m-over .btn-setup');
    await waitFor(H, () => document.body.dataset.screen === 'lobby' && !document.querySelector('.m-over'), { label: 'back in the lobby' });
    const st = await H.page.evaluate(() => ({
      code: [...document.querySelectorAll('.code-big span')].map(e => e.textContent).join(''),
      empty: document.querySelectorAll('.lseat.empty').length,
      start: document.querySelector('#btn-start')?.disabled,
    }));
    if (st.code !== code || st.empty !== 1 || !st.start) throw new Error(`lobby after game over ${JSON.stringify(st)}`);
    friend = new NodeWS(BASE.replace(/^http/, 'ws') + '/ws', { headers: { Origin: BASE, 'X-Real-IP': nextIP() } });
    await new Promise((ok, fail) => { friend.once('open', ok); friend.once('error', fail); });
    friend.send(JSON.stringify({ t: 'join', code, name: 'Laatkomer' }));
    await waitFor(H, () => [...document.querySelectorAll('.lseat .ls-name')].some(e => e.textContent === 'Laatkomer'), { label: 'friend seated' });
    await shot(H, 'setup-lobby');
    await press(H, '#btn-start:not(:disabled)');
    await waitFor(H, () => document.body.dataset.screen === 'game' && document.querySelector('.potje-n b')?.textContent === '1', { label: 'new match dealt' });
  });
  friend?.close();
};

// The host puts a chosen bot at a lobby seat ('left', 'top', 'right'), in
// place of the bot there (bots fill the seats not meant for people) or on
// an empty seat; one already elsewhere at the table moves out first.
async function seatBot(H, pos, name) {
  const seatOf = () => H.page.evaluate(n => [...document.querySelectorAll('.lseat')]
    .find(e => e.querySelector('.ls-name')?.textContent === n)?.className.match(/ls-(left|top|right)/)?.[1] || '', `${name} (AI)`);
  const pick = async (at, want, label) => {
    await press(H, `.ls-${at} .ls-main`);
    await waitFor(H, () => document.querySelector('.m-bots.open'), { label: 'bot picker' });
    await sleep(300);
    for (const it of await H.page.$$('.m-bots .bot-item:not(.random):not(.sit):not(:disabled)')) {
      if (want(await it.evaluate(e => e.textContent))) { await pressEl(H, it); return; }
    }
    throw new Error(`no ${label} in the bot picker`);
  };
  const at = await seatOf();
  if (at === pos) return;
  if (at) {
    await pick(at, t => !t.includes(name), 'other bot');
    await waitFor(H, (p, n) => !document.querySelector(`.ls-${p} .ls-name`)?.textContent.startsWith(n), { label: `${name} moved out` }, at, name);
  }
  await pick(pos, t => t.includes(name), name);
  await waitFor(H, (p, n) => document.querySelector(`.ls-${p} .ls-name`)?.textContent === `${n} (AI)`, { label: `${name} seated` }, pos, name);
}

// Names in a tight spot shorten but keep their "(AI)" (sel: the names'
// boxes); with full, also nothing may be shortened at all.
async function aiMarks(P, sel, { full = false } = {}) {
  const r = await P.page.evaluate(s => [...document.querySelectorAll(s)].filter(e => e.querySelector('.pname-ai')).map(e => {
    const box = e.getBoundingClientRect();
    const ai = e.querySelector('.pname-ai').getBoundingClientRect();
    const base = e.querySelector('.pname-base');
    return { text: e.textContent, shown: ai.width > 0 && ai.left >= box.left - 0.5 && ai.right <= box.right + 0.5, cut: base.scrollWidth > base.clientWidth };
  }), sel);
  const bad = r.filter(x => !x.shown || (full && x.cut));
  if (!r.length || bad.length) throw new Error(`[${P.name}] names in ${sel}: ${JSON.stringify(r)}`);
  return r;
}

// A friend with the link types a name and presses Enter (the keyboard's go
// key) to join; on the home screen Enter in the name field joins the code
// typed before it. The guest's lobby title fits a 360 px screen, and long
// bot names keep "(AI)" in the lobby, the score pill and Laatste slag.
CHECKS.names = async browser => {
  const H = await page(browser, VP.desktop, 'names-host');
  const G = await page(browser, VP.phone, 'names-guest');
  const G2 = await page(browser, VP.phone, 'names-guest2');
  await run(G, async () => {
    await home(H, 'Anna');
    const code = await newGame(H);
    await seatBot(H, 'right', 'Kees de Visser');
    await aiMarks(H, '.lseat .ls-name');

    await G.page.goto(`${BASE}/${code}`, { waitUntil: 'networkidle0' });
    await waitFor(G, () => document.querySelector('.invite:not([hidden])') && document.activeElement?.id === 'name', { label: 'invite with the name field focused' });
    if (await G.page.$eval('#name', e => e.enterKeyHint) !== 'go') throw new Error('the invite name field has no go key');
    await G.page.keyboard.type('Gast');
    await G.page.keyboard.press('Enter');
    await waitFor(G, () => document.body.dataset.screen === 'lobby', { label: 'guest in the lobby after Enter', timeout: 8000 });
    await waitFor(G, () => [...document.querySelectorAll('.lseat .ls-name')].some(e => e.textContent === 'Kees de Visser (AI)'), { label: 'guest sees the bot' });
    const title = await G.page.$eval('.lb-title', e => ({ text: e.textContent, fits: e.scrollWidth <= e.clientWidth }));
    if (title.text !== 'Even wachten' || !title.fits) throw new Error(`guest lobby title ${JSON.stringify(title)}`);
    await aiMarks(G, '.lseat .ls-name');
    await shot(G, 'lobby');

    await G2.page.goto(BASE + '/', { waitUntil: 'networkidle0' });
    if (await G2.page.$eval('#name', e => e.enterKeyHint) !== 'done') throw new Error('the home name field lost its done key');
    await type(G2, '#join-code', code);
    await waitFor(G2, () => document.activeElement?.id === 'name' && [...document.querySelectorAll('.toast-main')].some(t => t.textContent === 'Hoe heet je?'), { label: 'asked for a name' });
    await G2.page.keyboard.type('Bert');
    await G2.page.keyboard.press('Enter');
    await waitFor(G2, () => document.body.dataset.screen === 'lobby', { label: 'second guest in the lobby after Enter', timeout: 8000 });
    await waitFor(H, () => [...document.querySelectorAll('.lseat .ls-name')].filter(e => ['Gast', 'Bert'].includes(e.textContent)).length === 2, { label: 'host sees both guests' });
  });
  await H.ctx.close().catch(() => {});
  await G2.ctx.close().catch(() => {});

  // Two long bot names in one team: the score pill from 1024 px wide up,
  // and the trick at the seats.
  const P = await page(browser, { width: 1024, height: 768, isMobile: false, hasTouch: false, deviceScaleFactor: 1 }, 'names-pill');
  await run(P, async () => {
    await home(P, 'Anna');
    await newGame(P);
    await seatBot(P, 'left', 'Tante Truus');
    await seatBot(P, 'right', 'Kees de Visser');
    await press(P, '#btn-start:not(:disabled)');
    await waitFor(P, () => document.body.dataset.screen === 'game' && document.querySelector('.sp-zij .sp-names')?.textContent === 'Tante Truus (AI) & Kees de Visser (AI)', { label: 'game with both bots' });
    for (const [width, height] of [[1024, 768], [1440, 900], [1920, 1080]]) {
      await P.page.setViewport({ width, height });
      await sleep(300);
      await aiMarks(P, '.sp-names .pname', { full: true });
      const bar = await P.page.evaluate(() => {
        const r = sel => document.querySelector(sel).getBoundingClientRect();
        const tools = [...document.querySelectorAll('.topbar .tb')].filter(e => getComputedStyle(e).display !== 'none').map(e => e.getBoundingClientRect());
        return { tools: tools.length, inside: tools.every(t => t.right <= innerWidth), apart: r('.score-pill').right <= r('.potje').left && r('.trump-badge').right <= tools[0].left };
      });
      if (bar.tools < 5 || !bar.inside || !bar.apart) throw new Error(`top bar at ${width}: ${JSON.stringify(bar)}`);
    }
    await shot(P, 'pill');
    await playUntil(P, () => !document.querySelector('.topbar .tb-last').disabled, { label: 'a first trick' });
    await press(P, '.topbar .tb-last');
    await waitFor(P, () => document.querySelectorAll('.m-last.open .cross-slot').length === 4, { label: 'Laatste slag' });
    await aiMarks(P, '.m-last .cs-name');
    const kees = await P.page.$eval('.m-last .cs-right .cs-name', e => e.title);
    if (kees !== 'Kees de Visser (AI)') throw new Error(`the right seat's name in Laatste slag: "${kees}"`);
  });
};

// A guest who leaves while offline frees the seat once the network is back;
// the chat badge counts only what people write.
CHECKS.leave = async browser => {
  const H = await page(browser, VP.desktop, 'leave-host');
  const G = await page(browser, VP.phone, 'leave-guest', { hooks: true });
  await run(G, async () => {
    await home(H, 'Anna');
    const code = await newGame(H);
    await home(G, 'Bert', '/' + code);
    await press(G, '.invite .btn-hero');
    await waitFor(G, () => document.body.dataset.screen === 'lobby', { label: 'guest in lobby' });
    await sleep(800);
    const early = await G.page.$eval('.lobby-bar .chat-badge', e => (e.hidden ? '' : e.textContent));
    if (early) throw new Error(`chat badge "${early}" for system lines`);
    await type(H, '.chat-input', 'Hoi Bert!');
    await H.page.keyboard.press('Enter');
    await waitFor(G, () => document.querySelector('.lobby-bar .chat-badge:not([hidden])')?.textContent === '1', { label: 'badge 1 for the host line' });

    await G.page.evaluate(() => { window.__kj.block = true; window.__kj.last().close(); });
    await waitFor(H, () => [...document.querySelectorAll('.lseat .ls-tag')].some(e => e.textContent.startsWith('weg')), { label: 'host sees Bert away' });
    await press(G, '.tb-back');
    await waitFor(G, () => document.body.dataset.screen === 'home' && location.pathname === '/', { label: 'guest home' });
    await sleep(500);
    await G.page.evaluate(() => { window.__kj.block = false; dispatchEvent(new Event('online')); });
    await waitFor(H, () => ![...document.querySelectorAll('.lseat .ls-name')].some(e => e.textContent === 'Bert'), { label: 'Bert gone from the host lobby', timeout: 15000 });
    await waitFor(G, c => !localStorage.getItem('kj.token.' + c), { label: 'seat token deleted once the leave went out', timeout: 5000 }, code);
  });
  await H.ctx.close().catch(() => {});
};

// Lobby: the hint fits a full table of people; a failed copy shows the link.
CHECKS.lobby = async browser => {
  const H = await page(browser, VP.desktop, 'lobby', {
    init: () => {
      navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
      document.execCommand = () => false;
    },
  });
  const bots = [];
  await run(H, async () => {
    await home(H, 'Anna');
    const code = await newGame(H);
    const ws = BASE.replace(/^http/, 'ws') + '/ws';
    for (const name of ['Bert', 'Cor', 'Dien']) {
      const c = new NodeWS(ws, { headers: { Origin: BASE, 'X-Real-IP': nextIP() } });
      await new Promise((ok, fail) => { c.once('open', ok); c.once('error', fail); });
      c.send(JSON.stringify({ t: 'join', code, name }));
      bots.push(c);
    }
    await waitFor(H, () => document.querySelectorAll('.lseat:not(.empty)').length === 4, { label: 'four people seated' });
    const hint = await H.page.$eval('.lb-count', e => e.textContent);
    if (hint !== '4 van de 4 plaatsen bezet · iedereen zit klaar') throw new Error(`lobby hint "${hint}"`);
    await press(H, '.lb-code .btn-row .btn:first-child');
    await waitFor(H, () => document.querySelector('.modal.open .link-field'), { label: 'link to copy by hand' });
    const st = await H.page.evaluate(() => ({ value: document.querySelector('.link-field').value, path: location.pathname, toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent) }));
    if (st.value !== BASE + st.path || st.toasts.some(t => t.includes('Plak'))) throw new Error(`copy fallback ${JSON.stringify(st)}`);
  });
  for (const c of bots) c.close();
};

// A full table: a late friend with a stored name opens the link, is told to
// ask the host for a seat and finds the code back in the Meedoen field; the
// host gets a toast saying how to make room, and the hint under the code
// says every seat is taken. Once Spelers goes up, one tap on Meedoen joins.
CHECKS.full = async browser => {
  const H = await page(browser, VP.desktop, 'full-host');
  const L = await page(browser, VP.phone, 'full-late');
  let guest = null;
  await run(L, async () => {
    await home(H, 'Anna');
    const code = await newGame(H, { players: 2 });
    const hint = () => H.page.$eval('.lb-code .lb-hint', e => e.textContent);
    if (!(await hint()).startsWith('Stuur de link')) throw new Error(`hint with a free seat: "${await hint()}"`);
    guest = new NodeWS(BASE.replace(/^http/, 'ws') + '/ws', { headers: { Origin: BASE, 'X-Real-IP': nextIP() } });
    await new Promise((ok, fail) => { guest.once('open', ok); guest.once('error', fail); });
    guest.send(JSON.stringify({ t: 'join', code, name: 'Bert' }));
    await waitFor(H, () => document.querySelector('.lb-code .lb-hint')?.textContent.startsWith('Alle plaatsen zijn bezet. Zet Spelers hoger'), { label: 'hint: no seat for people' });

    await L.page.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await L.page.evaluate(() => localStorage.setItem('kj.name', 'Laat'));
    await L.page.goto(`${BASE}/${code}`, { waitUntil: 'networkidle0' });
    await waitFor(L, () => document.body.dataset.screen === 'home' && [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Vraag de host')), { label: 'refused with advice' });
    const late = await L.page.evaluate(() => ({ path: location.pathname, code: document.querySelector('#join-code').value }));
    if (late.path !== '/' || late.code !== code) throw new Error(`late friend after the refusal: ${JSON.stringify(late)}`);
    await waitFor(H, () => [...document.querySelectorAll('.toast')].some(t => t.textContent.startsWith('Laat wil meedoen, maar de tafel is vol') && t.textContent.includes('Zet Spelers op 3')), { label: 'host told how to make room' });
    await shot(H, 'toast');

    await pickOpt(H, '.lb-opts', 'players', '3');
    await waitFor(H, () => document.querySelector('.lb-code .lb-hint')?.textContent.startsWith('Stuur de link'), { label: 'hint with a seat free again' });
    await press(L, '.btn-join');
    await waitFor(L, () => document.body.dataset.screen === 'lobby', { label: 'late friend seated after one tap' });
    await waitFor(H, () => [...document.querySelectorAll('.lseat .ls-name')].some(e => e.textContent === 'Laat'), { label: 'host sees the late friend' });
  });
  guest?.close();
  await H.ctx.close().catch(() => {});
};

// Back (Android gesture, browser button) closes the top overlay, and at the
// table asks before leaving.
CHECKS.back = async browser => {
  const P = await page(browser, VP.iphone, 'back');
  await run(P, async () => {
    await home(P);
    await quick(P);
    const path = await P.page.evaluate(() => location.pathname);
    const back = async () => { await P.page.evaluate(() => history.back()); await sleep(450); };
    const state = () => P.page.evaluate(() => ({
      screen: document.body.dataset.screen, path: location.pathname, chat: document.body.classList.contains('chat-open'),
      modals: [...document.querySelectorAll('#modals .modal.open')].map(m => m.className.replace('modal ', '').split(' ')[0]),
    }));
    const expect = async (want, label) => {
      const st = await state();
      const ok = st.screen === 'game' && st.path === path && st.chat === !!want.chat && String(st.modals) === String(want.modals || []);
      if (!ok) throw new Error(`${label}: ${JSON.stringify(st)}`);
    };

    await press(P, '.topbar .tb-chat');
    await waitFor(P, () => document.body.classList.contains('chat-open'), { label: 'chat' });
    await sleep(300);
    await back();
    await expect({}, 'back closes the chat');

    await press(P, '.topbar .tb-menu');
    await waitFor(P, () => document.querySelector('.m-menu.open'), { label: 'menu' });
    await sleep(250);
    await press(P, '.m-menu .menu-item:nth-child(3)');
    await waitFor(P, () => document.querySelector('.m-manual.open'), { label: 'manual' });
    await sleep(300);
    await back();
    await expect({}, 'back closes the manual (opened from the menu)');

    await press(P, '.score-pill');
    await waitFor(P, () => document.querySelector('.m-score.open'), { label: 'score sheet' });
    await sleep(300);
    await P.page.keyboard.press('Escape');
    await sleep(400);
    await expect({}, 'Escape closes the score sheet');

    await back();
    await expect({ modals: ['m-confirm'] }, 'back at the table asks first');
    await back();
    await expect({}, 'back again: staying');
    await back();
    await press(P, '.m-confirm .btn-danger');
    await waitFor(P, () => document.body.dataset.screen === 'home' && location.pathname === '/', { label: 'left the table' });
    await sleep(500);
    if (await P.page.evaluate(() => location.pathname) !== '/') throw new Error('url changed after leaving');
  });
};

// Keyboard: dialogs keep the focus; trump choice and summary take it.
CHECKS.keys = async browser => {
  const P = await page(browser, VP.desktop, 'keys');
  await run(P, async () => {
    await home(P);
    await quick(P);
    await press(P, '.topbar .tb-settings');
    await waitFor(P, () => document.querySelector('.m-settings.open'), { label: 'settings' });
    await sleep(300);
    for (let i = 0; i < 14; i++) {
      await P.page.keyboard.press('Tab');
      if (!(await P.page.evaluate(() => !!document.activeElement?.closest('.m-settings .dialog')))) throw new Error(`Tab ${i + 1} left the dialog`);
    }
    await P.page.keyboard.down('Shift');
    for (let i = 0; i < 4; i++) await P.page.keyboard.press('Tab');
    await P.page.keyboard.up('Shift');
    if (!(await P.page.evaluate(() => !!document.activeElement?.closest('.m-settings .dialog')))) throw new Error('Shift+Tab left the dialog');
    await P.page.keyboard.press('Escape');
    await sleep(300);
    await P.page.evaluate(() => document.activeElement?.blur());
    // A trump choice that opened while the settings were open rightly left
    // the focus there (voorhand in the first potje): choose, look at the next.
    if (await P.page.$('.panel-trump .suit-btn:not(:disabled)')) await press(P, '.panel-trump .suit-btn:not(:disabled)');
    await playUntil(P, () => !!document.querySelector('.panel-trump .suit-btn:not(:disabled)') || !!document.querySelector('.m-summary.open'),
      { label: 'trump choice or summary', ready: false, timeout: 240000 });
    await sleep(300);
    const st = await P.page.evaluate(() => ({ trump: !!document.querySelector('.panel-trump'), focus: document.activeElement?.className || '' }));
    if (st.trump && !st.focus.includes('suit-btn')) throw new Error(`trump panel without focus (${st.focus})`);
    await playUntil(P, () => !!document.querySelector('.m-summary.open'), { label: 'summary', ready: false });
    await sleep(120); // -fast: the summary is gone again after 0.6 s
    const f = await P.page.evaluate(() => document.activeElement?.closest('.m-summary .btn-go') ? '' : `${document.activeElement?.tagName}.${document.activeElement?.className}`);
    if (f) throw new Error(`"Volgend potje" not focused but ${f}`);
  });
};

// Touch targets, contrast of the score, trump info wording, manual tabs.
CHECKS.targets = async browser => {
  for (const vp of ['phone', 'landscape', 'smallLandscape', 'desktop']) {
    const P = await page(browser, VP[vp], `targets-${vp}`);
    await run(P, async () => {
      await home(P);
      await quick(P);
      const small = await P.page.evaluate(() => {
        const bad = [];
        for (const el of document.querySelectorAll('.topbar .tb, .prompt .tb-last')) {
          const b = el.getBoundingClientRect();
          if (!b.width || getComputedStyle(el).display === 'none') continue;
          const cx = b.left + b.width / 2;
          const cy = b.top + b.height / 2;
          // 21 px either way of the centre (elementFromPoint rounds to whole pixels).
          for (const [dx, dy] of [[-21, 0], [21, 0], [0, -21], [0, 21]]) {
            if (document.elementFromPoint(cx + dx, cy + dy)?.closest('.tb') !== el) bad.push(`${el.className} ${dx},${dy}`);
          }
        }
        return bad;
      });
      if (small.length) throw new Error(`tool buttons under 44 px: ${small}`);
      const contrast = await P.page.evaluate(() => {
        const lum = ([r, g, b]) => [r, g, b].map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
        const out = [];
        for (const sel of ['.sp-wij', '.sp-zij']) {
          const stops = [...getComputedStyle(document.querySelector(sel)).backgroundImage.matchAll(/rgb\((\d+), (\d+), (\d+)\)/g)].map(m => m.slice(1).map(Number));
          for (const c of stops) out.push((1.05 / (lum(c) + 0.05)).toFixed(2));
        }
        out.push(getComputedStyle(document.querySelector('.sp-lbl')).opacity);
        return out;
      });
      if (contrast.slice(0, 4).some(c => Number(c) < 4.5) || contrast[4] !== '1') throw new Error(`score pill contrast ${contrast}`);
      if (vp === 'phone') {
        await press(P, '.topbar .tb-chat');
        await waitFor(P, () => document.body.classList.contains('chat-open'), { label: 'chat' });
        const quickH = await P.page.$$eval('.quick', els => Math.min(...els.map(e => e.getBoundingClientRect().height)));
        if (quickH < 44) throw new Error(`quick reactions ${quickH} px high`);
        await P.page.keyboard.press('Escape');
        await sleep(300);
        await press(P, '.topbar .tb-menu');
        await waitFor(P, () => document.querySelector('.m-menu.open'), { label: 'menu' });
        await sleep(250);
        await press(P, '.m-menu .menu-item:nth-child(3)');
        await waitFor(P, () => document.querySelector('.m-manual.open .man'), { label: 'manual' });
        await P.page.evaluate(() => document.querySelector('.m-manual .tab').click());
        await sleep(400);
        const man = await P.page.evaluate(() => ({
          tabH: Math.min(...[...document.querySelectorAll('.tab')].map(e => e.getBoundingClientRect().height)),
          fade: document.querySelector('.tabs').classList.contains('more-r'),
          next: document.querySelector('.man-next button')?.textContent,
        }));
        if (man.tabH < 44 || !man.fade || man.next !== 'Volgende: Spelregels') throw new Error(`manual on a phone ${JSON.stringify(man)}`);
        await P.page.evaluate(() => document.querySelector('.man-next button').click());
        await sleep(300);
        const sel = await P.page.$eval('.tab[aria-selected="true"]', e => e.textContent);
        if (sel !== 'Spelregels') throw new Error(`next section went to ${sel}`);
        await P.page.keyboard.press('Escape');
        await sleep(300);
      }
      if (vp === 'desktop') {
        // After the trump banner, a plain tap (during it: CHECKS.badge).
        await playUntil(P, () => document.querySelector('.trump-badge.known') && !document.querySelector('.banner'), { label: 'trump known' });
        await sleep(300);
        await press(P, '.trump-badge');
        await waitFor(P, () => document.querySelector('.ti-trump b'), { label: 'trump info' });
        const st = await P.page.$eval('.ti-trump b', e => ({ text: e.innerText, transform: getComputedStyle(e).textTransform }));
        if (!/^[A-Z][a-z]+ is troef$/.test(st.text) || st.transform !== 'none') throw new Error(`trump info title ${JSON.stringify(st)}`);
      }
    });
  }
};

// Speech bubbles never cover a card in the trick, stay on screen and never
// pile up: a chat line in the way of another bubble waits its turn (on a
// short portrait screen the top seat's bubble meets the side seats'), and a
// bid always shows at once, ending a chat bubble in its way.
CHECKS.bubbles = async browser => {
  for (const vp of ['phone', 'iphone', 'landscape', 'smallLandscape']) {
    const P = await page(browser, VP[vp], `bubbles-${vp}`, { hooks: true });
    await run(P, async () => {
      await home(P);
      await quick(P);
      await playUntil(P, () => document.querySelectorAll('.trick .slot .card').length >= 3, { label: 'three cards in the trick' });
      // The table holds still meanwhile: no bot chatter, the trick stays.
      await P.page.evaluate(() => {
        window.__kj.last().__hold = [];
        for (const b of document.querySelectorAll('.seat .bubble')) b.hidden = true;
      });
      const r = await P.page.evaluate(async () => {
        const table = await import('/js/table.js');
        const { app, posOf } = await import('/js/util.js');
        const s = app.s;
        const seatAt = pos => [1, 2, 3].map(k => (s.you + k) % 4).find(seat => posOf(s, seat) === pos);
        const pause = ms => new Promise(ok => setTimeout(ok, ms));
        const LONG = 'Ha, daar zijn jullie! Ik heb er zó\'n zin in vanavond, echt waar.';
        const visible = () => [...document.querySelectorAll('.seat .bubble:not([hidden])')];
        const posOfBubble = b => b.closest('.seat').className.match(/seat-(\w+)/)[1];
        const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const out = { bad: [], off: [], overlap: [], shown: new Set(), n: 0 };
        const sample = label => {
          const vis = visible();
          const rects = vis.map(e => e.getBoundingClientRect());
          for (const card of document.querySelectorAll('.trick .slot .card')) {
            const b = card.getBoundingClientRect();
            for (const [fx, fy] of [[0.12, 0.08], [0.5, 0.5], [0.88, 0.92], [0.12, 0.92], [0.88, 0.08]]) {
              const hit = document.elementFromPoint(b.left + b.width * fx, b.top + b.height * fy);
              if (hit?.closest('.bubble')) out.bad.push(`${label}: ${card.dataset.card} at ${fx},${fy}`);
            }
          }
          for (const b of rects) if (b.left < -1 || b.right > innerWidth + 1 || b.top < 0) out.off.push(`${label}: ${Math.round(b.left)}..${Math.round(b.right)}`);
          for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
              const a = area(rects[i], rects[j]);
              if (a) out.overlap.push(`${label}: ${posOfBubble(vis[i])}/${posOfBubble(vis[j])} ${Math.round(a)} px²`);
            }
          }
          for (const b of vis) out.shown.add(b.textContent);
          out.n = Math.max(out.n, vis.length);
        };
        // Three long chat lines at once: whatever waits shows later.
        for (let k = 1; k < 4; k++) table.bubble(s, (s.you + k) % 4, `${LONG} (${k})`, '', 1500);
        for (let t = 0; t < 50; t++) { await pause(100); sample(`chat ${t * 100} ms`); }
        out.chats = [1, 2, 3].filter(k => out.shown.has(`${LONG} (${k})`)).length;
        await pause(1600);

        // A bid in the way of a chat line ends that line; a chat line in
        // the way of a bid waits for it.
        const top = seatAt('top');
        const left = seatAt('left');
        const leftB = () => document.querySelector('.seat-left .bubble');
        const topB = () => document.querySelector('.seat-top .bubble');
        table.bubble(s, left, LONG, '', 5000);
        await pause(300); // popped in to full size
        const leftRect = leftB().getBoundingClientRect();
        table.bubble(s, top, `Ik speel! ${LONG}`, 'go', 1500);
        await pause(300);
        sample('bid after chat');
        out.collided = area(leftRect, topB().getBoundingClientRect()) > 0;
        out.bidShown = !topB().hidden;
        out.chatEnded = leftB().hidden;
        await pause(1500);
        table.bubble(s, top, `Ik speel! ${LONG}`, 'go', 1200);
        table.bubble(s, left, `${LONG} (later)`, '', 2000);
        await pause(300);
        sample('chat after bid');
        out.chatWaited = leftB().hidden && !topB().hidden;
        await pause(1300);
        out.chatLater = !leftB().hidden && leftB().textContent === `${LONG} (later)`;
        sample('chat after the bid ended');
        out.shown = out.shown.size;
        return out;
      });
      await shot(P, 'bubbles');
      await P.page.evaluate(() => window.__kj.release());
      if (r.bad.length || r.off.length) throw new Error(`bubbles over trick cards: ${r.bad.slice(0, 4)}; off screen: ${r.off.slice(0, 4)}`);
      if (r.overlap.length) throw new Error(`bubbles overlap each other: ${r.overlap.slice(0, 4)}`);
      if (r.chats !== 3) throw new Error(`only ${r.chats} of 3 chat lines got their turn`);
      // Short landscape tables talk sideways: the three fit at once.
      if (P.vp.isLandscape && r.n !== 3) throw new Error(`landscape shows ${r.n} bubbles at once, want 3`);
      if (!r.bidShown || (r.collided && !r.chatEnded)) throw new Error(`bid after a chat line: ${JSON.stringify(r)}`);
      if (r.collided && (!r.chatWaited || !r.chatLater)) throw new Error(`chat line after a bid: ${JSON.stringify(r)}`);
      // The case of the report: on a 360×640 screen the top and left bubbles meet.
      if (P.name === 'bubbles-phone' && !r.collided) throw new Error('phone: the top and left bubbles did not meet; the check proves nothing');
    });
  }
};

// Card values stay readable where cards overlap. Whatever the order of play
// and whoever wins (scaled up, with its ring), every card in the trick keeps
// one corner index clear of the cards above it: the top and left cards their
// top-left one, the bottom and right cards their bottom-right one. In open
// hands and the hand each card's top-left index is clear of the cards after
// it. The table renders made-up states: every card in every slot and seeded
// deals, each trick led and won from every seat.
CHECKS.corners = async browser => {
  for (const vp of ['iphonese', 'oldSE', 'oldSELandscape', 'phone', 'landscape']) {
    const P = await page(browser, VP[vp], `corners-${vp}`, { hooks: true });
    await run(P, async () => {
      await home(P);
      await quick(P);
      await waitFor(P, () => document.querySelectorAll('.hand .card').length === 8, { label: 'the dealt hand' });
      // The table holds still meanwhile.
      await P.page.evaluate(() => { window.__kj.last().__hold = []; });
      await sleep(1500);
      const r = await P.page.evaluate(async () => {
        const table = await import('/js/table.js');
        const { app, posOf } = await import('/js/util.js');
        const s0 = app.s;
        const POS = ['bottom', 'left', 'top', 'right'];
        const seatAt = pos => [0, 1, 2, 3].find(seat => posOf(s0, seat) === pos);
        const SUITS = ['C', 'D', 'H', 'S'];
        const RANKS = ['7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
        // A box in an SVG element's own units, grown by g of them, as a polygon on screen.
        const quad = (el, b, g = 0) => [[b.x - g, b.y - g], [b.x + b.width + g, b.y - g], [b.x + b.width + g, b.y + b.height + g], [b.x - g, b.y + b.height + g]]
          .map(([x, y]) => new DOMPoint(x, y).matrixTransform(el.getScreenCTM())).map(p => [p.x, p.y]);
        // A corner index's ink: the rank's box grown by half its stroke, and the suit's box.
        const ink = idx => [...idx.querySelectorAll('path')].map(p => quad(p, p.getBBox(), (Number(p.getAttribute('stroke-width')) || 0) / 2));
        // A card's outline (a winner's with its 5 px ring, which hit tests
        // such as covered() do not see): the rectangle inside its rounded
        // corners (cards.css: radius 0.075 × width) and that radius.
        const outline = c => {
          const svg = c.querySelector('.card-svg');
          const ring = c.classList.contains('winner') ? 5 * 200 / c.offsetWidth : 0;
          const m = svg.getScreenCTM();
          return { poly: quad(svg, { x: 15, y: 15, width: 170, height: 250 }), r: (15 + ring) * Math.hypot(m.a, m.b) };
        };
        // Distance between convex polygons: the shortest vertex-edge distance,
        // or, when they overlap, the (negative) separating axis gap.
        const toSeg = ([px, py], [x1, y1], [x2, y2]) => {
          const dx = x2 - x1;
          const dy = y2 - y1;
          const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
          return Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
        };
        const apart = (p, q) => {
          const gap = Math.max(...[p, q].flatMap(poly => poly.map(([x1, y1], i) => {
            const [x2, y2] = poly[(i + 1) % poly.length];
            const len = Math.hypot(x2 - x1, y2 - y1);
            const along = pts => pts.map(([x, y]) => (x * (y1 - y2) + y * (x2 - x1)) / len);
            return Math.max(Math.min(...along(q)) - Math.max(...along(p)), Math.min(...along(p)) - Math.max(...along(q)));
          })));
          if (gap < 0) return gap;
          return Math.min(...[[p, q], [q, p]].flatMap(([a, b]) => a.flatMap(v => b.map((e, i) => toSeg(v, e, b[(i + 1) % b.length])))));
        };
        // How far part of an index is from a card above it (negative: under it).
        const clear = (part, over) => {
          const o = outline(over);
          return apart(o.poly, part) - o.r;
        };
        const worst = { trick: { gap: Infinity }, open: { gap: Infinity }, hand: { gap: Infinity } };
        const note = (kind, gap, what) => { if (gap < worst[kind].gap) worst[kind] = { gap, what }; };
        // Each card's top-left index against the cards after it.
        const stack = (kind, cards) => cards.forEach((c, i) => {
          for (const part of ink(c.querySelector('.card-index'))) {
            for (const d of cards.slice(i + 1)) note(kind, clear(part, d), `${c.dataset.card} under ${d.dataset.card}`);
          }
        });

        // A made-up state on the table, its cards moved and scaled at once.
        const show = st => {
          table.render({ ...s0, phase: 'play', turn: -1, ...st });
          for (const a of document.getAnimations()) if (a instanceof CSSTransition) a.finish();
        };

        const sets = RANKS.flatMap(rank => [0, 1, 2, 3].map(k => POS.map((_, i) => rank + SUITS[(i + k) % 4])));
        let seed = 7;
        const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        for (let n = 0; n < 64; n++) {
          const pool = SUITS.flatMap(s => RANKS.map(rank => rank + s));
          sets.push(POS.map(() => pool.splice(Math.floor(rnd() * pool.length), 1)[0]));
        }
        for (const set of sets) {
          for (let lead = 0; lead < 4; lead++) {
            for (const win of POS) {
              const cards = [0, 1, 2, 3].map(i => ({ seat: seatAt(POS[(lead + i) % 4]), card: set[(lead + i) % 4] }));
              show({ hands4: null, trick: { leader: cards[0].seat, cards, winner: seatAt(win) } });
              const els = POS.map(pos => document.querySelector(`.trick .slot-${pos} .card`));
              const z = el => Number(el.parentElement.style.zIndex);
              POS.forEach((pos, i) => {
                const own = els[i].querySelectorAll('.card-index')[pos === 'top' || pos === 'left' ? 0 : 1];
                for (const part of ink(own)) {
                  for (const over of els.filter(e => z(e) > z(els[i]))) {
                    note('trick', clear(part, over), `${pos} ${els[i].dataset.card} under ${over.dataset.card}${over.classList.contains('winner') ? ' (winner)' : ''}, led from ${POS[lead]}`);
                  }
                }
              });
            }
          }
        }
        // Open hands and the hand: each suit, in both orders, at every seat.
        const suits = SUITS.flatMap(s => [RANKS.map(rank => rank + s), RANKS.map(rank => rank + s).reverse()]);
        for (let k = 0; k < suits.length; k++) {
          const hands4 = [0, 1, 2, 3].map(seat => suits[(k + 2 * seat) % suits.length]);
          show({ trick: null, hands4, hand: hands4[s0.you] });
          for (const pos of ['left', 'top', 'right']) stack('open', [...document.querySelectorAll(`.seat-${pos} .backs.open > .card`)]);
          stack('hand', [...document.querySelectorAll('.hand .card')].sort((a, b) => a.style.zIndex - b.style.zIndex));
        }
        table.render(s0);
        return worst;
      });
      await P.page.evaluate(() => window.__kj.release());
      const bad = Object.entries(r).filter(([, w]) => !(w.gap >= 0 && w.gap < Infinity)).map(([kind, w]) => `${kind}: ${w.what ? `${w.what} (${w.gap.toFixed(2)} px)` : 'nothing measured'}`);
      if (bad.length) throw new Error(`corner index covered: ${bad.join('; ')}`);
    });
  }
};

// The trump badge tapped during the "… is troef" banner: the badge already
// shows the new trump, and so do the details it opens.
CHECKS.badge = async browser => {
  const P = await page(browser, VP.phone, 'badge', {
    init: () => {
      window.__badge = null;
      document.addEventListener('DOMContentLoaded', () => {
        new MutationObserver(() => {
          if (window.__badge || !document.querySelector('.fx .banner')) return;
          const b = document.querySelector('.trump-badge');
          b.click(); // in the same task as the banner: it is surely still there
          window.__badge = { badge: b.title, info: document.querySelector('#modals .modal:last-child .dlg-body')?.textContent || '' };
        }).observe(document.body, { childList: true, subtree: true });
      });
    },
  });
  await run(P, async () => {
    await home(P);
    await quick(P);
    await playUntil(P, () => !!window.__badge, { label: 'the trump banner' });
    const st = await P.page.evaluate(() => window.__badge);
    if (!st.badge.startsWith('Troef is ') || !/is troef/.test(st.info) || st.info.includes('nog geen troef')) throw new Error(`badge during the banner: ${JSON.stringify(st)}`);
  });
};

// A background tab hears and sees that it is your turn.
CHECKS.hidden = async browser => {
  const P = await page(browser, VP.desktop, 'hidden');
  await run(P, async () => {
    await home(P);
    await quick(P);
    await P.page.evaluate(async () => {
      const { sound } = await import('/js/sound.js');
      window.__sounds = [];
      const play = sound.play.bind(sound);
      sound.play = n => { window.__sounds.push(n); return play(n); };
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await playUntil(P, () => document.title === '● Jouw beurt · Klaverjas', { label: 'turn in the tab title' });
    if (!(await P.page.evaluate(() => window.__sounds.includes('turn')))) throw new Error('no turn sound while hidden');
    await P.page.evaluate(() => {
      delete document.hidden;
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const title = await P.page.evaluate(() => document.title);
    if (!/^Klaverjas · [A-Z]{4}$/.test(title)) throw new Error(`title back to "${title}"`);
  });
};

// The on-screen keyboard, emulated by shrinking the viewport while a field
// has the focus (index.html: interactive-widget=resizes-content). An
// upright phone keeps its upright layout although the viewport turns short
// and wide: the banner makes way, the field and its button stay in view,
// and the table behind the chat does not switch to its landscape layout.
// A phone on its side keeps its landscape layout.
const KB_STATE = sels => {
  const where = s => {
    const el = document.querySelector(s);
    if (!el) return 'missing';
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) return 'hidden';
    if (b.top < -1 || b.bottom > innerHeight + 1 || b.left < -1 || b.right > innerWidth + 1) {
      return `outside [${Math.round(b.left)},${Math.round(b.top)}..${Math.round(b.right)},${Math.round(b.bottom)}] of ${innerWidth}×${innerHeight}`;
    }
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + Math.min(b.height / 2, 20));
    return hit && (hit === el || el.contains(hit)) ? 'ok' : `covered by ${hit ? `${hit.tagName}.${[...hit.classList].join('.')}` : 'nothing'}`;
  };
  const css = (s, prop) => {
    const el = document.querySelector(s);
    return el ? getComputedStyle(el)[prop] : '';
  };
  return {
    kb: document.documentElement.classList.contains('kb'),
    focus: document.activeElement === document.body ? '' : document.activeElement?.className || '',
    logo: css('.logo', 'display'),
    home: css('.home-inner', 'flexDirection'),
    seat: css('.seat-left', 'flexDirection'),
    tbh: getComputedStyle(document.documentElement).getPropertyValue('--tb-h').trim(),
    seen: Object.fromEntries(sels.map(s => [s, where(s)])),
  };
};

CHECKS.keyboard = async browser => {
  const iphone = VP.iphone;
  const kbSizes = [[390, 420], [360, 330]];
  const state = (P, sels = []) => P.page.evaluate(KB_STATE, sels);
  const resize = async (P, width, height, extra = {}) => {
    await P.page.setViewport({ ...P.vp, width, height, ...extra });
    await sleep(350);
  };
  const expectOpen = (st, sels, label) => {
    const bad = [];
    if (!st.kb) bad.push('no html.kb');
    if (st.logo !== 'none') bad.push(`banner shows (${st.logo})`);
    if (st.home !== 'column') bad.push(`home layout ${st.home}`);
    for (const s of sels) if (st.seen[s] !== 'ok') bad.push(`${s}: ${st.seen[s]}`);
    if (bad.length) throw new Error(`${label}: ${bad.join('; ')}\n  ${JSON.stringify(st)}`);
  };

  // Home: the name, then the code field, as the keyboard comes and goes.
  const P = await page(browser, iphone, 'keyboard-home');
  await run(P, async () => {
    await P.page.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await waitFor(P, () => document.querySelector('#name'), { label: 'home' });
    await press(P, '#name');
    let st = await state(P);
    if (st.kb || st.logo === 'none' || !st.focus.includes('field-name')) throw new Error(`focused, keyboard not up yet: ${JSON.stringify(st)}`);
    for (const [w, hgt] of kbSizes) {
      await resize(P, w, hgt);
      expectOpen(await state(P, ['#name', '#btn-quick']), ['#name', '#btn-quick'], `name field at ${w}×${hgt}`);
      await shot(P, `name-${w}x${hgt}`);
    }
    await P.page.keyboard.type('Toetsje');
    await press(P, '#join-code');
    st = await state(P, ['#join-code', '.btn-join']);
    expectOpen(st, ['#join-code', '.btn-join'], 'code field');
    await shot(P, 'code-360x330');
    // A blur does not close the keyboard at once: the layout holds still
    // (no jump under the finger) until the viewport grows back.
    await P.page.evaluate(() => document.activeElement.blur());
    await sleep(150);
    st = await state(P);
    if (!st.kb || st.logo !== 'none') throw new Error(`layout moved before the keyboard went down: ${JSON.stringify(st)}`);
    await resize(P, iphone.width, iphone.height);
    st = await state(P, ['.logo', '#name', '#btn-quick']);
    if (st.kb || st.logo === 'none' || st.home !== 'column' || st.seen['.logo'] !== 'ok') throw new Error(`keyboard down, upright layout back: ${JSON.stringify(st)}`);
    await shot(P, 'closed');
  });

  // The invite of a join link asks only for the name.
  const I = await page(browser, iphone, 'keyboard-invite');
  await run(I, async () => {
    await I.page.goto(BASE + '/ABCD', { waitUntil: 'networkidle0' });
    await waitFor(I, () => !document.querySelector('.invite').hidden, { label: 'invite' });
    await press(I, '#name');
    await resize(I, ...kbSizes[1]);
    expectOpen(await state(I, ['#name', '.invite .btn-hero']), ['#name', '.invite .btn-hero'], 'invite');
    await shot(I, 'invite-360x330');
    await I.page.evaluate(() => document.activeElement.blur());
    await resize(I, iphone.width, iphone.height);
    // The glossary's search field in the handleiding.
    await press(I, '.invite .btn-link');
    await press(I, '#btn-help');
    await waitFor(I, () => document.querySelector('.m-manual.open'), { label: 'manual' });
    await I.page.$eval('.m-manual .tab[data-id="woorden"]', e => e.click());
    await sleep(400); // the sheet slides up
    await press(I, '.m-manual .man-search input');
    await resize(I, ...kbSizes[1]);
    const st = await state(I, ['.m-manual .man-search input']);
    if (!st.kb || st.seen['.m-manual .man-search input'] !== 'ok') throw new Error(`glossary search with keyboard: ${JSON.stringify(st)}`);
    await shot(I, 'glossary-360x330');
  });

  // A phone on its side: the landscape layout stays, keyboard or not.
  const L = await page(browser, VP.landscape, 'keyboard-landscape');
  await run(L, async () => {
    await L.page.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await waitFor(L, () => document.querySelector('#name'), { label: 'home' });
    let st = await state(L, ['.logo']);
    if (st.kb || st.home !== 'row' || st.seen['.logo'] !== 'ok') throw new Error(`landscape home: ${JSON.stringify(st)}`);
    await shot(L, 'home');
    await press(L, '#name');
    await resize(L, 844, 200);
    st = await state(L, ['#name']);
    if (st.kb || st.home !== 'row' || st.seen['#name'] !== 'ok') throw new Error(`landscape with keyboard: ${JSON.stringify(st)}`);
    await shot(L, 'keyboard');
  });

  // At the table: chat and settings. The table behind them keeps its
  // upright layout while the keyboard is up.
  const T = await page(browser, iphone, 'keyboard-table');
  await run(T, async () => {
    await home(T, 'Typist');
    await quick(T);
    await sleep(500);
    const upright = await state(T);
    await press(T, '.topbar .tb-chat');
    await waitFor(T, () => document.body.classList.contains('chat-open'), { label: 'chat' });
    await sleep(400);
    await press(T, '.chat-input');
    await resize(T, ...kbSizes[1]);
    let st = await state(T, ['.chat-input', '.chat-send']);
    if (!st.kb || st.seat !== upright.seat || st.tbh !== upright.tbh || st.seen['.chat-input'] !== 'ok' || st.seen['.chat-send'] !== 'ok') {
      throw new Error(`chat with keyboard: ${JSON.stringify(st)}, upright ${JSON.stringify(upright)}`);
    }
    await shot(T, 'chat-360x330');
    await T.page.evaluate(() => document.activeElement.blur());
    await resize(T, iphone.width, iphone.height);
    await T.page.keyboard.press('Escape');
    await waitFor(T, () => !document.body.classList.contains('chat-open'), { label: 'chat closed' });
    // Settings: the name field is at the bottom of the sheet.
    if (await T.page.$eval('.topbar .tb-settings', e => !!e.getClientRects().length).catch(() => false)) await press(T, '.topbar .tb-settings');
    else {
      await press(T, '.topbar .tb-menu');
      await waitFor(T, () => document.querySelector('.m-menu.open'), { label: 'menu' });
      await sleep(300);
      const items = await T.page.$$('.m-menu .menu-item');
      let item = null;
      for (const it of items) if ((await it.evaluate(e => e.textContent)).includes('Instellingen')) item = it;
      if (!item) throw new Error('no Instellingen in the menu');
      await pressEl(T, item);
    }
    await waitFor(T, () => document.querySelector('.m-settings.open'), { label: 'settings' });
    await sleep(400);
    const field = '.m-settings .set-group:last-of-type .field, .m-settings input[autocomplete="nickname"]';
    await press(T, field);
    await resize(T, ...kbSizes[1]);
    st = await state(T, ['.m-settings input[autocomplete="nickname"]']);
    if (!st.kb || st.seat !== upright.seat || st.seen['.m-settings input[autocomplete="nickname"]'] !== 'ok') {
      throw new Error(`settings name with keyboard: ${JSON.stringify(st)}`);
    }
    await shot(T, 'settings-360x330');
  });
};

// The takeover question (design §6): nobody plays a person's seat unasked.
// When the game waits on someone who lost the connection or left, everyone
// else is asked whether an AI may play for them, and only if all agree does
// one. A returning player closes the question; their next drop-out asks
// again. Also how the question fits, with two people asked and with three
// and long names, on phones (upright and on their side) and on a desktop:
// on the turn of who is gone with two cards in the trick, what stays in
// view, and that the answers stay put as you answer. A chip without an
// answer yet reads "…" here (it shows thinking dots).
const VOTE = () => {
  const p = document.querySelector('.stage .panel-vote');
  if (!p) return null;
  const who = p.querySelector('.vote-who');
  return {
    title: p.querySelector('.panel-title').textContent,
    q: p.querySelector('.vote-q').textContent,
    btns: [...p.querySelectorAll('.vote-btns .btn')].map(b => `${b.textContent}|${b.getAttribute('aria-pressed')}`),
    rule: who.hidden ? '' : who.querySelector('.vote-rule').textContent,
    chips: who.hidden ? [] : [...p.querySelectorAll('.vote-chip')].map(c => c.querySelector('.vote-name').textContent
      + (c.querySelector('.vote-st.open') ? '…' : c.querySelector('.vote-st').textContent)),
    stage: document.querySelectorAll('.stage > *').length,
    focus: document.activeElement?.closest('.panel-vote .btn')?.textContent || '',
  };
};

// How the question reads to a screen reader: the panel a group named by its
// title and described by the question, the answers described by it too, the
// live line that says it, and the open chips' hidden words.
const VOTE_A11Y = () => {
  const p = document.querySelector('.stage .panel-vote');
  const text = id => document.getElementById(id)?.textContent || '';
  const q = p.querySelector('.vote-q').getBoundingClientRect();
  return {
    role: p.getAttribute('role'), name: text(p.getAttribute('aria-labelledby')), desc: text(p.getAttribute('aria-describedby')),
    btnDesc: [...p.querySelectorAll('.vote-btns .btn')].map(b => text(b.getAttribute('aria-describedby'))),
    live: [...document.querySelectorAll('.table [aria-live]')].map(e => e.textContent).filter(t => t.includes('Mag een AI-speler')),
    open: [...p.querySelectorAll('.vote-st.open')].map(e => e.textContent),
    answered: p.classList.contains('answered'), qShown: q.width > 2 && q.height > 2,
  };
};

// The seat of a player by name: its status line and whether it has the turn.
const SEAT_OF = name => {
  const el = [...document.querySelectorAll('.seat')].find(e => e.querySelector('.nm')?.textContent === name);
  const st = el?.querySelector('.st');
  return el ? { status: st.hidden ? '' : st.textContent, turn: el.classList.contains('turn') } : null;
};
const SEAT_SAYS = (name, status) => {
  const el = [...document.querySelectorAll('.seat')].find(e => e.querySelector('.nm')?.textContent === name);
  const st = el?.querySelector('.st');
  return !!st && (st.hidden ? '' : st.textContent) === status;
};

// The question fits: on the screen and under the top bar, ending above the
// hand; both answers whole, at least 44 px high and not covered; every chip
// inside the panel.
const VOTE_FIT = () => {
  const r = el => el.getBoundingClientRect();
  const p = document.querySelector('.stage .panel-vote');
  const b = r(p);
  const bad = [];
  const top = r(document.querySelector('.topbar')).bottom;
  const hand = Math.min(...[...document.querySelectorAll('.hand .card')].map(c => r(c).top));
  if (b.left < 0 || b.right > innerWidth || b.top < top - 1 || b.bottom > hand + 1) {
    bad.push(`panel at [${Math.round(b.left)},${Math.round(b.top)}..${Math.round(b.right)},${Math.round(b.bottom)}], bar ends ${Math.round(top)}, hand starts ${Math.round(hand)}`);
  }
  for (const btn of p.querySelectorAll('.vote-btns .btn')) {
    const x = r(btn);
    const hit = document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2);
    if (x.height < 44) bad.push(`"${btn.textContent}" ${Math.round(x.height)} px high`);
    if (btn.scrollWidth > btn.clientWidth + 1) bad.push(`"${btn.textContent}" cut off`);
    if (hit?.closest('.btn') !== btn) bad.push(`"${btn.textContent}" covered by ${hit?.className}`);
  }
  for (const c of p.querySelectorAll('.vote-chip')) {
    const x = r(c);
    if (x.left < b.left || x.right > b.right || x.bottom > b.bottom) bad.push(`chip "${c.textContent}" outside the panel`);
  }
  return { bad, size: `${Math.round(b.width)}×${Math.round(b.height)}`, chips: p.querySelectorAll('.vote-chip').length };
};

// The parts of the side seats (ring, and name plate with the status) that
// something else covers.
const SIDES_COVERED = () => ['left', 'right'].flatMap(pos => {
  const seat = document.querySelector(`.seat-${pos}`);
  return [...seat.querySelectorAll('.ring, .plate')].filter(el => {
    const r = el.getBoundingClientRect();
    return !seat.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  }).map(el => `${pos} ${el.className}`);
});

// The cards in the trick whose centre the question covers.
const TRICK_COVERED = () => [...document.querySelectorAll('.trick .slot > .card')].filter(c => {
  const r = c.getBoundingClientRect();
  return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.panel-vote');
}).map(c => c.parentElement.className);

// Where the answers are: they must not move under the finger as you answer.
const BTNS_AT = () => [...document.querySelectorAll('.stage .panel-vote .vote-btns .btn')]
  .map(b => { const r = b.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)}`; }).join(' ');
const SE = { width: 375, height: 548, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };

// At each size the question fits, and leaves these in view: the side seats
// ('sides'), whose status says who is gone, and the trick ('trick').
async function voteInView(P, sizes, keep, label) {
  for (const [name, vp] of Object.entries(sizes)) {
    await P.page.setViewport(vp);
    await sleep(500);
    const fit = await P.page.evaluate(VOTE_FIT);
    const sides = keep.includes('sides') ? await P.page.evaluate(SIDES_COVERED) : [];
    const trick = keep.includes('trick') ? await P.page.evaluate(TRICK_COVERED) : [];
    await shot(P, `${label}-${name}`);
    if (fit.bad.length || sides.length || trick.length) {
      throw new Error(`the question ${label} at ${vp.width}×${vp.height}: ${JSON.stringify(fit)}, covered: ${[...sides, ...trick]}`);
    }
  }
}

CHECKS.takeover = async browser => {
  // Updates as they arrive, to see who moved.
  const sniff = P => P.page.evaluate(() => {
    window.__evs = [];
    window.__kj.rewrite = data => {
      if (data.startsWith('{"t":"update"')) {
        const m = JSON.parse(data);
        if (m.ev) window.__evs.push(m.ev);
      }
      return data;
    };
  });
  const voteOpen = () => !!document.querySelector('.stage .panel-vote');
  const vote = (P, ai) => press(P, `.stage .panel-vote ${ai ? '.btn-go' : '.btn-pass'}`);
  const toastSeen = (P, text) => waitFor(P, t => [...document.querySelectorAll('.toast-main')].some(e => e.textContent === t), { label: `toast "${text}"`, timeout: 8000 }, text);
  const drop = P => P.page.evaluate(() => { window.__kj.block = true; window.__kj.last().close(); });
  const comeBack = async P => {
    await P.page.evaluate(() => { window.__kj.block = false; dispatchEvent(new Event('online')); });
    await waitFor(P, () => document.getElementById('net-banner').hidden && document.querySelector('.hand .card'), { label: 'back at the table', timeout: 15000 });
  };
  // A move of seat s after the takeover.
  const aiMoved = s => {
    const i = window.__evs.findIndex(e => e.type === 'takeover');
    return i >= 0 && window.__evs.slice(i + 1).some(e => ['play', 'trump', 'bid'].includes(e.type) && e.seat === s);
  };
  const errorsOf = (...ps) => ps.flatMap(P => P.errors.filter(e => !e.includes('/blocked')));

  // A connection lost: Bert's turn waits for him, then Anna and Kees are asked.
  const H = await page(browser, VP.desktop, 'takeover-anna', { hooks: true });
  const G = await page(browser, VP.phone, 'takeover-bert', { hooks: true });
  const K = await page(browser, VP.iphone, 'takeover-kees', { hooks: true });
  await run(H, async () => {
    await home(H, 'Anna');
    const code = await newGame(H, { hands: 8 });
    for (const [P, name] of [[G, 'Bert'], [K, 'Kees']]) {
      await home(P, name, '/' + code);
      await press(P, '.invite .btn-hero');
      await waitFor(P, () => document.body.dataset.screen === 'lobby', { label: 'in the lobby' });
    }
    await press(H, '#btn-start:not(:disabled)');
    for (const P of [H, G, K]) await waitFor(P, () => document.body.dataset.screen === 'game' && document.querySelector('.hand .card'), { label: 'dealt' });
    await sniff(H);
    await sniff(K);
    await H.page.evaluate(async () => {
      const { sound } = await import('/js/sound.js');
      const play = sound.play.bind(sound);
      window.__sounds = [];
      sound.play = n => { window.__sounds.push(`${n}${document.querySelector('.panel-vote') ? ' (vote)' : ''}`); return play(n); };
    });

    // Bert loses the connection on his turn, with two cards in the trick.
    const bertsTurn = () => [...document.querySelectorAll('.seat.turn .nm')].some(e => e.textContent === 'Bert')
      && document.querySelectorAll('.trick .slot > .card').length >= 2;
    await Promise.all([H, G, K].map(P => playUntil(P, bertsTurn, { label: "Bert's turn in a trick" })));
    await drop(G);
    await waitFor(H, SEAT_SAYS, { label: "Bert's seat: verbinding weg" }, 'Bert', 'verbinding weg');
    await Promise.all([playUntil(H, voteOpen, { label: 'the question' }), playUntil(K, voteOpen, { label: 'the question' })]);
    await sleep(400);
    let v = await H.page.evaluate(VOTE);
    const want = {
      title: 'Bert is weg', q: 'Het spel wacht op Bert. Mag een AI-speler zolang voor Bert spelen?',
      btns: ['AI laten spelen|false', 'Wachten|false'], rule: 'Iedereen moet akkoord zijn:', chips: ['Jij…', 'Kees…'], stage: 1, focus: 'AI laten spelen',
    };
    if (JSON.stringify(v) !== JSON.stringify(want)) throw new Error(`the question for Anna: ${JSON.stringify(v)}`);
    const k = await K.page.evaluate(VOTE);
    if (k.focus || String(k.chips) !== 'Jij…,Anna…') throw new Error(`the question for Kees (touch: no focus): ${JSON.stringify(k)}`);
    const a11y = await K.page.evaluate(VOTE_A11Y);
    const q = 'Het spel wacht op Bert. Mag een AI-speler zolang voor Bert spelen?';
    if (a11y.role !== 'group' || a11y.name !== 'Bert is weg' || a11y.desc !== q || String(a11y.btnDesc) !== `${q},${q}`
      || String(a11y.live) !== 'Bert is weg. Mag een AI-speler zolang voor Bert spelen?' || String(a11y.open) !== 'nog niet gekozen,nog niet gekozen'
      || a11y.answered || !a11y.qShown) {
      throw new Error(`the question for a screen reader: ${JSON.stringify(a11y)}`);
    }
    const bert = await H.page.evaluate(SEAT_OF, 'Bert');
    if (!bert.turn || bert.status !== 'verbinding weg') throw new Error(`Bert's seat while asked: ${JSON.stringify(bert)}`);
    if (!(await H.page.evaluate(() => window.__sounds.includes('turn (vote)')))) throw new Error(`no sound when asked: ${await H.page.evaluate(() => window.__sounds)}`);
    await Promise.all([H, K].map(P => waitFor(P, () => !document.querySelector('.toast'), { label: 'no toasts', timeout: 10000 })));
    await shot(H, 'gone');
    await shot(K, 'gone');
    // Low on the table, the question leaves the trick and the side seats
    // (Bert's "verbinding weg" too) in view; on a short phone the side seats.
    if (String(await H.page.evaluate(TRICK_COVERED))) throw new Error(`the question covers the trick on a desktop: ${await H.page.evaluate(TRICK_COVERED)}`);
    await voteInView(K, { phone: VP.phone, iphone: VP.iphone }, 'sides trick', 'asked');
    await voteInView(K, { se: SE }, 'sides', 'asked');
    await K.page.setViewport(VP.iphone);
    await sleep(500);
    const at = await K.page.evaluate(BTNS_AT);

    // Kees would rather wait, but his socket goes deaf as he answers: the
    // watchdog reconnects, and his answer holds. Answered, the question text
    // steps out of sight. Anna agrees. The game waits for Bert.
    const socks = await K.page.evaluate(() => window.__kj.socks.length);
    await K.page.evaluate(() => { window.__kj.last().__deaf = true; });
    await vote(K, false);
    await waitFor(K, n => window.__kj.socks.length > n, { label: "the watchdog reconnects after Kees's unanswered vote", timeout: 9000 }, socks);
    await waitFor(H, () => [...document.querySelectorAll('.vote-chip')].some(c => c.textContent === 'Keeswil wachten'), { label: 'Kees waits' });
    await waitFor(K, () => document.querySelector('.panel-vote .btn-pass')?.getAttribute('aria-pressed') === 'true', { label: "Kees's answer after the resync" });
    const ka = await K.page.evaluate(VOTE_A11Y);
    if (!ka.answered || ka.qShown || ka.desc !== q) throw new Error(`answered, the question takes no room but is still read: ${JSON.stringify(ka)}`);
    await waitFor(K, () => document.getElementById('net-banner').hidden, { label: 'online again' });
    await sleep(500);
    const moved = await K.page.evaluate(BTNS_AT);
    if (moved !== at) throw new Error(`the answers moved as Kees answered: ${at} → ${moved}`);
    // Answered, the panel is smaller still: the side seats and the trick
    // show, on a short phone and on one on its side too.
    await voteInView(K, { phone: VP.phone, se: SE, landscape: VP.landscape }, 'sides trick', 'answered');
    await K.page.setViewport(VP.iphone);
    await vote(H, true);
    await waitFor(K, () => [...document.querySelectorAll('.vote-chip')].some(c => c.textContent === 'Annaakkoord'), { label: 'Anna agrees' });
    const moves = await H.page.evaluate(() => window.__evs.length);
    await sleep(2500);
    v = await H.page.evaluate(VOTE);
    if (String(v?.btns) !== 'AI laten spelen|true,Wachten|false' || String(v.chips) !== 'Jijakkoord,Keeswil wachten') throw new Error(`while Kees waits: ${JSON.stringify(v)}`);
    const still = await H.page.evaluate(() => window.__evs.length);
    if (still !== moves || !(await H.page.evaluate(SEAT_OF, 'Bert')).turn) throw new Error(`the game went on although Kees waits: ${await H.page.evaluate(() => JSON.stringify(window.__evs.slice(-3)))}`);
    await shot(K, 'waiting');

    // Kees agrees after all: an AI plays for Bert until he is back.
    await vote(K, true);
    await Promise.all([H, K].map(P => toastSeen(P, 'Een AI-speler speelt nu voor Bert')));
    if (await H.page.evaluate(voteOpen) || await K.page.evaluate(voteOpen)) throw new Error('the question stays after everyone agreed');
    const seat = await H.page.evaluate(() => window.__evs.find(e => e.type === 'takeover')?.seat);
    await Promise.all([H, K].map(P => playUntil(P, aiMoved, { label: 'the AI plays for Bert' }, seat)));
    await waitFor(H, SEAT_SAYS, { label: "Bert's seat: AI speelt even mee" }, 'Bert', 'AI speelt even mee');

    // Bert is back and plays himself, told that an AI played for him; his
    // next drop-out asks again.
    await comeBack(G);
    await toastSeen(G, 'Een AI-speler speelde even voor je');
    await toastSeen(H, 'Bert is terug');
    await waitFor(H, SEAT_SAYS, { label: "Bert's seat without a status" }, 'Bert', '');
    await drop(G);
    await Promise.all([playUntil(H, voteOpen, { label: 'the question again' }), playUntil(K, voteOpen, { label: 'the question again' })]);
    v = await H.page.evaluate(VOTE);
    if (String(v.btns) !== 'AI laten spelen|false,Wachten|false' || String(v.chips) !== 'Jij…,Kees…') throw new Error(`asked again: ${JSON.stringify(v)}`);
    await vote(K, false);
    await waitFor(H, () => [...document.querySelectorAll('.vote-chip')].some(c => c.textContent === 'Keeswil wachten'), { label: 'Kees waits again' });
    // Back, he closes the question himself and has his turn. Kees, on a slow
    // line, still sees the question and changes his mind as Bert returns:
    // too late, which is nobody's mistake (no error toast).
    await K.page.evaluate(() => { window.__kj.last().__hold = []; });
    await comeBack(G);
    await waitFor(H, () => !document.querySelector('.panel-vote'), { label: 'the question closed by Bert', timeout: 8000 });
    await vote(K, true);
    await sleep(800);
    await K.page.evaluate(() => window.__kj.release());
    await waitFor(K, () => !document.querySelector('.panel-vote'), { label: 'the question closed for Kees', timeout: 8000 });
    await sleep(500);
    const late = await K.page.evaluate(() => [...document.querySelectorAll('.toast-error')].map(e => e.textContent));
    if (late.length) throw new Error(`a vote too late shows an error: ${late}`);
    await waitFor(G, () => !!document.querySelector('.panel-trump .suit-btn:not(:disabled), .panel-bid .btn-go:not(:disabled), .hand.my-turn .card.legal'), { label: "Bert's own turn" });

    // Kees leaves: the others hear an AI takes his seat only if all agree,
    // and so does he. Then Bert leaves on his turn: Anna alone is asked, so
    // the question speaks to her alone and lists nobody.
    const leaving = async P => {
      await press(P, '.topbar .tb-menu');
      await waitFor(P, () => document.querySelector('.m-menu.open'), { label: 'menu' });
      await sleep(250);
      await press(P, '.m-menu .menu-item.danger');
      await waitFor(P, () => document.querySelector('.m-confirm.open'), { label: 'leave?' });
      const text = await P.page.$eval('.m-confirm p', e => e.textContent);
      if (text !== 'De anderen beslissen samen of een AI-speler je plaats inneemt.') throw new Error(`[${P.name}] leaving mid-game: ${text}`);
      await sleep(250);
      await press(P, '.m-confirm .btn-danger');
      await waitFor(P, () => document.body.dataset.screen === 'home', { label: 'home again' });
    };
    await leaving(K);
    await waitFor(H, () => [...document.querySelectorAll('.toast')].some(t => t.querySelector('.toast-main')?.textContent === 'Kees is vertrokken'
      && t.querySelector('.toast-sub')?.textContent === 'Een AI-speler neemt de plaats pas in als iedereen akkoord is.'), { label: 'the leave toast', timeout: 8000 });
    await leaving(G);
    await waitFor(H, () => document.querySelector('.panel-vote .panel-title')?.textContent === 'Bert is vertrokken', { label: 'the question about Bert, who left' });
    const alone = await H.page.evaluate(VOTE);
    if (alone.q !== 'Mag een AI-speler de plaats van Bert innemen? Je kunt ook wachten tot iemand anders met de code aanschuift.' || alone.rule || alone.chips.length) {
      throw new Error(`the question to Anna alone: ${JSON.stringify(alone)}`);
    }
    await shot(H, 'alone');
    const bad = errorsOf(G, K);
    if (bad.length) throw new Error(bad.join('\n'));
  });
  await G.ctx.close().catch(() => {});
  await K.ctx.close().catch(() => {});

  // Someone leaves for good: three people are asked about a long name, at
  // once on that seat's turn. A friend with the code takes the seat (and
  // leaves it at once); then the table lets an AI have it.
  const LONG = 'Maximiliaan Wolfgang';
  const A2 = await page(browser, VP.desktop, 'takeover-fit-desktop', { hooks: true });
  const K2 = await page(browser, VP.phone, 'takeover-fit', { hooks: true });
  const L2 = await page(browser, VP.phone, 'takeover-fit-lotte', { hooks: true });
  const leavers = [];
  // A player over a bare websocket, who leaves as soon as a game shows, or
  // with trick, on its turn with two cards in the trick (playing the first
  // card it may until then).
  const leaver = async (code, name, trick = false) => {
    const ws = new NodeWS(BASE.replace(/^http/, 'ws') + '/ws', { headers: { Origin: BASE, 'X-Real-IP': nextIP() } });
    leavers.push(ws);
    await new Promise((ok, fail) => { ws.once('open', ok); ws.once('error', fail); });
    ws.on('message', data => {
      const m = JSON.parse(String(data));
      const s = m.s;
      if (m.t !== 'update' || s.phase === 'lobby' || ws.gone) return;
      if (!trick || s.turn === s.you && s.phase === 'play' && s.trick.cards.length >= 2) {
        ws.gone = true;
        ws.send(JSON.stringify({ t: 'leave' }));
      } else if (s.phase === 'handEnd') ws.send(JSON.stringify({ t: 'ready' }));
      else if (s.turn === s.you && s.phase === 'trump') ws.send(JSON.stringify({ t: 'trump', suit: ['C', 'D', 'H', 'S'].find(c => !(s.forced && c === s.turned)) }));
      else if (s.turn === s.you && s.phase === 'bid') ws.send(JSON.stringify({ t: 'bid', play: false }));
      else if (s.turn === s.you && s.phase === 'play') ws.send(JSON.stringify({ t: 'play', card: s.legal[0] }));
    });
    ws.send(JSON.stringify({ t: 'join', code, name }));
  };
  await run(K2, async () => {
    await home(A2, 'Anna-Sophie de Groot');
    const code = await newGame(A2, { hands: 8 });
    for (const [P, name] of [[K2, 'Kees'], [L2, 'Lotte van der Linden']]) {
      await home(P, name, '/' + code);
      await press(P, '.invite .btn-hero');
      await waitFor(P, () => document.body.dataset.screen === 'lobby', { label: 'in the lobby' });
    }
    await leaver(code, LONG, true);
    await waitFor(A2, n => [...document.querySelectorAll('.lseat .ls-name')].some(e => e.textContent === n), { label: 'Maximiliaan seated' }, LONG);
    await press(A2, '#btn-start:not(:disabled)');
    await Promise.all([A2, K2, L2].map(P => playUntil(P, voteOpen, { label: 'the question' })));
    await toastSeen(K2, `${LONG} is vertrokken`);
    await waitFor(K2, SEAT_SAYS, { label: 'the seat left: vertrokken' }, LONG, 'vertrokken');
    await sleep(400);
    const v = await K2.page.evaluate(VOTE);
    if (v.title !== `${LONG} is vertrokken` || v.q !== `Mag een AI-speler de plaats van ${LONG} innemen? Jullie kunnen ook wachten tot iemand anders met de code aanschuift.`
      || String(v.chips) !== 'Jij…,Lotte van der Linden…,Anna-Sophie de Groot…') {
      throw new Error(`the question about who left: ${JSON.stringify(v)}`);
    }
    // Unanswered, on an upright phone the side seats show (on a big one the
    // trick too), and on a desktop the trick does.
    await Promise.all([K2, A2].map(P => waitFor(P, () => !document.querySelector('.toast'), { label: 'no toasts', timeout: 10000 })));
    await voteInView(K2, { phone: VP.phone }, 'sides', 'asked');
    await voteInView(K2, { iphone: VP.iphone }, 'sides trick', 'asked');
    await voteInView(A2, { desktop: VP.desktop }, 'sides trick', 'asked');
    await vote(L2, false);
    await vote(A2, true);
    await waitFor(K2, () => document.querySelectorAll('.vote-chip.yes, .vote-chip.no').length === 2, { label: 'two answers' });
    // The toasts of the start and the leave go first (they would cover the shots).
    await Promise.all([K2, A2].map(P => waitFor(P, () => !document.querySelector('.toast'), { label: 'no toasts', timeout: 10000 })));
    const sizes = { phone: VP.phone, se: SE, iphone: VP.iphone, landscape: VP.landscape, smallLandscape: VP.smallLandscape };
    for (const [label, vp] of Object.entries(sizes)) {
      await K2.page.setViewport(vp);
      await sleep(500);
      const fit = await K2.page.evaluate(VOTE_FIT);
      await shot(K2, label);
      if (fit.bad.length || fit.chips !== 3) throw new Error(`the question at ${vp.width}×${vp.height}: ${JSON.stringify(fit)}`);
      await checkOverflow(K2, label);
    }
    // Answered, with three people asked and long names: the side seats and
    // the trick show; on a short phone and the smallest one on its side,
    // where the chips take three lines or the panel goes wide, the side
    // seats do. The answers stay put as Kees answers.
    await K2.page.setViewport(VP.phone);
    await sleep(500);
    const at = await K2.page.evaluate(BTNS_AT);
    await vote(K2, false);
    await waitFor(K2, () => !!document.querySelector('.panel-vote.answered'), { label: 'Kees answered' });
    await sleep(500);
    const moved = await K2.page.evaluate(BTNS_AT);
    if (moved !== at) throw new Error(`the answers moved as Kees answered: ${at} → ${moved}`);
    await voteInView(K2, { phone: VP.phone, iphone: VP.iphone, landscape: VP.landscape }, 'sides trick', 'answered');
    await voteInView(K2, { se: SE, smallLandscape: VP.smallLandscape }, 'sides', 'answered');
    await K2.page.setViewport(VP.phone);

    // Joop joins with the code in the seat Maximiliaan left, which ends the
    // question, and leaves again: a new question, nobody has answered it.
    await leaver(code, 'Joop');
    await waitFor(K2, () => [...document.querySelectorAll('.chat-list .msg.sys')].some(m => m.textContent === 'Joop neemt de plaats van Maximiliaan Wolfgang over.'), { label: 'Joop in the seat' });
    await Promise.all([A2, K2, L2].map(P => waitFor(P, () => document.querySelector('.panel-vote .panel-title')?.textContent === 'Joop is vertrokken', { label: 'the question about Joop' })));
    const j = await K2.page.evaluate(VOTE);
    if (String(j.chips) !== 'Jij…,Lotte van der Linden…,Anna-Sophie de Groot…' || String(j.btns) !== 'AI laten spelen|false,Wachten|false') throw new Error(`the question about Joop: ${JSON.stringify(j)}`);

    // Everyone agrees: a bot takes the seat.
    for (const P of [L2, A2, K2]) await vote(P, true);
    await waitFor(K2, () => [...document.querySelectorAll('.toast-main')].some(e => / \(AI\) neemt het over$/.test(e.textContent)), { label: 'the bot takes the seat', timeout: 8000 });
    if (await K2.page.evaluate(voteOpen)) throw new Error('the question stays after everyone agreed');
    const names = await K2.page.$$eval('.seat .nm', els => els.map(e => e.textContent));
    if (names.includes('Joop') || names.filter(n => n.endsWith(' (AI)')).length !== 1) throw new Error(`seats after the takeover: ${names}`);
    const bad = errorsOf(A2, L2);
    if (bad.length) throw new Error(bad.join('\n'));
  });
  for (const ws of leavers) ws.close();
  await A2.ctx.close().catch(() => {});
  await L2.ctx.close().catch(() => {});
};

// Calling (issues #43, #61): the call is offered in the lobby, not
// proposed, and not at all alone with bots. The first time one calls, the
// sheet asks whether to come into the call by oneself from then on
// (Automatisch meebellen, off); Niet nu keeps nothing. A page with that on
// is in the call by itself, already in the lobby, and asked once for the
// microphone and camera. One that joins with both off listens, and still
// hears and sees the other. A page that hung up stays out of the call in
// that room: neither proposed it nor put in it. A video takes the place of
// a face, with the dealer's and trump's marks outside it; a muted
// microphone has a mark in the circle. Microphone and camera switch with
// one tap and are remembered (a refused one as off), and a refused camera
// leaves the microphone; a new connection starts a new call session; the
// phone's menu hangs up; a reload comes back into the call with
// Automatisch meebellen, with the devices as last chosen, and never
// answered is proposed it, with the question, its answers in view in
// short landscape. A camera or microphone that goes by itself is switched
// off, also a microphone that went while the camera was asked for; video
// goes under a ceiling, and a muted microphone sends nothing until it is
// on. The iOS audio session records from before the microphone is asked
// until it has stopped: after a hang-up and after leaving while the
// devices were asked for.
CHECKS.call = async browser => {
  // The host's browser has an iOS audio session (Chromium has none): each
  // type set goes in __session with the number of live tracks then, and
  // each request for the devices with the type it was made under. With
  // window.__hold the devices wait for it.
  const H = await page(browser, VP.phone, 'call-host', {
    call: true,
    init: () => {
      const log = (window.__session = []);
      const tracks = (window.__tracks = []);
      const live = () => tracks.filter(t => t.readyState === 'live').length;
      let type = 'auto';
      const as = { get type() { return type; }, set type(v) { type = v; log.push(`${v}/${live()}`); } };
      Object.defineProperty(Navigator.prototype, 'audioSession', { get: () => as, configurable: true });
      window.__live = live;
      const md = navigator.mediaDevices;
      const real = md.getUserMedia.bind(md);
      md.getUserMedia = async c => {
        log.push(`ask/${type}`);
        await window.__hold;
        const st = await real(c);
        tracks.push(...st.getTracks());
        return st;
      };
    },
  });
  // The guest's browser refuses the camera until window.__camOk (the fake
  // devices of scripts/chrome are always allowed); with window.__camHold,
  // the camera asked for on its own waits for it first. window.__mic is the
  // latest microphone track.
  const G = await page(browser, VP.desktop, 'call-guest', {
    call: true,
    hooks: true,
    init: () => {
      const md = navigator.mediaDevices;
      const real = md.getUserMedia.bind(md);
      md.getUserMedia = async c => {
        if (c.video && !window.__camOk) {
          if (!c.audio) await window.__camHold;
          throw new DOMException('Permission denied', 'NotAllowedError');
        }
        const st = await real(c);
        window.__mic = st.getAudioTracks()[0] || window.__mic;
        return st;
      };
    },
  });
  // Keeps the connections, for __sending(): for each connection up, whether
  // the microphone's track is on it, and the video's ceiling.
  const keepPCs = () => {
    const Native = window.RTCPeerConnection;
    const pcs = [];
    window.RTCPeerConnection = class extends Native {
      constructor(...a) {
        super(...a);
        pcs.push(this);
      }
    };
    window.__sending = () => pcs.filter(pc => pc.connectionState === 'connected').map(pc => {
      const sender = kind => pc.getTransceivers().find(t => t.receiver.track.kind === kind).sender;
      return `${sender('audio').track ? 'mic' : 'none'}/${sender('video').getParameters().encodings[0]?.maxBitrate}`;
    }).join(',');
  };
  for (const P of [H, G]) await P.page.evaluateOnNewDocument(keepPCs);
  const sends = (P, label, want) => waitFor(P, w => window.__sending() === w, { label }, want);
  // The seats (by name) that show a playing video, and the call marks
  // (name:off|lost; none while the microphone is on).
  const shows = (P, label, want) => waitFor(P, w => [...document.querySelectorAll('.seat:not([hidden]) .ring.cam')].flatMap(r => {
    const el = r.querySelector(':scope > video.call-video');
    return el && el.videoWidth > 0 && !el.paused ? [r.closest('.seat').querySelector('.nm').textContent] : [];
  }).sort().join(',') === w, { label, timeout: 30000 }, want);
  const marked = (P, label, want) => waitFor(P, w => [...document.querySelectorAll('.seat:not([hidden]) .ring')].flatMap(r => {
    const t = r.querySelector(':scope > .call-tag');
    return t ? [`${r.closest('.seat').querySelector('.nm').textContent}:${t.dataset.key}`] : [];
  }).sort().join(',') === w, { label, timeout: 30000 }, want);
  const inCall = (P, label) => waitFor(P, () => !!document.querySelector('.call-dock:not([hidden]) .tb-hangup'), { label });
  const outCall = (P, label) => waitFor(P, () => !!document.querySelector('.call-dock:not([hidden]) .tb-call'), { label });
  const stored = P => P.page.evaluate(() => JSON.parse(localStorage.getItem('kj.call') || '{}'));
  const toasted = (P, text) => waitFor(P, t => [...document.querySelectorAll('.toast')].some(e => e.textContent.includes(t)), { label: text }, text);
  // Taps a call button once nothing lies over it: on a phone the trump or
  // bid panel covers it while we choose, so we choose first.
  const tapCall = async (P, sel) => {
    await playUntil(P, q => {
      const b = document.querySelector(q);
      const r = b?.getBoundingClientRect();
      const hit = r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && b.contains(hit);
    }, { label: `${sel} in reach` }, sel);
    await press(P, sel);
  };
  // The switches of the call sheet, by label: whether each is on.
  const switches = P => P.page.$$eval('.m-call .set-row', rows => rows.map(r => `${r.querySelector('b').textContent}:${r.querySelector('input').checked}`).join(','));
  const flip = async (P, label) => {
    for (const r of await P.page.$$('.m-call .set-row')) if (await r.$eval('b', e => e.textContent) === label) return pressEl(P, await r.$('.switch'));
    throw new Error(`[${P.name}] no switch ${label}`);
  };
  // The call marks lie in their circles (issue #61).
  const tagsIn = async P => {
    const bad = await P.page.evaluate(() => [...document.querySelectorAll('.seat:not([hidden]) .ring > .call-tag')].flatMap(tag => {
      const r = tag.parentElement.getBoundingClientRect();
      const b = tag.getBoundingClientRect();
      const out = Math.hypot(b.left + b.width / 2 - r.left - r.width / 2, b.top + b.height / 2 - r.top - r.height / 2) + b.width / 2 - r.width / 2;
      return out > 0.5 ? [`${tag.closest('.seat').querySelector('.nm').textContent} ${out.toFixed(1)}px out`] : [];
    }));
    if (bad.length) throw new Error(`[${P.name}] call marks out of their circle: ${bad.join(', ')}`);
  };
  await run(H, async () => {
    // Alone with bots: no call, and call.js is not even fetched.
    const S = await page(browser, VP.phone, 'call-solo', { call: true });
    try {
      const fetched = [];
      S.page.on('request', r => fetched.push(r.url()));
      await home(S, 'Solo');
      await quick(S);
      await sleep(1500);
      const solo = await S.page.evaluate(() => ({ dock: !document.querySelector('.prompt .call-dock')?.hidden, sheet: !!document.querySelector('.m-call') }));
      if (solo.dock || solo.sheet || fetched.some(u => u.includes('/js/call.js'))) throw new Error(`call alone with bots: ${JSON.stringify(solo)}, fetched call.js ${fetched.some(u => u.includes('call.js'))}`);
    } finally {
      await S.ctx.close().catch(() => {});
    }

    await home(H, 'Host');
    // The host turned Automatisch meebellen on under Instellingen, before
    // it ever called.
    await H.page.evaluate(() => localStorage.setItem('kj.call', JSON.stringify({ auto: true })));
    const code = await newGame(H);
    await home(G, 'Gast', '/' + code);
    await press(G, '.invite .btn-hero');
    // The host comes into the call by itself, already in the lobby, and is
    // asked for the microphone and camera it never chose. The guest is
    // offered the call there, not proposed it.
    await waitFor(H, () => document.querySelector('.m-call.open .btn-go'), { label: 'devices asked in the lobby' });
    await inCall(H, 'host in the call in the lobby');
    const text = await H.page.$eval('.m-call .dlg-body p', e => e.textContent);
    if (!text.startsWith('Je zit in het gesprek:')) throw new Error(`the host's sheet says "${text}"`);
    if (await switches(H) !== 'Microfoon:true,Camera:true') throw new Error(`the host's switches ${await switches(H)}`);
    await waitFor(G, () => document.querySelector('.lb-call:not([hidden]) .tb-call'), { label: 'call button in the lobby' });
    await sleep(500);
    if (await G.page.$('.m-call')) throw new Error('the call was proposed in the lobby');
    // The host switches them on.
    await press(H, '.m-call .btn-go');
    await waitFor(H, () => window.__session.some(e => e.startsWith('ask/')), { label: 'host asks for the devices' });
    const asked = await H.page.evaluate(() => window.__session.filter(e => e.startsWith('ask/')));
    if (String(asked) !== 'ask/play-and-record') throw new Error(`the host asked for the devices under ${asked}`);
    await sleep(300);

    // The guest calls with the lobby's Bellen button, asked the first time
    // whether to call by itself from then on (off). It switches that on, and
    // its microphone and camera off: it listens, and hears the host. Hung
    // up, it stays out of the call in this room, though it would now come
    // into it by itself: also when the game starts, which proposes nothing.
    await press(G, '.lb-call .tb-call');
    await waitFor(G, () => document.querySelector('.m-call.open .btn-go'), { label: 'call sheet in the lobby' });
    const offered = await G.page.$eval('.m-call .dlg-body p', e => e.textContent);
    if (!offered.startsWith('Host belt al.')) throw new Error(`the guest's sheet says "${offered}"`);
    if (await switches(G) !== 'Microfoon:true,Camera:true,Automatisch meebellen:false') throw new Error(`the guest's switches ${await switches(G)}`);
    await sleep(300);
    await flip(G, 'Microfoon');
    await flip(G, 'Camera');
    await flip(G, 'Automatisch meebellen');
    await press(G, '.m-call .btn-go');
    await inCall(G, 'guest in the call in the lobby');
    const chose = await stored(G);
    if (chose.mic !== false || chose.cam !== false || chose.auto !== true) throw new Error(`the guest remembers ${JSON.stringify(chose)}`);
    const heard = () => [...document.querySelectorAll('.call-media audio')].some(a => !a.paused && a.srcObject?.getAudioTracks()[0]?.muted === false);
    await waitFor(G, heard, { label: 'host heard in the lobby' });
    await press(G, '.lb-call .tb-hangup');
    await outCall(G, 'guest hung up in the lobby');
    await sleep(1500);
    if (await G.page.$('.call-dock .tb-hangup')) throw new Error('the guest came back into the call after hanging up');
    await press(H, '#btn-start:not(:disabled)');
    await waitFor(G, () => document.body.dataset.screen === 'game', { label: 'guest at the table' });
    await shows(H, 'own video', 'Host');
    await sleep(1000);
    if (await G.page.$('.m-call') || await G.page.$('.call-dock .tb-hangup')) throw new Error('the guest was proposed the call or put in it at the start, after hanging up');
    if (await G.page.$('.seat:not([hidden]) .ring.cam')) throw new Error('video outside the call');

    // The guest calls again with the Bellen button, asked only for its
    // devices (both off, as last chosen): it listens, and sees and hears the
    // host. Its seat has the mark of a microphone off, in the circle; the
    // host's none.
    await tapCall(G, '.prompt .call-dock .tb-call');
    await waitFor(G, () => document.querySelector('.m-call.open .btn-go'), { label: 'call sheet' });
    if (await switches(G) !== 'Microfoon:false,Camera:false') throw new Error(`the guest's switches with Bellen ${await switches(G)}`);
    await sleep(300);
    await press(G, '.m-call .btn-go');
    await inCall(G, 'guest in the call');
    await shows(G, 'host video on the page of the guest who listens', 'Host');
    await waitFor(G, heard, { label: 'host heard on the guest page' });
    await marked(G, 'guest muted', 'Gast:off');
    await marked(H, 'guest muted on the host page', 'Gast:off');
    await tagsIn(H);

    // The guest's camera is refused, its microphone comes: one tap each.
    await tapCall(G, '.prompt .call-dock .tb-cam');
    await toasted(G, 'Geen toegang tot de camera');
    await tapCall(G, '.prompt .call-dock .tb-mic');
    await marked(H, 'guest with microphone', '');
    if (!(await G.page.$('.prompt .call-dock .tb-cam[aria-pressed="false"]'))) throw new Error('guest camera button not off');

    // The camera allowed after all: one tap and the host sees the guest.
    await G.page.evaluate(() => { window.__camOk = true; });
    await tapCall(G, '.prompt .call-dock .tb-cam');
    await shows(H, 'guest video on the host page', 'Gast,Host');
    await shows(G, 'both videos on the guest page', 'Gast,Host');
    // The dealer's and trump's marks lie outside a ring with a video (issue #53).
    for (const P of [H, G]) {
      const over = await P.page.evaluate(() => [...document.querySelectorAll('.seat:not([hidden]) .ring.cam')].flatMap(r => {
        const b = r.getBoundingClientRect();
        return [...r.querySelectorAll(':scope > :is(.dealer-chip, .trump-tag):not([hidden])')].flatMap(m => {
          const mb = m.getBoundingClientRect();
          const gap = Math.hypot(mb.left + mb.width / 2 - b.left - b.width / 2, mb.top + mb.height / 2 - b.top - b.height / 2) - (b.width + mb.width) / 2;
          return gap < 0 ? [`${r.closest('.seat').querySelector('.nm').textContent} ${m.className} ${gap.toFixed(1)}px`] : [];
        });
      }));
      if (over.length) throw new Error(`[${P.name}] marks over a video: ${over.join(', ')}`);
    }
    await shot(H, 'videos');
    await shot(G, 'videos');
    await checkOverflow(H, 'in the call');
    await checkOverflow(G, 'in the call');
    // The one who offers and the one who answers each set the ceiling.
    await sends(H, 'host video under the ceiling', 'mic/300000');
    await sends(G, 'guest video under the ceiling', 'mic/300000');

    // The guest's camera and microphone go by themselves (the permission
    // withdrawn, as when a device is unplugged or another app takes it):
    // off as with their buttons. Allowed again, one tap brings each back,
    // the video under the same ceiling.
    const cdp = await browser.target().createCDPSession();
    const permit = (name, setting) => cdp.send('Browser.setPermission', { permission: { name }, setting, origin: BASE, browserContextId: G.ctx.id });
    await permit('camera', 'denied');
    await waitFor(G, () => document.querySelector('.prompt .call-dock .tb-cam[aria-pressed="false"]'), { label: 'guest camera off by itself' });
    await shows(G, 'the guest without its own video', 'Host');
    await permit('microphone', 'denied');
    await waitFor(G, () => document.querySelector('.prompt .call-dock .tb-mic[aria-pressed="false"]'), { label: 'guest microphone off by itself' });
    await marked(H, 'guest microphone off on the host page', 'Gast:off');
    await sends(G, 'no ended microphone on the connection', 'none/300000');
    await permit('camera', 'granted');
    await permit('microphone', 'granted');
    await tapCall(G, '.prompt .call-dock .tb-cam');
    await shows(H, 'guest video back on the host page', 'Gast,Host');
    await tapCall(G, '.prompt .call-dock .tb-mic');
    await marked(H, 'guest microphone back on the host page', '');
    await sends(G, 'guest microphone back, video under the ceiling again', 'mic/300000');

    // The guest hangs up, and joins again with the Bellen button (asked
    // nothing more than its devices): in the call at once, listening, while
    // the camera, refused once more but slowly, is still asked for and the
    // microphone goes meanwhile. The microphone stays off, nothing on the
    // connection; allowed again, one tap brings it back. Then the camera.
    await tapCall(G, '.prompt .call-dock .tb-hangup');
    await shows(H, 'guest hung up', 'Host');
    await outCall(G, 'guest out of the call');
    await G.page.evaluate(() => {
      window.__camOk = false;
      window.__camHold = new Promise(r => { window.__camGo = r; });
    });
    await tapCall(G, '.prompt .call-dock .tb-call');
    await waitFor(G, () => document.querySelector('.m-call.open .btn-go'), { label: 'call sheet' });
    if (!(await G.page.$eval('.m-call .dlg-body p', e => e.textContent)).startsWith('Host belt al.')) throw new Error('the Bellen sheet does not say who calls');
    if (await switches(G) !== 'Microfoon:true,Camera:true') throw new Error(`the guest's switches the second time ${await switches(G)}`);
    await sleep(300);
    await press(G, '.m-call .btn-go');
    await marked(H, 'guest in the call at once, listening', 'Gast:off');
    await waitFor(G, () => window.__mic.readyState === 'live', { label: 'guest microphone, the camera still asked for' });
    if (!(await G.page.$('.prompt .call-dock .tb-mic:disabled'))) throw new Error('the guest\'s buttons not waiting for the camera');
    await permit('microphone', 'denied');
    await waitFor(G, () => window.__mic.readyState === 'ended', { label: 'guest microphone ended while the camera is asked for' });
    await G.page.evaluate(() => window.__camGo());
    await waitFor(G, () => document.querySelector('.prompt .call-dock .tb-mic[aria-pressed="false"]:not(:disabled)'), { label: 'guest with the microphone off' });
    await marked(H, 'guest microphone still off on the host page', 'Gast:off');
    await sends(G, 'no microphone that ended meanwhile on the connection', 'none/300000');
    await permit('microphone', 'granted');
    await cdp.detach();
    await tapCall(G, '.prompt .call-dock .tb-mic');
    await marked(H, 'guest microphone on', '');
    await G.page.evaluate(() => { window.__camOk = true; });
    await tapCall(G, '.prompt .call-dock .tb-cam');
    await shows(H, 'guest video on the host page again', 'Gast,Host');

    // The host's microphone off: one tap, marked on the guest page, remembered.
    await tapCall(H, '.prompt .call-dock .tb-mic');
    await marked(G, 'host muted', 'Host:off');
    await tagsIn(G);
    await sends(H, 'no microphone on the connection', 'none/300000');
    const kept = await stored(H);
    if (kept.mic !== false || kept.cam !== true || kept.auto !== true) throw new Error(`host remembers ${JSON.stringify(kept)}`);
    // On again: the microphone is back on the connection at once.
    await tapCall(H, '.prompt .call-dock .tb-mic');
    await marked(G, 'host unmuted', '');
    await sends(H, 'microphone back on the connection', 'mic/300000');

    // A new connection: the call goes on in a new session.
    const ids = () => G.page.evaluate(() => window.__kj.sent.filter(m => m.t === 'call' && m.id).map(m => m.id));
    const before = await ids();
    await G.page.evaluate(() => window.__kj.last().close());
    await waitFor(G, n => new Set(window.__kj.sent.filter(m => m.t === 'call' && m.id).map(m => m.id)).size > n, { label: 'new call session' }, new Set(before).size);
    await shows(H, 'guest video after the reconnect', 'Gast,Host');
    await shows(G, 'host video after the reconnect', 'Gast,Host');

    // The phone's menu hangs up.
    await press(H, '.topbar .tb-menu');
    await waitFor(H, () => document.querySelector('.m-menu.open'), { label: 'menu' });
    await sleep(250);
    const items = await H.page.$$eval('.m-menu .menu-item', els => els.map(e => e.textContent));
    if (!items.includes('Ophangen')) throw new Error(`menu items ${items}`);
    const hang = (await H.page.$$('.m-menu .menu-item'))[items.indexOf('Ophangen')];
    await pressEl(H, hang);
    await shows(G, 'only the own video after the hang-up', 'Gast');
    await outCall(H, 'host call button again');
    // Though it came into the call by itself, it stays out now.
    await sleep(1500);
    if (await H.page.$('.call-dock .tb-hangup')) throw new Error('the host came back into the call after hanging up');
    // The game's session again, set once the microphone and camera had stopped.
    const hung = await H.page.evaluate(() => window.__session);
    if (hung.at(-1) !== 'ambient/0' || hung.some(e => /^ambient\/[1-9]/.test(e))) throw new Error(`the host's audio session: ${hung.join(' ')}`);

    // With Automatisch meebellen (on since the lobby) a reload comes into
    // the call by itself, with the microphone and camera as last chosen (the
    // camera refused again: the microphone alone), and asks nothing.
    await G.page.reload({ waitUntil: 'networkidle0' });
    await inCall(G, 'in the call by itself after a reload');
    await toasted(G, 'Geen toegang tot de camera');
    await waitFor(G, () => document.querySelector('.call-dock .tb-mic[aria-pressed="true"]'), { label: 'microphone on after the reload' });
    if (await G.page.$('.m-call')) throw new Error('asked after a reload');
    const refused = await stored(G);
    if (refused.mic !== true || refused.cam !== false) throw new Error(`a refused camera not remembered as off: ${JSON.stringify(refused)}`);
    // Never answered (as before #61), a reload proposes the call: the
    // switches as last chosen, and the question whether to call by itself,
    // off. In short landscape it and the answers stay in reach. Niet nu keeps
    // nothing, and the guest stays out of the call.
    await G.page.evaluate(() => {
      const c = JSON.parse(localStorage.getItem('kj.call'));
      delete c.auto;
      localStorage.setItem('kj.call', JSON.stringify(c));
    });
    await G.page.reload({ waitUntil: 'networkidle0' });
    await waitFor(G, () => document.querySelector('.m-call.open .btn-go'), { label: 'proposed after a reload' });
    if (await switches(G) !== 'Microfoon:true,Camera:false,Automatisch meebellen:false') throw new Error(`guest's switches after the reload ${await switches(G)}`);
    for (const [w, hh] of [[568, 320], [740, 300]]) {
      await G.page.setViewport({ ...VP.desktop, width: w, height: hh });
      await sleep(600);
      // The question above the answers, and both where a tap reaches them.
      const bad = await G.page.evaluate(() => {
        const row = [...document.querySelectorAll('.m-call .set-row')].find(r => r.querySelector('b').textContent === 'Automatisch meebellen');
        const d = document.querySelector('.m-call .dlg-body').getBoundingClientRect();
        const out = [];
        for (const [n, el] of [['question', row.querySelector('.switch')], ['answer', document.querySelector('.m-call .btn-go')]]) {
          const b = el.getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          if (b.top < d.top || b.bottom > d.bottom + 0.5 || b.bottom > innerHeight || !el.contains(hit)) out.push(n);
        }
        if (row.getBoundingClientRect().bottom > document.querySelector('.m-call .btn-row').getBoundingClientRect().top + 0.5) out.push('order');
        return out;
      });
      await shot(G, `first-sheet-${w}x${hh}`);
      if (bad.length) throw new Error(`the first sheet at ${w}x${hh}: ${bad.join(', ')} out of reach`);
    }
    await G.page.setViewport(VP.desktop);
    await sleep(600);
    await press(G, '.m-call .btn-ghost');
    await waitFor(G, () => !document.querySelector('.m-call'), { label: 'proposal closed' });
    await sleep(1000);
    const after = await G.page.evaluate(() => ({ kept: JSON.parse(localStorage.getItem('kj.call')), joined: window.__kj.sent.some(m => m.t === 'call' && m.id) }));
    if ('auto' in after.kept || after.joined) throw new Error(`after Niet nu: ${JSON.stringify(after)}`);
    await marked(H, 'nobody in the call', '');

    // Refused at the browser's question (slowly, as a person answers): only
    // the device the browser already allows is asked for again; the other
    // is remembered as off.
    const cdp2 = await browser.target().createCDPSession();
    const permit2 = (name, setting) => cdp2.send('Browser.setPermission', { permission: { name }, setting, origin: BASE, browserContextId: G.ctx.id });
    await permit2('microphone', 'granted');
    await permit2('camera', 'denied');
    await G.page.evaluate(() => {
      localStorage.setItem('kj.call', JSON.stringify({ mic: true, cam: true, auto: false }));
      const md = navigator.mediaDevices;
      const prev = md.getUserMedia;
      window.__asks = [];
      md.getUserMedia = async c => {
        window.__asks.push(`${c.audio ? 'mic' : ''}${c.video ? 'cam' : ''}`);
        if (c.audio && c.video) {
          await new Promise(r => setTimeout(r, 1200));
          throw new DOMException('Permission denied', 'NotAllowedError');
        }
        return prev.call(md, c);
      };
    });
    await tapCall(G, '.prompt .call-dock .tb-call');
    await waitFor(G, () => document.querySelector('.m-call.open .btn-go'), { label: 'call sheet, refused slowly' });
    await sleep(300);
    await press(G, '.m-call .btn-go');
    await toasted(G, 'Geen toegang tot de camera');
    await waitFor(G, () => document.querySelector('.call-dock .tb-mic[aria-pressed="true"]:not(:disabled)'), { label: 'the allowed microphone after a slow refusal' });
    const slow = await G.page.evaluate(() => ({ asks: window.__asks.join(','), kept: JSON.parse(localStorage.getItem('kj.call')) }));
    if (slow.asks !== 'miccam,mic' || slow.kept.mic !== true || slow.kept.cam !== false) throw new Error(`after a slow refusal: asked ${slow.asks}, remembered ${JSON.stringify(slow.kept)}`);
    await cdp2.detach();

    // The host joins again, the devices slow to come, and leaves the table
    // meanwhile: in the call it was at once, the session is the game's
    // again, and the tracks that come late are stopped.
    await H.page.evaluate(() => { window.__hold = new Promise(r => { window.__release = r; }); });
    await tapCall(H, '.prompt .call-dock .tb-call');
    await waitFor(H, () => document.querySelector('.m-call.open .btn-go'), { label: 'host call sheet' });
    await sleep(300);
    await press(H, '.m-call .btn-go');
    await waitFor(H, () => window.__session.at(-1) === 'ask/play-and-record', { label: 'host asks for the devices again' });
    await inCall(H, 'host in the call while the devices are asked for');
    await press(H, '.topbar .tb-menu');
    await waitFor(H, () => document.querySelector('.m-menu.open'), { label: 'menu' });
    await sleep(250);
    await press(H, '.m-menu .menu-item.danger');
    await waitFor(H, () => document.querySelector('.m-confirm.open .btn-danger'), { label: 'leave dialog' });
    await sleep(250);
    await press(H, '.m-confirm .btn-danger');
    await waitFor(H, () => document.body.dataset.screen === 'home', { label: 'host left the table' });
    await H.page.evaluate(() => window.__release());
    await waitFor(H, () => window.__tracks.length === 4 && window.__live() === 0, { label: 'late tracks stopped' });
    const left = await H.page.evaluate(() => ({ log: window.__session, type: navigator.audioSession.type }));
    if (left.log.at(-1) !== 'ambient/0' || left.type !== 'ambient') throw new Error(`the host's audio session after leaving: ${left.log.join(' ')}`);
  });
  await G.ctx.close().catch(() => {});
};

// ---------- runner ----------

let failures = [];
async function run(P, fn) {
  const t0 = Date.now();
  try {
    await fn();
    // Sockets the check blocked on purpose fail loudly; that is expected.
    const errors = P.errors.filter(e => !e.includes('/blocked'));
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(`  ok ${P.name} (${Math.round((Date.now() - t0) / 1000)} s)`);
  } catch (e) {
    await shot(P, 'zz-failure').catch(() => {});
    failures.push(`[${P.name}] ${e.message || e}`);
    console.log(`  FAIL ${P.name}: ${e.message || e}`);
  } finally {
    await P.ctx.close().catch(() => {});
  }
}

const names = A.only ? A.only.split(',') : Object.keys(CHECKS);
const browser = await connect(A.cdp);
try {
  for (const n of names) {
    if (!CHECKS[n]) throw new Error(`no check ${n}; have ${Object.keys(CHECKS)}`);
    console.log(n);
    await CHECKS[n](browser);
  }
} finally {
  await browser.disconnect();
  proxy.close();
}
if (failures.length) {
  console.error('FAILED:\n' + failures.join('\n'));
  process.exit(1);
}
console.log(`ok: ${names.length} checks`);
process.exit(0); // the proxy may still hold keep-alive connections
