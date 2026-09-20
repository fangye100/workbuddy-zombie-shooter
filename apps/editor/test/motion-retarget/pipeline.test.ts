/**
 * pipeline.test.ts —— 管线编排测试（MR-05）。
 *
 * 端到端：BVH fixture → 源采样 → 模板目标 → 方向基准 → retargetMotion。
 * 守：输入不可变、取消、标定指纹失效、正常路径产出世界解与指标。
 */
import { describe, it, expect } from 'vitest';
import { parseBvh } from '../../src/services/binding/bvh-parser';
import { buildSourceMotion, sourceRestDirections } from '../../src/services/binding/motion-retarget/source-motion';
import { buildTargetRig, computeDirectionBaseline, computeWorldRestBaseline } from '../../src/services/binding/motion-retarget/rig-calibration';
import { retargetMotion } from '../../src/services/binding/motion-retarget/pipeline';
import { createDefaultRecipe, RETARGET_META_SCHEMA_VERSION, RETARGET_ALGORITHM_VERSION, type RetargetCalibration } from '@aether/scene';
import { buildBvhText } from './fixture';
import { computeDependencyFingerprint, type RetargetEnvironment } from '../../src/services/binding/motion-retarget/contracts';

function makeInput(rootPosWalk = true, trustedWorld = false) {
  const bvhText = buildBvhText({
    rootPos: rootPosWalk ? (f) => [f * 10, 100, 0] : () => [0, 100, 0],
  });
  const bvh = parseBvh(bvhText);
  const sm = buildSourceMotion(bvh, trustedWorld ? { rootMotion: 'world-trajectory' } : {});
  const { rig } = buildTargetRig({});
  const baseline = computeDirectionBaseline({ srcDirections: sourceRestDirections(bvh) }, rig);
  const recipe = createDefaultRecipe(
    { guid: 'as_src00001', path: 'assets/x/walk.bvh', contentHash: 'sha256:a' },
    { guid: 'as_tgt00001', path: 'assets/x/tgt.glb', contentHash: 'sha256:b' },
  );
  const environment: RetargetEnvironment = {
    sourcePlane: { origin: [0, 0, 0], normal: [0, 1, 0] },
    targetPlane: { origin: [0, 0, 0], normal: [0, 1, 0] },
    origin: 'recipe-default',
    sceneNodeId: null,
  };
  return { sm, rig, baseline, recipe, environment };
}

function footCalibration(): RetargetCalibration {
  return {
    schemaVersion: RETARGET_META_SCHEMA_VERSION, side: 'source', pelvisHeightM: 1,
    supportPlane: { origin: [0, 0, 0], normal: [0, 1, 0], source: 'declared', confidence: 1 },
    unitScale: 0.01, upAxis: 'y', rotationBaseline: 'direction',
    markers: {
      'LeftFoot.ball': { bone: 'LeftFoot', offset: [0, -0.03, 0.09], origin: 'manual' },
      'RightFoot.ball': { bone: 'RightFoot', offset: [0, -0.03, 0.09], origin: 'manual' },
    },
  };
}

describe('executed contact promises', () => {
  it.each([0, 0.000001])('honors an explicitly zero plane confidence without inventing a positive threshold (%s)', (confidence) => {
    const { sm, rig, baseline, recipe, environment } = makeInput(true, true);
    const cal = footCalibration();
    const out = retargetMotion({ source: sm, targetRig: rig, baseline, environment,
      recipe: { ...recipe, annotations: [{ marker: 'LeftFoot.ball', startS: 0, endS: 0.1, mode: 'support' }] },
      sourceCalibration: { ...cal, supportPlane: { ...cal.supportPlane, source: 'fitted', confidence } },
    });
    if (confidence === 0) {
      expect(out.status).toBe('partial');
      expect(out.coverage).not.toContain('world-lock');
      expect(out.metrics!.iterations).toBe(0);
      expect(out.diagnostics.map((d) => d.code)).toContain('MRC_SOURCE_PLANE_UNTRUSTED');
      expect(out.clip!.frames[0]!.rootPos).toEqual([0, 1, 0]);
    } else {
      expect(out.coverage).toContain('world-lock');
      expect(out.diagnostics.map((d) => d.code)).not.toContain('MRC_SOURCE_PLANE_UNTRUSTED');
    }
  });
  it('rejects calibration units that do not match already sampled source data', () => {
    const { sm, rig, baseline, recipe, environment } = makeInput(false, true);
    const out = retargetMotion({ source: sm, targetRig: rig, baseline, recipe, environment,
      sourceCalibration: { ...footCalibration(), unitScale: 1 },
    });
    expect(out.status).toBe('failed');
    expect(out.diagnostics.map((d) => d.code)).toContain('MRC_SOURCE_CALIBRATION_MISMATCH');
  });

  it('uses the executing algorithm version in the cache identity even for an old saved recipe', () => {
    const { sm, rig, baseline, environment, recipe: current } = makeInput(false, true);
    const recipe = { ...current, algorithmVersion: 'mr-foot-1' };
    const sourceCalibration = footCalibration();
    const out = retargetMotion({ source: sm, targetRig: rig, baseline, recipe, environment, sourceCalibration });
    const depInput = {
      sourceFingerprint: sm.fingerprint, targetRig: rig, environment,
      recipeSemantic: { recipe, sourceCalibration, baseline: { mode: baseline.mode, pre: baseline.pre, post: baseline.post } },
    };
    expect(out.dependencyFingerprint).toBe(computeDependencyFingerprint({ ...depInput, algorithmVersion: RETARGET_ALGORITHM_VERSION }));
    expect(out.dependencyFingerprint).not.toBe(computeDependencyFingerprint({ ...depInput, algorithmVersion: 'mr-foot-1' }));
  });
  it('does not create world constraints from a phase-only trajectory', () => {
    const { sm, rig, baseline, recipe, environment } = makeInput(false);
    const out = retargetMotion({ source: sm, targetRig: rig, baseline, environment,
      recipe: { ...recipe, annotations: [{ marker: 'LeftFoot.ball', startS: 0, endS: 0.1, mode: 'support' }] },
      sourceCalibration: footCalibration(),
    });
    expect(out.status).toBe('partial');
    expect(out.coverage).not.toContain('world-lock');
    expect(out.coverage).toContain('phase-only');
    expect(out.metrics!.iterations).toBe(0);
    expect(out.diagnostics.map((d) => d.code)).toContain('MRC_ANNOT_UNHONORED');
  });

  it.each(['slide', 'roll'] as const)('does not report an unsupported %s request complete when geometry happens to pass', (mode) => {
    const { sm, rig, baseline, recipe, environment } = makeInput(false, true);
    const out = retargetMotion({ source: sm, targetRig: rig, baseline, environment,
      recipe: { ...recipe, annotations: [{ marker: 'LeftFoot.ball', startS: 0, endS: 0.1, mode }] },
      sourceCalibration: { ...footCalibration(), markers: { 'LeftFoot.ball': footCalibration().markers['LeftFoot.ball']! } },
    });
    expect(out.status).toBe('partial');
    expect(out.metrics!.iterations).toBe(0);
    expect(out.diagnostics.map((d) => d.code)).toContain('MRC_CONTACT_MODE_UNSUPPORTED');
    expect(out.diagnostics.map((d) => d.code)).toContain('MRC_ANNOT_UNHONORED');
    expect(out.coverage).not.toContain('world-lock');
  });

  it('does not let an honored annotation hide another interval on the same marker', () => {
    const { sm, rig, baseline, recipe, environment } = makeInput(false, true);
    const out = retargetMotion({ source: sm, targetRig: rig, baseline, environment,
      recipe: { ...recipe, annotations: [
        { marker: 'LeftFoot.ball', startS: 0, endS: 0.1, mode: 'support' },
        { marker: 'LeftFoot.ball', startS: 10, endS: 11, mode: 'support' },
      ] }, sourceCalibration: footCalibration(),
    });
    expect(out.status).toBe('partial');
    expect(out.diagnostics.filter((d) => d.code === 'MRC_ANNOT_UNHONORED')).toHaveLength(1);
    expect(out.diagnostics.map((d) => d.code)).toContain('MRC_ANNOT_TIME_UNSUPPORTED');
  });

  it('does not claim world-lock for a wholly out-of-clip declaration', () => {
    const { sm, rig, baseline, recipe, environment } = makeInput(true, true);
    const out = retargetMotion({ source: sm, targetRig: rig, baseline, environment,
      recipe: { ...recipe, annotations: [{ marker: 'LeftFoot.ball', startS: 10, endS: 11, mode: 'support' }] },
      sourceCalibration: footCalibration(),
    });
    expect(out.status).toBe('partial');
    expect(out.coverage).not.toContain('world-lock');
  });

  it('does not synthesize a zero marker trajectory when source bone samples are missing', () => {
    const { sm, rig, baseline, recipe, environment } = makeInput(false, true);
    const positions = { ...sm.worldPositions };
    delete positions.LeftFoot;
    const out = retargetMotion({ source: { ...sm, worldPositions: positions }, targetRig: rig,
      baseline, recipe, environment, sourceCalibration: footCalibration(),
    });
    expect(out.status).toBe('partial');
    expect(out.diagnostics.map((d) => d.code)).toContain('MRC_MARKER_TRAJECTORY_MISSING');
    expect(out.clip!.frames[0]!.bonePos.LeftFoot![0]).toBeGreaterThan(0.09);
  });

  it('measures the delivered correction against the original source root after the second solve', () => {
    const { sm, rig, baseline, recipe, environment } = makeInput(true, true);
    const out = retargetMotion({ source: sm, targetRig: rig, baseline, environment,
      recipe: { ...recipe, annotations: [{ marker: 'LeftFoot.ball', startS: 0, endS: 0.1, mode: 'support' }] },
      sourceCalibration: footCalibration(),
    });
    const corrections = out.clip!.frames.map((fr, f) => fr.rootPos.map((v, a) => v - sm.worldPositions.Hips![f * 3 + a]!));
    const maxCorrection = Math.max(...corrections.map((v) => Math.hypot(...v)));
    const speeds = corrections.slice(1).map((v, i) => Math.hypot(...v.map((x, a) => x - corrections[i]![a]!)) / (sm.times[i + 1]! - sm.times[i]!));
    expect(maxCorrection).toBeGreaterThan(1e-4);
    expect(out.metrics!.maxRootCorrectionM).toBeCloseTo(maxCorrection, 12);
    expect(out.metrics!.maxSwitchJumpMps).toBeCloseTo(Math.max(...speeds), 12);
  });
});

describe('retargetMotion · 正常路径', () => {
  it('T-pose 源走动采样 → 世界解产出（complete 或 partial），帧数/骨数完整', () => {
    const { sm, rig, baseline, recipe, environment } = makeInput(true);
    const out = retargetMotion({ source: sm, targetRig: rig, baseline, recipe, environment, sourceCalibration: null });
    expect(out.status).not.toBe('failed');
    expect(out.clip).not.toBeNull();
    expect(out.clip!.frames.length).toBe(sm.times.length);
    expect(Object.keys(out.clip!.frames[0]!.bonePos).length).toBe(rig.order.length);
    expect(out.dependencyFingerprint).toMatch(/^fp1_/);
    expect(out.coverage).toContain('space-mapping');
    expect(out.metrics).not.toBeNull();
    expect(out.metrics!.converged).toBe(true);
  });

  it('★ 输入不可变：跑完管线后输入的 JSON 快照不变（含冻结对象）', () => {
    const { sm, rig, baseline, recipe, environment } = makeInput(true);
    Object.freeze(recipe);
    Object.freeze(recipe.contactDetection);
    Object.freeze(environment);
    const snap = JSON.stringify({
      times: Array.from(sm.times),
      hips: Array.from(sm.worldPositions.Hips!),
      rigFp: rig.fingerprint,
      pre: baseline.pre.Hips,
    });
    retargetMotion({ source: sm, targetRig: rig, baseline, recipe, environment, sourceCalibration: null });
    expect(JSON.stringify({
      times: Array.from(sm.times),
      hips: Array.from(sm.worldPositions.Hips!),
      rigFp: rig.fingerprint,
      pre: baseline.pre.Hips,
    })).toBe(snap);
  });

  it('原地素材（in-place）→ 不承诺 world-lock：coverage 标 phase-only，仍出结果', () => {
    const { sm, rig, baseline, recipe, environment } = makeInput(false);
    const out = retargetMotion({ source: sm, targetRig: rig, baseline, recipe, environment, sourceCalibration: null });
    // 未标定源标记：coverage 明确标 contact-uncalibrated（不再与 world-lock 并存），
    // 状态因能力缺口降为 partial（几何仍自由运动交付）
    expect(out.coverage).toContain('contact-uncalibrated');
    expect(out.coverage).not.toContain('world-lock');
    expect(out.status).toBe('partial');
    expect(out.diagnostics.some((d) => d.code === 'MRC_CAPABILITY_GAP')).toBe(true);
  });
});

describe('retargetMotion · 失败路径', () => {
  it('坏源（时间轴乱序）→ failed，诊断定位', () => {
    const { sm, rig, baseline, recipe, environment } = makeInput(true);
    (sm as { times: Float64Array }).times = new Float64Array([0, 0.05, 0.03, 0.1, 0.13]);
    const out = retargetMotion({ source: sm, targetRig: rig, baseline, recipe, environment, sourceCalibration: null });
    expect(out.status).toBe('failed');
    expect(out.clip).toBeNull();
    expect(out.diagnostics.some((d) => d.code === 'MRC_TIMES_NOT_ASCENDING')).toBe(true);
  });

  it('★ 取消（AbortSignal 已中止）→ failed + MRC_CANCELLED，不产出半份 clip', () => {
    const { sm, rig, baseline, recipe, environment } = makeInput(true);
    const ctrl = new AbortController();
    ctrl.abort();
    const out = retargetMotion({
      source: sm, targetRig: rig, baseline, recipe, environment, sourceCalibration: null, signal: ctrl.signal,
    });
    expect(out.status).toBe('failed');
    expect(out.clip).toBeNull();
    expect(out.diagnostics.some((d) => d.code === 'MRC_CANCELLED')).toBe(true);
  });

  it('★ 标定指纹失配 → failed + MRC_CAL_FINGERPRINT_MISMATCH（结果失效语义）', () => {
    const { sm, rig, baseline, recipe, environment } = makeInput(true);
    const cal: RetargetCalibration = {
      schemaVersion: RETARGET_META_SCHEMA_VERSION,
      side: 'source',
      pelvisHeightM: 0.98,
      supportPlane: { origin: [0, 0, 0], normal: [0, 1, 0], source: 'declared', confidence: 1 },
      unitScale: 0.01,
      upAxis: 'y',
      markers: {},
      rotationBaseline: 'direction',
    };
    const out = retargetMotion({ source: sm, targetRig: rig, baseline, recipe, environment, sourceCalibration: cal });
    // recipe.sourceCalibrationFingerprint 为空串 → 不核对（草稿语义）；填错的指纹才触发
    expect(out.status).not.toBe('failed');
    const bad = {
      ...recipe,
      sourceCalibrationFingerprint: 'fp1_0000000000000000000000',
    };
    const out2 = retargetMotion({ source: sm, targetRig: rig, baseline, recipe: bad, environment, sourceCalibration: cal });
    expect(out2.status).toBe('failed');
    expect(out2.diagnostics.some((d) => d.code === 'MRC_CAL_FINGERPRINT_MISMATCH')).toBe(true);
  });

  it('★ 姿态基准守门：world-rest 作用于 identity 源（BVH）→ failed + MRC_BASELINE_REJECTED', () => {
    const { sm, rig, recipe, environment } = makeInput(true);
    // 构造带 error 诊断的 world-rest 基准（identity 源）
    const identityRest: Record<string, [number, number, number, number]> = {};
    for (const n of rig.order) identityRest[n] = [0, 0, 0, 1];
    const badBaseline = computeWorldRestBaseline({ srcRestWorldRotations: identityRest }, rig);
    const worldRestRecipe = { ...recipe, rotationBaseline: 'world-rest' as const };
    const out = retargetMotion({ source: sm, targetRig: rig, baseline: badBaseline, recipe: worldRestRecipe, environment, sourceCalibration: null });
    expect(out.status).toBe('failed');
    expect(out.clip).toBeNull();
    expect(out.diagnostics.some((d) => d.code === 'MRC_BASELINE_REJECTED')).toBe(true);
  });

  it('★ 基准模式三方不一致（baseline vs recipe vs rig）→ failed + MRC_BASELINE_MODE_MISMATCH', () => {
    const { sm, rig, baseline, environment } = makeInput(true);
    const mismatchRecipe = {
      ...makeInput(true).recipe,
      rotationBaseline: 'world-rest' as const,
    };
    const out = retargetMotion({ source: sm, targetRig: rig, baseline, recipe: mismatchRecipe, environment, sourceCalibration: null });
    expect(out.status).toBe('failed');
    expect(out.diagnostics.some((d) => d.code === 'MRC_BASELINE_MODE_MISMATCH')).toBe(true);
  });

  it('slide 标注段 → 不硬锁（MRP_MODE_SOFT_MVP 警告），结果仍产出不失败', () => {
    const { sm, rig, baseline, environment } = makeInput(true);
    const slideRecipe = {
      ...makeInput(true).recipe,
      annotations: [{ marker: 'LeftFoot.ball', startS: 0.0, endS: 0.1, mode: 'slide' as const }],
    };
    // 源标定提供足底标记（未标定语义直接不做接触，slide 段拿不到锚点）
    const out = retargetMotion({
      source: sm, targetRig: rig, baseline, recipe: slideRecipe, environment,
      sourceCalibration: {
        schemaVersion: RETARGET_META_SCHEMA_VERSION,
        side: 'source',
        pelvisHeightM: 1.0,
        supportPlane: { origin: [0, 0, 0], normal: [0, 1, 0], source: 'declared', confidence: 1 },
        unitScale: 0.01,
        upAxis: 'y',
        markers: { 'LeftFoot.ball': { bone: 'LeftFoot', offset: [0, -0.03, 0.09], origin: 'manual' } },
        rotationBaseline: 'direction',
      },
    });
    expect(out.status).not.toBe('failed');
    expect(out.status).toBe('partial');
    expect(out.diagnostics.some((d) => d.code === 'MRC_CONTACT_MODE_UNSUPPORTED')).toBe(true);
  });
});
