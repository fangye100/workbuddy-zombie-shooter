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

/** 首个带 m 单位的数值（attack.range 用：『扇形 90° / 2.2 m』→ 2.2，不是 90） */
function firstMeter(raw) {
  const m = String(raw).match(/(\d+(?:\.\d+)?)\s*m/);
  return m ? Number(m[1]) : null;
}

/** 扇形角度（『扇形 90°』→ 90；无 ° 返回 null） */
function arcDeg(raw) {
  const m = String(raw).match(/(\d+(?:\.\d+)?)\s*°/);
  return m ? Number(m[1]) : null;
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

    // ---- P5 战斗数值交叉校验（docs/23 §2.6，npc / boss 规则分叉）----
    if (typeof s.hp !== 'number' || !Number.isFinite(s.hp) || s.hp <= 0) {
      errors.push(`${at}.hp 必须是正有限数，实际 ${JSON.stringify(s.hp)}`);
    } else if (r !== undefined && r.hp !== s.hp) {
      errors.push(`${at}.hp = ${s.hp}，与 roster.hp ${r.hp} 不一致`);
    }

    const a = s.attack;
    if (a === null) {
      // boss 近战未定（roster 只有远程/产卵散文）：必须有 attackNote 说明，不许静默
      if (typeof s.attackNote !== 'string' || s.attackNote.length === 0) {
        errors.push(`${at}.attack = null 但缺 attackNote（近战未定的理由必须写明，防编造防静默）`);
      }
    } else if (typeof a !== 'object') {
      errors.push(`${at}.attack 必须是对象或 null，实际 ${JSON.stringify(a)}`);
    } else {
      for (const f of ['windupSec', 'rangeM', 'damage', 'cdSec']) {
        if (typeof a[f] !== 'number' || !Number.isFinite(a[f]) || a[f] < 0) {
          errors.push(`${at}.attack.${f} 必须是非负有限数，实际 ${JSON.stringify(a[f])}`);
        }
      }
      if (a.windupSec <= 0) errors.push(`${at}.attack.windupSec 必须 > 0（零前摇无法风控）`);
      if (a.rangeM <= 0) errors.push(`${at}.attack.rangeM 必须 > 0`);
      if (a.damage <= 0) errors.push(`${at}.attack.damage 必须 > 0`);
      if (!['melee','pounce','charge','acid','explode'].includes(a.kind ?? 'melee')) errors.push(`${at}.attack.kind invalid`);
      const required = a.kind === 'acid' ? ['flightSec','poolRadiusM','poolSeconds'] : ['pounce','charge'].includes(a.kind) ? ['speedMps','impactRadiusM'] : a.kind === 'explode' ? ['triggerRangeM'] : [];
      for (const f of required) if (!Number.isFinite(a[f]) || a[f] <= 0) errors.push(`${at}.attack.${f} must be positive`);
      if (a.arcDeg !== null && (typeof a.arcDeg !== 'number' || !(a.arcDeg > 0 && a.arcDeg <= 360))) {
        errors.push(`${at}.attack.arcDeg 必须是 (0,360] 或 null，实际 ${JSON.stringify(a.arcDeg)}`);
      }
      // npc（roster.attack 嵌套对象）才做逐字段核对；boss（roster 只有 attacks 散文数组）
      // 的数值是作者数据，source/attackNote 注明即可，不逐字段校验
      if (r !== undefined && typeof r.attack === 'object' && r.attack !== null) {
        const ra = r.attack;
        const w = firstNumber(ra.windup);
        if (w === null || a.windupSec !== w) {
          errors.push(`${at}.attack.windupSec = ${a.windupSec}，与 roster.attack.windup "${ra.windup}" 不一致`);
        }
        const rm = firstMeter(ra.range);
        if (rm === null || a.rangeM !== rm) {
          errors.push(`${at}.attack.rangeM = ${a.rangeM}，与 roster.attack.range "${ra.range}" 的首个米数 ${rm} 不一致`);
        }
        const rd =
          typeof ra.damage === 'number'
            ? ra.damage
            : firstNumber(ra.damage);
        if (rd === null || a.damage !== rd) {
          errors.push(
            `${at}.attack.damage = ${a.damage}，与 roster.attack.damage ${JSON.stringify(ra.damage)} 的首个数值 ${rd} 不一致`,
          );
        }
        const rc = firstNumber(ra.cd);
        // cd "—"（E-05 自爆无 CD）→ 解析 null → stats 必须为 0
        if ((rc === null ? 0 : rc) !== a.cdSec) {
          errors.push(`${at}.attack.cdSec = ${a.cdSec}，与 roster.attack.cd "${ra.cd}" 不一致（"—" 应为 0）`);
        }
        const rArc = arcDeg(ra.range);
        if ((rArc ?? null) !== (a.arcDeg ?? null)) {
          errors.push(`${at}.attack.arcDeg = ${a.arcDeg}，与 roster.attack.range "${ra.range}" 的扇形角 ${rArc} 不一致`);
        }
        // 复合串的 extras 标记必须存在（E-03 DPS / E-04 眩晕）——不校验具体值（本期不消费），
        // 只防「复合语义被静默压扁成单击伤害」
        if (typeof ra.damage === 'string' && !/^-?\d+(?:\.\d+)?$/.test(ra.damage.trim())) {
          if (typeof a.extras !== 'object' || a.extras === null || Object.keys(a.extras).length === 0) {
            errors.push(
              `${at}.attack.damage 源是复合串 ${JSON.stringify(ra.damage)}，extras 必须非空标记（防语义静默压扁）`,
            );
          }
        }
      }
    }
  });

  // ---- 玩家战斗数值：roster 无玩家条目，只做结构校验（作者数据，source 注明）----
  if (typeof stats.player.hp !== 'number' || !(stats.player.hp > 0)) {
    errors.push('stats.json player.hp 必须是正数');
  }
  const w = stats.player.weapon;
  if (typeof w !== 'object' || w === null) {
    errors.push('stats.json player.weapon 必须是对象（P5 手枪数值，docs/23 §2.3）');
  } else {
    for (const f of ['damage', 'cdSec', 'rangeM']) {
      if (typeof w[f] !== 'number' || !Number.isFinite(w[f]) || w[f] <= 0) {
        errors.push(`stats.json player.weapon.${f} 必须是正有限数，实际 ${JSON.stringify(w[f])}`);
      }
    }
  }

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
  const attack =
    e.attack == null // 同时捕 null 与 undefined（player 条目无 attack 字段）
      ? 'null'
      : JSON.stringify(e.attack);
  const lines = [
    `{`,
    `${pad}  defId: ${e.defId},`,
    `${pad}  id: ${JSON.stringify(e.id)},`,
    `${pad}  name: ${JSON.stringify(e.name)},`,
    ...NUMERIC_FIELDS.map((f) => `${pad}  ${f}: ${e[f]},`),
    `${pad}  hp: ${e.hp},`,
    `${pad}  attack: ${attack},`,
    `${pad}}`,
  ];
  return lines.join('\n');
}

function generate() {
  const npcs = toDefId();
  // 玩家排在 NPC 定义表之后，占一个正常槽位 —— 用 -1 之类的哨兵值会让它
  // 既不能被 Uint16Array 正确表示，也无法和 CharacterDef 表统一索引。
  const player = { ...stats.player, defId: npcs.length };
  const weaponLine =
    typeof stats.player.weapon === 'object' && stats.player.weapon !== null
      ? `export const PLAYER_WEAPON: WeaponStats = { damage: ${stats.player.weapon.damage}, cdSec: ${stats.player.weapon.cdSec}, rangeM: ${stats.player.weapon.rangeM} };`
      : 'export const PLAYER_WEAPON: WeaponStats | null = null;';

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

export const PLAYER_STATS: CharacterStatsEntry = ${renderEntry(player, 0)};

${weaponLine}

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
