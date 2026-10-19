/** Act1真实输入验收：只读模拟快照指导键鼠，不生成/伤害/搬运实体，不改场景。 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {makeArgParser,ensureServer,launchEditorSession,waitFor,createRecorder,sleep} from './editor-smoke-lib.mjs';
import {verifyImpactVisibility} from './vfx-m2-pixels.mjs';
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
const {arg,has}=makeArgParser(process.argv);
if(!has('headed'))throw Error('本机必须 --headed');
if(!['','acid','explosion'].includes(arg('only','')))throw Error('--only 仅支持 acid/explosion');
const out=path.resolve(arg('out','.workbuddy/tmp/vfx-acid-explosion/development'));
fs.mkdirSync(out,{recursive:true});
const port=Number(arg('cdp','9343'));
const badPool=has('bad-pool'),textures=badPool?13:14;
if(await new Promise(r=>{const s=net.connect(port,'127.0.0.1');s.once('connect',()=>{s.destroy();r(true);});s.once('error',()=>r(false));}))throw Error('任务CDP已占用');
const {server,url}=await ensureServer(5100,'apps/editor/vite.config.ts');
if(server)throw Error('必须复用已核对来源的5100');
const {check,results}=createRecorder();
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const scenes=[2,3].map(n=>`assets/scenes/act1/floor-${n}.scene.json`);
const sources=['tools/verify/vfx-acid-explosion-probe.mjs','tools/verify/editor-smoke-lib.mjs','tools/verify/vfx-m2-pixels.mjs','packages/zombie-game/src/session.ts','packages/zombie-game/src/enemy-attacks.ts','packages/zombie-game/src/presentation/enemy-vfx-planner.ts','apps/editor/src/services/play-vfx.ts',...scenes,...fs.readdirSync('assets/vfx').filter(p=>/\.(svg|vfx\.json)$/.test(p)).map(p=>'assets/vfx/'+p)];
const evidence={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),checks:results,sourceHashes:Object.fromEntries(sources.map(p=>[p,hash(p)])),routes:[]};
const {chrome,cdp,ws}=await launchEditorSession({chromePath:arg('chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),cdpPort:port,headed:true,appUrl:url,windowSize:'1500,1000',userDataDir:arg('profile','.workbuddy/tmp/vfx-acid-explosion/chrome-profile')});
const send=cdp.send.bind(cdp);cdp.send=(m,p={})=>Promise.race([send(m,p),new Promise((_,r)=>{const t=setTimeout(()=>r(Error(m+' timeout')),15000);t.unref();})]);
// 失败回归仅使本测试tab的指定纹理解码失败；不覆盖关卡，不制造攻击。
if(badPool){
 evidence.failureInjection={path:'assets/vfx/comic-acid-pool.svg',method:'test-tab-only invalid SVG response',requests:0};
 ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Fetch.requestPaused'&&m.sessionId===cdp.sessionId)void(async()=>{const p=new URL(m.params.request.url).searchParams.get('path');if(p===evidence.failureInjection.path){evidence.failureInjection.requests++;await cdp.send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'image/svg+xml'}],body:Buffer.from('invalid SVG for bounded fallback verification').toString('base64')});}else await cdp.send('Fetch.continueRequest',{requestId:m.params.requestId});})().catch(error=>check('失败注入请求处理',false,String(error)));});
 await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*__fs/file?path=*',requestStage:'Request'}]});
}
const key=(type,k)=>cdp.send('Input.dispatchKeyEvent',{type,key:k,code:/^[0-9]$/.test(k)?'Digit'+k:'Key'+k.toUpperCase(),windowsVirtualKeyCode:k.toUpperCase().charCodeAt(0)});
const held=new Set();
async function hold(keys){for(const k of [...held])if(!keys.includes(k)){await key('keyUp',k);held.delete(k);}for(const k of keys)if(!held.has(k)){await key('keyDown',k);held.add(k);}}
const click=async selector=>{await cdp.send('Page.bringToFront');const p=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('control '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});};
const frames=()=>cdp.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
const snap=()=>cdp.eval(`(()=>{const p=window.__editor.playCtl,r=p.session.runtime,c=window.__editor.renderer.core;return {tick:r?.tick,run:r?.runId,outcome:r?.outcome,paused:p.state,player:r?.player(),actors:r?.view().map(a=>({...a,windup:r.table.windupRemain[a.id]})),effects:r?.enemyAttacks.effects,pendingAttackEvents:r?.enemyAttacks.events.length,vfx:window.__editor.vfx.snapshot().play,progress:r?.progress?{kills:r.progress.kills,choosing:r.progress.choosing,choices:r.progress.choices,stacks:[...r.progress.stacks],scrap:r.progress.scrap}:null,weapon:r?{id:r.weapons.active.id,state:r.weapons.state,reload:r.weapons.reloadRemaining}:null,sessionEvents:r?.sessionEvents,ledger:p.ledger,diagnostics:p.diagnostics,camera:{eye:[...c.eyeVec],viewProj:[...c.viewProj],viewport:[innerWidth,innerHeight,devicePixelRatio]}};})()`);
async function capture(name){await frames();await cdp.send('Page.bringToFront');const s=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(s.data,'base64'));}
async function pause(){await hold([]);await click('#btn-pause');await frames();}
async function resume(){await click('#btn-pause');await frames();}
async function step(n=1){for(let i=0;i<n;i++)await click('#btn-step');await frames();}
async function aim(x,z){const q=await cdp.eval(`window.__editor.renderer.worldToScreen([${x},window.__editor.playCtl.session.runtime.weaponMount.position[1],${z}])`);if(!q.behind)await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:q.x,y:q.y});}
async function equip(n){await frames();await hold([]);await key('keyDown',String(n));await key('keyUp',String(n));await frames();}
async function choose(record,s){if(!s.progress.choosing)return false;await hold([]);if(!await waitFor(()=>cdp.eval(`!!document.querySelector('.run-hud.choosing .talent-choices button')`),{timeout:2000,interval:20}))throw Error('强化UI未就绪');const choices=s.progress.choices,index=choices.findIndex(c=>c.effect==='leech');const i=index>=0?index:choices.findIndex(c=>c.effect==='damage');await click(`.talent-choices button:nth-of-type(${Math.max(0,i)+1})`);await frames();record.choices.push({tick:s.tick,offered:choices,selected:Math.max(0,i),after:(await snap()).progress});return true;}
// 原Camera yaw=-15°，逐次只读玩家位置后选8方向中最接近目标的原生WASD。
function movement(p,target){const dx=target[0]-p.x,dz=target[1]-p.z;if(Math.hypot(dx,dz)<.45)return [];const yaw=-Math.PI/12,c=Math.cos(yaw),s=Math.sin(yaw);const opts=[['d',1,0],['a',-1,0],['w',0,-1],['s',0,1],['dw',1,-1],['ds',1,1],['aw',-1,-1],['as',-1,1]];return [...opts.sort((a,b)=>((b[1]*c+b[2]*s)*dx+(-b[1]*s+b[2]*c)*dz)/Math.hypot(b[1],b[2])-((a[1]*c+a[2]*s)*dx+(-a[1]*s+a[2]*c)*dz)/Math.hypot(a[1],a[2]))[0][0]];}
async function load(floor){await cdp.send('Page.navigate',{url:`${url}?scene=${encodeURIComponent(`assets/scenes/act1/floor-${floor}.scene.json`)}`});if(!await waitFor(()=>cdp.eval(`window.__editor?.renderer.getDocument()?.id==='sc_act1_floor${floor}' && window.__editor.renderer.pendingAssetCount===0 && !!window.__editor.renderer.getSceneSource()`),{timeout:60000}))throw Error('场景未就绪');await cdp.eval(`localStorage.setItem('zh.ui.dockH','180');document.documentElement.style.setProperty('--dock-h','180px');document.getElementById('asset-dock')?.classList.add('collapsed');window.dispatchEvent(new Event('resize'));`);await click('#btn-play');if(!await waitFor(()=>cdp.eval(`window.__editor.vfx.snapshot().play.enemy.ready.includes('enemy.explode') && window.__editor.vfx.snapshot().play.enemy.ready.includes('enemy.acid.flight') && window.__editor.vfx.snapshot().play.gpu?.textures===${textures}`),{timeout:15000}))throw Error('VFX未就绪');}
async function stop(record){await hold([]);await click('#btn-stop');record.stopped=await snap();check(record.kind+` Stop释放${textures}纹理/Play账目归零`,record.stopped.ledger.pending===0 && record.stopped.vfx.gpu===null && record.stopped.vfx.lastReleased.destroyedTextures===textures && record.stopped.vfx.lastReleased.destroyedBuffers>=2);}
function identity(e){return {id:e.id,runId:e.runId,source:e.source,generation:e.generation,startTick:e.startTick};}
function same(a,b){return a.id===b.id && a.runId===b.runId && a.source===b.source && a.generation===b.generation;}
async function lifecycle(record,attack){
 record.attack=identity(attack);const id=attack.id,run=attack.runId,key=`enemy:${run}:${id}:`;
 record.selected=attack;
 record.source=record.kind==='acid'?record.wave2.actors.find(a=>a.id===attack.source&&a.generation===attack.generation):record.sourceBefore;
 const doc=JSON.parse(fs.readFileSync(scenes[record.floor-2])),spawn=doc.nodes.find(n=>n.id===record.source.sourceNodeId),component=spawn.components.find(c=>c.kind==='SpawnPoint');
 record.origin={actor:record.source,sourceNodeId:spawn.id,roomNodeId:spawn.parent,spawner:component,waveEvents:record.initial.sessionEvents.concat(record.wave2?.sessionEvents??record.windup.sessionEvents)};
 check(record.kind+' 来源是原关卡指定房间/波次',record.source.characterId===(record.kind==='acid'?'E-03':'E-05')&&record.source.sourceNodeId===(record.kind==='acid'?'nd_f2r0_sp2':'nd_f3r1_sp1') && spawn.parent===(record.kind==='acid'?'nd_f2r0':'nd_f3r1') && component.wave===(record.kind==='acid'?2:1));
 // 全部单步都走原暂停工具栏，禁止调用runtime.step。
 let s=await snap();record.phaseStart=s;await capture(record.kind+'-start');
 const frozen=s.tick;await sleep(120);check(record.kind+' 暂停生命周期冻结',(await snap()).tick===frozen);
 if(record.kind==='acid'){
  record.flight=s;record.flightVisible=await verifyImpactVisibility(cdp,out,attack.position,'acid-flight',{filterIncludes:key+'enemy.acid.flight'});check('酸液飞行真实GPU可见',record.flightVisible.passed);
  for(let n=0;n<70;n++){s=await snap();const e=s.effects.find(e=>same(e,attack));if(e?.phase==='pool'){record.pool=s;record.poolEffect=e;break;}await step();}
  check('同一酸液飞行→落地→池',!!record.pool && record.pool.vfx.enemy.events.some(e=>e.type==='impact'&&same(e.effect,attack)) && (badPool?record.pool.vfx.enemy.stats.fallback>0:record.pool.vfx.enemy.instances.some(p=>p.key===key+'enemy.acid.pool')));
  if(!record.pool)throw Error('选定酸液未落地成池');
  await step(8);record.pool=await snap();await capture('acid-pool');record.poolVisible=await verifyImpactVisibility(cdp,out,record.poolEffect.position,'acid-pool',{filterIncludes:key+'enemy.acid.pool'});
  if(badPool){check('坏纹理显式诊断且危险池保底继续',evidence.failureInjection.requests>0 && !record.pool.vfx.enemy.ready.includes('enemy.acid.pool') && record.pool.vfx.diagnostics.some(d=>!d.includes('兼容读取')) && !record.pool.vfx.enemy.rendered.includes(id) && record.pool.vfx.enemy.stats.fallback>0 && !record.poolVisible.passed);}
  else{check('道路酸池真实GPU局部可见',record.poolVisible.passed);const pool=record.pool.vfx.enemy.instances.find(p=>p.key===key+'enemy.acid.pool');check('池危险尺寸及真实结束时间',pool?.size[0]===record.poolEffect.radius*2 && pool?.size[1]===record.poolEffect.radius*2 && Math.abs(pool.lifetime-4)<.02);}
  // 先用真实输入撤离落点，再冻结并单步到同一池结束，避免后来的新池冒充目标池。
  await resume();const p=record.pool.player,target=[p.x-5,p.z-4];const until=Date.now()+1000;while(Date.now()<until){s=await snap();await choose(record,s);await hold(movement(s.player,target));await sleep(40);}await pause();
 }
 for(let n=0;n<330;n++){
  s=await snap();if(s.outcome!=='running')throw Error('生命周期途中玩家死亡');
  const end=s.vfx.enemy.events.find(e=>e.type==='end'&&same(e.effect,attack));
  if(end){record.ended=s;record.endEvent=end;break;}
  await step();
 }
 check(record.kind+' 同一攻击到时end/实例回收',!!record.endEvent && !record.ended.effects.some(e=>same(e,attack)) && !record.ended.vfx.enemy.instances.some(p=>p.key===key+(record.kind==='acid'?'enemy.acid.pool':'enemy.explode')));
 if(!record.ended)throw Error('缺少目标end');
 check(record.kind+' end同帧消费并生成地面痕迹',record.ended.vfx.enemy.instances.some(p=>p.key===key+'enemy.mark'));
 record.timing={startTick:attack.startTick,phaseTick:record.poolEffect?.phaseTick??attack.phaseTick,endTick:record.endEvent.tick,expectedEndTick:attack.startTick+Math.ceil(attack.duration*30),fixedStep:1/30};
 check(record.kind+' 完整事件已消费且结束tick准确',record.ended.pendingAttackEvents===0 && record.ended.vfx.enemy.stats.eventDrops===0 && record.endEvent.tick===record.timing.expectedEndTick);
 await capture(record.kind+'-mark');record.markVisible=await verifyImpactVisibility(cdp,out,record.endEvent.effect.position,record.kind+'-mark',{filterIncludes:key+'enemy.mark'});check(record.kind+' 地面痕迹GPU可见',record.markVisible.passed);
 await step(60);record.recycled=await snap();check(record.kind+' 装饰痕迹回收',!record.recycled.vfx.enemy.instances.some(p=>p.key.startsWith(key)));
}
try{
 for(const kind of (arg('only','')?[arg('only','')]:['acid','explosion'])){
  const floor=kind==='acid'?2:3;await load(floor);const record={kind,floor,choices:[],path:[],initial:await snap()};evidence.routes.push(record);
  if(!evidence.gpu){ evidence.gpu=await cdp.eval(`(async()=>{const a=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});return {secure:isSecureContext,info:{vendor:a.info.vendor,architecture:a.info.architecture},fallback:a.info.isFallbackAdapter??a.isFallbackAdapter};})()`);
 check('HTTPS真实NVIDIA非fallback',evidence.gpu.secure && evidence.gpu.info.vendor==='nvidia' && evidence.gpu.fallback===false);
}

  let attack=null;
  if(kind==='acid'){
   await equip(7);if(!await waitFor(()=>cdp.eval(`window.__editor.playCtl.session.runtime.weapons.active.id==='launcher'`),{timeout:1000}))throw Error('切枪失败');const deadline=Date.now()+150000;let previous=-1,waypoint=0;const waypoints=[[4,-5],[17,-5],[17,5],[4,5]];
   while(Date.now()<deadline){let s=await snap();if(s.outcome!=='running')throw Error('清波死亡');if(await choose(record,s))continue;
    if(s.progress.kills!==previous){previous=s.progress.kills;console.log('clear',s.tick,s.progress.kills,s.player.hp,s.weapon.state);record.path.push({tick:s.tick,player:s.player,kills:s.progress.kills,weapon:s.weapon,events:s.sessionEvents});}
    const acids=s.actors.filter(a=>a.kind==='npc'&&a.alive&&a.characterId==='E-03');
    if(acids.length){await hold([]);record.wave2=s;console.log('acid wave reached',s.tick,s.player.hp);break;}
    const npc=s.actors.filter(a=>a.kind==='npc'&&a.alive).sort((a,b)=>Math.hypot(a.x-s.player.x,a.z-s.player.z)-Math.hypot(b.x-s.player.x,b.z-s.player.z))[0];
    if(npc){if(Math.hypot(s.player.x-waypoints[waypoint][0],s.player.z-waypoints[waypoint][1])<1)waypoint=(waypoint+1)%waypoints.length;await aim(npc.x,npc.z);await hold([...movement(s.player,waypoints[waypoint]),'j']);}else await hold([]);await sleep(40);
   }
   if(!record.wave2)throw Error('未正常清出E03第二波');
   const reached=await waitFor(async()=>{const s=await snap();record.beforeLaunch=s;return s.effects.find(e=>e.kind==='acid'&&e.phase==='flight'&&!e.blocked);},{timeout:18000,interval:20});if(!reached)throw Error('未自然发射酸液');await pause();attack=(await snap()).effects.find(e=>same(e,reached));
  }else{
   // 不杀敌、不改房间；现有道路原生移动到Boss房，由进入AABB自然触发原wave1。
   const deadline=Date.now()+30000;let retreat=null;
   while(Date.now()<deadline){const s=await snap();if(s.outcome!=='running')throw Error('原道路接近爆尸途中死亡');if(await choose(record,s))continue;
    record.path.push({tick:s.tick,player:s.player,events:s.sessionEvents});
    const bomb=s.actors.filter(a=>a.kind==='npc'&&a.alive&&a.characterId==='E-05').sort((a,b)=>Math.hypot(a.x-s.player.x,a.z-s.player.z)-Math.hypot(b.x-s.player.x,b.z-s.player.z))[0];
    if(bomb && bomb.behavior===2){await pause();record.windup=await snap();record.sourceBefore=record.windup.actors.find(a=>a.id===bomb.id);await capture('explosion-windup');check('原生接近触发E05前摇',record.sourceBefore.hp>0 && record.sourceBefore.windup>0);await resume();retreat=[s.player.x-7,s.player.z-3];break;}
    await hold(movement(s.player,bomb?[bomb.x,bomb.z]:[35,0]));await sleep(40);
   }
   if(!retreat)throw Error('未自然接近E05前摇');
   const reached=await waitFor(async()=>{const s=await snap();await hold(movement(s.player,retreat));return s.effects.find(e=>e.kind==='explode'&&e.source===record.sourceBefore.id&&e.generation===record.sourceBefore.generation);},{timeout:5000,interval:20});
   if(!reached)throw Error('目标E05未自然自爆');await pause();attack=reached;record.exploded=await snap();await capture('explosion-burst');record.burstVisible=await verifyImpactVisibility(cdp,out,attack.position,'explosion-burst',{filterIncludes:`enemy:${attack.runId}:${attack.id}:enemy.explode`});check('自然自爆死亡且爆发GPU可见',!record.exploded.actors.some(a=>a.id===attack.source&&a.generation===attack.generation) && record.burstVisible.passed);
  }
  if(!attack)throw Error('错过选定攻击');await lifecycle(record,attack);await stop(record);
  await click('#btn-play');check(kind+' 原关卡重新Play资源就绪',await waitFor(()=>cdp.eval(`window.__editor.vfx.snapshot().play.gpu?.textures===${textures}`),{timeout:15000}));record.reopen={kind:kind+'重开'};await stop(record.reopen);
 }
 check('正式场景/生产源码资产未被验收写回',sources.filter(p=>!p.startsWith('tools/')).every(p=>hash(p)===evidence.sourceHashes[p]));
 evidence.consoleErrors=cdp.consoleErrors;evidence.exceptions=cdp.exceptions;check('无浏览器/GPU错误',!cdp.consoleErrors.length&&!cdp.exceptions.length);
}catch(error){evidence.failure=String(error);check('执行完成',false,String(error));evidence.failedState=await snap().catch(()=>null);await capture('failure').catch(()=>{});}finally{await hold([]).catch(()=>{});await cdp.eval(`window.__editor?.playCtl.isPlaying && document.querySelector('#btn-stop')?.click()`).catch(()=>{});evidence.consoleErrors=cdp.consoleErrors;evidence.exceptions=cdp.exceptions;fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(evidence,null,2));ws.close();chrome.kill();}
process.exitCode=results.some(r=>!r.ok)?1:0;
