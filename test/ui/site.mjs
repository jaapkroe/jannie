// One game's site as the browser sees it: the union of web/shared and
// web/<game> (design §9, "One site per game"), for the static servers of the
// tests (mock/server.mjs, manual-app.mjs, sound-render.mjs, ...). The two
// trees must not share a path; test/sites.test.mjs checks that.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');

// The games with a site: every directory of web/ but shared with an index.html.
export const GAMES = fs.readdirSync(WEB)
  .filter(d => d !== 'shared' && fs.existsSync(path.join(WEB, d, 'index.html')))
  .sort();

// The file behind URL path p on the site of game, or null.
export function siteFile(game, p) {
  let rel;
  try { rel = decodeURIComponent(p); } catch { return null; }
  rel = path.normalize(rel).replace(/^[/\\]+/, '');
  if (rel.startsWith('..')) return null;
  for (const root of [path.join(WEB, game), path.join(WEB, 'shared')]) {
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
