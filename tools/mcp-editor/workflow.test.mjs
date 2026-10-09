import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { EDITOR_TOOLS } from './catalog.mjs';
import { editorWorkflow } from './workflow.mjs';

test('workflow references actual tools and repository contracts without exposing mutable shared state', () => {
  const workflow = editorWorkflow(), names = new Set(EDITOR_TOOLS.map(t => t.name));
  for (const stage of workflow.stages) for (const name of stage.tools) assert.ok(names.has(name), name);
  const paths = [workflow.guide, workflow.transport, ...Object.values(workflow.sources),
    workflow.knowledge.entry, workflow.knowledge.catalog, workflow.knowledge.architecture, workflow.knowledge.codeGraph,
    ...workflow.topics.flatMap(t => [t.guide, t.reusable, t.resourceBrief].filter(Boolean))];
  for (const path of paths) assert.ok(existsSync(fileURLToPath(new URL(`../../${path}`, import.meta.url))), path);
  workflow.stages[0].tools.length = 0;
  assert.ok(editorWorkflow().stages[0].tools.includes('editor_instances'));
  assert.match(workflow.recovery.TIMEOUT, /may have executed/);
});
