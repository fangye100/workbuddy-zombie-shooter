/**
 * scene-boot.ts 的测试（ADR-009：应用侧测试与被测代码同位，放在本应用的 test 目录）。
 *
 * 测的是「项目容器 → 起始场景路径」这一步的判定规则，重点是**降级路径**：
 * 项目文件读不到 / 不合法 / 没登记场景 / startIndex 越界，每种都要有确定行为，
 * 且**都不抛异常** —— 编辑器不能因为项目文件坏了就白屏。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  FALLBACK_SCENE_PATH,
  resolveStartScenePath,
  type JsonFetch,
  type StartSceneResolution,
} from '../src/scene-boot';

/** 仓库里真实的项目文件，作为"合法输入"的基线（不再手搓一份假的，否则测不到真格式） */
const projectModules = import.meta.glob('/aether.project.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;
const realProject = projectModules['/aether.project.json'] as Record<string, unknown>;

/** 造一个假 fetch：按 url 返回预设结果 */
function fakeFetch(handler: (url: string) => unknown | Promise<unknown>): JsonFetch {
  return async (url: string) => {
    const body = await handler(url);
    if (body === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveStartScenePath', () => {
  it('正常路径：从项目容器取 scenes[startIndex]（ADR-015 锚点）', async () => {
    const r = await resolveStartScenePath(fakeFetch(() => realProject));
    const scenes = realProject['scenes'] as { path: string }[];
    const idx = (realProject['startIndex'] as number) ?? 0;
    expect(r.fromProject).toBe(true);
    expect(r.warning).toBeNull();
    expect(r.path).toBe(`/${scenes[idx]!.path.replace(/^\//, '')}`);
  });

  it('项目文件 HTTP 失败 → 兜底 + fromProject=false', async () => {
    const r = await resolveStartScenePath(fakeFetch(() => null));
    expect(r).toMatchObject({ path: FALLBACK_SCENE_PATH, fromProject: false });
    expect(r.warning).toContain('HTTP 404');
  });

  it('项目文件校验不通过 → 兜底（不让坏数据进渲染器）', async () => {
    const r = await resolveStartScenePath(fakeFetch(() => ({ schemaVersion: 1 })));
    expect(r.fromProject).toBe(false);
    expect(r.warning).toContain('校验失败');
  });

  it('项目里没登记场景 → 兜底（空数组是校验器允许的，只有这里能兜住）', async () => {
    const r = await resolveStartScenePath(
      fakeFetch(() => ({ ...realProject, scenes: [], startIndex: null })),
    );
    expect(r.fromProject).toBe(false);
    expect(r.warning).toContain('没有登记任何场景');
  });

  it('startIndex 为 null → 取 scenes[0] 并给 warning', async () => {
    const scenes = [
      { id: 'a', path: 'assets/scenes/a.scene.json', enabled: true },
      { id: 'b', path: 'assets/scenes/b.scene.json', enabled: true },
    ];
    const r = await resolveStartScenePath(
      fakeFetch(() => ({ ...realProject, scenes, startIndex: null })),
    );
    expect(r).toMatchObject({ path: '/assets/scenes/a.scene.json', fromProject: true });
    expect(r.warning).toContain('startIndex 为空');
  });

  // 下面两条**不该**由 scene-boot 自己判 —— validateProject 已经用 error 拦过
  // （E_PROJ_START_RANGE / E_PROJ_SCENE_PATH）。这里断言"拦得住"，防止以后有人
  // 把规则从校验器里删掉、或者反过来在 scene-boot 里重写一份。
  it('startIndex 越界 → 被校验器拦住，走兜底（不是自己回落）', async () => {
    const scenes = [
      { id: 'a', path: 'assets/scenes/a.scene.json', enabled: true },
      { id: 'b', path: 'assets/scenes/b.scene.json', enabled: true },
    ];
    const r = await resolveStartScenePath(
      fakeFetch(() => ({ ...realProject, scenes, startIndex: 9 })),
    );
    expect(r.fromProject).toBe(false);
    expect(r.warning).toContain('校验失败');
  });

  it('scenes[i] 缺 path → 被校验器拦住，走兜底', async () => {
    const r = await resolveStartScenePath(
      fakeFetch(() => ({ ...realProject, scenes: [{ id: 'x', enabled: true }], startIndex: 0 })),
    );
    expect(r.fromProject).toBe(false);
    expect(r.warning).toContain('校验失败');
  });

  it('相对路径补前导斜杠，绝对路径不重复加', async () => {
    const rel = await resolveStartScenePath(
      fakeFetch(() => ({ ...realProject, scenes: [{ path: 'assets/x.scene.json' }], startIndex: 0 })),
    );
    expect(rel.path).toBe('/assets/x.scene.json');
    const abs = await resolveStartScenePath(
      fakeFetch(() => ({ ...realProject, scenes: [{ path: '/assets/x.scene.json' }], startIndex: 0 })),
    );
    expect(abs.path).toBe('/assets/x.scene.json');
  });

  it('fetch 抛异常 → 兜底且不冒泡，但根因要留在 warning 里', async () => {
    const r = await resolveStartScenePath(
      fakeFetch(() => {
        throw new Error('network down');
      }),
    );
    expect(r.fromProject).toBe(false);
    expect(r.warning).toContain('network down');
  });

  it('默认参数是全局 fetch，且走 /__fs/file 端点（不是裸路径）', async () => {
    const stub = vi.fn(async () => ({ ok: true, status: 200, json: async () => realProject }));
    vi.stubGlobal('fetch', stub);
    const r: StartSceneResolution = await resolveStartScenePath();
    expect(r.fromProject).toBe(true);
    // 直接 fetch /aether.project.json 会被 vite SPA fallback 挡成 200 + index.html
    expect(stub).toHaveBeenCalledWith('/__fs/file?path=aether.project.json');
  });
});
