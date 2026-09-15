/**
 * runtime 的公共类型（引擎层，零依赖 —— 不 import @aether/*）。
 *
 * ## 为什么这个包不依赖任何东西
 * headless runtime 要能被三种宿主消费：① vitest 单测 ② Node 脚本（tsc→CJS 后 require）
 * ③ 将来的编辑器与游戏本体。任何一条外部依赖都会把某个宿主拖下水
 * （尤其 @aether/scene 是给浏览器 vite 环境写的）。
 * 因此本包只接受**纯数据**输入，产出**纯数据**输出，序列化交给调用方。
 */

/** 实体类别。用数值枚举：存进 Uint8Array，也便于将来按 kind 分桶批处理 */
export const AgentKind = {
  Player: 0,
  Zombie: 1,
} as const;
export type AgentKind = (typeof AgentKind)[keyof typeof AgentKind];

/**
 * 角色数值。切片阶段由调用方传入常数；后续应从 roster.json 的
 * `speed`（"1.4 m/s"）/ `height`（"1.75 m"）解析后喂进来。
 */
export interface CharacterStats {
  /** roster 的 id，如 'E-01' */
  id: string;
  /** 最大移动速度（米/秒） */
  speed: number;
  /** 碰撞/分离半径（米） */
  radius: number;
  /** 身高（米），仅用于导出快照时决定胶囊尺寸 */
  height: number;
}

/** 一次刷怪请求（由场景 SpawnPoint 转换而来） */
export interface SpawnRequest {
  /** 世界坐标中心 */
  x: number;
  z: number;
  characterId: string;
  count: number;
  /** 散布半径（米），对应 SpawnPoint.radius */
  spread: number;
  stats: CharacterStats;
}

/** 快照导出用的单个实体视图（纯数据，调用方负责转成场景节点） */
export interface AgentView {
  index: number;
  kind: AgentKind;
  characterId: string;
  x: number;
  z: number;
  /** 朝向（弧度，绕 Y 轴；0 = +X 方向） */
  yaw: number;
  radius: number;
  height: number;
  alive: boolean;
}
