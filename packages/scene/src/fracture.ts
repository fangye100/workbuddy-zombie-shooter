import type { AssetRef, Quat, Vec3 } from './document';
import { validVfxRef as validAssetGuidRef } from './vfx';

/**
 * 独立破碎资产（`.fracture.json`）的数据契约，scene 拥有格式。
 *
 * 只存引用与可静态校验的标量：碎块几何永远是 GLB AssetRef，物理代理是有界基本体
 * 或离线凸包引用；GPU 缓冲、物理世界句柄、运行碎块位置一律不落盘。
 *
 * SOT 边界（WU-01 冻结）：
 * - 物体耐久/触发条件：场景组件保存初始配置（DestructibleComponent）；
 *   当前耐久与损坏状态转换属于 Play runtime 副本，由游戏内核拥有。
 * - NPC 致死策略：可复用部分落角色/actor profile 引用的 fracture 资产（kind='npc'）；
 *   场景特有覆盖落场景。普通未配置 NPC 继续原死亡表现。
 * - 碰撞/导航关联：组件只声明破坏后策略；实际移除由游戏内核复用既有
 *   collider/动态导航阻挡机制执行，Stop 回滚恢复作者状态。
 */
export const FRACTURE_VERSION = 1;

/** 资产库离线预算：限制单资产可制作的碎块规模，不是运行时活动上限。 */
export const FRACTURE_BUDGET = { chunks: 64, largeChunks: 32, boneMapEntries: 192 } as const;

export type FractureAssetKind = 'object' | 'npc';
export type FractureChunkClass = 'large' | 'small';

/** 有界碰撞代理；动态碎块不默认使用任意凹三角网格。 */
export type FractureProxyShape =
  | { type: 'box'; halfExtents: Vec3 }
  | { type: 'sphere'; radius: number }
  | { type: 'capsule'; halfHeight: number; radius: number }
  | { type: 'convex'; mesh: AssetRef & { guid: string } };

export interface FractureProxy {
  shape: FractureProxyShape;
  /** 千克；实际进入物理求解（WU-03）。 */
  mass: number;
  friction: number;
  restitution: number;
  /** 首期碰撞分组：静态环境互撞或碎屑组，不自动撞飞玩家/NPC。 */
  collisionGroup: 'environment' | 'debris';
  maxLinearSpeed?: number;
  maxAngularSpeed?: number;
}

/** 单个碎块。chunkId 在资产内稳定唯一，跨文件引用不用数组下标。 */
export interface FractureChunk {
  chunkId: string;
  class: FractureChunkClass;
  /** 碎块 GLB（外表面 + 封口/内部表面在同一引用内，经 sub 定位）。 */
  mesh: AssetRef & { guid: string };
  /** 资产局部坐标下的还原 TRS；完整组装时与原模型对齐。 */
  bind: { position: Vec3; rotation: Quat; scale: Vec3 };
  /** 碎块局部质心/枢轴（米）。 */
  pivot: Vec3;
  proxy: FractureProxy;
}

/** NPC 对齐契约：原 actor/rig 的稳定身份、骨骼映射与归一化尺度。 */
export interface FractureNpcAlignment {
  actorId: string;
  mode: 'skinned' | 'baked';
  /** 碎块蒙皮分块 → 骨名；稳定标识，不保存骨骼下标。 */
  boneMap: Record<string, string>;
  normalizeHeightM: number | null;
  footOffsetM: number;
}

/** 播放策略：分类/优先级/寿命与可选原 VFX 伴随；不包含伤害公式。 */
export interface FracturePlayback {
  priority: number;
  lifetimeSec: number;
  fadeSec: number;
  companionVfx: { resource: AssetRef & { guid: string }; effectKey: string } | null;
}

export interface FractureAsset {
  version: number;
  /** 必须等于 sidecar `.meta.json` 的 guid（与 VFX 资产同约定）。 */
  id: string;
  name: string;
  status: 'accepted' | 'quarantined';
  kind: FractureAssetKind;
  /** 完整模型与来源记录；许可/来源审计在 WU-02 落地。 */
  source: { model: AssetRef & { guid: string }; origin: string };
  /** 资产局部单位 → 米的唯一换算系数；离线导出与 runtime 不得各缩放一遍。 */
  assemblyScale: number;
  chunks: FractureChunk[];
  npc: FractureNpcAlignment | null;
  playback: FracturePlayback;
}

const CHUNK_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ACTOR_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** 破碎 profile 的类型化引用：路径必须是 assets/ 下带 GUID 的 .fracture.json。 */
export function validFractureProfileRef(value: unknown): value is AssetRef & { guid: string } {
  return validAssetGuidRef(value) && value.path.endsWith('.fracture.json');
}
const finite = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
const vec3 = (v: unknown, min: number, max: number): boolean =>
  Array.isArray(v) && v.length === 3 && v.every(n => finite(n, min, max));
const quat = (v: unknown): boolean =>
  Array.isArray(v) && v.length === 4 && v.every(n => finite(n, -1, 1)) && Math.abs(Math.hypot(...v as number[]) - 1) <= 0.001;

function validProxyShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const s = value as FractureProxyShape;
  if (s.type === 'box') return vec3(s.halfExtents, 0.001, 100);
  if (s.type === 'sphere') return finite(s.radius, 0.001, 100);
  if (s.type === 'capsule') return finite(s.halfHeight, 0.001, 100) && finite(s.radius, 0.001, 100);
  if (s.type === 'convex') return validAssetGuidRef(s.mesh) && s.mesh.path.endsWith('.glb');
  return false;
}

function validProxy(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const p = value as FractureProxy;
  return validProxyShape(p.shape) && finite(p.mass, 0.001, 10000) && finite(p.friction, 0, 2)
    && finite(p.restitution, 0, 1) && ['environment', 'debris'].includes(p.collisionGroup as string)
    && (p.maxLinearSpeed === undefined || finite(p.maxLinearSpeed, 0.1, 200))
    && (p.maxAngularSpeed === undefined || finite(p.maxAngularSpeed, 0.1, 200));
}

function validNpc(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const n = value as FractureNpcAlignment;
  return typeof n.actorId === 'string' && ACTOR_ID_RE.test(n.actorId) && ['skinned', 'baked'].includes(n.mode as string)
    && !!n.boneMap && typeof n.boneMap === 'object' && !Array.isArray(n.boneMap)
    && Object.keys(n.boneMap).length >= 1 && Object.keys(n.boneMap).length <= FRACTURE_BUDGET.boneMapEntries
    && Object.entries(n.boneMap).every(([block, bone]) => CHUNK_ID_RE.test(block) && typeof bone === 'string' && !!bone)
    && (n.normalizeHeightM === null || finite(n.normalizeHeightM, 0.1, 10)) && finite(n.footOffsetM, -1, 1);
}

function validPlayback(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const p = value as FracturePlayback;
  const companion = p.companionVfx;
  if (companion === undefined) return false;
  const validCompanion = companion === null
    || (!!companion && typeof companion === 'object' && validAssetGuidRef(companion.resource) && companion.resource.path.endsWith('.vfx.json')
      && typeof companion.effectKey === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(companion.effectKey));
  return Number.isInteger(p.priority) && p.priority >= 0 && p.priority <= 3
    && finite(p.lifetimeSec, 0.5, 30) && finite(p.fadeSec, 0, 5) && p.fadeSec <= p.lifetimeSec
    && validCompanion;
}

/** 静态校验，返回诊断列表；未来版本、坏代理、非法数值、重复 chunkId、超预算均显式报错。 */
export function validateFractureAsset(value: unknown): string[] {
  if (!value || typeof value !== 'object') return ['Fracture 资产必须是对象'];
  const a = value as FractureAsset, errors: string[] = [];
  if (a.version !== FRACTURE_VERSION) errors.push(`不支持 Fracture 版本 ${a.version}（当前 ${FRACTURE_VERSION}）`);
  if (typeof a.id !== 'string' || !a.id || typeof a.name !== 'string' || !a.name.trim()) errors.push('Fracture 缺少 id/name');
  if (!['accepted', 'quarantined'].includes(a.status)) errors.push('Fracture 验收状态非法');
  if (!['object', 'npc'].includes(a.kind)) errors.push('Fracture 资产 kind 必须是 object/npc');
  if (!a.source || !validAssetGuidRef(a.source.model) || !a.source.model.path.endsWith('.glb')
    || typeof a.source.origin !== 'string' || !a.source.origin.trim()) errors.push('Fracture 完整模型引用或来源记录非法');
  if (!finite(a.assemblyScale, 0.0001, 10000)) errors.push('Fracture assemblyScale 必须是有限正数');
  if (!Array.isArray(a.chunks) || a.chunks.length < 1 || a.chunks.length > FRACTURE_BUDGET.chunks) {
    errors.push(`Fracture 碎块数量必须为 1–${FRACTURE_BUDGET.chunks}`);
    return errors;
  }
  const seen = new Set<string>();
  let large = 0;
  for (const [i, c] of a.chunks.entries()) {
    const at = `碎块[${i}]`;
    if (!c || typeof c !== 'object') { errors.push(`${at} 不是对象`); continue; }
    if (typeof c.chunkId !== 'string' || !CHUNK_ID_RE.test(c.chunkId)) errors.push(`${at} chunkId 非法`);
    else if (seen.has(c.chunkId)) errors.push(`chunkId 重复：${c.chunkId}`);
    if (typeof c.chunkId === 'string') seen.add(c.chunkId);
    if (c.class === 'large') large++;
    else if (c.class !== 'small') errors.push(`${at} class 必须是 large/small`);
    if (!validAssetGuidRef(c.mesh) || !c.mesh.path.endsWith('.glb')) errors.push(`${at} 碎块几何引用非法`);
    if (!c.bind || !vec3(c.bind.position, -10000, 10000) || !quat(c.bind.rotation) || !vec3(c.bind.scale, 0.01, 100)) errors.push(`${at} 还原 TRS 非法`);
    if (!vec3(c.pivot, -10000, 10000)) errors.push(`${at} pivot 非法`);
    if (!validProxy(c.proxy)) errors.push(`${at} 碰撞代理非法（形状/质量/摩擦/恢复系数/碰撞组越界）`);
  }
  if (large > FRACTURE_BUDGET.largeChunks) errors.push(`large 碎块超过资产预算（${large} > ${FRACTURE_BUDGET.largeChunks}）`);
  if (a.kind === 'npc' && !validNpc(a.npc)) errors.push('NPC 破碎资产必须携带合法 actor/骨骼映射对齐块');
  if (a.kind === 'object' && a.npc !== null && a.npc !== undefined) errors.push('物体破碎资产不能携带 NPC 对齐块');
  if (a.npc !== null && a.npc !== undefined && !!a.npc && typeof a.npc === 'object' && !!a.npc.boneMap && typeof a.npc.boneMap === 'object' && !Array.isArray(a.npc.boneMap))
    for (const block of Object.keys(a.npc.boneMap)) if (!seen.has(block)) errors.push(`骨骼映射指向不存在的碎块：${block}`);
  if (!validPlayback(a.playback)) errors.push('Fracture 播放策略非法（优先级/寿命/淡出/伴随 VFX）');
  return errors;
}

/** 显式资产迁移；调用方保留磁盘原对象用于 CAS。 */
export function migrateFractureAsset(value: unknown): FractureAsset {
  const errors = validateFractureAsset(value);
  if (errors.length) throw new Error(errors.join('；'));
  return structuredClone(value) as FractureAsset;
}

/** 全部带 GUID 的类型化引用，供跨文件身份校验与改名事务使用。 */
export function fractureAssetRefs(asset: FractureAsset): Array<AssetRef & { guid: string }> {
  const refs: Array<AssetRef & { guid: string }> = [asset.source.model];
  for (const chunk of asset.chunks) {
    refs.push(chunk.mesh);
    if (chunk.proxy.shape.type === 'convex') refs.push(chunk.proxy.shape.mesh);
  }
  if (asset.playback.companionVfx) refs.push(asset.playback.companionVfx.resource);
  return refs;
}

/**
 * 可破坏物体组件：只保存 profile 引用与初始作者配置。
 * 当前耐久、一次性损坏转换、碰撞/导航移除属于 Play runtime，由游戏内核拥有。
 */
export interface DestructibleComponent {
  kind: 'Destructible';
  enabled: boolean;
  profile: AssetRef & { guid: string };
  maxDurability: number;
  /** 允许推进/完成破坏的伤害来源；DOT 不借用同帧直接命中序号。 */
  trigger: { direct: boolean; explosion: boolean; burn: boolean };
  onBroken: { collider: 'remove' | 'keep'; navigation: 'clear-blocking' | 'keep' };
}

export function validDestructible(value: unknown): value is DestructibleComponent {
  if (!value || typeof value !== 'object') return false;
  const c = value as DestructibleComponent;
  return c.kind === 'Destructible' && typeof c.enabled === 'boolean'
    && validFractureProfileRef(c.profile)
    && finite(c.maxDurability, 1, 1000000)
    && !!c.trigger && typeof c.trigger === 'object'
    && [c.trigger.direct, c.trigger.explosion, c.trigger.burn].every(v => typeof v === 'boolean')
    && !!c.onBroken && typeof c.onBroken === 'object'
    && ['remove', 'keep'].includes(c.onBroken.collider as string)
    && ['clear-blocking', 'keep'].includes(c.onBroken.navigation as string);
}
