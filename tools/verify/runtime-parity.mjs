#!/usr/bin/env node
/**
 * runtime-parity —— **Node 侧取样**（docs/17 §8-1）。
 *
 * ## 它在证明什么
 *
 * docs/17 §8-1 要求「Node 与浏览器使用同一初始化、seed 和固定 tick 输入，比较相同
 * tick 的实体身份、位置、目标/状态；使用明确容差，**不只比较实体数量**」。
 *
 * 这句话之所以要单独做一条证明，是因为"两边都能跑"和"两边跑出来一样"是两回事：
 * 只要任一宿主自己解释了场景语义（自己算一遍世界变换、自己挑一种刷怪顺序），
 * 数量可能对得上，逐实体的身份与位置却早就分岔了 —— 而这种分岔在编辑器里
 * 看起来只是"僵尸站的位置有点不一样"，几乎不可能被肉眼发现。
 *
 * 本脚本与浏览器侧 `__editor.runtime.runTo()` 走**同一个入口**
 * （`PlaySession.play(doc)` + `RuntimeSession.step()`），差别只在宿主：
 * 这里 Node 直跑 esbuild 打包产物，浏览器跑同一个 bundle 的模块实例。
 *
 * ## 只读
 *
 * 不写场景、不改项目配置、不导出快照。与 `sim-level.mjs` 的区别就在这里 ——
 * docs/17 §8 明确禁止用完整模拟导出命令代替只读检查（它会写场景和 project.json）。
 *
 * 用法：
 *   npm run runtime:build
 *   node tools/verify/runtime-parity.mjs --scene <path> --seed 7 --ticks 60 [--out <file>]
 *
 * 退出码：0 成功；2 缺打包产物；3 场景装载失败；4 参数不对。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RUNTIME = path.resolve('.workbuddy/tmp/runtime/index.js');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const scene = arg('scene', null);
const seed = Number(arg('seed', '7'));
const ticks = Number(arg('ticks', '60'));
const out = arg('out', null);

if (scene === null || !Number.isFinite(seed) || !Number.isFinite(ticks)) {
  console.error('用法：node tools/verify/runtime-parity.mjs --scene <path> --seed <n> --ticks <n> [--out <file>]');
  process.exit(4);
}
if (!fs.existsSync(RUNTIME)) {
  console.error(`缺少 runtime 打包产物 ${RUNTIME} —— 先跑 \`npm run runtime:build\``);
  process.exit(2);
}

const rt = require(RUNTIME);
const doc = JSON.parse(fs.readFileSync(scene, 'utf8'));

// 与浏览器侧完全一致的入口：PlaySession（装载 + 固定步生命周期），不是裸 createSession。
// 只有走同一条路，"同输入同输出"这句话才成立 —— 否则比的是两个不同的东西。
const ps = new rt.PlaySession({ seed, fixedStep: 1 / 30 });
const played = ps.play(doc);
if (!played.ok) {
  console.error(`装载失败：${played.errors.join('；')}`);
  process.exit(3);
}
const s = ps.runtime;
for (let i = 0; i < ticks; i++) s.step();

const snapshot = {
  host: 'node',
  seed,
  fixedStep: ps.fixedStep,
  ticks,
  tick: s.tick,
  sceneId: s.desc.sceneId,
  schemaVersion: s.desc.schemaVersion,
  // "同输入"不是靠假设的，是比出来的：指纹不等就说明两边喂的文档不一样，
  // 那时实体坐标对不上跟一致性无关，排查方向完全不同。
  docFingerprint: rt.sceneFingerprint(doc),
  entities: s.view().map((e) => ({
    id: e.id,
    generation: e.generation,
    characterId: e.characterId,
    kind: e.kind,
    x: e.x,
    z: e.z,
    yaw: e.yaw,
    sourceNodeId: e.sourceNodeId,
    targetId: e.targetId,
    behavior: e.behavior,
  })),
};
ps.stop();

const text = JSON.stringify(snapshot, null, 2);
if (out !== null) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, text, 'utf8');
  console.error(`已写出 ${out}（${snapshot.entities.length} 个实体，tick ${snapshot.tick}）`);
} else {
  console.log(text);
}
process.exit(0);
