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
import { sourceRestDirections } from '../../src/services/binding/motion-retarget/source-motion';
import { parseBvh } from '../../src/services/binding/bvh-parser';
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

/** 把 BVH 文本里全部 OFFSET 数值 ×k（换骨架体型用，不动通道/帧数据） */
function scaleBvhOffsets(text: string, k: number): string {
  return text.replace(/OFFSET (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/g, (_, a, b, c) =>
    `OFFSET ${Number(a) * k} ${Number(b) * k} ${Number(c) * k}`);
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

  it('动作位移纠正：覆盖根模式 → 重采样 + 待更新；非法声明被拒且源保持（UX 审核 P1 回归）', () => {    const s = new RetargetSession(memStore().store);
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

// ---------------------------------------------------------------- 标定归属（UX 复审 P1「不同骨架沿用旧标定」）

describe('retarget-session 标定归属与兼容停用', () => {
  it('换不同体型的源 → 旧源标定自动停用并警告（不再显示已标定地求解）', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    expect(s.setSourceCalibration(sourceCalibration()).ok).toBe(true);
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'binding-fit' });
    const good = s.solve();
    expect(good.coverage).toContain('world-lock');

    // 换一具整体 ×1.5 的骨架（骨盆 1.0→1.5m）：rest 骨盆高超出 35% 带宽 → 停用
    const swapped = s.loadSourceBvh(scaleBvhOffsets(walkBvh(), 1.5), 'big');
    expect(swapped.ok).toBe(true);
    expect(s.summary().sourceCalibrated).toBe(false);
    expect(s.summary().diagnostics.some((d) => d.code === 'MRS_SOURCE_CAL_DETACHED')).toBe(true);
    // 停用后求解回到未标定语义（自由运动、不谎报锁脚）
    const after = s.solve();
    expect(after.coverage).toContain('contact-uncalibrated');
    expect(after.coverage).not.toContain('world-lock');
  });

  it('同骨架换 clip → 标定保留（可复用是其设计目的，不得误停用）', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    expect(s.setSourceCalibration(sourceCalibration()).ok).toBe(true);
    // 同一具骨架的另一段动作（帧数/内容不同、骨髯相同）
    s.loadSourceBvh(buildBvhText({ frames: 5, armDeg: 20 }), 'same-rig-other-clip');
    expect(s.summary().sourceCalibrated).toBe(true);
    expect(s.summary().diagnostics.some((d) => d.code === 'MRS_SOURCE_CAL_DETACHED')).toBe(false);
  });

  it('显式载入错骨架的源标定 → 拒绝（骨盆高 / 隐含足底判据）', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    // 判据 1：骨盆高带宽
    const wrongHips = sourceCalibration();
    wrongHips.pelvisHeightM = 2.0;
    const r1 = s.setSourceCalibration(wrongHips);
    expect(r1.ok).toBe(false);
    expect(r1.diagnostics.some((d) => d.code === 'MRS_CAL_PELVIS_MISMATCH')).toBe(true);
    // 判据 2：骨盆 → 最低标记的几何距离（标记深 0.5m → 距离 1.47m vs 声明 1.0m）
    const wrongSole = sourceCalibration();
    for (const id of Object.keys(wrongSole.markers)) {
      wrongSole.markers[id]!.offset = [0, -0.5, 0];
    }
    const r2 = s.setSourceCalibration(wrongSole);
    expect(r2.ok).toBe(false);
    expect(r2.diagnostics.some((d) => d.code === 'MRS_CAL_PELVIS_MISMATCH')).toBe(true);
    // 判据 3：标记骨不存在
    const wrongBone = sourceCalibration();
    wrongBone.markers['GhostFoot.heel'] = { bone: 'GhostFoot', offset: [0, 0, 0], origin: 'manual' };
    const r3 = s.setSourceCalibration(wrongBone);
    expect(r3.ok).toBe(false);
    expect(r3.diagnostics.some((d) => d.code === 'MRS_CAL_BONE_MISSING')).toBe(true);
    // 会话保持未标定
    expect(s.summary().sourceCalibrated).toBe(false);
  });

  it('换不同体型的目标骨架 → 旧目标标定自动停用；显式错配拒绝', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    const fit = tposeWorldPositions();
    s.setTarget({ fitPositions: fit, name: 'a' });
    expect(s.setTargetCalibration(targetCalibration(1.0)).ok).toBe(true);
    expect(s.summary().targetCalibrated).toBe(true);

    // 换 ×1.5 体型：基线 h_t ≈1.55 vs 标定 1.0 → 超带宽 → 停用 + 警告，目标仍成功构建
    const scaledFit: JointPositions = {};
    for (const [k, p] of Object.entries(fit)) scaledFit[k] = [p[0]! * 1.5, p[1]! * 1.5, p[2]! * 1.5];
    const r = s.setTarget({ fitPositions: scaledFit, name: 'b' });
    expect(r.ok).toBe(true);
    expect(s.summary().targetCalibrated).toBe(false);
    expect(s.summary().diagnostics.some((d) => d.code === 'MRS_TARGET_CAL_DETACHED')).toBe(true);

    // 显式给小骨架载大骨架的标定 → 拒绝
    const bad = s.setTargetCalibration(targetCalibration(2.5));
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics.some((d) => d.code === 'MRS_CAL_PELVIS_MISMATCH')).toBe(true);
  });

  it('summary.tolerances 暴露绝对容差（×h_t）供问题帧判定', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'fit' });
    s.solve();
    const tol = s.summary().tolerances;
    expect(tol).not.toBeNull();
    const hT = s.summary().targetPlaneY;
    expect(hT).not.toBeNull();
    // anchorM = 0.002 × h_t（h_t = Hips − 平面），正数且量级在毫米级
    expect(tol!.anchorM).toBeGreaterThan(0.001);
    expect(tol!.anchorM).toBeLessThan(0.005);
  });
});

describe('retarget-session 标定诊断通道（复审 P3 回归）', () => {
  it('一侧通过/操作不得抹掉另一侧的停用警告', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    const fit = tposeWorldPositions();
    s.setTarget({ fitPositions: fit, name: 'a' });
    s.setTargetCalibration(targetCalibration(1.0));
    // 换 ×1.5 骨架 → 目标侧停用
    const scaledFit: JointPositions = {};
    for (const [k, p] of Object.entries(fit)) scaledFit[k] = [p[0]! * 1.5, p[1]! * 1.5, p[2]! * 1.5];
    s.setTarget({ fitPositions: scaledFit, name: 'b' });
    expect(s.summary().diagnostics.some((d) => d.code === 'MRS_TARGET_CAL_DETACHED')).toBe(true);
    // 源侧随后换 clip（源侧通道无警告、检查跳过）→ 目标侧警告必须保留
    s.loadSourceBvh(buildBvhText({ frames: 5 }), 'other-clip');
    expect(s.summary().diagnostics.some((d) => d.code === 'MRS_TARGET_CAL_DETACHED')).toBe(true);
    // 显式载回匹配的目标标定 → 该侧警告清除
    expect(s.setTargetCalibration(targetCalibration(scaledFit.Hips![1]!)).ok).toBe(true);
    expect(s.summary().diagnostics.some((d) => d.code === 'MRS_TARGET_CAL_DETACHED')).toBe(false);
  });

  it('源停用警告随源再换而过期清除（不指向已不在场的老骨架）', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    s.setSourceCalibration(sourceCalibration());
    // 换 ×1.5 骨架 → 源标定停用 + 警告
    s.loadSourceBvh(scaleBvhOffsets(walkBvh(), 1.5), 'big');
    expect(s.summary().diagnostics.some((d) => d.code === 'MRS_SOURCE_CAL_DETACHED')).toBe(true);
    expect(s.summary().sourceCalibrated).toBe(false);
    // 再换第三具骨架（指纹又不同）→ 停用警告过期清除（徽章「需标定」仍持续提示）
    s.loadSourceBvh(scaleBvhOffsets(walkBvh(), 1.2), 'another');
    expect(s.summary().diagnostics.some((d) => d.code === 'MRS_SOURCE_CAL_DETACHED')).toBe(false);
    expect(s.summary().sourceCalibrated).toBe(false);
  });
});

describe('retarget-session 标定判据的坐标规则（三判 P1 反例回归）', () => {
  it('P1-1：只改根 OFFSET（位置通道驱动世界）→ 骨架几何未变，标定不得误拒', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    expect(s.setSourceCalibration(sourceCalibration()).ok).toBe(true);
    // 有位置通道时，采样世界根完全由通道值决定：改根 OFFSET 不改任何采样位置
    const movedRoot = walkBvh().replace('OFFSET 0 100 0', 'OFFSET 0 55 0');
    expect(movedRoot).not.toBe(walkBvh());
    const r = s.loadSourceBvh(movedRoot, 'moved-root');
    expect(r.ok).toBe(true);
    // 骨盆相对几何不变 → 标定保留（旧判据把根 OFFSET 当世界骨盆高，会误停用）
    expect(s.summary().sourceCalibrated).toBe(true);
    expect(s.summary().diagnostics.some((d) => d.code === 'MRS_SOURCE_CAL_DETACHED')).toBe(false);
  });

  it('P1-2：体型编辑路径 syncTarget 不再绕过目标标定兼容检查', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    expect(s.setSourceCalibration(sourceCalibration()).ok).toBe(true);
    const fit = tposeWorldPositions();
    s.setTarget({ fitPositions: fit, name: 'a' });
    expect(s.setTargetCalibration(targetCalibration(1.0)).ok).toBe(true);
    // 入口 A 实际用的路径：syncTarget 换 ×1.5 体型 → 必须停用旧标定（旧实现直接带病构建）
    const scaledFit: JointPositions = {};
    for (const [k, p] of Object.entries(fit)) scaledFit[k] = [p[0]! * 1.5, p[1]! * 1.5, p[2]! * 1.5];
    const r = s.syncTarget({ fitPositions: scaledFit, name: 'a' });
    expect(r.state).toBe('changed');
    expect(s.summary().targetCalibrated).toBe(false);
    expect(s.summary().diagnostics.some((d) => d.code === 'MRS_TARGET_CAL_DETACHED')).toBe(true);
    // 停用后求解用骨架自算 h_t（不再是旧标定的 1.0）；源标定不受影响 → 世界锁脚照常
    const out = s.solve();
    expect(out.status).not.toBe('failed');
    expect(out.coverage).toContain('world-lock');
  });

  it('P1-3：厘米骨架 + unitScale=0.01 的目标标定不被未换算基线误拒', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    // 厘米制外部骨架（模板位置 ×100）
    const cmFit: JointPositions = {};
    for (const [k, p] of Object.entries(tposeWorldPositions())) cmFit[k] = [p[0]! * 100, p[1]! * 100, p[2]! * 100];
    s.setTarget({ fitPositions: cmFit, name: 'cm-rig' });
    const cmCal = targetCalibration(1.0);
    cmCal.unitScale = 0.01;
    const r = s.setTargetCalibration(cmCal);
    expect(r.ok).toBe(true); // 基线按标定单位换算后 ≈1.0m，不再拿 97.03 比 1.0
    expect(s.summary().targetCalibrated).toBe(true);
    expect(s.summary().diagnostics.some((d) => d.code === 'MRS_CAL_PELVIS_MISMATCH')).toBe(false);
  });
});

describe('retarget-session 标定判据契约（85620c9 复审三反例回归）', () => {
  it('P1 反例1：停用几何标定不得丢单位换算（cm 骨架编辑体型后仍是米制）', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    // 厘米骨架 + 有效标定（unitScale=.01）
    const cmFit: JointPositions = {};
    for (const [k, p] of Object.entries(tposeWorldPositions())) cmFit[k] = [p[0]! * 100, p[1]! * 100, p[2]! * 100];
    s.setTarget({ fitPositions: cmFit, name: 'cm-rig' });
    const cmCal = targetCalibration(1.0);
    cmCal.unitScale = 0.01;
    expect(s.setTargetCalibration(cmCal).ok).toBe(true);
    expect(s.targetSkeletonView()!.planeY).toBeLessThan(1); // 米制

    // 编辑体型 ×1.5 → 几何停用；单位换算必须保留（旧实现退回 unitScale=1 → 145m）
    const scaledCm: JointPositions = {};
    for (const [k, p] of Object.entries(cmFit)) scaledCm[k] = [p[0]! * 1.5, p[1]! * 1.5, p[2]! * 1.5];
    const r = s.syncTarget({ fitPositions: scaledCm, name: 'cm-rig' });
    expect(r.state).toBe('changed');
    expect(s.summary().targetCalibrated).toBe(false);
    expect(s.summary().diagnostics.some((d) => d.code === 'MRS_TARGET_CAL_DETACHED')).toBe(true);
    // 单位保留的铁证：支撑面仍在米制量级（丢单位会变成 ~4.5m 级）
    expect(s.targetSkeletonView()!.planeY).toBeLessThan(1);
    expect(s.summary().diagnostics.some((d) => d.code === 'MRS_TARGET_UNITS_DROPPED')).toBe(false);
  });

  it('P1 反例1 附属：换资产不沿用旧单位（资产键门控），回原资产复用', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    const cmFit: JointPositions = {};
    for (const [k, p] of Object.entries(tposeWorldPositions())) cmFit[k] = [p[0]! * 100, p[1]! * 100, p[2]! * 100];
    s.setTarget({ fitPositions: cmFit, name: 'cm-rig' });
    const cmCal = targetCalibration(1.0);
    cmCal.unitScale = 0.01;
    expect(s.setTargetCalibration(cmCal).ok).toBe(true);
    // 换**米制**资产（不同键）：单位上下文不沿用——直接按默认米制构建，无跨资产污染
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'meter-rig' });
    const py = s.targetSkeletonView()!.planeY;
    expect(py).toBeGreaterThan(-0.5);
    expect(py).toBeLessThan(0.5);
    // 换回原 cm 资产（同键）：上下文复用（不再触发丢弃/推断）
    s.setTarget({ fitPositions: cmFit, name: 'cm-rig' });
    expect(s.targetSkeletonView()!.planeY).toBeLessThan(1);
  });

  it('P1 反例2：角色与地面同时抬高 0.5m（比例不变）→ 源/目标标定都不得误拒', () => {
    const s = new RetargetSession(memStore().store);
    // 源：根抬高到 150cm；标定声明平面 y=0.5、骨盆到支撑面 1.0（相对量，契约语义）
    const raised = walkBvh().replace('OFFSET 0 100 0', 'OFFSET 0 150 0');
    s.loadSourceBvh(raised, 'raised');
    const srcCal = sourceCalibration(); // pelvisHeightM 1.0
    srcCal.supportPlane = { origin: [0, 0.5, 0], normal: [0, 1, 0], source: 'declared', confidence: 1 };
    const rs = s.setSourceCalibration(srcCal);
    expect(rs.ok).toBe(true); // 旧实现按 1.0−0.5=0.5 对比几何下垂 1.0 → 误拒
    expect(s.summary().sourceCalibrated).toBe(true);

    // 目标：fit 整体抬高 0.5 + 带足底标记 + 声明平面 y=0.5
    const raisedFit: JointPositions = {};
    for (const [k, p] of Object.entries(tposeWorldPositions())) raisedFit[k] = [p[0]!, p[1]! + 0.5, p[2]!];
    s.setTarget({ fitPositions: raisedFit, name: 'raised-rig' });
    const tgtCal = targetCalibration(1.0);
    tgtCal.supportPlane = { origin: [0, 0.5, 0], normal: [0, 1, 0], source: 'declared', confidence: 1 };
    tgtCal.markers = {
      'LeftFoot.heel': { bone: 'LeftFoot', offset: [0, -0.03, -0.05], origin: 'manual' },
      'LeftFoot.ball': { bone: 'LeftFoot', offset: [0, -0.03, 0.09], origin: 'manual' },
      'RightFoot.heel': { bone: 'RightFoot', offset: [0, -0.03, -0.05], origin: 'manual' },
      'RightFoot.ball': { bone: 'RightFoot', offset: [0, -0.03, 0.09], origin: 'manual' },
    };
    const rt = s.setTargetCalibration(tgtCal);
    expect(rt.ok).toBe(true);
    expect(s.summary().targetCalibrated).toBe(true);
  });

  it('P1 反例3：单侧腿变长不得被另一侧的最小下垂掩盖', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    expect(s.setSourceCalibration(sourceCalibration()).ok).toBe(true);
    // 只把左腿一段加长 42cm（JS 单次字符串替换只改第一处 = LeftLeg）
    const leftLonger = walkBvh().replace('OFFSET 0 -42 0', 'OFFSET 0 -84 0');
    expect(leftLonger.includes('OFFSET 0 -84 0')).toBe(true);
    // 右腿的 -42 仍在（只改了一处）
    expect(leftLonger.includes('OFFSET 0 -42 0')).toBe(true);
    const r = s.loadSourceBvh(leftLonger, 'left-longer');
    expect(r.ok).toBe(true);
    // 左脚下垂 1.42m > 1.0×1.35 → 停用；右腿 1.0 不得掩盖
    expect(s.summary().sourceCalibrated).toBe(false);
    expect(s.summary().diagnostics.some((d) => d.code === 'MRS_SOURCE_CAL_DETACHED')).toBe(true);
  });
});

describe('retarget-session 复审跟进（b840ac6 复审 P2/P3 回归）', () => {
  it('P2：资产键门控下换回 cm 资产直接复用单位（不静默 97m）', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    const cmFit: JointPositions = {};
    for (const [k, p] of Object.entries(tposeWorldPositions())) cmFit[k] = [p[0]! * 100, p[1]! * 100, p[2]! * 100];
    s.setTarget({ fitPositions: cmFit, name: 'cm-rig' });
    const cmCal = targetCalibration(1.0);
    cmCal.unitScale = 0.01;
    expect(s.setTargetCalibration(cmCal).ok).toBe(true);
    // 换米制资产（不同键）→ 不沿用；换回 cm 资产（同键）→ 上下文直接复用
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'meter-rig' });
    s.setTarget({ fitPositions: cmFit, name: 'cm-rig' });
    expect(s.targetSkeletonView()!.planeY).toBeLessThan(1); // 米制量级（97m 级是错的）
    const again = s.syncTarget({ fitPositions: cmFit, name: 'cm-rig' });
    expect(again.state).toBe('unchanged');
    const out = s.solve();
    expect(out.status).not.toBe('failed');
  });

  it('P1(1505f36)：无标定资产的单位上下文按资产键隔离——.1 资产不得污染米制资产', () => {
    // 差分 oracle：B 直接载入 vs 先载 A(.1) 再切 B，两者骨架必须一致
    const mk = () => {
      const s = new RetargetSession(memStore().store);
      s.loadSourceBvh(walkBvh(), 'walk');
      return s;
    };
    const fitA: JointPositions = {}; // 分米制授权：数字 ×10
    for (const [k, p] of Object.entries(tposeWorldPositions())) fitA[k] = [p[0]! * 10, p[1]! * 10, p[2]! * 10];
    const fitB = tposeWorldPositions(); // 米制
    // 直接 B
    const direct = mk();
    direct.setTarget({ fitPositions: fitB, name: 'B' });
    const directPelvis = direct.targetSkeletonView()!.pelvisHeightM;
    // 先 A（带 .1 标定）再切 B
    const viaA = mk();
    viaA.setTarget({ fitPositions: fitA, name: 'A' });
    const calA = targetCalibration(1.0);
    calA.unitScale = 0.1;
    expect(viaA.setTargetCalibration(calA).ok).toBe(true);
    viaA.setTarget({ fitPositions: fitB, name: 'B' });
    expect(viaA.targetSkeletonView()!.pelvisHeightM).toBeCloseTo(directPelvis, 9);
    // 两边都在人形区间内（0.1 缩放后的 B≈0.2m 也合法）——差异只能靠资产键拦住
  });

  it('P3：手部标记（下垂远小于 h）不劫持足底判据', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    const cal = sourceCalibration(); // 足底 droop=1.0 ≈ h=1.0
    // T-pose 手在肩上方：骨盆→手下垂 ≈ -0.55（负值），min 口径会误拒
    cal.markers['LeftHand.palm'] = { bone: 'LeftHand', offset: [0, 0, 0], origin: 'manual' };
    const r = s.setSourceCalibration(cal);
    expect(r.ok).toBe(true); // 深处仍由足底决定 ≈ h；手标记不进最深判据
    // 目标侧同口径
    const fit = tposeWorldPositions();
    s.setTarget({ fitPositions: fit, name: 'rig' });
    const t = targetCalibration(1.0);
    t.markers = {
      'LeftFoot.heel': { bone: 'LeftFoot', offset: [0, -0.03, -0.05], origin: 'manual' },
      'RightFoot.heel': { bone: 'RightFoot', offset: [0, -0.03, -0.05], origin: 'manual' },
      'LeftHand.palm': { bone: 'LeftHand', offset: [0, 0, 0], origin: 'manual' },
    };
    expect(s.setTargetCalibration(t).ok).toBe(true);
  });
});

describe('retarget-session 单侧缩短不得被未变侧掩盖（复审 P1 回归）', () => {
  it('源：左腿 −42→−2（左脚下垂 0.60 / 右 1.00）→ 停用', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    expect(s.setSourceCalibration(sourceCalibration()).ok).toBe(true);
    const shortened = walkBvh().replace('OFFSET 0 -42 0', 'OFFSET 0 -2 0'); // 只改第一处 = LeftLeg
    expect(shortened.includes('OFFSET 0 -2 0')).toBe(true);
    expect(shortened.includes('OFFSET 0 -42 0')).toBe(true); // RightLeg 未动
    expect(s.loadSourceBvh(shortened, 'left-shorter').ok).toBe(true);
    expect(s.summary().sourceCalibrated).toBe(false);
    expect(s.summary().diagnostics.some((d) => d.code === 'MRS_SOURCE_CAL_DETACHED')).toBe(true);
  });

  it('目标：左脚骨上移 40cm → 显式载入被拒 / 已载标定被停用', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    const fit = tposeWorldPositions();
    const cal = targetCalibration(1.0);
    cal.markers = {
      'LeftFoot.heel': { bone: 'LeftFoot', offset: [0, -0.03, -0.05], origin: 'manual' },
      'RightFoot.heel': { bone: 'RightFoot', offset: [0, -0.03, -0.05], origin: 'manual' },
    };
    s.setTarget({ fitPositions: fit, name: 'a' });
    expect(s.setTargetCalibration(cal).ok).toBe(true);
    // 左脚骨上移 40cm：左足下垂 0.6、右足 1.0——已载标定在换骨架时停用
    const liftedFit: JointPositions = { ...fit, LeftFoot: [fit.LeftFoot![0]!, fit.LeftFoot![1]! + 0.4, fit.LeftFoot![2]!] };
    const r = s.syncTarget({ fitPositions: liftedFit, name: 'a' });
    expect(r.state).toBe('changed');
    expect(s.summary().targetCalibrated).toBe(false);
    expect(s.summary().diagnostics.some((d) => d.code === 'MRS_TARGET_CAL_DETACHED')).toBe(true);
    // 显式载入错骨架：直接拒绝
    const bad = s.setTargetCalibration(cal);
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics.some((d) => d.code === 'MRS_CAL_PELVIS_MISMATCH')).toBe(true);
  });
});

describe('retarget-session 标定载入事务性（1505f36 复审 P2 回归）', () => {
  it('模板目标载入不支持的 X-up 标定：失败不覆盖原标定，清除仍可用', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    s.setTarget({ name: 'tpl' }); // 模板目标（无 skeleton/fit）
    // 先放一个模板接受的标定（单位/轴向 null → 模板规范形态）
    expect(s.setTargetCalibration(targetCalibration(1.0)).ok).toBe(true);
    expect(s.summary().targetCalibrated).toBe(true);
    // X-up 标定：模板分支 MRR_TEMPLATE_NOT_CANONICAL 拒绝——失败且**不覆盖**原状态
    const xup = targetCalibration(1.0);
    xup.upAxis = 'x';
    const r = s.setTargetCalibration(xup);
    expect(r.ok).toBe(false);
    expect(s.summary().targetCalibrated).toBe(true); // 旧标定保留（事务回滚）
    // 清除不再被失败状态卡死
    expect(s.setTargetCalibration(null).ok).toBe(true);
    expect(s.summary().targetCalibrated).toBe(false);
  });
});

describe('retarget-session 完整标定的资产归属（37bd3ad 复审 P1 回归）', () => {
  it('先载已标定的 A 再切 B：B 不得沿用 A 的完整标定（等比骨架让几何检查恰好通过）', () => {
    const mk = () => {
      const s = new RetargetSession(memStore().store);
      s.loadSourceBvh(walkBvh(), 'walk');
      return s;
    };
    // Luna 构造：A/B **原始数字相同**、唯一差异是资产键——几何检查（用 A 的
    // 单位解释 B）必然通过，只有资产归属能拦。
    // A：模板原始数字 + 单位声明 0.5 → 真实骨盆 ≈0.515m，标定声明与之一致
    const fitA = tposeWorldPositions();
    const calA = targetCalibration(0.515);
    calA.unitScale = 0.5;
    calA.markers = {
      'LeftFoot.heel': { bone: 'LeftFoot', offset: [0, -0.03, -0.05], origin: 'manual' },
      'RightFoot.heel': { bone: 'RightFoot', offset: [0, -0.03, -0.05], origin: 'manual' },
    };
    // B：同一套原始数字，米制授权（直载骨盆 ≈1.03m；被 A 的 0.5 单位解释 → 0.515m）
    const fitB = tposeWorldPositions();
    // 直接 B（无任何标定史）
    const direct = mk();
    direct.setTarget({ fitPositions: fitB, name: 'B' });
    const directPelvis = direct.targetSkeletonView()!.pelvisHeightM;
    // 先 A（带完整标定）再切 B：B 的原始数字 ×A 的 0.5 恰好复现 A 的几何 →
    // 几何检查通过，只有资产归属检查能拦（旧实现：B 被按 0.5 单位建出 1.03m 并误报已标定）
    const viaA = mk();
    viaA.setTarget({ fitPositions: fitA, name: 'A' });
    expect(viaA.setTargetCalibration(calA).ok).toBe(true);
    viaA.setTarget({ fitPositions: fitB, name: 'B' });
    // 骨盆高差分（单位敏感量：直载 ≈1.03m；旧 bug 下被 A 的 0.5 单位解释成 ≈0.515m）
    expect(viaA.targetSkeletonView()!.pelvisHeightM).toBeCloseTo(directPelvis, 9);
    expect(viaA.summary().targetCalibrated).toBe(false); // 不误报已标定
    expect(viaA.summary().diagnostics.some((d) => d.code === 'MRS_TARGET_CAL_DETACHED')).toBe(true);
  });

  it('无目标时载入目标标定被拒绝（不再产出 owner 未知的死标定）', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    const r = s.setTargetCalibration(targetCalibration(1.0));
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.code === 'MRS_NO_TARGET')).toBe(true);
    // 状态未被触碰
    expect(s.summary().targetCalibrated).toBe(false);
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'rig' });
    expect(s.setTargetCalibration(targetCalibration(1.0)).ok).toBe(true); // 有目标后正常
  });
});

describe('retarget-session 新目标构建失败的完整保留（099a5d1 复审 P1 回归）', () => {
  /** 非统一缩放的目标骨架：把某节点 locals 的 s 改成 [1,1,2] */
  function nonUniformSkeleton(): SkeletonData {
    const sk = skeletonFromPositions(tposeWorldPositions());
    const i = HUMANIK_ORDER.indexOf('LeftFoot');
    sk.locals[i]!.s = [1, 1, 2];
    return sk;
  }

  it('setTarget 拒绝坏目标 B 后，A 的标定/骨架/旧结果完整保留', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    s.setSourceCalibration(sourceCalibration());
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'A' });
    expect(s.setTargetCalibration(targetCalibration(1.0)).ok).toBe(true);
    const before = s.solve();
    expect(before.status).not.toBe('failed');

    // 切换到含非统一缩放的 B：被正确拒绝
    const r = s.setTarget({ skeleton: nonUniformSkeleton(), name: 'B', assetKey: 'B' });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.code === 'MRR_NONUNIFORM_SCALE')).toBe(true);
    // A 的标定未被清空（归属停用发生在构建前，构建失败必须回滚）
    expect(s.summary().targetCalibrated).toBe(true);
    expect(s.summary().diagnostics.some((d) => d.code === 'MRS_TARGET_CAL_DETACHED')).toBe(false);
    // 旧目标与旧结果仍在
    expect(s.requireResult().ok).toBe(true);
    expect(s.result()!.dependencyFingerprint).toBe(before.dependencyFingerprint);
    expect(s.targetSkeletonView()!.pelvisHeightM).toBeGreaterThan(0.9); // 仍是 A
  });

  it('syncTarget 同路径：坏目标返回 invalid，A 状态完整保留', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    s.setSourceCalibration(sourceCalibration());
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'A' });
    expect(s.setTargetCalibration(targetCalibration(1.0)).ok).toBe(true);
    expect(s.solve().status).not.toBe('failed');

    const r = s.syncTarget({ skeleton: nonUniformSkeleton(), name: 'B', assetKey: 'B' });
    expect(r.state).toBe('invalid');
    expect(s.summary().targetCalibrated).toBe(true);
    expect(s.requireResult().ok).toBe(true);
  });
});

describe('retarget-session 复审跟进（b778631 复审 P3 回归）', () => {
  it('同一超界骨架反复 syncTarget：TARGET_UNITS_SUSPECT 不无界累积', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    // 米/cm 双超界的微缩骨架（骨盆 ~0.05m，×0.01 后更小）→ SUSPECT
    const tinyFit: JointPositions = {};
    for (const [k, p] of Object.entries(tposeWorldPositions())) tinyFit[k] = [p[0]! * 0.05, p[1]! * 0.05, p[2]! * 0.05];
    s.setTarget({ fitPositions: tinyFit, name: 'tiny' });
    for (let i = 0; i < 4; i++) {
      const scaled: JointPositions = {};
      for (const [k, p] of Object.entries(tinyFit)) scaled[k] = [p[0]! + i * 1e-6, p[1]!, p[2]!];
      s.syncTarget({ fitPositions: scaled, name: 'tiny' });
    }
    const count = s.summary().diagnostics.filter((d) => d.code === 'MRS_TARGET_UNITS_SUSPECT').length;
    expect(count).toBe(1);
  });
});

describe('retarget-session PR#1 bot 评审修复回归', () => {
  it('#2 标定单位声明纠正误推断：事务性重采样后接受（旧实现 CAL_UNIT_MISMATCH 拒绝）', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk'); // 推断 unitScale=0.01，hips≈1.0
    // 声明“真实单位是 0.02”（hips 实为 2.0）+ 与之一致的 pelvisHeightM/标记
    const cal = sourceCalibration();
    cal.pelvisHeightM = 2.0; // 声明与 0.02 单位一致（hips 2.0）
    cal.unitScale = 0.02;
    for (const id of Object.keys(cal.markers)) {
      cal.markers[id]!.offset = [cal.markers[id]!.offset[0]!, -0.06, cal.markers[id]!.offset[2]!];
    }
    cal.supportPlane = { origin: [0, 0, 0], normal: [0, 1, 0], source: 'declared', confidence: 1 };
    const r = s.setSourceCalibration(cal);
    expect(r.ok).toBe(true); // 重采样到 0.02 后几何一致（droop 2.0 = h 2.0）
    expect(s.summary().sourceCalibrated).toBe(true);
    expect(s.summary().diagnostics.some((d) => d.code === 'MRS_CAL_UNIT_MISMATCH')).toBe(false);
    // 重采样生效：Hips 世界高度翻倍
    expect(s.sourceFramePositions(0)!.Hips![1]).toBeCloseTo(2.0, 6);
  });

  it('#2 附属：声明重采样后几何仍不匹配 → 连重采样一起回滚', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    const cal = sourceCalibration();
    cal.pelvisHeightM = 5.0; // 与重采样后几何（hips 2.0）严重不符
    cal.unitScale = 0.02;
    const r = s.setSourceCalibration(cal);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.code === 'MRS_CAL_PELVIS_MISMATCH')).toBe(true);
    // 源回到推断采样（hips 1.0），不残留 0.02 重采样
    expect(s.sourceFramePositions(0)!.Hips![1]).toBeCloseTo(1.0, 6);
    expect(s.summary().sourceCalibrated).toBe(false);
  });

  it('#3 基准用有效采样轴向：sourceRestDirections 轴覆盖与检测轴的结果差一个换基旋转', () => {
    const text = buildBvhText({ up: 'Z' }); // 解析器检测为 Z-up
    const bvh = parseBvh(text);
    const det = sourceRestDirections(bvh); // 检测轴（z → 规范 Y-up）
    const forced = sourceRestDirections(bvh, 1); // 声明按 Y-up 解释原始偏移
    const sp = det['Spine']!;
    const spY = forced['Spine']!;
    // Z 内容按 Y 解释：规范系里的 +Y 骨向在 Y 解释下落在 +Z；rotX(-90) 应把它们对齐
    const h = (-90 * Math.PI / 180) / 2;
    const q = [Math.sin(h), 0, 0, Math.cos(h)] as [number, number, number, number];
    const w = q[3], x = q[0];
    // rotX(-90) 作用在 spY 上
    const rx = (v: readonly number[]): [number, number, number] => {
      const tx = 2 * (0 * v[2]! - 0 * v[1]!);
      const ty = 2 * (0 * v[0]! - x * v[2]!);
      const tz = 2 * (x * v[1]! - 0 * v[0]!);
      return [
        v[0]! + w * tx + (0 * tz - 0 * ty),
        v[1]! + w * ty + (0 * tx - x * tz),
        v[2]! + w * tz + (x * ty - 0 * tx),
      ];
    };
    const rotated = rx(spY);
    for (const k of [0, 1, 2] as const) {
      expect(rotated[k]).toBeCloseTo(sp[k]!, 6);
    }
  });

  it('#4 成对载入失败回滚源：目标构建失败后旧结果仍新鲜可消费', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    s.setSourceCalibration(sourceCalibration());
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'A' });
    expect(s.solve().status).not.toBe('failed');
    expect(s.isStale()).toBe(false);
    // 模拟 main 的成对载入：先快照 → 新源提交 → 坏目标被拒 → 回滚源
    const snap = s.snapshotSourceState();
    expect(s.loadSourceBvh(buildBvhText({ frames: 4, armDeg: 30 }), 'newclip').ok).toBe(true);
    expect(s.isStale()).toBe(true); // 源已提交 → 旧结果待更新
    const sk = skeletonFromPositions(tposeWorldPositions());
    sk.locals[HUMANIK_ORDER.indexOf('LeftFoot')]!.s = [1, 1, 2];
    expect(s.setTarget({ skeleton: sk, name: 'B', assetKey: 'B' }).ok).toBe(false);
    s.rollbackSourceTo(snap);
    // 回滚后：源回到旧 clip、结果恢复新鲜（非 stale）——catch 语义“保留上一份结果”成立
    expect(s.sourceInfo()!.clipName).toBe('walk');
    expect(s.isStale()).toBe(false);
    expect(s.requireResult().ok).toBe(true);
  });
});

describe('retarget-session Copilot 迟到评审修复回归（PR#1 合并后跟进）', () => {
  it('法向归一：[0,2,0] 的源支撑面不再被环境校验拒绝', () => {
    const s = new RetargetSession(memStore().store);
    s.loadSourceBvh(walkBvh(), 'walk');
    const cal = sourceCalibration();
    cal.supportPlane = { origin: [0, 0, 0], normal: [0, 2, 0], source: 'declared', confidence: 1 };
    expect(s.setSourceCalibration(cal).ok).toBe(true); // 校验层只警告
    s.setTarget({ fitPositions: tposeWorldPositions(), name: 'rig' });
    const out = s.solve();
    expect(out.status).not.toBe('failed'); // 旧实现：未归一法向进 env → ENVIRONMENT_PLANE_UNSUPPORTED 拒绝
    expect(out.diagnostics.some((d) => d.code === 'MRC_ENVIRONMENT_PLANE_UNSUPPORTED')).toBe(false);
  });

  it('锚点中位数先于映射：非 identity 旋转映射下与数学正确值一致', async () => {
    const { contactAnchor } = await import('../../src/services/binding/motion-retarget/space-targets');
    type SM = Parameters<typeof contactAnchor>[3];
    // 45° 绕 Z（**非轴对齐**——轴对齐旋转是符号置换，坐标中位数可交换，拦不住回退）
    const c = Math.SQRT1_2;
    const map = {
      mode: 'preserve-world', sRoot: 1, C: [0, 0, Math.SQRT1_2, Math.SQRT1_2] as [number, number, number, number],
      oSrc: [0, 0, 0], oTgt: [0, 0, 0],
      mapBodyRelative: (p: readonly number[]) => [p[0]!, p[1]!, p[2]!],
      mapWorldAnchor: (p: readonly number[]) => {
        const [x, y, z] = [p[0]!, p[1]!, p[2]!];
        return [c * (x - y), c * (x + y), z];
      },
    } as unknown as SM;
    // 样本刻意挑选：源中位数 (2.5,3.5) 映射后 x=c(2.5-3.5)=-√2/2；
    // 先映射再取中位数 = median({c(1-9), 0, 0, 0}) = 0 ≠ -√2/2（y 被平面投影消去，
    // 判别落在 x 上——旧实现此断言必挂）
    const traj = new Float64Array([
      1, 9, 0,
      2, 2, 0,
      3, 3, 0,
      4, 4, 0,
    ]);
    const plane = { origin: [0, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number] };
    const got = contactAnchor(traj, 0, 3, map, plane);
    expect(got[0]).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(got[1]).toBeCloseTo(0, 9);
    expect(got[2]).toBeCloseTo(0, 9);
  });
});
