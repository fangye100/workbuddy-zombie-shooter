/**
 * 场景文件批量迁移（把磁盘上的 `.scene.json` / `.prefab.json` 升到当前 SCHEMA_VERSION）。
 *
 * 为什么要这个工具：
 *  编辑器/运行时**加载时**会走迁移链，所以旧版本文件照样能开 —— 但这让"磁盘数据
 *  停在旧版本"这件事变成隐形的：schema 已经到 v4，仓库里却同时躺着 v2/v3/v4 三种
 *  文件（2026-10-02 审查实测：floor-1=v4、floor-2/3=v3、sandbox=v2、sim/*=v3），
 *  任何一次 `gen-level.mjs` 重跑都会吐出"版本号被改"的假 diff。
 *
 *  迁移链的解释权归 `packages/scene`（唯一真源）——本脚本只负责"遍历 + 落盘"，
 *  不复制任何迁移语义。
 *
 * 用法：
 *  node tools/level/migrate-scenes.mjs            # 就地升级（无变化则不写盘）
 *  node tools/level/migrate-scenes.mjs --check    # 只检查，有文件未升级 → exit 1
 *
 * 落盘规则与 gen-level.mjs 保持一致：2 空格缩进 + 末尾换行，LF 行尾。
 */
import fs from 'node:fs';
import path from 'node:path';

import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
// Windows 下 import.meta.url.pathname 带前导斜杠（/C:/...），用 fileURLToPath 更稳
const HERE = path.dirname(
  (await import('node:url')).fileURLToPath(new URL(import.meta.url)),
);
const ROOT2 = path.resolve(HERE, '../..');

const BUNDLE = path.join(ROOT2, '.workbuddy/tmp/scene-bundle.mjs');
const TARGETS = ['assets/scenes', 'assets/prefabs'];

async function bundleScene() {
  fs.mkdirSync(path.dirname(BUNDLE), { recursive: true });
  // 直接调 esbuild JS API（沙箱里 pnpm.cmd 不一定在 PATH 上，子进程调用不稳）
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [path.join(ROOT2, 'packages/scene/src/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: BUNDLE,
    tsconfig: path.join(ROOT2, 'tsconfig.check.json'),
    logLevel: 'error',
  });
}

/** 递归收集目标文件 */
function collect(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(p));
    else if (e.name.endsWith('.scene.json') || e.name.endsWith('.prefab.json')) out.push(p);
  }
  return out;
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  await bundleScene();
  const scene = await import(pathToFileURL(BUNDLE).href);

  const files = TARGETS.flatMap((d) => collect(path.join(ROOT2, d))).sort();
  const stale = [];
  const changed = [];
  let errors = 0;

  for (const abs of files) {
    const rel = path.relative(ROOT2, abs).split(path.sep).join('/');
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
      console.error(`  [E_PARSE] ${rel}：${e.message}`);
      errors++;
      continue;
    }
    if (!scene.needsMigration(doc)) continue;

    // 🔴 迁移是**就地**改 doc 的：版本号必须在调用前取，否则打印成 "v4 → v4"
    const fromVersion = doc.schemaVersion;
    const prevCreatedAt = doc.meta?.createdAt;
    const r = scene.migrateToLatest(doc);
    if (r.diagnostics.some((d) => d.severity === 'error')) {
      console.error(`  [E_MIGRATE] ${rel}：${JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error'))}`);
      errors++;
      continue;
    }
    stale.push(`${rel}  v${fromVersion} → v${r.doc.schemaVersion}`);
    if (!checkOnly) {
      // 保留原文件的创建时间语义（meta.createdAt 不是"最后一次迁移的时间"）
      if (prevCreatedAt && r.doc.meta) r.doc.meta.createdAt = prevCreatedAt;
      fs.writeFileSync(abs, `${JSON.stringify(r.doc, null, 2)}\n`, 'utf8');
      changed.push(rel);
    }
  }

  if (checkOnly) {
    if (stale.length > 0 || errors > 0) {
      console.error('[migrate-scenes] 磁盘上有场景文件未升到当前 schema：');
      for (const s of stale) console.error(`  · ${s}`);
      console.error(`\n修复：node tools/level/migrate-scenes.mjs`);
      process.exit(1);
    }
    console.log(`[migrate-scenes] ${files.length} 个场景文件全部已是 v${scene.SCHEMA_VERSION}`);
    return;
  }

  if (changed.length > 0) {
    console.log(`[migrate-scenes] 已升级 ${changed.length} 个文件到 v${scene.SCHEMA_VERSION}：`);
    for (const c of changed) console.log(`  · ${c}`);
  } else {
    console.log(`[migrate-scenes] ${files.length} 个场景文件无需升级（全部 v${scene.SCHEMA_VERSION}）`);
  }
  if (errors > 0) process.exit(1);
}

main().catch((e) => {
  console.error('迁移脚本异常终止：', e);
  process.exit(1);
});
