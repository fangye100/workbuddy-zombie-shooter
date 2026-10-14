import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { strafeOptions, gaitEvidence, STRAFE_SNAPSHOT } from './strafe-motion.mjs';
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
test('A/D使用真实Input并且release精确释放持有键',async()=>{
 const calls=[],input=new ProbeInput({send:async(method,params)=>{calls.push({method,params});}});
 await input.key('a',true);await input.key('d',true);await input.release();
 assert.deepEqual(calls.map(c=>[c.method,c.params.type,c.params.code]),[['Input.dispatchKeyEvent','keyDown','KeyA'],['Input.dispatchKeyEvent','keyDown','KeyD'],['Input.dispatchKeyEvent','keyUp','KeyA'],['Input.dispatchKeyEvent','keyUp','KeyD']]);
 assert.equal(input.held.size,0);
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
 const editor={playCtl:controller,camera:{yaw:0},renderer:{getDocument:()=>doc,state:{objects:[object],frameCounter:7}},
   motions:{summary:()=>{reads++;return {pending:0,nodes:controller.state==='playing'?[{nodeId:'player',layer}]:[]};},setState:()=>{throw Error('禁止写入 motions');}},
   bodyIk:{summary:()=>({nodes:[]}),setWeight:()=>{throw Error('禁止写入 IK');}},weaponModels:{snapshot:()=>({visible:controller.state==='playing'})}};
 const context={window:{__editor:editor},crypto:webcrypto,TextEncoder,structuredClone};
 const author=await runInNewContext(STRAFE_SNAPSHOT,context);
 assert.equal(author.actor.clip,null);assert.equal(author.actor.layer,null);assert.equal(author.player,null);assert.equal(author.authorDocumentSha256.length,64);
 controller.state='playing';controller.tick=12;controller.session.runtime={fixedStep:1/30,player:()=>({x:2,z:3})};skinState.clip=0;skinState.time=.15;
 const play=await runInNewContext(STRAFE_SNAPSHOT,context);
 assert.equal(play.actor.clip,'walk_l');assert.equal(play.actor.phase,.25);assert.equal(play.actor.layer,layer);assert.equal(play.tick,12);assert.equal(play.fixedStep,1/30);
 assert.deepEqual(Array.from(play.actor.feet,p=>p.name),['LeftFoot','RightFoot']);assert.equal(play.actor.feet[0].world[0],2+skinScratch[28]);assert.equal(play.actor.hands.length,2);assert.equal(reads,2);
});
