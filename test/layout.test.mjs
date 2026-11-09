// The layout of the Go code: the platform knows no game, and a game knows
// no other game. A game is a folder, games/<g>/ or extra/<g>/ in the overlay
// (docs/adding-a-game.md#the-folder). Checks the imports of every tracked
// .go file, and of every one in the overlay:
//   - nothing under platform/ imports a package of a game, except
//     klaverjas, still built into platform/server: its klaverjas_*.go files,
//     and the server's tests, which play klaverjas, import games/klaverjas/;
//   - no package of one game imports one of another;
//   - a game's server, cmd/<g> or <folder>/cmd/<g>, imports only packages of
//     platform/ and of the game's folder;
//   - platform/cards, the seats and cards every game shares, imports no
//     package of the module;
//   - a game whose test/facts.mjs has an import table (imports) keeps to it.
//   node --test test/layout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOLDERS, facts } from './ui/site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = fs.readFileSync(path.join(ROOT, 'go.mod'), 'utf8').match(/^module\s+(\S+)/m)[1];

// The .go files on disk under dir, as paths from the root, but in hidden
// directories and node_modules; none when dir does not exist.
function goFilesUnder(dir) {
  if (!fs.existsSync(path.join(ROOT, dir))) return [];
  return fs.readdirSync(path.join(ROOT, dir), { recursive: true }).map(f => f.split(path.sep).join('/'))
    .filter(f => f.endsWith('.go') && !f.split('/').some(p => p.startsWith('.') || p === 'node_modules'))
    .map(f => path.posix.join(dir, f));
}

// The .go files, as paths from the root ("platform/server/room.go"): the
// tracked ones that exist and the untracked ones git does not ignore, or,
// outside a git checkout, every one under cmd/, platform/ and games/; and
// every one of the overlay, extra/, which git ignores here.
function goFiles() {
  let files;
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.go'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    files = [...new Set(out.split('\0').filter(Boolean))].filter(f => fs.existsSync(path.join(ROOT, f)));
  } catch {
    files = ['cmd', 'platform', 'games'].flatMap(goFilesUnder);
  }
  return [...files.filter(f => !f.startsWith('extra/')), ...goFilesUnder('extra')];
}

// The import paths of Go source src: every interpreted ("…") or raw (`…`)
// string of its import declarations, which come before any other
// declaration, several specs on a line included.
function parseImports(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const head = code.split(/^(?:func|type|var|const)\b/m)[0];
  const paths = [];
  for (const m of head.matchAll(/^import\s*(\([\s\S]*?^\)|[^\n]*)/gm)) {
    for (const spec of m[1].matchAll(/"([^"\n]+)"|`([^`]+)`/g)) paths.push(spec[1] ?? spec[2]);
  }
  return paths;
}

// The module's own packages among imports, relative to the module
// ("games/klaverjas/game").
function own(imports) {
  return imports.filter(p => p.startsWith(MODULE + '/')).map(p => p.slice(MODULE.length + 1));
}

const FILES = goFiles().map(file => {
  const imports = parseImports(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  return { file, imports, own: own(imports) };
});

// The game of a path from the root ("games/klaverjas/game" or
// "extra/<g>/…"), if it lies in a game's folder.
const gameOf = p => p.match(/^(?:games|extra)\/([^/]+)\//)?.[1];

// The violations of rule, a predicate on (file, import), as "file: import".
function violations(rule) {
  return FILES.flatMap(({ file, own }) => own.filter(p => !rule(file, p)).map(p => `${file}: ${p}`));
}

test('the parser sees the code', () => {
  assert.ok(FILES.length > 50, `${FILES.length} .go files`);
  const kj = FILES.find(f => f.file === 'platform/server/klaverjas_game.go');
  assert.ok(kj?.own.includes('games/klaverjas/game'), 'klaverjas_game.go imports games/klaverjas/game');
  const toepen = FILES.filter(f => f.file.startsWith('games/toepen/'));
  assert.ok(toepen.some(f => f.own.includes('platform/cards')), 'toepen imports platform/cards');
});

test('the platform imports no game, but for klaverjas built into the server', () => {
  const builtIn = (file, p) => /^platform\/server\/(klaverjas_[^/]+|[^/]+_test)\.go$/.test(file) &&
    p.startsWith('games/klaverjas/');
  assert.deepEqual(violations((file, p) =>
    !file.startsWith('platform/') || !gameOf(p) || builtIn(file, p)), []);
});

test('a game imports no other game', () => {
  assert.deepEqual(violations((file, p) => !gameOf(file) || !gameOf(p) || gameOf(p) === gameOf(file)), []);
});

test('a game\'s server, cmd/<g> or <folder>/cmd/<g>, imports only the platform and the game\'s folder', () => {
  assert.deepEqual(violations((file, p) => {
    const g = file.match(/^(?:cmd|(?:games|extra)\/([^/]+)\/cmd)\/([^/]+)\//);
    if (!g || g[1] && g[1] !== g[2]) return true;
    const folder = FOLDERS.get(g[2]);
    return p.startsWith('platform/') || !!folder && p.startsWith(path.relative(ROOT, folder).split(path.sep).join('/') + '/');
  }), []);
});

test('platform/cards imports nothing of the module', () => {
  assert.ok(FILES.some(f => f.file.startsWith('platform/cards/')), 'platform/cards has files');
  assert.deepEqual(violations(file => !file.startsWith('platform/cards/')), []);
});

// under reports whether path p is pkg or lies under it.
const under = (p, pkg) => p === pkg || p.startsWith(pkg + '/');

// The violations of a game's import table among files ({file, imports}), as
// "file: import"; folder is the game's, from the root ("games/<g>"). The
// table, imports in the game's test/facts.mjs
// (docs/adding-a-game.md#facts-for-the-shared-tests), maps each package of
// the game, a path in its folder, to what it may import besides itself and
// the packages under it: a path in the folder ("." for all of it), the
// platform's ("platform", "platform/cards") or another module's
// ("github.com/…"); the standard library is always allowed. A Go file of
// the folder in no package of the table is a violation too.
function tableViolations(folder, table, files) {
  const full = p => p === '.' ? folder
    : under(p, 'platform') || p.split('/')[0].includes('.') ? p : `${folder}/${p}`;
  const keys = Object.keys(table).sort((a, b) => full(b).length - full(a).length);
  return files.flatMap(({ file, imports }) => {
    if (!under(file, folder)) return [];
    const key = keys.find(k => under(path.posix.dirname(file), full(k)));
    if (key === undefined) return [`${file}: in no package of the import table`];
    const allowed = [full(key), ...table[key].map(full)];
    return imports
      .map(p => p.startsWith(MODULE + '/') ? p.slice(MODULE.length + 1) : p)
      .filter(p => (gameOf(p) || under(p, 'platform') || p.split('/')[0].includes('.')) && !allowed.some(a => under(p, a)))
      .map(p => `${file}: ${p}`);
  });
}

// The games with an import table, as [folder from the root, table].
const TABLES = (await Promise.all([...FOLDERS].map(async ([g, dir]) =>
  [path.relative(ROOT, dir).split(path.sep).join('/'), (await facts(g)).imports])))
  .filter(([, table]) => table);

test('a game with an import table keeps to it', () => {
  for (const [folder, table] of TABLES) assert.deepEqual(tableViolations(folder, table, FILES), [], folder);
});

test('an import table catches a forbidden import', () => {
  const fake = (file, src) => ({ file, imports: parseImports(src) });
  const table = {
    rules: [], bots: ['rules', 'platform/cards'], server: ['rules', 'platform'], 'cmd/kwartet': ['.', 'platform'],
  };
  const files = [
    fake('extra/kwartet/rules/deal.go', `package rules

import (
	"fmt"

	// "jannie/extra/kwartet/bots" in a comment is no import
	"jannie/platform/cards"
)

func f() {}
`),
    fake('extra/kwartet/rules/net.go', 'package rules\n\nimport "github.com/coder/websocket"\n'),
    fake('extra/kwartet/bots/bot.go', 'package bots\n\nimport (\n\t"jannie/extra/kwartet/rules"\n\t"jannie/extra/kwartet/server"\n)\n'),
    // Raw strings and several specs on a line, which gofmt would rewrite.
    fake('extra/kwartet/bots/raw.go', 'package bots\n\nimport s `jannie/extra/kwartet/server`\n'),
    fake('extra/kwartet/bots/semi.go', 'package bots\n\nimport ("fmt"; "jannie/platform/server")\n'),
    fake('extra/kwartet/bots/other.go', 'package bots\n\nimport "jannie/games/toepen/toepen"\n'),
    fake('extra/kwartet/tools/gen.go', 'package main\n\nimport "fmt"\n'),
    // Allowed:
    fake('extra/kwartet/rules/rules_test.go', 'package rules_test\n\nimport (\n\t"testing"\n\n\t"jannie/extra/kwartet/rules"\n)\n'),
    fake('extra/kwartet/bots/sub/sub.go', 'package sub\n\nimport "jannie/platform/cards"\n'),
    fake('extra/kwartet/server/table.go', 'package server\n\nimport (\n\t"jannie/extra/kwartet/rules"\n\t"jannie/platform/server/servertest"\n)\n'),
    fake('extra/kwartet/cmd/kwartet/main.go', 'package main\n\nimport (\n\t"jannie/extra/kwartet/bots"\n\t"jannie/platform/serve"\n)\n'),
    // Outside the game's folder: the other rules' case, not the table's.
    fake('games/toepen/toepen/deal.go', 'package toepen\n\nimport "jannie/extra/kwartet/bots"\n'),
  ];
  assert.deepEqual(tableViolations('extra/kwartet', table, files), [
    'extra/kwartet/rules/deal.go: platform/cards',
    'extra/kwartet/rules/net.go: github.com/coder/websocket',
    'extra/kwartet/bots/bot.go: extra/kwartet/server',
    'extra/kwartet/bots/raw.go: extra/kwartet/server',
    'extra/kwartet/bots/semi.go: platform/server',
    'extra/kwartet/bots/other.go: games/toepen/toepen',
    'extra/kwartet/tools/gen.go: in no package of the import table',
  ]);
});
