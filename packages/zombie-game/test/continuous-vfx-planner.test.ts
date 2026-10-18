import {it,expect} from 'vitest';
import {NPC_STATS} from '@aether/content';
import type {VfxAsset,SceneDocument} from '@aether/scene';
import {RuntimeSession,loadLevelRuntime} from '../src/index';
import {WeaponVfxPlanner} from '../src/presentation/vfx-planner';
import {EnemyVfxPlanner} from '../src/presentation/enemy-vfx-planner';
import {ContinuousVfxPlanner,CONTINUOUS_VFX_SLOTS} from '../src/presentation/continuous-vfx-planner';
const docs=import.meta.glob('../../../assets/scenes/sandbox/vfx-m2-pounce.scene.json',{eager:true,import:'default'}),assets=import.meta.glob('../../../assets/vfx/comic-motion.vfx.json',{eager:true,import:'default'}),weapons=import.meta.glob('../../../assets/weapons/prototype.weapons.json',{eager:true,import:'default'});
function fixture(){const doc=structuredClone(Object.values(docs)[0]) as SceneDocument,arsenal=(Object.values(weapons)[0] as any).arsenal??Object.values(weapons)[0];const rules=doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules')!;if(rules.kind==='RunRules')rules.arsenal=structuredClone(arsenal) as any;const r=new RuntimeSession({desc:loadLevelRuntime(doc).desc!,seed:1}),w=new WeaponVfxPlanner(),enemy=new EnemyVfxPlanner(w.pool),p=new ContinuousVfxPlanner(w),asset=Object.values(assets)[0] as VfxAsset;['flame','smoke','sparks','charge-dust','melee-arc'].forEach((key,i)=>p.bindings.set(CONTINUOUS_VFX_SLOTS[i]![0],asset.effects[key]!));return {r,w,enemy,p,update(){w.update(r);enemy.update(r,()=>true);p.update(r,enemy.frameEvents,()=>true);}};}
it('flame immutable facts survive multi ticks, release stops emission, same handle restarts, reset removes old run',()=>{
 const f=fixture();expect(f.r.equipWeapon('flame')).toBe(true);f.r.setAim(5,0);f.r.setFire(true);for(let i=0;i<24;i++)f.r.step();f.update();expect(f.p.recent.filter(e=>e.kind==='flame').length).toBeGreaterThan(1);expect(Object.isFrozen(f.p.recent[0]!.from)).toBe(true);expect(f.p.renderedWeapons.has('flame')).toBe(true);const h=f.p.emitters.activeHandles.find(h=>h.key.includes(':flame:'))!;expect(h).toBeTruthy();
 const spawned=f.p.emitters.stats.emitted;f.update();expect(f.p.emitters.stats.emitted).toBe(spawned);f.r.setFire(false);for(let i=0;i<12;i++)f.r.step();f.update();expect(f.p.emitters.activeHandles.some(h=>h.key.includes(':flame:'))).toBe(false);f.r.setFire(true);for(let i=0;i<4;i++)f.r.step();f.update();expect(f.p.emitters.stats.restarted).toBeGreaterThan(0);f.r.reset();f.update();expect(f.w.pool.active).toHaveLength(0);
});
it('charge consumes every actual move sample and melee swing does not invent a hit',()=>{
 const f=fixture(),r=f.r,actor={x:5,z:0,generation:1,radius:.4,hp:70},player={x:0,z:0,generation:1,radius:.35,hp:100},world={player:0,actor:(id:number)=>id===0?player:actor,damage:()=>{},move:(_id:number,x:number,z:number)=>[x,0,z] as [number,number,number],obstruction:()=>null};
 r.enemyAttacks.strike(1,actor,NPC_STATS.find(n=>n.id==='E-04')!.attack!,0,player,world);for(let i=0;i<9;i++)r.enemyAttacks.step(i,1/30,world);const events=r.enemyAttacks.drainEvents();expect(events.filter(e=>e.type==='move')).toHaveLength(9);Object.defineProperty(r,'tick',{value:9});f.p.update(r,events,()=>true);expect(f.w.pool.active.filter(p=>p.key.includes(':charge:')).length).toBeGreaterThan(9);expect(new Set(f.w.pool.active.map(p=>p.position[0])).size).toBeGreaterThan(3);
 r.enemyAttacks.strike(1,actor,{...NPC_STATS.find(n=>n.id==='E-01')!.attack!,kind:'melee',damage:1,rangeM:1,cdSec:1,windupSec:.1},9,player,world);const swing=r.enemyAttacks.drainEvents()[0]!;expect(swing.effect.hit).toBe(false);
});
