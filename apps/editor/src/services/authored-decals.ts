import {SceneGraph,VFX_VERSION,type SceneDocument,type VfxDecalComponent,type VfxEffectDefinition} from '@aether/scene';
import {VfxDecalPool} from '@aether/runtime';
import type {VfxPass,DecalReceiver} from '@aether/render';
import {readVfxAsset,readVfxTexture} from './vfx-assets';
/** Authored projector host: runtime owns lifetime, render owns projection/geometry. */
export class AuthoredDecals {
 readonly pool=new VfxDecalPool();readonly diagnostics:string[]=[];private generation=0;private run=-1;private pass:VfxPass|null=null;private doc:SceneDocument|null=null;
 private jobs:{id:string;effect:VfxEffectDefinition;component:VfxDecalComponent;matrix:Float32Array;started:boolean}[]=[];
 constructor(private readonly receivers:(doc:SceneDocument)=>readonly DecalReceiver[]){ }
 start(doc:SceneDocument,pass:VfxPass){this.clear();this.pass=pass;this.doc=doc;const generation=this.generation,graph=SceneGraph.fromDocument(doc);
  for(const n of doc.nodes)for(const c of n.components)if(c.kind==='VfxDecal' && c.enabled && c.playing && graph.isEffectivelyVisible(n.id))void(async()=>{try{const asset=await readVfxAsset(c.resource),effect=asset.effects[c.effectKey];if(effect?.kind!=='decal')throw new Error(n.id+': VfxDecal需要decal效果');if(asset.version<VFX_VERSION && generation===this.generation)this.diagnostics.push(n.id+': 兼容资源v'+asset.version+'，保存才升级');const bitmap=await readVfxTexture(effect.texture);try{if(generation!==this.generation)return;pass.addTexture(effect.texture.guid,bitmap);}finally{bitmap.close();}if(generation===this.generation)this.jobs.push({id:n.id,effect,component:structuredClone(c),matrix:graph.worldMatrix(n.id),started:false});}catch(e){if(generation===this.generation)this.diagnostics.push(String(e));}})();
 }
 update(tick:number,step:number,run:number){if(!this.pass || !this.doc)return;if(run!==this.run){this.pool.clear();for(const j of this.jobs)j.started=false;this.run=run;}this.pool.advance(tick,step);for(const j of this.jobs)if(!j.started){j.started=true;if(!this.pool.spawn({key:`author-decal:${run}:${j.id}`,effect:j.effect,matrix:j.matrix,receivers:j.component.receivers,layerMask:j.component.layerMask,priority:j.component.priority}))this.diagnostics.push(j.id+': 贴花实例预算拒绝');}this.pass.decals=this.pool.active;this.pass.receivers=this.receivers(this.doc);}
 snapshot(){return {ready:this.jobs.map(j=>j.id),pool:this.pool.snapshot(),diagnostics:[...this.diagnostics,...(this.pass?.decal?.snapshot().diagnostics??[])],gpu:this.pass?.decal?{...this.pass.decal.stats}:null};}
 clear(){this.generation++;this.pool.clear();this.jobs=[];this.diagnostics.length=0;this.pass=null;this.doc=null;this.run=-1;}
}
