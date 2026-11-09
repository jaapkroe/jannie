// One site per game (docs/frontend.md#one-site-per-game,
// docs/architecture.md#one-site-per-game): each game's site is the union of
// platform/web (the shell) and the web/ of the game's folder, games/<game>
// or extra/<game> (docs/adding-a-game.md#the-folder). Checks, for every site:
//   - the two trees share no path (no file of the shell is replaced);
//   - a page load stays within 17 requests, which a rate limit in front of
//     the site must let through at once, and
//     every module main.js imports statically is preloaded, and every one
//     they import when first needed is on the site, with what it imports;
//   - the shell reaches the game only through main.js importing ./game.js;
//   - nothing a player sees names another game.
//   node --test test/sites.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SHELL, GAMES, facts, siteDir, siteFile, treeFiles } from './ui/site.mjs';

const SHARED = SHELL;
const read = f => fs.readFileSync(f, 'utf8');

test('there are sites, and klaverjas is one of them', () => {
  assert.ok(GAMES.includes('klaverjas'), GAMES.join());
  assert.ok(GAMES.length >= 2, GAMES.join());
});

// The modules a module imports statically (import … from / export … from),
// as site paths.
function staticImports(file) {
  const src = read(file);
  return [...src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+'(\.\/[\w.-]+\.js)'/gm)].map(m => m[1].slice(2));
}

// The modules a module imports when first needed (import('./x.js')).
function dynamicImports(file) {
  return [...read(file).matchAll(/\bimport\(\s*'(\.\/[\w.-]+\.js)'\s*\)/g)].map(m => m[1].slice(2));
}

// User-visible text of a file: string literals of JS, the text of HTML and
// the manifest. Comments are not shown to anyone.
function visibleText(file) {
  const src = read(file);
  if (file.endsWith('.js')) {
    const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
    return [...noComments.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map(m => m[0]).join('\n');
  }
  if (file.endsWith('.html')) return src.replace(/<!--[\s\S]*?-->/g, '');
  if (file.endsWith('.webmanifest')) return src;
  return '';
}

for (const game of GAMES) {
  const dir = siteDir(game);

  test(`${game}: its tree and the shell's share no path`, () => {
    const shared = new Set(treeFiles(SHARED));
    const both = treeFiles(dir).filter(f => shared.has(f));
    assert.deepEqual(both, [], 'a path in platform/web and in the game\'s tree');
  });

  test(`${game}: a page load stays within 17 requests`, () => {
    const html = read(path.join(dir, 'index.html'));
    const attr = (re) => [...html.matchAll(re)].map(m => m[1]);
    const css = attr(/<link rel="stylesheet" href="\/([^"]+)">/g);
    const preload = attr(/<link rel="modulepreload" href="\/([^"]+)">/g);
    const scripts = attr(/<script type="module" src="\/([^"]+)"><\/script>/g);
    assert.deepEqual(scripts, ['js/main.js'], 'one module script: the shell\'s main.js');
    // Every module reached by static imports from main.js is preloaded.
    const seen = new Set();
    const walk = p => {
      if (seen.has(p)) return;
      seen.add(p);
      const file = siteFile(game, '/' + p);
      assert.ok(file, `${p} exists on the site`);
      for (const dep of staticImports(file)) walk('js/' + dep);
      for (const dep of dynamicImports(file)) reach('js/' + dep, p);
    };
    // A module imported when first needed, and all it imports in turn, is
    // on the site; it is not part of the page load.
    const later = new Set();
    const reach = (p, from) => {
      if (seen.has(p) || later.has(p)) return;
      later.add(p);
      const file = siteFile(game, '/' + p);
      assert.ok(file, `${from} imports ${p}, which is not on the site`);
      for (const dep of [...staticImports(file), ...dynamicImports(file)]) reach('js/' + dep, p);
    };
    walk('js/main.js');
    seen.delete('js/main.js');
    assert.deepEqual([...seen].sort(), [...preload].sort(), 'the modules main.js imports statically are exactly the ones preloaded');
    for (const p of [...css, ...preload]) assert.ok(siteFile(game, '/' + p), `${p} exists on the site`);
    // html, favicon, manifest, one PNG icon (the install check) and the websocket.
    const total = 1 + css.length + 1 + preload.length + 1 + 1 + 1 + 1;
    assert.ok(total <= 17, `${total} requests: ${[...css, 'js/main.js', ...preload].join(', ')}`);
  });

  test(`${game}: the shell reaches the game only through main.js and game.js`, () => {
    const gameModules = new Set(treeFiles(path.join(dir, 'js')));
    for (const f of treeFiles(path.join(SHARED, 'js'))) {
      const src = read(path.join(SHARED, 'js', f));
      const deps = [...src.matchAll(/(?:from\s+|import\()\s*'\.\/([\w.-]+\.js)'/g)].map(m => m[1]);
      for (const d of deps) {
        if (f === 'main.js' && d === 'game.js') continue;
        assert.ok(!gameModules.has(d), `shell module ${f} imports the game's ${d}`);
        assert.ok(fs.existsSync(path.join(SHARED, 'js', d)), `shell module ${f} imports ${d}, which the shell does not have`);
      }
    }
    assert.ok(fs.existsSync(path.join(dir, 'js', 'game.js')), 'the game has its game.js');
  });

  test(`${game}: nothing a player sees names another game`, async () => {
    // How a game is named: mention in its test/facts.mjs, or the first four
    // letters of its name.
    const others = await Promise.all(GAMES.filter(g => g !== game).map(async g => (await facts(g)).mention ?? g.slice(0, 4)));
    const files = [...treeFiles(dir).map(f => path.join(dir, f)), ...treeFiles(SHARED).map(f => path.join(SHARED, f))];
    for (const f of files) {
      const text = visibleText(f).toLowerCase();
      for (const o of others) assert.ok(!text.includes(o), `${path.relative(path.join(SHELL, '../..'), f)} names ${o}`);
    }
  });
}
