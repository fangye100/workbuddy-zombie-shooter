// 自动生成，请勿手改 —— 真源 assets/characters/stats.json
//
// 角色运行时参数（物理 / AI 数值）。与 roster.generated.ts 分工：
//   roster.generated.ts  = 外观、叙事、威胁档（美术/设计资料库派生）
//   本文件               = 程序消费的运行时数值（作者数据）
//
// CharacterDef 需要的字段在 roster 里一项都没有（见 gen-content.mjs 的 UNDERIVABLE），
// 所以这些数字由人在 stats.json 里显式填写并注明来源，不是"从美术资料库算出来的"。
//
// ⚠️ defId = npcs 数组下标。**重排数组会改变 defId**，属破坏性变更。
//
// 生成：npm run content:gen

/** 单次攻击的战斗数值（P5，docs/23 §2.2/§2.6）。null = 该角色近战未定（四态机不 windup） */
export interface AttackStats {
  readonly kind?: 'melee' | 'pounce' | 'charge' | 'acid' | 'explode';
  readonly speedMps?: number;
  readonly impactRadiusM?: number;
  readonly triggerRangeM?: number;
  readonly flightSec?: number;
  readonly poolRadiusM?: number;
  readonly poolSeconds?: number;
  readonly windupSec: number;
  readonly rangeM: number;
  readonly damage: number;
  /** 攻击 CD（秒）；0 = 无 CD（如 E-05 自爆一次性） */
  readonly cdSec: number;
  /** 扇形判定角（度）；null = 非扇形（直线/抛物线，本期近战内核按扇形缺省处理） */
  readonly arcDeg: number | null;
  /** 复合串语义标记（dps/knockback/stunSec/knockbackM）——本期不消费，防语义静默压扁 */
  readonly extras: Record<string, unknown>;
}

/** 玩家武器数值（P5 手枪，docs/23 §2.3；类型在 weapons.ts，数值真源在 stats.json） */
export interface WeaponStats {
  readonly damage: number;
  readonly cdSec: number;
  readonly rangeM: number;
}

/** 单个角色的运行时参数。defId 是全局唯一的角色定义槽位 */
export interface CharacterStatsEntry {
  readonly defId: number;
  readonly id: string;
  readonly name: string;
  readonly capsuleRadius: number;
  readonly capsuleHeight: number;
  readonly mass: number;
  readonly navAgentRadius: number;
  readonly moveSpeed: number;
  readonly turnRate: number;
  readonly sightRange: number;
  readonly fovDeg: number;
  readonly hearingRange: number;
  readonly aggression: number;
  readonly attackRange: number;
  readonly prewarm: number;
  readonly max: number;
  /** 血量上限（roster.hp 交叉校验；health 列的初始真源） */
  readonly hp: number;
  readonly attack: AttackStats | null;
  /** 玩家武器（仅 PLAYER_STATS 有意义） */
  readonly weapon?: WeaponStats;
}

export const PLAYER_STATS: CharacterStatsEntry = {
  defId: 8,
  id: "P-01",
  name: "玩家",
  capsuleRadius: 0.35,
  capsuleHeight: 1.8,
  mass: 75,
  navAgentRadius: 0.37,
  moveSpeed: 4.5,
  turnRate: 720,
  sightRange: 0,
  fovDeg: 0,
  hearingRange: 0,
  aggression: 0,
  attackRange: 0,
  prewarm: 0,
  max: 1,
  hp: 100,
  attack: null,
};

export const PLAYER_WEAPON: WeaponStats = { damage: 12, cdSec: 0.35, rangeM: 18 };

export const NPC_STATS: readonly CharacterStatsEntry[] = [
  {
    defId: 0,
    id: "E-01",
    name: "游荡者",
    capsuleRadius: 0.34,
    capsuleHeight: 1.75,
    mass: 70,
    navAgentRadius: 0.36,
    moveSpeed: 1.4,
    turnRate: 180,
    sightRange: 18,
    fovDeg: 200,
    hearingRange: 12,
    aggression: 0.5,
    attackRange: 2.2,
    prewarm: 0,
    max: 300,
    hp: 60,
    attack: {"windupSec":0.8,"rangeM":2.2,"damage":8,"cdSec":1.6,"arcDeg":90,"extras":{},"kind":"melee"},
  },
  {
    defId: 1,
    id: "E-02",
    name: "扑跃者",
    capsuleRadius: 0.4,
    capsuleHeight: 1.3,
    mass: 55,
    navAgentRadius: 0.42,
    moveSpeed: 3.2,
    turnRate: 400,
    sightRange: 22,
    fovDeg: 240,
    hearingRange: 16,
    aggression: 0.85,
    attackRange: 6,
    prewarm: 0,
    max: 120,
    hp: 45,
    attack: {"windupSec":0.5,"rangeM":6,"damage":18,"cdSec":3.2,"arcDeg":null,"extras":{},"kind":"pounce","speedMps":8,"impactRadiusM":1.6},
  },
  {
    defId: 2,
    id: "E-03",
    name: "呕吐者",
    capsuleRadius: 0.55,
    capsuleHeight: 1.7,
    mass: 95,
    navAgentRadius: 0.58,
    moveSpeed: 1,
    turnRate: 120,
    sightRange: 20,
    fovDeg: 180,
    hearingRange: 10,
    aggression: 0.4,
    attackRange: 9,
    prewarm: 0,
    max: 60,
    hp: 70,
    attack: {"windupSec":1.2,"rangeM":9,"damage":6,"cdSec":4,"arcDeg":null,"extras":{"dps":true},"kind":"acid","flightSec":0.8,"poolRadiusM":2,"poolSeconds":4},
  },
  {
    defId: 3,
    id: "E-04",
    name: "盾卫",
    capsuleRadius: 0.5,
    capsuleHeight: 2.05,
    mass: 140,
    navAgentRadius: 0.52,
    moveSpeed: 1.8,
    turnRate: 140,
    sightRange: 16,
    fovDeg: 120,
    hearingRange: 10,
    aggression: 0.7,
    attackRange: 2.5,
    prewarm: 0,
    max: 40,
    hp: 220,
    attack: {"windupSec":1,"rangeM":8,"damage":12,"cdSec":5,"arcDeg":null,"extras":{"knockback":true,"stunSec":0.6},"kind":"charge","speedMps":6,"impactRadiusM":0.8},
  },
  {
    defId: 4,
    id: "E-05",
    name: "爆尸",
    capsuleRadius: 0.75,
    capsuleHeight: 1.6,
    mass: 110,
    navAgentRadius: 0.78,
    moveSpeed: 1.1,
    turnRate: 100,
    sightRange: 14,
    fovDeg: 200,
    hearingRange: 14,
    aggression: 0.6,
    attackRange: 3,
    prewarm: 0,
    max: 40,
    hp: 90,
    attack: {"windupSec":1.5,"rangeM":3.5,"damage":35,"cdSec":0,"arcDeg":null,"extras":{"knockbackM":4},"kind":"explode","triggerRangeM":2.5},
  },
  {
    defId: 5,
    id: "B-01",
    name: "屠夫",
    capsuleRadius: 0.85,
    capsuleHeight: 3.2,
    mass: 320,
    navAgentRadius: 0.9,
    moveSpeed: 2.2,
    turnRate: 160,
    sightRange: 26,
    fovDeg: 200,
    hearingRange: 18,
    aggression: 0.9,
    attackRange: 3.5,
    prewarm: 0,
    max: 4,
    hp: 4200,
    attack: {"windupSec":0.9,"rangeM":4,"damage":30,"cdSec":3,"arcDeg":270,"extras":{"knockbackM":3},"kind":"melee"},
  },
  {
    defId: 6,
    id: "B-02",
    name: "母体",
    capsuleRadius: 1.2,
    capsuleHeight: 2.4,
    mass: 600,
    navAgentRadius: 1.25,
    moveSpeed: 0,
    turnRate: 60,
    sightRange: 30,
    fovDeg: 360,
    hearingRange: 25,
    aggression: 1,
    attackRange: 12,
    prewarm: 0,
    max: 2,
    hp: 6000,
    attack: null,
  },
  {
    defId: 7,
    id: "B-03",
    name: "零号",
    capsuleRadius: 0.55,
    capsuleHeight: 2.6,
    mass: 180,
    navAgentRadius: 0.58,
    moveSpeed: 3,
    turnRate: 360,
    sightRange: 28,
    fovDeg: 240,
    hearingRange: 20,
    aggression: 1,
    attackRange: 3,
    prewarm: 0,
    max: 2,
    hp: 9000,
    attack: null,
  },
];

const BY_ID = new Map<string, CharacterStatsEntry>(
  [PLAYER_STATS, ...NPC_STATS].map((e) => [e.id, e]),
);

/** 按 roster 角色 id（'E-01' / 'P-01'）查参数；未登记返回 undefined（调用方必须处理） */
export function lookupCharacterStats(id: string): CharacterStatsEntry | undefined {
  return BY_ID.get(id);
}
