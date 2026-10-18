import {VfxPool,type VfxRequest,type VfxInstance} from '@aether/runtime';
import type {VfxEffectDefinition} from '@aether/scene';
import type {RuntimeSession} from '../session';
import type {EnemyAttackEffect,EnemyAttackEvent} from '../enemy-attacks';

/** Game meaning stays here; framework bindings treat these as opaque tags. */
export const ENEMY_VFX_SLOTS=[
 ['enemy.acid.flight','酸液飞行'],['enemy.acid.land','酸液落地'],['enemy.acid.pool','酸池危险区'],['enemy.acid.blocked','酸液被挡'],['enemy.explode','自爆'],['enemy.pounce.impact','突扑落点'],['enemy.mark','装饰平面痕迹'],
] as const;
export class EnemyVfxPlanner {
 readonly bindings=new Map<string,VfxEffectDefinition>();
 readonly rendered=new Set<number>();
 frameEvents:readonly EnemyAttackEvent[]=[];
 readonly recentEvents:EnemyAttackEvent[]=[];
 readonly stats={fallback:0,eventDrops:0};
 private run=-1;private handles=new Set<string>();
 constructor(readonly pool:VfxPool){}
 private key(e:Readonly<EnemyAttackEffect>,part:string){return `enemy:${e.runId}:${e.id}:${part}`;}
 private request(e:Readonly<EnemyAttackEffect>,tag:string,key:string):VfxRequest|null{
  const effect=this.bindings.get(tag);if(!effect)return null;
  const ground=effect.orientation==='surface';if(ground && !e.surface)return null;
  const radiusDriven=tag==='enemy.acid.pool' || tag==='enemy.pounce.impact' || tag==='enemy.explode';
  return {key,effect:{...effect,...(radiusDriven?{size:[e.radius*2,e.radius*2] as [number,number]}:{})},position:[...e.position],...(ground?{normal:e.surface!.normal}:{}),seed:e.id,priority:tag==='enemy.acid.pool'?20:tag==='enemy.mark'?0:5};
 }
 update(runtime:RuntimeSession,canDraw:(p:VfxInstance)=>boolean):void{
  if(this.run!==runtime.runId){for(const key of this.handles)this.pool.stop(key);this.handles.clear();this.recentEvents.length=0;this.run=runtime.runId;}
  this.rendered.clear();this.stats.fallback=0;this.stats.eventDrops=runtime.enemyAttacks.droppedEvents;
  const tick=Math.max(0,runtime.tick-1),step=runtime.fixedStep;
  this.frameEvents=runtime.enemyAttacks.drainEvents();
  for(const event of this.frameEvents){
   this.recentEvents.push(event);if(this.recentEvents.length>32)this.recentEvents.shift();const e=event.effect;
   const tag=event.type==='impact'?e.kind==='acid'?e.blocked?'enemy.acid.blocked':'enemy.acid.land':e.kind==='explode'?'enemy.explode':e.kind==='pounce'?'enemy.pounce.impact':null:event.type==='end' && e.surface && (e.kind==='pounce' || e.kind==='explode' || e.kind==='acid' && e.phase==='pool')?'enemy.mark':null;
   if(!tag)continue;const request=this.request(e,tag,this.key(e,tag));if(!request)continue;
   const age=Math.max(0,tick-event.tick)*step;
   if(age<request.effect.duration){this.pool.spawn(request);const instance=this.pool.active.find(p=>p.key===request.key);if(instance)instance.age=age;}
  }
  const next=new Set<string>();
  for(const e of runtime.enemyAttacks.effects){
   if(!['acid','pounce','explode'].includes(e.kind))continue;
   let key:string|null=null;
   if(e.kind==='acid' && !e.blocked){
    const tag=e.phase==='pool'?'enemy.acid.pool':'enemy.acid.flight';key=this.key(e,tag);next.add(key);
    const request=this.request(e,tag,key),phaseAge=Math.max(0,tick-e.phaseTick)*step,lifetime=e.duration-(e.phaseTick-e.startTick)*step;
    if(request)this.pool.upsert({...request,lifetime:e.phase==='flight'?e.flightSeconds:lifetime},phaseAge);
   }else if(e.kind==='acid' && e.blocked)key=this.key(e,'enemy.acid.blocked');
   else if(e.kind==='explode')key=this.key(e,'enemy.explode');
   else if(e.finished)key=this.key(e,'enemy.pounce.impact');
   const instance=key?this.pool.active.find(p=>p.key===key):null;
   if(instance && canDraw(instance))this.rendered.add(e.id);else this.stats.fallback++;
  }
  for(const key of this.handles)if(!next.has(key))this.pool.stop(key);this.handles=next;
 }
 clear():void{for(const key of this.handles)this.pool.stop(key);this.handles.clear();this.bindings.clear();this.rendered.clear();this.recentEvents.length=0;this.frameEvents=[];this.run=-1;this.stats.fallback=this.stats.eventDrops=0;}
}
