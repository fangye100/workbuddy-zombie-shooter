/**
 * 导航层冒烟测试（无测试框架，直接 tsc → node 运行）。
 *
 *   npm run smoke:nav
 *
 * 覆盖：绕行可达性 / clearance-aware cost 效果 / 不可达区域 / 僵持检测 / 群体避让性能与数值稳定性。
 * 这些是纯 CPU 逻辑，不需要浏览器与 WebGPU。
 */

import {
  CrowdSolver,
  FlowField,
  FlowFieldIntegrator,
  SpatialHash,
  UNREACHABLE,
  type CrowdBuffers,
  type CrowdParams,
} from '../src/navigation';

const W = 48;
const H = 48;

function makeField(): FlowField {
  const f = new FlowField({ width: W, height: H, cellSize: 1, originX: 0, originZ: 0 });
  // 竖墙 cx=12，cz 0..38，缺口在 cz 39..47 —— 必须从下方绕行
  for (let cz = 0; cz <= 38; cz++) f.setBlocked(12, cz, true);
  return f;
}

function integrate(f: FlowField, gx: number, gz: number): number {
  const it = new FlowFieldIntegrator(f);
  if (!it.setGoal(gx, gz)) return -1;
  for (let frames = 0; frames < 500; frames++) {
    if (it.step(4096)) return frames + 1;
  }
  return -1;
}

interface WalkResult {
  reached: boolean;
  reason: string;
  steps: number;
  hugging: number;
  minClearance: number;
}

function walk(f: FlowField, sx: number, sz: number, gx: number, gz: number, maxSteps: number): WalkResult {
  const out = { x: 0, z: 0, confidence: 0 };
  const goalCell = f.cellIndexAtWorld(gx, gz);
  let x = sx;
  let z = sz;
  let steps = 0;
  let hugging = 0;
  let minClearance = 99;

  while (steps < maxSteps) {
    const gi = f.cellIndexAtWorld(x, z);
    if (gi < 0) return { reached: false, reason: 'oob', steps, hugging, minClearance };
    if (gi === goalCell) return { reached: true, reason: 'goal', steps, hugging, minClearance };
    const cl = f.clearance[gi]!;
    if (cl < minClearance) minClearance = cl;
    if (cl <= 1) hugging++;
    if (!f.sampleFlow(x, z, out)) {
      return { reached: false, reason: 'noflow', steps, hugging, minClearance };
    }
    x += out.x * 0.5;
    z += out.z * 0.5;
    steps++;
  }
  return { reached: false, reason: 'maxsteps', steps, hugging, minClearance };
}

function makeBuffers(n: number): CrowdBuffers {
  const b: CrowdBuffers = {
    count: n,
    posX: new Float32Array(n),
    posZ: new Float32Array(n),
    velX: new Float32Array(n),
    velZ: new Float32Array(n),
    radius: new Float32Array(n).fill(0.4),
    maxSpeed: new Float32Array(n).fill(3.2),
    speedScale: new Float32Array(n).fill(1),
    dodgeBias: new Int8Array(n),
    outX: new Float32Array(n),
    outZ: new Float32Array(n),
    stuckTicks: new Uint16Array(n),
    stuckRefX: new Float32Array(n),
    stuckRefZ: new Float32Array(n),
    stuck: new Uint8Array(n),
  };
  return b;
}

const PARAMS: CrowdParams = {
  separationWeight: 3.0,
  maxNeighbors: 6,
  wallPush: 0.02,
  jitter: 0.35,
  acceleration: 12,
  dt: 1 / 60,
  stuckWindowSeconds: 0.4,
  stuckProgressRatio: 0.3,
};

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail}`);
}

// --- 1. 绕行可达性 ---------------------------------------------------------
const f1 = makeField();
const frames1 = integrate(f1, 40.5, 44.5);
check('绕障寻路收敛', frames1 > 0, `frames=${frames1}`);
const w1 = walk(f1, 2.5, 16.5, 40.5, 44.5, 500);
check('从 (2.5,16.5) 抵达目标', w1.reached, `${w1.reason} steps=${w1.steps}`);
const w2 = walk(f1, 5.5, 5.5, 40.5, 44.5, 500);
check('从 (5.5,5.5) 抵达目标', w2.reached, `${w2.reason} steps=${w2.steps}`);

// --- 2. clearance-aware cost ----------------------------------------------
const f2 = makeField();
integrate(f2, 40.5, 44.5);
const before = walk(f2, 2.5, 16.5, 40.5, 44.5, 500);

const f3 = makeField();
f3.bakeClearance(8);
f3.applyClearanceToCost(2, 3);
integrate(f3, 40.5, 44.5);
const after = walk(f3, 2.5, 16.5, 40.5, 44.5, 500);
check(
  'clearance 惩罚显著减少贴墙',
  after.hugging < before.hugging * 0.2,
  `贴墙格 ${before.hugging} → ${after.hugging}，步数 ${before.steps} → ${after.steps}`,
);
check('clearance 惩罚不增加路径长度', after.steps <= before.steps, `${before.steps} → ${after.steps}`);

// --- 3. 不可达区域 ---------------------------------------------------------
const f4 = makeField();
for (let cx = 4; cx <= 8; cx++) {
  f4.setBlocked(cx, 44, true);
  f4.setBlocked(cx, 47, true);
}
for (let cz = 44; cz <= 47; cz++) {
  f4.setBlocked(4, cz, true);
  f4.setBlocked(8, cz, true);
}
integrate(f4, 40.5, 20.5);
const sealed = f4.index(6, 46);
check('密封房间标记为 UNREACHABLE', f4.integration[sealed] === UNREACHABLE, `v=${f4.integration[sealed]}`);
check(
  '不可达格流向为零',
  f4.flowX[sealed]! === 0 && f4.flowZ[sealed]! === 0,
  `flow=(${f4.flowX[sealed]!}, ${f4.flowZ[sealed]!})`,
);

// --- 4. 僵持检测（被困在密封房间内，来回震荡但速度不低） -----------------------
const solo = makeBuffers(1);
solo.posX[0] = 6.5;
solo.posZ[0] = 46.5;
solo.stuckRefX[0] = 6.5;
solo.stuckRefZ[0] = 46.5;
solo.dodgeBias[0] = 1;
const soloSolver = new CrowdSolver(0, 0, W, H, 1.0, 1);
let maxInstantSpeed = 0;
for (let k = 0; k < 60; k++) {
  soloSolver.solve(solo, f4, PARAMS);
  const s = Math.hypot(solo.outX[0]!, solo.outZ[0]!);
  if (s > maxInstantSpeed) maxInstantSpeed = s;
  solo.velX[0] = solo.outX[0]!;
  solo.velZ[0] = solo.outZ[0]!;
  solo.posX[0] += solo.velX[0]! * PARAMS.dt;
  solo.posZ[0] += solo.velZ[0]! * PARAMS.dt;
}
check(
  '震荡中的 NPC 被判为僵持',
  solo.stuck[0] === 1,
  `瞬时速度峰值 ${maxInstantSpeed.toFixed(2)}（速度判据会漏判这种情况）`,
);

// --- 5. 群体避让性能与数值稳定性 --------------------------------------------
const N = 300;
const buf = makeBuffers(N);
for (let i = 0; i < N; i++) {
  buf.posX[i] = 20 + (i % 17) * 0.05;
  buf.posZ[i] = 20 + Math.floor(i / 17) * 0.05;
  buf.stuckRefX[i] = buf.posX[i]!;
  buf.stuckRefZ[i] = buf.posZ[i]!;
  buf.dodgeBias[i] = (i & 1) === 0 ? 1 : -1;
}
const solver = new CrowdSolver(0, 0, W, H, 1.0, N);
const t0 = performance.now();
for (let f = 0; f < 60; f++) {
  solver.solve(buf, f3, PARAMS);
  for (let i = 0; i < N; i++) {
    buf.velX[i] = buf.outX[i]!;
    buf.velZ[i] = buf.outZ[i]!;
    buf.posX[i] = buf.posX[i]! + buf.velX[i]! * PARAMS.dt;
    buf.posZ[i] = buf.posZ[i]! + buf.velZ[i]! * PARAMS.dt;
  }
}
const msPerFrame = (performance.now() - t0) / 60;

let maxSpeed = 0;
let moved = 0;
let nan = 0;
for (let i = 0; i < N; i++) {
  const s = Math.hypot(buf.velX[i]!, buf.velZ[i]!);
  if (!Number.isFinite(s)) nan++;
  if (s > maxSpeed) maxSpeed = s;
  if (Math.hypot(buf.posX[i]! - 20, buf.posZ[i]! - 20) > 0.5) moved++;
}
check('无 NaN', nan === 0, `nan=${nan}`);
check('速度被钳制在上限内', maxSpeed <= 3.2 + 1e-3, `max=${maxSpeed.toFixed(3)} / cap 3.200`);
check('拥挤的 NPC 被推开', moved === N, `moved=${moved}/${N}`);
check('群体避让在预算内', msPerFrame < 1.2, `${msPerFrame.toFixed(3)} ms/frame @ ${N} agents`);

// --- 6. 空间哈希 -----------------------------------------------------------
const hash = new SpatialHash(0, 0, W, H, 1.0, N);
hash.build(buf.posX, buf.posZ, N);
const out = new Int32Array(64);
check('空间哈希能查到邻居', hash.query(22.0, 22.0, out) > 0, `hits=${hash.query(22.0, 22.0, out)}`);

if (failures > 0) {
  throw new Error(`${failures} navigation smoke check(s) FAILED.`);
}
console.log('\nAll checks passed.');
