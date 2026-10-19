import {SceneGraph,cpuVfxCompatibility,type AssetRef,type SceneDocument,type VfxAsset,type VfxEffectDefinition} from '@aether/scene';
import {VfxEmitters,VfxPool} from '@aether/runtime';
import {VfxPass,type RendererCore} from '@aether/render';
import {readVfxAssetSource,readVfxTexture} from './vfx-assets';
import {vfxAuthorAnchor} from './vfx-author-anchor';

/** Preview owns its actual GPU allocations; Play uses the existing AuthoredVfx adapter. */
export class VfxGraphPreview {
 private pass:VfxPass|null=null;private generation=0;private accumulator=0;
 private readonly pool=new VfxPool();private readonly emitters=new VfxEmitters(this.pool);
 private effect:VfxEffectDefinition|null=null;private anchor:ReturnType<typeof vfxAuthorAnchor>|null=null;
 private seed=7;tick=0;paused=true;ready=false;diagnostic='';lastReleased:unknown=null;
 constructor(private readonly core:RendererCore){}
 async start(asset:VfxAsset,source:AssetRef,doc:SceneDocument,nodeId:string,key:string,paused:boolean){
  this.stop();this.diagnostic='';if(this.core.vfx)throw new Error('其他播放占用VFX Pass，请先停止');
  if(asset.status!=='accepted')throw new Error('隔离图资源不能预览');
  if(asset.id!==source.guid)throw new Error('图预览源身份不匹配');
  const node=doc.nodes.find(n=>n.id===nodeId),component=node?.components.find(c=>c.kind==='VfxEmitter' && c.resource.guid===asset.id && c.effectKey===key);
  if(!node || component?.kind!=='VfxEmitter')throw new Error('请选择匹配图GUID/输出key的真实作者节点');
  const effect=asset.effects[key];if(!effect || effect.kind!=='sprite')throw new Error('图预览仅支持编译sprite输出');
  const generation=++this.generation;
  try{
   await readVfxAssetSource(source);if(generation!==this.generation)return;
   if(this.core.vfx)throw new Error('其他播放占用VFX Pass，请先停止');
   const pass=new VfxPass(this.core.device);this.pass=pass;this.core.vfx=pass;
   this.effect=structuredClone(effect);this.anchor=vfxAuthorAnchor(SceneGraph.fromDocument(doc),node.id,component);this.seed=component.seed;this.paused=paused;
   const bitmap=await readVfxTexture(effect.texture);try{if(generation!==this.generation || this.core.vfx!==pass)return;pass.addTexture(effect.texture.guid,bitmap);}finally{bitmap.close();}
   if(generation!==this.generation || this.core.vfx!==pass)return;this.ready=true;
  }catch(error){if(generation!==this.generation)return;this.diagnostic=String(error);this.stop();throw error;}
 }
 update(dt:number,locked:boolean){if(this.pass && (locked || this.core.vfx!==this.pass)){this.stop();return;}if(!this.ready || this.paused)return;this.accumulator+=Math.min(dt,.25);while(this.accumulator>=1/30){this.accumulator-=1/30;this.advance();}}
 step(){if(this.ready){this.paused=true;this.advance();}}
 private advance(){
  if(!this.pass || !this.effect || !this.anchor)return;this.pool.advance(1/30);let effect=this.effect;const tick=this.tick++;
  if(effect.backend==='gpu'){const reason=this.pass.updateGpuEmitter('graph-preview',effect,this.anchor,tick,1/30,this.seed);if(!reason){this.diagnostic='';this.emitters.stop('graph-preview');this.pass.instances=this.pool.active;return;}this.diagnostic=reason;effect=cpuVfxCompatibility(effect);}
  this.emitters.update('graph-preview',effect,this.anchor,tick,1/30,this.seed);this.pass.instances=this.pool.active;
 }
 stop(){this.generation++;if(this.pass){this.pass.destroy();this.lastReleased={...this.pass.stats};}if(this.core.vfx===this.pass)this.core.vfx=null;this.pass=null;this.effect=null;this.anchor=null;this.pool.clear();this.emitters.clear();this.tick=0;this.accumulator=0;this.ready=false;}
 snapshot(){return {ready:this.ready,tick:this.tick,paused:this.paused,seed:this.seed,diagnostic:this.diagnostic,pool:{...this.pool.stats,active:this.pool.active.length},emitters:{...this.emitters.stats,handles:this.emitters.activeHandles},particles:this.pool.active.map(p=>({...p})),gpu:this.pass?{...this.pass.stats}:null,compute:this.pass?.gpu?.snapshot()??null,lastReleased:this.lastReleased};}
}
