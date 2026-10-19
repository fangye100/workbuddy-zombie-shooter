import { describe,it,expect } from 'vitest';
import { EnemyAttacks,type EnemyAttackWorld } from '../src/enemy-attacks';
import { NPC_STATS } from '@aether/content';
function fixture() {
  const attacks=new EnemyAttacks();
  const actor={x:0,z:0,radius:.5,generation:1,hp:70};
  const player={x:6,z:0,radius:.35,generation:1,hp:100};
  const hits:{slot:number;amount:number;source:number}[]=[];
  let shooter=true;
  const world:EnemyAttackWorld={player:0,actor:slot=>slot===0?player:shooter?actor:null,
    damage:(slot,amount,source)=>{hits.push({slot,amount,source});if(slot===0)player.hp-=amount;},
    move:(_slot,x,z)=>{actor.x=x;actor.z=z;return [x,0,z];},obstruction:()=>null};
  return {attacks,actor,player,hits,world,killShooter:()=>{shooter=false;}};
}
describe('authored enemy attack mechanics',()=>{
  it('immutable phase/end facts survive catchup ticks and shooter slot reuse',()=>{
    const f=fixture(),a=NPC_STATS.find(s=>s.id==='E-03')!.attack!;f.attacks.beginRun(9);f.attacks.lock(1,1,6,0);f.attacks.strike(1,f.actor,a,0,f.player,f.world);
    f.actor.generation=2;for(let i=0;i<150;i++)f.attacks.step(i,1/30,f.world);
    const events=f.attacks.drainEvents();expect(events.map(e=>e.type)).toEqual(['spawn','phase','impact','end']);expect(events.every(e=>e.runId===9 && e.effect.generation===1)).toBe(true);expect(new Set(events.map(e=>e.effect.id)).size).toBe(1);expect(events[1]!.effect.phase).toBe('pool');expect(events[1]!.effect.position).toEqual([6,0,0]);expect(Object.isFrozen(events[1]!.effect.position)).toBe(true);expect(f.attacks.drainEvents()).toEqual([]);
  });
  it('blocked acid emits impact but never a pool phase',()=>{
    const f=fixture(),a=NPC_STATS.find(s=>s.id==='E-03')!.attack!;f.world.obstruction=()=>[1,.7,0];f.attacks.strike(1,f.actor,a,0,f.player,f.world);for(let i=0;i<40;i++)f.attacks.step(i,1/30,f.world);const events=f.attacks.drainEvents();expect(events.some(e=>e.type==='impact' && e.effect.blocked)).toBe(true);expect(events.some(e=>e.type==='phase')).toBe(false);
  });
  it('酸液真实落地只通知一次；被遮挡不通知，发射者死亡后仍保留落地点',()=>{
    const f=fixture(),a=NPC_STATS.find(s=>s.id==='E-03')!.attack!,landings:number[]=[];
    f.world.landed=(_e,tick)=>landings.push(tick);f.attacks.lock(1,1,6,0);f.attacks.strike(1,f.actor,a,0,f.player,f.world);f.killShooter();
    for(let i=0;i<145;i++)f.attacks.step(i,1/30,f.world);expect(landings).toEqual([24]);
    const blocked=fixture();blocked.world.landed=()=>landings.push(-1);blocked.world.obstruction=()=>[1,1,0];blocked.attacks.strike(1,blocked.actor,a,0,blocked.player,blocked.world);
    for(let i=0;i<145;i++)blocked.attacks.step(i,1/30,blocked.world);expect(landings).toEqual([24]);
  });
  it('acid flies to the locked target and applies 6 DPS only after landing for four seconds',()=>{
    const f=fixture(),a=NPC_STATS.find(s=>s.id==='E-03')!.attack!;
    f.attacks.lock(1,1,6,0);f.attacks.strike(1,f.actor,a,0,f.player,f.world);
    for(let i=0;i<24;i++)f.attacks.step(i,1/30,f.world);
    expect(f.hits).toHaveLength(0);expect(f.attacks.effects[0]!.phase).toBe('flight');
    f.killShooter(); // Acid already in flight survives despawn; no recycled source credit.
    for(let i=24;i<145;i++)f.attacks.step(i,1/30,f.world);
    expect(f.hits.reduce((n,h)=>n+h.amount,0)).toBeCloseTo(24,5);
    expect(f.hits.every(h=>h.source===-1)).toBe(true);expect(f.attacks.effects).toHaveLength(0);
  });
  it('moving away dodges the locked acid landing point',()=>{
    const f=fixture(),a=NPC_STATS.find(s=>s.id==='E-03')!.attack!;
    f.attacks.lock(1,1,6,0);f.attacks.strike(1,f.actor,a,0,f.player,f.world);f.player.z=4;
    for(let i=0;i<150;i++)f.attacks.step(i,1/30,f.world);
    expect(f.hits).toHaveLength(0);
  });
  it('a solid blocks the final flight segment and prevents a pool behind cover',()=>{
    const f=fixture(),a=NPC_STATS.find(s=>s.id==='E-03')!.attack!;
    f.attacks.lock(1,1,6,0);f.attacks.strike(1,f.actor,a,0,f.player,f.world);
    for(let i=0;i<24;i++)f.attacks.step(i,1/30,f.world);
    f.world.obstruction=()=>[5,.5,0];f.attacks.step(24,1/30,f.world);
    expect(f.attacks.effects[0]!.blocked).toBe(true);
    for(let i=25;i<150;i++)f.attacks.step(i,1/30,f.world);
    expect(f.hits).toHaveLength(0);
  });
  it('pounce travels at authored speed and damages at the landing rather than across a six metre wedge',()=>{
    const f=fixture(),a=NPC_STATS.find(s=>s.id==='E-02')!.attack!;
    f.attacks.lock(1,1,6,0);f.attacks.strike(1,f.actor,a,0,f.player,f.world);
    f.attacks.step(0,1/30,f.world);expect(f.hits).toHaveLength(0);
    f.attacks.step(10,1/30,f.world);expect(f.actor.x).toBeCloseTo(8/3);expect(f.hits).toHaveLength(0);
    for(let i=11;i<30;i++)f.attacks.step(i,1/30,f.world);
    expect(f.hits).toEqual([{slot:0,amount:18,source:1}]);expect(f.attacks.moving(1)).toBe(false);
  });
  it('charge damage occurs once along the path; obstacle stops the attacker',()=>{
    const f=fixture(),a=NPC_STATS.find(s=>s.id==='E-04')!.attack!;
    f.attacks.lock(1,1,6,0);f.attacks.strike(1,f.actor,a,0,f.player,f.world);f.player.x=3;
    for(let i=0;i<38;i++)f.attacks.step(i,1/30,f.world);
    expect(f.hits).toHaveLength(1);expect(f.hits[0]!.amount).toBe(12);
    const blocked=fixture();blocked.world.obstruction=()=>[1,.7,0];blocked.attacks.lock(1,1,6,0);
    blocked.attacks.strike(1,blocked.actor,a,0,blocked.player,blocked.world);blocked.attacks.step(1,1/30,blocked.world);
    expect(blocked.attacks.moving(1)).toBe(false);expect(blocked.hits).toHaveLength(0);
  });
  it('a recycled movement slot cannot continue the old attack; reset clears effects and locks',()=>{
    const f=fixture(),a=NPC_STATS.find(s=>s.id==='E-02')!.attack!;
    f.attacks.lock(1,1,6,0);f.attacks.strike(1,f.actor,a,0,f.player,f.world);f.actor.generation++;
    expect(f.attacks.moving(1,2)).toBe(false);
    f.attacks.step(1,1/30,f.world);expect(f.attacks.effects).toHaveLength(0);
    f.attacks.lock(1,2,6,0);f.attacks.clear();expect(f.attacks.target(1,2)).toBeUndefined();
  });
});

it('blocked pounce uses actual moved landing and scene ground receiver; dead explosion retains scene surface',()=>{
 const actor={x:0,z:0,radius:.4,generation:1,hp:70},player={x:6,z:0,radius:.35,generation:1,hp:100},attacks=new EnemyAttacks();
 const world:EnemyAttackWorld={player:0,actor:id=>id===0?player:actor,damage:()=>{},move:()=>[.7,0,0],obstruction:()=>[1,.7,0],surface:(from,to)=>{expect(from[1]).toBe(.2);expect(to[1]).toBe(-.2);return {nodeId:'nd_ground',normal:[0,1,0]};}};
 attacks.strike(1,actor,NPC_STATS.find(s=>s.id==='E-02')!.attack!,0,player,world);attacks.step(1,1/30,world);
 const impact=attacks.drainEvents().find(e=>e.type==='impact')!;expect(impact.effect.position).toEqual([.7,0,0]);expect(impact.effect.surface?.nodeId).toBe('nd_ground');expect(impact.effect.blocked).toBe(true);
 attacks.strike(1,actor,NPC_STATS.find(s=>s.id==='E-05')!.attack!,2,player,world);expect(attacks.drainEvents().find(e=>e.type==='impact')!.effect.surface?.nodeId).toBe('nd_ground');
});
