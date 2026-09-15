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
import { createDefaultRecipe, RETARGET_META_SCHEMA_VERSION, type RetargetCalibration } from '@aether/scene';
import { buildBvhText } from './fixture';
import type { RetargetEnvironment } from '../../src/services/binding/motion-retarget/contracts';

function makeInput(rootPosWalk = true) {
  const bvhText = buildBvhText({
    rootPos: rootPosWalk ? (f) => [f * 10, 100, 0] : () => [0, 100, 0],
  });
  const bvh = parseBvh(bvhText);
  const sm = buildSourceMotion(bvh);
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
    expect(out.coverage).toContain('phase-only');
    expect(out.status).not.toBe('failed');
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
        unitScale: 1,
        upAxis: 'y',
        markers: { 'LeftFoot.ball': { bone: 'LeftFoot', offset: [0, -0.03, 0.09], origin: 'manual' } },
        rotationBaseline: 'direction',
      },
    });
    expect(out.status).not.toBe('failed');
    expect(out.diagnostics.some((d) => d.code === 'MRP_MODE_SOFT_MVP')).toBe(true);
  });
});
