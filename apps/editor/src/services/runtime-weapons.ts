/** Play 武器 IO/资源与 renderer 适配；动作策略来自游戏表现，骨求值来自现有单次采样。 */
import { mat4, multiply, type Quat } from '@aether/core';
import { parseGlb, VERTEX_FLOATS, resolveSocketDefaults, validateAssetMeta, validateModelAssetIdentity, actorHoldSlot, validActorHoldProfiles, type ActorHoldProfiles, type ActorHoldSlot, type AssetMeta, type AssetRef, type BoneSockets, type GltfResult,
  type ModelAttachment, type ModelSockets, type SceneDocument, type SocketTransform, type WeaponDefinition } from '@aether/scene';
import { attachedModelFrame, composeSocket, inverseSocket, rigidFromMatrix, rotateVec3, socketMatrix,
  type ModelDraw, type PoseFrameOutput, type PostPoseDrawPort, type RegisterDrawResource } from '@aether/render';
import type { PlaySession, RuntimeSession } from '@aether/zombie-game';
import { weaponModelProjection, weaponMountForHoldSlot, type WeaponModelView } from '@aether/zombie-game/presentation/weapon-model';
import { fileUrl } from '../asset-util';
import type { IkObject } from './runtime-body-ik';

interface Loaded { draw:ModelDraw; sockets:ModelSockets; corners:number[][] }
interface Child extends Loaded { spec:ModelAttachment }
interface Assembly extends Loaded { definition:WeaponDefinition; baseDefinition:WeaponDefinition; children:Child[] }
export interface RuntimeWeaponsPorts {
  objectForNode(id:string):(IkObject&{visible?:boolean})|null;
  meta(path:string):Promise<AssetMeta|null>;
  draw(model:GltfResult,bitmap:ImageBitmap|null,register:RegisterDrawResource,label:string):ModelDraw;
  read?(path:string,signal:AbortSignal):Promise<ArrayBuffer>;
  decode?(image:Blob):Promise<ImageBitmap>;
}
interface Active { assembly:Assembly; object:IkObject; right:number; left:number; removed:boolean }
export interface HoldContext {
  actor:AssetRef; nodeId:string|null; profiles:ActorHoldProfiles|undefined;
  weapons:{id:string;name:string;model:AssetRef;slot:ActorHoldSlot}[];
  frame:{weaponId:string;world:SocketTransform;actorRotation:Quat;scale:number}|null;
}
export class RuntimeWeapons implements PostPoseDrawPort {
  private generation=0;
  private abort:AbortController|null=null;
  private session:PlaySession|null=null;
  private nodeId:string|null=null;
  private bones:BoneSockets|null=null;
  private assemblies=new Map<string,Assembly>();
  private active:Active|null=null;
  private errors=new Set<string>();
  private pending=0;
  private runtime:RuntimeSession|null=null;
  private actorRef:AssetRef|null=null;
  private profiles:ActorHoldProfiles|undefined;
  private configured=new Map<string,string>();
  private holdFrame:{weaponId:string;world:SocketTransform;actorRotation:Quat;scale:number}|null=null;
  private frame:PoseFrameOutput={frameStamp:0,stamp:-1,nodes:[],matrices:new Map()};
  private projection:WeaponModelView={visible:false,weaponId:null,frameStamp:-1,muzzle:null,diagnostics:[]};
  private measurements:Record<string,number|null>={};
  /** 本帧实际提交的附件矩阵，只用于诊断，不驱动相位或下一帧求解。 */
  private attachmentDraws:{id:string;guid:string|undefined;removed:boolean;frameStamp:number;worldMatrix:number[];worldCorners:number[][]}[]=[];
  constructor(private readonly ports:RuntimeWeaponsPorts){}
  holdContext():HoldContext|null{return this.actorRef?{actor:structuredClone(this.actorRef),nodeId:this.nodeId,profiles:structuredClone(this.profiles),weapons:[...this.assemblies.values()].map(a=>({id:a.definition.id,name:a.definition.name,model:structuredClone(a.definition.presentation.model!),slot:actorHoldSlot(this.profiles,a.definition.presentation.model!)??{bone:a.baseDefinition.presentation.assembly?.holdSlot?.bone??'Hips',position:[...(a.baseDefinition.presentation.assembly?.holdSlot?.position??a.baseDefinition.presentation.assembly!.holdPose.position)],rotation:[...a.baseDefinition.presentation.assembly!.holdPose.rotation]}})),frame:this.holdFrame?structuredClone(this.holdFrame):null}:null;}
  setHoldProfiles(actorGuid:string,profiles:ActorHoldProfiles):void {
    if(!this.actorRef||this.actorRef.guid!==actorGuid||!validActorHoldProfiles(profiles))throw new Error('WEAPON_HOLD_PROFILE: 角色身份/持握配置不匹配');
    this.profiles=structuredClone(profiles);this.configured.clear();this.sync(this.session?.runtime??null);
  }
  view():WeaponModelView {
    const pose=this.runtime?.weapons.poseIntent;
    const diagnostics=[...this.errors].filter(e=>!e.includes(': WEAPON_LEGACY ')||e.startsWith(`${pose?.weaponId}:`));
    return {...this.projection,visible:this.projection.visible&&pose?.weaponId===this.projection.weaponId,diagnostics};
  }
  summary(){return {pending:this.pending,loaded:[...this.assemblies.keys()],generation:this.generation,simulationTick:this.runtime?.tick??null,pose:this.runtime?.weapons.poseIntent??null,...this.view(),visibleDrawCount:this.drawObjects().filter(d=>d.visible).length,warnings:[...this.errors],ikDiagnostics:this.active?.object.skinState?.bodyIk?.diagnostics??[],measurements:{...this.measurements},attachmentDraws:this.attachmentDraws.map(d=>({...d,worldMatrix:[...d.worldMatrix],worldCorners:d.worldCorners.map(p=>[...p])}))};}
  private error(message:string):void {this.errors.add(message);}
  private valid(generation:number):boolean {return generation===this.generation&&!!this.session&&this.session.state!=='stopped'&&!this.abort?.signal.aborted;}
  start(doc:SceneDocument,session:PlaySession):void {
    this.stop();this.errors.clear();this.session=session;this.abort=new AbortController();
    const generation=this.generation,signal=this.abort.signal;
    const node=doc.nodes.find(n=>n.id===doc.playerStart),mesh=node?.components.find(c=>c.kind==='MeshRenderer'&&c.playBinding==='player');
    if(mesh?.kind!=='MeshRenderer'||mesh.source.type!=='asset'){this.error('WEAPON_ACTOR: 玩家真实骨架未配置，保留 legacy');return;}
    this.nodeId=node!.id;
    this.actorRef=structuredClone(mesh.source.ref);
    const definitions=session.runtime?.weapons.definitions??[];
    this.pending++;
    void (async()=>{
      try{
        const meta=await this.ports.meta(mesh.source.type==='asset'?mesh.source.ref.path:'');
        if(!this.valid(generation))return;
        if(!meta||meta.guid!==(mesh.source.type==='asset'?mesh.source.ref.guid:undefined))throw new Error('WEAPON_ACTOR_GUID: 角色 GUID/path 不一致');
        const invalid=validateAssetMeta(meta).filter(d=>d.severity==='error');if(invalid.length)throw new Error(invalid.map(d=>d.message).join('; '));
        this.bones=resolveSocketDefaults(meta.boneSockets,mesh.boneSockets);
        if(!this.bones?.rightHand||!this.bones.leftHand)throw new Error('WEAPON_BONE_SOCKET: 缺少 rightHand/leftHand contact，保留 legacy');
        this.profiles=structuredClone(meta.holdProfiles);
      }catch(e){if(this.valid(generation))this.error(String(e));}
      finally{if(this.valid(generation))this.pending--;}
    })();
    for(const definition of definitions){
      if(!definition.presentation.assembly||!definition.presentation.model){this.error(`${definition.id}: WEAPON_LEGACY 无模型/assembly，使用旧 markers`);continue;}
      this.pending++;
      void (async()=>{
        const created:Loaded[]=[];
        try{
          const assembly=definition.presentation.assembly!;
          const main=await this.load(definition.presentation.model!,assembly.sockets,generation,signal);created.push(main);
          const children:Child[]=[];
          for(const spec of assembly.attachments){const child=await this.load(spec.model,spec.sockets,generation,signal);created.push(child);children.push({...child,spec});}
          if(!this.valid(generation)){created.forEach(x=>x.draw.dispose());return;}
          for(const key of ['primaryGrip','supportGrip','muzzle','magazine','chamber'])if(!main.sockets[key])throw new Error(`${definition.id}: WEAPON_SOCKET ${key} 缺失`);
          for(const child of children)if(!main.sockets[child.spec.parentSocket]||!child.sockets[child.spec.childSocket])throw new Error(`${definition.id}: WEAPON_ATTACHMENT_SOCKET ${child.spec.id} 断链`);
          this.assemblies.set(definition.id,{...main,definition,baseDefinition:structuredClone(definition),children});
        }catch(e){created.forEach(x=>x.draw.dispose());if(this.valid(generation))this.error(String(e));}
        finally{if(this.valid(generation))this.pending--;}
      })();
    }
  }
  private async load(ref:AssetRef,overrides:ModelSockets|undefined,generation:number,signal:AbortSignal):Promise<Loaded> {
    const meta=await this.ports.meta(ref.path);
    if(!this.valid(generation))throw new Error('WEAPON_CANCELLED');
    const identity=validateModelAssetIdentity(ref,meta);if(identity.length)throw new Error(identity.join('; '));
    if(!meta)throw new Error('WEAPON_META_MISSING');
    const invalid=validateAssetMeta(meta).filter(d=>d.severity==='error');if(invalid.length)throw new Error(`WEAPON_META: ${invalid.map(d=>d.message).join('; ')}`);
    const data=await (this.ports.read??(async(path,abortSignal)=>{const response=await fetch(fileUrl(path),{signal:abortSignal,cache:'no-store'});if(!response.ok)throw new Error(`${path}: HTTP ${response.status}`);return response.arrayBuffer();}))(ref.path,signal);
    if(!this.valid(generation))throw new Error('WEAPON_CANCELLED');
    const model=parseGlb(data,meta.importer?.normalizeHeightM??null,meta.importer?.upAxisFlip?'z':'y');
    if(model.skeleton)throw new Error(`WEAPON_RIG: ${ref.path} 附件需刚性模型`);
    let bitmap:ImageBitmap|null=null;
    try{
      if(model.image)bitmap=await (this.ports.decode??createImageBitmap)(model.image);
      if(!this.valid(generation))throw new Error('WEAPON_CANCELLED');
      const register:RegisterDrawResource=(label,dispose)=>{if(!this.valid(generation)){dispose();throw new Error('WEAPON_CANCELLED');}this.session!.registerResource(label,dispose);};
      const draw=this.ports.draw(model,bitmap,register,`weapon:${ref.guid}`);
      const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
      for(let i=0;i<model.mesh.vertices.length;i+=VERTEX_FLOATS)for(let k=0;k<3;k++){min[k]=Math.min(min[k]!,model.mesh.vertices[i+k]!);max[k]=Math.max(max[k]!,model.mesh.vertices[i+k]!);}
      const corners=Array.from({length:8},(_,i)=>[0,1,2].map(k=>(i&(1<<k)?max:min)[k]!));
      return {draw,sockets:resolveSocketDefaults(meta.modelSockets,overrides)??{},corners};
    }finally{bitmap?.close();}
  }
  stop():void {
    this.generation++;this.abort?.abort();this.abort=null;
    if(this.active?.object.skinState?.bodyIk)delete this.active.object.skinState.bodyIk.attachment;
    for(const a of this.assemblies.values()){a.draw.dispose();a.children.forEach(c=>c.draw.dispose());}
    this.assemblies.clear();this.active=null;this.bones=null;this.nodeId=null;this.session=null;this.runtime=null;this.pending=0;
    this.actorRef=null;this.profiles=undefined;this.configured.clear();this.holdFrame=null;
    this.projection={visible:false,weaponId:null,frameStamp:-1,muzzle:null,diagnostics:[]};this.measurements={};this.attachmentDraws=[];this.frame.matrices.clear();
  }
  sync(runtime:RuntimeSession|null):void {
    this.projection={...this.projection,visible:false};this.measurements={};this.attachmentDraws=[];
    this.runtime=runtime;
    if(runtime)for(const a of this.assemblies.values()){
      const slot=actorHoldSlot(this.profiles,a.baseDefinition.presentation.model!);
      const key=JSON.stringify(slot??null);if(this.configured.get(a.definition.id)===key)continue;
      const sk=this.nodeId?this.ports.objectForNode(this.nodeId)?.skeleton:null;
      if(slot&&sk?.jointNames.filter(n=>n?.replace(/^mixamorig[:_]?/i,'')===slot.bone.replace(/^mixamorig[:_]?/i,'')).length!==1){this.error(`${a.definition.id}: WEAPON_HOLD_PROFILE 骨 ${slot.bone} 缺失/歧义`);continue;}
      try {runtime.weapons.configureMount(a.definition.id,slot?weaponMountForHoldSlot(a.baseDefinition,slot):{assembly:a.baseDefinition.presentation.assembly!,markers:a.baseDefinition.presentation.markers});this.configured.set(a.definition.id,key);}
      catch(error){this.error(String(error));}
    }
    for(const a of this.assemblies.values()){a.draw.draw.visible=false;a.children.forEach(c=>c.draw.draw.visible=false);}
    const previous=this.active;this.active=null;
    if(previous?.object.skinState?.bodyIk)delete previous.object.skinState.bodyIk.attachment;
    const player=runtime?.player(),pose=runtime?.weapons.poseIntent;
    if(!runtime||!player||!pose||!this.nodeId||player.sourceNodeId!==this.nodeId)return;
    const object=this.ports.objectForNode(this.nodeId),a=this.assemblies.get(pose.weaponId),bones=this.bones,ik=object?.skinState?.bodyIk;
    if(!object||object.removed||object.visible===false||!object.skeleton||!ik||!a||!bones?.rightHand||!bones.leftHand)return;
    const right=ik.binding.controls.find(c=>c.part==='rightHand'),left=ik.binding.controls.find(c=>c.part==='leftHand');
    const bone=(name:string)=>{const names=object.skeleton!.jointNames;const matches=names.flatMap((n,i)=>n===name?[object.skeleton!.joints[i]!]:[]);return matches.length===1?matches[0]:undefined;};
    const rightNode=bone(bones.rightHand.bone),leftNode=bone(bones.leftHand.bone);
    if(!right||!left||rightNode===undefined||leftNode===undefined||ik.nodes[right.id]?.at(-1)!==rightNode||ik.nodes[left.id]?.at(-1)!==leftNode){this.error('WEAPON_BONE: contact 骨引用与 IK 末端不一致/歧义');return;}
    if(!ik.binding.enabled||ik.binding.weight<=0||!right.enabled||right.weight<=0||!left.enabled||left.weight<=0){this.error('WEAPON_IK_DISABLED: 精确装配需有效双手控制，保留 legacy');return;}
    const reload=a.children.find(c=>c.spec.id===a.definition.presentation.assembly!.reloadAttachmentId);
    const slot=a.definition.presentation.assembly!.holdSlot;
    const holdNodes=slot?object.skeleton.jointNames.flatMap((n,i)=>n?.replace(/^mixamorig[:_]?/i,'')===slot.bone.replace(/^mixamorig[:_]?/i,'')?[object.skeleton!.joints[i]!]:[]):[];
    if(slot&&holdNodes.length!==1){this.error(`${a.definition.id}: WEAPON_HOLD_SLOT 骨 ${slot.bone} 缺失/歧义，保留 legacy`);return;}
    const reloadGrip=reload?.sockets.primaryGrip?composeSocket(composeSocket(composeSocket(a.sockets[reload.spec.parentSocket]!,reload.spec.offset),inverseSocket(reload.sockets[reload.spec.childSocket]!)),reload.sockets.primaryGrip):undefined;
    const projection=weaponModelProjection(a.definition,pose,player.yaw,object.quat as Quat,a.sockets,{id:right.id,socket:bones.rightHand},{id:left.id,socket:bones.leftHand},reloadGrip,d=>this.error(`${a.definition.id}: ${d}`),holdNodes[0]);
    if(!projection){this.error(`${a.definition.id}: WEAPON_SOCKET 缺少当前相位 socket`);return;}
    ik.attachment=projection.request;ik.controlWeights??={};ik.controlWeights[right.id]=1;ik.controlWeights[left.id]=1;
    this.active={assembly:a,object,right:rightNode,left:leftNode,removed:projection.magazineRemoved};
  }
  frameFor(nodeId:string,stamp:number):PoseFrameOutput|undefined {
    if(nodeId!==this.nodeId||!this.active)return;
    this.projection={...this.projection,visible:false};
    this.attachmentDraws=[];
    this.active.assembly.draw.draw.visible=false;this.active.assembly.children.forEach(c=>c.draw.draw.visible=false);
    const ik=this.active.object.skinState?.bodyIk;
    if(!ik?.attachment||!ik.binding.enabled||ik.binding.weight<=0)return;
    this.frame.frameStamp=stamp;this.frame.nodes=[this.active.right,this.active.left];return this.frame;
  }
  afterPose(nodeId:string,actorMatrix:Float32Array<ArrayBuffer>,frame:PoseFrameOutput):void {
    const active=this.active,request=active?.object.skinState?.bodyIk?.attachment;
    if(nodeId!==this.nodeId||!active||!request||frame!==this.frame||frame.stamp!==frame.frameStamp)return;
    const right=frame.matrices.get(active.right),left=frame.matrices.get(active.left);
    const hand=right&&rigidFromMatrix(right),support=left&&rigidFromMatrix(left);
    if(!hand||!support||!rigidFromMatrix(actorMatrix)||!request.result||!request.resolvedTarget){this.error('WEAPON_POSE: 本帧最终骨方向不可用');return;}
    const root=attachedModelFrame(hand,request.primary.contact,request.primary.modelSocket),world=mat4();multiply(world,actorMatrix,socketMatrix(root));
    const worldFrame=rigidFromMatrix(world);if(!worldFrame)return;
    const actor=rigidFromMatrix(actorMatrix)!;
    const desired=composeSocket(actor,{position:request.resolvedTarget.position.map(v=>v*active.object.scale) as SocketTransform['position'],rotation:request.resolvedTarget.rotation});
    this.holdFrame={weaponId:active.assembly.definition.id,world:desired,actorRotation:actor.rotation,scale:active.object.scale};
    active.assembly.draw.setMatrix(world);active.assembly.draw.draw.visible=true;
    for(const child of active.assembly.children){
      let local:SocketTransform;
      if(active.removed&&child.spec.id===active.assembly.definition.presentation.assembly!.reloadAttachmentId){
        if(!child.sockets.primaryGrip){this.error(`${child.spec.id}: WEAPON_SOCKET 缺少离手 primaryGrip`);continue;}
        local=attachedModelFrame(support,request.dependent!.contact,child.sockets.primaryGrip);
      }else local=composeSocket(root,composeSocket(composeSocket(active.assembly.sockets[child.spec.parentSocket]!,child.spec.offset),inverseSocket(child.sockets[child.spec.childSocket]!)));
      const matrix=mat4();multiply(matrix,actorMatrix,socketMatrix(local));child.draw.setMatrix(matrix);child.draw.draw.visible=true;
      const worldCorners=child.corners.map(p=>[0,1,2].map(k=>matrix[k]!*p[0]!+matrix[k+4]!*p[1]!+matrix[k+8]!*p[2]!+matrix[k+12]!));
      this.attachmentDraws.push({id:child.spec.id,guid:child.spec.model.guid,removed:active.removed&&child.spec.id===active.assembly.definition.presentation.assembly!.reloadAttachmentId,frameStamp:frame.stamp,worldMatrix:Array.from(matrix),worldCorners});
    }
    const muzzleMatrix=mat4();multiply(muzzleMatrix,world,socketMatrix(active.assembly.sockets.muzzle!));
    const muzzle=rigidFromMatrix(muzzleMatrix)!;
    const ideal=composeSocket(composeSocket(request.resolvedTarget,request.primary.modelSocket),inverseSocket(request.primary.contact));
    const dependent=composeSocket(composeSocket(root,request.dependent!.modelSocket),inverseSocket(request.dependent!.contact));
    const distance=(a:SocketTransform,b:SocketTransform)=>Math.hypot(...a.position.map((n,i)=>n-b.position[i]!));
    const angle=(a:SocketTransform,b:SocketTransform)=>2*Math.acos(Math.min(1,Math.abs(a.rotation.reduce((sum,n,i)=>sum+n*b.rotation[i]!,0))));
    const forward=rotateVec3(muzzle.rotation,[1,0,0]),yaw=this.runtime!.player()!.yaw;
    const yawError=Math.atan2(Math.sin(Math.atan2(forward[2],forward[0])-yaw),Math.cos(Math.atan2(forward[2],forward[0])-yaw));
    const mount=this.runtime!.weaponMount.position;
    const shot=[...this.runtime!.weaponCombat.effects].reverse().find(e=>e.tick===this.runtime!.tick-1&&e.weaponId===active.assembly.definition.id&&['shot','pellet','pierce','projectile','flame'].includes(e.kind));
    this.measurements={rightTargetResidualM:distance(hand,ideal),rightOrientationResidualRad:angle(hand,ideal),leftTargetResidualM:distance(support,dependent),leftOrientationResidualRad:angle(support,dependent),muzzleYawErrorRad:Math.abs(yawError),modelMuzzleToSimulationMountM:Math.hypot(...muzzle.position.map((n,i)=>n-mount[i]!))};
    this.measurements.lastShotOriginTick=shot?.tick??null;
    this.measurements.sameTickShotOriginResidualM=shot?Math.hypot(...muzzle.position.map((n,i)=>n-shot.from[i]!)):null;
    this.projection={visible:true,weaponId:active.assembly.definition.id,frameStamp:frame.stamp,muzzle,diagnostics:[]};
  }
  drawObjects(){return [...this.assemblies.values()].flatMap(a=>[a.draw.draw,...a.children.map(c=>c.draw.draw)]);}
}
