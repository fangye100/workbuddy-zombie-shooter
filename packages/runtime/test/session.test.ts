import { describe, it, expect } from 'vitest';
import { RuntimeSession } from '../src/session';
import { loadLevelRuntime } from '../src/loader';
import type { SceneDocument } from '@aether/scene';
import type { LevelRuntimeDesc } from '../src/loader';

const MODULES = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });

function desc(): LevelRuntimeDesc {
  const key = Object.keys(MODULES)[0]!;
  const doc = (MODULES[key] as { default: unknown }).default as SceneDocument;
  const r = loadLevelRuntime(doc);
  if (r.desc === null) throw new Error('测试夹具装载失败：' + JSON.stringify(r.diagnostics));
  return r.desc;
}

function make(opts: { seed?: number; capacity?: number } = {}): RuntimeSession {
  return new RuntimeSession({ desc: desc(), seed: opts.seed ?? 1, ...(opts.capacity ? { capacity: opts.capacity } : {}) });
}

/** 僵尸中心是否落在障碍内部（留 0.05 容差）。这是"没有穿墙"的最低标准 */
function insideAnyObstacle(s: RuntimeSession, x: number, z: number): boolean {
  const eps = 0.05;
  for (const o of s.desc.obstacles) {
    if (!o.enabled) continue;
    if (Math.abs(x - o.x) < o.halfX - eps && Math.abs(z - o.z) < o.halfZ - eps) return true;
  }
  return false;
}

describe('RuntimeSession —— 房间进入触发', () => {
  it('玩家出生所在的房间立即触发，未进入的房间不刷', () => {
    const s = make();
    // 房间 1 = 5+4+3 = 12 只；房间 3 = 12 只（玩家在 x≈3，房间 3 在 x≈56）
    expect(s.countNpc()).toBe(12);
    expect(s.triggeredRooms()).toEqual(['nd_f1r0']);
  });

  it('再次跨越边界不重复投放同一波', () => {
    const s = make();
    s.run(200);
    expect(s.countNpc()).toBe(12);
    expect(s.triggeredRooms()).toEqual(['nd_f1r0']);
  });

  it('实体能追溯到来源刷怪点（一处刷怪点可生成多个实体）', () => {
    const s = make();
    const v = s.view();
    const fromSp0 = v.filter((e) => e.sourceNodeId === 'nd_f1r0_sp0');
    expect(fromSp0).toHaveLength(5); // E-01 ×5
    expect(v.filter((e) => e.kind === 'player')[0]?.sourceNodeId).toBe('nd_f1_start');
  });

  it('身份带 generation，不是裸数组下标', () => {
    const s = make();
    const v = s.view();
    expect(v.every((e) => Number.isInteger(e.generation))).toBe(true);
    expect(new Set(v.map((e) => e.id)).size).toBe(v.length);
  });
});

describe('RuntimeSession —— 障碍真实参与约束', () => {
  it('推进过程中没有僵尸停在障碍内部', () => {
    const s = make({ seed: 7 });
    for (const t of [0, 10, 50, 200]) {
      s.run(t === 0 ? 0 : t - s.tick);
      for (const e of s.view()) {
        if (e.kind !== 'npc') continue;
        expect(insideAnyObstacle(s, e.x, e.z)).toBe(false);
      }
    }
  });

  it('僵尸确实朝玩家收敛（不是原地不动）', () => {
    const s = make({ seed: 3 });
    const before = s.view().filter((e) => e.kind === 'npc');
    const dBefore =
      before.reduce((a, e) => a + Math.hypot(e.x - s.desc.playerStart.x, e.z - s.desc.playerStart.z), 0) /
      before.length;
    s.run(300);
    const after = s.view().filter((e) => e.kind === 'npc');
    const dAfter =
      after.reduce((a, e) => a + Math.hypot(e.x - s.desc.playerStart.x, e.z - s.desc.playerStart.z), 0) /
      after.length;
    expect(dAfter).toBeLessThan(dBefore);
  });
});

describe('RuntimeSession —— 确定性与容量', () => {
  it('同种子：reset 后重跑到同一 tick，结果逐位一致', () => {
    const s = make({ seed: 42 });
    s.run(60);
    const a = s.view().map((e) => `${e.characterId}:${e.x.toFixed(6)},${e.z.toFixed(6)}`);
    s.reset();
    s.run(60);
    const b = s.view().map((e) => `${e.characterId}:${e.x.toFixed(6)},${e.z.toFixed(6)}`);
    expect(b).toEqual(a);
  });

  it('不同种子得到不同散布（种子真的被用上了）', () => {
    const a = make({ seed: 1 }).view().map((e) => e.x.toFixed(6));
    const b = make({ seed: 999 }).view().map((e) => e.x.toFixed(6));
    expect(b).not.toEqual(a);
  });

  it('容量不足 → 整批原子拒绝，不留半批实体', () => {
    const s = make({ capacity: 6 }); // 玩家占 1，房间 1 需要 12
    expect(s.countNpc()).toBe(0);
    expect(s.triggeredRooms()).toEqual([]);
  });

  it('reset 回到初始状态（房间需要重新触发，实体数不累积）', () => {
    const s = make();
    s.run(30);
    s.reset();
    expect(s.tick).toBe(0);
    expect(s.countNpc()).toBe(12);
  });
});
