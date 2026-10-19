/** 真实 SharedMotion/Spine + 同帧 gameAim 的七件切换/攻击/换弹 CPU 探针；不认证 GPU 像素。 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {posedJointPosition} from '../verify/weapon-assembly.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const folder=path.join(root,'.workbuddy/tmp/wpn-integration');
fs.mkdirSync(folder,{recursive:true});
const bundle=path.join(folder,'motion-fit-api.mjs');
await build({stdin:{contents:"export * from './apps/editor/src/services/runtime-weapons';export * from './apps/editor/src/services/runtime-body-ik';export * from './apps/editor/src/services/runtime-scene-motion';export * from './apps/editor/src/services/shared-motion-runtime';export * from '@aether/scene';export * from '@aether/render';export * from '@aether/core';export * from '@aether/zombie-game';",resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:bundle,tsconfig:path.join(root,'tsconfig.check.json'),logLevel:'error'});
const api=await import(pathToFileURL(bundle).href);
const doc=read('assets/scenes/sandbox/weapon-assembly-trial.scene.json'),node=doc.nodes.find(n=>n.id===doc.playerStart),mesh=node.components.find(c=>c.kind==='MeshRenderer');
const asset=mesh.source.ref.path,meta=read(asset+'.meta.json'),bytes=fs.readFileSync(path.join(root,asset));
const model=api.parseGlb(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),meta.importer.normalizeHeightM,'y');
const object={pos:[...node.transform.position],quat:[0,0,0,1],scale:1,skeleton:model.skeleton,animations:[],skinState:api.createSkinState(model.skeleton,[]),removed:false,visible:true,loadedAssetPath:asset};
const session=new api.PlaySession();if(!session.play(doc).ok)throw new Error('trial Play失败');
const runtime=session.runtime,library=new api.SharedMotionRuntime(async p=>fs.readFileSync(path.join(root,p),'utf8'));
const motion=new api.RuntimeSceneMotion(library,id=>id===node.id?object:null);
let aim=null;
const ik=new api.RuntimeBodyIk(id=>id===node.id?object:null,async p=>read(p+'.meta.json'),()=>null,height=>aim?[aim[0],height,aim[1]]:null);
const models=new api.RuntimeWeapons({objectForNode:id=>id===node.id?object:null,meta:async p=>read(p+'.meta.json'),read:async p=>{const b=fs.readFileSync(path.join(root,p));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);},decode:async()=>({close(){}}),draw:()=>({draw:{visible:false,subMeshes:[]},setMatrix(){},dispose(){}})});
async function ready(service){const end=Date.now()+30000;while(service.summary().pending&&Date.now()<end)await new Promise(r=>setTimeout(r,10));const s=service.summary();if(s.pending||s.errors?.length)throw new Error(JSON.stringify(s));}
const samples=[];let stamp=0,motionEvidence;
function step(label,yaw,distance,moving=false){
 const before=runtime.player();aim=[before.x+distance*Math.cos(yaw),before.z+distance*Math.sin(yaw)];runtime.setAim(...aim);runtime.setInput(moving?.4*Math.cos(yaw):0,moving?.4*Math.sin(yaw):0);runtime.step();
 const player=runtime.player();object.pos=[player.x,node.transform.position[1],player.z];object.quat=[0,Math.sin((Math.PI/2-player.yaw)/2),0,Math.cos((Math.PI/2-player.yaw)/2)];
 motion.sync(runtime);ik.sync(runtime);models.sync(runtime);const frame=models.frameFor(node.id,++stamp);if(!frame)throw new Error(JSON.stringify(models.summary()));
 const scratch=new Float32Array((model.skeleton.joints.length+1)*16);api.evalJointMatrices(object.skinState,scratch,frame);const actor=api.mat4();api.composeQuat(actor,...object.pos,object.quat,object.scale);models.afterPose(node.id,actor,frame);
 const chains=model.skeleton.jointNames.flatMap((name,i)=>/(Left|Right)(Arm|ForeArm|Hand)$/.test(name)?[{name,position:posedJointPosition(scratch.slice(i*16,(i+1)*16),model.skeleton.normalization,model.skeleton.inverseBind.slice(i*16,(i+1)*16))}]:[]);
 const s=models.summary();samples.push({label,tick:runtime.tick,frame:stamp,yaw:player.yaw,aim,distance,moving,weapon:s.weaponId,pose:s.pose,request:structuredClone(object.skinState.bodyIk.attachment),chains,measurements:s.measurements,diagnostics:structuredClone(object.skinState.bodyIk.diagnostics),clip:object.skinState.clips[object.skinState.clip]?.name,upper:object.skinState.clips[object.skinState.poseLayer?.clip]?.name});
}
try{
 motion.start(doc);await ready(motion);motionEvidence=motion.summary();ik.start(doc);await ready(ik);models.start(doc,session);await ready(models);
 for(const distance of [1,4])for(const yaw of [0,Math.PI/2,Math.PI,-Math.PI/2]){
  runtime.reset();
  for(const definition of runtime.weapons.definitions){
   if(definition.id!==runtime.weapons.equippedId&&!runtime.equipWeapon(definition.id))throw new Error('equip未开始 '+definition.id);
   for(let i=0;i<32;i++)step('switch/aim',yaw,distance,i>=16);
   runtime.setFire(true);for(let i=0;i<12;i++)step('attack',yaw,distance,true);runtime.setFire(false);
   if(definition.ammo.reloadMode!=='none'){
    if(!runtime.reload())throw new Error('reload未开始 '+definition.id);
    for(let i=0;i<Math.ceil(definition.ammo.reloadSec/runtime.fixedStep)+2;i++)step('reload',yaw,distance,true);
   }
  }
 }
}finally{models.stop();ik.stop();motion.stop();session.stop();}
const failed=samples.filter(s=>s.diagnostics.some(d=>['IK_UNREACHABLE','IK_SOCKET_RESIDUAL','IK_ATTACHMENT'].includes(d.code))||s.measurements?.rightTargetResidualM>1e-4||s.measurements?.leftTargetResidualM>1e-4);
const max=(key,list=samples)=>Math.max(0,...list.map(s=>s.measurements?.[key]??0));
const out=path.join(folder,'seven-motion-fit.json');
const snapshot=Object.fromEntries(['tools/art/check-weapon-motion-fit.mjs','packages/zombie-game/src/presentation/game-controls.ts','packages/zombie-game/src/presentation/weapon-model.ts','apps/editor/src/services/runtime-weapons.ts','assets/scenes/sandbox/weapon-assembly-trial.scene.json'].map(p=>[p,createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex')]));
fs.writeFileSync(out,JSON.stringify({status:failed.length?'failed':'motion-phase-cpu-pass',baseHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),snapshot,limitations:['真实 retarget clips + 单次 base/Spine sample/IK；同帧XZ目标、四向1/4m距离、有限切枪/移动/攻击/换弹，非全姿态证明。','不包含DOM输入或GPU像素批准；旧bind探针独立保留。'],motion:motionEvidence,samples,failures:failed},null,2)+'\n');
console.log(JSON.stringify({samples:samples.length,failures:failed.length,maxRightM:max('rightTargetResidualM'),maxLeftM:max('leftTargetResidualM'),switchMaxLeftM:max('leftTargetResidualM',samples.filter(s=>s.label==='switch/aim')),firstFailures:failed.slice(0,5),out},null,2));
if(failed.length)process.exitCode=1;
