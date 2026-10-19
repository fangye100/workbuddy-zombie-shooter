/** 正式Act1场景原生输入验收。只观察模拟；不搬运/生成/伤害实体，不保存场景。 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {makeArgParser,launchEditorSession,waitFor,createRecorder} from './editor-smoke-lib.mjs';
import {verifyImpactVisibility} from './vfx-m2-pixels.mjs';
// 原shared helper的历史全局TLS开关不进入本探针网络请求；探活仅用其单请求回退。
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
const {arg,has}=makeArgParser(process.argv);
if(!has('headed'))throw Error('本机必须 --headed');
if(arg('only','') && !['pistol','shotgun','smg','sniper','chainsaw','flame','launcher'].includes(arg('only','')))throw Error('--only武器ID非法');
const out=path.resolve(arg('out','.workbuddy/tmp/vfx-gameplay-integration/development'));
fs.mkdirSync(out,{recursive:true});
const port=Number(arg('cdp','9343'));
const occupied=await new Promise(r=>{const s=net.connect(port,'127.0.0.1');s.once('connect',()=>{s.destroy();r(true);});s.once('error',()=>r(false));});
if(occupied)throw Error(`CDP ${port} 已占用`);
const url='https://fangye-win11-office.tail6b29a2.ts.net:5100/';
if(!(await fetch(url,{signal:AbortSignal.timeout(8000)})).ok)throw Error('必须复用已核对来源的detached5100');
const {check,results}=createRecorder();
const scenes=[1,2,3].map(n=>`assets/scenes/act1/floor-${n}.scene.json`);
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const evidence={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),checks:results,sceneHashes:Object.fromEntries(scenes.map(p=>[p,hash(p)])),floors:[]};
evidence.verificationSources=Object.fromEntries([...new Set(['tools/verify/vfx-gameplay-probe.mjs','tools/verify/editor-smoke-lib.mjs','tools/verify/vfx-m2-pixels.mjs','apps/editor/src/services/play-vfx.ts','packages/zombie-game/src/presentation/vfx-planner.ts','packages/zombie-game/src/presentation/combat-overlay.ts','packages/zombie-game/src/presentation/combat-ink.ts',...fs.readdirSync('assets/vfx').filter(p=>/\.(svg|vfx\.json)$/.test(p)).map(p=>'assets/vfx/'+p)])].map(p=>[p,hash(p)]));
const {chrome,cdp,ws}=await launchEditorSession({chromePath:arg('chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),cdpPort:port,headed:true,appUrl:url,windowSize:'1500,1000',userDataDir:arg('profile','.workbuddy/tmp/vfx-gameplay-integration/chrome-profile')});
const send=cdp.send.bind(cdp);cdp.send=(method,params={})=>Promise.race([send(method,params),new Promise((_,r)=>{const t=setTimeout(()=>r(Error(method+' timeout')),15000);t.unref();})]);
// 同一宿主/相机下仅给本测试tab投影精确基线的场景和VFX字节，用于全景风格对照。
// 游戏事实仍由原生输入产生；不作为同输入/同tick性能基准，也不修改磁盘资产。
const comparisonBase=arg('compare-base','');
if(comparisonBase){
 if(!/^[0-9a-f]{40}$/.test(comparisonBase))throw Error('compare-base必须为完整commit');
 evidence.comparisonBase=comparisonBase;evidence.projectedSources={};evidence.comparisonCurrentSources={};
 // 预载发生在Play之前；不能在每次纹理请求里同步启动git拖慢真实战斗。
 const basePaths=execFileSync('git',['ls-tree','-r','--name-only',comparisonBase,'--','assets/vfx'],{encoding:'utf8'}).trim().split('\n');
 const cache=new Map([...basePaths,...scenes].map(p=>[p,execFileSync('git',['show',`${comparisonBase}:${p}`])]));
 ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Fetch.requestPaused' && m.sessionId===cdp.sessionId)void (async()=>{const p=new URL(m.params.request.url).searchParams.get('path'),bytes=cache.get(p);if(!bytes){await cdp.send('Fetch.continueRequest',{requestId:m.params.requestId});return;}evidence.projectedSources[p]=createHash('sha256').update(bytes).digest('hex');evidence.comparisonCurrentSources[p]=fs.existsSync(p)?hash(p):null;await cdp.send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:p.endsWith('.svg')?'image/svg+xml':'application/json'}],body:bytes.toString('base64')});})().catch(error=>check('基线投影',false,String(error)));});
 await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*__fs/file?path=*',requestStage:'Request'}]});
}
const click=async selector=>{await cdp.send('Page.bringToFront');const p=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('control '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});};
const key=(type,k,code,vk)=>cdp.send('Input.dispatchKeyEvent',{type,key:k,code,windowsVirtualKeyCode:vk});
const press=async n=>{await cdp.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');if(await cdp.eval(`!!document.querySelector('.run-hud.choosing .talent-choices button')`))await click('.talent-choices button');await click('#center .weapon-select');await key('keyDown','Home','Home',36);await key('keyUp','Home','Home',36);for(let i=1;i<n;i++){await key('keyDown','ArrowDown','ArrowDown',40);await key('keyUp','ArrowDown','ArrowDown',40);}await key('keyDown','Enter','Enter',13);await key('keyUp','Enter','Enter',13);};
const snap=()=>cdp.eval(`(()=>{const r=window.__editor.playCtl.session.runtime,c=window.__editor.renderer.core;return {vfx:window.__editor.vfx.snapshot().play,tick:r?.tick,run:r?.runId,outcome:r?.outcome,weapon:r?.weapons.active.id,selector:(()=>{const s=document.querySelector('#center .weapon-select');return s?{value:s.value,text:s.selectedOptions[0]?.textContent,disabled:s.disabled,switching:r?.weapons.switching}:null})(),actors:r?.view(),burning:r?.weaponCombat.burning,effects:r?.enemyAttacks.effects,ledger:window.__editor.playCtl.ledger,error:window.__editor.playCtl.error,diagnostics:window.__editor.playCtl.diagnostics,camera:{viewProj:[...c.viewProj],eye:[...c.eyeVec],viewport:[innerWidth,innerHeight,devicePixelRatio]},button:{disabled:document.querySelector('#btn-play').disabled,state:window.__editor.playCtl.state}};})()`);
const capture=async name=>{await cdp.send('Page.bringToFront');await cdp.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const s=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(s.data,'base64'));};
const aim=async()=>{const p=await cdp.eval(`(()=>{const r=window.__editor.playCtl.session.runtime,p=r.player(),a=r.view().filter(a=>a.kind==='npc'&&a.alive).sort((a,b)=>Math.hypot(a.x-p.x,a.z-p.z)-Math.hypot(b.x-p.x,b.z-p.z))[0];return a?window.__editor.renderer.worldToScreen([a.x,r.weaponMount.position[1],a.z]):null;})()`);if(p && !p.behind)await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y});};
const stop=async record=>{await key('keyUp','j','KeyJ',74);await click('#btn-stop');record.stopped=await snap();check(record.floor+' Stop账目归零及真实GPU销毁',record.stopped.ledger.pending===0 && record.stopped.vfx.gpu===null && record.stopped.vfx.lastReleased.destroyedBuffers>=2 && record.stopped.vfx.lastReleased.destroyedTextures===15);};
try{
 for(const floor of (arg('only','')?[1]:[1,2,3])){
  await cdp.send('Page.navigate',{url:`${url}?scene=${encodeURIComponent(scenes[floor-1])}`});
  if(!await waitFor(()=>cdp.eval(`window.__editor?.renderer.getDocument()?.id==='sc_act1_floor${floor}' && !!window.__editor.vfx && window.__editor.renderer.pendingAssetCount===0 && !!window.__editor.renderer.getSceneSource()`),{timeout:60000}))throw Error('场景/GLB补载未完成');
  await cdp.eval(`localStorage.setItem('zh.ui.dockH','180');document.documentElement.style.setProperty('--dock-h','180px');document.getElementById('asset-dock')?.classList.add('collapsed');window.dispatchEvent(new Event('resize'));`);
  await click('#btn-play');
  evidence.startState=await snap();
  check(floor+' 七武器及实战标签15纹理完整加载',await waitFor(()=>cdp.eval(`(()=>{const s=window.__editor.vfx.snapshot().play;return s.ready.length===7 && s.continuous.ready.length===15 && s.ribbon.ready.length===1 && s.gpu.textures===15;})()`),{timeout:15000}));
  const record={floor,initial:await snap(),phases:[]};evidence.floors.push(record);
  check(floor+' 保持初始pistol且无预算/资源失败',record.initial.weapon==='pistol' && record.initial.vfx.diagnostics.every(s=>s.includes('兼容读取')));
  if(!evidence.gpu)evidence.gpu=await cdp.eval(`(()=>{const a=window.__editor.renderer.core.device.adapterInfo;return {secure:isSecureContext,info:{vendor:a?.vendor,architecture:a?.architecture},fallback:a?.isFallbackAdapter};})()`);
  // 自然NPC攻击，原玩家原位置，不直接调用strike或改波次。
  if(floor===3){const natural=await waitFor(async()=>{const s=await snap();return s.vfx.ribbon.trails.some(t=>t.key.includes(':charge-ribbon:')&&t.points.length>10)?s:null;},{timeout:10000,interval:25});record.natural=natural;check('三层真实盾卫冲锋Ribbon',!!natural);if(natural){await click('#btn-pause');record.charge=await snap();await capture('floor3-charge');const trail=record.charge.vfx.ribbon.trails.find(t=>t.key.includes(':charge-ribbon:'));record.ribbonVisible=await verifyImpactVisibility(cdp,out,trail.points[Math.floor(trail.points.length/2)].position,'floor3-ribbon-visible',{filterRibbonIncludes:':charge-ribbon:'});check('三层冲锋Ribbon局部GPU可见',record.ribbonVisible.passed);if(has('style-sequence')){record.chargeSequence=[record.charge];for(const frame of [1,2]){for(let step=0;step<10;step++)await click('#btn-step');record.chargeSequence.push(await snap());await capture(`floor3-charge-${frame}`);}check('自然冲锋原生UI单步20tick连续帧',record.chargeSequence[2].tick===record.chargeSequence[0].tick+20);}await click('#btn-pause');}}
  for(const [number,id] of (floor===1?[[1,'pistol'],[2,'shotgun'],[3,'smg'],[4,'sniper'],[6,'flame'],[5,'chainsaw'],[7,'launcher']].filter(([,id])=>!arg('only','') || id===arg('only','')):[[1,'pistol']])){
   // 每种武器从原关卡新Play开始，避免前种武器击杀后的成长模态改变后续输入条件。
   if(record.phases.length){await stop({floor:`${floor}/${record.phases.at(-1).id}`});await click('#btn-play');if(!await waitFor(()=>cdp.eval(`window.__editor.vfx.snapshot().play.ready.length===7 && window.__editor.vfx.snapshot().play.gpu?.textures===15`),{timeout:15000}))throw Error('重开纹理未就绪');}
   await press(number);
   if(!await waitFor(()=>cdp.eval(`window.__editor.playCtl.session.runtime.weapons.active.id===${JSON.stringify(id)} && document.querySelector('#center .weapon-select').value===${JSON.stringify(id)} && !window.__editor.playCtl.session.runtime.weapons.switching`),{timeout:2500,interval:20}))throw Error('原生下拉框切枪失败 '+id);
   record.selected=await snap();await aim();await key('keyDown','j','KeyJ',74);
   const state=await waitFor(async()=>{await aim();const s=await snap();if(s.outcome!=='running')return null;return (id==='flame'?s.vfx.continuous.instances.filter(p=>p.key.includes(':flame:')).length>=16 && (s.burning?.length>0 || has('compile-only')):id==='chainsaw'?s.vfx.continuous.instances.some(p=>p.key.includes(':slash:')):id==='launcher'?s.vfx.continuous.instances.some(p=>p.key.includes(':projectile:') || p.key.includes(':weapon-explosion:')):s.vfx.events.some(e=>e.weaponId===id && e.kind==='trace'&&e.contact!=='miss'))?s:null;},{timeout:4000,interval:25});
   await click('#btn-pause');await key('keyUp','j','KeyJ',74);const paused=await snap();record.phases.push({id,triggered:!!state,selected:record.selected,state:paused});
   check(floor+' '+id+' 原生输入产生真实GPU事实',!!state && paused.vfx.gpu.draws>0);
   record.phases.at(-1).camera=await cdp.eval(`(()=>{const c=window.__editor.renderer.core;return {viewProj:[...c.viewProj],eye:[...c.eyeVec],viewport:[innerWidth,innerHeight,devicePixelRatio]};})()`);
   await capture(`floor${floor}-${id}`);
   const flame=paused.vfx.continuous.instances.filter(p=>p.key.includes(':flame:'))[4];
   const point=flame?flame.position.map((v,i)=>v+(flame.velocity?.[i]??0)*flame.age):paused.vfx.events.findLast(e=>e.weaponId===id&&e.kind==='trace'&&e.contact!=='miss')?.to;
   if(point && floor===1 && ['pistol','flame'].includes(id)){record.phases.at(-1).visible=await verifyImpactVisibility(cdp,out,point,`floor${floor}-${id}-visible`);check(id+' 实际关卡GPU局部可见',record.phases.at(-1).visible.passed);}
   await click('#btn-pause');
   if(floor===1 && id==='sniper' && !arg('only','')){
    check('真实击杀后强化模态出现',await waitFor(()=>cdp.eval(`!!document.querySelector('.run-hud.choosing .talent-choices button')`),{timeout:2500}));
    record.choiceBefore=await snap();await click('.talent-choices button');await cdp.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await aim();const sequence=record.choiceBefore.vfx.events.at(-1)?.sequence??0;
    await key('keyDown','j','KeyJ',74);check('原生选择强化后继续真实战斗',await waitFor(()=>cdp.eval(`!window.__editor.playCtl.session.runtime.progress.choosing && window.__editor.vfx.snapshot().play.events.some(e=>e.sequence>${sequence})`),{timeout:2500,interval:25}));await key('keyUp','j','KeyJ',74);record.choiceAfter=await snap();
   }
  }
  await stop(record);
 }
 check('HTTPS真实NVIDIA非fallback',evidence.gpu.secure && evidence.gpu.info.vendor==='nvidia' && evidence.gpu.fallback===false);
 evidence.consoleErrors=cdp.consoleErrors;evidence.exceptions=cdp.exceptions;check('无浏览器或GPU错误',!cdp.consoleErrors.length && !cdp.exceptions.length);
 check('正式场景未被验收写回',scenes.every(p=>hash(p)===evidence.sceneHashes[p]));
}catch(error){evidence.failure=String(error);check('执行完成',false,String(error));await capture('failure').catch(()=>{});}finally{await key('keyUp','j','KeyJ',74).catch(()=>{});await cdp.eval(`window.__editor?.playCtl.isPlaying && document.querySelector('#btn-stop')?.click()`).catch(()=>{});fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(evidence,null,2));ws.close();chrome.kill();}
process.exitCode=results.some(r=>!r.ok)?1:0;
