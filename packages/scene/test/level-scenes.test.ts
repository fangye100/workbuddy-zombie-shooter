/**
 * 关卡场景的门禁测试（`npm test` 覆盖）。
 *
 * 与 `scene-files.test.ts` 的分工：那个测**格式合法**（validateSceneDocument 零 error），
 * 这个测**在编辑器里真的能看见**。两者不是一回事 —— 一个场景可以格式完全合法、
 * 同时在编辑器里一个像素都没有。
 *
 * 为什么必须有这一层（两条都是真踩过的坑）：
 *
 * 1. **gizmo 约定**：`instantiateScene` 只处理 `MeshRenderer`，其余组件一律 skipped。
 *    所以「新增一种语义节点（刷怪点 / 房间体 / 掉落点）却忘了挂 MeshRenderer」的表现
 *    是**静默隐形**——文件合法、校验全绿、编辑器里啥也没有。这条断言把它变成红灯。
 *
 * 2. **64 物件上限**：`MAX_OBJECTS` 超了 `applySpecs` 会 throw，catch 后整体回退
 *    `buildDefaultSpecs()`。表现是「我生成的关卡消失了，变回默认场景」，**不报错**。
 *    GDD 改一版房间数就可能撑爆，这里提前拦住。
 *
 * 数据来源：assets/scenes/act1/*.scene.json，由 tools/level/gen-level.mjs 生成。
 * 用 import.meta.glob 而非 node:fs（本仓库无 @types/node，types 是白名单）。
 */
import { describe, it, expect } from 'vitest';
import { ComponentKind, validateSceneDocument, type SceneDocument } from '../src/document';
import { SceneGraph, MAX_NODES } from '../src/graph';
import { instantiateScene } from '../src/instantiate';

const levelModules = import.meta.glob('/assets/scenes/act1/*.scene.json', {
  eager: true,
  import: 'default',
}) as Record<string, SceneDocument>;

/**
 * **必须可见**的语义组件：这些节点没挂 MeshRenderer 就是在编辑器里隐形。
 *
 * 房间体与刷怪点是**关卡评审要看的内容**（布局、密度、动线），隐形 = 这份数据等于没生成。
 *
 * `NavZone` 故意不在此列：它是 packages/ai 流场寻路的**烘焙作用域**，属于运行时
 * 调试数据，不是要评审的关卡内容；而且当前材质库没有半透明材质，画出来只会挡住地板。
 * 等有 gizmo 层 / 半透明材质再把它纳入。
 */
const MUST_BE_VISIBLE_KINDS: readonly string[] = [
  ComponentKind.RoomVolume,
  ComponentKind.SpawnPoint,
];

describe('关卡场景（tools/level/gen-level.mjs 生成）', () => {
  const files = Object.keys(levelModules);

  it('assets/scenes/act1 下至少有一层关卡', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s 通过 validateSceneDocument（零 error）', (file) => {
    const errors = validateSceneDocument(levelModules[file]).filter((d) => d.severity === 'error');
    expect(errors.map((e) => `${e.path} ${e.code} ${e.message}`)).toEqual([]);
  });

  it.each(files)('%s 实例化后至少有一个可渲染物件', (file) => {
    const doc = levelModules[file];
    if (doc === undefined) return;
    const graph = SceneGraph.fromDocument(doc);
    graph.updateWorldTransforms();
    const { objects } = instantiateScene(graph);
    expect(objects.length).toBeGreaterThan(0);
  });

  it.each(files)('%s 可渲染物件数不超过 MAX_OBJECTS', (file) => {
    const doc = levelModules[file];
    if (doc === undefined) return;
    const graph = SceneGraph.fromDocument(doc);
    graph.updateWorldTransforms();
    const { objects } = instantiateScene(graph);
    // 超了不是截断，是整场景被丢弃 + 回退默认场景，所以这里必须是硬失败
    expect(objects.length).toBeLessThanOrEqual(MAX_NODES);
  });

  it.each(files)('%s 每个语义节点都挂了 MeshRenderer（gizmo 约定）', (file) => {
    const doc = levelModules[file];
    if (doc === undefined) return;
    const offenders: string[] = [];
    for (const node of doc.nodes) {
      const kinds = node.components.map((c) => c.kind);
      const hasSemantic = kinds.some((k) => MUST_BE_VISIBLE_KINDS.includes(k));
      if (hasSemantic && !kinds.includes(ComponentKind.MeshRenderer)) {
        offenders.push(`${node.id}（${node.name}）组件：${kinds.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(files)('%s 场景 id 与文件名对应的楼层一致', (file) => {
    const doc = levelModules[file];
    if (doc === undefined) return;
    const depth = /floor-(\d+)\.scene\.json$/.exec(file)?.[1];
    expect(doc.id).toContain(`floor${depth}`);
    // GDD §4.1：固定 3 层，depth 只能是 1..3
    expect(Number(depth)).toBeGreaterThanOrEqual(1);
    expect(Number(depth)).toBeLessThanOrEqual(3);
  });
});
