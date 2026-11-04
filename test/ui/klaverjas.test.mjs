// games/klaverjas/web/js/rules.js without a browser: node --test test/ui/klaverjas.test.mjs
// (manual.js imports the shell's cards.js, which site.mjs's siteImports
// finds as the browser does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteImports } from './site.mjs';

siteImports();
const { MANUAL_SECTIONS } = await import('../../games/klaverjas/web/js/rules.js');
const { SECTIONS } = await import('../../games/klaverjas/web/js/manual.js');

test('the manual\'s sections are manual.js\'s, for the lesson link before it loads', () => {
  assert.deepEqual(MANUAL_SECTIONS, SECTIONS);
});
