import { expect, it } from 'vitest';
import { NpcMotionPresentation } from '../src/presentation/npc-motion';
import type { EntityView, CombatEvent } from '../src/session';
const npc: EntityView = { id: 1, generation: 1, runId: 2, characterId: 'E-01', kind: 'npc', x: 3, z: 4, yaw: .5, alive: true, sourceNodeId: null, targetId: 0, behavior: 1, hp: 50, maxHp: 50, hitFlash: 0, lodTier: 0 };
const event = (type: 'damage'|'kill', tick = 1): CombatEvent => ({ type, tick, runId: 2, generation: 1, slot: 1, characterId: 'E-01', amount: 20, hpAfter: type==='kill'?0:30, sourceSlot: 0, sourceGeneration: 1, x: 3, z: 4 });
it('受击只影响表现，攻击优先；死亡不复活实体，暂停不重播，代次与 Stop 隔离', () => {
 const p = new NpcMotionPresentation(); p.frames([npc], [], 0, 1/30, 2);
 p.frames([npc], [event('damage')], 1, 1/30, 2);
 expect(p.cue(npc, 1, 1/30)?.phase).toBe(0);
 expect(p.cue({...npc,behavior:2},1,1/30)).toBeNull();
 expect(p.cue({...npc,motionCue:{state:'slam',phase:.4}},1,1/30)).toEqual({state:'slam',phase:.4});
 const dead=p.frames([], [event('damage'),event('kill',2)],2,1/30,2)[0]!;
 expect(dead.alive).toBe(false); expect(npc.alive).toBe(true);
 expect(p.cue(dead,2,1/30)).toEqual({state:'death',phase:0});
 expect(p.frames([], [event('damage'),event('kill',2)],32,1/30,2)).toHaveLength(1);
 expect(p.cue(dead,32,1/30)?.phase).toBeCloseTo(1/3.3);
 const replacement={...npc,generation:2};p.frames([replacement],[event('damage'),event('kill',2)],33,1/30,2);
 expect(p.cue(replacement,33,1/30)).toBeNull();
 expect(p.frames([],[],134,1/30,2)).toHaveLength(0);
 p.clear();expect(p.frames([],[],0,1/30,3)).toHaveLength(0);
});
it('尸体尾部最多 32 个，无法观察的目标和旧事件不伪造实体', () => {
 const p=new NpcMotionPresentation();expect(p.frames([], [event('kill')],1,1/30,2)).toEqual([]);
 p.clear();const live=Array.from({length:50},(_,i)=>({...npc,id:i+1}));p.frames(live,[],0,1/30,2);
 const ev=live.map(e=>({...event('kill'),slot:e.id}));expect(p.frames([],ev,1,1/30,2)).toHaveLength(32);
 expect(p.frames([],ev,1,1/30,3)).toHaveLength(0);
});
it('同一 tick 中生成又死亡的 NPC 使用击杀快照，玩家死亡不派生 NPC 尾部', () => {
 const p=new NpcMotionPresentation();
 expect(p.frames([], [{...event('kill'),defeated:npc}],1,1/30,2)[0]?.alive).toBe(false);
 p.clear();expect(p.frames([], [{...event('kill'),defeated:{...npc,kind:'player'}}],1,1/30,2)).toEqual([]);
 p.clear();expect(p.frames([], [{...event('kill'),defeated:{...npc,generation:2}}],1,1/30,2)).toEqual([]);
 p.clear();expect(p.frames([], [{...event('kill'),defeated:{...npc,runId:3}}],1,1/30,2)).toEqual([]);
});
