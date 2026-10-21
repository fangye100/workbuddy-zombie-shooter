import { SceneGraph, parseGlb, type FractureAsset, type SceneDocument } from '@aether/scene';
import { bakeSkinVertices, paletteForNamedPose, poseIndexAt, type CoreDynamicBatch, type RendererCore } from '@aether/render';
import { admitFractureProfile, attachFixedTick, bindFractureToPlay, createGlbConvexResolver, frozenFractureEvent,
  prepareFractureActivation, type FractureAssetIO, type FractureEvent, type FracturePlayBinding } from '@aether/runtime';
import { PlayFractureRenderer, basisFromQuat } from './fracture-renderer';
import { ActorLibrary, type ActorMesh } from './runtime-actors';
import { SharedMotionRuntime } from './shared-motion-runtime';
import { paletteChoice } from './animation-debug/selection';
import { animPhase } from './runtime-bridge';

/** 作者宿主只组合正式准备器/物理/渲染器。没有游戏伤害、奖励、导航或第二套运动求解。 */
export class FracturePreview {
  private generation = 0;
  private binding: ReturnType<typeof attachFixedTick> | null = null;
  private meshRenderer: PlayFractureRenderer | null = null;
  private actors: ActorLibrary | null = null;
  private actor: ActorMesh | null = null;
  private source: ReturnType<typeof parseGlb> | null = null;
  private image: ImageBitmap | null = null;
  private profile: FractureAsset | null = null;
  private event: FractureEvent | null = null;
  private sourceBatches: CoreDynamicBatch[] = [];
  private accumulator = 0;
  private owner = '';
  private restore: (() => void) | null = null;
  private takingOver = false;
  private expected = 0;
  ready = false; paused = true; triggered = false; tick = 0; diagnostic = '';
  lastReleased: unknown = null;
  constructor(private readonly core: RendererCore, private readonly io: FractureAssetIO,
    private readonly port: { hide(nodeId: string): () => void }) {}
  get batches(): CoreDynamicBatch[] {
    return [...this.sourceBatches, ...(this.meshRenderer?.dynamicBatches ?? [])];
  }
  get resources(): FracturePlayBinding | null { return this.binding; }
  bounds():{center:[number,number,number];radius:number}|null {
    const b=this.batches[0];if(!b?.rigid)return null;
    const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity],r=b.rigid;
    for(let i=0;i<b.vertices.length;i+=15)for(let axis=0;axis<3;axis++){
      const v=b.instances[axis]!+r[axis]!*b.vertices[i]!+r[4+axis]!*b.vertices[i+1]!+r[8+axis]!*b.vertices[i+2]!;
      min[axis]=Math.min(min[axis]!,v);max[axis]=Math.max(max[axis]!,v);
    }
    return {center:[(min[0]!+max[0]!)/2,(min[1]!+max[1]!)/2,(min[2]!+max[2]!)/2],radius:Math.hypot(max[0]!-min[0]!,max[1]!-min[1]!,max[2]!-min[2]!)/2};
  }
  async start(doc: SceneDocument, nodeId: string, ref: {path: string;guid: string}, draft: FractureAsset, seed: number): Promise<void> {
    this.stop(); this.diagnostic = '';
    const generation = this.generation, owner = this.owner = `fracture-preview-${generation}`;
    const current = () => generation === this.generation;
    const graph = SceneGraph.fromDocument(doc); graph.updateWorldTransforms();
    const node = graph.getNode(nodeId); if (!node) throw new Error('预览节点已不存在');
    const spawn = node.components.find(c => c.kind === 'SpawnPoint');
    if (draft.kind === 'npc' && (spawn?.kind !== 'SpawnPoint' || spawn.characterId !== draft.npc?.actorId)) throw new Error('请选择与 profile actorId 一致的 NPC 刷怪点');
    if(draft.kind==='object'){
      const mesh=node.components.find(c=>c.kind==='MeshRenderer');
      if(mesh?.kind!=='MeshRenderer'||mesh.source.type!=='asset'||mesh.source.ref.guid!==draft.source.model.guid)throw new Error('选中物体的源模型GUID与碎裂配方不匹配');
    }
    const world = node.world;
    let event: FractureEvent = frozenFractureEvent({ sequence: generation, tick: 0, seed, profile: ref,
      target: draft.kind === 'npc' ? {kind:'npc',runId:owner,slot:0,id:0,generation} : {kind:'scene-object',runId:owner,nodeId},
      position: [...world.position], rotation: [...world.rotation], scale: [...world.scale],
      contact: null, normal: [0,0,1], impulse: [0,2,3], source:{weaponId:'author-preview',hitSequence:generation} });
    try {
      // 当前磁盘准入在任何World/GPU分配前；NPC姿态随后补上，最终仍走完整正式prepare。
      const admission=await admitFractureProfile(ref,this.io,draft);if(!current())return;
      if(!admission.ok)throw new Error(admission.failure.stage+'：'+admission.failure.detail);
      if(admission.profile.kind!==draft.kind)throw new Error('当前profile类型与草稿不一致');
      if (draft.kind === 'npc') {
        const manifest = JSON.parse(await this.io.readText('assets/_data/asset-manifest.json')); if (!current()) return;
        const actors = new ActorLibrary(manifest, path => this.io.readBinary(path)); this.actors = actors;
        actors.setSharedMotions(new SharedMotionRuntime(path => this.io.readText(path)));
        await actors.preload(draft.npc!.actorId); if (!current()) return;
        const actor = actors.get(draft.npc!.actorId); if (!actor) throw new Error(actors.diagnostics.join('；') || 'NPC 动作不可用');
        this.actor = actor;
        event = frozenFractureEvent({...event,position:[world.position[0],world.position[1]+actor.feetOffset*world.scale[1],world.position[2]]});
      }
      this.profile = structuredClone(draft); this.event = event;
      const bytes = await this.io.readBinary(draft.source.model.path); if (!current()) return;
      this.source = parseGlb(bytes,null,'auto',{normalize:false});
      if (this.source.image) {
        const image = await createImageBitmap(this.source.image);
        if (!current()) { image.close(); return; } this.image = image;
      }
      this.sampleActor();
      const admitted = await prepareFractureActivation(this.event!,{io:this.io,draftProfile:draft,resolveConvexPoints:createGlbConvexResolver()});
      if (!current()) return;
      if (!admitted.ok) throw new Error(admitted.failure.stage + '：' + admitted.failure.detail);
      const scene = structuredClone(doc);
      // 仅预览World不把待碎对象本身镜像为障碍；原作者/导航碰撞不变。
      if (draft.kind === 'object') { const target = scene.nodes.find(n=>n.id===nodeId); if (target) target.visible=false; }
      const binding = attachFixedTick(bindFractureToPlay({fixedStepSec:1/30,registerResource:()=>{}},{initialScene:SceneGraph.fromDocument(scene)}));
      this.binding = binding;
      if (!await binding.ready || !current()) { if(current()) throw new Error(binding.failure?.detail ?? '物理初始化已取消'); return; }
      this.meshRenderer = new PlayFractureRenderer(this.io,{owner});
      this.ready = true; this.paused = true; this.sourceFrame();
    } catch (error) {
      if (!current()) return;
      this.stop(); this.diagnostic = String(error); throw error;
    }
  }
  private sampleActor(): void {
    const actor=this.actor, event=this.event; if (!actor || !event) return;
    const clipIndex=paletteChoice(actor.clips,1,null).index;
    const clip=actor.clips[clipIndex];
    const pose=clip ? poseIndexAt(actor.palette,clipIndex,animPhase(this.tick,1/30,0,clip.durationSec)) : actor.restPose;
    const count=actor.palette.jointCount, matrices=actor.palette.data.slice(pose*count*16,(pose+1)*count*16);
    const named:Record<string,number[]>={};
    for(let i=0;i<count;i++){const name=actor.jointNames[i];if(name)named[name]=Array.from(matrices.subarray(i*16,i*16+16));}
    this.event=frozenFractureEvent({...event,tick:this.tick,npcPose:named,npcNormalization:Array.from(actor.normalization!)});
  }
  private sourceFrame(): void {
    const source=this.source,event=this.event,profile=this.profile; if(!source || !event || !profile)return;
    let vertices=source.mesh.vertices;
    if(this.actor && event.npcPose){if(!source.skeleton)throw new Error('NPC源网格缺少骨架');vertices=bakeSkinVertices(source.mesh,paletteForNamedPose(source.skeleton.jointNames,event.npcPose),event.npcNormalization!);}
    const instances=new Float32Array(20);instances.set(event.position,0);instances.set([1,1,1],4);instances.set([1,1,1],8);instances[14]=2;instances[16]=1;
    const rigid=new Float32Array(12);basisFromQuat(event.rotation,event.scale[0],rigid,0);rigid[3]=1;
    this.sourceBatches=source.subMeshes.map(sm=>{
      const row=new Float32Array(instances);row.set(sm.hasBaseColorTexture?[1,1,1]:(sm.baseColorFactor??[1,1,1,1]).slice(0,3),8);
      return {owner:this.owner,meshId:this.owner+':source:'+this.tick,vertices,indices:source.mesh.indices,skin:null,instances:row,count:1,rigid,
        albedo:sm.hasBaseColorTexture?this.image:null,textureKey:this.owner+':source',indexStart:sm.indexStart,indexCount:sm.indexCount,outline:true};
    });
  }
  async trigger(): Promise<void> {
    if(!this.ready || !this.event || !this.profile || !this.binding || this.triggered)throw new Error('请先开始或重播预览，再触发一次');
    const generation=this.generation,binding=this.binding,event=this.event;
    const prepared=await prepareFractureActivation(event,{io:this.io,draftProfile:this.profile,resolveConvexPoints:createGlbConvexResolver()});
    if(generation!==this.generation || binding!==this.binding)return;
    if(!prepared.ok){this.diagnostic=prepared.failure.stage+'：'+prepared.failure.detail;throw new Error(this.diagnostic);}
    const result=binding.runtime.play(prepared.activation);if(!result.accepted)throw new Error(result.rejection?.detail??'预览入队被拒绝');
    binding.runtime.tick(0);this.expected=prepared.activation.chunks.length;
    this.triggered=true;this.takingOver=true;this.sync();
  }
  update(dt:number):void {
    if(!this.ready)return;
    if(!this.paused){this.accumulator+=Math.min(.25,Math.max(0,dt));while(this.accumulator>=1/30){this.accumulator-=1/30;this.advance();}}
    this.sync();
  }
  step():void { if(this.ready){this.paused=true;this.advance();this.sync();} }
  private advance():void {this.tick++;if(this.triggered)this.binding?.onFixedTick(1/30);else{this.sampleActor();this.sourceFrame();}}
  private sync():void {
    const binding=this.binding,renderer=this.meshRenderer;if(!binding || !renderer || !binding.backend())return;
    renderer.sync(binding.runtime,binding.backend());
    if(!this.restore && this.sourceBatches.length && this.core.dynamicBatchState(this.sourceBatches)==='ready')this.restore=this.port.hide(this.event!.target.kind==='scene-object'?this.event!.target.nodeId:'');
    if(this.takingOver){
      const batches=renderer.dynamicBatches;
      const failure=binding.runtime.active.length!==this.expected?'物理接管失败或预算不足':renderer.error;
      const state=batches.length?this.core.dynamicBatchState(batches):'pending';
      if(failure || state==='failed'){
        this.diagnostic=failure??this.core.dynamicError??'GPU预览接管失败';
        this.binding?.runtime.cancel(binding.runtime.active[0]?.eventKey??'');renderer.sync(binding.runtime,binding.backend());this.takingOver=false;
      }else if(state==='ready'){
        this.sourceBatches=[];if(!this.restore)this.restore=this.port.hide(this.event!.target.kind==='scene-object'?this.event!.target.nodeId:'');this.takingOver=false;
      }
    }
    this.core.releaseDynamicMeshesWithPrefix(this.owner+':',new Set(this.batches.map(b=>b.meshId)));
  }
  stop():void {
    this.generation++;const binding=this.binding;this.binding=null;
    const oldRuntime=binding?.backend()?binding.runtime:null;
    binding?.dispose();this.meshRenderer?.dispose();this.meshRenderer=null;
    this.actors?.clear();this.actors=null;this.actor=null;this.image?.close();this.image=null;
    if(this.owner)this.core.releaseDynamicOwner(this.owner);
    this.restore?.();this.restore=null;
    this.lastReleased=binding?{runtime:oldRuntime,session:binding.session}:this.lastReleased;
    this.profile=null;this.event=null;this.source=null;this.sourceBatches=[];
    this.ready=false;this.triggered=false;this.takingOver=false;this.tick=0;this.accumulator=0;this.paused=true;
  }
  snapshot(){return {ready:this.ready,paused:this.paused,triggered:this.triggered,sourceVisible:this.sourceBatches.length>0,takingOver:this.takingOver,tick:this.tick,owner:this.owner,diagnostic:this.diagnostic,
    event:this.event,active:this.binding?.backend()?this.binding.runtime.active.length:0,stats:this.binding?.backend()?{...this.binding.runtime.stats}:null,batches:this.batches.map(b=>({meshId:b.meshId,count:b.count}))};}
}
