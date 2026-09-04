/**
 * instantiate.ts 的测试（ADR-009：测试与被测代码同位）。
 *
 * 除了单元级（buildBuiltinMesh / resolveMaterialId），最后一组是**端到端**：
 * 拿仓库里真实的 `assets/scenes/sandbox/default.scene.json` 走完整链路
 * （migrate → SceneGraph → instantiate），断言产出的物体与文件里写的一致。
 * 这一组是 S1「场景内容来自文件」的实际落点证明 —— 它挂了就说明编辑器加载不了。
 */
import { describe, it, expect } from 'vitest';
import { buildBuiltinMesh, resolveMaterialId, instantiateScene } from '../src/instantiate';
import { migrateToLatest } from '../src/migrate';
import { SceneGraph } from '../src/graph';
import { ComponentKind, type MaterialBinding, type SceneDocument } from '../src/document';

const sceneModules = import.meta.glob('/assets/**/*.scene.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

describe('buildBuiltinMesh', () => {
  it('五种形状都能造出非空网格（顶点 + 索引都 > 0）', () => {
    const cases = [
      ['box', [1, 1, 1]],
      ['sphere', [0.55, 40, 24]],
      ['cylinder', [0.32, 1.3, 32]],
      ['capsule', [0.34, 1, 28, 10]],
      ['plane', [80, 24]],
    ] as const;
    for (const [shape, params] of cases) {
      const mesh = buildBuiltinMesh(shape, params);
      expect(mesh, shape).not.toBeNull();
      expect(mesh!.vertices.length, shape).toBeGreaterThan(0);
      expect(mesh!.indices.length, shape).toBeGreaterThan(0);
    }
  });

  it('参数个数与 BUILTIN_SHAPE_PARAMS 不符时返回 null（不静默错位）', () => {
    expect(buildBuiltinMesh('box', [1, 1])).toBeNull();
    expect(buildBuiltinMesh('plane', [80])).toBeNull();
    expect(buildBuiltinMesh('capsule', [0.34, 1, 28])).toBeNull();
  });
});

describe('resolveMaterialId', () => {
  const binding = (m: MaterialBinding['material']): MaterialBinding => ({
    match: { by: 'index', value: -1 },
    material: m,
  });

  it('shared 直接取 id', () => {
    expect(resolveMaterialId([binding({ type: 'shared', id: 'mat1' })])).toBe('mat1');
  });

  it('instance 取自身 id（不是 base）', () => {
    expect(resolveMaterialId([binding({ type: 'instance', id: 'matA', base: 'mat0' })])).toBe('matA');
  });

  it('override 一路剥到最内层的 shared', () => {
    expect(
      resolveMaterialId([
        binding({
          type: 'override',
          base: { type: 'override', base: { type: 'shared', id: 'mat2' }, patch: {} },
          patch: {},
        }),
      ]),
    ).toBe('mat2');
  });

  it('空绑定 / 非法类型返回 null（交给调用方回落，不在这里猜默认值）', () => {
    expect(resolveMaterialId([])).toBeNull();
    expect(resolveMaterialId([binding({ type: 'bogus' } as unknown as MaterialBinding['material'])])).toBeNull();
  });
});

describe('instantiateScene（端到端：真实场景文件）', () => {
  const raw = sceneModules['/assets/scenes/sandbox/default.scene.json'];
  const migrated = migrateToLatest(raw as SceneDocument);
  const graph = SceneGraph.fromDocument(migrated.doc);
  graph.updateWorldTransforms();
  const result = instantiateScene(graph);

  it('场景文件存在且迁移后无 error', () => {
    expect(raw).toBeDefined();
    expect(migrated.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('13 个带 MeshRenderer 的物体被实例化；光源与相机进 skipped', () => {
    expect(result.objects.length).toBe(13);
    const skippedNames = result.skipped.map((s) => s.name);
    expect(skippedNames).toContain('Key Light');
    expect(skippedNames).toContain('Main Camera');
    // 跳过的都是"本来就不该渲染"的，不能因为参数错被跳过
    expect(result.skipped.every((s) => s.reason === '没有 MeshRenderer 组件')).toBe(true);
  });

  it('每个物体都有网格与材质 id（builtin 全部就地造好）', () => {
    for (const o of result.objects) {
      expect(o.mesh, o.name).not.toBeNull();
      expect(o.materialId, o.name).toMatch(/^mat\d$/);
    }
  });

  it('世界变换来自文件：地面在原点、角色在 y=0.84', () => {
    const ground = result.objects.find((o) => o.name === '地面 Ground');
    const char = result.objects.find((o) => o.name === '角色 Character');
    expect(ground?.position).toEqual([0, 0, 0]);
    expect(char?.position).toEqual([0, 0.84, 0]);
  });

  it('不可拾取的地面 / 天空 pickable 为 false，其余为 true', () => {
    expect(result.objects.find((o) => o.name === '地面 Ground')?.pickable).toBe(false);
    expect(result.objects.find((o) => o.name === '天空 Sky')?.pickable).toBe(false);
    expect(result.objects.find((o) => o.name === '立方体 Box')?.pickable).toBe(true);
  });

  // 用 toMatchObject 而不是 toEqual：userData 里还有 category 等字段，
  // 断言"我关心的这几项在"比"一个不多一个不少"更能扛住后续加字段。
  it('userData 原样透传（bob / aoMin·aoMax / background / category 都要到得了渲染器）', () => {
    expect(result.objects.find((o) => o.name === '天空 Sky')?.userData).toMatchObject({
      background: true,
      category: '环境',
    });
    expect(result.objects.find((o) => o.name === '角色 Character')?.userData).toMatchObject({
      aoMin: -0.84,
      aoMax: 0.84,
      category: '角色',
    });
    // 敌人 4 的 bob 是 2.0999999999999996（JSON 里写死的值，别"修"它）
    expect(result.objects.find((o) => o.name === '敌人 Enemy 4')?.userData).toMatchObject({
      bob: 2.0999999999999996,
      category: '敌人',
    });
  });

  it('隐藏节点被跳过（isEffectivelyVisible 生效）', () => {
    const g2 = SceneGraph.fromDocument(migrated.doc);
    g2.updateWorldTransforms();
    const box = g2.findByName('立方体 Box')[0]!;
    g2.setLocalTransform(box, {});
    // 直接改可见性：走 graph 的 API 才能同时影响 isEffectivelyVisible
    const node = g2.getNode(box)!;
    node.visible = false;
    g2.markDirty();
    g2.updateWorldTransforms();
    const r2 = instantiateScene(g2);
    expect(r2.objects.length).toBe(12);
    expect(r2.skipped.some((s) => s.name === '立方体 Box' && s.reason === '组件或层级被隐藏')).toBe(true);
  });
});

describe('instantiateScene（组件开关）', () => {
  it('MeshRenderer.enabled=false 时不产出物体', () => {
    const doc: SceneDocument = {
      ...migrateToLatest(sceneModules['/assets/scenes/sandbox/default.scene.json'] as SceneDocument)
        .doc,
      nodes: [
        {
          id: 'nd_a',
          name: 'A',
          parent: null,
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          visible: true,
          pickable: true,
          components: [
            {
              kind: ComponentKind.MeshRenderer,
              enabled: false,
              source: { type: 'builtin', shape: 'box', params: [1, 1, 1] },
              materials: [{ match: { by: 'index', value: -1 }, material: { type: 'shared', id: 'mat0' } }],
              visible: true,
              layer: 0,
              importScale: 1,
            },
          ],
          prefab: null,
        },
      ],
    };
    const g = SceneGraph.fromDocument(doc);
    g.updateWorldTransforms();
    const r = instantiateScene(g);
    expect(r.objects.length).toBe(0);
    expect(r.skipped[0]?.reason).toBe('组件或层级被隐藏');
  });
});
