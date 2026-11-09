// One game's site as the browser sees it: the union of platform/web and
// the web/ of the game's folder (docs/frontend.md#one-site-per-game), for
// the static servers of the tests (mock/server.mjs, manual-app.mjs,
// sound-render.mjs, ...). The two trees must not share a path;
// test/sites.test.mjs checks that. Also the games themselves, the folders
// the shared tests go through, and what those tests need to know of each.
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The shell every site shares.
export const SHELL = path.join(ROOT, 'platform', 'web');

// Every game's folder by name, in the order of the names: games/<game> and,
// in a checkout with the overlay, extra/<game>, each with its settings in
// <game>.mk (docs/adding-a-game.md#the-folder). A game in both is an error.
export const FOLDERS = new Map(['games', 'extra']
  .flatMap(dir => fs.existsSync(path.join(ROOT, dir)) ? fs.readdirSync(path.join(ROOT, dir)).map(g => [dir, g]) : [])
  .filter(([dir, g]) => fs.existsSync(path.join(ROOT, dir, g, `${g}.mk`)))
  .sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([dir, g], i, all) => {
    if (all[i + 1]?.[1] === g) throw new Error(`${g} is a game twice, in ${dir}/${g} and ${all[i + 1][0]}/${g}`);
    return [g, path.join(ROOT, dir, g)];
  }));

// The folder of game, and the directory of its own site files.
export const gameDir = game => FOLDERS.get(game) ?? path.join(ROOT, 'games', game);
export const siteDir = game => path.join(gameDir(game), 'web');

// The games with a site: every game whose folder has a web/index.html.
export const GAMES = [...FOLDERS.keys()].filter(g => fs.existsSync(path.join(siteDir(g), 'index.html')));

// What the shared tests need to know of game: the exports of its folder's
// test/facts.mjs (docs/adding-a-game.md#facts-for-the-shared-tests), or
// none without one.
export async function facts(game) {
  const file = path.join(gameDir(game), 'test', 'facts.mjs');
  return fs.existsSync(file) ? { ...await import(pathToFileURL(file).href) } : {};
}

// The file behind URL path p on the site of game, or null.
export function siteFile(game, p) {
  let rel;
  try { rel = decodeURIComponent(p); } catch { return null; }
  rel = path.normalize(rel).replace(/^[/\\]+/, '');
  if (rel.startsWith('..')) return null;
  for (const root of [siteDir(game), SHELL]) {
    const f = path.join(root, rel);
    if (f.startsWith(root + path.sep) && fs.statSync(f, { throwIfNoEntry: false })?.isFile()) return f;
  }
  return null;
}

// Makes node resolve a relative import in a module of a game's web/ as
// the browser does on that game's site: in the union, so the node tests of
// a game's module (games/klaverjas/web/js/rules.js) load the shell's
// ./util.js. Node 22.15 or later (module.registerHooks).
export function siteImports() {
  module.registerHooks({
    resolve(specifier, context, next) {
      if (/^\.\.?\//.test(specifier) && context.parentURL?.startsWith('file:')) {
        const from = fileURLToPath(context.parentURL);
        for (const game of GAMES) {
          const dir = siteDir(game);
          if (!from.startsWith(dir + path.sep)) continue;
          const rel = path.relative(dir, path.resolve(path.dirname(from), specifier)).split(path.sep).join('/');
          const file = siteFile(game, '/' + rel);
          if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
        }
      }
      return next(specifier, context);
    },
  });
}

// Every file of a tree, as site paths ("js/main.js").
export function treeFiles(dir) {
  const out = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out.push(path.relative(dir, f).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}
