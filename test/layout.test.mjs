// The layout of the Go code: the platform knows no game, and a game knows
// no other game. Checks the imports of every tracked .go file:
//   - nothing under platform/ imports a package of games/, except
//     klaverjas, still built into platform/server: its klaverjas_*.go files,
//     and the server's tests, which play klaverjas;
//   - no package of games/<a> imports one of games/<b>;
//   - cmd/<g> imports only packages of platform/ and games/<g>/;
//   - platform/cards, the seats and cards every game shares, imports no
//     package of the module.
//   node --test test/layout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = fs.readFileSync(path.join(ROOT, 'go.mod'), 'utf8').match(/^module\s+(\S+)/m)[1];

// The tracked .go files, as paths from the root ("platform/server/room.go").
function goFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--', '*.go'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

// The imports of a Go file: the paths in its import declarations, which
// come before any other declaration.
function importsOf(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const head = src.split(/^(?:func|type|var|const)\b/m)[0].replace(/\/\*[\s\S]*?\*\//g, '');
  const paths = [];
  for (const m of head.matchAll(/^import\s*(\([\s\S]*?^\)|[^\n]*)/gm)) {
    for (const line of m[1].split('\n')) {
      const spec = line.replace(/\/\/.*$/, '').match(/"([^"]+)"/);
      if (spec) paths.push(spec[1]);
    }
  }
  return paths;
}

// The module's own packages a file imports, relative to the module
// ("games/klaverjas/game").
function ownImports(file) {
  return importsOf(file).filter(p => p.startsWith(MODULE + '/')).map(p => p.slice(MODULE.length + 1));
}

const FILES = goFiles().map(file => ({ file, own: ownImports(file) }));

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
  const allowed = file => /^platform\/server\/(klaverjas_[^/]+|[^/]+_test)\.go$/.test(file);
  assert.deepEqual(violations((file, p) =>
    !file.startsWith('platform/') || !p.startsWith('games/') || allowed(file)), []);
});

test('a game imports no other game', () => {
  const game = p => p.match(/^games\/([^/]+)\//)?.[1];
  assert.deepEqual(violations((file, p) => !game(file) || !game(p) || game(p) === game(file)), []);
});

test('cmd/<g> imports only the platform and games/<g>', () => {
  assert.deepEqual(violations((file, p) => {
    const g = file.match(/^cmd\/([^/]+)\//)?.[1];
    return !g || p.startsWith('platform/') || p.startsWith(`games/${g}/`);
  }), []);
});

test('platform/cards imports nothing of the module', () => {
  assert.ok(FILES.some(f => f.file.startsWith('platform/cards/')), 'platform/cards has files');
  assert.deepEqual(violations(file => !file.startsWith('platform/cards/')), []);
});
