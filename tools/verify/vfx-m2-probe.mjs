/** M2 headed GPU / actual form handlers / isolated disk copies. Never writes tracked acceptance data. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {measureVfxCost} from './vfx-cost.mjs';
import {verifyM2Pixels,verifyImpactVisibility} from './vfx-m2-pixels.mjs';
import {makeArgParser,ensureServer,launchEditorSession,waitFor,createRecorder} from './editor-smoke-lib.mjs';
const {arg,has}=makeArgParser(process.argv),out=path.resolve(arg('out','.workbuddy/tmp/vfx-m2/development'));
const variants=['acid','acid-blocked','pounce','explode'],fixtures=Object.fromEntries(variants.map(v=>[v,`.workbuddy/tmp/vfx-m2/${v}.scene.json`])),assetCopy='.workbuddy/tmp/vfx-m2/probe.vfx.json';
fs.mkdirSync(out,{recursive:true});fs.mkdirSync(path.dirname(assetCopy),{recursive:true});
for(const v of variants)fs.copyFileSync(`assets/scenes/sandbox/vfx-m2-${v}.scene.json`,fixtures[v]);
for(const [source,target] of [['assets/vfx/comic-enemies.vfx.json',assetCopy],['assets/vfx/comic-enemies.vfx.json.meta.json',`${assetCopy}.meta.json`]])fs.copyFileSync(source,target);
if(has('prepare-only')){console.log(JSON.stringify({fixtures,assetCopy}));process.exit(0);}
if(!has('headed'))throw new Error('本机 VFX 验收必须显式 --headed');
const port=Number(arg('cdp','9333'));
const occupied=await new Promise(resolve=>{const s=net.connect(port,'127.0.0.1');s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));});
if(occupied)throw new Error(`CDP ${port} 已占用，不接管或终止已有进程`);
const {check,results}=createRecorder(),evidence={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),checks:results};
evidence.verificationSources=Object.fromEntries(['tools/verify/vfx-m2-probe.mjs','tools/verify/vfx-m2-pixels.mjs','tools/verify/vfx-cost.mjs'].map(p=>[p,createHash('sha256').update(fs.readFileSync(p)).digest('hex')]));
const {server,url}=await ensureServer(5100,'apps/editor/vite.config.ts');if(server)throw new Error('请先用记录的 detached 方式启动固定5100服务');
const {chrome,cdp,ws}=await launchEditorSession({chromePath:arg('chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),cdpPort:port,headed:true,appUrl:url,windowSize:'1500,1000'});
// The shared CDP client has no per-call deadline; bound this standalone probe's commands.
const send=cdp.send.bind(cdp);cdp.send=(method,params={})=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`CDP ${method} exceeded 10s`)),10000);send(method,params).then(r=>{clearTimeout(timer);resolve(r);},e=>{clearTimeout(timer);reject(e);});});
// Only this test tab sees the fixture registration. Disk project and product rules stay unchanged.
const projectedProject=JSON.parse(fs.readFileSync('aether.project.json','utf8'));
for(const v of variants)projectedProject.scenes.find(s=>s.id===`sc_vfx_m2_${v.replaceAll('-','_')}`).path=fixtures[v];
ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Fetch.requestPaused' && m.sessionId===cdp.sessionId)void cdp.send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(projectedProject)).toString('base64')});});
await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*__fs/file?path=aether.project.json*',requestStage:'Request'}]});
const capture=async name=>{await cdp.eval(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,`${name}.png`),Buffer.from(r.data,'base64'));};
const click=async selector=>{const p=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('missing control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});};
const button=async(label,panel='vfx-panel')=>{const selector=await cdp.eval(`(()=>{const b=[...document.querySelectorAll('#${panel} button')].find(b=>b.textContent===${JSON.stringify(label)});if(!b)throw new Error('control ${label}');b.dataset.probe='selected';return '#${panel} button[data-probe="selected"]';})()`);await click(selector);await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).removeAttribute('data-probe')`);};
const input=async(label,value,panel='vfx-panel')=>cdp.eval(`(()=>{const e=document.querySelector('#${panel} [aria-label=${JSON.stringify(label)}]');if(e.type==='checkbox')e.checked=${JSON.stringify(value)};else e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const viewport=()=>cdp.eval(`(()=>{localStorage.setItem('zh.ui.dockH','230');document.documentElement.style.setProperty('--dock-h','230px');document.getElementById('asset-dock')?.classList.add('collapsed');window.dispatchEvent(new Event('resize'));})()`);
const snapshot=()=>cdp.eval(`(()=>{const r=window.__editor.playCtl.session.runtime;return {vfx:window.__editor.vfx.snapshot().play,tick:r?.tick,runId:r?.runId,outcome:r?.outcome,effects:r?.enemyAttacks.effects,actors:r?.view(),ledger:window.__editor.playCtl.ledger};})()`);
const load=async v=>{await cdp.send('Page.navigate',{url:`${url}?scene=${encodeURIComponent(fixtures[v])}`});if(!await waitFor(()=>cdp.eval(`!!window.__editor?.vfx && window.__editor.renderer.getDocument()?.id===${JSON.stringify('sc_vfx_m2_'+v.replaceAll('-','_'))}`),{timeout:30000}))throw new Error(`scene ${v} unavailable`);await viewport();};
const start=async()=>{await click('#btn-play');if(!await waitFor(()=>cdp.eval(`window.__editor.vfx.snapshot().play.enemy.ready.length===7`),{timeout:20000}))throw new Error('enemy textures not ready');};
const stop=async name=>{await click('#btn-stop');const state=await snapshot();evidence[name]=state;check(`${name}: Stop真实销毁与账目归零`,state.ledger.pending===0 && state.vfx.gpu===null && state.vfx.lastReleased?.destroyedBuffers===2 && state.vfx.lastReleased?.destroyedTextures===8);};
try{
 await load('acid');
 evidence.gpu=await cdp.eval(`(async()=>{const a=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});return {secure:isSecureContext,isFallbackAdapter:a?.info?.isFallbackAdapter??a?.isFallbackAdapter??null,info:a?.info?{vendor:a.info.vendor,architecture:a.info.architecture,device:a.info.device,description:a.info.description}:null};})()`);
 check('secure + nonfallback硬件GPU',evidence.gpu.secure && evidence.gpu.isFallbackAdapter===false && !/swiftshader|llvmpipe|software/i.test(JSON.stringify(evidence.gpu.info)),JSON.stringify(evidence.gpu));
 await click('.insp-tab[data-tab="scene"]');
 const bindings=()=>JSON.parse(fs.readFileSync(fixtures.acid,'utf8')).nodes.flatMap(n=>n.components).find(c=>c.kind==='VfxBindings').bindings;
 await button('移除标签绑定','vfx-binding-panel');await button('撤销标签绑定','vfx-binding-panel');await button('重做标签绑定','vfx-binding-panel');await button('保存标签场景','vfx-binding-panel');
 check('移除→Undo→Redo→Save实际删磁盘tag',await waitFor(()=>Promise.resolve(!bindings()['enemy.acid.flight'])));
 await input('绑定资源','assets/vfx/comic-enemies.vfx.json','vfx-binding-panel');await button('读取绑定资源','vfx-binding-panel');
 if(!await waitFor(()=>cdp.eval(`!!document.querySelector('#vfx-binding-panel [aria-label="效果 key"] option[value="acid-flight"]')`)))throw new Error('binding resource unavailable');
 await input('效果 key','acid-flight','vfx-binding-panel');await button('应用标签绑定','vfx-binding-panel');await button('保存标签场景','vfx-binding-panel');
 check('重新绑定→Save真实写盘',await waitFor(()=>Promise.resolve(bindings()['enemy.acid.flight']?.effectKey==='acid-flight')));
 await cdp.send('Page.reload');check('整页Reload保留绑定',await waitFor(()=>cdp.eval(`!!window.__editor?.vfx && window.__editor.renderer.getDocument()?.nodes.flatMap(n=>n.components).find(c=>c.kind==='VfxBindings')?.bindings['enemy.acid.flight']?.resource.guid==='as_vfx_comic_enemies'`),{timeout:30000}));
 await viewport();await click('.insp-tab[data-tab="scene"]');await input('资源文件路径',assetCopy);await button('打开 VFX 资源');
 if(!await waitFor(()=>cdp.eval(`window.__editor.vfx.snapshot().editor.path===${JSON.stringify(assetCopy)}`)))throw new Error('asset copy unavailable');
 await input('编辑效果','acid-pool');await input('宽度 m','1.2');await input('VFX 颜色','#90ee55');await input('持续时间 s','.7');await input('VFX 朝向','surface');await input('循环帧动画',true);await button('应用资源参数');
 await button('撤销资源参数');check('资产Undo恢复周期',await cdp.eval(`window.__editor.vfx.snapshot().editor.asset.effects['acid-pool'].duration===.6`));await button('重做资源参数');await button('保存 VFX 资产');
 check('v2独立资产真实写盘',await waitFor(()=>Promise.resolve(JSON.parse(fs.readFileSync(assetCopy,'utf8')).effects['acid-pool'].duration===.7)));
 await button('重载 VFX 资产');check('资产Reload朝向循环尺寸保留',await waitFor(()=>cdp.eval(`(()=>{const e=window.__editor.vfx.snapshot().editor.asset.effects['acid-pool'];return e.duration===.7 && e.size[0]===1.2 && e.orientation==='surface' && e.loop;})()`)));
 await waitFor(()=>cdp.eval(`document.querySelector('#vfx-panel [role="status"]').textContent==='VFX 已从磁盘重载'`));
 const savedAsset=JSON.parse(fs.readFileSync(assetCopy,'utf8'));
 await input('宽度 m','1.4');await button('应用资源参数');const external={...savedAsset,name:'外部版本'};fs.writeFileSync(assetCopy,JSON.stringify(external,null,2)+'\n');await button('保存 VFX 资产');
 evidence.casDraft=await cdp.eval(`({snapshot:window.__editor.vfx.snapshot().editor,status:document.querySelector('#vfx-panel [role="status"]').textContent})`);
 check('CAS冲突可见且保留草稿',await waitFor(()=>cdp.eval(`window.__editor.vfx.snapshot().editor.dirty && document.querySelector('#vfx-panel [role="status"]').textContent.includes('外部修改')`)));
 await button('重载 VFX 资产');check('CAS后显式Reload读取外部版本',await waitFor(()=>cdp.eval(`!window.__editor.vfx.snapshot().editor.dirty && window.__editor.vfx.snapshot().editor.asset.name==='外部版本'`)));
 fs.writeFileSync(assetCopy,JSON.stringify({...external,version:99}));await button('重载 VFX 资产');check('未来资源版本可见诊断且保留当前资源',await waitFor(()=>cdp.eval(`document.querySelector('#vfx-panel [role="status"]').textContent.includes('不支持 VFX 版本 99') && window.__editor.vfx.snapshot().editor.asset.version===2`)));fs.writeFileSync(assetCopy,JSON.stringify(external,null,2)+'\n');await button('重载 VFX 资产');
 await button('循环 GPU 预览');check('平面资源预览有真实GPU draw',await waitFor(()=>cdp.eval(`(window.__editor.vfx.snapshot().editor.preview?.draws??0)>0`)));await capture('01-plane-preview');await button('停止 VFX 预览');
 await start();
 const flight=await waitFor(async()=>{const s=await snapshot();return s.effects?.some(e=>e.kind==='acid' && e.phase==='flight') && s.vfx.enemy.instances.some(i=>i.key.endsWith('enemy.acid.flight')) && s.vfx.gpu?.draws>0?s:null;},{timeout:10000,interval:10});
 check('真实模拟触发酸液flight与GPU实例',!!flight);evidence.flight=flight;await capture('02-acid-flight');
 const pool=await waitFor(async()=>{const s=await snapshot();return s.effects?.some(e=>e.kind==='acid' && e.phase==='pool') && s.vfx.enemy.instances.some(i=>i.key.endsWith('enemy.acid.pool'))?s:null;},{timeout:5000,interval:10});if(!pool)throw new Error('acid pool not reached');await click('#btn-pause');evidence.pool=await snapshot();
 const fact=evidence.pool.effects.find(e=>e.phase==='pool'),instance=evidence.pool.vfx.enemy.instances.find(i=>i.key.endsWith('enemy.acid.pool'));
 check('pool位置直径与真实radius一致',instance.size.every(n=>n===2*fact.radius) && instance.position.every((n,i)=>n===fact.position[i]) && !!instance.normal && evidence.pool.vfx.enemy.rendered.includes(fact.id));
 check('真实落地不可变快照与接收面',evidence.pool.vfx.enemy.events.some(e=>e.type==='phase' && e.effect.surface?.nodeId==='nd_vfx_ground' && e.effect.id===fact.id));
 await capture('03-acid-pool');
 const paused=evidence.pool.tick;await new Promise(r=>setTimeout(r,150));check('暂停不延长模拟tick', (await snapshot()).tick===paused);await click('#btn-step');check('单步仅1tick',(await snapshot()).tick===paused+1);
 evidence.pixels=await verifyM2Pixels(cdp,out);check('平面遮挡/透明排序/aux像素验证',evidence.pixels.passed,JSON.stringify(evidence.pixels));
 evidence.cost=await measureVfxCost(cdp);
 // Verification-only pool pressure; no damage, actor movement or attack hooks.
 evidence.budget=await cdp.eval(`(async()=>{const host=window.__editor.playCtl.vfx,pool=host.planner.pool,effect=host.enemy.bindings.get('enemy.mark');for(let i=0;i<pool.capacity;i++)pool.spawn({key:'verification-budget:'+i,effect,position:[1000,0,1000],normal:[0,1,0],seed:0,priority:30,lifetime:100});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return host.snapshot();})()`);
 check('满池实际不可绘制时保留危险fallback',evidence.budget.enemy.stats.fallback>0 && !evidence.budget.enemy.rendered.includes(fact.id) && evidence.budget.pool.dropped>0);await capture('04-budget-fallback');
 await cdp.eval(`(()=>{const p=window.__editor.playCtl.vfx.planner.pool;for(let i=0;i<p.capacity;i++)p.stop('verification-budget:'+i);})()`);
 await click('#btn-pause');
 const ended=await waitFor(async()=>{const s=await snapshot();return s.vfx.enemy.events.some(e=>e.type==='end' && e.effect.id===fact.id) && !s.vfx.enemy.instances.some(i=>i.key.includes(':'+fact.id+':enemy.acid.pool'))?s:null;},{timeout:6000,interval:20});evidence.ended=ended;check('真实end即移除danger实例',!!ended);await capture('05-acid-end');
 const marksGone=await waitFor(async()=>{const s=await snapshot();return s.tick>ended.tick+30 && !s.vfx.enemy.instances.some(i=>i.key.includes(':'+fact.id+':enemy.mark'))?s:null;},{timeout:3000,interval:20});check('装饰痕迹TTL独立结束',!!marksGone);await stop('acidStopped');
 for(const variant of ['acid-blocked','pounce','explode']){
  await load(variant);await start();
  const impact=await waitFor(async()=>{const s=await snapshot();return s.vfx.enemy.events.some(e=>e.type==='impact')?s:null;},{timeout:10000,interval:10});if(!impact)throw new Error(`no real impact ${variant}`);await click('#btn-pause');const state=await snapshot();evidence[variant]=state;const event=state.vfx.enemy.events.find(e=>e.type==='impact');
  if(variant==='acid-blocked')check('blocked实际impact且无pool',event.effect.blocked && !state.vfx.enemy.events.some(e=>e.type==='phase') && !state.vfx.enemy.instances.some(i=>i.key.endsWith('enemy.acid.pool')));
  else check(`${variant}实际impact与GPU位置半径`,state.vfx.enemy.instances.some(i=>i.key.endsWith(variant==='pounce'?'enemy.pounce.impact':'enemy.explode') && i.position.every((n,k)=>n===event.effect.position[k]) && i.size.every(n=>n===event.effect.radius*2)) && state.vfx.gpu.draws>0);
  if(variant==='pounce'){const q=await cdp.eval(`window.__editor.renderer.worldToScreen(${JSON.stringify(event.effect.position)})`);check('真实突扑落点在可见视口且接近锁定目标',q.x>0 && q.x<1500 && q.y>85 && q.y<900 && !q.behind && Math.hypot(event.effect.position[0]-event.effect.to[0],event.effect.position[2]-event.effect.to[2])<.1);evidence.pouncePixels=await verifyImpactVisibility(cdp,out,event.effect.position);check('真实突扑实例产生可见GPU像素',evidence.pouncePixels.passed,JSON.stringify(evidence.pouncePixels));}
  if(variant==='explode')check('自爆者死亡后快照仍可显示',!state.actors.some(e=>e.id===event.effect.source && e.generation===event.effect.generation && e.alive) && state.outcome==='running');
  await capture(`06-${variant}`);await click('#btn-pause');
  const end=await waitFor(async()=>{const s=await snapshot();return s.vfx.enemy.events.some(e=>e.type==='end' && e.effect.id===event.effect.id)?s:null;},{timeout:3000,interval:10});check(`${variant}真实结束事实`,!!end);await stop(variant+'Stopped');
 }
 const invalid=JSON.parse(fs.readFileSync(fixtures.acid,'utf8'));invalid.nodes.flatMap(n=>n.components).find(c=>c.kind==='VfxBindings').bindings['enemy.acid.flight'].effectKey='missing-effect';fs.writeFileSync(fixtures.acid,JSON.stringify(invalid,null,2)+'\n');await load('acid');await click('#btn-play');
 const bad=await waitFor(async()=>{const s=await snapshot();return s.vfx.diagnostics.some(d=>d.includes('missing-effect')) && s.effects?.some(e=>e.kind==='acid' && e.phase==='flight')?s:null;},{timeout:10000,interval:10});evidence.badBinding=bad;
 check('坏绑定可定位诊断并按handle保留Canvas fallback',!!bad && !bad.vfx.enemy.ready.includes('enemy.acid.flight') && bad.vfx.enemy.stats.fallback>0 && !bad.vfx.enemy.rendered.length);await capture('07-bad-binding');await stop('badBindingStopped');
 evidence.consoleErrors=cdp.consoleErrors;evidence.exceptions=cdp.exceptions;check('无浏览器/GPU错误',!cdp.consoleErrors.length && !cdp.exceptions.length,JSON.stringify([...cdp.consoleErrors,...cdp.exceptions]));
}catch(error){evidence.failure=String(error);check('探针执行',false,String(error));await capture('failure').catch(()=>{});}
finally{await cdp.eval(`(()=>{if(window.__editor?.playCtl.isPlaying)document.querySelector('#btn-stop')?.click();})()`).catch(()=>{});fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(evidence,null,2));ws.close();chrome.kill();}
process.exitCode=results.some(r=>!r.ok)?1:0;
