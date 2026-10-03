/**
 * Play 相机接线测试（ADR-018 P6）。
 *
 * 重点两条：
 * 1. 回退链路必须对（entryCamera → 第一个启用 Camera → null）
 * 2. **必须保存/还原编辑相机** —— AuthorSnapshot 不含相机，
 *    不自己还原就会让 Stop 之后编辑视角停在游戏相机位置（实打实的污染）
 */

import { describe, expect, it } from 'vitest';
import {
  PlayCameraController,
  planPlayCamera,
  resolveEntryCamera,
  type ViewCameraState,
} from '../src/services/play-camera';
import type { SceneDocument } from '@aether/scene';

function cam(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: 'Camera',
    enabled: true,
    fovDeg: 50,
    near: 0.1,
    far: 100,
    mode: 'orbit-follow',
    followTarget: null,
    pitchDeg: 35,
    distance: 12,
    yawOffsetDeg: 0,
    ...over,
  };
}

function node(id: string, components: Record<string, unknown>[]): Record<string, unknown> {
  return { id, name: id, parent: null, transform: {}, visible: true, pickable: true, components, prefab: null };
}

function doc(nodes: Record<string, unknown>[], entryCamera: string | null = null): SceneDocument {
  return {
    schemaVersion: 3,
    id: 'sc_test',
    name: '相机测试',
    act: null,
    environment: {},
    editorCamera: { target: [0, 0, 0], distance: 40, yaw: 0, elevation: 0.6 },
    entryCamera,
    playerStart: null,
    nodes,
  } as unknown as SceneDocument;
}

/** 假的世界坐标查询：只有指定节点有坐标，其余返回 null */
function posOf(map: Record<string, [number, number, number]>) {
  return (id: string): [number, number, number] | null => map[id] ?? null;
}

describe('resolveEntryCamera · 回退链路', () => {
  it('entryCamera 指向的节点带启用 Camera → 用它', () => {
    const d = doc([node('a', [cam()]), node('b', [cam({ distance: 99 })])], 'b');
    const r = resolveEntryCamera(d);
    expect(r?.nodeId).toBe('b');
    expect(r?.cam.distance).toBe(99);
  });

  it('entryCamera 为 null → 取第一个启用的 Camera 组件', () => {
    const d = doc([node('a', [{ kind: 'MeshRenderer' }]), node('b', [cam()])], null);
    expect(resolveEntryCamera(d)?.nodeId).toBe('b');
  });

  it('🔴 entryCamera 指向的节点没有 Camera 组件 → 继续回退，不当错误', () => {
    const d = doc([node('a', [cam()]), node('b', [{ kind: 'MeshRenderer' }])], 'b');
    expect(resolveEntryCamera(d)?.nodeId).toBe('a');
  });

  it('🔴 entryCamera 指向的 Camera 被禁用 → 继续回退', () => {
    const d = doc([node('a', [cam()]), node('b', [cam({ enabled: false })])], 'b');
    expect(resolveEntryCamera(d)?.nodeId).toBe('a');
  });

  it('没有启用 Camera → null（保持编辑相机，不污染）', () => {
    const d = doc([node('a', [cam({ enabled: false })]), node('b', [{ kind: 'MeshRenderer' }])], null);
    expect(resolveEntryCamera(d)).toBeNull();
  });

  it('entryCamera 指向不存在的节点 → 回退到第一个启用 Camera', () => {
    const d = doc([node('a', [cam()])], 'nope');
    expect(resolveEntryCamera(d)?.nodeId).toBe('a');
  });
});

describe('planPlayCamera · 姿态计算', () => {
  const entry = { nodeId: 'cam1', cam: cam({ mode: 'orbit-follow', followTarget: 'player', pitchDeg: 40, distance: 15, yawOffsetDeg: 90 }) as never };

  it('用 followTarget 的世界坐标作 target，并带上 pitch/distance', () => {
    const p = planPlayCamera(entry, posOf({ player: [3, 0, 5] }));
    expect(p).not.toBeNull();
    expect(p!.target).toEqual([3, 0, 5]);
    expect(p!.distance).toBe(15);
    expect(p!.elevationDeg).toBe(40);
  });

  it('yawOffsetDeg 叠加到 baseYaw 上（度转弧度）', () => {
    const p = planPlayCamera(entry, posOf({ player: [0, 0, 0] }), 0);
    expect(p!.yaw).toBeCloseTo(Math.PI / 2, 5); // 90°
  });

  it('followTarget 为 null 时用相机节点自身位置', () => {
    const e2 = { nodeId: 'cam1', cam: cam({ followTarget: null }) as never };
    const p = planPlayCamera(e2, posOf({ cam1: [7, 1, 2] }));
    expect(p!.target).toEqual([7, 1, 2]);
  });

  it('锚点节点取不到世界坐标 → null（不要静默用原点）', () => {
    expect(planPlayCamera(entry, posOf({}))).toBeNull();
  });

  it('🔴 数值守卫：字段缺失/非有限 → null（否则 distance=NaN 会让视口黑屏）', () => {
    const mk = (over: Record<string, unknown>) =>
      ({ nodeId: 'cam1', cam: cam(over) as never }) as never;
    expect(planPlayCamera(mk({ distance: undefined }), posOf({ cam1: [0, 0, 0] }))).toBeNull();
    expect(planPlayCamera(mk({ pitchDeg: 'x' }), posOf({ cam1: [0, 0, 0] }))).toBeNull();
    expect(planPlayCamera(mk({ distance: 0 }), posOf({ cam1: [0, 0, 0] }))).toBeNull();
    expect(planPlayCamera(mk({ distance: -5 }), posOf({ cam1: [0, 0, 0] }))).toBeNull();
  });
});

describe('PlayCameraController · 保存与还原', () => {
  function harness() {
    let cur: ViewCameraState = { target: [0, 0, 0], distance: 40, yaw: 0, elevationDeg: 30 };
    const view = {
      get: () => cur,
      set: (s: ViewCameraState) => {
        cur = s;
      },
    };
    return { view, get cur() { return cur; } };
  }

  const gameDoc = doc([node('cam1', [cam({ pitchDeg: 50, distance: 18 })])], 'cam1');

  it('attach 切到游戏相机，detach 精确还原编辑相机', () => {
    const h = harness();
    const before = h.cur;
    const pc = new PlayCameraController(h.view);

    expect(pc.attach(gameDoc, posOf({ cam1: [10, 0, 10] }))).toBe(true);
    expect(h.cur.distance).toBe(18);
    expect(h.cur.elevationDeg).toBe(50);
    expect(h.cur.target).toEqual([10, 0, 10]);

    pc.detach();
    expect(h.cur).toEqual(before); // 🔴 必须还原
  });

  it('🔴 场景没有游戏相机 → attach 返回 false 且**完全不碰相机**', () => {
    const h = harness();
    const before = { ...h.cur };
    const pc = new PlayCameraController(h.view);
    expect(pc.attach(doc([node('a', [{ kind: 'MeshRenderer' }])]), posOf({}))).toBe(false);
    expect(h.cur).toEqual(before);
    expect(pc.active).toBe(false);
  });

  it('detach 幂等：重复调用不会二次写入', () => {
    const h = harness();
    const pc = new PlayCameraController(h.view);
    pc.attach(gameDoc, posOf({ cam1: [0, 0, 0] }));
    pc.detach();
    const after = { ...h.cur };
    pc.detach();
    expect(h.cur).toEqual(after);
    expect(pc.active).toBe(false);
  });

  it('🔴 orbit-follow 跟随玩家位置；fixed 模式钉住不动', () => {
    const h = harness();
    const pc = new PlayCameraController(h.view);

    // follow
    pc.attach(
      doc([node('cam1', [cam({ mode: 'orbit-follow', yawOffsetDeg: 90 })])], 'cam1'),
      posOf({ cam1: [0, 0, 0] }),
    );
    pc.update({ x: 12, z: 8, yaw: Math.PI });
    expect(h.cur.target[0]).toBe(12);
    expect(h.cur.target[2]).toBe(8);

    // fixed：即便传了玩家位置也不动
    const h2 = harness();
    const pc2 = new PlayCameraController(h2.view);
    pc2.attach(doc([node('cam1', [cam({ mode: 'fixed' })])], 'cam1'), posOf({ cam1: [1, 0, 2] }));
    pc2.update({ x: 99, z: 99, yaw: 0 });
    expect(h2.cur.target).toEqual([1, 0, 2]); // 没被拖走
  });

  // =====================================================================
  // 偏航跟随模式 yawMode（schema v5）
  //
  // 起因：用户实测反馈「第三人称上帝视角，但按左右移动时整个视角在跟着转」。
  // 根因是 update() 无条件 `yaw = target.yaw + offset` —— 把俯视上帝视角做成了
  // 肩后跟随视角。上帝视角下摇杆的"上"必须恒等于世界的某个方向，角色转身
  // 不该带相机；否则操作感直接崩坏（而且这不是手感偏好问题，是设计错误）。
  // =====================================================================
  describe('PlayCameraController · yawMode 偏航跟随', () => {
    function harness() {
      let cur: ViewCameraState = { target: [0, 0, 0], distance: 40, yaw: 0, elevationDeg: 30 };
      const view = { get: () => cur, set: (s: ViewCameraState) => { cur = s; } };
      return { view, get cur() { return cur; } };
    }

    const follow = (over: Record<string, unknown>) =>
      doc([node('cam1', [cam({ mode: 'orbit-follow', yawOffsetDeg: 90, ...over })])], 'cam1');

    it('🔴 缺省（旧场景无 yawMode）→ world：玩家转身**不**带相机', () => {
      const h = harness();
      const pc = new PlayCameraController(h.view);
      pc.attach(follow({}), posOf({ cam1: [0, 0, 0] }));
      const yawAfterAttach = h.cur.yaw; // = 0 + 90° = π/2
      expect(yawAfterAttach).toBeCloseTo(Math.PI / 2, 5);

      // 玩家转身到 π，相机 yaw 必须纹丝不动
      pc.update({ x: 1, z: 2, yaw: Math.PI });
      expect(h.cur.yaw).toBeCloseTo(yawAfterAttach, 6);

      // 再转几个角度都一样
      for (const y of [-2.5, 0.3, 1.9, 3.0]) {
        pc.update({ x: 0, z: 0, yaw: y });
        expect(h.cur.yaw).toBeCloseTo(yawAfterAttach, 6);
      }
    });

    it("yawMode='world' 明示：同上，位置跟随但朝向锁死", () => {
      const h = harness();
      const pc = new PlayCameraController(h.view);
      pc.attach(follow({ yawMode: 'world' }), posOf({ cam1: [0, 0, 0] }));
      pc.update({ x: 30, z: -12, yaw: 2.2 });
      expect(h.cur.target[0]).toBe(30); // 位置照跟
      expect(h.cur.target[2]).toBe(-12);
      expect(h.cur.yaw).toBeCloseTo(Math.PI / 2, 6); // 朝向锁在 plan
    });

    it("yawMode='target' → 肩后跟随：yaw = 玩家朝向 + yawOffsetDeg", () => {
      const h = harness();
      const pc = new PlayCameraController(h.view);
      pc.attach(follow({ yawMode: 'target' }), posOf({ cam1: [0, 0, 0] }));
      pc.update({ x: 0, z: 0, yaw: Math.PI });
      expect(h.cur.yaw).toBeCloseTo(Math.PI + Math.PI / 2, 5);
      pc.update({ x: 0, z: 0, yaw: -Math.PI / 2 });
      expect(h.cur.yaw).toBeCloseTo(-Math.PI / 2 + Math.PI / 2, 5);
    });

    it('两种模式都不动 pitch / distance（yawMode 只管偏航，别越权）', () => {
      const h = harness();
      const pc = new PlayCameraController(h.view);
      pc.attach(follow({ yawMode: 'target' }), posOf({ cam1: [0, 0, 0] }));
      const before = { d: h.cur.distance, e: h.cur.elevationDeg };
      pc.update({ x: 4, z: 4, yaw: 1.1 });
      expect(h.cur.distance).toBe(before.d);
      expect(h.cur.elevationDeg).toBe(before.e);
    });
  });

  it('没有 attach 时 update / detach 都是安全的空操作', () => {
    const h = harness();
    const before = { ...h.cur };
    const pc = new PlayCameraController(h.view);
    pc.update({ x: 1, z: 1, yaw: 0 });
    pc.detach();
    expect(h.cur).toEqual(before);
  });
});
