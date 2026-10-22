// Focused regression checks for the table, overlays and connection handling,
// against the real server from source with -fast pacing:
//
//   scripts/dev-server 18300 -fast && scripts/chrome 9303
//   cd test/ui && node app-checks.mjs --url http://127.0.0.1:18300 --cdp http://127.0.0.1:9303 [--only coach,lost]
//
// Each check runs in fresh browser contexts, each with an address of its own
// (addressProxy in app-lib.mjs), so the server's per-address limits do not
// trip over a full run.
import { WebSocket as NodeWS } from 'ws';
import {
  args, connect, openPage, VIEWPORTS, press, pressEl, type, shot, waitFor, sleep, playLegal, addressProxy, nextIP, ownAddress,
} from './app-lib.mjs';

const A = args();
const VP = {
  ...VIEWPORTS,
  smallLandscape: { width: 640, height: 360, isMobile: true, hasTouch: true, isLandscape: true, deviceScaleFactor: 1 },
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

async function page(browser, vp, name, { hooks = false, init = null } = {}) {
  const P = await openPage(browser, vp, name);
  await ownAddress(P, BASE);
  if (hooks) await P.page.evaluateOnNewDocument(netHooks);
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

async function pickOpt(P, sheet, row, value) {
  const btns = await P.page.$$(`${sheet} .opt-row:nth-child(${row}) .seg-btn`);
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
  await pickOpt(P, '.m-new', 1, String(players));
  await pickOpt(P, '.m-new', 2, String(hands));
  await pickOpt(P, '.m-new', 6, 'Snel');
  await press(P, '#btn-create');
  await waitFor(P, () => document.body.dataset.screen === 'lobby' && document.querySelector('.code-big span'), { label: 'lobby' });
  return P.page.$$eval('.code-big span', els => els.map(e => e.textContent).join(''));
}

async function training(P, trumpMode = 'Utrechts') {
  await press(P, '#btn-train');
  await waitFor(P, () => document.querySelector('.m-train.open'), { label: 'training sheet' });
  await sleep(300);
  if (trumpMode !== 'Utrechts') await pickOpt(P, '.m-train', 1, trumpMode);
  await pickOpt(P, '.m-train', 3, 'Snel');
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

// Training on a short landscape screen: the coach in the top-left corner
// never covers the left seat (who plays after you) or the partner on top;
// a long text shows the lines that fit and "Lees verder", which opens it.
CHECKS.coachfit = async browser => {
  const LONG = 'Kees de Visser (AI) wint de slag met ♣A, de hoogste kaart in de gevraagde kleur. 27 punten. Juf Ans had ♦10 aangeraden. Je maat had de slag al, dus gooi dan punten bij: een 10 of een aas van een kleur die je niet kunt bekennen.';
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

// Hand summary and score sheet: who played which card, running totals,
// and the review of the previous hand stays while updates arrive. The
// updates are held back while the overlays open (-fast pacing would move
// on first), then let through.
CHECKS.review = async browser => {
  const P = await page(browser, VP.iphone, 'review', {
    hooks: true,
    init: () => localStorage.setItem('kj.opts', JSON.stringify({ hands: 4, tempo: 'snel' })),
  });
  await run(P, async () => {
    await home(P);
    await quick(P);
    await P.page.evaluate(() => { window.__kj.last().__holdAfter = 'handEnd'; });
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
    await P.page.keyboard.press('Escape');
    await sleep(300);
    await press(P, '.m-summary .btn-go');
    await P.page.evaluate(() => window.__kj.release());

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
    await press(P, '.m-score .back-btn');
    await waitFor(P, () => document.querySelector('.m-score .scoresheet') && document.querySelector('.m-score h2').textContent === 'Scorebord', { label: 'back to the score sheet' });
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

// Touch: a lifted card says how to play it; a forced card plays on one tap.
// The chat badge stays dark for bot and system lines.
CHECKS.taps = async browser => {
  const P = await page(browser, VP.phone, 'taps');
  await run(P, async () => {
    await home(P);
    await quick(P);
    let lifted = false;
    let forced = false;
    const t0 = Date.now();
    while ((!lifted || !forced) && Date.now() - t0 < 120000) {
      const st = await P.page.evaluate(() => ({
        trump: !!document.querySelector('.panel-trump .suit-btn:not(:disabled)'),
        play: !!document.querySelector('.hand.my-turn .card.legal'),
        summary: !!document.querySelector('.m-summary.open .btn-go:not(:disabled)'),
        legal: document.querySelectorAll('.hand.my-turn .card.legal').length,
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
          const again = await P.page.$(`.hand .card.selected[data-card="${code}"]`);
          await pressEl(P, again);
        }
      }
      await sleep(120);
    }
    if (!lifted || !forced) throw new Error(`saw lifted ${lifted}, forced ${forced}`);
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

    await pickOpt(H, '.lb-opts', 1, '3');
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
