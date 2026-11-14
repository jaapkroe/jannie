// Shared helpers for the browser checks of every game (app-screens.mjs,
// app-play.mjs, app-checks.mjs, toepen-screens.mjs, the manual's and the
// sound's scripts; css-same.mjs uses its hooks): connect to scripts/chrome,
// give every page an address of its own, open isolated pages per viewport,
// collect errors, tap like a finger or click like a mouse, hold the
// server's messages, save screenshots, and run a script's flows per
// viewport.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUT = path.join(HERE, 'out');

// Where a tool that rides along with a check (css-same.mjs) hooks in, each a
// list of async functions: page(P) for every new page before it loads
// anything, shot(P, label) before every screenshot, wait(P, label) after
// every condition waitFor saw come true.
export const hooks = { page: [], shot: [], wait: [] };

export const VIEWPORTS = {
  phone: { width: 360, height: 640, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
  // iPhone SE in Safari with its toolbars: the smallest common phone, trick cards under 60 px.
  iphonese: { width: 375, height: 548, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
  iphone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
  landscape: { width: 844, height: 390, isMobile: true, hasTouch: true, isLandscape: true, deviceScaleFactor: 1 },
  tablet: { width: 768, height: 1024, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
  desktop: { width: 1440, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
};

export function args() {
  const a = process.argv.slice(2);
  const get = (name, def) => {
    const i = a.indexOf('--' + name);
    return i < 0 ? def : a[i + 1];
  };
  return {
    url: get('url', 'http://127.0.0.1:18300'),
    cdp: get('cdp', 'http://127.0.0.1:9301'),
    only: get('only', ''),
    flows: get('flows', ''),
    dpr: Number(get('dpr', 0)),
    has: name => a.includes('--' + name),
  };
}

// The server limits rooms and connections per client address (X-Real-IP,
// trusted as from nginx). Pages reach it through addressProxy, which sets
// X-Real-IP from the browser context's "kjip" cookie (ownAddress), so each
// context counts as an address of its own and a long run does not trip the
// limits. Extra HTTP headers would not do: Chromium leaves them off the
// websocket handshake. Host and Origin pass unchanged, so the server's
// same-origin check holds.
let ipN = 0;
const run0 = Math.floor(Math.random() * 250);
export const nextIP = () => `10.${77 + Math.floor(ipN / 250)}.${run0}.${(ipN++ % 250) + 1}`;

export async function addressProxy(target) {
  const t = new URL(target);
  const realIP = req => /(?:^|;\s*)kjip=([\d.]+)/.exec(req.headers.cookie || '')?.[1] || req.headers['x-real-ip'] || '';
  const headers = req => {
    const out = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() !== 'x-real-ip') out.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
    }
    const ip = realIP(req);
    if (ip) out.push(['X-Real-IP', ip]);
    return out;
  };
  const srv = http.createServer((req, res) => {
    const up = http.request({ host: t.hostname, port: t.port, path: req.url, method: req.method, headers: Object.fromEntries(headers(req)) }, r => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  srv.on('upgrade', (req, sock, head) => {
    const up = net.connect(Number(t.port), t.hostname, () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers(req).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head?.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

// Gives the page's browser context an address of its own behind base (an
// addressProxy URL).
export async function ownAddress(P, base) {
  await P.page.setCookie({ name: 'kjip', value: nextIP(), url: base });
}

export async function connect(cdp) {
  const res = await fetch(cdp + '/json/version');
  const { webSocketDebuggerUrl } = await res.json();
  return puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl, defaultViewport: null, protocolTimeout: 120000 });
}

// For a script with a Chromium of its own: connects to the one on CDP
// port, after starting scripts/chrome there when none listens (one that
// listens is never replaced). stop() disconnects, and stops a Chromium
// started here; one that was started and did not come up is stopped too.
export async function ownBrowser(port) {
  const cdp = `http://127.0.0.1:${port}`;
  const listens = () => fetch(cdp + '/json/version').then(r => r.ok, () => false);
  const halt = () => { try { execFileSync('podman', ['stop', `kj-chrome-${port}`], { stdio: 'ignore' }); } catch { /* gone */ } };
  const started = !(await listens());
  if (started) {
    execFileSync(path.join(HERE, '../../scripts/chrome'), [String(port)], { stdio: ['ignore', 2, 2] });
    for (let i = 0; i < 100 && !(await listens()); i++) await sleep(200);
  }
  let browser;
  try { browser = await connect(cdp); } catch (e) {
    if (started) halt();
    throw new Error(`no Chromium on port ${port}: ${e.message || e}`);
  }
  const stop = async () => {
    await browser.disconnect().catch(() => {});
    if (started) halt();
  };
  return { browser, stop };
}

// Isolated page (own storage) with error collection.
export async function openPage(browser, vp, name, dpr = 0) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(dpr ? { ...vp, deviceScaleFactor: dpr } : vp);
  const errors = [];
  page.on('console', m => {
    if (m.type() === 'error') errors.push(`[${name}] console: ${m.text()}`);
  });
  page.on('pageerror', e => errors.push(`[${name}] pageerror: ${e.message}`));
  page.on('requestfailed', r => {
    if (!r.url().includes('/ws')) errors.push(`[${name}] request failed: ${r.url()} ${r.failure()?.errorText}`);
  });
  page.on('response', r => {
    if (r.status() >= 400) errors.push(`[${name}] HTTP ${r.status()} ${r.url()}`);
  });
  const P = { page, ctx, errors, vp, name, touch: !!vp.hasTouch };
  for (const f of hooks.page) await f(P);
  return P;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Tap (touch) or click (mouse) the centre of the first visible match.
export async function press(P, selector, { timeout = 15000 } = {}) {
  const el = await P.page.waitForSelector(selector, { visible: true, timeout });
  await scrollIntoView(el);
  const box = await el.boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 30);
  if (P.touch) await P.page.touchscreen.tap(x, y);
  else await P.page.mouse.click(x, y);
  return el;
}

// Scrolls like a user would when the target is outside the viewport.
async function scrollIntoView(el) {
  const moved = await el.evaluate(e => {
    const b = e.getBoundingClientRect();
    const x = b.left + b.width / 2;
    const y = b.top + Math.min(b.height / 2, 30);
    if (x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight) return false;
    e.scrollIntoView({ block: 'center', inline: 'center' });
    return true;
  });
  if (moved) await sleep(250);
}

// Taps a point of the element that is not covered by a sibling (overlapping hand cards).
export async function pressEl(P, el) {
  await scrollIntoView(el);
  const pt = await el.evaluate(e => {
    const b = e.getBoundingClientRect();
    for (let fy = 0.2; fy < 0.9; fy += 0.15) {
      for (let fx = 0.12; fx < 0.95; fx += 0.08) {
        const x = b.left + b.width * fx;
        const y = b.top + b.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === e || e.contains(hit))) return { x, y };
      }
    }
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  if (P.touch) await P.page.touchscreen.tap(pt.x, pt.y);
  else await P.page.mouse.click(pt.x, pt.y);
}

// For page.evaluateOnNewDocument, before the app: a hold on the server's
// messages, so a state stays on screen whatever the server's pace.
// kjHoldWhen(s, m) holds them from the first update (m, its state s) it is
// true for, that update still delivered; kjHeld() says whether they are
// held; kjRelease() delivers them, up to the update a new kjHoldWhen is
// true for. kjPatch(m) may change a message before the app gets it, and
// returns true when it did. kjSend(m) sends a message of the script's own
// over the app's socket (from kjHoldWhen: an answer that reaches the
// server before it plays on behind the hold), and what the app sends is
// kept in kjSent once the script made that an array.
export function holdHook() {
  const held = [];
  let hold = false;
  let sock = null;
  const deliver = (f, e) => {
    const m = (window.kjHoldWhen || window.kjPatch) && JSON.parse(e.data);
    if (m && window.kjPatch?.(m)) e = new MessageEvent('message', { data: JSON.stringify(m) });
    f(e);
    if (m?.t === 'update' && window.kjHoldWhen?.(m.s, m)) { hold = true; window.kjHoldWhen = null; }
  };
  window.kjHeld = () => hold;
  window.kjRelease = () => { hold = false; while (held.length && !hold) deliver(...held.shift()); };
  window.kjSend = m => sock?.send(JSON.stringify(m));
  window.WebSocket = class extends window.WebSocket {
    set onmessage(f) {
      sock = this;
      super.onmessage = f && (e => { if (hold) held.push([f, e]); else deliver(f, e); });
    }
    get onmessage() { return super.onmessage; }
    send(data) {
      if (typeof data === 'string') window.kjSent?.push(JSON.parse(data));
      super.send(data);
    }
  };
}

// With holdHook, from the script: holdEvent holds the server's messages
// from the update with an event of this type, held says whether they are
// held, and release delivers them.
export const holdEvent = (P, type) => P.page.evaluate(t => { window.kjHoldWhen = (s, m) => m.ev?.type === t; }, type);
export const held = P => P.page.evaluate(() => !!window.kjHeld?.());
export const release = P => P.page.evaluate(() => window.kjRelease?.());

// For page.evaluate, with holdHook: the hand summary's countdown, which the
// server leaves out for one person at the table, set by hand to the 12 s a
// table of more people has at tempo normaal. kjPatch = null ends it.
export function countdownPatch() {
  let at = 0;
  window.kjPatch = m => {
    if (m.t !== 'update' || m.s.phase !== 'handEnd' || m.s.nextAt) return false;
    m.s.nextAt = at ||= Date.now() + 12000;
    return true;
  };
}

export async function type(P, selector, text) {
  const el = await P.page.waitForSelector(selector, { visible: true });
  await el.evaluate(e => { e.focus(); e.select?.(); });
  await P.page.keyboard.type(text);
}

export async function shot(P, label) {
  for (const f of hooks.shot) await f(P, label);
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${P.name}-${label}.png`);
  for (let i = 0; ; i++) {
    try {
      await P.page.screenshot({ path: file, captureBeyondViewport: false });
      return file;
    } catch (e) {
      // Headless Chromium occasionally misses a frame; try again.
      if (i >= 4) throw e;
      await sleep(400);
    }
  }
}

// A screenshot with the overflow check, said on the console.
export async function snap(P, label) {
  await sleep(120);
  await shot(P, label);
  await checkOverflow(P, label);
  console.log(`  ${P.name}: ${label}`);
}

// Whether the page has an element for the selector, and whether it is drawn.
export const has = (P, sel) => P.page.evaluate(s => !!document.querySelector(s), sel);
export const shown = (P, sel) => P.page.evaluate(s => !!document.querySelector(s)?.getClientRects().length, sel);

// Closes the open dialog.
export async function closeModal(P) {
  await P.page.keyboard.press('Escape');
  await sleep(320);
}

// The game's manual where it shows: its modal, or on a wide screen at a
// table the side column's pane (docs/frontend.md#the-side-column).
export const MANUAL = ':is(.m-manual.open, .chat.manual .side-man)';

// Puts the manual away: its modal closed, or the side column back to Chat.
export async function closeManual(P) {
  if (!await shown(P, '.chat.manual .side-man')) return closeModal(P);
  await press(P, '#side-tab-chat');
  await waitFor(P, () => !document.querySelector('.chat.manual'), { label: 'the chat back in the side column' });
}

// For page.evaluate: the elements under the one for sel that reach past
// its right edge (at most five, as tag.class), but for those in a box that
// scrolls sideways on its own.
export function wideIn(sel) {
  const root = document.querySelector(sel);
  const edge = root.getBoundingClientRect().right;
  const inScroller = el => {
    for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
      if (['auto', 'scroll'].includes(getComputedStyle(p).overflowX)) return true;
    }
    return false;
  };
  const wide = [...root.querySelectorAll('*')]
    .filter(el => !inScroller(el) && el.getBoundingClientRect().right > edge + 1)
    .map(el => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 60));
  return [...new Set(wide)].slice(0, 5);
}

// Fails when the document scrolls sideways or an element sticks out.
export async function checkOverflow(P, label) {
  const r = await P.page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const bad = [];
    if (document.documentElement.scrollWidth > W + 1) bad.push(`document scrollWidth ${document.documentElement.scrollWidth} > ${W}`);
    for (const el of document.querySelectorAll('.screen:not([hidden]) *, .modal *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('#fly, .hand, .chat, .confetti, .tabs, .chat-quick')) continue;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      if (b.right > W + 2 || b.left < -2) {
        const scroller = el.closest('.tabs, .chat-quick, .dlg-body, .lobby-main, .screen-home');
        if (scroller && getComputedStyle(scroller).overflowX !== 'visible' && scroller !== el) {
          const sb = scroller.getBoundingClientRect();
          if (sb.right <= W + 2 && sb.left >= -2) continue;
        }
        bad.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} [${Math.round(b.left)}..${Math.round(b.right)}]`);
        if (bad.length > 5) break;
      }
    }
    return bad;
  });
  if (r.length) throw new Error(`[${P.name}] horizontal overflow at ${label}: ${r.join('; ')}`);
}

export async function waitFor(P, fn, { timeout = 30000, label = 'condition' } = {}, ...a) {
  let r;
  try {
    r = await P.page.waitForFunction(fn, { timeout, polling: 100 }, ...a);
  } catch (e) {
    throw new Error(`[${P.name}] timeout waiting for ${label}: ${e.message}\n  page: ${await diag(P)}`);
  }
  for (const f of hooks.wait) await f(P, label);
  return r;
}

// A one-line summary of what the page shows, for failure messages.
export async function diag(P) {
  try {
    return await P.page.evaluate(() => JSON.stringify({
      path: location.pathname,
      screen: document.body.dataset.screen,
      modals: [...document.querySelectorAll('#modals .modal')].map(m => m.className),
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent),
      rule: document.querySelector('.rule')?.textContent,
      hand: document.querySelectorAll('.hand .card').length,
      potje: document.querySelector('.potje-n')?.textContent,
      banner: !document.getElementById('net-banner')?.hidden,
    }));
  } catch (e) {
    return `unavailable (${e.message})`;
  }
}

// Plays one legal card from the hand: two taps on touch, one click with a mouse.
export async function playLegal(P, prefer = '') {
  const sel = prefer ? `.hand .card.legal[data-card="${prefer}"]` : '.hand .card.hint.legal, .hand .card.legal';
  const el = (await P.page.$(sel)) || (await P.page.$('.hand .card.legal'));
  if (!el) return false;
  const code = await el.evaluate(e => e.dataset.card);
  await pressEl(P, el);
  if (P.touch) {
    const tap = await P.page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('kj.prefs') || '{}').tap; } catch { return ''; }
    });
    if (tap !== 'one') {
      await sleep(350); // let the lift transition finish, like a human would
      const again = await P.page.$(`.hand .card.selected[data-card="${code}"]`);
      if (again) await pressEl(P, again);
    }
  }
  return code;
}

// One flow of a screens script on a page of its own: the viewport of this
// name, an address of its own, init and holdHook in the page before the
// app. Returns the page's errors, with a failure of fn among them and a
// screenshot of it.
export async function scenario(browser, name, base, fn, { label = name, dpr = 0, init } = {}) {
  const P = await openPage(browser, VIEWPORTS[name], label, dpr);
  await ownAddress(P, base);
  if (init) await P.page.evaluateOnNewDocument(init);
  await P.page.evaluateOnNewDocument(holdHook);
  try {
    await fn(P);
  } catch (e) {
    await shot(P, 'zz-failure').catch(() => {});
    P.errors.push(`[${label}] ${e.message || e}`);
  } finally {
    await P.ctx.close().catch(() => {});
  }
  return P.errors;
}

// The end of a screens script: each(browser, name), which gives the errors
// of one viewport, for every name on a connection of its own, one at a
// time or `--parallel N` at once (headless Chromium in its container has
// little shared memory). Returns the errors.
export async function perViewport(cdp, names, each) {
  const run = async name => {
    const browser = await connect(cdp);
    try {
      return await each(browser, name);
    } finally {
      await browser.disconnect();
    }
  };
  const parallel = Math.max(1, Number(process.argv[process.argv.indexOf('--parallel') + 1]) || 1);
  const errors = [];
  for (let i = 0; i < names.length; i += parallel) {
    errors.push(...(await Promise.all(names.slice(i, i + parallel).map(run))).flat());
  }
  return errors;
}

// Exits: 1 with the errors, or 0 after the line ok.
export function finish(errors, ok) {
  if (errors.length) {
    console.error('FAILED:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log(ok);
  process.exit(0); // an address proxy may still hold keep-alive connections
}
