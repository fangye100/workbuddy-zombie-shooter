import {describe,it,expect} from 'vitest';
import {RuntimeSession,loadLevelRuntime} from '../src';
import {CombatDecalJournal} from '../src/combat-decals';
import {CombatDecalPlanner,type CombatDecalProjector} from '../src/presentation/combat-decals';
import {DecalPool} from '@aether/render';
import {validateSceneDocument,migrateToLatest,type SceneDocument,type DecalEmitterComponent} from '@aether/scene';
import raw from '../../../assets/scenes/sandbox/combat-decal-whitebox.scene.json';
const scene=()=>structuredClone(raw) as unknown as SceneDocument;
const config=()=>scene().nodes.flatMap(n=>n.components).find(c=>c.kind==='DecalEmitter') as DecalEmitterComponent;
const projection:CombatDecalProjector=(_fact,rule)=>({receiver:'ground',position:[0,0,0],rotation:[0,0,0,1],size:[...rule.size]});
function session(){const loaded=loadLevelRuntime(scene());if(!loaded.desc)throw Error(JSON.stringify(loaded.diagnostics));return new RuntimeSession({desc:loaded.desc,seed:7});}
const addBlood=(j:CombatDecalJournal,tick:number,slot=1)=>j.append(1,{event:'npc-damage',tick,point:[0,0,0],slot,generation:1});
describe('真实战斗贴花事实与场景配置',()=>{
  it('v20迁移只升版本；非法容量、淡出、重复配置拒绝；装载复制配置',()=>{
    const old=scene();old.schemaVersion=20;old.nodes.forEach(n=>n.components=n.components.filter(c=>c.kind!=='DecalEmitter'));const before=structuredClone(old),m=migrateToLatest(old);
    expect(m.applied).toEqual(['authored-combat-decal-emitter','integrated-navigation-pose-sockets','integrated-navigation-and-vfx','destructible-fracture-components','npc-death-fracture-reference']);expect(m.doc.nodes).toEqual(before.nodes);expect(old).toEqual(before);
    const doc=scene(),c=doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='DecalEmitter') as DecalEmitterComponent;c.rules[0]!.fadeSec=200;c.capacity=0;expect(validateSceneDocument(doc).some(d=>d.code==='E_DECAL_EMITTER')).toBe(true);
    const good=scene(),loader=loadLevelRuntime(good);expect(loader.desc?.decalEmitter).toEqual(config());good.nodes[0]!.components.push(config());expect(validateSceneDocument(good).some(d=>d.code==='E_DECAL_EMITTER_DUP')).toBe(true);
  });
  it('真实开火命中墙产生接收节点/法线；伤害记录在回收之前，零伤害无血，Reset清代次',()=>{
    const r=session();r.setAim(0,-20);r.setFire(true);r.step();r.setFire(false);
    expect(r.decalEvents.after(0).some(e=>e.event==='weapon-solid-impact'&&e.receiver==='nd_combat_wall'&&e.normal[2]>.9)).toBe(true);
    const npc=r.view().find(e=>e.kind==='npc')!;expect(npc).toBeDefined();const before=r.decalEvents.latest;
    r.applyDamage(npc.id,0);expect(r.decalEvents.latest).toBe(before);r.applyDamage(npc.id,9999,r.player()!.id);
    const blood=r.decalEvents.after(before);expect(blood).toHaveLength(1);expect(blood[0]).toMatchObject({event:'npc-damage',slot:npc.id,generation:npc.generation});
    const oldRun=r.runId;r.reset();expect(r.runId).not.toBe(oldRun);expect(r.decalEvents.after(0)).toEqual([]);
  });
  it('事实有界并脱离输入引用，慢消费者可观察丢弃',()=>{
    const j=new CombatDecalJournal();for(let i=0;i<520;i++)addBlood(j,i);expect(j.after(0)).toHaveLength(512);expect(j.dropped).toBe(8);
    const copied=j.after(0);copied[0]!.point[0]=99;expect(j.after(0)[0]!.point[0]).toBe(0);j.clear();expect(j.latest).toBe(0);
  });
});
describe('事件痕迹预算/寿命/限流',()=>{
  it('带下划线的规则ID不混计上限',()=>{
    const c=config();c.rules=[{...c.rules[1]!,id:'blood',maxAlive:1,cooldownSec:0},{...c.rules[1]!,id:'blood_alt',maxAlive:1,cooldownSec:0}];const p=new DecalPool(),planner=new CombatDecalPlanner(c),j=new CombatDecalJournal();addBlood(j,0);addBlood(j,1,2);planner.consume(j,1,1,1/30,p,projection);
    expect(p.snapshot().count).toBe(2);expect(planner.counts.ruleEvicted).toBe(2);expect(p.snapshot().marks.map(e=>e.mark.id)).toEqual(['combat_blood_2','combat_blood_alt_2']);
  });
  it('按事件时间淡出，暂停不衰减；每类/全局上限淘汰，过期事实不复活',()=>{
    const c=config();c.capacity=3;c.rules=[{...c.rules[1]!,maxAlive:2,cooldownSec:0,ttlSec:3,fadeSec:1}];const p=new DecalPool(3),planner=new CombatDecalPlanner(c),j=new CombatDecalJournal();
    for(let i=0;i<5;i++)addBlood(j,0,i);p.advance(1);planner.consume(j,1,1,1/30,p,projection);expect(p.snapshot().count).toBe(2);expect(planner.counts.ruleEvicted).toBe(3);
    const a=p.snapshot();planner.consume(j,1,1,1/30,p,projection);expect(p.snapshot()).toEqual(a);
    p.advance(2.5);expect(p.snapshot().marks[0]!.mark.opacity).toBeCloseTo(c.rules[0]!.opacity*.5);
    p.advance(3);expect(p.snapshot().count).toBe(0);addBlood(j,0);planner.consume(j,1,3,1/30,p,projection);expect(planner.counts.expired).toBe(1);
  });
  it('只做预算内表面查询，缺表面明确计数，不重复消费或跨run绘制',()=>{
    const c=config();c.maxPerFrame=2;c.rules=[{...c.rules[1]!,cooldownSec:0}];const p=new DecalPool(),planner=new CombatDecalPlanner(c),j=new CombatDecalJournal();let calls=0;
    for(let i=0;i<6;i++)addBlood(j,0,i);planner.consume(j,1,0,1/30,p,()=>{calls++;return null;});expect(calls).toBe(2);expect(planner.counts.noSurface).toBe(2);expect(planner.counts.budgetDropped).toBe(4);
    planner.consume(j,1,0,1/30,p,projection);expect(p.snapshot().count).toBe(0);addBlood(j,1);planner.consume(j,2,1/30,1/30,p,projection);expect(p.snapshot().count).toBe(0);
  });
  it('受击冷却不被每帧DOT刷屏；酸液不在有效伤害期提前淡出',()=>{
    const c=config(),p=new DecalPool(),planner=new CombatDecalPlanner(c),j=new CombatDecalJournal();addBlood(j,0);addBlood(j,1);j.append(1,{event:'acid-land',tick:0,slot:3,generation:1,point:[0,0,0],radius:1.2,activeSec:9});p.advance(1);planner.consume(j,1,1,1/30,p,projection);
    expect(planner.counts.throttled).toBe(1);const acid=p.snapshot().marks.find(e=>e.mark.pattern==='acid')!;expect(acid.remainingSec).toBe(10);
    p.advance(8);expect(p.snapshot().marks.find(e=>e.mark.pattern==='acid')!.mark.opacity).toBe(c.rules[2]!.opacity);
    p.advance(10);expect(p.snapshot().marks.find(e=>e.mark.pattern==='acid')!.mark.opacity).toBeCloseTo(c.rules[2]!.opacity/2);
  });
});
