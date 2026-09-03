#!/usr/bin/env node
/**
 * content/ 生成层（ADR-002 · docs/10 D3）
 *
 * 把两个内容真源编译成强类型 TS，供上层消费：
 *   assets/style/tokens.json        → src/generated/tokens.generated.ts
 *   assets/characters/roster.json   → src/generated/roster.generated.ts
 *
 * 铁律：**只派生真源里真实存在的数据，绝不编造。**
 * 真源没有的字段一律不生成 —— 见下方 UNDERIVABLE。
 * （曾经有人为了"让表填满"手写数字，那是把编造的数字洗成"单一真源"，比硬编码更坏。）
 *
 * 用法：
 *   node packages/content/scripts/gen-content.mjs           # 写文件
 *   node packages/content/scripts/gen-content.mjs --check   # 只比对，不一致 exit 1
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const OUT_DIR = join(HERE, '..', 'src', 'generated');

const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const tokens = read('assets/style/tokens.json');
const roster = read('assets/characters/roster.json');

/* ==========================================================================
 * 1. 派生规则（全部可证，改动必须同步改这里的说明）
 * ========================================================================== */

/** 取字符串里第一个数值。用于 "1.25 m（四足）/ 1.60 m（直立）" 这类复合描述。
 *  规则：第一个数值 = 基准姿态/主值，括号内的是变体。原始串一律保留在 *Raw 字段，
 *  保证信息不丢。若解析失败 → 抛错，绝不静默填 0。 */
function firstNumber(raw, what) {
  const m = String(raw).match(/[-+]?\d*\.?\d+/);
  if (!m) throw new Error(`无法从 ${what} 解析数值：${JSON.stringify(raw)}`);
  return Number(m[0]);
}

/** 同上，但解析不到数值时返回 null（表示"真源明示无此数值"），而不是抛错。
 *  例：B-02 母体 speed = "本体固定不可移动"。区别 null 与 0 很重要 ——
 *  0 是我们编的数，null 是"真源没给"这个事实。 */
function parseOptionalNumber(raw) {
  const m = String(raw).match(/[-+]?\d*\.?\d+/);
  return m ? Number(m[0]) : null;
}

/** mixTo 是 core 色组的键名（如 "night-deep"），在这里解析成 hex。
 *  解析不到 → 抛错，因为那说明真源不一致，必须先在 tokens.json 里修。 */
function resolveColor(key) {
  if (key === null || key === undefined) return null;
  const hex = tokens.groups?.core?.[key];
  if (typeof hex !== 'string') {
    throw new Error(`tokens.json 的 groups.core 里找不到色键 ${JSON.stringify(key)}`);
  }
  return hex;
}

/**
 * 不可派生清单 —— 真源里**没有**、因此本生成器拒绝生成的字段。
 * 写进生成物头部注释，让"表为什么是空的"有据可查，而不是靠口头传承。
 */
const UNDERIVABLE = [
  ['CharacterPhysicsDef.capsuleRadius', 'roster 只有 height（身高），没有体型/肩宽/半径'],
  ['CharacterPhysicsDef.capsuleHeight', 'height 是"站高"，胶囊高还要减端半球，属物理调参'],
  ['CharacterPhysicsDef.mass', 'roster 无质量字段'],
  ['CharacterPhysicsDef.navAgentRadius', '导航半径属寻路调参，roster 无'],
  ['CharacterAiDef.turnRate', 'roster 无转向速率'],
  ['CharacterAiDef.sightRange / fovDeg / hearingRange', 'roster 无感知参数'],
  ['CharacterAiDef.aggression', 'roster 只有 threat（低/中/高/极高）定性档，无数值'],
  ['CharacterAiDef.archetype', 'roster 的 ai 字段是出图提示词，不是行为原型枚举'],
  ['HurtboxDef.bone/radius', 'roster 无骨骼名与部位半径；weakness 是散文（"头部 ×2.5"）'],
  ['boss 招式数值', 'attacks[].desc 是中文散文（"前摇 0.9 s，半径 4 m，伤害 30"），非结构化'],
  ['BodyPartDef.mesh/material', 'roster 无网格/材质索引，需资产绑定后回填'],
];

/* ==========================================================================
 * 2. 组装数据
 * ========================================================================== */

const coreColors = { ...tokens.groups.core };
const colorUsage = { ...tokens.usage };

/** grading / toonRamp 的 stops 形状一致，只是区间字段名不同（range vs ndotl）。 */
function buildStops(stops, rangeKey) {
  return stops.map((s) => {
    const range = s[rangeKey];
    if (!Array.isArray(range) || range.length !== 2) {
      throw new Error(`stop ${s.name} 的 ${rangeKey} 必须是二元数组`);
    }
    return {
      name: s.name,
      range: [Number(range[0]), Number(range[1])],
      multiply: Number(s.multiply),
      mixTo: s.mixTo ?? null,
      mixToHex: resolveColor(s.mixTo ?? null),
      mix: Number(s.mix),
      saturation: Number(s.saturation),
    };
  });
}

const grading = {
  space: tokens.grading.space,
  purpose: tokens.grading.purpose,
  edgeSoftness: Number(tokens.grading.edgeSoftness),
  stops: buildStops(tokens.grading.stops, 'range'),
};

const toonRamp = {
  space: tokens.toonRamp.space,
  edgeSoftness: Number(tokens.toonRamp.edgeSoftness),
  stops: buildStops(tokens.toonRamp.stops, 'ndotl'),
};

const outline = {
  method: tokens.outline.method,
  widthStorage: tokens.outline.widthStorage,
  widthsPxAt1080p: { ...tokens.outline.widthsPxAt1080p },
};

function buildCharacter(c, kind) {
  return {
    id: c.id,
    kind,
    name: c.name,
    en: c.en,
    threat: c.threat,
    acts: [...(c.acts ?? [Number(c.act)])],
    heightRaw: c.height,
    heightMeters: firstNumber(c.height, `${c.id}.height`),
    speedRaw: c.speed,
    // B-02 母体是 "本体固定不可移动" —— 用 null 表示"真源明示不可移动"，
    // 不用 0 顶替：0 是我们编的数，null 是"真源没给数值"这个事实。
    speedMps: parseOptionalNumber(c.speed),
    hp: Number(c.hp),
    tris: Number(c.tris),
    accent: c.accent,
  };
}

const characters = [
  ...roster.npcs.map((c) => buildCharacter(c, 'npc')),
  ...roster.bosses.map((c) => buildCharacter(c, 'boss')),
];

/* ==========================================================================
 * 3. 渲染成 TS
 * ========================================================================== */

const num = (n) => (Number.isInteger(n) ? String(n) : String(n));

function renderHeader(title, sources, extra = '') {
  const src = sources.map((s) => ` *   ${s}`).join('\n');
  return `/**
 * ${title}
 *
 * ⚠️ 自动生成，请勿手改 —— 改真源后重跑：
 *    node packages/content/scripts/gen-content.mjs
 *
 * 真源：
${src}
${extra} */
`;
}

const gapBlock = ` *
 * ── 不可派生清单（真源里没有，故不生成；不要手写填表）──────────────
${UNDERIVABLE.map(([f, why]) => ` *   ✗ ${f.padEnd(42)} ${why}`).join('\n')}
 *
 * 这些字段等真源补结构化数据、或由独立的调参表承载后再接进来。
 * 在此之前手写数字 = 把编造值洗成"单一真源"，比硬编码更坏。`;

function renderTokens() {
  const stops = (arr) =>
    arr
      .map(
        (s) => `  {
    name: ${JSON.stringify(s.name)},
    range: [${num(s.range[0])}, ${num(s.range[1])}],
    multiply: ${num(s.multiply)},
    mixTo: ${s.mixTo === null ? 'null' : JSON.stringify(s.mixTo)},
    mixToHex: ${s.mixToHex === null ? 'null' : JSON.stringify(s.mixToHex)},
    mix: ${num(s.mix)},
    saturation: ${num(s.saturation)},
  }`,
      )
      .join(',\n');

  return `${renderHeader('风格令牌（由 tokens.json 生成）', [
    'assets/style/tokens.json',
  ])}

/** 一个色调停靠点。range 的语义由所属段落决定：
 *  grading 用显示亮度区间，toonRamp 用 NdotL 区间。 */
export interface ToneStop {
  readonly name: string;
  readonly range: readonly [number, number];
  readonly multiply: number;
  /** core 色组里的键名；null = 不做混色 */
  readonly mixTo: string | null;
  /** mixTo 解析后的 hex；null = 不做混色 */
  readonly mixToHex: string | null;
  readonly mix: number;
  readonly saturation: number;
}

export interface ToneCurve {
  readonly space: string;
  readonly edgeSoftness: number;
  readonly stops: readonly ToneStop[];
}

/** core 色组（真源 tokens.json → groups.core） */
export const CORE_COLORS = ${JSON.stringify(coreColors, null, 2)} as const;

/** 每个色键的用途（真源 tokens.json → usage），用于让人看懂该用哪个色 */
export const COLOR_USAGE = ${JSON.stringify(colorUsage, null, 2)} as const;

/** 尺寸/圆角类数值（真源 tokens.json → numbers） */
export const NUMBERS = ${JSON.stringify(tokens.numbers, null, 2)} as const;

/** 后期调色三段：暗部 / 中间调 / 亮部（真源 tokens.json → grading） */
export const GRADING: ToneCurve = {
  space: ${JSON.stringify(grading.space)},
  edgeSoftness: ${num(grading.edgeSoftness)},
  stops: [
${stops(grading.stops)},
  ],
};

/** 卡通分级（真源 tokens.json → toonRamp）。这是生产分阶的唯一真源。 */
export const TOON_RAMP: ToneCurve = {
  space: ${JSON.stringify(toonRamp.space)},
  edgeSoftness: ${num(toonRamp.edgeSoftness)},
  stops: [
${stops(toonRamp.stops)},
  ],
};

export const OUTLINE = ${JSON.stringify(outline, null, 2)} as const;

export const STYLE_VERSION = ${JSON.stringify(String(tokens.version))} as const;
`;
}

function renderRoster() {
  const rows = characters
    .map(
      (c) => `  {
    id: ${JSON.stringify(c.id)},
    kind: ${JSON.stringify(c.kind)},
    name: ${JSON.stringify(c.name)},
    en: ${JSON.stringify(c.en)},
    threat: ${JSON.stringify(c.threat)},
    acts: [${c.acts.map(num).join(', ')}],
    heightRaw: ${JSON.stringify(c.heightRaw)},
    heightMeters: ${num(c.heightMeters)},
    speedRaw: ${JSON.stringify(c.speedRaw)},
    speedMps: ${c.speedMps === null ? 'null' : num(c.speedMps)},
    hp: ${num(c.hp)},
    tris: ${num(c.tris)},
    accent: ${JSON.stringify(c.accent)},
  }`,
    )
    .join(',\n');

  return `${renderHeader('角色名册（由 roster.json 生成）', [
    'assets/characters/roster.json',
  ], gapBlock + '\n')}

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
${rows},
];

const BY_ID: ReadonlyMap<string, RosterCharacter> = new Map(
  ROSTER_CHARACTERS.map((c) => [c.id, c]),
);

/** 按 id 取角色；不存在直接抛错 —— 宁可启动失败，也不给 undefined 让 bug 潜伏。 */
export function requireCharacter(id: string): RosterCharacter {
  const c = BY_ID.get(id);
  if (!c) throw new Error(\`roster.json 里没有角色 \${id}（已载入：\${[...BY_ID.keys()].join(', ')}）\`);
  return c;
}

export const ROSTER_VERSION = ${JSON.stringify(String(roster.version))} as const;
`;
}

/* ==========================================================================
 * 4. 写出
 * ========================================================================== */

const files = {
  'tokens.generated.ts': renderTokens(),
  'roster.generated.ts': renderRoster(),
};

const check = process.argv.includes('--check');
let dirty = false;

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, content] of Object.entries(files)) {
  const path = join(OUT_DIR, name);
  let current = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    /* 文件还不存在 */
  }
  if (current === content) {
    console.log(`  ✓ ${name} 已是最新`);
    continue;
  }
  dirty = true;
  if (check) {
    console.error(`  ✗ ${name} 与真源不同步 —— 重跑：node packages/content/scripts/gen-content.mjs`);
  } else {
    writeFileSync(path, content);
    console.log(`  ✓ ${name} 已生成（${content.split('\n').length} 行）`);
  }
}

if (check) {
  if (dirty) {
    console.error('\n❌ content 生成物与真源不同步。');
    process.exit(1);
  }
  console.log('✅ content 生成物与真源同步。');
} else {
  console.log(
    `\n共 ${characters.length} 个角色（npc ${roster.npcs.length} / boss ${roster.bosses.length}）`,
  );
  console.log(`不可派生字段 ${UNDERIVABLE.length} 项，已写进 roster.generated.ts 头部。`);
}
