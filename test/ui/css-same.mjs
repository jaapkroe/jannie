// Checks that a change of stylesheets changes nothing on screen. It rides
// along with a browser check (app-screens.mjs, toepen-screens.mjs,
// app-checks.mjs): at every screenshot it computes the style of every
// element, its ::before and ::after (and ::marker, ::placeholder and
// ::-webkit-scrollbar where they apply), first under the site's stylesheets
// as served, then, in the same synchronous step so no frame passes, under
// the stylesheets that the site's index.html linked at git revision --base.
// It reports every difference: the element, the property, the value at
// --base and the value now. Each element's box (getBoundingClientRect) is
// compared too.
//
// Left out, as Chromium may report stale values even when nothing changed
// (a closed <details>, an auto margin): the sizes and offsets of elements
// not drawn, and the margins and offsets of an element whose box stays in
// place. Listed apart, without failing the run: differences in a property
// an animation of the element moves (both passes see the same moment of it,
// but an animation yet to start can show another frame). Compared with a
// --base of the same stylesheets, a run reports nothing else.
//
//   cd test/ui && node css-same.mjs --base main app-screens.mjs --url ... --cdp ...
//   node css-same.mjs --base main --waits app-checks.mjs --only lessons --url ... --cdp ...
//
// --base REV   the revision to compare with (default main), with the game's
//              web/ and platform/web. A game of the overlay, extra/, has its
//              own files at REV of the overlay's repository, so name a
//              revision both repositories have (a branch of that name).
// --waits      compare also at every condition waitFor sees come true
//              (app-checks.mjs takes screenshots only on failure).
// --report F   write every difference as JSON to F.
// The other flags go to the check. Exits 1 on a difference, or as the check
// does. The pages bypass the CSP, which would refuse the inline <style>.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hooks } from './app-lib.mjs';
import { GAMES, gameDir, siteDir, siteFile } from './site.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const argv = process.argv.slice(2);
const flag = (name, def) => (argv.includes('--' + name) ? argv[argv.indexOf('--' + name) + 1] : def);
const BASE = flag('base', 'main');
const REPORT = flag('report', '');
const check = argv.find(a => a.endsWith('.mjs'));
if (!check) {
  console.error('usage: node css-same.mjs [--base REV] [--waits] [--report FILE] CHECK.mjs [its flags]');
  process.exit(2);
}

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
const sheets = html => [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]);

// Per game: the stylesheets its index.html links now, and those it linked
// at BASE with their text then.
const SITES = GAMES.map(game => {
  const now = sheets(fs.readFileSync(path.join(siteDir(game), 'index.html'), 'utf8'));
  // The game's web/ at BASE: in this repository, or in the overlay's.
  const overlay = path.relative(ROOT, gameDir(game)).split(path.sep)[0] === 'extra';
  const own = overlay
    ? ['-C', 'extra', 'show', `${BASE}:${game}/web`]
    : ['show', `${BASE}:games/${game}/web`];
  let html;
  try {
    html = git(...own.slice(0, -1), own.at(-1) + '/index.html');
  } catch {
    return { game, overlay, now: now.join(' '), then: null, custom: [] }; // a site new since BASE
  }
  const then = sheets(html).map(href => {
    for (const tree of [own, ['show', `${BASE}:platform/web`]]) {
      try {
        return { href, text: git(...tree.slice(0, -1), tree.at(-1) + href) };
      } catch { /* not in this tree */ }
    }
    throw new Error(`${href} of ${game} is not at ${BASE}`);
  });
  const texts = [...then.map(s => s.text), ...now.map(href => fs.readFileSync(siteFile(game, href), 'utf8'))];
  // Custom properties are not listed by getComputedStyle; ask for them by name.
  const custom = [...new Set(texts.flatMap(t => [...t.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1])))].sort();
  return { game, now: now.join(' '), then, custom };
});

// Runs in the page: the styles under the sheets served, then under the old
// ones, the differences, and what the swap set moving (a transition starts
// where a value changed; its first frame shows the old value, so it is
// reported too). Everything is put back as it was.
function compareInPage(oldTexts, custom) {
  const t0 = performance.now();
  const els = [document.documentElement, document.body, ...document.body.querySelectorAll('*')];
  const names = Array.from(getComputedStyle(document.documentElement));
  const shows = v => v !== 'none' && v !== 'normal';
  const pseudos = el => {
    const out = ['::before', '::after'];
    if (el.localName === 'input' || el.localName === 'textarea') out.push('::placeholder');
    if (el.localName === 'li' || el.localName === 'summary') out.push('::marker');
    const cs = getComputedStyle(el);
    if (/auto|scroll/.test(cs.overflowX + cs.overflowY)) out.push('::-webkit-scrollbar');
    return out;
  };
  const kinds = els.map(el => ['', ...pseudos(el)]);
  // An element not drawn (display: none, or in a closed <details>, whose
  // content Chromium skips) has no layout of its own: its sizes and offsets
  // may be left over from before, or 0. Those are not compared.
  const drawn = els.map(el => el.checkVisibility());
  const LAYOUT = /^(box|width|height|inline-size|block-size|top|right|bottom|left|inset-.*|margin-.*|padding-.*|perspective-origin|transform-origin|grid-template-(columns|rows))$/;
  // Where an element is drawn: its box is compared too. Chromium sometimes
  // reports an auto margin from an earlier layout (0 in a flex item that
  // has it); with the box in place such a margin or offset is left out.
  const OFFSET = /^(top|right|bottom|left|inset-.*|margin-.*)$/;
  const box = el => {
    const r = el.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].map(n => Math.round(n * 100) / 100).join(' ');
  };
  const values = cs => {
    const v = new Array(names.length + custom.length);
    for (let k = 0; k < names.length; k++) v[k] = cs.getPropertyValue(names[k]);
    for (let k = 0; k < custom.length; k++) v[names.length + k] = cs.getPropertyValue(custom[k]).trim();
    return v;
  };
  // A ::before or ::after without content draws nothing: only its content
  // counts, unless the other pass draws it.
  const snap = prev => (void document.documentElement.offsetWidth, els.map((el, i) => kinds[i].map((ps, p) => {
    const cs = getComputedStyle(el, ps || null);
    if (ps === '::before' || ps === '::after') {
      const content = cs.getPropertyValue('content');
      if (!shows(content) && !(prev && prev[i][p].length > 1)) return [content];
    }
    const v = values(cs);
    if (!ps) v.push(box(el));
    return v;
  })));

  const camel = prop => prop.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
  const before = snap(null);
  const anims = new Set(document.getAnimations());
  const links = [...document.querySelectorAll('link[rel="stylesheet"]')].filter(l => l.sheet && !l.sheet.disabled);
  const styles = [];
  let after;
  let applied;
  let started;
  try {
    for (const l of links) l.sheet.disabled = true;
    for (const t of oldTexts) {
      const s = document.createElement('style');
      s.textContent = t;
      document.head.append(s);
      styles.push(s);
    }
    applied = styles.every(s => s.sheet && s.sheet.cssRules.length > 0);
    after = snap(before);
    // A transition from the value now to the one then, or an animation.
    started = document.getAnimations().filter(a => !anims.has(a)).map(a => {
      const kf = a.effect?.getKeyframes() || [];
      const prop = a.transitionProperty || '';
      const val = k => (prop ? k?.[camel(prop)] : JSON.stringify(k || {}));
      return { a, kind: a.constructor.name, what: prop || a.animationName || '', then: val(kf.at(-1)), now: val(kf[0]) };
    });
  } finally {
    for (const s of styles) s.remove();
    for (const l of links) l.sheet.disabled = false;
    void document.documentElement.offsetWidth;
    for (const a of document.getAnimations()) if (!anims.has(a)) a.cancel();
  }

  const where = el => {
    const parts = [];
    for (let e = el; e; e = e.parentElement) {
      let s = e.localName + (e.id ? '#' + e.id : '') + [...e.classList].slice(0, 4).map(c => '.' + c).join('');
      const same = e.parentElement ? [...e.parentElement.children].filter(c => c.localName === e.localName) : [];
      if (same.length > 1 && !e.id) s += `:nth-of-type(${same.indexOf(e) + 1})`;
      parts.unshift(s);
      if (e.id) break;
    }
    return parts.join(' > ');
  };
  const animated = (el, ps) => {
    const props = new Set();
    for (const a of document.getAnimations()) {
      const fx = a.effect;
      if (!fx || fx.target !== el || (fx.pseudoElement || '') !== ps) continue;
      for (const kf of fx.getKeyframes()) {
        for (const k of Object.keys(kf)) props.add(k.replace(/[A-Z]/g, m => '-' + m.toLowerCase()));
      }
    }
    return props;
  };
  const moves = el => {
    for (let e = el; e; e = e.parentElement) if (e.getAnimations().length) return true;
    return false;
  };
  const all = [...names, ...custom, 'box'];
  const diffs = [];
  let skipped = 0;
  for (let i = 0; i < els.length && diffs.length < 3000; i++) {
    for (let p = 0; p < kinds[i].length; p++) {
      const a = before[i][p];
      const b = after[i][p];
      const ps = kinds[i][p];
      let moving = null;
      const one = (prop, then, now) => {
        if (!drawn[i] && LAYOUT.test(prop)) { skipped++; return; }
        if (!ps && OFFSET.test(prop) && a.at(-1) === b.at(-1)) { skipped++; return; }
        moving ||= animated(els[i], ps);
        // A box moves with an animation of the element or one around it.
        const anim = prop === 'box' ? moves(els[i]) : moving.has(prop);
        diffs.push({ el: where(els[i]) + ps, prop, then, now, animated: anim });
      };
      // One pass drew the pseudo-element and the other did not: its content differs.
      const content = v => (v.length > 1 ? v[all.indexOf('content')] : v[0]);
      if (a.length !== b.length) one('content', content(b), content(a));
      else for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) one(a.length === 1 ? 'content' : all[k], b[k], a[k]);
    }
  }
  const moved = started.map(({ a, ...m }) => ({ el: (a.effect?.target ? where(a.effect.target) : '?') + (a.effect?.pseudoElement || ''), ...m }));
  return { els: els.length, applied, diffs, moved, skipped, ms: Math.round(performance.now() - t0) };
}

const results = [];
let states = 0;
let elements = 0;
let skipped = 0;
const problems = [];

async function compare(P, label) {
  try {
    if (P.page.isClosed()) return;
    const now = await P.page.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.getAttribute('href')).join(' '));
    const site = SITES.find(s => s.now === now);
    if (!site) throw new Error(`no game's index.html links ${now}`);
    if (!site.then) throw new Error(`${site.game} has no site at ${BASE}${site.overlay ? " of the overlay's repository" : ''}`);
    const r = await P.page.evaluate(compareInPage, site.then.map(s => s.text), site.custom);
    if (!r.applied) throw new Error(`the sheets of ${BASE} did not apply (the CSP?)`);
    states++;
    elements += r.els;
    if (r.diffs.length || r.moved.length) results.push({ page: P.name, label, game: site.game, diffs: r.diffs, moved: r.moved });
    skipped += r.skipped;
    console.log(`  css-same ${P.name} ${label}: ${r.els} elements, ${r.diffs.length} differences, ${r.moved.length} moving${r.skipped ? `, ${r.skipped} layout values left out` : ''} (${r.ms} ms)`);
  } catch (e) {
    if (/Target closed|Session closed|detached|Execution context was destroyed/.test(e.message)) return;
    problems.push(`[${P.name}] ${label}: ${e.message}`);
  }
}

hooks.page.push(P => P.page.setBypassCSP(true));
hooks.shot.push((P, label) => (label === 'zz-failure' ? null : compare(P, label)));
if (argv.includes('--waits')) hooks.wait.push((P, label) => compare(P, `wait ${label}`));

process.on('exit', () => {
  const lines = [];
  let failed = 0;
  let animated = 0;
  for (const r of results) {
    const plain = r.diffs.filter(d => !d.animated);
    const moving = r.diffs.filter(d => d.animated);
    if (plain.length || r.moved.length) failed++;
    animated += moving.length;
    lines.push(`${r.game} ${r.page} ${r.label}:`);
    for (const d of plain.slice(0, 40)) lines.push(`  ${d.el} ${d.prop}: ${d.then} -> ${d.now}`);
    if (plain.length > 40) lines.push(`  ... ${plain.length - 40} more`);
    for (const m of r.moved) lines.push(`  ${m.el} ${m.what} (${m.kind} started by the swap): ${m.then} -> ${m.now}`);
    for (const d of moving.slice(0, 20)) lines.push(`  animated: ${d.el} ${d.prop}: ${d.then} -> ${d.now}`);
    if (moving.length > 20) lines.push(`  animated: ... ${moving.length - 20} more`);
  }
  if (REPORT) fs.writeFileSync(REPORT, JSON.stringify({ base: BASE, states, elements, skipped, results, problems }, null, 1));
  console.log(`css-same: ${states} states, ${elements} elements compared with ${BASE}; ${failed} states differ` +
    (animated ? `; ${animated} differences in animated properties` : '') +
    (skipped ? `; ${skipped} layout values left out (elements not drawn, boxes in place)` : ''));
  if (lines.length) console.log(lines.join('\n'));
  if (problems.length) console.log('css-same problems:\n' + problems.join('\n'));
  if (failed || problems.length || !states) process.exitCode = 1;
});

await import(pathToFileURL(path.resolve(HERE, check)).href);
