#!/usr/bin/env node
/**
 * runtime-parity —— Node 侧取样与**跨宿主比对**（docs/17 §8-1）。
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
 * 有两个模式，**别把取样当成比对**：
 *
 *   取样  --scene <p> --seed 7 --ticks 60 [--out f]
 *         只产出 Node 侧快照。
 *
 *   比对  --compare <web.json> [--scene <p> --seed 7 --ticks 60 | --against <node.json>]
 *         把浏览器侧快照与本侧（现算或已存盘的）快照逐实体比对，输出 maxΔ。
 *         **"两侧一致"这个结论必须由这个模式产出**，否则它只存在于某个人的
 *         临时脚本里，半年后没人能复跑（docs/12 已把这条定为 P0）。
 *
 * ## 只读
 *
 * 不写场景、不改项目配置、不导出快照。与 `sim-level.mjs` 的区别就在这里 ——
 * docs/17 §8 明确禁止用完整模拟导出命令代替只读检查（它会写场景和 project.json）。
 *
 * 退出码：0 成功 / 一致；1 两侧不一致；2 缺打包产物；3 场景装载失败；4 参数不对。
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
const has = (name) => process.argv.includes(`--${name}`);

function sample(rt, sceneText, seed, ticks, inputs) {
  const doc = JSON.parse(sceneText);
  // 与浏览器侧完全一致的入口：PlaySession（装载 + 固定步生命周期），不是裸 createSession。
  // 只有走同一条路，"同输入同输出"这句话才成立 —— 否则比的是两个不同的东西。
  const ps = new rt.PlaySession({ seed, fixedStep: 1 / 30 });
  const played = ps.play(doc);
  if (!played.ok) {
    console.error(`装载失败：${played.errors.join('；')}`);
    process.exit(3);
  }
  const s = ps.runtime;
  for (let i = 0; i < ticks; i++) {
    // 固定 tick 输入消费：与浏览器侧喂同一条序列，玩家输入才算进了比对（复审 #7）
    const inp = inputs !== null && inputs[i] !== undefined ? inputs[i] : null;
    if (inp !== null) s.setInput(inp.x, inp.z);
    s.step();
  }
  const snap = {
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
  return snap;
}

/**
 * 逐实体比对两份快照。
 *
 * 身份按 `id:generation` 配对（不是数组下标 —— 下表相同不代表是同一只），
 * 离散字段要求全等，连续字段要求落在容差内并**报告实际偏差**。
 */
function diffSnapshots(a, b, tol) {
  const problems = [];
  if (a.entities.length !== b.entities.length) {
    problems.push(`实体数 ${a.entities.length} vs ${b.entities.length}`);
    return { problems, maxDelta: NaN };
  }
  const key = (e) => `${e.id}:${e.generation}`;
  const ma = new Map(a.entities.map((e) => [key(e), e]));
  const mb = new Map(b.entities.map((e) => [key(e), e]));
  let maxDelta = 0;
  for (const [k, ea] of ma) {
    const eb = mb.get(k);
    if (eb === undefined) {
      problems.push(`身份 ${k} 只在一侧存在`);
      continue;
    }
    for (const f of ['characterId', 'kind', 'sourceNodeId', 'targetId', 'behavior']) {
      if (ea[f] !== eb[f]) problems.push(`${k}.${f} ${ea[f]} vs ${eb[f]}`);
    }
    for (const f of ['x', 'z', 'yaw']) {
      const d = Math.abs(ea[f] - eb[f]);
      if (d > maxDelta) maxDelta = d;
      if (d > tol) problems.push(`${k}.${f} Δ=${d.toExponential(3)}`);
    }
  }
  for (const k of mb.keys()) if (!ma.has(k)) problems.push(`身份 ${k} 只在一侧存在`);
  return { problems, maxDelta };
}

const TOL = Number(arg('tol', '1e-9'));
const inputsFile = arg('inputs', null);
const inputs = inputsFile === null ? null : JSON.parse(fs.readFileSync(inputsFile, 'utf8'));
const compare = arg('compare', null);

if (!has('compare') && !has('scene')) {
  console.error(
    '用法：\n' +
      '  取样  node tools/verify/runtime-parity.mjs --scene <path> --seed <n> --ticks <n> [--out <file>]\n' +
      '  比对  node tools/verify/runtime-parity.mjs --compare <web.json> --scene <path> --seed <n> --ticks <n>\n' +
      '  比对  node tools/verify/runtime-parity.mjs --compare <web.json> --against <node.json>\n' +
      '  通用  --inputs <file.json> 每 tick 的玩家输入序列 [{x,z},...]（复审 #7：输入也进比对）',
  );
  process.exit(4);
}
if (!fs.existsSync(RUNTIME)) {
  console.error(`缺少 runtime 打包产物 ${RUNTIME} —— 先跑 \`npm run runtime:build\``);
  process.exit(2);
}
const rt = require(RUNTIME);

// ------------------------------------------------------------ 比对模式
if (compare !== null) {
  const other = JSON.parse(fs.readFileSync(compare, 'utf8'));
  const against = arg('against', null);
  let mine;
  if (against !== null) {
    mine = JSON.parse(fs.readFileSync(against, 'utf8'));
  } else {
    const scene = arg('scene', null);
    const seed = Number(arg('seed', '7'));
    const ticks = Number(arg('ticks', '60'));
    if (scene === null || !Number.isFinite(seed) || !Number.isFinite(ticks)) {
      console.error('比对模式要么给 --against <node.json>，要么给 --scene/--seed/--ticks 现场取样');
      process.exit(4);
    }
    mine = sample(rt, fs.readFileSync(scene, 'utf8'), seed, ticks, inputs);
  }

  const lines = [];
  const fail = (m) => lines.push(`[FAIL] ${m}`);
  const pass = (m) => lines.push(`[PASS] ${m}`);

  if (mine.docFingerprint === other.docFingerprint) {
    pass(`两侧喂进 runtime 的是同一份文档 — ${mine.docFingerprint}`);
  } else {
    fail(`输入文档不一致（node=${mine.docFingerprint} other=${other.docFingerprint}）—— 先解决输入，别谈输出`);
  }
  if (mine.sceneId === other.sceneId && mine.schemaVersion === other.schemaVersion) {
    pass(`场景与 schema 一致 — ${mine.sceneId} v${mine.schemaVersion}`);
  } else {
    fail(`场景/schema 不一致 — ${mine.sceneId} v${mine.schemaVersion} vs ${other.sceneId} v${other.schemaVersion}`);
  }
  if (mine.tick === other.tick) pass(`到达同一 tick — ${mine.tick}`);
  else fail(`tick 不同 — ${mine.tick} vs ${other.tick}`);

  const { problems, maxDelta } = diffSnapshots(mine, other, TOL);
  if (problems.length === 0) {
    pass(`逐实体身份 / 位置 / 目标 / 状态一致 — ${mine.entities.length} 个实体，maxΔ=${maxDelta.toExponential(2)}`);
  } else {
    fail(`逐实体不一致 — ${problems.slice(0, 8).join(' | ')}`);
  }

  console.log(lines.join('\n'));
  console.log(`\n===== ${lines.filter((l) => l.startsWith('[PASS]')).length} PASS / ${lines.filter((l) => l.startsWith('[FAIL]')).length} FAIL =====`);
  process.exit(problems.length === 0 && mine.docFingerprint === other.docFingerprint ? 0 : 1);
}

// ------------------------------------------------------------ 取样模式
const scene = arg('scene', null);
const seed = Number(arg('seed', '7'));
const ticks = Number(arg('ticks', '60'));
const out = arg('out', null);
if (scene === null || !Number.isFinite(seed) || !Number.isFinite(ticks)) {
  console.error('用法：node tools/verify/runtime-parity.mjs --scene <path> --seed <n> --ticks <n> [--out <file>]');
  process.exit(4);
}

const snapshot = sample(rt, fs.readFileSync(scene, 'utf8'), seed, ticks, inputs);
const text = JSON.stringify(snapshot, null, 2);
if (out !== null) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, text, 'utf8');
  console.error(`已写出 ${out}（${snapshot.entities.length} 个实体，tick ${snapshot.tick}）`);
} else {
  console.log(text);
}
process.exit(0);
