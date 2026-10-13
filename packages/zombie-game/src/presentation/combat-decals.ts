import {DecalPool,type RuntimeDecal} from '@aether/render';
import type {DecalEmitterComponent,DecalEventRule} from '@aether/scene';
import type {CombatDecalFact,CombatDecalJournal} from '../combat-decals';
export type CombatDecalSurface=Pick<RuntimeDecal,'receiver'> & Pick<RuntimeDecal['mark'],'position'|'rotation'|'size'>;
export type CombatDecalProjector=(fact:CombatDecalFact,rule:DecalEventRule,config:DecalEmitterComponent)=>CombatDecalSurface|null;
export const COMBAT_DECAL_EVENTS=['weapon-solid-impact','npc-damage','acid-land'] as const;
/** 游戏表现策略：读事实、找接收面、配规则；不改变伤害/寻路/作者场景。 */
export class CombatDecalPlanner {
  private cursor=0;private cooldowns=new Map<string,number>();
  readonly counts={emitted:0,noSurface:0,throttled:0,expired:0,budgetDropped:0,ruleEvicted:0,journalDropped:0,unknownRules:0};
  constructor(readonly config:DecalEmitterComponent|null){this.counts.unknownRules=config?.rules.filter(r=>!(COMBAT_DECAL_EVENTS as readonly string[]).includes(r.event)).length??0;}
  consume(journal:CombatDecalJournal,runId:number,now:number,dt:number,pool:DecalPool,project:CombatDecalProjector):void {
    const facts=journal.after(this.cursor);this.cursor=journal.latest;this.counts.journalDropped=journal.dropped;
    if(!this.config?.enabled)return;
    for(const [key,until]of this.cooldowns)if(until<=now)this.cooldowns.delete(key);
    let budget=this.config.maxPerFrame;
    for(const fact of facts){if(fact.runId!==runId)continue;
      for(const rule of this.config.rules){if(rule.event!==fact.event)continue;
        if(budget--<=0){this.counts.budgetDropped++;continue;}
        const born=fact.tick*dt,elapsed=Math.max(0,now-born),ttl=fact.event==='acid-land'?Math.min(120,Math.max(rule.ttlSec,fact.activeSec+rule.fadeSec)):rule.ttlSec;
        if(elapsed>=ttl){this.counts.expired++;continue;}
        const identity=fact.event==='weapon-solid-impact'?fact.receiver:`${fact.slot}-${fact.generation}`,key=`${rule.id}:${identity}`;
        if((this.cooldowns.get(key)??-1)>born){this.counts.throttled++;continue;}
        const surface=project(fact,rule,this.config);if(!surface){this.counts.noSurface++;continue;}
        const prefix=`combat_${rule.id}_`,matching=pool.snapshot().marks.filter(e=>e.mark.id.startsWith(prefix)&&/^\d+$/.test(e.mark.id.slice(prefix.length)));
        if(matching.length>=rule.maxAlive){pool.remove(matching[0]!.receiver,matching[0]!.mark.id);this.counts.ruleEvicted++;}
        pool.emit({receiver:surface.receiver,ttlSec:ttl,fadeSec:rule.fadeSec,mark:{position:surface.position,rotation:surface.rotation,size:surface.size,id:`${prefix}${fact.seq}`,pattern:rule.pattern,color:rule.color,opacity:rule.opacity,seed:(fact.seq*137+fact.tick*31)&65535,normalOffset:rule.normalOffset,priority:fact.event==='acid-land'?2:1,...(rule.style?{style:{...rule.style}}:{})}},elapsed);
        this.counts.emitted++;if(rule.cooldownSec>0)this.cooldowns.set(key,born+rule.cooldownSec);
      }
    }
  }
  clear():void {this.cooldowns.clear();}
  snapshot(){return {...this.counts,cursor:this.cursor};}
}
