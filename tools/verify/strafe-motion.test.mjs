import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strafeOptions, gaitEvidence } from './strafe-motion.mjs';
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
