/** 七武器真实模型装配数据：源测量点经配方转到实际parser空间，保留核心玩法和单一phase。 */
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {fileURLToPath,pathToFileURL} from 'node:url';import {build} from 'esbuild';
import { holdSlotBasePosition } from '../level/weapon-hold-slots.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),check=process.argv.includes('--check');
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8')),write=(p,d)=>{const text=JSON.stringify(d,null,2)+'\n';if(!fs.existsSync(path.join(root,p))||fs.readFileSync(path.join(root,p),'utf8')!==text)fs.writeFileSync(path.join(root,p),text);};
const sha=b=>createHash('sha256').update(b).digest('hex');
const bundle=path.join(root,'.workbuddy/tmp/wpn-integration/calibrate-full-scene.mjs');
await build({stdin:{contents:"export * from '@aether/scene'; export * from '@aether/render';",resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:bundle,tsconfig:path.join(root,'tsconfig.check.json'),logLevel:'error'});
const api=await import(pathToFileURL(bundle).href),I=[0,0,0,1],plusY=[0,Math.SQRT1_2,0,Math.SQRT1_2],minusY=[0,-Math.SQRT1_2,0,Math.SQRT1_2],plusX=[Math.SQRT1_2,0,0,Math.SQRT1_2];
const socket=(position,rotation=I)=>({position,rotation:[...rotation]});
const mul=(a,b)=>{const[x,y,z,w]=a,[X,Y,Z,W]=b;return[w*X+x*W+y*Z-z*Y,w*Y-x*Z+y*W+z*X,w*Z+x*Y-y*X+z*W,w*W-x*X-y*Y-z*Z];};
const valid=(p,d)=>{const errs=d.filter(x=>x.severity==='error');if(errs.length)throw new Error(p+': '+JSON.stringify(errs));};
const evidence='94c68a1 原源headed11视图；source point-surface区段测量；本轮final parse数值候选，GPU手掌/槽口未批准';
const bodyDefs={
 shotgun:{id:'WPN-02-SHOTGUN',primary:[0,.17,-.285],support:[0,.22,.17],muzzle:[0,.255,.548],magazine:[.025,.17,-.12],chamber:[.028,.245,-.12]},
 smg:{id:'WPN-03-SMG',variant:'WPN-03-SMG-without-mag',primary:[.12,.145,0],support:[-.35,.33,0],muzzle:[-.568,.36,0],magazine:[-.18,.30,0],chamber:[-.12,.37,.035]},
 sniper:{id:'WPN-04-SNIPER',primary:[.12,.105,0],support:[-.30,.205,0],muzzle:[-.605,.235,0],magazine:[-.105,.175,0],chamber:[-.01,.235,.035]},
 chainsaw:{id:'WPN-05-CHAINSAW',primary:[.43,.145,-.045],support:[.035,.37,-.045],muzzle:[-.61,.2,-.045],magazine:[.19,.3,-.045],chamber:[.19,.3,-.045]},
 flame:{id:'WPN-06-FLAME',variant:'WPN-06-FLAME-without-can',primary:[.04,.215,0],support:[-.24,.22,0],muzzle:[-.60,.415,0],magazine:[.19,.265,0],chamber:[.05,.41,.035]},
};
const variants=['WPN-03-SMG-without-mag','WPN-06-FLAME-without-can','WPN-MAG-02-SMG-fit','WPN-MAG-02-SNIPER-derived','WPN-FUEL-01-fit-can','WPN-SHELL-01-primer-fixed','WPN-07-LAUNCHER-round-derived'];
const owner=aid=>aid.startsWith('WPN-03-')?'WPN-03-SMG':aid.startsWith('WPN-06-')?'WPN-06-FLAME':aid.startsWith('WPN-FUEL')?'WPN-FUEL-01':aid.startsWith('WPN-SHELL')||aid.startsWith('WPN-07')?'WPN-SHELL-01':'WPN-MAG-02-SMG';
const refs=new Map(),parsed=new Map();
function get(file,data){
 const bytes=fs.readFileSync(path.join(root,file)),side=file+'.meta.json',exists=fs.existsSync(path.join(root,side)),hash=sha(bytes);
 if(check&&!exists)throw new Error(side+': 缺meta');
 const meta=exists?read(side):api.createDefaultAssetMeta('as_'+sha(Buffer.from(file)).slice(0,12),'gltf');
 if(exists&&meta.sourceHash!=='sha256:'+hash)throw new Error(side+': hash失配，拒绝覆盖');
 if(!exists){meta.sourceHash='sha256:'+hash;meta.userData={...data,variant:'game_ready',file:path.basename(file),status:'visual-review-candidate'};}
 const model=api.parseGlb(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),meta.importer.normalizeHeightM,meta.importer.upAxisFlip?'z':'y');
 if(meta.importer.normalizeHeightM!==null||meta.importer.upAxisFlip||model.skeleton)throw new Error(file+': 刚性米制模型配置不符');
 const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];for(let i=0;i<model.mesh.vertices.length;i+=api.VERTEX_FLOATS)for(let k=0;k<3;k++){low[k]=Math.min(low[k],model.mesh.vertices[i+k]);high[k]=Math.max(high[k],model.mesh.vertices[i+k]);}
 const item={file,asset:{path:file,guid:meta.guid},meta,sha256:hash,boundsMin:low,boundsMax:high,triangles:model.triangles};refs.set(file,item.asset);parsed.set(file,item);
 return item;
}
function setSockets(item,sockets){
 if(check){if(JSON.stringify(item.meta.modelSockets)!==JSON.stringify(sockets))throw new Error(item.file+': sockets漂移');}
 else{item.meta.modelSockets=structuredClone(sockets);valid(item.file,api.validateAssetMeta(item.meta));write(item.file+'.meta.json',item.meta);}
}
for(const aid of variants){
 const own=owner(aid),report=read(`assets/art/models/${own}/${aid}-fit-report.json`);
 if(report.sourceHash!==sha(fs.readFileSync(path.join(root,report.source))))throw new Error('派生原source过期');
 for(const l of report.levels){const file=`assets/art/models/${own}/game_ready/${l.file}`,item=get(file,{assetId:aid,source:report.source,sourceHash:report.sourceHash,report:`assets/art/models/${own}/${aid}-fit-report.json`,calibrationSpace:'parseGlb final import-space metre'});if(item.sha256!==l.hash||item.triangles!==l.triangles)throw new Error('派生文件/hash统计失配');
  if(aid.includes('without-'))continue;
  const h=item.boundsMax[1];let ss;
  if(aid==='WPN-FUEL-01-fit-can')ss={insertion:socket([0,h*.91,item.boundsMax[2]*.73]),primaryGrip:socket([0,h*.46,0]),base:socket([0,h*.4,item.boundsMin[2]])};
  else if(aid==='WPN-07-LAUNCHER-round-derived'){const factor=report.ergonomicNormalization?.factor??1;ss={insertion:socket([item.boundsMax[0]-.001*factor,h*.5,0]),primaryGrip:socket([item.boundsMin[0]+.035*factor,h*.5,0]),base:socket([item.boundsMin[0],h*.5,0])};}
  else ss={insertion:socket([0,h-.001,0]),primaryGrip:socket([0,h*.42,0]),base:socket([0,0,0])};
  setSockets(item,ss);
 }
}
const calibration=read('assets/art/calibration/weapon-assembly-trial.json');calibration.bodyIntegration={status:'calibrated-candidate-awaiting-headed',evidence,definitions:{}};
const prototype=read('assets/weapons/prototype.weapons.json');
for(const [weapon,data] of Object.entries(bodyDefs)){
 const report=read(`assets/art/models/${data.id}/lod-report.json`),variantReport=data.variant?read(`assets/art/models/${data.id}/${data.variant}-fit-report.json`):null;
 const qSource=report.recipe.rotationDeg[1]===90?plusY:I,scale=report.scaleXYZ[0];let main;
 for(const l of (variantReport??report).levels){
  const file=`assets/art/models/${data.id}/game_ready/${l.file}`,item=parsed.get(file)??get(file,{assetId:data.id});
  const finalPoint=p=>api.rotateVec3(qSource,p).map((n,k)=>(n-report.originRotatedSource[k])*scale-l.parserRecenterMeters[k]);
  const ss=Object.fromEntries(['primary','support','muzzle','magazine','chamber'].map((key,i)=>[['primaryGrip','supportGrip','muzzle','magazine','chamber'][i],socket(finalPoint(data[key]),minusY)]));
  setSockets(item,ss);if(l.level===0)main=item;
 }
 const w=prototype.definitions.find(w=>w.id===weapon),ss=main.meta.modelSockets;
 // holdPose是模型root；用理想主握接触点反推root，不能把root本身当手的位置。
 // H01 bind姿态四向原Z=.12时，长枪support越界55/78mm；回收root，不改实际握把socket或骨长。
 const desired=[-.03,weapon==='smg'?1.34:1.25,['shotgun','sniper'].includes(weapon)?.015:.12],hold=socket(desired.map((n,k)=>n-ss.primaryGrip.position[k]),plusY);
 const holdSlot=w.presentation.assembly?.holdSlot;
 w.presentation.model=main.asset;w.presentation.assembly={holdPose:hold,...(holdSlot?{holdSlot:structuredClone(holdSlot)}:{}),attachments:[],reloadAttachmentId:null};
 calibration.bodyIntegration.definitions[weapon]={asset:main.asset,sha256:main.sha256,boundsMin:main.boundsMin,boundsMax:main.boundsMax,modelSockets:ss,sourceNodeBakedPoints:data,holdPose:hold,idealPrimaryContactActor:desired,holdCalibration:['shotgun','sniper'].includes(weapon)?{priorActorContactZ:.12,priorBindLeftResidualM:weapon==='shotgun'?.05511691:.07830725,change:'模型root向身体回收.105m；保留实际primary/support位置，GPU全动作/轮廓未验'}:weapon==='smg'?{priorActorContactY:1.25,priorBindReloadLeftResidualM:.03398582,intermediateActorContactY:1.30,intermediateBindReloadLeftResidualM:.00657699,change:'新SMG模型root上移.09m，降低卸下弹匣目标肩距；保留原源socket，GPU仍待验'}:null,evidence};
}
const attach=(weapon,aid,parent,desiredRotation=I)=>{
 const w=prototype.definitions.find(w=>w.id===weapon),file=`assets/art/models/${owner(aid)}/game_ready/${aid}_lod0.glb`,child=parsed.get(file),a=w.presentation.assembly;
 if(!child)throw new Error('缺派生child');
 const parentSockets=read(w.presentation.model.path+'.meta.json').modelSockets;
 const offsetRotation=mul(api.inverseRotation(parentSockets[parent].rotation),desiredRotation);
 a.attachments=[{id:'reloadPart',model:child.asset,parentSocket:parent,childSocket:'insertion',offset:socket([0,0,0],offsetRotation)}];a.reloadAttachmentId='reloadPart';
};
attach('smg','WPN-MAG-02-SMG-fit','magazine');attach('sniper','WPN-MAG-02-SNIPER-derived','magazine');attach('shotgun','WPN-SHELL-01-primer-fixed','magazine',plusX);attach('flame','WPN-FUEL-01-fit-can','magazine');
// Launcher实际+X前孔装填；旧-.365落在实心后盖，不能作为装配槽。
// 物理socket在各LOD真正parser空间；动作frame为Game约定的模型局部delta，不是H01绝对点。
const launcher=prototype.definitions.find(w=>w.id==='launcher'),launcherReport=read('assets/art/models/WPN-07-LAUNCHER/lod-report.json');
const reference=launcherReport.levels[0].parserRecenterMeters,factor=launcherReport.ergonomicNormalization?.factor;
if(factor!==.9)throw new Error('先执行Launcher/round一致0.90归一化后处理');
// 这些已经是最终模型局部米；entry解析增量不能再乘factor。
const actionFrames={reloadPose:socket([.165,.035,-.298],plusY),reloadExtract:socket([.1611,-.036,0]),reloadClearance:socket([.13457441181107344,.126,0]),reloadReturnClearance:socket([0,.072,.036])};
for(const l of launcherReport.levels){
 const item=get(`assets/art/models/WPN-07-LAUNCHER/game_ready/${l.file}`,{assetId:'WPN-07-LAUNCHER'});
 const delta=reference.map((v,k)=>v-l.parserRecenterMeters[k]),point=p=>p.map((v,k)=>v+delta[k]);
 const physical=Object.fromEntries(Object.entries({primaryGrip:[-.222,.074,-.02],supportGrip:[-.08,.213,-.07],muzzle:[.375,.28,0],magazine:[.197,.28,0],chamber:[.197,.28,0]}).map(([key,p])=>[key,socket(p.map(n=>n*factor))]));
 setSockets(item,{...Object.fromEntries(Object.entries(physical).map(([key,s])=>[key,socket(point(s.position),s.rotation)])),...actionFrames});
}
launcher.presentation.lengthM=.675;launcher.presentation.assembly.holdPose=socket([-.31,1.20,.245]);delete launcher.presentation.assembly.sockets;
const launcherChild=parsed.get('assets/art/models/WPN-SHELL-01/game_ready/WPN-07-LAUNCHER-round-derived_lod0.glb');
launcher.presentation.assembly.attachments=[{id:'reloadPart',model:launcherChild.asset,parentSocket:'magazine',childSocket:'base',offset:socket([0,0,0])}];launcher.presentation.assembly.reloadAttachmentId='reloadPart';
const historicalLauncher=calibration.launcherFrontLoading?.historicalCandidateEvidence??calibration.launcherFrontLoading;
calibration.launcherFrontLoading={status:'0.90-candidate-awaiting-actual-entry-late-idle-headed',space:'physical sockets: LOD final import-space metres; action frames: model-local delta metres/xyzw',
 sourceHash:launcherReport.sourceHash,source:launcherReport.source,physicalLod0:read(launcher.presentation.model.path+'.meta.json').modelSockets,
 holdPose:launcher.presentation.assembly.holdPose,actionFrames,
 ergonomicNormalization:launcherReport.ergonomicNormalization,
 evidence:{rawTarget:'f5ac7bbd7c8c771e2a3273009cf32142371b819b',raw:'front-loading-focused-audit/observations.json',frontCavityAxisX:[.1129507*factor,.375*factor],rearSolidCapX:-.3750396*factor,roundLengthM:.1774375*factor,roundRadiusM:.0248765*factor,
 physicalGripBeforeUniform:{primary:[-.222,.074,-.02],primarySectionSideZ:[-.022944953,.022878806],support:[-.08,.213,-.07],supportSectionSideZ:[-.070791675,.070847284],supportSideBottomY:.212891712},
 rawShoulderSamples:423,handFailures:0,minimumRightMarginM:.01973628378332737,minimumLeftMarginM:.015582230223028737,
 geometryFrames:[1101,2299,2376,2137,2413,2417,2427],gunAndRoundTriangleHits:0,reverseParityInsideSamples:0,maximumBaselineChainReplayErrorM:2.0768505227202066e-7,
 entry:{frame:2299,phase:1/6,previousGunTriangleHits:152,blockedForwardDistanceM:.030034995159463423,gapM:.001,sinCoefficient:.2306158707424476,clearanceLocalXDeltaM:.13457441181107344,allowedLocalXDeltaM:[0,.20414512337934]},
 rawReports:['launcher-actual-reach-f5.json','launcher-current-grip-section.json','launcher-current-shoulders-candidate.json','launcher-entry-clearance-interval.json','launcher-entry-separation.json','launcher-actual-geometry-f5.json']},
 historicalCandidateEvidence:historicalLauncher,
 limits:['423真实同帧肩球而非理想骨姿；纯reach规划不替代新Input','仅7个无transition几何代表态；其他crossfade与全路径未证明clear','H01 whole-skin parity未认证闭合；零交面/反向点不是GPU像素批准','round仅统一缩放，UV/法线/索引/纹理/cap不变；底火仍待用户新版Shell源']};
for(const w of prototype.definitions){
 const a=w.presentation.assembly,ss={...read(w.presentation.model.path+'.meta.json').modelSockets,...a.sockets};
 if(a.holdSlot){calibration.holdSlots??={};calibration.holdSlots[w.id]=structuredClone(a.holdSlot);}
 // yaw=0 actorWorld RY+90；scene独立markers存模拟空间，绝非GLB local点。
  const rootWorld=socket(api.rotateVec3(plusY,holdSlotBasePosition(a,calibration.holdSlotReference)),a.holdPose.rotation),m=api.composeSocket(rootWorld,ss.muzzle).position;
 calibration.simulationCalibration.zeroRecoilActorMuzzle[w.id]=m;
}
const scenes=['assets/scenes/sandbox/weapon-assembly-trial.scene.json',...['1','2','3'].map(n=>`assets/scenes/act1/floor-${n}.scene.json`)];
for(const file of scenes){
 const doc=read(file),actor=doc.nodes.find(n=>n.id===doc.playerStart),rules=doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules');
 for(const w of rules.arsenal.definitions){const next=prototype.definitions.find(p=>p.id===w.id),slot=w.presentation.assembly?.holdSlot;w.presentation.model=structuredClone(next.presentation.model);w.presentation.assembly=structuredClone(next.presentation.assembly);if(slot)w.presentation.assembly.holdSlot=structuredClone(slot);if(w.id==='launcher')w.presentation.lengthM=next.presentation.lengthM;const a=w.presentation.assembly,ss={...read(w.presentation.model.path+'.meta.json').modelSockets,...a.sockets};const m=api.composeSocket(socket(api.rotateVec3(plusY,holdSlotBasePosition(a,calibration.holdSlotReference)),a.holdPose.rotation),ss.muzzle).position;w.presentation.markers.muzzle.position=[m[0],m[1]+actor.transform.position[1]-calibration.simulationCalibration.capsuleHalfM,m[2]];}
 const deps=rules.arsenal.definitions.flatMap(w=>[w.presentation.model.path,...w.presentation.assembly.attachments.map(a=>a.model.path)]);doc.dependencies=[...new Set([...doc.dependencies,...deps])];
 if(file.includes('sandbox/')){const cameraNode=doc.nodes.find(n=>n.id===doc.entryCamera),camera=cameraNode.components.find(c=>c.kind==='Camera');camera.distance=1.8;camera.pitchDeg=0;camera.yawOffsetDeg=-90;cameraNode.transform.position[1]=1.18;const note='五本体新LOD与去重复几何的附件fit候选；近Camera只试验场景，GPU七武器/实际离回槽待验。';if(!doc.meta.notes.includes(note))doc.meta.notes+=' '+note;}
 valid(file,api.validateSceneDocument(doc));if(check){const old=read(file);if(JSON.stringify(old.nodes)!==JSON.stringify(doc.nodes)||JSON.stringify(old.dependencies)!==JSON.stringify(doc.dependencies))throw new Error(file+': assembly/markers漂移');}else write(file,doc);
}
for(const w of prototype.definitions){const m=calibration.simulationCalibration.zeroRecoilActorMuzzle[w.id];w.presentation.markers.muzzle.position=[m[0],m[1]+calibration.simulationCalibration.referenceActorY-calibration.simulationCalibration.capsuleHalfM,m[2]];if(!api.validWeaponDefinition(w))throw new Error(w.id+': 非法武器装配');}
if(check){const saved=read('assets/art/calibration/weapon-assembly-trial.json');if(JSON.stringify(saved.bodyIntegration)!==JSON.stringify(calibration.bodyIntegration)||JSON.stringify(saved.simulationCalibration)!==JSON.stringify(calibration.simulationCalibration)||JSON.stringify(saved.launcherFrontLoading)!==JSON.stringify(calibration.launcherFrontLoading))throw new Error('calibration漂移');if(JSON.stringify(read('assets/weapons/prototype.weapons.json'))!==JSON.stringify(prototype))throw new Error('prototype漂移');}
else{write('assets/art/calibration/weapon-assembly-trial.json',calibration);write('assets/weapons/prototype.weapons.json',prototype);}
console.log(JSON.stringify({weapons:prototype.definitions.map(w=>({id:w.id,model:w.presentation.model,attachments:w.presentation.assembly.attachments.length,muzzle:calibration.simulationCalibration.zeroRecoilActorMuzzle[w.id]})),scenes,status:'assembly-candidate-awaiting-headed-fit'},null,2));
