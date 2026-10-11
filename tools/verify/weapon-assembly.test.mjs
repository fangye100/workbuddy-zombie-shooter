import {test} from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {editorSessionFlags} from './editor-smoke-lib.mjs';
import {probeOptions,profileOwners,ProbeInput,groundRayPoint,posedJointPosition} from './weapon-assembly.mjs';
const head='a'.repeat(40);
test('本任务严格TLS headed参数不绕证书；旧调用默认保持',()=>{
 const flags=editorSessionFlags({cdpPort:9348,headed:true,appUrl:'https://example.test',ignoreCertificateErrors:false});
 assert.ok(!flags.includes('--ignore-certificate-errors'));assert.ok(!flags.some(f=>f.includes('headless')||f.includes('swiftshader')));
 assert.ok(editorSessionFlags({cdpPort:9348,headed:true,appUrl:'https://example.test'}).includes('--ignore-certificate-errors'));
 assert.throws(()=>probeOptions([]),/expected-head/);assert.throws(()=>probeOptions(['--expected-head',head,'--url','https://localhost:5198']),/MagicDNS/);
 assert.throws(()=>probeOptions(['--expected-head',head,'--hold-ms','90000']),/有界/);assert.throws(()=>probeOptions(['--expected-head',head,'--out','assets/evidence']),/证据/);
});
test('瞄准比例必须有界，未指定保持旧默认；地面射线拒绝平行/背向',()=>{
 const args=['--expected-head',head];assert.equal(probeOptions(args).aimRatio,null);
 assert.deepEqual(probeOptions([...args,'--aim-ratio','.4,.7']).aimRatio,[.4,.7]);
 for(const ratio of ['0,.5','.5,1','NaN,.5','.5',''])assert.throws(()=>probeOptions([...args,'--aim-ratio',ratio]));
 assert.equal(groundRayPoint({o:[0,2,0],d:[1,0,0]},0),null);
 assert.equal(groundRayPoint({o:[0,2,0],d:[0,1,0]},0),null);
 assert.deepEqual(groundRayPoint({o:[0,2,0],d:[1,-1,2]},0),[2,0,4]);
});
test('只读链位置恢复 inverse-bind 原点，支持旋转及归一化尺度',()=>{
 const skin=[1,0,0,0,0,1,0,0,0,0,1,0,.1,.2,.3,1];
 const norm=[.01,0,0,0,0,.01,0,0,0,0,.01,0,0,0,0,1];
 // inverseBind = inverse(rotateZ90 + position[10,20,30]).
 const ib=[0,-1,0,0,1,0,0,0,0,0,1,0,-20,10,-30,1];
 assert.deepEqual(posedJointPosition(skin,norm,ib),[.2,.4,.6]);
 assert.equal(posedJointPosition(skin,norm,new Array(16).fill(0)),null);
});
test('profile归属精确匹配，不混淆别的Chrome目录',()=>{
 const profile=path.resolve('.workbuddy/tmp/chrome-profile');
 assert.deepEqual(profileOwners([{ProcessId:1,CommandLine:`chrome --user-data-dir="${profile}"`},{ProcessId:2,CommandLine:`chrome --user-data-dir="${profile}-other"`}],profile).map(p=>p.ProcessId),[1]);
});
test('中途输入失败仍尝试释放持有按键与鼠标，不注入runtime',async()=>{
 const calls=[];let fail=true;const cdp={async send(method,params){calls.push({method,params});if(params.type==='mousePressed'&&fail){fail=false;throw new Error('input failure');}}};
 const input=new ProbeInput(cdp);await input.key('w',true);await assert.rejects(input.pointer({x:50,y:60},true),/input failure/);assert.deepEqual(await input.release(),[]);
 assert.equal(calls.at(-2).params.type,'keyUp');assert.equal(calls.at(-2).params.code,'KeyW');assert.equal(calls.at(-1).params.type,'mouseReleased');assert.ok(calls.every(c=>c.method.startsWith('Input.')));
 await input.pointer({x:50,y:60},true);await input.move({x:55,y:65});assert.equal(calls.at(-1).params.type,'mouseMoved');assert.equal(calls.at(-1).params.buttons,1);
 await input.release();assert.equal(calls.at(-1).params.x,55);assert.equal(calls.at(-1).params.y,65);
});
