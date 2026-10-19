import {RibbonHistory,type RibbonTrail} from '@aether/runtime';
import type {VfxEffectDefinition} from '@aether/scene';
import type {RuntimeSession} from '../session';import type {EnemyAttackEvent} from '../enemy-attacks';import type {MotionVfxFrame} from '../motion-vfx-frames';
export const RIBBON_VFX_SLOTS=[['actor.player.ribbon','玩家连续Ribbon'],['enemy.charge.ribbon','冲锋连续Ribbon']] as const;
/** Real immutable motion → generic history. Does not simulate trajectories or damage. */
export class RibbonVfxPlanner {
 readonly bindings=new Map<string,VfxEffectDefinition>();readonly recent:MotionVfxFrame[]=[];readonly renderedEnemies=new Set<number>();readonly stats={factLoss:0,fallback:0};private run=-1;private dropped=0;
 constructor(readonly history:RibbonHistory){}
 update(runtime:RuntimeSession,events:readonly EnemyAttackEvent[],canDraw:(t:RibbonTrail)=>boolean){const now=Math.max(0,runtime.tick-1),step=runtime.fixedStep;if(this.run!==runtime.runId){this.history.clear();this.recent.length=0;this.run=runtime.runId;this.dropped=0;}this.history.advance(now,step);this.renderedEnemies.clear();this.stats.fallback=0;
  const loss=runtime.motionVfxFrames.dropped+runtime.enemyAttacks.droppedEvents;if(loss>this.dropped){for(const key of this.history.keys)if(key.startsWith(`${runtime.runId}:player-ribbon:`) || key.startsWith(`${runtime.runId}:charge-ribbon:`))this.history.disconnect(key);this.stats.factLoss+=loss-this.dropped;}this.dropped=loss;const keep=new Set<string>();
  for(const f of runtime.motionVfxFrames.drain()){if(f.runId!==runtime.runId)continue;this.recent.push(f);if(this.recent.length>64)this.recent.shift();const key=`${f.runId}:player-ribbon:${f.id}:${f.generation}`,effect=this.bindings.get('actor.player.ribbon');if(!f.alive){this.history.stop(key);continue;}if(effect?.kind==='ribbon'){if(!this.history.push(key,effect,f.position,f.tick,step,now))this.stats.fallback++;}}
  const p=runtime.player();if(p)keep.add(`${runtime.runId}:player-ribbon:${p.id}:${p.generation}`);
  for(const event of events){const e=event.effect;if(event.runId!==runtime.runId || e.kind!=='charge')continue;const key=`${runtime.runId}:charge-ribbon:${e.id}:${e.source}:${e.generation}`,effect=this.bindings.get('enemy.charge.ribbon');if(event.type==='move' && effect?.kind==='ribbon'){if(!this.history.push(key,effect,e.position,event.tick,step,now))this.stats.fallback++;}if(event.type==='end'){this.history.stop(key);keep.delete(key);}}
  for(const e of runtime.enemyAttacks.effects)if(e.kind==='charge' && !e.finished){const key=`${runtime.runId}:charge-ribbon:${e.id}:${e.source}:${e.generation}`;keep.add(key);const trail=this.history.active.find(t=>t.key===key);
   // Old tails may still draw after a gap. Only the latest connected edge can replace current charge ink.
   if(trail && !trail.gap && !trail.points.at(-1)!.breakBefore && canDraw({...trail,points:trail.points.slice(-2)}))this.renderedEnemies.add(e.id);}
  for(const key of this.history.keys)if(!key.startsWith('author:') && !keep.has(key))this.history.stop(key);
 }
 clear(){this.history.clear();this.bindings.clear();this.recent.length=0;this.renderedEnemies.clear();this.stats.factLoss=this.stats.fallback=0;this.run=-1;this.dropped=0;}
 snapshot(){return {...this.history.snapshot(),ready:[...this.bindings.keys()],facts:[...this.recent],stats:{...this.stats,...this.history.stats}};}
}
