/**
 * 资产 sidecar 元数据测试（ADR-009：测试与被测代码同位）。
 *
 * 只测数据契约，不碰文件系统与 GPU —— 与 document.test.ts 同策略。
 */
import { describe, it, expect } from 'vitest';
import {
  META_SCHEMA_VERSION,
  newAssetGuid,
  createDefaultAssetMeta,
  defaultGlbImporter,
  metaPathFor,
  validateAssetMeta,
  isAssetMetaValid,
  defaultRigSettings,
  defaultRigExportSettings,
  type AssetMeta,
  type MetaDiagnostic,
  type MeshNodeBindingEntry,
  type RigSettings,
} from '../src/asset-meta';

function codes(d: MetaDiagnostic[]): string[] {
  return d.filter((x) => x.severity === 'error').map((x) => x.code);
}
function warns(d: MetaDiagnostic[]): string[] {
  return d.filter((x) => x.severity === 'warning').map((x) => x.code);
}

describe('createDefaultAssetMeta', () => {
  it('默认元数据通过校验（合法基线）', () => {
    const m = createDefaultAssetMeta(newAssetGuid(), 'gltf');
    expect(codes(validateAssetMeta(m))).toEqual([]);
    expect(isAssetMetaValid(m)).toBe(true);
  });

  it('guid 形态为 as_xxxxxxxx', () => {
    expect(newAssetGuid()).toMatch(/^as_[0-9a-z]+$/);
    expect(newAssetGuid()).not.toBe(newAssetGuid());
  });

  it('默认导入设置的取值合理（焊接 1e-4、拆子网格、上限 8）', () => {
    const imp = defaultGlbImporter();
    expect(imp.weldTolerance).toBe(1e-4);
    expect(imp.splitSubMeshes).toBe(true);
    expect(imp.maxSubMeshes).toBe(8);
    // 默认不做有损变换：归一化/AO/翻转都必须显式开启
    expect(imp.normalizeHeightM).toBeNull();
    expect(imp.aoBakeFloor).toBeNull();
    expect(imp.upAxisFlip).toBe(false);
  });
});

describe('metaPathFor', () => {
  it('保留源扩展名（a.glb 与 a.obj 不撞车）', () => {
    expect(metaPathFor('assets/x/E04.glb')).toBe('assets/x/E04.glb.meta.json');
    expect(metaPathFor('assets/x/E04.obj')).toBe('assets/x/E04.obj.meta.json');
    expect(metaPathFor('a/E04.glb')).not.toBe(metaPathFor('a/E04.obj'));
  });
});

describe('validateAssetMeta · 根节点', () => {
  const base = (): AssetMeta => createDefaultAssetMeta(newAssetGuid(), 'gltf');

  it('非对象 → E_META_NOT_OBJECT', () => {
    expect(codes(validateAssetMeta(null))).toContain('E_META_NOT_OBJECT');
  });

  it('未来版本 → E_META_VERSION_FUTURE（拒绝而非静默降级）', () => {
    const m = { ...base(), schemaVersion: META_SCHEMA_VERSION + 1 };
    expect(codes(validateAssetMeta(m))).toContain('E_META_VERSION_FUTURE');
  });

  it('kind 非法 → E_META_KIND', () => {
    const m = { ...base(), kind: 'wav' };
    expect(codes(validateAssetMeta(m))).toContain('E_META_KIND');
  });

  it('guid 格式异常 → W_META_GUID_FORM（可加载，仅提示）', () => {
    const m = { ...base(), guid: 'some-random-id' };
    const d = validateAssetMeta(m);
    expect(codes(d)).toEqual([]);
    expect(warns(d)).toContain('W_META_GUID_FORM');
  });
});

describe('validateAssetMeta · 绑定', () => {
  // 参数放宽为 unknown：部分用例故意传非法数据（如 prims 不是数组）来验证校验器
  const withBinding = (b: unknown): AssetMeta => ({
    ...createDefaultAssetMeta(newAssetGuid(), 'gltf'),
    bindings: [b as MeshNodeBindingEntry],
  });

  it('nodeId 重复 → E_META_NODE_DUP（否则换模型继承会认错节点）', () => {
    const one = { nodeId: 'Body', nodePath: ['Root', 'Body'], prims: [{ primitiveKey: 'k', primitiveIndex: 0, material: null, visible: true }] };
    const m = createDefaultAssetMeta(newAssetGuid(), 'gltf');
    m.bindings = [one, { ...one }];
    expect(codes(validateAssetMeta(m))).toContain('E_META_NODE_DUP');
  });

  it('nodePath 为空 → W_META_NODE_PATH_EMPTY（还能加载，但换模型时无法路径匹配）', () => {
    const m = withBinding({ nodeId: 'Body', nodePath: [], prims: [] });
    const d = validateAssetMeta(m);
    expect(codes(d)).toEqual([]);
    expect(warns(d)).toContain('W_META_NODE_PATH_EMPTY');
  });

  it('prims 不是数组 → E_META_PRIMS', () => {
    const m = withBinding({ nodeId: 'Body', nodePath: ['Root'], prims: 'nope' });
    expect(codes(validateAssetMeta(m))).toContain('E_META_PRIMS');
  });
});

describe('validateAssetMeta · 导入设置', () => {
  const withImp = (patch: Record<string, unknown>): AssetMeta => ({
    ...createDefaultAssetMeta(newAssetGuid(), 'gltf'),
    importer: { ...defaultGlbImporter(), ...patch },
  });

  it('normalizeHeightM <= 0 → E_META_HEIGHT（0 米高会把模型压成一张纸）', () => {
    expect(codes(validateAssetMeta(withImp({ normalizeHeightM: 0 })))).toContain('E_META_HEIGHT');
    expect(codes(validateAssetMeta(withImp({ normalizeHeightM: -1 })))).toContain('E_META_HEIGHT');
  });

  it('normalizeHeightM = null 合法（不归一化）', () => {
    expect(codes(validateAssetMeta(withImp({ normalizeHeightM: null })))).toEqual([]);
  });

  it('E-04 的 2.05 m 归一化通过校验（真实数据）', () => {
    expect(codes(validateAssetMeta(withImp({ normalizeHeightM: 2.05 })))).toEqual([]);
  });

  it('aoBakeFloor 越界 → E_META_AO', () => {
    expect(codes(validateAssetMeta(withImp({ aoBakeFloor: 1.5 })))).toContain('E_META_AO');
    expect(codes(validateAssetMeta(withImp({ aoBakeFloor: -0.2 })))).toContain('E_META_AO');
  });

  it('maxSubMeshes < 1 → E_META_MAXSUB（材质槽预算不能为 0）', () => {
    expect(codes(validateAssetMeta(withImp({ maxSubMeshes: 0 })))).toContain('E_META_MAXSUB');
  });
});

describe('validateAssetMeta · 骨骼', () => {
  /**
   * 造一份「已导出」的干净绑定：会话数据齐全 + exported=true。
   * 这是唯一不该产生任何诊断的状态。
   */
  const cleanRig = (): RigSettings => ({
    ...defaultRigSettings(),
    template: 'humanik',
    session: {
      positions: { Hips: [0, 0.95, 0], Spine: [0, 1.3, 0] },
      bindPose: { Hips: [0, 0.95, 0], Spine: [0, 1.3, 0] },
      skinCylinders: {
        LeftArm: { bone: 'LeftArm', radii: { top: 0.05, medium: 0.06, bottom: 0.07 }, enabled: true },
      },
    },
    tposeLocalRotations: { Arm_L: [0, 0, 0.38, 0.92] },
    exported: true,
  });

  /** 在干净绑定上打补丁。patch 允许部分字段，便于造非法输入 */
  const withRig = (patch: Record<string, unknown>): AssetMeta => {
    const m = createDefaultAssetMeta(newAssetGuid(), 'gltf');
    m.rig = { ...cleanRig(), ...patch } as RigSettings;
    return m;
  };

  it('干净状态（会话齐全 + 已导出）→ 零诊断', () => {
    expect(validateAssetMeta(withRig({}))).toEqual([]);
  });

  it('未导出但有会话 → W_META_RIG_NOT_EXPORTED（摆位与 Wrapper 半径刷新即丢）', () => {
    const d = validateAssetMeta(withRig({ exported: false }));
    expect(codes(d)).toEqual([]);
    expect(warns(d)).toContain('W_META_RIG_NOT_EXPORTED');
  });

  it('已导出 + 无会话 → 零诊断（结果在 GLB 里，不需要草稿）', () => {
    expect(validateAssetMeta(withRig({ session: null }))).toEqual([]);
  });

  it('有模板 + 无会话 + 未导出 → W_META_RIG_EMPTY_SESSION', () => {
    const d = validateAssetMeta(withRig({ session: null, exported: false }));
    expect(warns(d)).toContain('W_META_RIG_EMPTY_SESSION');
  });

  it('有骨骼坐标但无模板 → W_META_RIG_NO_TEMPLATE', () => {
    const d = validateAssetMeta(withRig({ template: null }));
    expect(warns(d)).toContain('W_META_RIG_NO_TEMPLATE');
  });

  it('maxInfluences 越界 → E_META_RIG_MAXINF（引擎侧 4 骨/顶点）', () => {
    expect(codes(validateAssetMeta(withRig({ export: { ...defaultRigExportSettings(), maxInfluences: 0 } }))))
      .toContain('E_META_RIG_MAXINF');
    expect(codes(validateAssetMeta(withRig({ export: { ...defaultRigExportSettings(), maxInfluences: 9 } }))))
      .toContain('E_META_RIG_MAXINF');
    // 4 是合法值
    expect(codes(validateAssetMeta(withRig({})))).toEqual([]);
  });

  it('falloff / eps / smoothLambda / smoothIters 越界 → 对应 E_META_RIG_*', () => {
    const e = defaultRigExportSettings();
    expect(codes(validateAssetMeta(withRig({ export: { ...e, falloff: 0 } })))).toContain('E_META_RIG_FALLOFF');
    expect(codes(validateAssetMeta(withRig({ export: { ...e, eps: 1.5 } })))).toContain('E_META_RIG_EPS');
    expect(codes(validateAssetMeta(withRig({ export: { ...e, smoothLambda: 2 } })))).toContain('E_META_RIG_LAMBDA');
    expect(codes(validateAssetMeta(withRig({ export: { ...e, smoothIters: 64 } })))).toContain('E_META_RIG_ITERS');
  });

  it('Skin Wrapper 半径 ≤ 0 → E_META_RIG_RADIUS（算权重会出 NaN）', () => {
    const s = cleanRig().session!;
    const bad = {
      ...s,
      skinCylinders: { LeftArm: { bone: 'LeftArm', radii: { top: 0, medium: 0.06, bottom: 0.07 }, enabled: true } },
    };
    const d = validateAssetMeta(withRig({ session: bad }));
    expect(codes(d)).toContain('E_META_RIG_RADIUS');
    // 报错路径要指到具体骨与段，便于定位
    expect(d.some((x) => x.code === 'E_META_RIG_RADIUS' && x.path.includes('skinCylinders/LeftArm/radii/top'))).toBe(true);
  });

  it('开镜像权重但无 Wrapper 数据 → W_META_RIG_MIRROR_NOOP（镜像只作用于 Wrapper 模式）', () => {
    const s = { ...cleanRig().session!, skinCylinders: null };
    const d = validateAssetMeta(withRig({ session: s, export: { ...defaultRigExportSettings(), mirrorWeights: true } }));
    expect(warns(d)).toContain('W_META_RIG_MIRROR_NOOP');
  });

  it('默认 RigSettings 不触发「未导出」告警（session 为 null，压根没做过会话）', () => {
    expect(validateAssetMeta(withRig({ ...defaultRigSettings() }))).toEqual([]);
  });
});

describe('序列化往返', () => {
  it('带完整绑定与骨骼的元数据往返后等价', () => {
    const m = createDefaultAssetMeta(newAssetGuid(), 'gltf');
    m.importer = { ...defaultGlbImporter(), normalizeHeightM: 2.05, upAxisFlip: true, aoBakeFloor: 0.55 };
    m.bindings = [
      {
        nodeId: 'Body',
        nodePath: ['Armature', 'Body'],
        prims: [
          { primitiveKey: 'Body_MAT', primitiveIndex: 0, material: { type: 'shared', id: 's3' }, visible: true },
          { primitiveKey: 'Shield_MAT', primitiveIndex: 1, material: { type: 'override', base: { type: 'shared', id: 's1' }, patch: { emissiveColor: '#ff3300' } }, visible: true },
        ],
      },
    ];
    m.rig = {
      ...defaultRigSettings(),
      template: 'humanik',
      session: {
        positions: { Hips: [0, 0.95, 0], Spine: [0, 1.3, 0] },
        bindPose: { Hips: [0, 0.95, 0], Spine: [0, 1.3, 0] },
        skinCylinders: {
          LeftArm: { bone: 'LeftArm', radii: { top: 0.05, medium: 0.06, bottom: 0.07 }, enabled: true },
        },
      },
      tposeLocalRotations: { Arm_L: [0, 0, 0.38, 0.92] },
      exported: true,
    };
    m.userData = { batch: 'P2', note: '盾牌可拆' };
    m.sourceHash = 'sha256:deadbeef';

    const round = JSON.parse(JSON.stringify(m)) as AssetMeta;
    expect(round).toEqual(m);
    expect(isAssetMetaValid(round)).toBe(true);
  });
});
