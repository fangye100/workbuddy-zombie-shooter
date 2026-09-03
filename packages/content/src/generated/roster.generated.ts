/**
 * 角色名册（由 roster.json 生成）
 *
 * ⚠️ 自动生成，请勿手改 —— 改真源后重跑：
 *    node packages/content/scripts/gen-content.mjs
 *
 * 真源：
 *   assets/characters/roster.json
 *
 * ── 不可派生清单（真源里没有，故不生成；不要手写填表）──────────────
 *   ✗ CharacterPhysicsDef.capsuleRadius          roster 只有 height（身高），没有体型/肩宽/半径
 *   ✗ CharacterPhysicsDef.capsuleHeight          height 是"站高"，胶囊高还要减端半球，属物理调参
 *   ✗ CharacterPhysicsDef.mass                   roster 无质量字段
 *   ✗ CharacterPhysicsDef.navAgentRadius         导航半径属寻路调参，roster 无
 *   ✗ CharacterAiDef.turnRate                    roster 无转向速率
 *   ✗ CharacterAiDef.sightRange / fovDeg / hearingRange roster 无感知参数
 *   ✗ CharacterAiDef.aggression                  roster 只有 threat（低/中/高/极高）定性档，无数值
 *   ✗ CharacterAiDef.archetype                   roster 的 ai 字段是出图提示词，不是行为原型枚举
 *   ✗ HurtboxDef.bone/radius                     roster 无骨骼名与部位半径；weakness 是散文（"头部 ×2.5"）
 *   ✗ boss 招式数值                                  attacks[].desc 是中文散文（"前摇 0.9 s，半径 4 m，伤害 30"），非结构化
 *   ✗ BodyPartDef.mesh/material                  roster 无网格/材质索引，需资产绑定后回填
 *
 * 这些字段等真源补结构化数据、或由独立的调参表承载后再接进来。
 * 在此之前手写数字 = 把编造值洗成"单一真源"，比硬编码更坏。
 */


export type CharacterKind = 'npc' | 'boss';

export interface RosterCharacter {
  readonly id: string;
  readonly kind: CharacterKind;
  readonly name: string;
  readonly en: string;
  /** 威胁档（真源是定性文字：低/中/高/极高） */
  readonly threat: string;
  /** 出场幕次 */
  readonly acts: readonly number[];
  /** 真源原始身高串，复合描述（如 "1.25 m（四足）/ 1.60 m（直立）"）原样保留 */
  readonly heightRaw: string;
  /** 身高（米）。取 heightRaw 里第一个数值 = 基准姿态；变体在括号里，不取 */
  readonly heightMeters: number;
  readonly speedRaw: string;
  /** 基础速度（m/s）。取 speedRaw 第一个数值，括号内的冲锋速度不取。
   *  **null = 真源明示不可移动**（如 B-02 母体 "本体固定不可移动"），
   *  不是 0 —— 0 是编的，null 是事实。用到时请显式处理 null。 */
  readonly speedMps: number | null;
  readonly hp: number;
  /** 面数预算 */
  readonly tris: number;
  /** 主色键，指向 CORE_COLORS */
  readonly accent: string;
}

export const ROSTER_CHARACTERS: readonly RosterCharacter[] = [
  {
    id: "E-01",
    kind: "npc",
    name: "游荡者",
    en: "Shambler",
    threat: "低",
    acts: [1, 2, 3, 4],
    heightRaw: "1.75 m",
    heightMeters: 1.75,
    speedRaw: "1.4 m/s",
    speedMps: 1.4,
    hp: 60,
    tris: 900,
    accent: "zombie",
  },
  {
    id: "E-02",
    kind: "npc",
    name: "扑跃者",
    en: "Lunger",
    threat: "中",
    acts: [1, 2, 3, 4],
    heightRaw: "1.25 m（四足）/ 1.60 m（直立）",
    heightMeters: 1.25,
    speedRaw: "3.2 m/s（扑跃 8 m/s）",
    speedMps: 3.2,
    hp: 45,
    tris: 1100,
    accent: "blood",
  },
  {
    id: "E-03",
    kind: "npc",
    name: "呕吐者",
    en: "Spitter",
    threat: "中",
    acts: [2, 3, 4],
    heightRaw: "1.70 m",
    heightMeters: 1.7,
    speedRaw: "1.0 m/s",
    speedMps: 1,
    hp: 70,
    tris: 1200,
    accent: "zombie",
  },
  {
    id: "E-04",
    kind: "npc",
    name: "盾卫",
    en: "Bulwark",
    threat: "高",
    acts: [2, 3, 4],
    heightRaw: "2.05 m",
    heightMeters: 2.05,
    speedRaw: "1.8 m/s（冲锋 6 m/s）",
    speedMps: 1.8,
    hp: 220,
    tris: 1600,
    accent: "teal",
  },
  {
    id: "E-05",
    kind: "npc",
    name: "爆尸",
    en: "Bloater",
    threat: "高",
    acts: [3, 4],
    heightRaw: "1.60 m / 直径 1.50 m",
    heightMeters: 1.6,
    speedRaw: "1.1 m/s",
    speedMps: 1.1,
    hp: 90,
    tris: 1000,
    accent: "warn",
  },
  {
    id: "B-01",
    kind: "boss",
    name: "屠夫",
    en: "THE BUTCHER",
    threat: "极高",
    acts: [1],
    heightRaw: "3.2 m",
    heightMeters: 3.2,
    speedRaw: "2.2 m/s（冲锋 9 m/s）",
    speedMps: 2.2,
    hp: 4200,
    tris: 4200,
    accent: "blood",
  },
  {
    id: "B-02",
    kind: "boss",
    name: "母体",
    en: "THE BROODMOTHER",
    threat: "极高",
    acts: [2],
    heightRaw: "4.0 m（上半身 2.4 m）",
    heightMeters: 4,
    speedRaw: "本体固定不可移动",
    speedMps: null,
    hp: 6000,
    tris: 6000,
    accent: "toxic",
  },
  {
    id: "B-03",
    kind: "boss",
    name: "零号",
    en: "PATIENT ZERO",
    threat: "极高",
    acts: [4],
    heightRaw: "2.6 m",
    heightMeters: 2.6,
    speedRaw: "3.0 m/s（P3 狂暴 ×1.6）",
    speedMps: 3,
    hp: 9000,
    tris: 5200,
    accent: "toxic",
  },
];

const BY_ID: ReadonlyMap<string, RosterCharacter> = new Map(
  ROSTER_CHARACTERS.map((c) => [c.id, c]),
);

/** 按 id 取角色；不存在直接抛错 —— 宁可启动失败，也不给 undefined 让 bug 潜伏。 */
export function requireCharacter(id: string): RosterCharacter {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`roster.json 里没有角色 ${id}（已载入：${[...BY_ID.keys()].join(', ')}）`);
  return c;
}

export const ROSTER_VERSION = "1.0.0" as const;
