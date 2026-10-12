import {test} from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {editorSessionFlags} from './editor-smoke-lib.mjs';
import {probeOptions,profileOwners,ProbeInput,groundRayPoint,posedJointPosition,sceneReadinessExpression,aimPointExpression,groundMovementDirection,captureWithoutMovement,attackEvidence,reloadEvidence,reloadMoment,recoveryMoment} from './weapon-assembly.mjs';
import {runInNewContext} from 'node:vm';
import {STATIC_SCENES,staticNodes} from './weapon-static.mjs';
const head='a'.repeat(40);
test('03b SMG短fire漏采仍需本轮同武器shot配对、弹药和真实后坐；历史事件不能通过',()=>{
 const def={id:'smg',ammo:{reloadMode:'magazine'}},event={sequence:40,tick:640,weaponId:'smg',action:'fire',clip:'shoot'},before={weaponEvents:[{...event,sequence:39,tick:630}],weapons:{states:[{id:'smg',magazine:32}]}},sample={frame:1264,firing:true,weaponEvents:[event],lastShot:{tick:640},weapons:{states:[{id:'smg',magazine:31}]},models:{pose:{action:'idle',recoil:{pitchDeg:8,translation:[-.055,0,0]}}},actor:{layer:{clip:'idle'}}};
 assert.equal(attackEvidence(before,[sample],def).ok,true);assert.deepEqual(attackEvidence(before,[sample],def).fireFrames,[]);
 assert.equal(attackEvidence({...before,weaponEvents:[event]},[sample],def).ok,false);
 assert.equal(attackEvidence(before,[{...sample,lastShot:{tick:641}}],def).ok,false);
 assert.equal(attackEvidence(before,[{...sample,weaponEvents:[{...event,weaponId:'pistol'}]}],def).ok,false);
 assert.equal(attackEvidence(before,[{...sample,models:{pose:{action:'idle',recoil:{pitchDeg:0,translation:[0,0,0]}}}}],def).ok,false);
});
test('03b Shotgun归槽idle有效，但必须有同帧draw、离槽位移及实际slot回位',()=>{
 const m=y=>[1,0,0,0,0,1,0,0,0,0,1,0,0,y,0,1],s=(frame,removed,y,action='reload',phase=.3)=>({frame,authorPlayer:{pos:[0,0,0],quat:[0,0,0,1],scale:1},models:{visible:true,pose:{action,phase},attachmentDraws:[{id:'shell',frameStamp:frame,removed,worldMatrix:m(y)}]}});
 const before=s(1100,false,1.25,'idle'),out=s(1114,true,1.2),back=s(1139,false,1.25,'idle'),p={magazineOutPhase:.2,magazineInPhase:.65};
 assert.equal(reloadEvidence(before,[out,back],'shell').ok,true);assert.equal(reloadEvidence(before,[out,back],'shell').inAction,'idle');
 assert.equal(reloadMoment(back,'shell',p,'in',true),true);assert.equal(reloadMoment(back,'shell',p,'in',false),false);
 assert.equal(reloadEvidence(before,[out,s(1139,false,1.23,'idle')],'shell').ok,false);
 back.models.attachmentDraws[0].frameStamp=1138;assert.equal(reloadEvidence(before,[out,back],'shell').ok,false);
});
test('聚焦武器选择保留真实七键映射，不将未选武器视为本次通过',()=>{
 const args=['--expected-head',head,'--weapon','shotgun,flame,launcher'];const o=probeOptions(args);assert.deepEqual(o.weaponIds,['shotgun','flame','launcher']);assert.equal(o.allWeapons,true);
 for(const ids of ['shotgun,shotgun','missing',','])assert.throws(()=>probeOptions(['--expected-head',head,'--weapon',ids]));
 assert.throws(()=>probeOptions([...args,'--all-weapons']));assert.throws(()=>probeOptions([...args,'--static-scene',STATIC_SCENES[0],'--nodes','nd_a']));
});
test('回程采样不能将晚段漏采、历史idle或尚未结束的ready crossfade算作通过',()=>{
 const sample=(action,phase,transition=null)=>({state:'playing',frame:20,models:{visible:true,frameStamp:20,weaponId:'launcher',pose:{action,phase}},actor:{layer:{clip:action==='reload'?'reload':'ready',weight:1,transition}}});
 const late=sample('reload',.94444),later=sample('reload',.975),idle=sample('idle',0,{elapsed:.02,duration:.18}),ready=sample('idle',0);
 const entry={...late,models:{...late.models,pose:{...late.models.pose,phase:1/6}}};
 assert.equal(recoveryMoment(entry,'entry',true,'reload'),true);
 assert.equal(recoveryMoment({...entry,models:{...entry.models,pose:{...entry.models.pose,phase:.139}}},'entry',true,'reload'),false);
 assert.equal(recoveryMoment({...entry,models:{...entry.models,pose:{...entry.models.pose,phase:.181}}},'entry',true,'reload'),false);
 assert.equal(recoveryMoment(idle,'entry',false,'idle'),false);
 assert.equal(recoveryMoment(late,'late90',true,'reload'),true);assert.equal(recoveryMoment(later,'late90',true,'reload'),false);
 assert.equal(recoveryMoment(later,'late95',true,'reload'),true);assert.equal(recoveryMoment(idle,'late95',true,'reload'),false);
 assert.equal(recoveryMoment(idle,'firstIdle',true,'reload'),true);assert.equal(recoveryMoment(idle,'firstIdle',true,'idle'),false);assert.equal(recoveryMoment(idle,'firstIdle',false,'reload'),false);
 assert.equal(recoveryMoment(idle,'upperReady',true,'idle'),false);assert.equal(recoveryMoment(ready,'upperReady',true,'idle'),true);
 ready.models.frameStamp=19;assert.equal(recoveryMoment(ready,'upperReady',true,'idle'),false);
 const args=['--expected-head',head];assert.equal(probeOptions(args).launcherRecovery,false);
 assert.equal(probeOptions([...args,'--weapon','shotgun,smg,launcher','--launcher-recovery']).launcherRecovery,true);
 for(const ids of ['shotgun,smg','pistol,shotgun,smg,launcher'])assert.throws(()=>probeOptions([...args,'--weapon',ids,'--launcher-recovery']),/1–3件/);
 assert.throws(()=>probeOptions([...args,'--launcher-recovery']),/1–3件/);
});
test('真实3370射线在CSS client空间通过；越界/遮挡/平面误差分别保留证据',()=>{
 const player={x:0,z:-5.600001811981201},canvas={width:2000,height:1600,getBoundingClientRect:()=>({left:50,top:70,right:1050,bottom:870,width:1000,height:800})};
 const ray={o:[-.041666709157595176,1.1644444310304083,-3.9000018119829294],d:[-.3807105842999634,-.14213154549535018,-.9137056827978491]},ground={id:'ground',parent:null,transform:{position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]},components:[{kind:'MeshRenderer',source:{type:'builtin',shape:'plane',params:[80,24]}}]};
 let hit=canvas;const context={devicePixelRatio:2,innerWidth:1440,innerHeight:1000,structuredClone,document:{querySelector:()=>canvas,elementFromPoint:()=>hit},window:{__editor:{camera:{yaw:0},playCtl:{tick:139,session:{runtime:{player:()=>player}}},renderer:{state:{frameCounter:273},getDocument:()=>({nodes:[ground]}),worldToScreen:()=>({x:299.01163873947115,y:650.174050328452,behind:false}),pointerRay:()=>ray}}}};
 const read=()=>runInNewContext(aimPointExpression(180),context),accepted=read();
 assert.equal(accepted.ok,true);assert.ok(accepted.aimErrorM<1e-4);assert.equal(accepted.dpr,2);assert.equal(accepted.canvasRect.left,50);assert.equal(accepted.groundBounds.minZ,-12);
 // Translate actor, camera and the original ray together: projection still agrees,
 // but the authored physical ground no longer contains the intersection.
 player.z-=1;ray.o[2]-=1;const outside=read();assert.equal(outside.ok,false);assert.deepEqual(Array.from(outside.reasons),['ground-outside-authored-bounds']);assert.ok(outside.ground[2]<-12);assert.equal(outside.tick,139);
 hit={tagName:'DIV',id:'hud',className:'overlay'};const occluded=read();assert.ok(occluded.reasons.includes('pointer-ui-occluded'));assert.equal(occluded.actualElement.id,'hud');
 ray.o[0]+=.002;assert.ok(read().reasons.includes('aim-projection-mismatch'));
 ray.d[1]=0;const parallel=read();assert.ok(parallel.reasons.includes('ground-ray-no-forward-hit'));assert.ok(parallel.reasons.includes('aim-plane-no-forward-hit'));
});
test('地面实际余量通过真实W/S换向保持，旋转相机使用同一screenMovement约定',()=>{
 const point={ground:[-3.1607232013486843,0,-11.385739691119685],groundBounds:{minX:-40,maxX:40,minZ:-12,maxZ:12},camera:{yaw:0}};
 assert.equal(groundMovementDirection(point,'w'),'s');assert.equal(groundMovementDirection(point,'s'),'s');
 point.camera.yaw=Math.PI/2;point.ground=[-39.5,0,0];assert.equal(groundMovementDirection(point,'w'),'s');
 point.ground=[0,0,0];assert.equal(groundMovementDirection(point,'w'),'w');
 point.groundBounds={minX:-.1,maxX:.1,minZ:-.1,maxZ:.1};assert.throws(()=>groundMovementDirection(point,'w'),/余量不足/);
});
test('截图期间真实释放移动键但保留鼠标；成功恢复输入，失败不恢复移动',async()=>{
 const calls=[],input=new ProbeInput({async send(method,params){calls.push({method,params});}});
 await input.key('w',true);await input.pointer({x:50,y:60},true);
 const resume=name=>input.key(name,true);
 await captureWithoutMovement(input,async()=>{assert.equal(input.held.size,0);assert.ok(input.mouse);},resume);
 assert.equal(input.held.has('w'),true);assert.equal(calls.at(-2).params.type,'keyUp');assert.equal(calls.at(-1).params.type,'keyDown');
 await assert.rejects(captureWithoutMovement(input,async()=>{throw new Error('capture timeout');},resume),/capture timeout/);
 assert.equal(input.held.size,0);assert.equal(calls.at(-1).params.type,'keyUp');await input.release();
 assert.ok(calls.every(c=>c.method.startsWith('Input.')));
});
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
