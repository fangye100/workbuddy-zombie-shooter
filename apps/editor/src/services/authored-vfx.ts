import {SceneGraph,type SceneDocument,type VfxEffectDefinition} from '@aether/scene';
import {VfxEmitters,type VfxPool} from '@aether/runtime';
import {readVfxAsset,readVfxTexture} from './vfx-assets';
import type {VfxPass} from '@aether/render';
/** Host adapter for authored component transforms; generic runtime owns all particle clocks. */
export class AuthoredVfx {
 readonly emitters:VfxEmitters;readonly diagnostics:string[]=[];
 private jobs:{key:string;effect:VfxEffectDefinition;position:[number,number,number];direction:[number,number,number];normal:[number,number,number];seed:number}[]=[];
 private generation=0;private run=-1;
 constructor(pool:VfxPool){this.emitters=new VfxEmitters(pool);}
 start(doc:SceneDocument,pass:VfxPass):void{this.clear();const generation=this.generation,graph=SceneGraph.fromDocument(doc);
  for(const node of doc.nodes)for(const c of node.components)if(c.kind==='VfxEmitter' && c.enabled && c.playing && graph.isEffectivelyVisible(node.id))void(async()=>{try{
   const asset=await readVfxAsset(c.resource),effect=asset.effects[c.effectKey];if(!effect)throw new Error(`VFX发射器 ${node.id} 缺少 ${c.effectKey}`);const bitmap=await readVfxTexture(effect.texture);try{if(generation!==this.generation)return;pass.addTexture(effect.texture.guid,bitmap);}finally{bitmap.close();}
   if(generation!==this.generation)return;const m=graph.worldMatrix(node.id),d=c.direction,direction:[number,number,number]=[m[0]!*d[0]+m[4]!*d[1]+m[8]!*d[2],m[1]!*d[0]+m[5]!*d[1]+m[9]!*d[2],m[2]!*d[0]+m[6]!*d[1]+m[10]!*d[2]];
   this.jobs.push({key:node.id,effect,position:[...graph.getNode(node.id)!.world.position],direction,normal:[m[4]!,m[5]!,m[6]!],seed:c.seed});
  }catch(e){if(generation===this.generation)this.diagnostics.push(String(e));}})();
 }
 update(tick:number,step:number,runId:number){if(this.run!==runId){this.emitters.clear();this.run=runId;}for(const j of this.jobs)this.emitters.update(`author:${runId}:${j.key}`,j.effect,{position:j.position,direction:j.direction,normal:j.normal},tick,step,j.seed);}
 snapshot(){return {ready:this.jobs.map(j=>j.key),handles:this.emitters.activeHandles,stats:{...this.emitters.stats},diagnostics:[...this.diagnostics]};}
 clear(){this.generation++;this.jobs=[];this.emitters.clear();this.diagnostics.length=0;this.run=-1;}
}
