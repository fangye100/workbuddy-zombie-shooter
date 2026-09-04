/**
 * 项目容器测试（ADR-009：测试与被测代码同位）。
 *
 * 项目文件是所有相对路径、场景清单、层表的锚点 —— 它错了，下面三层全错。
 */
import { describe, it, expect } from 'vitest';
import {
  PROJECT_FILE_NAME,
  PROJECT_SCHEMA_VERSION,
  MAX_LAYERS,
  BUILTIN_LAYERS,
  createEmptyProject,
  defaultRenderSettings,
  validateProject,
  isProjectValid,
  type AetherProject,
  type ProjectDiagnostic,
} from '../src/project';

function codes(d: ProjectDiagnostic[]): string[] {
  return d.filter((x) => x.severity === 'error').map((x) => x.code);
}
function warns(d: ProjectDiagnostic[]): string[] {
  return d.filter((x) => x.severity === 'warning').map((x) => x.code);
}

describe('createEmptyProject', () => {
  it('空项目通过校验（合法基线）', () => {
    const p = createEmptyProject('zombie-horde', '末日尸潮');
    expect(codes(validateProject(p))).toEqual([]);
    expect(isProjectValid(p)).toBe(true);
  });

  it('内置层就位，数量不超过上限', () => {
    const p = createEmptyProject('zombie-horde');
    expect(p.layers.slice(0, BUILTIN_LAYERS.length)).toEqual([...BUILTIN_LAYERS]);
    expect(p.layers.length).toBeLessThanOrEqual(MAX_LAYERS);
  });

  it('默认资产根为 assets，材质库与行为目录有默认值', () => {
    const p = createEmptyProject('zombie-horde');
    expect(p.assetRoots).toEqual(['assets']);
    expect(p.materialLibrary).toContain('library.mat.json');
    expect(p.behaviorRoots).toContain('assets/behaviors');
  });

  it('默认渲染档位 t1（与安全降级一致，不激进）', () => {
    expect(defaultRenderSettings().targetTier).toBe('t1');
  });
});

describe('validateProject · 根节点', () => {
  it('非对象 → E_PROJ_NOT_OBJECT', () => {
    expect(codes(validateProject(null))).toContain('E_PROJ_NOT_OBJECT');
  });

  it('未来版本 → E_PROJ_VERSION_FUTURE', () => {
    const p = { ...createEmptyProject('x'), schemaVersion: PROJECT_SCHEMA_VERSION + 1 };
    expect(codes(validateProject(p))).toContain('E_PROJ_VERSION_FUTURE');
  });

  it('name 为空 → E_PROJ_NAME', () => {
    const p = { ...createEmptyProject('x'), name: '' };
    expect(codes(validateProject(p))).toContain('E_PROJ_NAME');
  });

  it('assetRoots 为空数组 → E_PROJ_ROOTS（没有资产根，guid 索引无从扫描）', () => {
    const p = { ...createEmptyProject('x'), assetRoots: [] };
    expect(codes(validateProject(p))).toContain('E_PROJ_ROOTS');
  });
});

describe('validateProject · 场景清单', () => {
  const withScenes = (scenes: AetherProject['scenes'], startIndex: number | null = null): AetherProject => ({
    ...createEmptyProject('x'),
    scenes,
    startIndex,
  });
  const scene = (path: string, id = `sc_${path}`, enabled = true) => ({ path, id, enabled });

  it('重复登记同一场景 → E_PROJ_SCENE_DUP', () => {
    const p = withScenes([scene('a.scene.json'), scene('a.scene.json')]);
    expect(codes(validateProject(p))).toContain('E_PROJ_SCENE_DUP');
  });

  it('startIndex 越界 → E_PROJ_START_RANGE', () => {
    const p = withScenes([scene('a.scene.json')], 5);
    expect(codes(validateProject(p))).toContain('E_PROJ_START_RANGE');
  });

  it('启动场景被禁用 → E_PROJ_START_DISABLED（打包后无内容可跑）', () => {
    const p = withScenes([scene('a.scene.json', 'sc_a', false)], 0);
    expect(codes(validateProject(p))).toContain('E_PROJ_START_DISABLED');
  });

  it('有场景但全禁用 → W_PROJ_NO_ENABLED', () => {
    const p = withScenes([scene('a.scene.json', 'sc_a', false)], null);
    const d = validateProject(p);
    expect(codes(d)).toEqual([]);
    expect(warns(d)).toContain('W_PROJ_NO_ENABLED');
  });

  it('场景缺 id → W_PROJ_SCENE_ID（重命名文件后引用找不回）', () => {
    const p = withScenes([{ path: 'a.scene.json', id: '', enabled: true }]);
    expect(warns(validateProject(p))).toContain('W_PROJ_SCENE_ID');
  });

  it('GDD 的 3 层结构可完整登记（Act1 场景清单）', () => {
    const p = withScenes(
      [
        scene('assets/scenes/act1/act1-01-highway.scene.json', 'sc_act1_01'),
        scene('assets/scenes/act1/act1-02-blockade.scene.json', 'sc_act1_02'),
        scene('assets/scenes/sandbox/combat-test.scene.json', 'sc_test', false),
      ],
      0,
    );
    expect(codes(validateProject(p))).toEqual([]);
  });
});

describe('validateProject · 层与标签', () => {
  it('改内置层名 → E_PROJ_LAYER_BUILTIN（layer 索引语义靠内置层稳定）', () => {
    const p = createEmptyProject('x');
    p.layers[0] = 'MyDefault';
    expect(codes(validateProject(p))).toContain('E_PROJ_LAYER_BUILTIN');
  });

  it('层名重复 → E_PROJ_LAYER_DUP', () => {
    const p = createEmptyProject('x');
    p.layers.push('Enemy', 'Enemy');
    expect(codes(validateProject(p))).toContain('E_PROJ_LAYER_DUP');
  });

  it('层表超过 32 → E_PROJ_LAYERS_MAX', () => {
    const p = createEmptyProject('x');
    p.layers = Array.from({ length: MAX_LAYERS + 1 }, (_, i) => `L${i}`);
    expect(codes(validateProject(p))).toContain('E_PROJ_LAYERS_MAX');
  });

  it('用户层可自由追加（GDD 需要 Enemy / Projectile / Hazard）', () => {
    const p = createEmptyProject('x');
    p.layers.push('Enemy', 'Projectile', 'Hazard');
    expect(codes(validateProject(p))).toEqual([]);
  });

  it('标签重复 → E_PROJ_TAG_DUP', () => {
    const p = createEmptyProject('x');
    p.tags = ['Boss', 'Boss'];
    expect(codes(validateProject(p))).toContain('E_PROJ_TAG_DUP');
  });
});

describe('validateProject · 渲染', () => {
  const withRender = (patch: Record<string, unknown>): AetherProject => ({
    ...createEmptyProject('x'),
    render: { ...defaultRenderSettings(), ...patch },
  });

  it('targetTier 非法 → E_PROJ_TIER', () => {
    expect(codes(validateProject(withRender({ targetTier: 'ultra' })))).toContain('E_PROJ_TIER');
  });

  it('renderScale 越界 → E_PROJ_SCALE（0 会除零，>2 没意义）', () => {
    expect(codes(validateProject(withRender({ renderScale: 0 })))).toContain('E_PROJ_SCALE');
    expect(codes(validateProject(withRender({ renderScale: 3 })))).toContain('E_PROJ_SCALE');
  });

  it('renderScale 0.5 合法（移动端半分辨率渲染）', () => {
    expect(codes(validateProject(withRender({ renderScale: 0.5, targetTier: 't0' })))).toEqual([]);
  });

  it('targetFps 为负或非整数 → E_PROJ_FPS', () => {
    expect(codes(validateProject(withRender({ targetFps: -1 })))).toContain('E_PROJ_FPS');
    expect(codes(validateProject(withRender({ targetFps: 59.5 })))).toContain('E_PROJ_FPS');
  });

  it('targetFps = 0 合法（不限帧）', () => {
    expect(codes(validateProject(withRender({ targetFps: 0 })))).toEqual([]);
  });
});

describe('序列化往返', () => {
  it('完整项目往返后等价且仍合法', () => {
    const p = createEmptyProject('zombie-horde', '末日尸潮');
    p.description = '第三人称俯视 mobile 横屏 3D 僵尸肉鸽';
    p.layers.push('Enemy', 'Projectile', 'Hazard');
    p.tags.push('Boss', 'Loot');
    p.scenes = [
      { path: 'assets/scenes/act1/act1-01-highway.scene.json', id: 'sc_act1_01', enabled: true },
      { path: 'assets/scenes/sandbox/combat-test.scene.json', id: 'sc_test', enabled: false },
    ];
    p.startIndex = 0;
    p.render = { ...defaultRenderSettings(), targetTier: 't1', renderScale: 0.75 };
    p.defaultStyle = 'assets/style/toon-comic.post.json';
    p.inputMap = 'assets/input/mobile-landscape.input.json';

    const round = JSON.parse(JSON.stringify(p)) as AetherProject;
    expect(round).toEqual(p);
    expect(isProjectValid(round)).toBe(true);
  });

  it('项目文件名常量稳定（改它等于全仓库锚点改名）', () => {
    expect(PROJECT_FILE_NAME).toBe('aether.project.json');
  });
});
