// The links of the docs and the code's references to them. Checks every
// tracked file, and every file of the overlay, extra/
// (docs/adding-a-game.md#the-overlay):
//   - a relative link or image in a Markdown file names a file of the
//     repository, and its #anchor a heading of that file (#anchor alone: of
//     the same file), with GitHub's anchors;
//   - a reference to docs/<name>.md, games/<game>/README.md,
//     extra/<game>/README.md or test/e2e/README.md in any other text file,
//     with or without an #anchor, does the same;
//   - no file cites the docs these replaced, or their numbered sections,
//     but for the one comment that renders into the installed units.
//   node --test test/docs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url)).split(path.sep).join('/');

// What .gitignore leaves out, for a tree without git: no checkout's own
// files, no packages, no build output; and the overlay, which is listed on
// its own.
const UNTRACKED = new Set(['.git', '.worktrees', '.claude', '.vscode', 'build', 'test/ui/out', 'local.mk',
  'CLAUDE.local.md', 'extra']);

// Every file under dir, as paths from the root, but UNTRACKED, git
// directories and node_modules.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const f = dir ? `${dir}/${e.name}` : e.name;
    if (UNTRACKED.has(f) || e.name === 'node_modules' || e.name === '.git') continue;
    if (e.isDirectory()) walk(f, out);
    else if (e.isFile()) out.push(f);
  }
  return out;
}

// The files of git's checkout at dir ("" for the root), as paths from the
// root: the tracked ones and the untracked ones its .gitignore keeps.
function gitFiles(dir) {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: path.join(ROOT, dir), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });
  return out.split('\0').filter(Boolean).map(f => dir ? `${dir}/${f}` : f);
}

// The files, as paths from the root ("docs/server.md"): the tracked ones
// that exist and the untracked ones git does not ignore, or, outside a git
// checkout, every file but those git would ignore. And the overlay's, which
// git ignores here: those of its own checkout, or every file in it.
function repoFiles() {
  let files;
  try {
    files = gitFiles('').filter(f => !f.startsWith('extra/'));
  } catch {
    files = walk('');
  }
  if (fs.existsSync(path.join(ROOT, 'extra'))) {
    let overlay;
    try {
      overlay = fs.existsSync(path.join(ROOT, 'extra', '.git')) ? gitFiles('extra') : walk('extra');
    } catch {
      overlay = walk('extra');
    }
    files.push(...overlay);
  }
  return [...new Set(files)].filter(f => fs.statSync(path.join(ROOT, f), { throwIfNoEntry: false })?.isFile()).sort();
}

const FILES = repoFiles();
const KNOWN = new Set(FILES);
const DIRS = new Set(FILES.flatMap(f => f.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))));
// The text files (no NUL byte) and their contents.
const TEXT = new Map();
for (const f of FILES) {
  const buf = fs.readFileSync(path.join(ROOT, f));
  if (!buf.includes(0)) TEXT.set(f, buf.toString('utf8'));
}
const MARKDOWN = [...TEXT.keys()].filter(f => f.endsWith('.md'));

// GitHub's anchor of a heading: lower case, every character but letters,
// digits, spaces, hyphens and underscores dropped, spaces as hyphens.
function slug(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N} _-]/gu, '').replace(/ /g, '-');
}

// src with the lines of fenced code blocks blanked: no heading or link in
// them counts. Line numbers stay.
function unfenced(src) {
  let fence = null;
  return src.split('\n').map(line => {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^\s*$/.test(line.slice(m[0].length))) fence = null;
      return '';
    }
    if (m) {
      fence = m[1];
      return '';
    }
    return line;
  }).join('\n');
}

// src without code: fenced blocks and code spans blanked, every line and
// offset kept. A code span stays within its paragraph.
function prose(src) {
  return unfenced(src).split(/(\n[ \t]*\n)/).map(block =>
    block.replace(/(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, m => m.replace(/[^\n]/g, ' '))).join('');
}

// The anchors of the headings in src, a repeated one numbered -1, -2, … as
// GitHub does. A heading's text is as rendered: a link or image by its
// text, no HTML tags.
function headingAnchors(src) {
  const anchors = new Set();
  const count = new Map();
  for (const line of unfenced(src).split('\n')) {
    const m = line.match(/^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/);
    if (!m) continue;
    const text = (m[1] ?? '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '').trim();
    const base = slug(text);
    let a = base;
    while (anchors.has(a)) {
      count.set(base, (count.get(base) ?? 0) + 1);
      a = `${base}-${count.get(base)}`;
    }
    anchors.add(a);
  }
  return anchors;
}

const anchorCache = new Map();
function anchorsOf(file) {
  if (!anchorCache.has(file)) anchorCache.set(file, headingAnchors(TEXT.get(file) ?? ''));
  return anchorCache.get(file);
}

const decode = s => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// What is wrong with a link or reference to target ("docs/server.md#pacing",
// "#options") in file, with relative paths from dir and /paths from the
// root; "" when it resolves. Only a Markdown file's anchors are checked.
function problem(target, file, dir) {
  const hash = target.indexOf('#');
  const p = (hash < 0 ? target : target.slice(0, hash)).replace(/\?.*$/, '');
  const anchor = hash < 0 ? null : decode(target.slice(hash + 1));
  let to = file;
  if (p) {
    to = path.posix.join(p.startsWith('/') ? '.' : dir, decode(p)).replace(/\/$/, '');
    if (to.startsWith('..')) return `${target}: outside the repository`;
    if (to !== '.' && !KNOWN.has(to) && !DIRS.has(to)) return `${target}: no such file`;
  }
  if (anchor !== null && to.endsWith('.md') && !anchorsOf(to).has(anchor)) return `${target}: no heading #${anchor} in ${to}`;
  return '';
}

const lineAt = (src, i) => src.slice(0, i).split('\n').length;

// The relative links and images of a Markdown file, with their lines:
// [text](target), ![alt](target), [label]: target, and the src or href of
// an HTML tag. Links with a scheme (https:, mailto:) go elsewhere.
function markdownLinks(file) {
  const src = prose(TEXT.get(file));
  const links = [];
  const add = (target, i) => {
    target = target.replace(/^<(.*)>$/, '$1');
    if (target && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(target)) links.push({ target, line: lineAt(src, i) });
  };
  for (const m of src.matchAll(/!?\[(?:[^\[\]\\]|\\.|\[[^\[\]]*\])*\]\(\s*(<[^>\n]*>|[^\s()]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) {
    add(m[1], m.index + m[0].indexOf('](') + 2);
  }
  for (const m of src.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm)) add(m[1], m.index);
  for (const m of src.matchAll(/<(?:img|a|source)\b[^>]*?\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    add(m[1] ?? m[2], m.index);
  }
  return links.sort((a, b) => a.line - b.line);
}

// A reference to a doc in a file that is not Markdown, from the root.
const DOC_REF = /(?<![\w./-])(?:docs\/[\w-]+\.md|(?:games|extra)\/[\w-]+\/README\.md|test\/e2e\/README\.md)(?:#[\p{L}\p{M}\p{N}_-]+)?/gu;

// The docs replaced by docs/architecture.md, server.md, protocol.md,
// frontend.md, deployment.md, adding-a-game.md and the games' READMEs, by
// path or bare name, and their numbered sections.
const REMOVED = /(?<![\w.-])(?:docs\/)?(?:design|games|toepen)\.md\b|README-deploy|\bdesign ?§|\bdesign section \d/g;
// The one citation kept: the comments of deploy/*.in render into the
// installed units, which must stay byte for byte the same (compare
// make -s quadlet GAME=klaverjas before and after), so this one keeps the
// old section number.
const KEPT = [{ file: 'deploy/game-server.container.in', text: 'The game log (design §6)' }];

test('anchors are made as GitHub makes them', () => {
  assert.equal(slug('Client → server'), 'client--server');
  assert.equal(slug('State `s`'), 'state-s');
  assert.equal(slug('SUPPORT_URL'), 'support_url');
  assert.equal(slug('platform/cards'), 'platformcards');
  assert.equal(slug('Roem (bonus points, "roem op tafel")'), 'roem-bonus-points-roem-op-tafel');
  assert.deepEqual([...headingAnchors('# A\n## A\n```\n# B\n```\n### [A](x.md) ##\n')], ['a', 'a-1', 'a-2']);
});

test('the parsers see the docs', () => {
  assert.ok(MARKDOWN.length >= 10, MARKDOWN.join());
  assert.ok(anchorsOf('docs/server.md').has('takeover-consent'), 'docs/server.md#takeover-consent');
  assert.ok(anchorsOf('games/klaverjas/README.md').has('seinen-signals'), 'games/klaverjas/README.md#seinen-signals');
  const links = MARKDOWN.flatMap(markdownLinks);
  assert.ok(links.length > 100, `${links.length} links`);
  assert.ok(links.some(l => l.target.startsWith('#')), 'a link within a file');
  const refs = [...TEXT].filter(([f]) => !f.endsWith('.md')).flatMap(([, src]) => [...src.matchAll(DOC_REF)]);
  assert.ok(refs.length > 100, `${refs.length} references in code`);
});

test('every relative link and image in the Markdown resolves', () => {
  const problems = MARKDOWN.flatMap(file => markdownLinks(file).map(({ target, line }) => {
    const p = problem(target, file, path.posix.dirname(file));
    return p && `${file}:${line}: ${p}`;
  })).filter(Boolean);
  assert.deepEqual(problems, []);
});

test('every reference to a doc in the code resolves', () => {
  const problems = [];
  for (const [file, src] of TEXT) {
    if (file.endsWith('.md')) continue;
    src.split('\n').forEach((line, i) => {
      for (const [ref] of line.matchAll(DOC_REF)) {
        const p = problem(ref, file, '');
        if (p) problems.push(`${file}:${i + 1}: ${p}`);
      }
    });
  }
  assert.deepEqual(problems, []);
});

test('no file cites the replaced docs', () => {
  const problems = [];
  for (const [file, src] of TEXT) {
    if (file === SELF) continue; // names them to find them
    src.split('\n').forEach((line, i) => {
      if (KEPT.some(k => k.file === file && line.includes(k.text))) return;
      for (const [name] of line.matchAll(REMOVED)) problems.push(`${file}:${i + 1}: ${name}`);
    });
  }
  assert.deepEqual(problems, []);
});
