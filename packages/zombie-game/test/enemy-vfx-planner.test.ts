import {it,expect} from 'vitest';
import {NPC_STATS} from '@aether/content';
import {VfxPool} from '@aether/runtime';
import type {VfxAsset} from '@aether/scene';
import {EnemyAttacks,type EnemyAttackWorld} from '../src/enemy-attacks';
import type {RuntimeSession} from '../src/session';
import {EnemyVfxPlanner,ENEMY_VFX_SLOTS} from '../src/presentation/enemy-vfx-planner';
const assets=import.meta.glob('../../../assets/vfx/comic-enemies.vfx.json',{eager:true,import:'default'});
function fixture(capacity=256){const attacks=new EnemyAttacks();attacks.beginRun(1);let tick=0;const pool=new VfxPool(capacity),planner=new EnemyVfxPlanner(pool),asset=Object.values(assets)[0] as VfxAsset;
 const keys=['acid-flight','acid-land','acid-pool','acid-blocked','explode','pounce-impact','ground-mark'];ENEMY_VFX_SLOTS.forEach(([tag],i)=>planner.bindings.set(tag,asset.effects[keys[i]!]!));
 const actor={x:0,z:0,generation:1,radius:.4,hp:70},player={x:6,z:0,generation:1,radius:.35,hp:100};let source=true;
 const world:EnemyAttackWorld={player:0,actor:id=>id===0?player:source?actor:null,damage:(id,amount)=>{if(id===0)player.hp-=amount;else source=false;},move:(_id,x,z)=>{actor.x=x;actor.z=z;return [x,0,z];},obstruction:()=>null};
 const runtime={runId:1,get tick(){return tick;},fixedStep:1/30,enemyAttacks:attacks} as RuntimeSession;
 return {attacks,actor,player,world,pool,planner,runtime,step(n:number){for(let i=0;i<n;i++){attacks.step(tick,1/30,world);pool.advance(1/30);tick++;}},update:(draw=(x:unknown)=>!!x)=>planner.update(runtime,draw)};
}
it('flight→pool uses actual phase, diameter and end independent of animation duration; catchup does not miss landing',()=>{
 const f=fixture();f.attacks.lock(1,1,6,0);f.attacks.strike(1,f.actor,NPC_STATS.find(n=>n.id==='E-03')!.attack!,0,f.player,f.world);f.step(5);f.update();expect(f.pool.active.find(p=>p.key.endsWith('enemy.acid.flight'))?.position).toEqual(f.attacks.effects[0]!.position);
 f.step(21);f.actor.generation=2;f.update();const p=f.pool.active.find(p=>p.key.endsWith('enemy.acid.pool'))!;expect(p.effect.size).toEqual([4,4]);expect(p.lifetime).toBeCloseTo(4);expect(p.effect.duration).toBe(.6);expect(f.planner.rendered.has(1)).toBe(true);const spawned=f.pool.stats.spawned;f.update();expect(f.pool.stats.spawned).toBe(spawned);
 f.step(125);f.update();expect(f.pool.active.some(p=>p.key.endsWith('enemy.acid.pool'))).toBe(false);expect(f.planner.recentEvents.some(e=>e.type==='phase' && e.effect.generation===1)).toBe(true);
});
it('budget or texture rejection keeps per-handle fallback and never claims a dangerous pool was rendered',()=>{
 const f=fixture(1);f.attacks.strike(1,f.actor,NPC_STATS.find(n=>n.id==='E-03')!.attack!,0,f.player,f.world);f.step(26);
 const effect=(Object.values(assets)[0] as VfxAsset).effects['ground-mark']!;f.pool.spawn({key:'reserved',effect,position:[0,0,0],seed:0,priority:30,lifetime:100});f.update();expect(f.planner.rendered.size).toBe(0);expect(f.planner.stats.fallback).toBe(1);expect(f.pool.stats.dropped).toBeGreaterThan(0);
 f.pool.clear();f.update(()=>false);expect(f.planner.rendered.size).toBe(0);expect(f.planner.stats.fallback).toBe(1);
});
it('blocked acid never plans a pool; pounce and self-explosion use immutable actual impacts',()=>{
 const f=fixture();f.world.obstruction=()=>[1,.5,0];f.attacks.strike(1,f.actor,NPC_STATS.find(n=>n.id==='E-03')!.attack!,0,f.player,f.world);f.step(2);f.update();expect(f.pool.active.some(p=>p.key.endsWith('enemy.acid.pool'))).toBe(false);
 const p=fixture();p.attacks.strike(1,p.actor,NPC_STATS.find(n=>n.id==='E-02')!.attack!,0,p.player,p.world);p.step(24);p.update();expect(p.pool.active.find(i=>i.key.endsWith('enemy.pounce.impact'))?.position).toEqual([6,0,0]);
 const e=fixture();e.attacks.strike(1,e.actor,NPC_STATS.find(n=>n.id==='E-05')!.attack!,0,e.player,e.world);e.actor.x=99;e.update();expect(e.pool.active.find(i=>i.key.endsWith('enemy.explode'))?.position).toEqual([0,0,0]);
});
