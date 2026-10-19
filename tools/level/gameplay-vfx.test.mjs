import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {applyGameplayVfx} from './gameplay-vfx.mjs';

test('正式关卡重绑幂等，保留模拟规则与布局，引用均为已接受正式资源', () => {
  for (const floor of [1, 2, 3]) {
    const doc = JSON.parse(fs.readFileSync(`assets/scenes/act1/floor-${floor}.scene.json`, 'utf8'));
    const before = structuredClone(doc);
    applyGameplayVfx(doc);
    assert.deepEqual(applyGameplayVfx(structuredClone(doc)), doc);
    // 清除仅本工具拥有的表现字段后，整份原关卡应完全相同。
    const gameplay = d => {
      d.dependencies = [];
      for (const n of d.nodes) {
        n.components = n.components.filter(c => c.kind !== 'VfxBindings');
        for (const c of n.components) if (c.kind === 'RunRules') for (const w of c.arsenal.definitions) w.presentation.vfx = null;
      }
      return d;
    };
    assert.deepEqual(gameplay(structuredClone(doc)), gameplay(before));
    for (const node of doc.nodes) for (const c of node.components) if (c.kind === 'VfxBindings') {
      for (const b of Object.values(c.bindings)) {
        const resource = JSON.parse(fs.readFileSync(b.resource.path, 'utf8'));
        const meta = JSON.parse(fs.readFileSync(b.resource.path + '.meta.json', 'utf8'));
        assert.equal(resource.id, b.resource.guid); assert.equal(meta.guid, b.resource.guid);
        assert.equal(resource.status, 'accepted'); assert.ok(resource.effects[b.effectKey]);
      }
    }
  }
});

test('编辑用途默认场景不补造玩法或发射器', () => {
  const doc = JSON.parse(fs.readFileSync('assets/scenes/sandbox/default.scene.json', 'utf8'));
  assert.deepEqual(applyGameplayVfx(structuredClone(doc)), doc);
});
