import type {NodeId} from '@aether/scene';
export type CombatDecalPoint=[number,number,number];
export type CombatDecalFact=(
  | {event:'weapon-solid-impact';receiver:NodeId;point:CombatDecalPoint;normal:CombatDecalPoint;from:CombatDecalPoint;direction:CombatDecalPoint;weaponId:string}
  | {event:'npc-damage';point:CombatDecalPoint;slot:number;generation:number}
  | {event:'acid-land';point:CombatDecalPoint;slot:number;generation:number;radius:number;activeSec:number}
) & {seq:number;runId:number;tick:number};
export type CombatDecalInput=CombatDecalFact extends infer F?F extends CombatDecalFact?Omit<F,'seq'|'runId'>:never:never;
/** 有界事实日志与短命绘制效果分离；多固定步一帧也不会丢事件，槽位回收不改旧事实。 */
export class CombatDecalJournal {
  private rows:CombatDecalFact[]=[];private sequence=0;dropped=0;
  append(runId:number,fact:CombatDecalInput):void {
    if(this.rows.length===512){this.rows.shift();this.dropped++;}
    this.rows.push({...structuredClone(fact),seq:++this.sequence,runId} as CombatDecalFact);
  }
  after(seq:number):readonly CombatDecalFact[]{return this.rows.filter(e=>e.seq>seq).map(e=>structuredClone(e));}
  clear():void {this.rows=[];this.sequence=0;this.dropped=0;}
  get latest():number{return this.sequence;}
}
