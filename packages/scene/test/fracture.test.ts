import { describe, it, expect } from 'vitest';
import {
  FRACTURE_VERSION, FRACTURE_BUDGET,
  validateFractureAsset, migrateFractureAsset, fractureAssetRefs,
  validDestructible, type FractureAsset, type DestructibleComponent,
} from '../src/fracture';
import { createEmptySceneDocument, validateSceneDocument, identityTransform, type SceneNode, type SceneDocument } from '../src/document';
import { migrateToLatest } from '../src/migrate';

const meshRef = { path: 'assets/fracture/crate/crate-chunks.glb', guid: 'as_chunks1' };
const proxy = { shape: { type: 'box' as const, halfExtents: [0.2, 0.2, 0.2] as [number, number, number] }, mass: 4, friction: 0.6, restitution: 0.25, collisionGroup: 'debris' as const };

function asset(overrides: Partial<FractureAsset> = {}): FractureAsset {
  return {
    version: FRACTURE_VERSION,
    id: 'as_fract1',
    name: '木箱碎裂',
    status: 'accepted',
    kind: 'object',
    source: { model: { path: 'assets/fracture/crate/crate.glb', guid: 'as_crate1' }, origin: '正式交付资产' },
    assemblyScale: 1,
    chunks: [
      { chunkId: 'chunk-0001', class: 'large', mesh: meshRef, bind: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, pivot: [0, 0, 0], proxy },
      { chunkId: 'chunk-0002', class: 'small', mesh: meshRef, bind: { position: [0, 0.1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, pivot: [0, 0, 0], proxy },
    ],
    npc: null,
    playback: { priority: 1, lifetimeSec: 3, fadeSec: 0.5, companionVfx: null },
    ...overrides,
  };
}

describe('fracture 资产契约', () => {
  it('最小正式资产通过校验，quarantined 也是合法资产状态', () => {
    expect(validateFractureAsset(asset())).toEqual([]);
    expect(validateFractureAsset(asset({ status: 'quarantined' }))).toEqual([]);
  });

  it('未来版本、缺 id/name、非法状态/kind 显式诊断', () => {
    expect(validateFractureAsset(asset({ version: FRACTURE_VERSION + 1 }))).toContainEqual(expect.stringContaining('不支持 Fracture 版本'));
    expect(validateFractureAsset(asset({ id: '' }))).toContainEqual('Fracture 缺少 id/name');
    expect(validateFractureAsset(asset({ status: 'draft' } as unknown as FractureAsset))).toContainEqual('Fracture 验收状态非法');
    expect(validateFractureAsset(asset({ kind: 'prop' } as unknown as FractureAsset))).toContainEqual('Fracture 资产 kind 必须是 object/npc');
  });

  it('重复 chunkId、坏代理、非法数值、超预算均诊断', () => {
    const dup = asset();
    dup.chunks[1]!.chunkId = 'chunk-0001';
    expect(validateFractureAsset(dup)).toContainEqual('chunkId 重复：chunk-0001');

    const badProxy = asset();
    badProxy.chunks[0]!.proxy = { ...proxy, mass: Number.NaN };
    expect(validateFractureAsset(badProxy).some(e => e.includes('碰撞代理非法'))).toBe(true);

    const negative = asset();
    negative.chunks[0]!.proxy = { ...proxy, shape: { type: 'sphere', radius: -1 } };
    expect(validateFractureAsset(negative).some(e => e.includes('碰撞代理非法'))).toBe(true);

    const overBudget = asset({ chunks: Array.from({ length: FRACTURE_BUDGET.chunks + 1 }, (_, i) => ({
      chunkId: `chunk-${String(i).padStart(4, '0')}`, class: 'small' as const, mesh: meshRef,
      bind: { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] },
      pivot: [0, 0, 0] as [number, number, number], proxy,
    })) });
    expect(validateFractureAsset(overBudget)).toContainEqual(`Fracture 碎块数量必须为 1–${FRACTURE_BUDGET.chunks}`);
  });

  it('NPC 资产必须携带对齐块，物体资产禁止携带', () => {
    expect(validateFractureAsset(asset({ kind: 'npc' }))).toContainEqual('NPC 破碎资产必须携带合法 actor/骨骼映射对齐块');
    expect(validateFractureAsset(asset({ npc: { actorId: 'E-04', mode: 'skinned', boneMap: { 'chunk-0001': 'Bone.001' }, normalizeHeightM: 2.05, footOffsetM: 0 } } as unknown as FractureAsset))).toContainEqual('物体破碎资产不能携带 NPC 对齐块');
    expect(validateFractureAsset(asset({ kind: 'npc', npc: { actorId: 'E-04', mode: 'skinned', boneMap: { 'chunk-0001': 'Bone.001' }, normalizeHeightM: 2.05, footOffsetM: 0 } }))).toEqual([]);
  });

  it('FR-WU01-01：缺失 chunkId / 缺失 companionVfx 键返回诊断而不是漏报或抛异常', () => {
    const noChunkId = asset();
    delete (noChunkId.chunks[1]! as Partial<typeof noChunkId.chunks[1]>).chunkId;
    const errors = validateFractureAsset(noChunkId);
    expect(errors.some(e => e.includes('chunkId 非法'))).toBe(true);

    const noCompanion = asset({ playback: { priority: 1, lifetimeSec: 3, fadeSec: 0.5 } } as unknown as FractureAsset);
    expect(() => validateFractureAsset(noCompanion)).not.toThrow();
    expect(validateFractureAsset(noCompanion)).toContainEqual('Fracture 播放策略非法（优先级/寿命/淡出/伴随 VFX）');

    expect(validateFractureAsset(asset())).toEqual([]);
  });

  it('FR-WU01-01：bind 四元数必须是单位四元数（容差 0.001）', () => {
    const nonUnit = asset();
    nonUnit.chunks[0]!.bind.rotation = [1, 1, 1, 1];
    expect(validateFractureAsset(nonUnit).some(e => e.includes('还原 TRS 非法'))).toBe(true);

    const unit = asset();
    unit.chunks[0]!.bind.rotation = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    expect(validateFractureAsset(unit)).toEqual([]);
  });

  it('FR-WU01-01：NPC 骨骼映射 key 必须指向资产内真实存在的碎块', () => {
    const ghost = asset({ kind: 'npc', npc: { actorId: 'E-04', mode: 'skinned', boneMap: { 'chunk-9999': 'Bone.001' }, normalizeHeightM: 2.05, footOffsetM: 0 } });
    expect(validateFractureAsset(ghost)).toContainEqual('骨骼映射指向不存在的碎块：chunk-9999');

    const ok = asset({ kind: 'npc', npc: { actorId: 'E-04', mode: 'skinned', boneMap: { 'chunk-0001': 'Bone.001' }, normalizeHeightM: 2.05, footOffsetM: 0 } });
    expect(validateFractureAsset(ok)).toEqual([]);
  });

  it('迁移克隆结果且拒绝非法输入；类型化引用覆盖模型/碎块/凸包/伴随VFX', () => {
    const source = asset();
    const migrated = migrateFractureAsset(source);
    expect(migrated).toEqual(source);
    expect(migrated).not.toBe(source);
    expect(() => migrateFractureAsset(asset({ version: 99 }))).toThrow();

    const convex = asset({ chunks: [{ chunkId: 'chunk-0001', class: 'large', mesh: meshRef, bind: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, pivot: [0, 0, 0], proxy: { ...proxy, shape: { type: 'convex', mesh: { path: 'assets/fracture/crate/convex-0001.glb', guid: 'as_cvx0001' } } } }] });
    const withVfx = asset({ playback: { priority: 1, lifetimeSec: 3, fadeSec: 0.5, companionVfx: { resource: { path: 'assets/vfx/comic-blast.vfx.json', guid: 'as_vfx0001' }, effectKey: 'blast' } } });
    expect(fractureAssetRefs(convex).map(r => r.guid)).toEqual(['as_crate1', 'as_chunks1', 'as_cvx0001']);
    expect(fractureAssetRefs(withVfx).map(r => r.guid)).toContain('as_vfx0001');
  });
});

describe('Destructible 场景组件与 v24 迁移', () => {
  const component: DestructibleComponent = {
    kind: 'Destructible', enabled: true,
    profile: { path: 'assets/fracture/crate/crate.fracture.json', guid: 'as_fract1' },
    maxDurability: 120,
    trigger: { direct: true, explosion: true, burn: false },
    onBroken: { collider: 'remove', navigation: 'clear-blocking' },
  };
  const meshRenderer = { kind: 'MeshRenderer' as const, enabled: true, source: { type: 'builtin' as const, shape: 'box' as const, params: [1, 1, 1] }, materials: [], visible: true, layer: 0, importScale: 1 };

  function sceneWith(extra: unknown): SceneDocument {
    const doc = createEmptySceneDocument('destructible');
    const node: SceneNode = { id: 'nd_crate01', name: 'Crate', parent: null, transform: identityTransform(), visible: true, pickable: true, prefab: null, components: [meshRenderer, extra as never] };
    doc.nodes.push(node);
    return doc;
  }

  it('合法组件通过校验；坏引用/耐久/策略显式报错', () => {
    expect(validDestructible(component)).toBe(true);
    expect(validDestructible({ ...component, profile: { path: 'assets/fracture/crate/crate.json', guid: 'as_fract1' } })).toBe(false);
    expect(validDestructible({ ...component, maxDurability: 0 })).toBe(false);
    expect(validDestructible({ ...component, onBroken: { ...component.onBroken, collider: 'explode' } })).toBe(false);
    expect(validateSceneDocument(sceneWith(component)).filter(d => d.severity === 'error')).toEqual([]);
    expect(validateSceneDocument(sceneWith({ ...component, profile: { path: 'assets/fracture/crate/crate.vfx.json', guid: 'as_fract1' } })).some(d => d.code === 'E_DESTRUCTIBLE')).toBe(true);
  });

  it('必须挂在启用 MeshRenderer 的物体节点', () => {
    const doc = createEmptySceneDocument('destructible');
    doc.nodes.push({ id: 'nd_bare01', name: 'Bare', parent: null, transform: identityTransform(), visible: true, pickable: true, prefab: null, components: [component] });
    expect(validateSceneDocument(doc).some(d => d.code === 'E_DESTRUCTIBLE_MESH')).toBe(true);

    const noMesh = sceneWith(component);
    (noMesh.nodes.at(-1)!.components[0] as { enabled: boolean }).enabled = false;
    expect(validateSceneDocument(noMesh).some(d => d.code === 'E_DESTRUCTIBLE_MESH')).toBe(true);
  });

  it('v23→v24 只补可破坏组件支持，不改作者数据且幂等', () => {
    const current = createEmptySceneDocument('migrate');
    const input = { ...structuredClone(current), schemaVersion: 23 };
    const result = migrateToLatest(input);
    expect(result.applied).toEqual(['destructible-fracture-components']);
    expect(result.doc).toEqual(current);
    expect(migrateToLatest(result.doc).applied).toEqual([]);
  });
});
