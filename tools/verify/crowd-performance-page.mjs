/** Developer-only instrumentation for a headed, supported browser/CDP session.
 * Evaluate bootstrap and installCrowdPerformance in the loaded developer test tab.
 * Never import this in the product. GPU timings are timestamp-query pass durations,
 * not queue completion latency. CPU samples exclude profiling serialization.
 */
export function crowdPerformanceBootstrap() {
  const perf = window.__crowdPerf = { active: false, frames: [], gpu: [], errors: [], pools: [], restores: [], inMainDraw: false, generation: 0, droppedGpu: 0 };
  const raf = window.requestAnimationFrame, clocks = new WeakMap();
  window.requestAnimationFrame = function (callback) {
    if (!callback.toString().includes('renderer.render(')) return raf.call(window, callback);
    return raf.call(window, now => {
      const last = clocks.get(callback); clocks.set(callback, now);
      const start = performance.now(); perf.current = {};
      callback(now);
      if (perf.active) perf.frames.push({ intervalMs: last === undefined ? null : now - last, cpuMs: performance.now() - start, ...perf.current,
        visible: document.visibilityState === 'visible', focused: document.hasFocus(), tick: window.__editor?.playCtl.tick });
    });
  };
  perf.restores.push(() => { window.requestAnimationFrame = raf; });
  const encoders = new WeakMap(), commands = new WeakMap();
  const create = GPUDevice.prototype.createCommandEncoder, submit = GPUQueue.prototype.submit;
  GPUDevice.prototype.createCommandEncoder = function (descriptor) {
    const encoder = create.call(this, descriptor);
    if (!perf.active || !perf.inMainDraw || !this.features.has('timestamp-query')) return encoder;
    let pool = perf.pools.find(p => p.device === this && !p.busy);
    if (!pool && perf.pools.length < 4) {
      pool = { device: this, busy: false, queries: this.createQuerySet({ type: 'timestamp', count: 32 }),
        resolve: this.createBuffer({ size: 256, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
        read: this.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) };
      perf.pools.push(pool);
      const ownedPool = pool;
      ownedPool.release = () => {
        if (ownedPool.released) return;
        ownedPool.released = true;
        if (ownedPool.read.mapState === 'mapped') ownedPool.read.unmap();
        ownedPool.read.destroy(); ownedPool.resolve.destroy(); ownedPool.queries.destroy();
        const index = perf.pools.indexOf(ownedPool); if (index >= 0) perf.pools.splice(index, 1);
      };
      window.__editor.playCtl.session.registerResource('crowd-performance-query-readback', ownedPool.release);
    }
    if (!pool) { perf.droppedGpu++; return encoder; }
    pool.busy = true;
    const capture = { pool, labels: [], generation: perf.generation };
    encoders.set(encoder, capture);
    const begin = encoder.beginRenderPass.bind(encoder), finish = encoder.finish.bind(encoder);
    encoder.beginRenderPass = desc => {
      const index = capture.labels.length * 2;
      if (index >= 32) return begin(desc);
      capture.labels.push(desc.label ?? 'unnamed');
      return begin({ ...desc, timestampWrites: { querySet: pool.queries, beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1 } });
    };
    encoder.finish = desc => {
      const count = capture.labels.length * 2;
      if (count) { encoder.resolveQuerySet(pool.queries, 0, count, pool.resolve, 0); encoder.copyBufferToBuffer(pool.resolve, 0, pool.read, 0, count * 8); }
      else pool.busy = false;
      const command = finish(desc); if (count) commands.set(command, capture); return command;
    };
    return encoder;
  };
  GPUQueue.prototype.submit = function (buffers) {
    const list = [...buffers]; submit.call(this, list);
    for (const command of list) {
      const capture = commands.get(command); if (!capture) continue;
      const { pool, labels, generation } = capture;
      void pool.read.mapAsync(GPUMapMode.READ).then(() => {
        const ns = new BigUint64Array(pool.read.getMappedRange()), passes = {};
        for (let i = 0; i < labels.length; i++) passes[labels[i]] = (passes[labels[i]] ?? 0) + Number(ns[i * 2 + 1] - ns[i * 2]) / 1e6;
        pool.read.unmap();
        if (generation === perf.generation) perf.gpu.push({ passes, totalMs: Object.values(passes).reduce((a, b) => a + b, 0) });
      }).catch(error => { if (!pool.released) perf.errors.push(String(error)); }).finally(() => { pool.busy = false; });
    }
  };
  perf.restores.push(() => { GPUDevice.prototype.createCommandEncoder = create; GPUQueue.prototype.submit = submit; });
}

export function installCrowdPerformance() {
  const perf = window.__crowdPerf, editor = window.__editor;
  if (!perf || !editor) throw new Error('Bootstrap/editor unavailable');
  if (perf.installed) return;
  perf.installed = true;
  const wrap = (owner, method, name, mainDraw = false) => {
    const original = owner[method];
    owner[method] = function (...args) {
      const start = performance.now(); if (mainDraw) perf.inMainDraw = true;
      try { return original.apply(this, args); }
      finally { if (mainDraw) perf.inMainDraw = false; if (perf.active) perf.current[name] = (perf.current[name] ?? 0) + performance.now() - start; }
    };
    perf.restores.push(() => { owner[method] = original; });
  };
  wrap(editor.playCtl, 'update', 'simulationAndPresentationMs');
  wrap(editor.bridge, 'batches', 'batchMs');
  wrap(editor.renderer, 'render', 'renderCpuMs');
  wrap(editor.renderer.core, 'drawFrame', 'encodeMs', true);
  wrap(editor.renderer.core, 'drawDynamicBatches', 'dynamicEncodeMs');
  perf.begin = () => {
    if (perf.active) throw new Error('Capture already active');
    if (document.visibilityState !== 'visible' || !document.hasFocus()) throw new Error('Foreground/focus required for capacity measurements');
    perf.generation++; perf.frames = []; perf.gpu = []; perf.errors = []; perf.droppedGpu = 0; perf.start = performance.now(); perf.active = true;
    perf.startNpc = editor.playCtl.session.runtime?.countNpc(); perf.startTick = editor.playCtl.tick;
    perf.gameplay?.reset();
  };
  perf.end = () => { perf.active = false; perf.elapsedMs = performance.now() - perf.start; };
  perf.snapshot = () => {
    const runtime = editor.playCtl.session.runtime, batches = editor.bridge.batches() ?? [];
    return { elapsedMs: perf.elapsedMs, frames: perf.frames, gpu: perf.gpu, errors: perf.errors, droppedGpu: perf.droppedGpu,
      deviceFeatures: Array.from(editor.renderer.device.features), secure: isSecureContext, visibility: document.visibilityState,
      scene: new URL(location.href).searchParams.get('scene'), userAgent: navigator.userAgent, focused: document.hasFocus(), startNpc: perf.startNpc, startTick: perf.startTick,
      raster: [editor.renderer.core.width, editor.renderer.core.height], bakeProfile: editor.bakeProfile(),
      state: editor.playCtl.state, outcome: runtime?.outcome, tick: runtime?.tick, npc: runtime?.countNpc(), drawCalls: editor.renderer.stats.drawCalls,
      gameplay: perf.gameplay?.snapshot(),
      animation: { motions: editor.motions.summary(), bodyIk: editor.bodyIk.summary() },
      batches: batches.map(b => ({ meshId: b.meshId, count: b.count, vertexCount: b.vertices.length / 15, trianglesPerInstance: b.indices.length / 3,
        transitionCount: Array.from({ length: b.count }, (_, i) => b.instances[i * editor.bridge.instanceStride + 16]).filter(w => w < 1).length,
        snapshotBytes: b.poseTransitions?.data.byteLength ?? 0 })),
      heap: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null };
  };
  perf.dispose = async () => {
    perf.active = false;
    if (perf.originalPlaySession && editor.playCtl.state !== 'stopped') throw new Error('Stop Play before restoring the test session');
    await editor.renderer.device.queue.onSubmittedWorkDone();
    for (const pool of [...perf.pools]) pool.release();
    for (const restore of perf.restores.reverse()) restore();
    if (perf.originalPlaySession) editor.playCtl.session = perf.originalPlaySession;
    delete window.__crowdPerf;
  };
}

/** Replace only the stopped test tab's PlaySession through its real constructor.
 * Defaults, fixed-step clock and behavior executor remain identical. The original
 * session is restored by dispose after Stop; production capacities are unchanged.
 */
export function prepareCrowdCapacity(count) {
  const editor = window.__editor, perf = window.__crowdPerf;
  if (!Number.isInteger(count) || count < 1) throw new Error('Positive integer count required');
  if (editor.playCtl.state !== 'stopped' || editor.playCtl.ledger.pending !== 0) throw new Error('Stop and release Play before changing test capacity');
  const original = perf.originalPlaySession ??= editor.playCtl.session;
  editor.playCtl.session = new original.constructor({ seed: original.seed, fixedStep: original.fixedStep,
    capacity: Math.max(512, count + 1), maxCatchUpSteps: original.maxCatchUpSteps, executor: original.executor });
  return { capacity: editor.playCtl.session.capacity, originalCapacity: original.capacity };
}

/** Reuse the authored validation scene's player assembly in a transient document.
 * No author document, asset metadata or scene file is mutated.
 */
export async function prepareCrowdMixedAnimation() {
  const editor = window.__editor, perf = window.__crowdPerf;
  if (editor.playCtl.state !== 'stopped') throw new Error('Stop before preparing animation fixture');
  if (perf.mixedDocument) return;
  const response = await fetch('/__fs/file?path=assets%2Fscenes%2Fsandbox%2Fbody-ik-validation.scene.json');
  if (!response.ok) throw new Error(`Animation fixture: HTTP ${response.status}`);
  const source = await response.json();
  const binding = source.nodes.flatMap(n => n.components).find(c => c.kind === 'MeshRenderer' && c.playBinding === 'player').bodyIk;
  const getDocument = editor.renderer.getDocument;
  const document = structuredClone(getDocument.call(editor.renderer));
  const playerMesh = document.nodes.flatMap(n => n.components).find(c => c.kind === 'MeshRenderer' && c.playBinding === 'player');
  if (!playerMesh || !binding) throw new Error('Player animation assembly unavailable');
  playerMesh.bodyIk = structuredClone(binding);
  playerMesh.bodyIk.controls[0].target = { kind: 'enemy', height: 1.5 };
  perf.mixedDocument = document;
  editor.renderer.getDocument = () => structuredClone(document);
  perf.restores.push(() => { editor.renderer.getDocument = getDocument; });
}

/** Deterministic debug population. Real scene, simulation, AI, attacks and GPU assets
 * remain active; extra health only prevents ending the measurement by player death.
 * debugSpawn does not certify wave balance or scene-authored placement.
 */
export function configureCrowdPopulation(count) {
  const editor = window.__editor, runtime = editor.playCtl.session.runtime;
  if (!runtime) throw new Error('Play must be started');
  const player = runtime.player(), p = player.id;
  runtime.table.health[p] = runtime.table.maxHp[p] = 1e8;
  const ids = ['E-01', 'E-02', 'E-03', 'E-04'];
  for (const id of ids) if (!editor.actorLib.get(id)) throw new Error(`Unloaded actor ${id}`);
  const existing = runtime.countNpc(), missing = count - existing;
  if (missing < 0) throw new Error(`Existing population ${existing} exceeds target ${count}`);
  let made = 0;
  for (let i = 0; i < ids.length; i++) made += runtime.debugSpawn(ids[i], player.x, player.z, Math.floor(missing / ids.length) + (i < missing % ids.length ? 1 : 0), 12);
  if (made !== missing) throw new Error(`Capacity: requested ${missing}, made ${made}`);
  return { existing, made, npc: runtime.countNpc(), tick: runtime.tick, player: [player.x, player.z] };
}

/** Public runtime inputs drive real movement, combat, reload and kill effects.
 * This is a load fixture, not physical keyboard acceptance or campaign balance.
 * Keep reserve/health high and replace killed NPCs to maintain the declared load.
 */
export function driveCrowdGameplay(count) {
  const perf = window.__crowdPerf, runtime = window.__editor.playCtl.session.runtime;
  const original = runtime.step, origin = runtime.player();
  const waypoints = [[origin.x + 4, origin.z], [origin.x + 4, origin.z + 4], [origin.x, origin.z + 4], [origin.x, origin.z]];
  let waypoint = 0, spawnIndex = 0, stats;
  const reset = () => { stats = { distance: 0, shots: 0, hits: 0, kills: 0, reloads: 0, choices: 0, refills: 0, steps: 0, movingSteps: 0, movingFireSteps: 0, minNpc: count, maxNpc: count }; };
  reset();
  runtime.progress.reserve = 1000000;
  runtime.step = function (...args) {
    const started = performance.now(), before = runtime.player(), kills = runtime.progress.kills, shot = runtime.lastShot;
    if (runtime.progress.choosing) { runtime.progress.choose(runtime.progress.choices[0].id); if (perf.active) stats.choices++; }
    const target = waypoints[waypoint];
    let dx = target[0] - before.x, dz = target[1] - before.z;
    if (Math.hypot(dx, dz) < .6) waypoint = (waypoint + 1) % waypoints.length;
    runtime.setInput(dx, dz); runtime.setAim(null, null); runtime.setFire(true);
    const reloading = runtime.progress.reloadRemaining > 0;
    const result = original.apply(this, args), after = runtime.player();
    const distance = Math.hypot(after.x - before.x, after.z - before.z);
    const missing = count - runtime.countNpc();
    if (missing > 0) {
      const made = runtime.debugSpawn(['E-01', 'E-02', 'E-03', 'E-04'][spawnIndex++ % 4], after.x, after.z, missing, 12);
      if (perf.active) stats.refills += made;
      if (made !== missing) perf.errors.push(`Refill failed: ${made}/${missing}`);
    }
    if (perf.active) {
      stats.steps++; stats.distance += distance; stats.kills += runtime.progress.kills - kills;
      if (distance > .001) { stats.movingSteps++; if (runtime.firing) stats.movingFireSteps++; }
      if (runtime.lastShot && runtime.lastShot !== shot) { stats.shots++; if (runtime.lastShot.hit) stats.hits++; }
      if (!reloading && runtime.progress.reloadRemaining > 0) stats.reloads++;
      const population = runtime.countNpc(); stats.minNpc = Math.min(stats.minNpc, population); stats.maxNpc = Math.max(stats.maxNpc, population);
      perf.current.gameplayStepMs = (perf.current.gameplayStepMs ?? 0) + performance.now() - started;
    }
    return result;
  };
  perf.restores.push(() => { runtime.step = original; runtime.setInput(0, 0); runtime.setFire(false); });
  perf.gameplay = { reset, snapshot: () => ({ ...stats, player: [runtime.player().x, runtime.player().z], magazine: runtime.progress.magazine }) };
}

export function summarizeCrowdCapture(capture) {
  const distribution = values => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return { samples: 0, p50: null, p95: null, p99: null, max: null };
    const q = percentile => sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)];
    return { samples: sorted.length, p50: q(.5), p95: q(.95), p99: q(.99), max: sorted.at(-1) };
  };
  const frames = capture.frames.filter(f => f.visible);
  const tenSecondWindows = [];
  let windowMs = 0, windowFrames = 0;
  for (const frame of frames) {
    if (!Number.isFinite(frame.intervalMs)) continue;
    windowMs += frame.intervalMs; windowFrames++;
    if (windowMs >= 10000) { tenSecondWindows.push(windowFrames / (windowMs / 1000)); windowMs = 0; windowFrames = 0; }
  }
  if (windowMs >= 1000) tenSecondWindows.push(windowFrames / (windowMs / 1000));
  const metrics = {};
  for (const key of ['intervalMs', 'cpuMs', 'simulationAndPresentationMs', 'batchMs', 'renderCpuMs', 'encodeMs', 'dynamicEncodeMs', 'gameplayStepMs']) metrics[key] = distribution(frames.map(f => f[key]));
  metrics.gpuMs = distribution(capture.gpu.map(f => f.totalMs));
  const passes = [...new Set(capture.gpu.flatMap(f => Object.keys(f.passes)))];
  for (const pass of passes) metrics[`gpu:${pass}`] = distribution(capture.gpu.map(f => f.passes[pass]));
  const fps = frames.length / (capture.elapsedMs / 1000);
  const renderedNpc = capture.batches.reduce((n, b) => n + b.count, 0);
  const validCapacitySample = frames.length > 0 && capture.frames.every(f => f.visible && f.focused === true) && capture.startNpc === capture.npc && renderedNpc === capture.npc && capture.tick > capture.startTick && capture.outcome === 'running' && capture.errors.length === 0;
  const g = capture.gameplay;
  const validGameplaySample = validCapacitySample && !!g && g.distance > 5 && g.shots > 0 && g.hits > 0 && g.reloads > 0 && g.movingFireSteps > g.steps * .5 && g.minNpc === capture.npc && g.maxNpc === capture.npc;
  const animation = capture.animation;
  const validMixedAnimationSample = validGameplaySample && !!animation && animation.motions.errors.length === 0 && animation.bodyIk.errors.length === 0 && animation.bodyIk.nodes.some(ik =>
    ik.binding.enabled && ik.binding.weight > 0 && ik.binding.locomotionWhileAiming && ik.diagnostics.every(d => d.code === 'IK_AIM_LIMIT') &&
    ik.binding.controls.some(c => c.enabled && c.weight > 0 && c.part === 'upperBody') && animation.motions.nodes.some(m => m.nodeId === ik.nodeId && m.state === 'run'));
  return { elapsedMs: capture.elapsedMs, fps, tenSecondWindows, stableAbove50: validGameplaySample && capture.elapsedMs >= 20000 && fps >= 50 && tenSecondWindows.length > 0 && tenSecondWindows.every(f => f >= 50), metrics,
    slowFrames33Ms: frames.filter(f => f.intervalMs > 33.34).length, hiddenFrames: capture.frames.length - frames.length,
    unfocusedFrames: frames.filter(f => f.focused === false).length,
    validCapacitySample,
    validGameplaySample, gameplay: g,
    validMixedAnimationSample, renderedNpc,
    droppedGpu: capture.droppedGpu, errors: capture.errors, npc: capture.npc, batches: capture.batches, raster: capture.raster,
    bakeProfile: capture.bakeProfile, tick: capture.tick, state: capture.state, outcome: capture.outcome, heap: capture.heap,
    drawCalls: capture.drawCalls, submittedDynamicTriangles: capture.batches.reduce((n, b) => n + b.count * b.trianglesPerInstance, 0) };
}
