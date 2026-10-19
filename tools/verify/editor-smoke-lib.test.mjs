import {test} from 'node:test';
import assert from 'node:assert/strict';
import {waitForEditorReady,reloadEditor,readSceneExpectation,readLodSmokeFixture,isHardwareGpu,Cdp,editorSessionFlags} from './editor-smoke-lib.mjs';
import path from 'node:path';

test('合并后保留专属profile与严格TLS选项，headed不启用软件GPU',()=>{
  const profile='.workbuddy/tmp/merge-main-20261020/chrome-profile';
  const flags=editorSessionFlags({cdpPort:9343,headed:true,appUrl:'https://test/',userDataDir:profile,ignoreCertificateErrors:false});
  assert.ok(flags.includes(`--user-data-dir=${path.resolve(profile)}`));
  assert.ok(!flags.some(f=>/headless|swiftshader|ignore-certificate-errors/.test(f)));
});

const state=()=>({timeOrigin:2,url:'https://test/?scene=fixture',fatal:null,source:{url:'/fixture.scene.json'},pending:0,frames:60,assets:true,preview:true,width:600,height:300});
test('就绪须经过新文档、正确场景、资产完成、服务绑定及出帧，早期hook不足以通过',async()=>{
  const ready=state(),states=[{...ready,timeOrigin:1},{...ready,source:{url:'/old.scene.json'}},{...ready,pending:2},{...ready,frames:0},{...ready,assets:false},{...ready,preview:false},ready];let calls=0;
  const cdp={eval:async()=>states[Math.min(calls++,states.length-1)]};
  assert.equal(await waitForEditorReady(cdp,{afterTimeOrigin:1,expectedScene:'fixture.scene.json',interval:0}),ready);
  assert.equal(calls,7);
});
test('超时抛错并保留最后pending/fps/source诊断；fatal不等待超时也不报成功',async()=>{
  const stalled={...state(),pending:5};
  await assert.rejects(waitForEditorReady({eval:async()=>stalled},{timeout:0,interval:0}),/"pending":5/);
  await assert.rejects(waitForEditorReady({eval:async()=>({...state(),fatal:'asset loader failed'})},{timeout:10000,interval:0}),/asset loader failed/);
});
test('reload记录旧代次和场景，明确Page.reload后仍须等新代次',async()=>{
  let call=0;const sent=[];const cdp={eval:async()=>++call===1?{time:1,scene:'/fixture.scene.json'}:state(),send:async(...args)=>sent.push(args)};
  const result=await reloadEditor(cdp);assert.equal(result.timeOrigin,2);assert.deepEqual(sent,[['Page.reload']]);
});
test('正式场景重名物件仍由NodeId保留独立pickable；白盒满足父子结构与容量前提',()=>{
  const real=readSceneExpectation('assets/scenes/act1/floor-1.scene.json');
  const duplicate=real.nodes.filter(n=>n.name==='P-02 · 水泥路障');assert.ok(duplicate.length>1);assert.equal(new Set(duplicate.map(n=>n.id)).size,duplicate.length);assert.ok(new Set(duplicate.map(n=>n.pickable)).size>1);
  const fixture=readSceneExpectation('assets/scenes/sandbox/editor-smoke.scene.json');
  assert.ok(fixture.nodes.some(n=>n.id==='nd_smoke_parent'));assert.ok(fixture.nodes.some(n=>n.id==='nd_smoke_child'));assert.ok(fixture.objects<60);assert.equal(fixture.spawnPoints,1);
});
test('LOD夹具由发布清单/sidecar选档，不能固定index0并继续加载未交接源模',()=>{
  const {low,high}=readLodSmokeFixture();assert.ok(high.tris>low.tris*2);assert.notEqual(high.path,low.path);assert.ok(low.path.endsWith('.glb'));assert.ok(Number.isInteger(high.index));
});

test('CDP eval卡死也必须有界超时',async()=>{
  await assert.rejects(waitForEditorReady({eval:()=>new Promise(()=>{})},{timeout:20}),/超时/);
});
test('硬件验收拒绝缺失、未知、fallback和软件设备，只认实际device信息',()=>{
  const real={secure:true,fallback:false,info:{vendor:'nvidia',architecture:'lovelace',description:''}};
  assert.equal(isHardwareGpu(real),true);
  for(const bad of [null,{...real,info:null},{...real,fallback:undefined},{...real,fallback:true},{...real,secure:false},{...real,info:{description:'SwiftShader'}}])assert.equal(isHardwareGpu(bad),false);
});

test('CDP命令超时、断连及发送异常都释放pending并拒绝，而不是悬挂整个聚合',async()=>{
  const listeners=new Map(),ws={addEventListener:(name,fn)=>listeners.set(name,fn),send:()=>{}};
  const cdp=new Cdp(ws,'probe',{timeoutMs:10});
  await assert.rejects(cdp.send('Runtime.evaluate'),/超时/);assert.equal(cdp.pending.size,0);
  const pending=cdp.send('Page.captureScreenshot');listeners.get('close')();
  await assert.rejects(pending,/连接关闭/);assert.equal(cdp.pending.size,0);
  ws.send=()=>{throw new Error('broken send');};
  await assert.rejects(cdp.send('Page.reload'),/broken send/);assert.equal(cdp.pending.size,0);
});
