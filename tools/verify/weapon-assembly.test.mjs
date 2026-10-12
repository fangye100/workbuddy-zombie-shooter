import {test} from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {editorSessionFlags} from './editor-smoke-lib.mjs';
import {probeOptions,profileOwners,ProbeInput,groundRayPoint,posedJointPosition,sceneReadinessExpression} from './weapon-assembly.mjs';
import {runInNewContext} from 'node:vm';
import {STATIC_SCENES,staticNodes} from './weapon-static.mjs';
const head='a'.repeat(40);
test('作者sceneId先到时拒绝陈旧Hierarchy或GLB占位；只有真实投影就绪才可Play',()=>{
 const doc={id:'trial',nodes:[{id:'player',name:'真实玩家',components:[{kind:'MeshRenderer',source:{type:'asset',ref:{path:'h01.glb'}}}]}]},object={nodeId:'player',name:'真实玩家',loadedAssetPath:'h01.glb'},button={disabled:false,getBoundingClientRect:()=>({x:10,y:10,width:50,height:30}),contains:()=>false};
 let row='Character';const renderer={getDocument:()=>doc,getSceneSource:()=>({url:'trial.json'}),pendingAssetCount:0,state:{objects:[object],frameCounter:6}};
 const context={window:{__editor:{renderer,playCtl:{state:'stopped',error:null}}},document:{querySelector:s=>s==='#btn-play'?button:{textContent:row},elementFromPoint:()=>button}};
 const read=()=>runInNewContext(sceneReadinessExpression(doc,'trial.json'),context);
 assert.equal(read().ok,false);row='真实玩家';object.loadedAssetPath=null;assert.equal(read().ok,false);
 object.loadedAssetPath='h01.glb';assert.equal(read().ok,true);renderer.pendingAssetCount=1;assert.equal(read().ok,false);
 renderer.pendingAssetCount=0;button.disabled=true;assert.equal(read().ok,false);
});
test('静态模式限制登记场景、唯一NodeId及编辑入口，拒绝混入Play选项',()=>{
 const args=['--expected-head',head,'--static-scene',STATIC_SCENES[1],'--nodes','nd_fit_smg_cut_0'];
 const options=probeOptions(args);assert.equal(new URL(options.url).searchParams.get('scene'),STATIC_SCENES[1]);assert.deepEqual(options.nodeIds,['nd_fit_smg_cut_0']);
 for(const extra of [['--all-weapons'],['--url','https://fangye-win11-office.tail6b29a2.ts.net:5198/?scene=assets/scenes/sandbox/weapon-assembly-trial.scene.json']])assert.throws(()=>probeOptions([...args,...extra]));
 assert.throws(()=>probeOptions(['--expected-head',head,'--static-scene',STATIC_SCENES[0]]));
 assert.throws(()=>probeOptions(['--expected-head',head,'--static-scene',STATIC_SCENES[0],'--nodes','nd_a,nd_a']));
 assert.throws(()=>probeOptions(['--expected-head',head,'--static-scene','assets/scenes/arbitrary.scene.json','--nodes','nd_a']));
 assert.throws(()=>staticNodes(process.cwd(),STATIC_SCENES[1],['nd_missing']),/不是候选资产/);
 assert.throws(()=>staticNodes(process.cwd(),STATIC_SCENES[1],['nd_cam0000']),/不是候选资产/);
 const actual=staticNodes(process.cwd(),STATIC_SCENES[1],options.nodeIds)[0];assert.equal(actual.id,'nd_fit_smg_cut_0');assert.match(actual.asset.sha256,/^[a-f0-9]{64}$/);
});
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
test('world yaw只选择真实pointer投影，角度/静态/冲突参数均拒绝',()=>{
 const args=['--expected-head',head];assert.equal(probeOptions(args).aimYaw,null);
 assert.equal(probeOptions([...args,'--aim-yaw','180','--side-aim-yaw','135']).sideAimYaw,135);
 for(const yaw of ['181','-181','NaN'])assert.throws(()=>probeOptions([...args,'--aim-yaw',yaw]));
 assert.throws(()=>probeOptions([...args,'--aim-yaw','180','--aim-ratio','.5,.7']),/同时/);
 assert.throws(()=>probeOptions([...args,'--static-scene',STATIC_SCENES[1],'--nodes','nd_fit_smg_cut_0','--aim-yaw','180']),/静态模式/);
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
test('七件模式仍用真实Digit keyDown/up，未传选项保留原流程',async()=>{
 assert.equal(probeOptions(['--expected-head',head]).allWeapons,false);assert.equal(probeOptions(['--expected-head',head,'--all-weapons']).allWeapons,true);
 const calls=[],input=new ProbeInput({async send(method,params){calls.push({method,params});}});for(const key of ['two','three','four','five','six'])await input.tap(key);
 assert.equal(calls.length,10);for(let i=0;i<5;i++){assert.equal(calls[i*2].params.code,'Digit'+(i+2));assert.equal(calls[i*2].params.windowsVirtualKeyCode,50+i);assert.equal(calls[i*2+1].params.type,'keyUp');}
});
