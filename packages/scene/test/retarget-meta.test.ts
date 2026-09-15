/**
 * retarget-meta.test.ts —— 重定向持久化契约测试（MR-01）。
 *
 * 守的是 docs/16 §5 的数据合同：指纹确定性/敏感性、标定与配方校验、
 * 版本迁移链（未来拒绝、当前往返）。纯数据，不碰文件系统。
 */
import { describe, it, expect } from 'vitest';
import {
  RETARGET_META_SCHEMA_VERSION,
  RETARGET_ALGORITHM_VERSION,
  canonicalJson,
  retargetFingerprint,
  calibrationFingerprint,
  createDefaultRecipe,
  defaultContactDetection,
  defaultRetargetTolerances,
  validateRetargetCalibration,
  validateRetargetRecipe,
  validateRetargetAssetBlock,
  migrateRetargetRecipe,
  type RetargetCalibration,
  type RetargetRecipe,
} from '../src/retarget-meta';
import type { MetaDiagnostic } from '../src/asset-meta';

function codes(d: MetaDiagnostic[]): string[] {
  return d.filter((x) => x.severity === 'error').map((x) => x.code);
}

function goodCalibration(side: 'source' | 'target' = 'target'): RetargetCalibration {
  return {
    schemaVersion: RETARGET_META_SCHEMA_VERSION,
    side,
    pelvisHeightM: 1.0,
    supportPlane: { origin: [0, 0, 0], normal: [0, 1, 0], source: 'declared', confidence: 1 },
    unitScale: 1,
    upAxis: 'y',
    markers: {
      'LeftFoot.heel': { bone: 'LeftFoot', offset: [0, -0.03, -0.05], origin: 'derived' },
      'LeftFoot.ball': { bone: 'LeftFoot', offset: [0, -0.03, 0.1], origin: 'derived' },
    },
    rotationBaseline: 'direction',
  };
}

function goodRecipe(): RetargetRecipe {
  const r = createDefaultRecipe(
    { guid: 'as_src00001', path: 'assets/mocap/walk.bvh', contentHash: 'sha256:aa' },
    { guid: 'as_tgt00001', path: 'assets/characters/models/E-04/rigged/x.glb', contentHash: 'sha256:bb' },
  );
  return {
    ...r,
    sourceCalibrationFingerprint: calibrationFingerprint(goodCalibration('source')),
    targetCalibrationFingerprint: calibrationFingerprint(goodCalibration('target')),
  };
}

// ───────────────────────── 指纹 ─────────────────────────

describe('retargetFingerprint / canonicalJson', () => {
  it('确定性：同值同指纹（跨调用稳定，不掺随机/时间）', () => {
    expect(retargetFingerprint(goodCalibration())).toBe(retargetFingerprint(goodCalibration()));
  });

  it('键序不敏感：手工重排 sidecar 键不制造假失效', () => {
    const a = { x: 1, y: { b: 2, a: 3 } };
    const b = { y: { a: 3, b: 2 }, x: 1 };
    expect(canonicalJson(a).length > 0).toBe(true);
    expect(retargetFingerprint(a)).toBe(retargetFingerprint(b));
  });

  it('值敏感：任何一个语义字段变化都改变指纹', () => {
    const base = goodCalibration();
    const variants: RetargetCalibration[] = [
      { ...base, pelvisHeightM: 1.01 },
      { ...base, rotationBaseline: 'world-rest' },
      { ...base, markers: { ...base.markers, 'LeftFoot.heel': { bone: 'LeftFoot', offset: [0, -0.03, -0.06], origin: 'derived' } } },
    ];
    const fp = retargetFingerprint(base);
    for (const v of variants) expect(retargetFingerprint(v)).not.toBe(fp);
  });

  it('标定指纹忽略 schemaVersion（升版不假失效），但语义字段全参与', () => {
    const a = goodCalibration();
    const b = { ...a, schemaVersion: a.schemaVersion + 1 };
    expect(calibrationFingerprint(a)).toBe(calibrationFingerprint(b));
    expect(calibrationFingerprint(a)).not.toBe(calibrationFingerprint({ ...a, side: 'source' }));
  });
});

// ───────────────────────── 标定校验 ─────────────────────────

describe('validateRetargetCalibration', () => {
  it('合法标定 → 零 error', () => {
    expect(codes(validateRetargetCalibration(goodCalibration()))).toEqual([]);
  });

  it('骨盆高 ≤ 0 / 零法向 / 空 marker 骨名 → 各自 E_RTCAL_*', () => {
    expect(codes(validateRetargetCalibration({ ...goodCalibration(), pelvisHeightM: 0 }))).toContain('E_RTCAL_PELVIS');
    expect(
      codes(
        validateRetargetCalibration({
          ...goodCalibration(),
          supportPlane: { origin: [0, 0, 0], normal: [0, 0, 0], source: 'declared', confidence: 1 },
        }),
      ),
    ).toContain('E_RTCAL_PLANE_NORMAL');
    expect(
      codes(
        validateRetargetCalibration({
          ...goodCalibration(),
          markers: { bad: { bone: '', offset: [0, 0, 0], origin: 'derived' } },
        }),
      ),
    ).toContain('E_RTCAL_MARKER_BONE');
  });

  it('非单位法向 → 警告而非错误（可加载，加载时归一化）', () => {
    const d = validateRetargetCalibration({
      ...goodCalibration(),
      supportPlane: { origin: [0, 0, 0], normal: [0, 2, 0], source: 'declared', confidence: 1 },
    });
    expect(codes(d)).toEqual([]);
    expect(d.some((x) => x.code === 'W_RTCAL_PLANE_UNNORMALIZED')).toBe(true);
  });

  it('rotationBaseline 非法 → E_RTCAL_BASELINE（分层规则不允许可选值）', () => {
    expect(codes(validateRetargetCalibration({ ...goodCalibration(), rotationBaseline: 'auto' as never }))).toContain(
      'E_RTCAL_BASELINE',
    );
  });
});

// ───────────────────────── 配方校验与迁移 ─────────────────────────

describe('validateRetargetRecipe', () => {
  it('合法配方（含标定指纹）→ 零 error', () => {
    expect(codes(validateRetargetRecipe(goodRecipe()))).toEqual([]);
  });

  it('未来版本 → E_RTR_VERSION_FUTURE（拒绝而非静默降级）', () => {
    const r = { ...goodRecipe(), schemaVersion: RETARGET_META_SCHEMA_VERSION + 1 };
    expect(codes(validateRetargetRecipe(r))).toContain('E_RTR_VERSION_FUTURE');
  });

  it('speedExit ≤ speedEnter → E_RTR_DETECT_HYSTERESIS（进出必须滞回）', () => {
    const r = goodRecipe();
    r.contactDetection = { ...r.contactDetection, speedExit: r.contactDetection.speedEnter };
    expect(codes(validateRetargetRecipe(r))).toContain('E_RTR_DETECT_HYSTERESIS');
  });

  it('标注 endS ≤ startS → E_RTR_ANNOT_SPAN', () => {
    const r = goodRecipe();
    r.annotations = [{ marker: 'LeftFoot.ball', startS: 2, endS: 1, mode: 'slide' }];
    expect(codes(validateRetargetRecipe(r))).toContain('E_RTR_ANNOT_SPAN');
  });

  it('算法版本过期 → 警告（结果需重算，但不阻塞保存）', () => {
    const r = { ...goodRecipe(), algorithmVersion: 'mr-foot-0' };
    const d = validateRetargetRecipe(r);
    expect(codes(d)).toEqual([]);
    expect(d.some((x) => x.code === 'W_RTR_ALGO_STALE')).toBe(true);
  });

  it('默认值合理：容差 = A08 数字（0.002/0.005/0.001），检测阈值形成滞回', () => {
    const tol = defaultRetargetTolerances();
    expect(tol.anchorH).toBe(0.002);
    expect(tol.slideH).toBe(0.005);
    expect(tol.penetrationH).toBe(0.001);
    const det = defaultContactDetection();
    expect(det.speedExit).toBeGreaterThan(det.speedEnter);
    expect(det.minDurationS).toBeGreaterThan(0);
    expect(RETARGET_ALGORITHM_VERSION).toBe('mr-foot-1');
  });
});

describe('migrateRetargetRecipe', () => {
  it('当前版本 v1 原样通过 + 零诊断', () => {
    const r = goodRecipe();
    const { value, diagnostics } = migrateRetargetRecipe(r);
    expect(value).not.toBeNull();
    expect(codes(diagnostics)).toEqual([]);
    expect(value).toEqual(r);
  });

  it('JSON 往返（保存/重载）不丢字段、指纹不变', () => {
    const r = goodRecipe();
    const round = JSON.parse(JSON.stringify(r)) as RetargetRecipe;
    const { value, diagnostics } = migrateRetargetRecipe(round);
    expect(codes(diagnostics)).toEqual([]);
    expect(retargetFingerprint(value)).toBe(retargetFingerprint(r));
  });

  it('未来版本 → value=null + E_RTR_VERSION_FUTURE', () => {
    const { value, diagnostics } = migrateRetargetRecipe({ ...goodRecipe(), schemaVersion: 99 });
    expect(value).toBeNull();
    expect(codes(diagnostics)).toContain('E_RTR_VERSION_FUTURE');
  });

  it('缺 schemaVersion → value=null + E_RTR_VERSION', () => {
    const r = goodRecipe() as Partial<RetargetRecipe>;
    delete r.schemaVersion;
    const { value, diagnostics } = migrateRetargetRecipe(r);
    expect(value).toBeNull();
    expect(codes(diagnostics)).toContain('E_RTR_VERSION');
  });
});

// ───────────────────────── AssetMeta 挂载块 ─────────────────────────

describe('validateRetargetAssetBlock', () => {
  it('空块（双 null）合法；坏标定透传诊断', () => {
    expect(codes(validateRetargetAssetBlock({ calibration: null, recipe: null }))).toEqual([]);
    const d = validateRetargetAssetBlock({
      calibration: { ...goodCalibration(), pelvisHeightM: -1 },
      recipe: null,
    });
    expect(codes(d)).toContain('E_RTCAL_PELVIS');
    expect(d[0]!.path.startsWith('/retarget/')).toBe(true);
  });
});
