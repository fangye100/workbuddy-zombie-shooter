import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {dependencies, inspectEdge, layerOf} from './check.mjs';
const rules = JSON.parse(fs.readFileSync(new URL('./layers.json', import.meta.url), 'utf8'));
const allExist = () => true;
for (const [title, source] of [
  ['type-only import', "import type { RuntimeSession } from '@aether/zombie-game';"],
  ['per-name type import', "import { type RuntimeSession } from '@aether/zombie-game';"],
  ['type expression', "type R = import('@aether/zombie-game').RuntimeSession;"],
  ['re-export', "export * from '@aether/zombie-game';"],
  ['dynamic import', "const r = import('@aether/zombie-game');"],
  ['CommonJS', "const r = require('@aether/zombie-game');"],
  ['import equals', "import R = require('@aether/zombie-game');"],
  ['direct Worker', "new Worker('../../../apps/editor/src/main.ts');"],
  ['Worker URL', "new Worker(new URL('../../../apps/editor/src/main.ts', import.meta.url));"],
  ['asset glob', "import.meta.glob('../../../assets/behaviors/*.ts');"],
]) test(`framework rejects ${title} into game/editor ownership`, () => {
  const edges = dependencies('packages/runtime/src/f.ts', source);
  assert.equal(edges.length, 1);
  assert.match(inspectEdge('packages/runtime/src/f.ts', edges[0], rules, allExist), /forbidden/);
});
test('headless game cannot depend on DOM presentation, including a public entry', () => {
  assert.match(inspectEdge('packages/zombie-game/src/f.ts', {specifier:'@aether/zombie-game/presentation/game-hud',kind:'import'}, rules, allExist), /forbidden/);
});
test('game cannot import editor even via relative paths', () => {
  assert.match(inspectEdge('packages/zombie-game/src/f.ts', {specifier:'../../../apps/editor/src/renderer',kind:'import'}, rules, allExist), /forbidden/);
});
test('composition can import game; game can import framework', () => {
  assert.equal(inspectEdge('apps/editor/src/main.ts', {specifier:'@aether/zombie-game',kind:'import'}, rules, allExist), null);
  assert.equal(inspectEdge('packages/zombie-game/src/f.ts', {specifier:'@aether/runtime',kind:'import'}, rules, allExist), null);
});
test('deep and missing aliases fail, while public presentation routes work', () => {
  assert.match(inspectEdge('apps/editor/src/main.ts', {specifier:'@aether/zombie-game/src/session',kind:'import'}, rules, allExist), /Non-public/);
  assert.match(inspectEdge('apps/editor/src/main.ts', {specifier:'@aether/missing',kind:'import'}, rules, () => false), /Missing/);
  assert.equal(inspectEdge('apps/editor/src/main.ts', {specifier:'@aether/zombie-game/presentation/game-hud',kind:'import'}, rules, allExist), null);
});
test('cross-package relative paths cannot bypass the public API rule', () => {
  assert.match(inspectEdge('packages/render/src/f.ts', {specifier:'../../scene/src/document.ts',kind:'import'}, rules, allExist), /public @aether/);
});
test('nonliteral imports cannot bypass lower-layer ownership', () => {
  const edges = dependencies('packages/runtime/src/f.ts', 'import(modulePath);');
  assert.match(inspectEdge('packages/runtime/src/f.ts', edges[0], rules, allExist), /Non-literal/);
});
test('absolute imports and globs cannot bypass ownership as external dependencies', () => {
  for(const code of ["import('/packages/zombie-game/src/index.ts');", "import.meta.glob('/assets/**/*.ts');"])
    assert.match(inspectEdge('packages/runtime/src/f.ts', dependencies('f.ts',code)[0], rules, allExist), /Absolute project/);
});
test('unknown package is unclassified; tests do not change source ownership', () => {
  assert.equal(layerOf('packages/unclassified/src/f.ts', rules), null);
  assert.equal(layerOf('packages/zombie-game/src/presentation/game-audio.ts', rules), 'game-presentation');
});
