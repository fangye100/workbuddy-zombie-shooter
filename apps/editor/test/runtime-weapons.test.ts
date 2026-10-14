import {describe,expect,it,vi} from 'vitest';
import {mat4,composeQuat} from '@aether/core';
import {PlaySession} from '@aether/zombie-game';
import {createDefaultAssetMeta,identitySocket,newBodyIkControl,legacyWeaponArsenal,type AssetMeta,type SceneDocument} from '@aether/scene';
import {createBodyIkState,createSkinState,evalJointMatrices,type ModelDraw,type CoreObjectDraw} from '@aether/render';
import {RuntimeWeapons} from '../src/services/runtime-weapons';
import type {IkObject} from '../src/services/runtime-body-ik';
import {skeletonFromFitPositions} from '../src/services/binding/retarget-session';
import {tposeWorldPositions} from '../src/services/binding/humanik-template';
const floors=import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json',{eager:true,import:'default'});
function glb(image=false):ArrayBuffer {
 const positions=new Float32Array([0,0,0,.1,0,0,0,.1,0]),binary=new Uint8Array(image?40:36);binary.set(new Uint8Array(positions.buffer));
 const document={asset:{version:'2.0'},buffers:[{byteLength:binary.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36},...(image?[{buffer:0,byteOffset:36,byteLength:4}]:[])],
  accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3'}],meshes:[{primitives:[{attributes:{POSITION:0}}]}],nodes:[{mesh:0}],scenes:[{nodes:[0]}],scene:0,...(image?{images:[{bufferView:1,mimeType:'image/png'}]}:{})};
 const raw=new TextEncoder().encode(JSON.stringify(document)),json=new Uint8Array(Math.ceil(raw.length/4)*4);json.fill(32);json.set(raw);
 const out=new ArrayBuffer(12+8+json.length+8+binary.length),view=new DataView(out);view.setUint32(0,0x46546c67,true);view.setUint32(4,2,true);view.setUint32(8,out.byteLength,true);
 view.setUint32(12,json.length,true);view.setUint32(16,0x4e4f534a,true);new Uint8Array(out,20,json.length).set(json);
 view.setUint32(20+json.length,binary.length,true);view.setUint32(24+json.length,0x004e4942,true);new Uint8Array(out,28+json.length).set(binary);return out;
}
async function settle(){for(let i=0;i<24;i++)await Promise.resolve();}
function setup(options:{image?:boolean;decode?:()=>Promise<ImageBitmap>;badGuid?:boolean;failDraw?:boolean;slot?:boolean}={}){
 const doc=structuredClone(Object.values(floors)[0]) as SceneDocument,node=doc.nodes.find(n=>n.id===doc.playerStart)!;
 const mesh=node.components.find(c=>c.kind==='MeshRenderer');if(mesh?.kind!=='MeshRenderer'||mesh.source.type!=='asset')throw new Error('fixture player');
 const arsenal=legacyWeaponArsenal({magazineSize:3,reserveRounds:8,reloadSec:1}),w=arsenal.definitions[0]!;
 w.presentation.model={path:'assets/test-weapon.glb',guid:'as_weapon'};w.presentation.assembly={holdPose:{position:[0,1.1,.2],rotation:[0,0,0,1]},attachments:[{id:'mag',model:{path:'assets/test-mag.glb',guid:'as_mag'},parentSocket:'magazine',childSocket:'insertion',offset:identitySocket()}],reloadAttachmentId:'mag'};
 if(options.slot)w.presentation.assembly.holdSlot={bone:'Hips',position:[0,.2,.2]};
 const rules=doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules');if(rules?.kind!=='RunRules')throw new Error('fixture rules');rules.arsenal=arsenal;
 const sk=skeletonFromFitPositions(tposeWorldPositions()),skin=createSkinState(sk,[]),right=newBodyIkControl('rightHand'),left=newBodyIkControl('leftHand');
 skin.bodyIk=createBodyIkState(sk,{enabled:true,weight:1,locomotionWhileAiming:true,controls:[right,left]});
 const object:IkObject&{visible:boolean}={pos:[0,0,0],quat:[0,0,0,1],scale:1,skeleton:sk,skinState:skin,removed:false,loadedAssetPath:mesh.source.ref.path,visible:true};
 const metadata=new Map<string,AssetMeta>();const actor=createDefaultAssetMeta(mesh.source.ref.guid!,'gltf');actor.boneSockets={rightHand:{bone:'RightHand',contact:identitySocket()},leftHand:{bone:'LeftHand',contact:identitySocket()}};metadata.set(mesh.source.ref.path,actor);
 const meta=createDefaultAssetMeta(options.badGuid?'as_wrong':'as_weapon','gltf');meta.modelSockets=Object.fromEntries(['primaryGrip','supportGrip','magazine','chamber','muzzle'].map(k=>[k,{position:[0,0,k==='supportGrip'?.1:0],rotation:[0,0,0,1]}]));metadata.set('assets/test-weapon.glb',meta);
 const mag=createDefaultAssetMeta('as_mag','gltf');mag.modelSockets={insertion:identitySocket(),primaryGrip:identitySocket()};metadata.set('assets/test-mag.glb',mag);
 const draws:ModelDraw[]=[],destroy=vi.fn(),matrices:Float32Array[]=[];
 const factory=vi.fn((_model,_bitmap,register,label)=>{
  for(let i=0;i<7;i++){let alive=true;register(`${label}:${i}`,()=>{if(alive){alive=false;destroy();}});}
  if(options.failDraw)throw new Error('DRAW_FAILED');
  let alive=true;const draw:ModelDraw={draw:{visible:false,subMeshes:[]} as unknown as CoreObjectDraw,setMatrix:m=>matrices.push(new Float32Array(m)),dispose:()=>{if(alive){alive=false;draw.draw.visible=false;}}};draws.push(draw);return draw;
 });
 const service=new RuntimeWeapons({objectForNode:()=>object,meta:async p=>metadata.get(p)??null,read:async()=>glb(options.image),draw:factory,...(options.decode?{decode:options.decode}:{})});
 const session=new PlaySession();expect(session.play(doc).ok).toBe(true);service.start(doc,session);
 return {service,session,object,factory,destroy,draws,matrices,doc};
}
describe('真实武器 loader、同帧绘制与 Stop 边界',()=>{
 it('角色profile替代legacy，双手同frame跟随；反复预览不累计markers变化，错误骨明确拒绝',async()=>{
  const f=setup({slot:true});await settle();const context=f.service.holdContext()!,model=context.weapons[0]!.model,base=f.session.runtime!.weapons.active.presentation.markers.muzzle.position;
  const profiles={[model.guid!]:{model,slot:{bone:'Hips',position:[.01,.2,.2] as [number,number,number],rotation:[0,0,0,1] as [number,number,number,number]}}};
  f.service.setHoldProfiles(context.actor.guid!,profiles);const marker=[...f.session.runtime!.weapons.active.presentation.markers.muzzle.position];expect(marker[2]).toBeCloseTo(base[2]!-.01);
  f.service.setHoldProfiles(context.actor.guid!,profiles);expect(f.session.runtime!.weapons.active.presentation.markers.muzzle.position).toEqual(marker);
  const request=f.object.skinState!.bodyIk!.attachment!;expect(request.target.position).toEqual([.01,.2,.2]);const frame=f.service.frameFor(f.doc.playerStart!,5)!;
  evalJointMatrices(f.object.skinState!,new Float32Array((f.object.skeleton!.joints.length+1)*16),frame);f.service.afterPose(f.doc.playerStart!,mat4(),frame);
  expect(f.service.holdContext()!.frame!.world.position).toEqual(request.resolvedTarget!.position);expect(f.service.summary().measurements.rightTargetResidualM).toBeLessThan(1e-4);expect(f.service.summary().measurements.leftTargetResidualM).toBeLessThan(1e-4);
  expect(()=>f.service.setHoldProfiles(context.actor.guid!,{[model.guid!]:{model,slot:{...profiles[model.guid!]!.slot,bone:'Missing'}}})).toThrow('缺失/歧义');
  f.service.stop();f.session.stop();expect(f.service.holdContext()).toBeNull();expect(f.session.ledger.pending).toBe(0);
 });
 it('slot转发唯一Hip节点，本次采样primary→model→support且探针使用resolvedTarget',async()=>{
  const f=setup({slot:true});await settle();f.service.sync(f.session.runtime);const hip=f.object.skeleton!.joints[f.object.skeleton!.jointNames.indexOf('Hips')]!;
  const request=f.object.skinState!.bodyIk!.attachment!;expect(request.positionAnchor).toEqual({node:hip});expect(request.target.position).toEqual([0,.2,.2]);
  f.object.skeleton!.locals[hip]!.t[0]+=.05;
  const frame=f.service.frameFor(f.doc.playerStart!,4)!;evalJointMatrices(f.object.skinState!,new Float32Array((f.object.skeleton!.joints.length+1)*16),frame);f.service.afterPose(f.doc.playerStart!,mat4(),frame);
  expect(request.resolvedTarget!.position[0]).toBeCloseTo(.05);expect(f.service.view().visible).toBe(true);expect(f.service.summary().measurements.rightTargetResidualM).toBeLessThan(1e-4);expect(f.service.summary().measurements.leftTargetResidualM).toBeLessThan(1e-4);
  expect(request.target.position).toEqual([0,.2,.2]);f.service.stop();f.session.stop();
 });
 it.each(['missing','ambiguous'])('slot骨%s明确降级，不复用上次装配',async mode=>{
  const f=setup({slot:true});await settle();f.service.sync(f.session.runtime);const names=f.object.skeleton!.jointNames;
  if(mode==='missing')names[names.indexOf('Hips')]='Other';else names[names.indexOf('Spine')]='mixamorig:Hips';
  f.service.sync(f.session.runtime);expect(f.object.skinState!.bodyIk!.attachment).toBeUndefined();expect(f.service.frameFor(f.doc.playerStart!,4)).toBeUndefined();expect(f.service.summary().diagnostics.join()).toContain('WEAPON_HOLD_SLOT');f.service.stop();f.session.stop();
 });
 it('模型promise已完成仍保留legacy；同帧有效骨/IK输出后才显示，Stop ledger归零',async()=>{
  const f=setup();await settle();expect(f.service.summary().pending).toBe(0);expect(f.service.view().visible).toBe(false);expect(f.factory).toHaveBeenCalledTimes(2);
  expect(f.session.ledger.pending).toBe(14);f.service.sync(f.session.runtime);
  const frame=f.service.frameFor(f.doc.playerStart!,5)!;evalJointMatrices(f.object.skinState!,new Float32Array((f.object.skeleton!.joints.length+1)*16),frame);
  const actor=mat4();composeQuat(actor,0,0,0,f.object.quat,1);f.service.afterPose(f.doc.playerStart!,actor,frame);
  expect(f.service.view()).toMatchObject({visible:true,frameStamp:5,weaponId:'pistol'});expect(f.draws.every(d=>d.draw.visible)).toBe(true);
  const child=f.service.summary().attachmentDraws[0]!;expect(child.frameStamp).toBe(5);expect(child.removed).toBe(false);expect(child.worldMatrix).toHaveLength(16);
  child.worldMatrix[12]=999;expect(f.service.summary().attachmentDraws[0]!.worldMatrix[12]).not.toBe(999);
  expect(child.worldCorners).toHaveLength(8);expect(child.worldCorners.flat().every(Number.isFinite)).toBe(true);
  child.worldCorners[0]![0]=999;expect(f.service.summary().attachmentDraws[0]!.worldCorners[0]![0]).not.toBe(999);
  f.object.visible=false;f.service.sync(f.session.runtime);expect(f.service.view().visible).toBe(false);expect(f.service.frameFor(f.doc.playerStart!,6)).toBeUndefined();
  expect(f.service.summary().attachmentDraws).toEqual([]);f.service.stop();f.session.stop();expect(f.session.ledger.pending).toBe(0);expect(f.service.summary().attachmentDraws).toEqual([]);expect(f.destroy).toHaveBeenCalledTimes(14);f.service.stop();expect(f.destroy).toHaveBeenCalledTimes(14);
 });
 it('decode迟到时关闭bitmap且不分配GPU，不污染下一Play身份',async()=>{
  let resolve!:(bitmap:ImageBitmap)=>void;const close=vi.fn();const f=setup({image:true,decode:()=>new Promise(r=>{resolve=r;})});await settle();expect(resolve).toBeTypeOf('function');
  f.service.stop();f.session.stop();resolve({close} as unknown as ImageBitmap);await settle();expect(close).toHaveBeenCalledOnce();expect(f.factory).not.toHaveBeenCalled();expect(f.session.ledger.pending).toBe(0);expect(f.service.view().visible).toBe(false);
  expect(f.session.play(f.doc).ok).toBe(true);expect(f.session.cycleCount).toBe(2);f.service.start(f.doc,f.session);f.service.stop();f.session.stop();expect(f.session.ledger.pending).toBe(0);
 });
 it('错误GUID和创建失败显式诊断，保留占位；Stop释放实际登记资源',async()=>{
  const bad=setup({badGuid:true});await settle();expect(bad.factory).not.toHaveBeenCalled();expect(bad.service.summary().diagnostics.join()).toContain('E_MODEL_GUID');expect(bad.service.view().visible).toBe(false);bad.service.stop();bad.session.stop();
  const broken=setup({failDraw:true});await settle();expect(broken.service.summary().diagnostics.join()).toContain('DRAW_FAILED');expect(broken.service.view().visible).toBe(false);broken.service.stop();broken.session.stop();expect(broken.destroy).toHaveBeenCalledTimes(7);expect(broken.session.ledger.pending).toBe(0);
 });
 it('缺骨socket/末端不一致不会使用前帧或选中骨来隐藏占位',async()=>{
  const f=setup();await settle();f.object.skeleton!.jointNames[f.object.skeleton!.jointNames.indexOf('RightHand')]='OtherHand';f.service.sync(f.session.runtime);
  expect(f.service.frameFor(f.doc.playerStart!,10)).toBeUndefined();expect(f.service.view().visible).toBe(false);expect(f.service.summary().diagnostics.join()).toContain('WEAPON_BONE');f.service.stop();f.session.stop();
 });
});
