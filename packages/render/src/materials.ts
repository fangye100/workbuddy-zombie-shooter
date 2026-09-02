/**
 * 材质数据契约（引擎层，纯数据 + 纯函数，不碰 GPU / DOM / 编辑器参数）。
 *
 * 这是渲染器上传到 GPU 的材质本体内核：一个子网格最终生效的就是 MaterialState。
 * 子网格槽位（MaterialSlot）、材质实例（MaterialInstance）、以及共享/实例/覆盖
 * 三层的 id 方案（sharedId/sharedIndex/isInstanceId）也在此定义——它们是纯原语，
 * 不依赖任何编辑器状态。
 *
 * 编辑器侧（apps/editor）的 MaterialLibrary 在此之上叠加"把槽位解析到
 * LabParams.materials 共享库"的逻辑（见 apps/lab/src/materials.ts）。
 */

/** 单个材质的可写数据本体（渲染器装箱进 uniform 的就是它） */
export interface MaterialState {
  albedo: string;
  roughness: number;
  metallic: number;
  emissiveColor: string;
  emissiveStrength: number;
  /** 材质级分阶阈值；< 0 表示跟随全局 */
  shadowEnd: number;
  /** 材质级高光混合；< 0 表示跟随全局 */
  specMix: number;
  /** 软边倍率，布料等柔和材质放大 */
  softnessScale: number;
  /** 半调强度倍率 */
  halftoneScale: number;
  /** 描边宽度倍率 */
  outlineScale: number;
  /** 自发光材质：跳过全部分阶 */
  unlit: boolean;
}

export type MaterialKind = 'shared' | 'instance';
/** 子网格材质槽当前的来源层级（override 不是库条目，是槽位上的局部副本） */
export type MaterialSource = 'shared' | 'instance' | 'override';

/** 材质库下拉项 */
export interface MaterialRef {
  id: string;
  name: string;
  kind: MaterialKind;
}

/** 用户创建的材质实例 */
export interface MaterialInstance {
  id: string;
  name: string;
  /** 派生来源 id（仅用于溯源展示，创建后不再联动） */
  baseId: string | null;
  state: MaterialState;
}

/**
 * 材质槽：一条子网格挂一份。这是「数据隔离」的核心结构 ——
 * materialId 指向材质库，override 是本槽的局部副本，两者互不干扰。
 */
export interface MaterialSlot {
  /** 库条目 id（共享或实例） */
  materialId: string;
  /** 局部覆盖：非 null 时优先于库条目，只作用于这一条子网格 */
  override: MaterialState | null;
}

const SHARED_PREFIX = 's';
const INSTANCE_PREFIX = 'i';

/** 共享材质 id：与共享材质库的下标一一对应 */
export function sharedId(index: number): string {
  return `${SHARED_PREFIX}${index}`;
}

/** 从 id 反解共享材质下标；非共享 id 返回 null */
export function sharedIndex(id: string): number | null {
  if (id.length < 2 || id[0] !== SHARED_PREFIX) return null;
  const n = Number(id.slice(1));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function isInstanceId(id: string): boolean {
  return id.length >= 2 && id[0] === INSTANCE_PREFIX;
}

export function cloneMaterial(m: MaterialState): MaterialState {
  return { ...m };
}

/**
 * 槽位的来源层级：override（本 mesh）> instance（库实例）> shared（共享材质）。
 * 纯函数，不依赖编辑器参数。
 */
export function slotSource(slot: MaterialSlot): MaterialSource {
  if (slot.override !== null) return 'override';
  return isInstanceId(slot.materialId) ? 'instance' : 'shared';
}

/**
 * 子网格条数的预算裁剪（纯函数，便于单测）。
 *
 * uniform 材质槽是固定容量，写越界 = WebGPU 校验错误 = 整页黑屏。
 * 所以「拆出来的条数装不下」时整体退化为 1 条（用整物体当一条子网格），
 * 而不是截断——截断会静默丢掉模型后半部分的几何，比少拆危险得多。
 *
 * @param requested   想拆成几条（0 或负 = 调用方没给 primitive 信息）
 * @param usedByOthers 场景里其他物体已经占掉的槽位数
 * @param capacity    全局槽位容量
 */
export function planSubMeshCount(requested: number, usedByOthers: number, capacity: number): number {
  if (requested <= 0) return 1;
  const budget = Math.max(1, capacity - usedByOthers);
  return requested <= budget ? requested : 1;
}
