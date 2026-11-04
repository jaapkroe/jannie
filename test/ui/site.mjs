// One game's site as the browser sees it: the union of platform/web and
// games/<game>/web (docs/frontend.md#one-site-per-game), for the static
// servers of the tests (mock/server.mjs, manual-app.mjs,
// sound-render.mjs, ...). The two trees must not share a path;
// test/sites.test.mjs checks that.
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The shell every site shares.
export const SHELL = path.join(ROOT, 'platform', 'web');

// The directory of game's own files.
export const siteDir = game => path.join(ROOT, 'games', game, 'web');

// The games with a site: every directory of games/ with a web/index.html.
export const GAMES = fs.readdirSync(path.join(ROOT, 'games'))
  .filter(d => fs.existsSync(path.join(siteDir(d), 'index.html')))
  .sort();

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

// Makes node resolve a relative import in a module of games/<game>/web as
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
