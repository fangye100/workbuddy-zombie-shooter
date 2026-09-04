#!/usr/bin/env node
/**
 * 批量生成 / 更新资产 sidecar 元数据（`<file>.glb.meta.json`）。
 *
 * ## 为什么需要它
 *
 * 编辑器对 GLB 做的操作（材质绑定继承、身高归一化、骨骼绑定、导入参数）
 * 会产生附加数据，按 ADR-016 这些落在同名 sidecar 里。本脚本负责**批量铺开骨架**，
 * 之后用户在编辑器里的修改由编辑器自己写回。
 *
 * ## 两条铁律
 *
 * 1. **merge 而非覆盖**：已存在的 `.meta.json` 只补缺失字段，
 *    绝不冲掉用户手改的 `bindings` / `rig` / `userData`。
 *    生成脚本冲掉用户数据是资产管线最常见的灾难。
 * 2. **身高值复用生成层**：从 `roster.generated.ts` 读已解析好的 `heightMeters`，
 *    不自己再解析一遍 `roster.json` 的复合串（ADR-002：资料库经生成层进入引擎）。
 *    提取后断言角色数 == 8，正则一旦失效立刻炸，不静默产出错误数据。
 *
 * ## 用法
 *
 *   node tools/scene/gen-asset-meta.mjs          写入 / 更新
 *   node tools/scene/gen-asset-meta.mjs --check  只比对不写，不同则 exit 1（CI 门禁）
 *
 * 归属：S0c。schema 真源 `packages/scene/src/asset-meta.ts`。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ASSETS = join(ROOT, 'assets');
const ROSTER_GEN = join(ROOT, 'packages', 'content', 'src', 'generated', 'roster.generated.ts');

const META_SUFFIX = '.meta.json';
/** 期望的名册角色数。正则提取的结果必须等于它，否则说明生成物格式变了 */
const EXPECTED_ROSTER_COUNT = 8;

// ---------------------------------------------------------------- 名册

/**
 * 从 roster.generated.ts 提取 `id → heightMeters`。
 *
 * 为什么不直接读 roster.json：那里的 height 是复合串
 * （`"1.25 m（四足）/ 1.60 m（直立）"`），解析规则（取第一个数值）已经在
 * content 生成层实现过一次。再实现一遍就是 ADR-002 明令禁止的"手写重复定义"。
 */
function loadRoster() {
  const src = readFileSync(ROSTER_GEN, 'utf8');
  const out = new Map();
  // 每条记录以 `  {` 开头（生成物格式固定），块内各自匹配 id / name / heightMeters
  const blocks = src.split(/\n {2}\{\n/).slice(1);
  for (const b of blocks) {
    const id = /\bid:\s*"([^"]+)"/.exec(b)?.[1];
    const name = /\bname:\s*"([^"]+)"/.exec(b)?.[1];
    const h = /\bheightMeters:\s*(-?[0-9.]+)/.exec(b)?.[1];
    if (id !== undefined && h !== undefined) {
      out.set(id, { id, name: name ?? id, heightMeters: Number(h) });
    }
  }
  if (out.size !== EXPECTED_ROSTER_COUNT) {
    throw new Error(
      `从 roster.generated.ts 只提取到 ${out.size} 个角色（期望 ${EXPECTED_ROSTER_COUNT}）。` +
        `生成物格式可能变了，请更新本脚本的提取正则 —— 拒绝带着错误数据继续。`,
    );
  }
  return out;
}

// ---------------------------------------------------------------- 资产筛选

/** 跳过的目录：破损备份、UV 保留中间产物、obj 中间产物 */
const SKIP_DIR_RE = /(^|[\\/])(_broken_backup[^\\/]*|uvkeep|obj_[^\\/]*|lab)([\\/]|$)/;

/** 原始混元产物：`E04_20260901_010134.glb` —— 40~50MB，是减面管线的输入，不是游戏资产 */
const RAW_SOURCE_RE = /^[EB]-\d{2}_\d{8}_\d{6}\.glb$/;

/** 成品所在的目录（这些目录下的 GLB 才生成 meta） */
const PRODUCT_DIRS = new Set(['rigged', 'textured', 'game_ready', 'synthetic']);

function isTarget(relPath) {
  if (SKIP_DIR_RE.test(relPath)) return false;
  const parts = relPath.split(/[\\/]/);
  const file = parts[parts.length - 1];
  if (RAW_SOURCE_RE.test(file)) return false;
  const dir = parts[parts.length - 2];
  return PRODUCT_DIRS.has(dir);
}

/** 从路径推断变体标签：`rigged_animated` / `textured` / `game_ready` … */
function variantOf(relPath) {
  const parts = relPath.split(/[\\/]/);
  const dir = parts[parts.length - 2] ?? '';
  const file = parts[parts.length - 1] ?? '';
  if (dir === 'synthetic') return 'synthetic';
  if (file.includes('_animated')) return `${dir}-animated`;
  return dir;
}

/** 从路径提取角色 id：`models/E-04/...` → `E-04` */
function characterIdOf(relPath) {
  const m = /models[\\/]([EB]-\d{2})[\\/]/.exec(relPath);
  return m?.[1] ?? null;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.glb')) out.push(p);
  }
  return out;
}

function sha256Of(absPath) {
  const buf = readFileSync(absPath);
  return createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------- meta 构造

function newGuid() {
  return `as_${Math.random().toString(36).slice(2, 10)}`;
}

function buildMeta(relPath, hash, roster) {
  const charId = characterIdOf(relPath);
  const entry = charId === null ? null : roster.get(charId) ?? null;
  const parts = relPath.split(/[\\/]/);
  const now = new Date().toISOString();

  return {
    schemaVersion: 1,
    guid: newGuid(),
    kind: 'gltf',
    importer: {
      // 角色资产按名册身高归一化；非角色（synthetic）不归一化
      normalizeHeightM: entry === null ? null : entry.heightMeters,
      weldTolerance: 1e-4,
      upAxisFlip: false,
      aoBakeFloor: null,
      splitSubMeshes: true,
      maxSubMeshes: 8,
    },
    bindings: [],
    rig: null,
    animations: null,
    userData: {
      ...(charId === null ? {} : { characterId: charId, characterName: entry?.name ?? charId }),
      variant: variantOf(relPath),
      file: parts[parts.length - 1],
    },
    sourceHash: `sha256:${hash}`,
    updatedAt: now,
  };
}

/**
 * 与已有 meta 合并：**只补缺失字段**，已有值一律保留。
 * 顶层标量（schemaVersion/kind/guid）保留旧的；importer 逐字段补缺。
 */
function mergeInto(existing, fresh) {
  const out = { ...existing };
  // 顶层：缺了才补
  for (const k of ['schemaVersion', 'guid', 'kind']) {
    if (out[k] === undefined) out[k] = fresh[k];
  }
  // importer：逐字段补缺
  const imp = { ...(existing.importer ?? {}) };
  for (const [k, v] of Object.entries(fresh.importer)) {
    if (imp[k] === undefined) imp[k] = v;
  }
  out.importer = imp;
  // 容器：空/null 才补
  if (!Array.isArray(out.bindings)) out.bindings = fresh.bindings;
  if (out.rig === undefined) out.rig = fresh.rig;
  if (out.animations === undefined) out.animations = fresh.animations;
  if (out.userData === undefined || typeof out.userData !== 'object') out.userData = {};
  for (const [k, v] of Object.entries(fresh.userData)) {
    if (out.userData[k] === undefined) out.userData[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- 主流程

function main() {
  const checkOnly = process.argv.includes('--check');
  const roster = loadRoster();

  const all = walk(ASSETS);
  const targets = all
    .map((abs) => ({ abs, rel: relative(ROOT, abs).split(sep).join('/') }))
    .filter(({ rel }) => isTarget(rel))
    .sort((a, b) => a.rel.localeCompare(b.rel));

  if (targets.length === 0) {
    console.error('没有找到任何目标资产，检查 assets/ 目录与筛选规则');
    process.exit(1);
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const drift = [];

  for (const { abs, rel } of targets) {
    const metaPath = `${abs}${META_SUFFIX}`;
    const hash = sha256Of(abs);
    const existed = existsSync(metaPath);
    let next;

    if (!existed) {
      next = buildMeta(rel, hash, roster);
    } else {
      const existing = JSON.parse(readFileSync(metaPath, 'utf8'));
      const fresh = buildMeta(rel, hash, roster);
      next = mergeInto(existing, fresh);
      // hash 必须跟随源文件：重导 GLB 后旧 hash 会让派生产物失效检测失灵
      next.sourceHash = `sha256:${hash}`;
    }

    const nextText = JSON.stringify(next, null, 2) + '\n';
    const prevText = existed ? readFileSync(metaPath, 'utf8') : null;

    if (prevText === nextText) {
      unchanged++;
      continue;
    }

    if (checkOnly) {
      drift.push(existed ? `需更新 ${rel}${META_SUFFIX}` : `缺失 ${rel}${META_SUFFIX}`);
      continue;
    }

    // 显式 LF：Windows 下 Python 会偷偷转 CRLF（本项目踩过），Node 不会，但显式确认更安全
    writeFileSync(metaPath, nextText.replace(/\r\n/g, '\n'), 'utf8');
    if (existed) updated++;
    else created++;
  }

  if (checkOnly) {
    if (drift.length > 0) {
      console.error(`[scene:check] 资产元数据与源文件不同步（${drift.length} 项）：`);
      for (const d of drift) console.error(`  - ${d}`);
      console.error('\n修复：npm run scene:gen');
      process.exit(1);
    }
    console.log(`[scene:check] ${targets.length} 个资产的元数据全部同步`);
    return;
  }

  console.log(
    `[scene:gen] 新建 ${created} · 更新 ${updated} · 无变化 ${unchanged} ` +
      `(共 ${targets.length} 个成品资产；已跳过源产物与备份目录)`,
  );
  const withHeight = targets.filter(({ rel }) => characterIdOf(rel) !== null).length;
  console.log(`[scene:gen] 其中 ${withHeight} 个角色资产的归一化身高取自 roster.generated.ts`);
}

main();
