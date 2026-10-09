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
