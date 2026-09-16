/**
 * retarget-session.test.ts —— 会话层合同（MR-06，docs/16 §8 A14 / A16）。
 *
 * 只锁会话编排合同：两入口一致、导出读回、重载复现、失效与失败不覆盖、
 * 标定 sidecar 往返与单侧失效。求解数学本身归 pipeline / pose-solver 等测试，
 * 这里不重复；预期值全部由独立构造的输入（fixture BVH / 手工骨架）给出。
 */

import { describe, expect, it } from 'vitest';
import {
  RetargetSession,
  skeletonFromFitPositions,
  type RetargetSidecarStore,
} from '../../src/services/binding/retarget-session';
import { readBackWorld } from '../../src/services/binding/motion-retarget/bake-adapter';
import { buildBvhText } from './fixture';
import { HUMANIK_BONES, HUMANIK_ORDER, tposeWorldPositions } from '../../src/services/binding/humanik-template';
import type { JointPositions } from '../../src/services/binding/binding-math';
import {
  calibrationFingerprint,
  type RetargetCalibration,
} from '@aether/scene';
import type { SkeletonData } from '@aether/scene';

// ---------------------------------------------------------------- 夹具

/** 内存 sidecar 存取（测试注入；main.ts 注入的是 devfs 版） */
function memStore(): { files: Map<string, Record<string, unknown>>; store: RetargetSidecarStore } {
  const files = new Map<string, Record<string, unknown>>();
  return {
    files,
    store: {
      read: async (p) =>
        files.has(p) ? { ok: true, json: files.get(p)! } : { ok: false, json: null, error: 'not found' },
      patch: async (p, patch) => {
        files.set(p, { ...(files.get(p) ?? {}), ...patch });
        return { ok: true };
      },
    },
  };
}

/**
 * 独立构造入口 B 用的骨架（不经过被测的 skeletonFromFitPositions）：
 * 节点 i = HUMANIK_ORDER[i]，局部平移 = 父子世界坐标差，rest 旋转 identity。
 */
function skeletonFromPositions(pos: JointPositions): SkeletonData {
  const indexOf = new Map(HUMANIK_ORDER.map((n, i) => [n, i] as const));
  const parent: number[] = [];
  const locals = HUMANIK_ORDER.map((n, i) => {
    const p = HUMANIK_BONES[n]!.parent;
    parent[i] = p === null ? -1 : indexOf.get(p)!;
    const self = pos[n]!;
    const pt = parent[i]! < 0 ? [0, 0, 0] : pos[HUMANIK_ORDER[parent[i]!]!]!;
    const t: [number, number, number] = [
      self[0]! - pt[0]!,
      self[1]! - pt[1]!,
      self[2]! - pt[2]!,
    ];
    return {
      t,
      r: [0, 0, 0, 1] as [number, number, number, number],
      s: [1, 1, 1] as [number, number, number],
    };
  });
  let rootIdx = 0;
  HUMANIK_ORDER.forEach((_, i) => {
    if (parent[i]! < 0) rootIdx = i;
  });
  return {
    joints: HUMANIK_ORDER.map((_, i) => i),
    jointNames: [...HUMANIK_ORDER],
    inverseBind: new Float32Array(HUMANIK_ORDER.length * 16),
    parent,
    locals,
    roots: [rootIdx],
    normalization: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  };
}

/** 带世界位移的行走样 BVH（cm 制、Y-up、6 帧）。根速 0.2cm/帧（0.06 m/s @30fps）：
 * 低于进入阈值 0.1×h_s（脚可判支撑），6 帧跨度 1cm ≥ in-place 判定线 → world-trajectory。 */
function walkBvh(): string {
  return buildBvhText({
    frames: 6,
    rootPos: (f) => [f * 0.2, 100, 0],
  });
}

/** 入口 B 带容器节点的骨架：节点 0 = Armature（平移 [1,0,0]、统一缩放 2），骨节点 1..27。
 * 用来端到端抓「两份 FK 实现（rig-calibration vs bake 输出骨架）在缩放祖先下漂移」。 */
function skeletonWithContainer(pos: JointPositions): SkeletonData {
  const base = skeletonFromPositions(pos);
  const parent = [-1, ...base.parent.map((p) => (p < 0 ? 0 : p + 1))];
  const locals = [
    { t: [1, 0, 0] as [number, number, number], r: [0, 0, 0, 1] as [number, number, number, number], s: [2, 2, 2] as [number, number, number] },
    ...base.locals,
  ];
  return {
    joints: base.joints.map((j) => j + 1),
    jointNames: base.jointNames,
    inverseBind: base.inverseBind,
    parent,
    locals,
    roots: [0],
    normalization: base.normalization,
  };
}

/** 源侧标定：cm 制（unitScale 0.01）、Y-up、骨盆高 1m、双侧足底标记 */
function sourceCalibration(ankleToSoleM = 0.03): RetargetCalibration {
  const marker = (bone: string, kind: 'heel' | 'ball', local: [number, number, number]) => ({
    bone,
    offset: local as [number, number, number],
    origin: 'manual' as const,
  });
  return {
    schemaVersion: 1,
    side: 'source',
    pelvisHeightM: 1.0,
    supportPlane: { origin: [0, 0, 0], normal: [0, 1, 0], source: 'declared', confidence: 1 },
    unitScale: 0.01,
    upAxis: 'y',
    markers: {
      'LeftFoot.heel': marker('LeftFoot', 'heel', [0, -ankleToSoleM, -0.05]),
      'LeftFoot.ball': marker('LeftFoot', 'ball', [0, -ankleToSoleM, 0.09]),
      'RightFoot.heel': marker('RightFoot', 'heel', [0, -ankleToSoleM, -0.05]),
      'RightFoot.ball': marker('RightFoot', 'ball', [0, -ankleToSoleM, 0.09]),
    },
    rotationBaseline: 'direction',
  };
}

function targetCalibration(hT: number): RetargetCalibration {
  return {
    schemaVersion: 1,
    side: 'target',
    pelvisHeightM: hT,
    supportPlane: { origin: [0, 0, 0], normal: [0, 1, 0], source: 'declared', confidence: 1 },
    unitScale: null,
    upAxis: null,
    markers: {},
    rotationBaseline: 'direction',
  };
}

// ---------------------------------------------------------------- A14：两入口一致

describe('retarget-session A14 两入口与导出同配方/结果', () => {
  it('入口 A（fit）与入口 B（骨架）在等价目标上产出同一规范世界解', () => {
    const fit = tposeWorldPositions();
    const a = new RetargetSession(memStore().store);
    const b = new RetargetSession(memStore().store);
    expect(a.loadSourceBvh(walkBvh(), 'walk').ok).toBe(true);
    expect(b.loadSourceBvh(walkBvh(), 'walk').ok).toBe(true);
    expect(a.setTarget({ fitPositions: fit, name: 'binding-fit' }).ok).toBe(true);
    expect(b.setTarget({ skeleton: skeletonFromPositions(fit), name: 'scene-object' }).ok).toBe(true);

    const oa = a.solve();
    const ob = b.solve();
    expect(oa.status).not.toBe('failed');
    expect(oa.status).toBe(ob.status);
    // 同配方：依赖指纹（源/目标/标定/环境/算法版本）逐项一致
    expect(oa.dependencyFingerprint).toBe(ob.dependencyFingerprint);
    // 同结果：逐帧世界解一致
    expect(oa.clip).not.toBeNull();
    expect(ob.clip).not.toBeNull();
    expect(oa.clip!.frames.length).toBe(ob.clip!.frames.length);
    for (let f = 0; f < oa.clip!.frames.length; f++) {
      const fa = oa.clip!.frames[f]!;
      const fb = ob.clip!.frames[f]!;
      for (let k = 0; k < 3; k++) expect(fa.rootPos[k]).toBeCloseTo(fb.rootPos[k]!, 12);
      for (const bone of Object.keys(fa.bonePos)) {
        const pa = fa.bonePos[bone]!;
        const pb = fb.bonePos[bone]!;
        for (let k = 0; k < 3; k++) expect(pa[k]).toBeCloseTo(pb[k]!, 12);
      }
    }
  });

  it('烘焙轨道读回规范世界后与求解结果一致（预览/应用/导出同版本）', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'binding-fit' });
    const outcome = s.solve();
    expect(outcome.status).not.toBe('failed');
    const baked = s.bake();
    expect(baked.ok).toBe(true);
    if (!baked.ok) return;
    const output = s.outputRig()!;
    const frames = readBackWorld(baked.tracks, output, outcome.clip!.frames.length);
    for (let f = 0; f < frames.length; f++) {
      const solved = outcome.clip!.frames[f]!;
      const read = frames[f]!;
      for (const bone of output.order) {
        const rp = read[bone];
        const sp = solved.bonePos[bone];
        if (rp === undefined || sp === undefined) continue;
        for (let k = 0; k < 3; k++) {
          expect(rp.pos[k]).toBeCloseTo(sp[k]!, 6);
        }
      }
    }
    // 载荷形状：22 根映射骨 + 根位移（binding-export / clipToAnimClip 的输入契约）
    const payload = s.toAnimPayload(baked.tracks, 'walk');
    expect(Object.keys(payload.rotations).length).toBe(22);
    expect(payload.translation).not.toBeNull();
    expect(payload.times.length).toBe(6);
  });

  it('配方 JSON 重载可复现：同输入 → 同依赖指纹与同结果', () => {
    const first = new RetargetSession(memStore().store);
    first.loadSourceBvh(walkBvh(), 'walk');
    first.setTarget({ fitPositions: tposeWorldPositions(), name: 'binding-fit' });
    const o1 = first.solve();
    const json = first.recipeJson();
    expect(json).not.toBeNull();

    const second = new RetargetSession(memStore().store);
    second.loadSourceBvh(walkBvh(), 'walk');
    second.setTarget({ fitPositions: tposeWorldPositions(), name: 'binding-fit' });
    expect(second.loadRecipeJson(json!).ok).toBe(true);
    const o2 = second.solve();
    expect(o2.dependencyFingerprint).toBe(o1.dependencyFingerprint);
    expect(o2.status).toBe(o1.status);
    expect(o2.clip!.frames.length).toBe(o1.clip!.frames.length);
  });
});

// ---------------------------------------------------------------- A14：失效 / 失败不覆盖 / 取消

describe('retarget-session 失效与失败不覆盖', () => {
  it('输入变化 → stale，预览/应用/导出被守门拦下，但上一份结果保留', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'binding-fit' });
    const good = s.solve();
    expect(good.status).not.toBe('failed');
    expect(s.requireResult().ok).toBe(true);

    // 换源（不同内容）→ 待更新
    const changed = s.loadSourceBvh(buildBvhText({ frames: 4, armDeg: 30 }), 'other');
    expect(changed.ok).toBe(true);
    expect(s.isStale()).toBe(true);
    const guard = s.requireResult();
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.code).toBe('MRS_STALE');
    // 上一份结果仍在（失败/失效不丢产物）
    expect(s.result()).not.toBeNull();
    expect(s.result()!.dependencyFingerprint).toBe(good.dependencyFingerprint);
    expect(s.summary().status).toBe('stale');
  });

  it('求解失败不覆盖 lastGood（换错目标 → failed，旧结果仍可看）', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'binding-fit' });
    const good = s.solve();
    expect(good.status).not.toBe('failed');

    // 目标标定声明 world-rest 基准 → 与 direction 配方冲突 → 管线显式拒绝
    const bad = targetCalibration(1.0);
    bad.rotationBaseline = 'world-rest';
    expect(s.setTargetCalibration(bad).ok).toBe(true);
    const outcome = s.solve();
    expect(outcome.status).toBe('failed');
    // 失败不覆盖：lastGood 与 lastFailure 分开保留
    expect(s.result()).not.toBeNull();
    expect(s.result()!.dependencyFingerprint).toBe(good.dependencyFingerprint);
    expect(s.lastFailedAttempt()).not.toBeNull();
    expect(s.summary().lastFailureCode).not.toBeNull();
  });

  it('取消：已中止的信号 → MRC_CANCELLED，输入未变时上一份结果仍可消费', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'binding-fit' });
    const good = s.solve();
    expect(good.status).not.toBe('failed');

    const ac = new AbortController();
    ac.abort();
    const cancelled = s.solve(ac.signal);
    expect(cancelled.status).toBe('failed');
    expect(cancelled.diagnostics.some((d) => d.code === 'MRC_CANCELLED')).toBe(true);
    // 输入没变（revision 未前进）→ 不触发 stale，上一份结果继续可消费
    expect(s.isStale()).toBe(false);
    expect(s.requireResult().ok).toBe(true);
    expect(s.result()!.dependencyFingerprint).toBe(good.dependencyFingerprint);
  });

  it('未设源 / 未设目标 → 会话级失败码，不进入管线', () => {
    const s = new RetargetSession(memStore().store);
    const o = s.solve();
    expect(o.status).toBe('failed');
    expect(o.diagnostics.some((d) => d.code === 'MRS_NO_SOURCE')).toBe(true);
  });

  it('消费点守门：输入变化后 bake() 拒绝（MRS_STALE），旧轨道不得流出（复审 P0 回归）', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'binding-fit' });
    expect(s.solve().status).not.toBe('failed');
    const before = s.bake();
    expect(before.ok).toBe(true);
    // 参数修改（spaceMode）→ 待更新：烘焙（= 导出/挂载的上游）必须拒绝
    s.updateRecipeSettings({ spaceMode: 'preserve-world' });
    const after = s.bake();
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.code).toBe('MRS_STALE');
  });

  it('syncTarget：fit 被拖改 → changed + 失效；未改 → unchanged 不 bump（复审 P1 回归）', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    const fit = tposeWorldPositions();
    s.setTarget({ fitPositions: fit, name: 'binding-fit' });
    expect(s.solve().status).not.toBe('failed');
    expect(s.isStale()).toBe(false);
    // 同一 fit 再 sync：无变化
    const same = s.syncTarget({ fitPositions: fit, name: 'binding-fit' });
    expect(same.state).toBe('unchanged');
    expect(s.isStale()).toBe(false);
    // 拖高 Hips 10cm：目标几何变了
    const edited: JointPositions = { ...fit, Hips: [fit.Hips![0]!, fit.Hips![1]! + 0.1, fit.Hips![2]!] };
    const changed = s.syncTarget({ fitPositions: edited, name: 'binding-fit' });
    expect(changed.state).toBe('changed');
    expect(s.isStale()).toBe(true);
    const guard = s.requireResult();
    expect(guard.ok).toBe(false);
  });

  it('配方绑定标定指纹但会话未设标定 → 拒绝求解，不静默降级（R13 / 复审 P1 回归）', async () => {
    const { files, store } = memStore();
    // 先在一个带源标定的会话里产出配方 JSON
    files.set('assets/mocap/walk.bvh.meta.json', { retarget: { calibration: sourceCalibration() } });
    const calibrated = new RetargetSession(store);
    calibrated.loadSourceBvh(walkBvh(), 'walk');
    await calibrated.loadCalibrationFromMeta('source', 'assets/mocap/walk.bvh.meta.json');
    calibrated.setTarget({ fitPositions: tposeWorldPositions(), name: 'binding-fit' });
    expect(calibrated.solve().status).not.toBe('failed');
    const json = calibrated.recipeJson()!;

    // 新会话：同源同目标、载入该配方、但**不**设标定 → 求解必须失败并指出缺标定
    const bare = new RetargetSession(store);
    bare.loadSourceBvh(walkBvh(), 'walk');
    bare.setTarget({ fitPositions: tposeWorldPositions(), name: 'binding-fit' });
    expect(bare.loadRecipeJson(json).ok).toBe(true);
    const refused = bare.solve();
    expect(refused.status).toBe('failed');
    expect(refused.diagnostics.some((d) => d.code === 'MRS_RECIPE_CAL_UNBOUND')).toBe(true);
    // 补载标定后同一配方即可求解（配方的标定身份被恢复而非抹掉）
    const restored = await bare.loadCalibrationFromMeta('source', 'assets/mocap/walk.bvh.meta.json');
    expect(restored.ok).toBe(true);
    const ok2 = bare.solve();
    expect(ok2.status).not.toBe('failed');
    expect(ok2.coverage).toContain('world-lock');
  });

  it('summary.spaceMode 回显当前配方（复审 P2 回归：呈现层不得自持状态）', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'binding-fit' });
    s.solve();
    expect(s.summary().spaceMode).toBe('normalize-gait');
    s.updateRecipeSettings({ spaceMode: 'preserve-world' });
    expect(s.summary().spaceMode).toBe('preserve-world');
    expect(s.summary().status).toBe('stale');
  });

  it('动作位移纠正：覆盖根模式 → 重采样 + 待更新；非法声明被拒且源保持（UX 审核 P1 回归）', () => {
    const s = new RetargetSession(memStore().store);
    // 站立 BVH（位置通道恒定）→ 自动检测为原地（有轨迹）、不可世界锁脚
    s.loadSourceBvh(buildBvhText({ frames: 5 }), 'stand');
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'binding-fit' });
    s.solve();
    expect(s.summary().rootMode).toBe('in-place-with-trajectory');
    expect(s.summary().rootMotionSetting).toBe('auto');
    // 用户纠正为「包含场景位移」→ canWorldLock 打开 + 结果待更新
    const fix = s.setSourceRootMotion('world-trajectory');
    expect(fix.ok).toBe(true);
    expect(s.summary().rootMode).toBe('world-trajectory');
    expect(s.summary().canWorldLock).toBe(true);
    expect(s.summary().rootMotionSetting).toBe('world-trajectory');
    expect(s.summary().status).toBe('stale');
    // 无位置通道的源声明轨迹 → 非法组合被拒，源保持原状
    const phaseOnly = new RetargetSession(memStore().store);
    phaseOnly.loadSourceBvh(buildBvhText({ frames: 5, rootChannels: '3' }), 'phase');
    const bad = phaseOnly.setSourceRootMotion('world-trajectory');
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics.some((d) => d.code === 'MRS_ROOT_MOTION_INVALID')).toBe(true);
    expect(phaseOnly.summary().rootMode).toBe('in-place-with-phase');
  });

  it('容器祖先（平移 + 统一缩放 2）下端到端：烘焙读回 == 求解世界（两份 FK 不得漂移）', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    const set = s.setTarget({ skeleton: skeletonWithContainer(tposeWorldPositions()), name: 'container-object' });
    expect(set.ok).toBe(true);
    const outcome = s.solve();
    expect(outcome.status).not.toBe('failed');
    const baked = s.bake();
    expect(baked.ok).toBe(true);
    if (!baked.ok) return;
    const output = s.outputRig()!;
    expect(output.rootParentWorld).not.toBeNull();
    expect(output.rootParentWorld!.uniformScale).toBeCloseTo(2, 12);
    const frames = readBackWorld(baked.tracks, output, outcome.clip!.frames.length);
    for (let f = 0; f < frames.length; f++) {
      const solved = outcome.clip!.frames[f]!;
      const read = frames[f]!;
      for (const bone of output.order) {
        const rp = read[bone];
        const sp = solved.bonePos[bone];
        if (rp === undefined || sp === undefined) continue;
        for (let k = 0; k < 3; k++) {
          expect(rp.pos[k]).toBeCloseTo(sp[k]!, 6);
        }
      }
    }
  });
});

// ---------------------------------------------------------------- A16：标定 sidecar

describe('retarget-session A16 标定持久化与单侧失效', () => {
  it('标定保存到 sidecar 是 merge（保留同文件 retarget.recipe 与其它顶层键）', async () => {
    const { files, store } = memStore();
    files.set('assets/mocap/walk.bvh.meta.json', {
      schemaVersion: 1,
      importer: { keep: true },
    });
    const s = new RetargetSession(store);
    s.loadSourceBvh(walkBvh(), 'walk');
    const cal = sourceCalibration();
    expect(s.setSourceCalibration(cal).ok).toBe(true);
    const saved = await s.saveCalibrationToMeta('source', 'assets/mocap/walk.bvh.meta.json');
    expect(saved.ok).toBe(true);
    const meta = files.get('assets/mocap/walk.bvh.meta.json')!;
    expect(meta.importer).toEqual({ keep: true }); // 其它顶层键不被冲掉
    const block = meta.retarget as { calibration: RetargetCalibration };
    expect(block.calibration.side).toBe('source');
    expect(calibrationFingerprint(block.calibration)).toBe(calibrationFingerprint(cal));
  });

  it('重载后标定保持一致：指纹不变、求解走标定路径（世界锁脚）', async () => {
    const { files, store } = memStore();
    const cal = sourceCalibration();
    files.set('assets/mocap/walk.bvh.meta.json', {
      retarget: { calibration: cal },
    });
    const s = new RetargetSession(store);
    s.loadSourceBvh(walkBvh(), 'walk');
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'binding-fit' });
    const load = await s.loadCalibrationFromMeta('source', 'assets/mocap/walk.bvh.meta.json');
    expect(load.ok).toBe(true);
    const outcome = s.solve();
    expect(outcome.status).not.toBe('failed');
    // 已标定 + 有可信轨迹 + 双侧足底标记 → 世界锁脚能力被声明
    expect(outcome.coverage).toContain('world-lock');
    expect(outcome.coverage).not.toContain('contact-uncalibrated');
  });

  it('改目标侧标定只重绑目标侧指纹，源侧绑定不动（A16）', async () => {
    const { files, store } = memStore();
    files.set('assets/mocap/walk.bvh.meta.json', { retarget: { calibration: sourceCalibration() } });
    const s = new RetargetSession(store);
    s.loadSourceBvh(walkBvh(), 'walk');
    await s.loadCalibrationFromMeta('source', 'assets/mocap/walk.bvh.meta.json');
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'binding-fit' });
    const before = s.solve();
    expect(before.status).not.toBe('failed');
    const srcFpBefore = calibrationFingerprint(sourceCalibration());

    const newTgt = targetCalibration(1.05); // h_t 改了 5cm
    expect(s.setTargetCalibration(newTgt).ok).toBe(true);
    expect(s.isStale()).toBe(true);
    const after = s.solve();
    expect(after.status).not.toBe('failed');
    expect(after.dependencyFingerprint).not.toBe(before.dependencyFingerprint); // 结果失效重算
    const recipe = s.recipeJson()!;
    const parsed = JSON.parse(recipe) as { sourceCalibrationFingerprint: string; targetCalibrationFingerprint: string };
    expect(parsed.sourceCalibrationFingerprint).toBe(srcFpBefore); // 源侧不动
    expect(parsed.targetCalibrationFingerprint).toBe(calibrationFingerprint(newTgt)); // 重算用新指纹
  });

  it('sidecar 坏数据被拒绝：side 不匹配 / 标定缺失 / 文件缺失', async () => {
    const { files, store } = memStore();
    files.set('assets/x.meta.json', { retarget: { calibration: sourceCalibration() } });
    const s = new RetargetSession(store);
    const wrongSide = await s.loadCalibrationFromMeta('target', 'assets/x.meta.json');
    expect(wrongSide.ok).toBe(false);
    expect(wrongSide.diagnostics.some((d) => d.code === 'MRS_CAL_SIDE_MISMATCH')).toBe(true);

    files.set('assets/empty.meta.json', { schemaVersion: 1 });
    const absent = await s.loadCalibrationFromMeta('source', 'assets/empty.meta.json');
    expect(absent.ok).toBe(false);
    expect(absent.diagnostics.some((d) => d.code === 'MRS_CAL_ABSENT')).toBe(true);

    const missing = await s.loadCalibrationFromMeta('source', 'assets/nope.meta.json');
    expect(missing.ok).toBe(false);
  });
});

// ---------------------------------------------------------------- 能力缺口状态（对话验收口径）

describe('retarget-session 能力状态', () => {
  it('未标定源 → 部分完成 + contact-uncalibrated，不谎报世界锁脚', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'binding-fit' });
    const outcome = s.solve();
    expect(outcome.status).toBe('partial');
    expect(outcome.coverage).toContain('contact-uncalibrated');
    const sum = s.summary();
    expect(sum.status).toBe('partial');
    expect(sum.sourceCalibrated).toBe(false);
    expect(sum.diagnostics.some((d) => d.code === 'MRC_CONTACT_UNCALIBRATED')).toBe(true);
  });

  it('summary 状态机：idle → ready → pass/partial → stale', () => {
    const s = new RetargetSession(memStore().store);
    expect(s.summary().status).toBe('idle');
    s.loadSourceBvh(walkBvh(), 'walk');
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'binding-fit' });
    expect(s.summary().status).toBe('ready');
    s.solve();
    expect(['pass', 'partial']).toContain(s.summary().status);
    s.updateRecipeSettings({ spaceMode: 'preserve-world' });
    expect(s.summary().status).toBe('stale');
  });

  it('非法配方参数被就地拒绝（滞回 / 秒制），不改状态', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'binding-fit' });
    s.solve();
    const bad = s.updateRecipeSettings({
      contactDetection: { heightEnter: 0.02, speedEnter: 0.3, speedExit: 0.25, minDurationS: 0.08 },
    });
    expect(bad.ok).toBe(false); // speedExit < speedEnter 违反滞回
    expect(s.summary().status).not.toBe('stale'); // 拒绝时不前进 revision
  });
});

// ---------------------------------------------------------------- 附：fit → 骨架合成的几何正确性

describe('skeletonFromFitPositions', () => {
  it('合成骨架的 FK 世界位置 == fit 原坐标（rest 旋转恒 identity）', () => {
    const fit = tposeWorldPositions();
    const sk = skeletonFromFitPositions(fit);
    // 沿父链 FK
    for (let i = 0; i < HUMANIK_ORDER.length; i++) {
      const n = HUMANIK_ORDER[i]!;
      const p = sk.parent[i]!;
      const t = sk.locals[i]!.t;
      if (p < 0) {
        expect(t[0]).toBeCloseTo(fit[n]![0], 12);
        expect(t[1]).toBeCloseTo(fit[n]![1], 12);
        expect(t[2]).toBeCloseTo(fit[n]![2], 12);
      } else {
        const pn = HUMANIK_ORDER[p]!;
        expect(t[0] + fit[pn]![0]).toBeCloseTo(fit[n]![0], 12);
        expect(t[1] + fit[pn]![1]).toBeCloseTo(fit[n]![1], 12);
        expect(t[2] + fit[pn]![2]).toBeCloseTo(fit[n]![2], 12);
      }
    }
  });
});
