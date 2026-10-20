// Shared helpers for the app browser checks (app-screens.mjs, app-play.mjs,
// app-checks.mjs): connect to scripts/chrome, give every page an address of
// its own, open isolated pages per viewport, collect errors, tap like a
// finger or click like a mouse, and save screenshots.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');

export const VIEWPORTS = {
  phone: { width: 360, height: 640, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
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
    url: get('url', 'http://127.0.0.1:18100'),
    cdp: get('cdp', 'http://127.0.0.1:9301'),
    only: get('only', ''),
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
  return { page, ctx, errors, vp, name, touch: !!vp.hasTouch };
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

export async function type(P, selector, text) {
  const el = await P.page.waitForSelector(selector, { visible: true });
  await el.evaluate(e => { e.focus(); e.select?.(); });
  await P.page.keyboard.type(text);
}

export async function shot(P, label) {
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
  try {
    return await P.page.waitForFunction(fn, { timeout, polling: 100 }, ...a);
  } catch (e) {
    throw new Error(`[${P.name}] timeout waiting for ${label}: ${e.message}\n  page: ${await diag(P)}`);
  }
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
