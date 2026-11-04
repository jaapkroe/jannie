// One game's site as the browser sees it: the union of platform/web and
// games/<game>/web (design §9, "One site per game"), for the static servers of the
// tests (mock/server.mjs, manual-app.mjs, sound-render.mjs, ...). The two
// trees must not share a path; test/sites.test.mjs checks that.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
