import type { WeaponAction, WeaponArsenal, WeaponDefinition } from '@aether/scene';

export interface WeaponState { id: string; magazine: number; reserve: number; level: number }
export interface WeaponCarry { equipped: string; states: WeaponState[] }
export interface WeaponEvent { sequence: number; tick: number; weaponId: string; action: WeaponAction | 'upgraded' | 'reload-complete' | 'equipped'; clip: string | null }
export type ReloadStage='magazine-out'|'magazine-in'|'chamber';
export interface WeaponHookPayload { event:Readonly<WeaponEvent>; definition:Readonly<WeaponDefinition>; markers:WeaponDefinition['presentation']['markers']; stage?:ReloadStage }
export interface WeaponAnimationHooks { onFire?(payload:WeaponHookPayload):void; onReload?(payload:WeaponHookPayload):void; onEquip?(payload:WeaponHookPayload):void; onUnequip?(payload:WeaponHookPayload):void; onReloadStage?(payload:WeaponHookPayload):void }
export interface WeaponAnimation { action: WeaponAction; weaponId: string; clip: string; fallback: string; phase: number; startTick: number }

/** Owns equipment, ammunition and action timing. Combat strategies never own a second magazine. */
export class WeaponSystem {
  readonly events: WeaponEvent[]=[];
  readonly states=new Map<string,WeaponState>();
  readonly definitions: readonly WeaponDefinition[];
  equippedId: string;
  private pendingId: string | null=null;
  private switchRemaining=0;
  reloadRemaining=0;
  private fireUntil=0;
  private firedAt=-Infinity;
  private nextFireAt=0;
  private tick=0;
  private now=0;
  private sequence=0;
  private actionStart=0;
  private switchEquipEmitted=false;
  private hooks:WeaponAnimationHooks={};
  readonly hookErrors:string[]=[];
  private reloadStages=new Set<ReloadStage>();
  constructor(readonly config: WeaponArsenal){
    this.definitions=structuredClone(config.definitions);this.equippedId=config.equipped;
    for(const w of this.definitions)this.states.set(w.id,{id:w.id,magazine:w.ammo.magazineSize,reserve:w.ammo.reserveRounds,level:1});
  }
  get active(): WeaponDefinition { return this.definitions.find(w=>w.id===this.equippedId)!; }
  get state(): WeaponState { return this.states.get(this.equippedId)!; }
  get switching(): boolean { return this.pendingId!==null; }
  get capacity(): number { return this.active.ammo.magazineSize+(this.state.level-1)*this.active.upgrades.magazineStep; }
  get damageMultiplier(): number {return 1+(this.state.level-1)*this.active.upgrades.damageStep;}
  get hasteMultiplier(): number {return 1+(this.state.level-1)*this.active.upgrades.hasteStep;}
  get upgradeCost(): number | null {return this.state.level>=this.active.upgrades.maxLevel?null:this.active.upgrades.baseCost+(this.state.level-1)*this.active.upgrades.costStep;}
  get animation(): WeaponAnimation {
    let action:WeaponAction='idle',phase=0,def=this.active;
    if(this.switching){const half=this.config.switchSec/2;if(this.switchRemaining>half){action='unequip';phase=1-(this.switchRemaining-half)/half;}else {action='equip';def=this.definitions.find(w=>w.id===this.pendingId)!;phase=1-this.switchRemaining/half;}}
    else if(this.reloadRemaining>0){action='reload';phase=1-this.reloadRemaining/this.active.ammo.reloadSec;}
    else if(this.now<this.fireUntil){action='fire';phase=1-(this.fireUntil-this.now)/Math.min(.25,this.active.cooldownSec);}
    const a=def.presentation.animations[action];return {action,weaponId:def.id,clip:a.clip,fallback:a.fallback,phase:Math.max(0,Math.min(1,phase)),startTick:this.actionStart};
  }
  setAnimationHooks(hooks:WeaponAnimationHooks):void {this.hooks=hooks;}
  /** Consumer maps local targets to HumanIK and blends them over authored FBX. No rig mutation here. */
  get poseIntent() {
    const a=this.animation,def=this.definitions.find(w=>w.id===a.weaponId)!,p=def.presentation.procedural;
    const elapsed=Math.max(0,this.now-this.firedAt);
    const recoil=!this.switching && elapsed<p.recoilSec?Math.sin(Math.PI*elapsed/p.recoilSec):0;
    return {weaponId:def.id,action:a.action,phase:a.phase,markers:structuredClone(def.presentation.markers),
      recoil:{translation:[-p.recoilM*recoil,0,0] as [number,number,number],pitchDeg:p.recoilPitchDeg*recoil},
      reload:{leftHandTarget:a.action==='reload' && a.phase>=p.magazineOutPhase && a.phase<p.chamberPhase?'magazine':a.action==='reload' && a.phase>=p.chamberPhase?'chamber':'supportGrip',phase:a.phase}};
  }
  private emit(action:WeaponEvent['action'],id=this.equippedId):void {
    const def=this.definitions.find(w=>w.id===id)!;
    const clip=action in def.presentation.animations?def.presentation.animations[action as WeaponAction].clip:null;
    this.events.push({sequence:++this.sequence,tick:this.tick,weaponId:id,action,clip});
    if(this.events.length>64)this.events.shift();
    const callback=action==='fire'?this.hooks.onFire:action==='reload'?this.hooks.onReload:action==='equip'?this.hooks.onEquip:action==='unequip'?this.hooks.onUnequip:null;
    if(callback)this.callHook(callback,{event:{...this.events[this.events.length-1]!},definition:structuredClone(def),markers:structuredClone(def.presentation.markers)});
  }
  private callHook(fn:(p:WeaponHookPayload)=>void,payload:WeaponHookPayload):void {try{fn(payload);}catch(e){this.hookErrors.push(String(e));if(this.hookErrors.length>16)this.hookErrors.shift();}}
  equip(id:string):boolean {
    if(!this.states.has(id) || this.switching || id===this.equippedId)return false;
    this.reloadRemaining=0;this.fireUntil=0;this.pendingId=id;this.switchRemaining=this.config.switchSec;this.actionStart=this.tick;this.switchEquipEmitted=false;this.emit('unequip');return true;
  }
  advance(dt:number,tick=this.tick+1):void {
    this.tick=tick;this.now+=dt;
    if(this.switching){
      this.switchRemaining=Math.max(0,this.switchRemaining-dt);
      if(!this.switchEquipEmitted && this.switchRemaining<=this.config.switchSec/2){this.switchEquipEmitted=true;this.actionStart=tick;this.emit('equip',this.pendingId!);}
      if(this.switchRemaining<1e-9){this.switchRemaining=0;this.equippedId=this.pendingId!;this.pendingId=null;this.nextFireAt=this.now;this.emit('equipped');}return;
    }
    if(this.reloadRemaining>0){
      this.reloadRemaining=Math.max(0,this.reloadRemaining-dt);
      const phase=1-this.reloadRemaining/this.active.ammo.reloadSec,proc=this.active.presentation.procedural;
      for(const [stage,at] of [['magazine-out',proc.magazineOutPhase],['magazine-in',proc.magazineInPhase],['chamber',proc.chamberPhase]] as const)if(phase>=at && !this.reloadStages.has(stage)){
        this.reloadStages.add(stage);const event:WeaponEvent={sequence:++this.sequence,tick,weaponId:this.equippedId,action:'reload',clip:this.active.presentation.animations.reload.clip};
        if(this.hooks.onReloadStage)this.callHook(this.hooks.onReloadStage,{event,definition:structuredClone(this.active),markers:structuredClone(this.active.presentation.markers),stage});
      }
      if(this.reloadRemaining<1e-9){
        this.reloadRemaining=0;const n=Math.min(this.capacity-this.state.magazine,this.state.reserve,this.active.ammo.reloadMode==='shell'?1:Infinity);
        this.state.magazine+=n;this.state.reserve-=n;this.emit('reload-complete');
        if(this.active.ammo.reloadMode==='shell')this.reload();
      }
    }
  }
  reload():boolean {
    if(this.switching || this.reloadRemaining>0 || this.active.ammo.reloadMode==='none' || this.state.magazine>=this.capacity || this.state.reserve<=0)return false;
    this.reloadRemaining=this.active.ammo.reloadSec;this.actionStart=this.tick;this.reloadStages.clear();this.emit('reload');return true;
  }
  consumeRound():boolean {
    if(this.switching)return false;
    if(this.reloadRemaining>0){if(this.active.ammo.reloadMode!=='shell' || this.state.magazine<this.active.ammo.perShot)return false;this.reloadRemaining=0;}
    if(this.active.ammo.reloadMode==='none')return true;
    if(this.state.magazine<this.active.ammo.perShot){this.reload();return false;}
    this.state.magazine-=this.active.ammo.perShot;return true;
  }
  beginFire(haste=1):boolean {
    if(this.now+1e-9<this.nextFireAt || !this.consumeRound())return false;
    this.nextFireAt=this.now+this.active.cooldownSec/(Math.max(.1,haste)*this.hasteMultiplier);
    this.firedAt=this.now;this.fireUntil=this.now+Math.min(.25,this.active.cooldownSec);this.actionStart=this.tick;this.emit('fire');return true;
  }
  upgrade(pay:(cost:number)=>boolean):boolean {
    const cost=this.upgradeCost;if(cost===null || this.switching || this.reloadRemaining>0 || !pay(cost))return false;
    this.state.level++;this.emit('upgraded');return true;
  }
  snapshot():WeaponCarry {return {equipped:this.equippedId,states:[...this.states.values()].map(s=>({...s}))};}
  validCarry(value:unknown):value is WeaponCarry {
    if(!value || typeof value!=='object')return false;const c=value as WeaponCarry;
    if(!this.states.has(c.equipped) || !Array.isArray(c.states) || c.states.length!==this.states.size || new Set(c.states.map(s=>s?.id)).size!==this.states.size)return false;
    return c.states.every(s=>{const w=this.definitions.find(w=>w.id===s?.id);return !!w && Number.isInteger(s.level) && s.level>=1 && s.level<=w.upgrades.maxLevel && Number.isInteger(s.magazine) && s.magazine>=0 && s.magazine<=w.ammo.magazineSize+(s.level-1)*w.upgrades.magazineStep && Number.isSafeInteger(s.reserve) && s.reserve>=0 && s.reserve<=10000000;});
  }
  restore(c:WeaponCarry):boolean {
    if(!this.validCarry(c))return false;this.equippedId=c.equipped;for(const s of c.states)this.states.set(s.id,{...s});
    this.pendingId=null;this.reloadRemaining=0;this.nextFireAt=this.now;this.fireUntil=0;this.firedAt=-Infinity;this.events.length=0;return true;
  }
}
