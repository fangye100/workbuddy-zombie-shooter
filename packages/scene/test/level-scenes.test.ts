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
import {
  ComponentKind,
  SCHEMA_VERSION,
  validateSceneDocument,
  type SceneDocument,
} from '../src/document';
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

describe('关卡场景 · 外部资产引用（ADR-018 P4b 门禁）', () => {
  // 与 gen-level.mjs 的 actCoverProps 一致：Act1 每层掩体应引用这些真实道具 GLB。
  // 这条断言看守的是「重生成退化回纯 box 也全绿」的变异 —— 没有它，
  // 删掉 renderer 的 pendingAssets.push 后 1085 条测试依然全绿（P4b 复审实测）。
  const ENV_GLBS = import.meta.glob('/assets/environment/models/**/tex2/*.glb', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
  const knownPaths = new Set(
    Object.keys(ENV_GLBS).map((k) => k.replace(/^\//, '').replace(/\\/g, '/')),
  );
  const levelFiles = Object.keys(levelModules);
  const sidecars = import.meta.glob('/assets/environment/models/**/tex2/*.glb.meta.json', { eager: true, import: 'default' }) as Record<string, { guid: string }>;
  const propModules = import.meta.glob('/assets/environment/props.json', { eager: true, import: 'default' }) as Record<string, { entries: { id: string; footprint: number[] }[] }>;

  it('places every delivered environment model in the campaign with resolved GUIDs and dependencies', () => {
    const placed = new Set<string>();
    for (const doc of Object.values(levelModules)) {
      for (const node of doc.nodes) for (const c of node.components) {
        if (c.kind !== 'MeshRenderer' || c.source.type !== 'asset') continue;
        const ref = c.source.ref;
        if (!/assets\/environment\/models\/[PS]-\d+\//.test(ref.path)) continue;
        expect(knownPaths.has(ref.path), node.id).toBe(true);
        expect(ref.guid, node.id).toBe(sidecars[`/${ref.path}.meta.json`]?.guid);
        expect(doc.dependencies, node.id).toContain(ref.path);
        expect(node.visible, node.id).toBe(true);
        placed.add(/models\/([^/]+)\//.exec(ref.path)![1]!);
      }
    }
    expect([...placed].sort()).toEqual(Object.values(propModules)[0]!.entries.map(p => p.id).sort());
  });

  it('optional asset GUIDs round-trip and reject invalid values', () => {
    const doc = JSON.parse(JSON.stringify(levelModules[levelFiles[0]!])) as SceneDocument;
    const cover = doc.nodes.find((node) => /_cv\d+$/.test(node.id))!;
    const mr = cover.components.find((c) => c.kind === 'MeshRenderer');
    if (mr?.kind !== 'MeshRenderer' || mr.source.type !== 'asset') throw new Error('Missing cover');
    expect(mr.source.ref.guid).toBeTruthy();
    mr.source.ref.guid = '';
    expect(validateSceneDocument(doc).map((d) => d.code)).toContain('E_MESH_GUID');
    delete mr.source.ref.guid;
    expect(validateSceneDocument(doc).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it.each(levelFiles)('%s environment GUIDs and collision dimensions match their assets', (file: string) => {
    const doc = levelModules[file] as SceneDocument;
    const props = Object.values(propModules)[0]!.entries;
    for (const n of doc.nodes.filter((node) => /_cv\d+$/.test(node.id))) {
      const mr = n.components.find((c) => c.kind === 'MeshRenderer');
      if (mr?.kind !== 'MeshRenderer' || mr.source.type !== 'asset') throw new Error('Missing cover asset');
      const ref = mr.source.ref;
      expect(ref.guid).toBe(sidecars[`/${ref.path}.meta.json`]!.guid);
      const id = /models\/([^/]+)\//.exec(ref.path)![1]!;
      const [w, d, h] = props.find((e) => e.id === id)!.footprint as [number, number, number];
      const collider = n.components.find((c) => c.kind === 'Collider');
      if (collider?.kind !== 'Collider' || collider.shape.type !== 'box') throw new Error('Missing cover collider');
      expect(collider.shape.halfExtents).toEqual([w / 2, h / 2, d / 2]);
    }
  });

  it.each(levelFiles)('%s 掩体（category=道具 的 _cv 节点）全部引用真实 GLB', (file: string) => {
    const doc = levelModules[file] as SceneDocument;
    if (doc === undefined) return;
    const covers = doc.nodes.filter((n) => /_cv\d+$/.test(n.id));
    expect(covers.length).toBeGreaterThanOrEqual(3);
    for (const n of covers) {
      const mr = n.components.find((c) => c.kind === 'MeshRenderer') as
        | { source: { type: string; ref: { path: string } } }
        | undefined;
      expect(mr).toBeDefined();
      expect(mr!.source.type).toBe('asset');
      // 引用的 GLB 必须真实存在（防手滑写错路径 → 编辑器补载静默失败）
      expect(knownPaths.has(mr!.source.ref.path.replace(/\\/g, '/'))).toBe(true);
    }
  });

  it.each(levelFiles)('%s 资产引用数量 ≥ 该层掩体数（补载有东西可换）', (file: string) => {
    const doc = levelModules[file] as SceneDocument;
    if (doc === undefined) return;
    let assetCount = 0;
    for (const n of doc.nodes) {
      for (const c of n.components) {
        if (c.kind === 'MeshRenderer' && (c as { source: { type: string } }).source.type === 'asset') {
          assetCount++;
        }
      }
    }
    const covers = doc.nodes.filter((n) => /_cv\d+$/.test(n.id));
    expect(assetCount).toBeGreaterThanOrEqual(covers.length);
  });
});

// ---------------------------------------------------------------------------
// 评审回归（PR #20 · bot review）：关卡生成器不许落后于 schema 真源
// ---------------------------------------------------------------------------

/**
 * 生成器源码（raw）。
 *
 * 为什么必须加这一层：生成器写死自己的 schema 版本号，schema 一抬版它就悄悄落后
 * —— 落后时**没有任何自动化会报警**，直到有人重跑生成器，把作者楼层整体降级、
 * `migrate-scenes --check` 才在另一个人手里炸开（PR #20 评审实测：gen-level 停在
 * v4、sim-level 停在 v3，而真源已经是 v5）。
 */
const TOOL_SOURCES = import.meta.glob('/tools/level/*.mjs', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

function tool(name: string): string {
  const key = Object.keys(TOOL_SOURCES).find((k) => k.endsWith(`/${name}.mjs`));
  if (key === undefined) throw new Error(`找不到工具源码：${name}.mjs`);
  return TOOL_SOURCES[key]!;
}

describe('关卡工具 · schema 版本必须与真源一致（评审 4171651527 / 4171651540）', () => {
  it('gen-level.mjs 的 SCHEMA_VERSION === document.ts 的 SCHEMA_VERSION', () => {
    const m = /const SCHEMA_VERSION\s*=\s*(\d+)/.exec(tool('gen-level'));
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(SCHEMA_VERSION);
  });

  it('sim-level.mjs 的 SUPPORTED_SCHEMA === document.ts 的 SCHEMA_VERSION', () => {
    const m = /const SUPPORTED_SCHEMA\s*=\s*(\d+)/.exec(tool('sim-level'));
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(SCHEMA_VERSION);
  });

  it('gen-level 生成的 Camera 组件带 v5 的 yawMode（否则重跑即产生降级 diff）', () => {
    const src = tool('gen-level');
    // 取 Camera 组件模板块（kind: 'Camera' 之后的 12 行内）
    const i = src.indexOf("kind: 'Camera'");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 400)).toContain('yawMode');
  });

  it('sim-level 的快照场景保留 loseCondition（派生产物不能丢真源字段）', () => {
    expect(tool('sim-level')).toContain('loseCondition');
  });
});
