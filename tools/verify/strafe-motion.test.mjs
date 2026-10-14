import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { strafeOptions, gaitEvidence, desktopStrafeEvidence, holdingEvidence, observationPlan, framingEvidence, STRAFE_SNAPSHOT, FRAMING_EXPRESSION } from './strafe-motion.mjs';
import { ProbeInput } from './weapon-assembly.mjs';

test('定向探针强制固定检出/HTTPS候选入口和完整HEAD，拒绝额外流程参数',()=>{
 const head='a'.repeat(40),options=strafeOptions(['--expected-head',head]);
 assert.ok(options.out.includes('strafe-motion'));assert.equal(options.expectedHead,head);
 assert.throws(()=>strafeOptions(['--expected-head','short']));
 assert.throws(()=>strafeOptions(['--expected-head',head,'--url','http://localhost:5100']));
 assert.throws(()=>strafeOptions(['--expected-head',head,'--all-weapons','true']));
});
test('Observation、暂停、无位移或没有相位循环不得通过真实横移证据',()=>{
 const samples=Array.from({length:8},(_,i)=>({state:'playing',observing:false,tick:i,fixedStep:1/30,player:{x:i*.15,z:0},actor:{clip:'walk_l',phase:[.2,.4,.7,.95,.15,.35,.6,.9][i],feet:[{local:[-.3,0,0],world:[-.3,.2,0]},{local:[.3,0,0],world:[.3,.2,0]}]}}));
 const evidence=gaitEvidence(samples,'walk_l');assert.equal(evidence.ok,true);assert.equal(evidence.wraps,1);assert.ok(Math.abs(evidence.meanSpeedMps-4.5)<1e-8);
 for(const change of [s=>({...s,observing:true}),s=>({...s,state:'paused'}),s=>({...s,player:{x:0,z:0}}),s=>({...s,actor:{...s.actor,phase:.2}})])assert.equal(gaitEvidence(samples.map(change),'walk_l').ok,false);
 assert.equal(gaitEvidence(samples,'walk_r').ok,false);
});
test('A/D/V/Esc使用真实Input并且release精确释放持有键',async()=>{
 const calls=[],input=new ProbeInput({send:async(method,params)=>{calls.push({method,params});}});
 await input.key('a',true);await input.key('d',true);await input.release();
 assert.deepEqual(calls.map(c=>[c.method,c.params.type,c.params.code]),[['Input.dispatchKeyEvent','keyDown','KeyA'],['Input.dispatchKeyEvent','keyDown','KeyD'],['Input.dispatchKeyEvent','keyUp','KeyA'],['Input.dispatchKeyEvent','keyUp','KeyD']]);
 assert.equal(input.held.size,0);
 await input.tap('v');await input.tap('escape');assert.deepEqual(calls.slice(4).map(c=>[c.params.type,c.params.code]),[['keyDown','KeyV'],['keyUp','KeyV'],['keyDown','Escape'],['keyUp','Escape']]);
});
test('无pointer横移证据必须同时证明实际actor面向、runtime yaw和正交位移',()=>{
 const samples=Array.from({length:8},(_,i)=>({state:'playing',observing:false,tick:i,fixedStep:1/30,player:{x:0,z:i*.15,yaw:0},authorPlayer:{quat:[0,Math.SQRT1_2,0,Math.SQRT1_2]},actor:{clip:'walk_r',phase:[.2,.4,.7,.95,.15,.35,.6,.9][i],feet:[{local:[-.3,0,0],world:[-.3,.2,0]},{local:[.3,0,0],world:[.3,.2,0]}]}}));
 assert.equal(desktopStrafeEvidence(samples,'walk_r',0).ok,true);
 for(const mutate of [s=>s.player.yaw=Math.PI/2,s=>s.authorPlayer.quat=[0,0,0,1],s=>{s.player.x=s.player.z;s.player.z=0;},s=>s.observing=true]){const bad=structuredClone(samples);bad.forEach(mutate);assert.equal(desktopStrafeEvidence(bad,'walk_r',0).ok,false);}
});
test('完整浏览器快照只使用实际公开的 motions.summary，作者态/Play态均可读取',async()=>{
 const identity=()=>Float32Array.from([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
 const names=['Hips','LeftFoot','RightFoot','LeftHand','RightHand'];
 const inverseBind=new Float32Array(5*16),skinScratch=new Float32Array(5*16);
 for(let i=0;i<5;i++){inverseBind.set(identity(),i*16);const m=identity();m[12]=i*.1;m[13]=.2;skinScratch.set(m,i*16);}
 const skinState={clips:[{name:'walk_l',duration:.6}],clip:-1,time:0};
 const object={nodeId:'player',removed:false,pos:[2,0,3],quat:[0,0,0,1],scale:1,visible:true,skinState,skeleton:{jointNames:names,normalization:identity(),inverseBind},skinScratch};
 const doc={playerStart:'player'},controller={state:'stopped',tick:0,observing:false,ledger:{pending:0},session:{runtime:null}};
 const layer={clip:'ready',time:.25,weight:1,nodes:[3,4],diagnostics:[]};let reads=0;
 // 与 main.ts 暴露的 wrapper 一致：没有类实例额外的 debugSnapshot 接口。
 const editor={playCtl:controller,camera:{yaw:0},params:{cameraElevation:0},renderer:{getDocument:()=>doc,worldToScreen:p=>({x:400+p[0]*100,y:500-p[1]*100,behind:false}),state:{objects:[object],frameCounter:7}},
   motions:{summary:()=>{reads++;return {pending:0,nodes:controller.state==='playing'?[{nodeId:'player',layer}]:[]};},setState:()=>{throw Error('禁止写入 motions');}},
   bodyIk:{summary:()=>({nodes:[]}),setWeight:()=>{throw Error('禁止写入 IK');}},weaponModels:{snapshot:()=>({visible:controller.state==='playing'})}};
 const context={window:{__editor:editor},crypto:webcrypto,TextEncoder,structuredClone};
 const author=await runInNewContext(STRAFE_SNAPSHOT,context);
 assert.equal(author.actor.clip,null);assert.equal(author.actor.layer,null);assert.equal(author.player,null);assert.equal(author.authorDocumentSha256.length,64);
 controller.state='playing';controller.tick=12;controller.session.runtime={fixedStep:1/30,player:()=>({x:2,z:3})};skinState.clip=0;skinState.time=.15;
 const play=await runInNewContext(STRAFE_SNAPSHOT,context);
 assert.equal(play.actor.clip,'walk_l');assert.equal(play.actor.phase,.25);assert.equal(play.actor.layer,layer);assert.equal(play.tick,12);assert.equal(play.fixedStep,1/30);
 assert.deepEqual(Array.from(play.actor.feet,p=>p.name),['LeftFoot','RightFoot']);assert.equal(play.actor.feet[0].world[0],2+skinScratch[28]);assert.equal(play.actor.hands.length,2);assert.equal(reads,2);
 const dom={getElementById:()=>null,querySelector:()=>({getBoundingClientRect:()=>({left:0,right:1440,top:80,bottom:1000,width:1440,height:920})}),querySelectorAll:()=>[]};
 const projection=await runInNewContext(FRAMING_EXPRESSION,{...context,document:dom,innerWidth:1440,innerHeight:1000,getComputedStyle:()=>({display:'block'})});
 assert.equal(projection.points.length,5);assert.equal(projection.uiRects.length,0);assert.ok(projection.bounds.left<projection.bounds.right);assert.equal(reads,3);
});
test('已声明手枪ready回退仍需本帧真实双手装配；其它诊断、旧frame、坏残差不能通过',()=>{
 const socket={position:[0,1,0],rotation:[0,0,0,1]},contract={requested:'pistol-idle',upper:'ready',dedicatedAvailable:false};
 const s={frame:4,actor:{clip:'walk_l',layer:{clip:'ready',weight:1,nodes:[1],diagnostics:['WEAPON_CLIP_MISSING: pistol-idle; base walk_l retained; procedural pose available only with configured IK']},
   hands:[{local:[0,1,0],world:[0,1,0]},{local:[.1,1,0],world:[.1,1,0]}],ik:{binding:{enabled:true,weight:1,controls:[{part:'leftHand',enabled:true,weight:1},{part:'rightHand',enabled:true,weight:1}]},diagnostics:[],attachment:{resolvedTarget:socket,result:socket,primary:{contact:socket,modelSocket:socket},dependent:{contact:socket,modelSocket:socket}}}},
   models:{visible:true,weaponId:'pistol',frameStamp:4,visibleDrawCount:2,pose:{action:'idle'},diagnostics:[],warnings:[],ikDiagnostics:[],attachmentDraws:[{frameStamp:4}],measurements:{rightTargetResidualM:1e-7,leftTargetResidualM:1e-7,rightOrientationResidualRad:1e-7,leftOrientationResidualRad:1e-7}}};
 assert.equal(holdingEvidence(s,contract).ok,true);assert.equal(holdingEvidence(s,contract).retainedDiagnostics.length,1);
 for(const change of [v=>v.actor.layer.diagnostics.push('NEW_FAILURE'),v=>v.models.frameStamp=3,v=>v.models.attachmentDraws[0].frameStamp=3,v=>v.models.measurements.leftTargetResidualM=.1,v=>v.actor.ik.binding.controls[0].enabled=false,v=>v.actor.ik.attachment.result=null,v=>v.actor.hands[0].world=null]){const bad=structuredClone(s);change(bad);assert.equal(holdingEvidence(bad,contract).ok,false);}
 assert.equal(holdingEvidence(s,{...contract,dedicatedAvailable:true}).ok,false);
});
test('全身观察计划从实际机位和actor朝向计算，输入有界；HUD遮腿或裁脚明确失败',()=>{
 const plan=observationPlan({camera:{yaw:-Math.PI/2,distance:1.8,elevationDeg:0},authorPlayer:{quat:[0,Math.SQRT1_2,0,Math.SQRT1_2]}});
 assert.equal(plan.desiredDistance,6.2);assert.ok(Math.abs(plan.dx)<530&&plan.wheelDelta>1000);assert.equal(plan.dy,80);
 const points=['Head','LeftLeg','RightLeg','LeftFoot','RightFoot'].map((name,i)=>({name,x:400+i*10,y:380+i*50,behind:false}));
 const projection={canvas:{left:0,right:1440,top:80,bottom:1000},points,bounds:{left:350,right:500,top:340,bottom:660},uiRects:[{left:540,right:885,top:640,bottom:900}],frontDot:Math.SQRT1_2};
 assert.equal(framingEvidence(projection).ok,true);
 assert.equal(framingEvidence({...projection,bounds:{...projection.bounds,right:560}}).ok,false);
 assert.equal(framingEvidence({...projection,bounds:{...projection.bounds,bottom:1001}}).ok,false);
 assert.equal(framingEvidence({...projection,frontDot:-1}).ok,false);
 assert.equal(framingEvidence({...projection,points:points.filter(p=>p.name!=='RightFoot')}).ok,false);
});
