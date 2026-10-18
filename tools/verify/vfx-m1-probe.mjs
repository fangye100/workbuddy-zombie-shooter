/** M1 headed GPU / actual form handlers / isolated disk copies. Never writes tracked acceptance data. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {measureVfxCost} from './vfx-cost.mjs';
import {makeArgParser,ensureServer,launchEditorSession,waitFor,createRecorder} from './editor-smoke-lib.mjs';
const {arg,has}=makeArgParser(process.argv),out=path.resolve(arg('out','.workbuddy/tmp/vfx-m1/development'));
const fixture='.workbuddy/tmp/vfx-m1/probe.scene.json',assetCopy='.workbuddy/tmp/vfx-m1/probe.vfx.json';
fs.mkdirSync(out,{recursive:true});fs.mkdirSync(path.dirname(fixture),{recursive:true});
for(const [source,target] of [['assets/scenes/sandbox/vfx-m1.scene.json',fixture],['assets/vfx/comic-pistol.vfx.json',assetCopy],['assets/vfx/comic-pistol.vfx.json.meta.json',`${assetCopy}.meta.json`]])fs.copyFileSync(source,target);
if(has('prepare-only')){console.log(JSON.stringify({fixture,assetCopy}));process.exit(0);}
if(!has('headed'))throw new Error('本机 VFX 验收必须显式 --headed');
const port=Number(arg('cdp','9333'));
const occupied=await new Promise(resolve=>{const s=net.connect(port,'127.0.0.1');s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));});
if(occupied)throw new Error(`CDP ${port} 已占用，不接管或终止已有进程`);
const {check,results}=createRecorder(),evidence={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),checks:results};
const {server,url}=await ensureServer(5100,'apps/editor/vite.config.ts');if(server)throw new Error('请先用记录的 detached 方式启动固定5100服务');
const {chrome,cdp,ws}=await launchEditorSession({chromePath:arg('chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),cdpPort:port,headed:true,appUrl:url,windowSize:'1500,1000'});
// Only this test tab sees the fixture registration. Disk project and product rules stay unchanged.
const projectedProject=JSON.parse(fs.readFileSync('aether.project.json','utf8'));
projectedProject.scenes.find(s=>s.id==='sc_vfx_m1').path=fixture;
ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Fetch.requestPaused' && m.sessionId===cdp.sessionId)void cdp.send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(projectedProject)).toString('base64')});});
await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*__fs/file?path=aether.project.json*',requestStage:'Request'}]});
const capture=async name=>{const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,`${name}.png`),Buffer.from(r.data,'base64'));};
const click=async selector=>{const p=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('missing control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});};
const button=async label=>{const selector=await cdp.eval(`(()=>{const b=[...document.querySelectorAll('#vfx-panel button')].find(b=>b.textContent===${JSON.stringify(label)});if(!b)throw new Error('control ${label}');b.dataset.probe='selected';return '#vfx-panel button[data-probe="selected"]';})()`);await click(selector);await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).removeAttribute('data-probe')`);};
const input=async(label,value)=>cdp.eval(`(()=>{const e=document.querySelector('#vfx-panel [aria-label=${JSON.stringify(label)}]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
try{
 await cdp.send('Page.navigate',{url:`${url}?scene=${encodeURIComponent(fixture)}`});
 check('场景副本和产品面板就绪',await waitFor(()=>cdp.eval(`!!window.__editor?.vfx && window.__editor.renderer.getDocument()?.id==='sc_vfx_m1'`),{timeout:30000}));
 await cdp.eval(`(()=>{localStorage.setItem('zh.ui.dockH','230');document.documentElement.style.setProperty('--dock-h','230px');document.getElementById('asset-dock')?.classList.add('collapsed');window.dispatchEvent(new Event('resize'));})()`);
 evidence.gpu=await cdp.eval(`(async()=>{const a=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});return {secure:isSecureContext,isFallbackAdapter:a?.info?.isFallbackAdapter??a?.isFallbackAdapter??null,info:a?.info?{vendor:a.info.vendor,architecture:a.info.architecture,device:a.info.device,description:a.info.description}:null};})()`);
 check('secure context + 硬件adapter',evidence.gpu.secure && evidence.gpu.info && !/swiftshader|llvmpipe|software/i.test(JSON.stringify(evidence.gpu.info)),JSON.stringify(evidence.gpu));
 await click('.insp-tab[data-tab="scene"]');await button('打开 VFX 资源');
 check('正式资源由UI加载',await waitFor(()=>cdp.eval(`window.__editor.vfx.snapshot().editor.asset?.id==='as_vfx_comic_pistol'`)));
 await button('循环 GPU 预览');check('预览真实GPU分配与draw',await waitFor(()=>cdp.eval(`(window.__editor.vfx.snapshot().editor.preview?.draws??0)>0`)));
 await capture('01-preview');await button('停止 VFX 预览');
 await button('清除 VFX 绑定');check('绑定Apply改变场景',await cdp.eval(`window.__editor.renderer.getDocument().nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules').arsenal.definitions[0].presentation.vfx.resource===null`));
 await button('撤销场景绑定');await waitFor(()=>cdp.eval(`!!window.__editor.renderer.getDocument().nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules').arsenal.definitions[0].presentation.vfx.resource`));
 await button('重做场景绑定');await waitFor(()=>cdp.eval(`window.__editor.renderer.getDocument().nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules').arsenal.definitions[0].presentation.vfx.resource===null`));
 await button('应用 VFX 绑定');await button('保存场景绑定');
 check('场景副本磁盘保存',await waitFor(()=>Promise.resolve(JSON.parse(fs.readFileSync(fixture,'utf8')).nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules').arsenal.definitions[0].presentation.vfx.resource?.guid==='as_vfx_comic_pistol')));
 await input('资源文件路径',assetCopy);await button('打开 VFX 资源');await waitFor(()=>cdp.eval(`window.__editor.vfx.snapshot().editor.path===${JSON.stringify(assetCopy)}`));
 await input('宽度 m','.72');await button('应用资源参数');check('资源参数Apply',await cdp.eval(`window.__editor.vfx.snapshot().editor.asset.effects['comic-muzzle'].size[0]===.72`));
 await button('撤销资源参数');check('资源Undo',await cdp.eval(`window.__editor.vfx.snapshot().editor.asset.effects['comic-muzzle'].size[0]===.55`));await button('重做资源参数');await button('保存 VFX 资产');
 check('资产副本磁盘保存',await waitFor(()=>Promise.resolve(JSON.parse(fs.readFileSync(assetCopy,'utf8')).effects['comic-muzzle'].size[0]===.72)));
 await button('重载 VFX 资产');check('资产重载',await waitFor(()=>cdp.eval(`!window.__editor.vfx.snapshot().editor.dirty && window.__editor.vfx.snapshot().editor.asset.effects['comic-muzzle'].size[0]===.72`)));
 await capture('02-editor');await click('#btn-play');
 check('Play GPU资源就绪',await waitFor(()=>cdp.eval(`window.__editor.vfx.snapshot().play.ready.length>0`),{timeout:20000}));
 const aim=await cdp.eval(`window.__editor.renderer.worldToScreen([4,.9,0])`);await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:aim.x,y:aim.y});await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'j',code:'KeyJ',windowsVirtualKeyCode:74});
 check('真实键盘开火产生GPU三件套',await waitFor(()=>cdp.eval(`window.__editor.vfx.snapshot().play.pool.active>=3`),{timeout:10000,interval:10}));await click('#btn-pause');await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'j',code:'KeyJ',windowsVirtualKeyCode:74});
 evidence.paused=await cdp.eval(`({vfx:window.__editor.vfx.snapshot(),tick:window.__editor.playCtl.tick,ledger:window.__editor.playCtl.ledger})`);await capture('03-play-paused');
 await new Promise(r=>setTimeout(r,200));const paused=await cdp.eval(`({vfx:window.__editor.vfx.snapshot(),tick:window.__editor.playCtl.tick})`);check('暂停保持TTL与tick',paused.tick===evidence.paused.tick && paused.vfx.play.pool.active===evidence.paused.vfx.play.pool.active);
 check('墙接触带实际接收者/法线',evidence.paused.vfx.play.events.some(e=>e.contact==='scene' && e.nodeId==='nd_vfx_wall' && e.normal));
 evidence.cost=await measureVfxCost(cdp);
 await click('#btn-step');check('单步只前进一个tick',await cdp.eval(`window.__editor.playCtl.tick===${paused.tick+1}`));await click('#btn-stop');
 evidence.stopped=await cdp.eval(`({vfx:window.__editor.vfx.snapshot(),ledger:window.__editor.playCtl.ledger})`);check('Stop真实销毁buffer/texture与账目清空',evidence.stopped.ledger.pending===0 && evidence.stopped.vfx.play.lastReleased?.destroyedBuffers===2 && evidence.stopped.vfx.play.lastReleased?.destroyedTextures===3 && evidence.stopped.vfx.play.gpu===null);
 await capture('04-stopped');
 evidence.consoleErrors=cdp.consoleErrors;evidence.exceptions=cdp.exceptions;check('无浏览器/GPU错误',!cdp.consoleErrors.length && !cdp.exceptions.length,JSON.stringify([...cdp.consoleErrors,...cdp.exceptions]));
}catch(error){evidence.failure=String(error);check('探针执行',false,String(error));await capture('failure').catch(()=>{});}
finally{fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(evidence,null,2));ws.close();chrome.kill();}
process.exitCode=results.some(r=>!r.ok)?1:0;
