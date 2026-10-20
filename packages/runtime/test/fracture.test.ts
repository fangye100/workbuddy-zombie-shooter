import { describe, it, expect } from 'vitest';
import {
  fractureTargetKey, fractureEventKey, frozenFractureEvent, validFractureBudget,
  type FractureEvent, type FractureBudget,
} from '../src/fracture';

const event: FractureEvent = {
  sequence: 7, tick: 1204, seed: 42,
  profile: { path: 'assets/fracture/crate/crate.fracture.json', guid: 'as_fract1' },
  target: { kind: 'scene-object', runId: 'run-1', nodeId: 'nd_crate01' },
  position: [1, 0.5, -2], contact: [1, 0.5, -2], normal: [0, 1, 0], impulse: [3, 1, 0],
  source: { weaponId: 'pistol', hitSequence: 3 },
};

describe('碎裂事件契约', () => {
  it('同一身份一次运行只允许一次破碎：去重键与事件序号/tick 无关', () => {
    expect(fractureEventKey(event)).toBe(fractureTargetKey(event.target));
    expect(fractureEventKey({ ...event, sequence: 99, tick: 9999, source: { weaponId: 'shotgun', hitSequence: 12 } }))
      .toBe(fractureEventKey(event));
  });

  it('NPC 身份按 runId/槽位/id/generation 区分；对象与 NPC 键不冲突', () => {
    const npcA = { kind: 'npc' as const, runId: 'run-1', slot: 2, id: 17, generation: 3 };
    const npcB = { ...npcA, generation: 4 };
    expect(fractureTargetKey(npcA)).not.toBe(fractureTargetKey(npcB));
    expect(fractureTargetKey(npcA)).not.toBe(fractureTargetKey(event.target));
  });

  it('公开事件快照冻结，嵌套数组不可改写', () => {
    const frozen = frozenFractureEvent(event);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.position)).toBe(true);
    expect(Object.isFrozen(frozen.profile)).toBe(true);
    expect(() => { (frozen.position as unknown as number[])[0] = 9; }).toThrow();
    expect(frozen.contact).toEqual([1, 0.5, -2]);
    expect(frozenFractureEvent({ ...event, contact: null, impulse: null }).contact).toBeNull();
  });

  it('预算取值域校验：越界预算在入口被拒绝', () => {
    const budget: FractureBudget = { maxRigidBodies: 32, maxSimplifiedChunks: 256, maxEventQueue: 256, fixedStepSec: 1 / 60, maxCatchUpTicks: 8 };
    expect(validFractureBudget(budget)).toBe(true);
    expect(validFractureBudget({ ...budget, maxRigidBodies: 0 })).toBe(false);
    expect(validFractureBudget({ ...budget, maxSimplifiedChunks: 999999 })).toBe(false);
    expect(validFractureBudget({ ...budget, fixedStepSec: 1 })).toBe(false);
    expect(validFractureBudget({ ...budget, maxCatchUpTicks: 1.5 })).toBe(false);
    expect(validFractureBudget(null)).toBe(false);
  });
});
