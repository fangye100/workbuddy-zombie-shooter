#!/usr/bin/env node
/**
 * 角色运行时参数生成层（ADR-002 · docs/18 §1.4）
 *
 *   assets/characters/stats.json → src/generated/stats.generated.ts
 *
 * ## 为什么需要第二个真源
 *
 * roster.json 是**美术/设计资料库**：`height: "1.75 m"`、`speed: "1.4 m/s"`、
 * `attack.range: "扇形 90° / 2.2 m"` —— 全是可读散文，承担不了 CharacterDef 需要的
 * 胶囊半径 / 质量 / 转向速率 / 视野 / 听觉 / 攻击距离等运行时数值。
 * 因此拆成两份，分工如下：
 *
 *   roster.json  → 外观、叙事、威胁档、AI 出图提示词   （美术/设计消费）
 *   stats.json   → 运行时物理与 AI 数值                 （程序消费）
 *
 * ## 为什么不合并进 gen-content.mjs
 *
 * 那份生成器的铁律是「只派生真源里真实存在的数据，绝不编造」，它的 UNDERIVABLE 清单
 * 明确列出 capsuleRadius / mass / turnRate / 感知参数**不可从 roster 派生**。
 * 把这些数字硬塞进 roster 派生链 = 把编造数字洗成单一真源，比硬编码更坏。
 * 正确做法是让它们成为**显式的作者数据**（stats.json 由人填写并注明来源），
 * 而不是伪装成从美术资料库算出来的结果。
 *
 * ## 防漂移
 *
 * --check 会交叉校验：id 集合与 roster 一致、moveSpeed 等于 roster.speed 的首个数值
 * （B-02 明示"固定不可移动" → 解析不到数值 → 期望 0）。两份真源不会静默各改各的。
 *
 * 用法：
 *   node packages/content/scripts/gen-stats.mjs           # 写文件
 *   node packages/content/scripts/gen-stats.mjs --check   # 只比对，不一致 exit 1
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const OUT_DIR = join(HERE, '..', 'src', 'generated');
const OUT_FILE = join(OUT_DIR, 'stats.generated.ts');

const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const stats = read('assets/characters/stats.json');
const roster = read('assets/characters/roster.json');
/** roster 把小兵与 Boss 分开存（npcs / bosses），但角色 id 空间是一份 */
const rosterAll = [...roster.npcs, ...roster.bosses];

/** 与 gen-content.mjs 同源的解析规则：取字符串里第一个数值 */
function firstNumber(raw) {
  const m = String(raw).match(/[-+]?\d*\.?\d+/);
  return m ? Number(m[0]) : null;
}

const NUMERIC_FIELDS = [
  'capsuleRadius',
  'capsuleHeight',
  'mass',
  'navAgentRadius',
  'moveSpeed',
  'turnRate',
  'sightRange',
  'fovDeg',
  'hearingRange',
  'aggression',
  'attackRange',
  'prewarm',
  'max',
];

/* ==========================================================================
 * 1. 校验（--check 与写入前都跑；真源不合法一律拒绝生成）
 * ========================================================================== */
function validate() {
  const errors = [];
  const rosterIds = new Set(rosterAll.map((n) => n.id));
  const seen = new Set();

  if (typeof stats.player !== 'object' || stats.player === null) {
    errors.push('stats.json 缺少 player 配置');
  }

  stats.npcs.forEach((s, i) => {
    const at = `stats.json npcs[${i}]`;
    if (typeof s.id !== 'string' || s.id.length === 0) {
      errors.push(`${at}.id 必须是非空字符串`);
      return;
    }
    if (seen.has(s.id)) errors.push(`${at}.id 重复：${s.id}`);
    seen.add(s.id);

    if (!rosterIds.has(s.id)) {
      errors.push(`${at}.id "${s.id}" 在 roster.json 里不存在（两份真源已漂移）`);
    }
    for (const f of NUMERIC_FIELDS) {
      if (typeof s[f] !== 'number' || !Number.isFinite(s[f])) {
        errors.push(`${at}.${f} 必须是有限数，实际 ${JSON.stringify(s[f])}`);
      }
    }
    if (s.capsuleRadius <= 0) errors.push(`${at}.capsuleRadius 必须 > 0`);
    if (s.capsuleHeight <= 0) errors.push(`${at}.capsuleHeight 必须 > 0`);
    if (s.moveSpeed < 0) errors.push(`${at}.moveSpeed 不能为负`);
    if (s.aggression < 0 || s.aggression > 1) errors.push(`${at}.aggression 必须在 [0,1]`);

    // ---- 与 roster 的交叉校验：速度 ----
    const r = rosterAll.find((n) => n.id === s.id);
    if (r !== undefined) {
      const rosterSpeed = firstNumber(r.speed);
      if (rosterSpeed === null) {
        // 真源明示"没有速度"（如 B-02 "本体固定不可移动"）→ 必须是 0，不能是编造的正数
        if (s.moveSpeed !== 0) {
          errors.push(
            `${at}.moveSpeed = ${s.moveSpeed}，但 roster 的 speed "${r.speed}" 解析不出数值` +
              `（真源明示该单位不可移动），此处必须为 0`,
          );
        }
      } else if (s.moveSpeed !== rosterSpeed) {
        errors.push(
          `${at}.moveSpeed = ${s.moveSpeed}，与 roster.speed "${r.speed}" 的首个数值 ${rosterSpeed} 不一致`,
        );
      }
    }
  });

  for (const id of rosterIds) {
    if (!seen.has(id)) errors.push(`roster.json 的角色 "${id}" 在 stats.json 里缺条目`);
  }

  return errors;
}

/* ==========================================================================
 * 2. 生成
 * ========================================================================== */
function toDefId() {
  return stats.npcs.map((s, i) => ({ ...s, defId: i }));
}

function renderEntry(e, indent) {
  const pad = ' '.repeat(indent);
  const lines = [
    `{`,
    `${pad}  defId: ${e.defId},`,
    `${pad}  id: ${JSON.stringify(e.id)},`,
    `${pad}  name: ${JSON.stringify(e.name)},`,
    ...NUMERIC_FIELDS.map((f) => `${pad}  ${f}: ${e[f]},`),
    `${pad}}`,
  ];
  return lines.join('\n');
}

function generate() {
  const npcs = toDefId();
  const player = { ...stats.player, defId: -1 };

  return `// 自动生成，请勿手改 —— 真源 assets/characters/stats.json
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

/** 单个角色的运行时参数。defId = -1 表示玩家（不占 NPC 定义表） */
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
}

export const PLAYER_STATS: CharacterStatsEntry = ${renderEntry(player, 0)};

export const NPC_STATS: readonly CharacterStatsEntry[] = [
${npcs.map((e) => '  ' + renderEntry(e, 2)).join(',\n')},
];

const BY_ID = new Map<string, CharacterStatsEntry>(
  [PLAYER_STATS, ...NPC_STATS].map((e) => [e.id, e]),
);

/** 按 roster 角色 id（'E-01' / 'P-01'）查参数；未登记返回 undefined（调用方必须处理） */
export function lookupCharacterStats(id: string): CharacterStatsEntry | undefined {
  return BY_ID.get(id);
}
`;
}

/* ==========================================================================
 * 3. 主流程
 * ========================================================================== */
const errors = validate();
const check = process.argv.includes('--check');

if (errors.length > 0) {
  console.error('[gen-stats] 真源校验失败：');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}

const out = generate();

if (check) {
  if (!existsSync(OUT_FILE)) {
    console.error(`[gen-stats] 生成物不存在：${OUT_FILE}（先跑 npm run content:gen）`);
    process.exit(1);
  }
  if (readFileSync(OUT_FILE, 'utf8') !== out) {
    console.error('[gen-stats] 生成物与真源不同步，请跑 npm run content:gen');
    process.exit(1);
  }
  console.log('[gen-stats] 同步检查通过');
  process.exit(0);
}

writeFileSync(OUT_FILE, out, 'utf8');
console.log(`[gen-stats] 已生成 ${OUT_FILE.replace(ROOT, '.')}（${stats.npcs.length} 个 NPC + 玩家）`);
