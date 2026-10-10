import { it,expect } from 'vitest';
import type { SceneDocument, RunRulesComponent } from '@aether/scene';
import { migrateToLatest,validRunRules } from '@aether/scene';
import { RuntimeSession,loadLevelRuntime } from '../src';
const modules=import.meta.glob("../../../assets/scenes/act1/*.scene.json",{eager:true,import:'default'});
function document(n:number):SceneDocument {return structuredClone(modules[`../../../assets/scenes/act1/floor-${n}.scene.json`] as SceneDocument);}
it('第一层长期突扑战斗不进入玩家圆盘内部',()=>{
  const desc=loadLevelRuntime(document(1)).desc!,s=new RuntimeSession({desc,seed:7});
  s.table.health[s.playerEntityId]=10000;
  for(let tick=0;tick<600;tick++) {
    s.step();const p=s.player()!;
    for(const e of s.view().filter(e=>e.kind==='npc'))
      expect(Math.hypot(e.x-p.x,e.z-p.z)).toBeGreaterThanOrEqual(s.table.radius[e.id]!+s.table.radius[p.id]!-.025);
  }
  expect(s.navigationSnapshot().crowd.externalBlockedMoves).toBeGreaterThan(0);
});
it('the campaign multiplies fodder, retains unique elites/boss and bounds concurrent ordinary attackers',()=>{
  for(const [floor,total,firstWave] of [[1,72,24],[2,137,48],[3,53,16]]){
    const doc=document(floor!),desc=loadLevelRuntime(doc).desc!;
    expect(desc.spawns.reduce((n,s)=>n+s.count,0)).toBe(total);
    for(const sp of desc.spawns.filter(s=>s.characterId.startsWith('B-') || s.characterId==='E-04'))expect(sp.count).toBe(1);
    const s=new RuntimeSession({desc,seed:7});expect(s.countNpc()).toBe(firstWave);
    s.table.health[s.playerEntityId]=10000;
    for(let tick=0;tick<180;tick++){
      s.step();const ordinary=s.view().filter(e=>e.kind==='npc' && e.characterId!=='E-04' && !e.characterId.startsWith('B-') && e.behavior===2);
      expect(ordinary.length).toBeLessThanOrEqual(desc.runRules!.attackTokenCount);
    }
  }
});
it('manual pointer aim is independent of strafing and overrides optional aim assist',()=>{
  const desc=loadLevelRuntime(document(1)).desc!;desc.obstacles=[];desc.shotColliders=[];
  const s=new RuntimeSession({desc,seed:7});s.aimAssist=true;s.setInput(0,1);s.setAim(18,0);s.setFire(true);s.step();
  const shot=s.lastShot!;expect(shot).not.toBeNull();expect(shot.to[0]).toBeGreaterThan(shot.from[0]);
  expect(shot.to[2]).toBeLessThan(shot.from[2]);expect(s.player()!.z).toBeGreaterThan(0);
  s.reset();expect(s.firing).toBe(false);expect(s.enemyAttacks.effects).toHaveLength(0);
});
it('v11 migrates a persisted attack budget; invalid authored budgets are rejected',()=>{
  const old=document(1);old.schemaVersion=11;
  const rule=old.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules')! as RunRulesComponent;
  delete (rule as unknown as Record<string,unknown>).attackTokenCount;
  delete (rule as unknown as Record<string,unknown>).npcTiming;
  const migrated=migrateToLatest(old);expect(migrated.applied).toEqual(['authored-crowd-attack-budget','unified-weapon-arsenal','scene-audio-cue-mapping','integrated-weapons-audio-body-ik','predictive-crowd-navigation']);
  const next=migrated.doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules') as RunRulesComponent;
  expect(next.attackTokenCount).toBe(4);expect(validRunRules(next)).toBe(true);
  expect(next.npcTiming.decisionMaxSec).toBeGreaterThan(next.npcTiming.decisionMinSec);
  expect(validRunRules({...next,npcTiming:{...next.npcTiming,windupJitterFrac:-1}})).toBe(false);
  expect(validRunRules({...next,attackTokenCount:0})).toBe(false);expect(validRunRules({...next,attackTokenCount:1.2})).toBe(false);
  expect((rule as unknown as Record<string,unknown>).attackTokenCount).toBeUndefined();
});
it('seeded transitions stay reproducible and stagger perception, windup and recovery across a crowd',()=>{
  const desc=loadLevelRuntime(document(1)).desc!;desc.shotColliders=[];desc.obstacles=[];
  const snapshots=(seed:number)=>{
    const s=new RuntimeSession({desc,seed});s.table.health[s.playerEntityId]=10000;
    // Equal distance isolates state cadence from travel/scatter differences.
    for(const e of s.view().filter(e=>e.kind==='npc')){s.table.posX[e.id]=4;s.table.posZ[e.id]=0;s.table.maxSpeed[e.id]=0;}
    const initial=s.view().filter(e=>e.kind==='npc');expect(initial.every(e=>e.behavior===0)).toBe(true);
    const transitions:string[]=[];const previous=new Map<number,number>();
    for(let tick=0;tick<300;tick++){
      s.step();for(const e of s.view().filter(e=>e.kind==='npc'))if(previous.get(e.id)!==e.behavior){transitions.push(`${s.tick}:${e.id}:${e.behavior}`);previous.set(e.id,e.behavior);}
    }
    return transitions;
  };
  const a=snapshots(7);expect(snapshots(7)).toEqual(a);expect(snapshots(8)).not.toEqual(a);
  expect(new Set(a.filter(x=>x.endsWith(':1')).map(x=>x.split(':')[0])).size).toBeGreaterThan(1);
  expect(a.some(x=>x.endsWith(':4'))).toBe(true);
});
it('前摇与收势提供单调阶段相位，收势不随机循环且不延迟模拟死亡',()=>{
  const desc=loadLevelRuntime(document(1)).desc!;desc.shotColliders=[];desc.obstacles=[];
  const s=new RuntimeSession({desc,seed:7});s.table.health[s.playerEntityId]=10000;
  for(const e of s.view().filter(e=>e.kind==='npc')){s.table.posX[e.id]=4;s.table.posZ[e.id]=0;s.table.maxSpeed[e.id]=0;}
  const last=new Map<number,{behavior:number;phase:number}>();let recoverSamples=0;
  for(let tick=0;tick<180;tick++){
    s.step();for(const e of s.view().filter(e=>e.kind==='npc')){
      if(e.behavior!==2 && e.behavior!==4)continue;
      expect(e.behaviorPhase).toBeGreaterThanOrEqual(0);expect(e.behaviorPhase).toBeLessThanOrEqual(1);
      const p=last.get(e.id);if(p?.behavior===e.behavior)expect(e.behaviorPhase!).toBeGreaterThanOrEqual(p.phase);
      last.set(e.id,{behavior:e.behavior,phase:e.behaviorPhase!});if(e.behavior===4)recoverSamples++;
    }
    // Clear last on every other state so a later attack starts its own phase.
    for(const e of s.view())if(e.behavior!==2 && e.behavior!==4)last.delete(e.id);
  }
  expect(recoverSamples).toBeGreaterThan(0);
  const npc=s.view().find(e=>e.kind==='npc')!;s.applyDamage(npc.id,10000);
  expect(s.view().some(e=>e.id===npc.id)).toBe(false);
  expect(s.combatEvents.at(-1)?.defeated).toMatchObject({id:npc.id,generation:npc.generation,runId:npc.runId});
});
it('an NPC cannot begin windup outside its authored attack distance, even while chasing',()=>{
  const desc=loadLevelRuntime(document(1)).desc!;desc.shotColliders=[];desc.obstacles=[];
  const s=new RuntimeSession({desc,seed:7});s.table.health[s.playerEntityId]=10000;
  for(const e of s.view().filter(e=>e.kind==='npc')){s.table.posX[e.id]=10;s.table.posZ[e.id]=0;s.table.maxSpeed[e.id]=0;}
  for(let tick=0;tick<180;tick++){
    s.step();expect(s.view().filter(e=>e.kind==='npc').every(e=>e.behavior!==2)).toBe(true);
    expect(s.enemyAttacks.effects).toHaveLength(0);
  }
  // Moving into range permits an attack only on that actor's next decision.
  const npc=s.view().find(e=>e.kind==='npc')!;s.table.posX[npc.id]=4;
  let windup=false;for(let tick=0;tick<30;tick++){s.step();windup ||= s.table.behavior[npc.id]===2;}
  expect(windup).toBe(true);
});
