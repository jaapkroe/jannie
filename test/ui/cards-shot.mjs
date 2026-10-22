// Checks the card module in headless Chromium (contract, sizes, faces at narrow
// widths, inks, caching, speed) and screenshots the gallery for visual review.
//
//   scripts/chrome 9311
//   python3 -m http.server 18110 --bind 127.0.0.1   (from the repo root)
//   cd test/ui && node cards-shot.mjs OUTDIR
//
// Env: CDP_PORT (9311), GALLERY_URL (http://127.0.0.1:18110/test/ui/cards-gallery.html).
// Writes OUTDIR/cards-dsf<1|3>-<nn>.png, one per gallery section.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const out = process.argv[2] || join(tmpdir(), 'kj-cards');
const cdp = process.env.CDP_PORT || '9311';
const url = process.env.GALLERY_URL || 'http://127.0.0.1:18110/test/ui/cards-gallery.html';
mkdirSync(out, { recursive: true });

const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${cdp}/json/version`)).json();
const browser = await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl });
const page = await browser.newPage();
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  else if (process.env.VERBOSE) console.log(`page: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));

try {
  await page.setCacheEnabled(false);
  await page.setViewport({ width: 1320, height: 900, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 5000 });

  problems.push(...await page.evaluate(async () => {
    const bad = [];
    const expect = (ok, msg) => { if (!ok) bad.push(msg); };
    const mod = await import('/web/js/cards.js');
    const { createCard, createBack, suitIcon } = mod;

    const faces = [...document.querySelectorAll('#gallery .card:not(.back)')];
    expect(new Set(faces.map((c) => c.dataset.card)).size === 32, 'gallery lacks some of the 32 cards');
    expect(faces.every((c) => c.getAttribute('role') === 'img' && c.getAttribute('aria-label')), 'card without role/aria-label');
    expect(!document.querySelector('.card [style], .card style, .card [id]'), 'style attribute, <style> or id inside a card');

    // clones: equal markup, distinct nodes, size class per clone
    const a = createCard('JH');
    const b = createCard('JH', { size: 'lg' });
    expect(a !== b && a.firstChild !== b.firstChild, 'createCard returned a shared node');
    expect(a.querySelector('svg').outerHTML === b.querySelector('svg').outerHTML, 'clones differ');
    expect(a.classList.contains('card-md') && b.classList.contains('card-lg') && !b.classList.contains('card-md'), 'size classes wrong');
    expect(a.dataset.card === 'JH' && a.getAttribute('aria-label') === 'harten boer', 'JH dataset/aria-label wrong');
    let threw = false;
    try { createCard('1X'); } catch { threw = true; }
    expect(threw, 'createCard accepted an invalid code');
    const back = createBack({ color: 'red', size: 'sm' });
    expect(back.matches('.card.back.card-sm[data-back="red"]') && back.getAttribute('aria-label') === 'dichte kaart', 'back attributes wrong');
    expect(suitIcon('H', { colored: true }).matches('svg.suit-icon.suit-ink[data-suit="H"]'), 'suitIcon markup wrong');

    // layout: --card-w drives size; at every width a face shows its picture and
    // both corner indices, apart, the index bigger on narrow cards unless
    // --card-index-max caps it; inks per suit and four-colour mode
    const box = document.createElement('div');
    document.body.append(box);
    const at = (w, code, cls) => {
      const c = createCard(code);
      const holder = document.createElement('div');
      if (cls) holder.className = cls;
      holder.style.setProperty('--card-w', `${w}px`);
      holder.append(c);
      box.append(holder);
      return c;
    };
    const c90 = at(90, 'QS');
    const r = c90.getBoundingClientRect();
    expect(Math.round(r.width) === 90 && Math.round(r.height) === 126, `90 px card measures ${r.width}x${r.height}`);
    const scale = (c, sel) => new DOMMatrixReadOnly(getComputedStyle(c.querySelector(sel)).transform).a;
    // The boxes a group's ink covers: each shape's box (which leaves out its
    // stroke) grown by half its stroke width on screen; and their union.
    const inkBoxes = (g) => [...g.querySelectorAll('path, rect, circle, ellipse')].map((s) => {
      const r = s.getBoundingClientRect();
      const m = s.getScreenCTM();
      const half = (s.getAttribute('stroke') ? (Number(s.getAttribute('stroke-width')) || 1) / 2 : 0) * Math.hypot(m.a, m.b);
      return { left: r.left - half, top: r.top - half, right: r.right + half, bottom: r.bottom + half, width: r.width + 2 * half };
    });
    const union = (bs) => {
      const b = { left: Math.min(...bs.map((x) => x.left)), top: Math.min(...bs.map((x) => x.top)), right: Math.max(...bs.map((x) => x.right)), bottom: Math.max(...bs.map((x) => x.bottom)) };
      return { ...b, width: b.right - b.left };
    };
    // An index's box clear of the picture's box, or of the circle in the ace's.
    const apart = (a, b, round) => {
      if (!round) return a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
      const cx = (b.left + b.right) / 2;
      const cy = (b.top + b.bottom) / 2;
      return Math.hypot(Math.max(a.left - cx, 0, cx - a.right), Math.max(a.top - cy, 0, cy - a.bottom)) >= b.width / 2;
    };
    // An index in the card's top-left (end 0) or bottom-right (end 1) corner:
    // inside the card and its own half, its outer corner at most a tenth of
    // the card's width from the card's, and inside the rounding (0.075 × width).
    const inCorner = (b, card, end) => {
      const cx = (card.left + card.right) / 2;
      const inside = b.left >= card.left && b.top >= card.top && b.right <= card.right && b.bottom <= card.bottom && (end ? b.left >= cx : b.right <= cx);
      const gx = end ? card.right - b.right : b.left - card.left;
      const gy = end ? card.bottom - b.bottom : b.top - card.top;
      const tenth = card.width * 0.1;
      const r = card.width * 0.075;
      return inside && gx <= tenth && gy <= tenth && (gx >= r || gy >= r || Math.hypot(r - gx, r - gy) <= r);
    };
    const codes = Object.keys(mod.SUITS).flatMap((s) => Object.keys(mod.RANKS).map((rank) => rank + s));
    // The index steps up below 60, 40 and 30 px: 59.95 px is already a step up.
    for (const [w, want] of [[20, 1.6], [29.95, 1.6], [30, 1.4], [39.95, 1.4], [40, 1.25], [59.95, 1.25], [60, 1], [116, 1]]) {
      for (const code of codes) {
        const c = at(w, code);
        const art = union(inkBoxes(c.querySelector('.card-pips, .card-ace, .card-court')));
        const idx = [...c.querySelectorAll('.card-index')].map(inkBoxes);
        expect(art.width > 0 && idx.length === 2 && idx.every((bs) => bs.length === 2 && bs.every((b) => b.width > 0)), `${code} at ${w} px lacks its picture or an index`);
        expect(idx.flat().every((b) => apart(b, art, code[0] === 'A')), `${code} at ${w} px: an index touches the picture`);
        const card = c.getBoundingClientRect();
        expect(idx.every((bs, end) => inCorner(union(bs), card, end)), `${code} at ${w} px: an index is not in its corner`);
        expect(scale(c, '.card-index > g') === want, `${code} at ${w} px: index scale ${scale(c, '.card-index > g')}, want ${want}`);
      }
    }
    const capped = at(46, 'KH');
    capped.parentElement.style.setProperty('--card-index-max', '1');
    expect(scale(capped, '.card-index > g') === 1 && scale(capped, '.card-court') === 1, '--card-index-max: 1 does not keep the regular face');
    const ink = (c) => getComputedStyle(c).color;
    expect(ink(at(90, 'AH')) === 'rgb(178, 16, 43)', 'harten not deep red');
    expect(ink(at(90, 'AC')) === 'rgb(23, 23, 28)', 'klaveren not near-black');
    expect(ink(at(90, 'AC', 'four-color')) === 'rgb(19, 129, 59)', 'four-colour klaveren not green');
    expect(ink(at(90, 'AD', 'four-color')) === 'rgb(21, 87, 192)', 'four-colour ruiten not blue');
    expect(ink(at(90, 'AS', 'four-color')) === 'rgb(23, 23, 28)', 'four-colour schoppen changed');
    const dis = at(90, '7C');
    dis.classList.add('disabled');
    expect(getComputedStyle(dis).filter !== 'none', '.disabled has no filter');
    const sel = at(90, '7C');
    sel.classList.add('selected');
    expect(getComputedStyle(sel).translate !== 'none', '.selected is not lifted');
    box.remove();

    // cloning cost: 1000 faces
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) createCard(['7H', 'JS', 'AD', 'KC'][i % 4]);
    const ms = performance.now() - t0;
    console.log(`1000 createCard calls: ${ms.toFixed(1)} ms`);
    expect(ms < 400, `createCard too slow: ${ms} ms per 1000`);
    return bad;
  }));

  // Pointer hover lifts a legal card. Headless Chromium has no pointer, so the
  // rules inside the hover media query are applied with :hover swapped for a class.
  const hover = await page.evaluate(() => {
    const rules = [...document.styleSheets].flatMap((ss) => [...ss.cssRules]);
    const media = rules.find((r) => r instanceof CSSMediaRule && r.conditionText.includes('hover: hover'));
    if (!media) return 'no hover media rule';
    const st = document.createElement('style');
    st.textContent = [...media.cssRules].map((r) => r.cssText.replaceAll(':hover', '.hover-probe')).join('\n');
    document.head.append(st);
    const box = document.querySelector('.states');
    const probe = (cls) => {
      const c = box.querySelector('.card').cloneNode(true);
      c.className = `card card-md hover-probe ${cls}`;
      box.append(c);
      const t = getComputedStyle(c).translate;
      c.remove();
      return t;
    };
    const res = { legal: probe('legal'), plain: probe(''), disabled: probe('legal disabled') };
    st.remove();
    return res.legal !== 'none' && res.plain === 'none' && res.disabled === 'none' ? '' : JSON.stringify(res);
  });
  if (hover) problems.push(`hover feedback wrong: ${hover}`);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const reduced = await page.evaluate(() => {
    const c = document.querySelector('.states .card.hint');
    return { anim: getComputedStyle(c, '::after').animationName, dur: getComputedStyle(c).transitionDuration };
  });
  if (reduced.anim !== 'none' || !reduced.dur.split(',').every((d) => parseFloat(d) < 0.001)) {
    problems.push(`reduced motion not honoured: ${JSON.stringify(reduced)}`);
  }
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  console.log(problems.length ? `${problems.length} problems` : 'checks passed');

  // One shot per section, kept inside a small viewport: larger captures
  // crash the GPU process of the containerised Chromium (64 MB /dev/shm).
  let n = 0;
  for (const [dsf, width, height] of [[1, 1320, 900], [3, 720, 560]]) {
    await page.setViewport({ width, height, deviceScaleFactor: dsf });
    const boxes = await page.$$eval('section', (els) => els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
    }));
    for (let i = 0; i < boxes.length; i++) {
      const clip = { ...boxes[i] };
      clip.width = Math.min(clip.width, width - clip.x);
      clip.height = Math.min(clip.height, height);
      await page.evaluate((y) => window.scrollTo(0, y), clip.y);
      await page.screenshot({ path: join(out, `cards-dsf${dsf}-${String(i).padStart(2, '0')}.png`), clip });
      n++;
      if (process.env.VERBOSE) console.log(`dsf ${dsf} section ${i}`);
    }
  }
  console.log(`wrote ${n} screenshots to ${out}`);
} finally {
  await page.close();
  await browser.disconnect();
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
