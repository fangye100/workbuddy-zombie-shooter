import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { crowdPerformanceBootstrap, summarizeCrowdCapture } from './crowd-performance-page.mjs';

it('registers query resources with Play and releases each handle once on Stop', () => {
  const keys = ['window', 'GPUDevice', 'GPUQueue', 'GPUBufferUsage'];
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const releases = []; let destroyed = 0;
  class Device {
    features = new Set(['timestamp-query']);
    createCommandEncoder() { return { beginRenderPass() {}, finish() {} }; }
    createQuerySet() { return { destroy() { destroyed++; } }; }
    createBuffer() { return { mapState: 'unmapped', destroy() { destroyed++; } }; }
  }
  try {
    globalThis.window = { requestAnimationFrame() {}, __editor: { playCtl: { session: { registerResource(_name, release) { releases.push(release); } } } } };
    globalThis.GPUDevice = Device; globalThis.GPUQueue = class { submit() {} };
    globalThis.GPUBufferUsage = { QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 };
    crowdPerformanceBootstrap();
    const perf = window.__crowdPerf; perf.active = perf.inMainDraw = true;
    const device = new Device(); device.createCommandEncoder();
    assert.equal(releases.length, 1); assert.equal(perf.pools.length, 1);
    releases[0](); releases[0]();
    assert.equal(destroyed, 3); assert.equal(perf.pools.length, 0);
    device.createCommandEncoder();
    assert.equal(releases.length, 2); releases[1](); assert.equal(destroyed, 6);
    for (const restore of perf.restores.reverse()) restore();
  } finally {
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});

describe('crowd performance evidence', () => {
  const capture = () => ({ elapsedMs: 1000, frames: [10, 20, 40].map(intervalMs => ({ intervalMs, cpuMs: 2, visible: true, focused: true })),
    gpu: [{ totalMs: 3, passes: { scene: 2, post: 1 } }], batches: [{ count: 50, trianglesPerInstance: 3000 }],
    startNpc: 50, npc: 50, startTick: 0, tick: 30, errors: [], outcome: 'running' });
  it('uses actual frame intervals and submitted geometry', () => {
    const result = summarizeCrowdCapture(capture());
    assert.deepEqual(result.metrics.intervalMs, { samples: 3, p50: 20, p95: 40, p99: 40, max: 40 });
    assert.equal(result.metrics.gpuMs.p50, 3);
    assert.equal(result.submittedDynamicTriangles, 150000);
    assert.equal(result.validCapacitySample, true);
    assert.equal(result.slowFrames33Ms, 1);
  });
  it('requires actual concurrent movement, hits, reloads and constant population for gameplay acceptance', () => {
    const sample = capture();
    assert.equal(summarizeCrowdCapture(sample).validGameplaySample, false);
    sample.gameplay = { distance: 20, shots: 10, hits: 8, reloads: 1, movingFireSteps: 28, steps: 30, minNpc: 50, maxNpc: 50 };
    assert.equal(summarizeCrowdCapture(sample).validGameplaySample, true);
    for (const key of ['distance', 'shots', 'hits', 'reloads', 'movingFireSteps']) {
      assert.equal(summarizeCrowdCapture({ ...sample, gameplay: { ...sample.gameplay, [key]: 0 } }).validGameplaySample, false);
    }
    assert.equal(summarizeCrowdCapture({ ...sample, gameplay: { ...sample.gameplay, minNpc: 49 } }).validGameplaySample, false);
  });
  it('rejects NPC counts that were not submitted to rendering', () => {
    const sample = capture(); sample.batches[0].count = 49;
    assert.equal(summarizeCrowdCapture(sample).validCapacitySample, false);
  });
  it('requires Run and enabled upper-body IK on the same actor for mixed animation evidence', () => {
    const sample = capture();
    sample.gameplay = { distance: 20, shots: 10, hits: 8, reloads: 1, movingFireSteps: 28, steps: 30, minNpc: 50, maxNpc: 50 };
    sample.animation = { motions: { errors: [], nodes: [{ nodeId: 'player', state: 'run' }] }, bodyIk: { errors: [], nodes: [{ nodeId: 'player', diagnostics: [], binding: { enabled: true, weight: 1, locomotionWhileAiming: true, controls: [{ enabled: true, weight: 1, part: 'upperBody' }] } }] } };
    assert.equal(summarizeCrowdCapture(sample).validMixedAnimationSample, true);
    sample.animation.bodyIk.nodes[0].diagnostics.push({ code: 'IK_AIM_LIMIT' });
    assert.equal(summarizeCrowdCapture(sample).validMixedAnimationSample, true);
    sample.animation.bodyIk.nodes[0].diagnostics.push({ code: 'IK_MISSING_CHAIN' });
    assert.equal(summarizeCrowdCapture(sample).validMixedAnimationSample, false);
    sample.animation.bodyIk.nodes[0].diagnostics = [];
    sample.animation.motions.nodes[0].state = 'shoot';
    assert.equal(summarizeCrowdCapture(sample).validMixedAnimationSample, false);
    sample.animation.motions.nodes[0].state = 'run';
    sample.animation.bodyIk.nodes[0].binding.weight = 0;
    assert.equal(summarizeCrowdCapture(sample).validMixedAnimationSample, false);
  });
  for (const reason of ['unfocused', 'hidden', 'population', 'frozen', 'ended', 'errors']) it(`rejects ${reason} capacity claims while retaining measurements`, () => {
    const sample = capture();
    if (reason === 'unfocused') sample.frames[0].focused = false;
    if (reason === 'hidden') sample.frames[0].visible = false;
    if (reason === 'population') sample.npc = 49;
    if (reason === 'frozen') sample.tick = 0;
    if (reason === 'ended') sample.outcome = 'game-over';
    if (reason === 'errors') sample.errors.push('GPU failed');
    assert.equal(summarizeCrowdCapture(sample).validCapacitySample, false);
    assert.equal(summarizeCrowdCapture(sample).metrics.gpuMs.p50, 3);
  });
});
