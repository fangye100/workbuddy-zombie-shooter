import type { AudioBinding, GameplayAudioConfig } from '@aether/scene';
import { NPC_STATS } from '@aether/content';
import type { RuntimeSession } from './session';

export interface AudioRequest { key:string; binding:AudioBinding; position:[number,number,number]|null }
export interface AudioFrame { shots:AudioRequest[]; loops:AudioRequest[] }

/** Presentation event projection. No audio API, damage, hooks or simulation writes. */
export class AudioFramePlanner {
  private run=-1;
  private consumedTick=0;
  private seen=new Set<string>();
  private windups=new Set<string>();
  reset():void {this.run=-1;this.consumedTick=0;this.seen.clear();this.windups.clear();}
  update(r:RuntimeSession,config:GameplayAudioConfig,paused:boolean):AudioFrame {
    if(r.runId!==this.run){this.reset();this.run=r.runId;}
    const frame:AudioFrame={shots:[],loops:[]},active=!paused && r.outcome==='running';
    // A lethal shot may open the growth choice in this same step. Preserve its
    // one-shot feedback; sustained loops and fresh enemy warnings freeze.
    const continuous=active && !r.progress?.choosing;
    const t=r.table,player=r.player(),tick=this.consumedTick;
    const edge=(key:string,eventTick:number,b:AudioBinding|null|undefined,pos:AudioRequest['position'])=>{
      if(eventTick<tick || this.seen.has(key))return;
      this.seen.add(key);if(active && b)frame.shots.push({key,binding:b,position:pos});
    };
    for(const e of r.weapons.events)if(e.action==='fire')edge(`weapon:${e.sequence}`,e.tick,config.weapons[e.weaponId]?.fire,r.weaponMount.position);
    for(const e of r.combatEvents){
      // Correlate actual player damage with a direct-contact presentation fact.
      // Continuous burn ticks without a new contact never produce flesh thwacks.
      if(!['damage','kill'].includes(e.type) || e.runId!==r.runId || e.amount<=0 || e.slot===r.playerEntityId || e.sourceSlot!==r.playerEntityId)continue;
      const contact=r.weaponCombat.effects.some(f=>f.tick===e.tick && f.hit && ['shot','pellet','pierce','slash','flame'].includes(f.kind));
      if(contact)edge(`hit:${e.tick}:${e.slot}:${e.generation}`,e.tick,config.fleshHit,[e.x??player?.x??0,(e.y??player?.y??0)+1,e.z??player?.z??0]);
    }
    const windups=new Set<string>();
    for(let slot=0;slot<t.capacity;slot++)if(t.isAlive(slot) && slot!==r.playerEntityId && t.behavior[slot]===2){
      const key=`warn:${slot}:${t.generation[slot]}`;windups.add(key);
      if(!this.windups.has(key) && player && Math.hypot(t.posX[slot]!-player.x,t.posZ[slot]!-player.z)<=config.warningDistanceM){
        const id=NPC_STATS.find(s=>s.defId===t.defId[slot])?.id;
        if(continuous && id && config.warnings[id])frame.shots.push({key:`${key}:${r.tick}`,binding:config.warnings[id]!,position:[t.posX[slot]!,t.posY[slot]!+1,t.posZ[slot]!]});
      }
    }
    this.windups=windups;
    for(const e of r.enemyAttacks.effects)if(e.kind==='acid' && !e.blocked){
      const key=`acid:${e.source}:${e.generation}:${e.startTick}`;
      if(e.phase==='flight')edge(key,e.startTick,config.acidLaunch,e.from);
      if(continuous && e.phase==='pool' && config.acidPool)frame.loops.push({key,binding:config.acidPool,position:[...e.position]});
    }
    if(continuous){
      if(config.ambience)frame.loops.push({key:'ambience',binding:config.ambience,position:null});
      const loop=config.weapons[r.weapons.active.id]?.loop;
      if(loop && r.firing && r.weapons.animation.action==='fire')frame.loops.push({key:`held:${r.weapons.active.id}`,binding:loop,position:r.weaponMount.position});
    }
    // Retain only current-tick edges. consumedTick prevents replay of old ring entries.
    if(r.tick!==this.consumedTick){this.seen.clear();this.consumedTick=r.tick;}
    return frame;
  }
}
