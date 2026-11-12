// Renders every handleiding section in a mock of the dark help modal, checks the
// layout (no horizontal overflow, tables fit without scrolling, cards drawn, no
// script errors) and writes viewport-sized screenshots at phone and desktop size.
//
//   cd test/ui && node manual-shot.mjs [OUTDIR]
//
// Serves klaverjas's site on 127.0.0.1:18120 and starts scripts/chrome 9321
// unless a browser already listens there (then it is left running).
// Env: CDP_PORT (9321), HTTP_PORT (18120), DSF (device scale factor, 1),
//      SECTIONS (comma list, default all), FOUR=1 (four-colour deck).
// Writes OUTDIR/manual-<section>-<width>-<nn>.png; OUTDIR defaults to test/ui/out/manual.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownBrowser, wideIn } from './app-lib.mjs';
import { serveSite } from './site.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const out = process.argv[2] || join(repo, 'test/ui/out/manual');
const dsf = Number(process.env.DSF || 1);
const four = process.env.FOUR === '1';
const VIEWPORTS = [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 1440, height: 900 }];
mkdirSync(out, { recursive: true });

// Mock of the help modal: dark translucent panel over the green felt.
const HARNESS = `<!doctype html>
<html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Handleiding</title>
<link rel="stylesheet" href="/css/klaverjas.css">
<link rel="stylesheet" href="/css/cards.css">
<style>
  html, body { margin: 0; }
  body { min-height: 100vh; background: radial-gradient(ellipse at 50% 40%, #237a4f 0%, #145236 55%, #0b2d1e 100%) fixed;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .modal { box-sizing: border-box; min-height: 100vh; padding: 16px; color: #eef3ef;
    background: rgba(10, 18, 16, 0.86); backdrop-filter: blur(12px); }
  @media (min-width: 700px) {
    .modal { width: min(52rem, 100% - 64px); min-height: 0; margin: 32px auto; padding: 24px 28px;
      border: 1px solid rgba(255,255,255,.12); border-radius: 18px; box-shadow: 0 24px 60px rgba(0,0,0,.5); }
  }
  h2 { margin: 0 0 12px; font-size: 1.35rem; }
  .tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 18px; }
  .tabs span { padding: 6px 10px; border-radius: 999px; background: rgba(255,255,255,.08); color: #cfe; font-size: .85rem; }
  .tabs span.on { background: #f3c969; color: #222; }
</style>
<script type="module">
  import { SECTIONS, renderManual } from '/js/manual.js';
  const id = new URLSearchParams(location.search).get('s');
  const modal = document.createElement('div');
  modal.className = 'modal';
  const title = document.createElement('h2');
  title.textContent = SECTIONS.find((s) => s.id === id).title;
  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  for (const s of SECTIONS) {
    const t = document.createElement('span');
    t.textContent = s.title;
    if (s.id === id) t.className = 'on';
    tabs.append(t);
  }
  modal.append(title, tabs, renderManual(id));
  document.body.append(modal);
  if (new URLSearchParams(location.search).get('four') === '1') document.body.classList.add('four-color');
  document.body.dataset.ready = '1';
</script>
</head><body></body></html>`;

// The manual is klaverjas's.
const server = await serveSite('klaverjas', Number(process.env.HTTP_PORT || 18120), { '/__manual.html': HARNESS });
const { browser, stop } = await ownBrowser(process.env.CDP_PORT || '9321');

const problems = [];
const notes = [];
let shots = 0;
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));

try {
  await page.goto(`${server.url}/__manual.html?s=bediening`, { waitUntil: 'networkidle0' });
  const ids = process.env.SECTIONS
    ? process.env.SECTIONS.split(',')
    : await page.evaluate(async () => (await import('/js/manual.js')).SECTIONS.map((s) => s.id));

  for (const vp of VIEWPORTS) {
    await page.setViewport({ ...vp, deviceScaleFactor: dsf });
    for (const id of ids) {
      await page.goto(`${server.url}/__manual.html?s=${id}${four ? '&four=1' : ''}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('body[data-ready="1"]', { timeout: 5000 });
      const facts = await page.evaluate(() => {
        const man = document.querySelector('.man');
        const cards = [...man.querySelectorAll('.card')];
        return {
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          tableScroll: [...man.querySelectorAll('.man-tablewrap')].filter((t) => t.scrollWidth > t.clientWidth + 1).length,
          cards: cards.length,
          blankCards: cards.filter((c) => c.getBoundingClientRect().width < 10 || !c.querySelector('svg')).length,
          cardWidth: cards.length ? Math.round(cards[0].getBoundingClientRect().width) : 0,
          smallText: [...man.querySelectorAll('p, li, dd, td, th, figcaption')]
            .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 11.5).length,
          height: document.documentElement.scrollHeight,
        };
      });
      // Overflow is fine inside a box that scrolls on its own (quick links); tables
      // have such a box too, but are checked separately: they must fit as they are.
      facts.wide = await page.evaluate(wideIn, '.man');
      const tag = `${id}@${vp.width}`;
      notes.push(`${tag}: ${facts.cards} cards (${facts.cardWidth}px), height ${facts.height}px`);
      if (facts.pageOverflow > 0) problems.push(`${tag}: page scrolls sideways by ${facts.pageOverflow}px`);
      if (facts.wide.length) problems.push(`${tag}: wider than the panel: ${facts.wide.join(', ')}`);
      if (facts.tableScroll) problems.push(`${tag}: ${facts.tableScroll} table(s) scroll sideways`);
      if (facts.blankCards) problems.push(`${tag}: ${facts.blankCards} cards not drawn`);
      if (facts.smallText) problems.push(`${tag}: ${facts.smallText} text elements below 11.5px`);

      // Viewport-sized shots: full-page captures crash the containerised Chromium.
      for (let y = 0, n = 0; y < facts.height; y += vp.height, n++) {
        await page.evaluate((top) => window.scrollTo(0, top), y);
        await page.screenshot({ path: join(out, `manual-${id}-${vp.width}-${String(n).padStart(2, '0')}.png`) });
        shots++;
      }
    }
  }
} finally {
  await page.close();
  server.close();
  await stop();
}

console.log(notes.join('\n'));
console.log(`wrote ${shots} screenshots to ${out}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
