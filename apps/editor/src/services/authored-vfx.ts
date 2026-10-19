import {vfxAuthorAnchor} from './vfx-author-anchor';
import {SceneGraph,cpuVfxCompatibility,VFX_VERSION,type SceneDocument,type VfxMotion,type VfxEffectDefinition} from '@aether/scene';
import {VfxEmitters,RibbonHistory,sampleVfxMotionWorld,type VfxPool} from '@aether/runtime';
import {readVfxAsset,readVfxTexture} from './vfx-assets';
import type {VfxPass} from '@aether/render';
/** Host adapter for authored component transforms; generic runtime owns all particle clocks. */
export class AuthoredVfx {
 readonly emitters:VfxEmitters;readonly diagnostics:string[]=[];
 private jobs:{key:string;effect:VfxEffectDefinition;position:[number,number,number];direction:[number,number,number];normal:[number,number,number];seed:number;motion?:VfxMotion;matrix:Float32Array;originTick:number|null;lastTick:number;cycle:number;finished:boolean}[]=[];
 private generation=0;private run=-1;
 private pass:VfxPass|null=null;
 constructor(pool:VfxPool,readonly ribbons=new RibbonHistory()){this.emitters=new VfxEmitters(pool);}
 start(doc:SceneDocument,pass:VfxPass):void{this.clear();this.pass=pass;const generation=this.generation,graph=SceneGraph.fromDocument(doc);
  for(const node of doc.nodes)for(const c of node.components)if(c.kind==='VfxEmitter' && c.enabled && c.playing && graph.isEffectivelyVisible(node.id))void(async()=>{try{
   const asset=await readVfxAsset(c.resource,{onDiagnostic:message=>{if(generation===this.generation)this.diagnostics.push(node.id+': '+message);}}),effect=asset.effects[c.effectKey];if(effect?.kind==='decal')throw new Error(node.id+': 投影贴花需要VfxDecal组件，不能作为sprite发射');if(!effect)throw new Error(`VFX发射器 ${node.id} 缺少 ${c.effectKey}`);if(asset.version<VFX_VERSION && generation===this.generation)this.diagnostics.push(`${node.id}: 兼容读取VFX v${asset.version}，磁盘未升级（${c.resource.path}）`);const bitmap=await readVfxTexture(effect.texture);try{if(generation!==this.generation)return;pass.addTexture(effect.texture.guid,bitmap);}finally{bitmap.close();}
   if(generation!==this.generation)return;const anchor=vfxAuthorAnchor(graph,node.id,c);
   this.jobs.push({key:node.id,effect,...anchor,seed:c.seed,...(c.motion?{motion:structuredClone(c.motion)}:{}),originTick:null,lastTick:-1,cycle:0,finished:false});
  }catch(e){if(generation===this.generation)this.diagnostics.push(String(e));}})();
 }
 update(tick:number,step:number,runId:number){if(this.run!==runId){if(this.run!==-1)for(const j of this.jobs)this.pass?.gpu?.release(`author:${this.run}:${j.key}`);this.emitters.clear();for(const j of this.jobs){j.originTick=null;j.lastTick=-1;j.cycle=0;j.finished=false;}this.run=runId;}for(const j of this.jobs){const key=`author:${runId}:${j.key}`,anchor={position:j.position,direction:j.direction,normal:j.normal};let effect=j.effect;
  if(effect.kind==='ribbon'){
   if(!j.motion){const message=j.key+': Ribbon作者需要场景motion路径';if(!this.diagnostics.includes(message))this.diagnostics.push(message);continue;}if(j.finished || tick===j.lastTick)continue;j.originTick??=tick;const start=Math.max(j.originTick,j.lastTick+1,tick-239);if(start>j.lastTick+1 && j.lastTick>=0){this.ribbons.disconnect(key);const message=j.key+': Ribbon作者追帧超过240，断开恢复';if(!this.diagnostics.includes(message))this.diagnostics.push(message);}
   for(let at=start;at<=tick;at++){const sample=sampleVfxMotionWorld(j.motion,(at-j.originTick)*step,j.matrix);if(sample.cycle!==j.cycle){this.ribbons.disconnect(key);j.cycle=sample.cycle;}if(!this.ribbons.push(key,effect,sample.position,at,step,tick)){const message=j.key+': Ribbon点/句柄预算已满';if(!this.diagnostics.includes(message))this.diagnostics.push(message);}if(sample.finished){this.ribbons.stop(key);j.finished=true;break;}}j.lastTick=tick;continue;
  }
  if(effect.backend==='gpu'){const reason=this.pass?.updateGpuEmitter(key,effect,anchor,tick,step,j.seed)??null;if(!reason){this.emitters.stop(key);continue;}const message=`${j.key}: ${reason}（CPU限120/s、128粒子，保留加速度）`;if(!this.diagnostics.includes(message))this.diagnostics.push(message);effect=cpuVfxCompatibility(effect);}
  this.emitters.update(key,effect,anchor,tick,step,j.seed);
 }}
 snapshot(){return {ready:this.jobs.map(j=>j.key),handles:this.emitters.activeHandles,stats:{...this.emitters.stats},gpu:this.pass?.gpu?.snapshot()??null,ribbons:this.ribbons.snapshot(),diagnostics:[...this.diagnostics]};}
 clear(){this.generation++;this.jobs=[];this.emitters.clear();this.diagnostics.length=0;this.run=-1;this.pass=null;}
}
