// Opens the handleiding inside the real app (home screen → Handleiding), walks
// every tab and checks that the manual fits the help modal: no sideways scroll,
// tables fit their box without scrolling (down to a 320 px phone), cards drawn,
// quick links scroll inside the modal. Writes one screenshot per tab.
//
//   cd test/ui && node manual-app.mjs [OUTDIR]
//
// Serves web/ as the site root on 127.0.0.1:18121 (no game server needed) and
// starts scripts/chrome 9321 unless a browser already listens there.
// Env: CDP_PORT (9321), HTTP_PORT (18121). OUTDIR defaults to test/ui/out/manual-app.
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const webRoot = join(repo, 'web');
const out = process.argv[2] || join(repo, 'test/ui/out/manual-app');
const cdpPort = process.env.CDP_PORT || '9321';
const httpPort = Number(process.env.HTTP_PORT || 18121);
const VIEWPORTS = [
  { width: 320, height: 568, isMobile: true, hasTouch: true },
  { width: 360, height: 640, isMobile: true, hasTouch: true },
  { width: 375, height: 667, isMobile: true, hasTouch: true },
  { width: 390, height: 844, isMobile: true, hasTouch: true },
  { width: 1440, height: 900 },
];
mkdirSync(out, { recursive: true });

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.html': 'text/html' };

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/' || /^\/[A-Za-z]{4}$/.test(path)) path = '/index.html';
  const file = normalize(join(webRoot, path));
  if (!file.startsWith(webRoot)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': `${TYPES[extname(file)] || 'application/octet-stream'}; charset=utf-8` });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => server.listen(httpPort, '127.0.0.1', ok));

async function cdpEndpoint() {
  const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
  return (await r.json()).webSocketDebuggerUrl;
}

let startedChrome = false;
let endpoint;
try {
  endpoint = await cdpEndpoint();
} catch {
  execFileSync(join(repo, 'scripts/chrome'), [cdpPort], { stdio: 'inherit' });
  startedChrome = true;
  for (let i = 0; i < 50 && !endpoint; i++) {
    await new Promise((r) => setTimeout(r, 200));
    endpoint = await cdpEndpoint().catch(() => undefined);
  }
}

const problems = [];
const notes = [];
const browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
const page = await browser.newPage();
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  // The static server has no /ws; connection errors are expected here.
  if (m.type() === 'error' && !/WebSocket|\/ws|404/.test(m.text())) problems.push(`console: ${m.text()}`);
});

try {
  for (const vp of VIEWPORTS) {
    await page.setViewport({ ...vp, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${httpPort}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#btn-help', { visible: true, timeout: 5000 });
    await page.click('#btn-help');
    await page.waitForSelector('.man', { visible: true, timeout: 5000 });
    const tabs = await page.$$eval('[role="tab"][data-id]', (els) => els.map((e) => e.dataset.id));
    if (tabs.length !== 9) problems.push(`${vp.width}: expected 9 tabs, found ${tabs.length}`);

    for (const id of tabs) {
      await page.click(`[role="tab"][data-id="${id}"]`);
      await page.waitForSelector(`.man[data-section="${id}"]`, { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 350));
      const facts = await page.evaluate(() => {
        const man = document.querySelector('.man');
        const box = man.getBoundingClientRect();
        const inScroller = (el) => {
          for (let p = el.parentElement; p && p !== man; p = p.parentElement) {
            if (['auto', 'scroll'].includes(getComputedStyle(p).overflowX)) return true;
          }
          return false;
        };
        const wide = [...man.querySelectorAll('*')]
          .filter((el) => !inScroller(el) && el.getBoundingClientRect().right > box.right + 1)
          .map((el) => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 60));
        // A table may scroll inside its own box as a last resort, but nobody
        // expects that: every table has to fit the panel as it is.
        const tables = [...man.querySelectorAll('.man-tablewrap')]
          .filter((t) => t.scrollWidth > t.clientWidth + 1)
          .map((t) => `${t.className} ${t.scrollWidth}px in ${t.clientWidth}px`);
        const cards = [...man.querySelectorAll('.card')];
        let scroller = man.parentElement;
        while (scroller && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
        return {
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          manWidth: Math.round(box.width),
          wide: [...new Set(wide)].slice(0, 5),
          tables,
          blankCards: cards.filter((c) => c.getBoundingClientRect().width < 10 || !c.querySelector('svg')).length,
          cards: cards.length,
          textColor: getComputedStyle(man).color,
          scroller: scroller ? scroller.className : null,
          hasToc: !!man.querySelector('.man-toc'),
        };
      });
      const tag = `${id}@${vp.width}`;
      notes.push(`${tag}: panel ${facts.manWidth}px, ${facts.cards} cards, scroll box ${facts.scroller}`);
      if (facts.pageOverflow > 0) problems.push(`${tag}: page scrolls sideways by ${facts.pageOverflow}px`);
      if (facts.wide.length) problems.push(`${tag}: wider than the panel: ${facts.wide.join(', ')}`);
      if (facts.tables.length) problems.push(`${tag}: table scrolls sideways: ${facts.tables.join(', ')}`);
      if (facts.blankCards) problems.push(`${tag}: ${facts.blankCards} cards not drawn`);

      // Quick links must scroll the modal to the heading.
      if (facts.hasToc) {
        const moved = await page.evaluate(async () => {
          const btns = document.querySelectorAll('.man-toc-btn');
          const last = btns[btns.length - 1];
          const target = [...document.querySelectorAll('.man h3')].pop();
          last.click();
          await new Promise((r) => setTimeout(r, 900));
          // A short last section cannot reach the top; it must at least be in view.
          const top = target.getBoundingClientRect().top;
          return top >= -2 && top < window.innerHeight - 40;
        });
        if (!moved) problems.push(`${tag}: quick link did not scroll to its heading`);
        await page.evaluate(() => document.querySelector('.man').scrollIntoView({ block: 'start' }));
      }
      await page.screenshot({ path: join(out, `app-${id}-${vp.width}.png`) });
    }
    await page.keyboard.press('Escape');
  }
} finally {
  await page.close();
  await browser.disconnect();
  server.close();
  if (startedChrome) execFileSync('podman', ['stop', `kj-chrome-${cdpPort}`], { stdio: 'ignore' });
}

console.log(notes.join('\n'));
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`ok, screenshots in ${out}`);
