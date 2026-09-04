/**
 * SceneDocument schema 测试（ADR-009：测试与被测代码同位，packages/scene/test/）。
 *
 * 这里只测**数据契约**，不碰 GPU、不碰文件系统——schema 是场景系统的地基，
 * 它必须能在纯 Node 下被完整验证（ADR-003 第一层 / ADR-008 结论可复现）。
 */
import { describe, it, expect } from 'vitest';
import {
  SCHEMA_VERSION,
  ComponentKind,
  REPEATABLE_COMPONENTS,
  createEmptySceneDocument,
  validateSceneDocument,
  isSceneDocumentValid,
  identityTransform,
  type SceneDocument,
  type SceneNode,
  type SceneDiagnostic,
} from '../src/document';

/** 只取 error 的 code 列表，便于断言 */
function codes(docs: SceneDiagnostic[]): string[] {
  return docs.filter((d) => d.severity === 'error').map((d) => d.code);
}
function warns(docs: SceneDiagnostic[]): string[] {
  return docs.filter((d) => d.severity === 'warning').map((d) => d.code);
}

describe('createEmptySceneDocument', () => {
  it('产出的空场景必须通过校验（合法基线）', () => {
    const doc = createEmptySceneDocument('Test Scene');
    const diagnostics = validateSceneDocument(doc);
    expect(codes(diagnostics)).toEqual([]);
    expect(isSceneDocumentValid(doc)).toBe(true);
  });

  it('带一盏主光与一台相机，且 entryCamera 指向真实节点', () => {
    const doc = createEmptySceneDocument('Test Scene');
    const lights = doc.nodes.flatMap((n) => n.components.filter((c) => c.kind === ComponentKind.Light));
    const cameras = doc.nodes.flatMap((n) => n.components.filter((c) => c.kind === ComponentKind.Camera));
    expect(lights).toHaveLength(1);
    expect(cameras).toHaveLength(1);
    expect(doc.nodes.some((n) => n.id === doc.entryCamera)).toBe(true);
  });

  it('节点 id 唯一、schemaVersion 与常量一致', () => {
    const doc = createEmptySceneDocument('Test Scene');
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(new Set(doc.nodes.map((n) => n.id)).size).toBe(doc.nodes.length);
  });
});

describe('identityTransform', () => {
  it('是单位变换（四元数 xyzw = 0001）', () => {
    const t = identityTransform();
    expect(t.position).toEqual([0, 0, 0]);
    expect(t.rotation).toEqual([0, 0, 0, 1]);
    expect(t.scale).toEqual([1, 1, 1]);
  });

  it('每次调用返回独立对象（避免共享可变状态）', () => {
    const a = identityTransform();
    const b = identityTransform();
    a.position[0] = 42;
    expect(b.position[0]).toBe(0);
  });
});

describe('validateSceneDocument · 根节点', () => {
  it('非对象根节点 → E_NOT_OBJECT', () => {
    expect(codes(validateSceneDocument(null))).toContain('E_NOT_OBJECT');
    expect(codes(validateSceneDocument('scene'))).toContain('E_NOT_OBJECT');
  });

  it('未来版本 → E_VERSION_FUTURE（拒绝加载，而不是偷偷降级）', () => {
    const doc = { ...createEmptySceneDocument('x'), schemaVersion: SCHEMA_VERSION + 1 };
    expect(codes(validateSceneDocument(doc))).toContain('E_VERSION_FUTURE');
  });

  it('旧版本 → W_VERSION_OLD（可加载，提示迁移）', () => {
    const doc = { ...createEmptySceneDocument('x'), schemaVersion: SCHEMA_VERSION - 1 };
    const d = validateSceneDocument(doc);
    expect(codes(d)).not.toContain('E_VERSION_FUTURE');
    expect(warns(d)).toContain('W_VERSION_OLD');
  });

  it('nodes 不是数组 → E_NODES 并提前返回（后续断言依赖 nodes）', () => {
    const doc = { ...createEmptySceneDocument('x'), nodes: 'nope' };
    expect(codes(validateSceneDocument(doc))).toContain('E_NODES');
  });
});

describe('validateSceneDocument · 节点', () => {
  const base = (): SceneDocument => createEmptySceneDocument('base');

  it('重复 id → E_NODE_ID_DUP', () => {
    const doc = base();
    const clone: SceneNode = { ...doc.nodes[0]! };
    doc.nodes.push(clone);
    expect(codes(validateSceneDocument(doc))).toContain('E_NODE_ID_DUP');
  });

  it('parent 指向不存在的节点 → E_PARENT_MISSING', () => {
    const doc = base();
    doc.nodes[1]!.parent = 'nd_ghost';
    expect(codes(validateSceneDocument(doc))).toContain('E_PARENT_MISSING');
  });

  it('parent 成环 → E_PARENT_CYCLE（否则运行时变换传播会死循环）', () => {
    const doc = base();
    const a = doc.nodes[0]!;
    const b = doc.nodes[1]!;
    b.parent = a.id;
    a.parent = b.id; // a→b→a
    expect(codes(validateSceneDocument(doc))).toContain('E_PARENT_CYCLE');
  });

  it('自环 → E_PARENT_CYCLE', () => {
    const doc = base();
    doc.nodes[0]!.parent = doc.nodes[0]!.id;
    expect(codes(validateSceneDocument(doc))).toContain('E_PARENT_CYCLE');
  });

  it('多层合法父子链不报环（防止环检测误伤）', () => {
    const doc = base();
    const [a, b] = [doc.nodes[0]!, doc.nodes[1]!];
    b.parent = a.id;
    const c: SceneNode = {
      id: 'nd_child01',
      name: 'Child',
      parent: b.id,
      transform: identityTransform(),
      visible: true,
      pickable: true,
      prefab: null,
      components: [],
    };
    doc.nodes.push(c);
    expect(codes(validateSceneDocument(doc))).toEqual([]);
  });

  it('四元数长度不对 → E_TRS_ROT', () => {
    const doc = base();
    // @ts-expect-error 故意构造非法数据
    doc.nodes[0]!.transform.rotation = [0, 0, 0];
    expect(codes(validateSceneDocument(doc))).toContain('E_TRS_ROT');
  });

  it('零四元数 → E_TRS_ROT_ZERO（不是 warning，它无法表示任何旋转）', () => {
    const doc = base();
    doc.nodes[0]!.transform.rotation = [0, 0, 0, 0];
    expect(codes(validateSceneDocument(doc))).toContain('E_TRS_ROT_ZERO');
  });

  it('scale 含 0 → W_TRS_SCALE_ZERO（可加载但矩阵不可逆，只警告）', () => {
    const doc = base();
    doc.nodes[0]!.transform.scale = [1, 0, 1];
    const d = validateSceneDocument(doc);
    expect(codes(d)).toEqual([]);
    expect(warns(d)).toContain('W_TRS_SCALE_ZERO');
  });

  it('position 含 NaN → E_TRS_POS（NaN 会污染整棵变换树）', () => {
    const doc = base();
    doc.nodes[0]!.transform.position = [Number.NaN, 0, 0];
    expect(codes(validateSceneDocument(doc))).toContain('E_TRS_POS');
  });
});

describe('validateSceneDocument · 组件', () => {
  const withNode = (components: SceneNode['components']): SceneDocument => {
    const doc = createEmptySceneDocument('base');
    doc.nodes.push({
      id: 'nd_test001',
      name: 'Test',
      parent: null,
      transform: identityTransform(),
      visible: true,
      pickable: true,
      prefab: null,
      components,
    });
    return doc;
  };

  it('未知组件类型 → E_COMPONENT_UNKNOWN', () => {
    // @ts-expect-error 故意塞入未注册的 kind
    const doc = withNode([{ kind: 'RigidBody', enabled: true }]);
    expect(codes(validateSceneDocument(doc))).toContain('E_COMPONENT_UNKNOWN');
  });

  it('同节点重复 Light → E_COMPONENT_DUP', () => {
    const light = (): SceneNode['components'][number] => ({
      kind: ComponentKind.Light,
      enabled: true,
      type: 'directional',
      color: '#ffffff',
      intensity: 1,
      range: 0,
      spotAngle: 0,
      castShadow: false,
      priority: 0,
    });
    const doc = withNode([light(), light()]);
    expect(codes(validateSceneDocument(doc))).toContain('E_COMPONENT_DUP');
  });

  it('Script 允许重复（在 REPEATABLE_COMPONENTS 白名单里）', () => {
    expect(REPEATABLE_COMPONENTS.has(ComponentKind.Script)).toBe(true);
    const script = (behavior: string): SceneNode['components'][number] => ({
      kind: ComponentKind.Script,
      enabled: true,
      behavior,
      params: {},
    });
    const doc = withNode([script('onDeath'), script('onSpawn')]);
    expect(codes(validateSceneDocument(doc))).toEqual([]);
  });

  it('point 光 range <= 0 → E_LIGHT_RANGE', () => {
    const doc = withNode([
      {
        kind: ComponentKind.Light,
        enabled: true,
        type: 'point',
        color: '#ff0000',
        intensity: 1,
        range: 0,
        spotAngle: 0,
        castShadow: false,
        priority: 0,
      },
    ]);
    expect(codes(validateSceneDocument(doc))).toContain('E_LIGHT_RANGE');
  });

  it('灯光颜色非法 → E_COLOR', () => {
    const doc = withNode([
      {
        kind: ComponentKind.Light,
        enabled: true,
        type: 'directional',
        color: 'red',
        intensity: 1,
        range: 0,
        spotAngle: 0,
        castShadow: false,
        priority: 0,
      },
    ]);
    expect(codes(validateSceneDocument(doc))).toContain('E_COLOR');
  });

  it('SpawnPoint 缺 characterId → E_SPAWN_CHAR（防止刷出空气）', () => {
    const doc = withNode([
      {
        kind: ComponentKind.SpawnPoint,
        enabled: true,
        characterId: '',
        count: 4,
        wave: 0,
        trigger: 'room-enter',
        delaySec: 0,
        radius: 2,
        prefab: null,
      },
    ]);
    expect(codes(validateSceneDocument(doc))).toContain('E_SPAWN_CHAR');
  });
});

describe('validateSceneDocument · 跨节点引用', () => {
  it('entryCamera 指向不存在的节点 → E_ENTRY_CAMERA', () => {
    const doc = createEmptySceneDocument('base');
    doc.entryCamera = 'nd_missing';
    expect(codes(validateSceneDocument(doc))).toContain('E_ENTRY_CAMERA');
  });

  it('entryCamera = null 合法（回落规则：场景首个 Camera → EditorCamera）', () => {
    const doc = createEmptySceneDocument('base');
    doc.entryCamera = null;
    expect(codes(validateSceneDocument(doc))).toEqual([]);
  });
});

describe('序列化往返', () => {
  it('JSON 往返后仍通过校验，且引用的对象语义不变', () => {
    const doc = createEmptySceneDocument('Act1 · 城郊公路');
    doc.act = 'act1';
    const round = JSON.parse(JSON.stringify(doc)) as SceneDocument;
    expect(round).toEqual(doc);
    expect(isSceneDocumentValid(round)).toBe(true);
  });

  it('扁平节点表往返不丢失 parent 拓扑', () => {
    const doc = createEmptySceneDocument('hierarchy');
    const root = doc.nodes[0]!;
    doc.nodes.push({
      id: 'nd_child01',
      name: 'Child',
      parent: root.id,
      transform: identityTransform(),
      visible: true,
      pickable: true,
      prefab: null,
      components: [],
    });
    const round = JSON.parse(JSON.stringify(doc)) as SceneDocument;
    const child = round.nodes.find((n) => n.id === 'nd_child01');
    expect(child?.parent).toBe(root.id);
    expect(round.nodes).toHaveLength(doc.nodes.length);
  });
});
