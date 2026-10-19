/** Focused M4.5 failure/lifecycle cases. GUI edits remain genuine; test-only network/pressure inputs are labelled. */
import fs from 'node:fs';import path from 'node:path';
import {waitFor} from './editor-smoke-lib.mjs';
import {verifyImpactVisibility} from './vfx-m2-pixels.mjs';
import {verifyComputePixels,verifyMixedCpu} from './vfx-m4-1-measure.mjs';
import {measureVfxCost} from './vfx-cost.mjs';
const graphRoot='(document.querySelector("#vfx-graph-dialog[open]")??document.getElementById("vfx-graph-panel"))';
async function reloadGraph(c,fragment){
 await c.cdp.eval(`${graphRoot}.querySelector('[role=status]').textContent='probe awaiting graph reload'`);
 await c.button('重载节点图');if(!await waitFor(async()=>(await c.status()).includes(fragment)))throw new Error('图重载状态未完成 '+fragment+': '+await c.status());
}
async function saveGraph(c,predicate){await c.button('保存节点图');if(!await waitFor(async()=>!(await c.graph()).dirty) || !predicate(JSON.parse(fs.readFileSync(c.assetCopy,'utf8'))))throw new Error('图保存未完成 '+await c.status());}
async function parameter(c,node,label,value){await c.input('图选中节点',node);await c.input(label,value);await c.button('应用节点参数');}

export async function verifyGraphFailures(c){
 const {cdp,out,evidence,check,button,input,graph,status,preview,steps,stopPreview,capture,network,assetCopy}=c;
 await parameter(c,'texture_smoke','节点纹理GUID','as_missing_texture');await button('预览编译图');
 if(!await waitFor(async()=>(await status()).includes('贴图身份')))throw new Error('坏纹理诊断未出现 '+await status());
 evidence.badTexture=(await graph());check('坏纹理真实Preview诊断与分配释放',!evidence.badTexture.preview.ready && !evidence.badTexture.preview.gpu && evidence.badTexture.preview.lastReleased.destroyedBuffers===2);
 await capture('05-bad-texture-diagnostic');await button('撤销图编辑');await preview();await steps(1);check('修复图纹理后真实GPU恢复',(await graph()).preview.gpu.active>0);await stopPreview('recoveredTextureStopped');
 network.holdTexture=true;await button('预览编译图');
 if(!await waitFor(()=>Promise.resolve(network.pending.length>0)))throw new Error('未捕获真实纹理请求');
 evidence.lateTexture={requests:network.pending.map(r=>({...r}))};await button('停止图预览');evidence.lateTexture.stopped=(await graph()).preview;
 const released=await network.release();if(!await waitFor(()=>Promise.resolve(released.every(r=>r.networkId && network.finished.has(r.networkId)))))throw new Error('延迟纹理真实响应未完成');
 await cdp.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');evidence.lateTexture.after=(await graph()).preview;
 check('真实延迟纹理在Stop后不复活GPU',!evidence.lateTexture.after.ready && !evidence.lateTexture.after.gpu && evidence.lateTexture.stopped.lastReleased.destroyedBuffers===2 && evidence.lateTexture.stopped.lastReleased.textures===0);
 await parameter(c,'sprite','节点模拟后端','gpu');await preview();await steps(12);evidence.alphaCompatibility=(await graph()).preview;
 check('图GPU alpha显式CPU兼容仍实际绘制',evidence.alphaCompatibility.diagnostic.includes('CPU') && evidence.alphaCompatibility.particles.length>0 && !evidence.alphaCompatibility.compute?.handles && evidence.alphaCompatibility.gpu.draws>0);await stopPreview('alphaCompatibilityStopped');
 await parameter(c,'sprite','节点混合方式','additive');await preview();await steps(12);
 if(!await waitFor(async()=>(await graph()).preview.compute?.draws>0))throw new Error('图实际compute未绘制');evidence.computePreview=(await graph()).preview;
 evidence.computeReadback=await cdp.eval("window.__editor.renderer.core.vfx.gpu.readback('graph-preview')");
 check('图白名单编译到真正compute播放',evidence.computePreview.compute.handles===1 && evidence.computePreview.compute.submittedTick===11 && evidence.computePreview.compute.draws>0 && evidence.computeReadback.counters[0]>0);
 evidence.computeVisible=await verifyImpactVisibility(cdp,out,[0,1.2,-2],'graph-compute');check('图compute正式纹理GPU可见',evidence.computeVisible.passed);await capture('06-graph-compute-preview');
 const pixels=path.join(out,'graph-controlled-pixels');fs.mkdirSync(pixels,{recursive:true});evidence.controlledComputePixels=await verifyComputePixels(cdp,pixels);check('编译图纹理受控遮挡/aux GPU证据',evidence.controlledComputePixels.passed);
 evidence.controlledMixed=await verifyMixedCpu(cdp,pixels);check('图GPU与CPU alpha混合显式兼容/顺序',evidence.controlledMixed.reversed===0 && evidence.controlledMixed.colorsSwapped>=15 && evidence.controlledMixed.gpuDraws===0);
 await stopPreview('computePreviewStopped');await reloadGraph(c,'已从磁盘重载');
 const good=fs.readFileSync(assetCopy,'utf8'),original=JSON.parse(good),badCases=[
  ['future-asset','资产版本',a=>a.version=99],['future-graph','图版本',a=>a.graph.version=99],
  ['unknown-node','未知类型',a=>a.graph.nodes[0].type='arbitrary-script'],
  ['unknown-port','未知节点/端口',a=>a.graph.edges.push({id:'bad_inherited',from:{node:'texture_smoke',port:'constructor'},to:{node:'output',port:'constructor'}})],
  ['port-type','类型不匹配',a=>a.graph.edges[0].from.node='tint'],
  ['missing-input','缺少输入',a=>a.graph.edges.shift()],['duplicate-input','输入重复',a=>a.graph.edges.push({...a.graph.edges[0],id:'bad_duplicate'})],
  ['cycle','循环',a=>{a.graph.nodes.push({id:'cyclic',type:'multiply',position:[0,0],params:{}});a.graph.edges.push({id:'cycle_a',from:{node:'cyclic',port:'value'},to:{node:'cyclic',port:'a'}},{id:'cycle_b',from:{node:'rate_fast',port:'value'},to:{node:'cyclic',port:'b'}});}],
  ['node-budget','节点预算',a=>{for(let i=0;i<65;i++)a.graph.nodes.push({id:'budget_'+i,type:'number',position:[0,0],params:{value:1}});}],
  ['edge-budget','连线预算',a=>{while(a.graph.edges.length<129)a.graph.edges.push({...a.graph.edges[0],id:'edge_budget_'+a.graph.edges.length});}],
  ['arithmetic-budget','乘积',a=>{a.graph.nodes.push({id:'large',type:'number',position:[0,0],params:{value:2000}},{id:'product',type:'multiply',position:[0,0],params:{}});a.graph.edges.push({id:'product_a',from:{node:'large',port:'value'},to:{node:'product',port:'a'}},{id:'product_b',from:{node:'large',port:'value'},to:{node:'product',port:'b'}});}],
 ];
 evidence.badGraphs=[];
 for(const [name,fragment,mutate] of badCases){
  const bad=structuredClone(original);mutate(bad);fs.writeFileSync(assetCopy,JSON.stringify(bad));await reloadGraph(c,fragment);
  const message=await status(),state=await graph();evidence.badGraphs.push({name,message,sourceRetained:JSON.stringify(state.source)===JSON.stringify(original),diagnostics:state.compilation?.diagnostics,preview:state.preview.gpu});
  check('坏图真实UI定位诊断 '+name,message.includes(fragment) && !state.preview.gpu);
  fs.writeFileSync(assetCopy,good);await reloadGraph(c,'已从磁盘重载');if(!(await graph()).compilation.asset)throw new Error('坏图恢复后仍不可编译 '+name);
 }
 check('所有坏图恢复后保留真实源且可预览',JSON.stringify((await graph()).source)===JSON.stringify(original));await preview();await steps(1);check('坏图恢复后的真实GPU播放',(await graph()).preview.gpu.active>0);await stopPreview('badGraphRecoveredStopped');
}

export async function verifyGraphPlayBoundaries(c){
 const {cdp,out,evidence,check,button,input,click,snap,graph,start,stop,reload,open,assetCopy,fixture,emptyFixture,empty,network,capture}=c;
 await start();await click('#btn-pause');const before=await cdp.eval('window.__editor.playCtl.session.runtime.tick');await new Promise(r=>setTimeout(r,150));check('图作者Play暂停固定tick不推进',await cdp.eval('window.__editor.playCtl.session.runtime.tick')===before);
 await click('#btn-step');check('图作者Play真实单步一个tick',await cdp.eval('window.__editor.playCtl.session.runtime.tick')===before+1);
 const run=await cdp.eval('window.__editor.playCtl.session.runtime.runId');await click('#btn-reset');check('图作者重开旧run资源释放',await waitFor(()=>cdp.eval('window.__editor.playCtl.session.runtime.runId!=='+run)) && (await snap()).play.lastReleased.destroyedBuffers>=2);await click('#btn-play');await waitFor(()=>cdp.eval(`window.__editor.vfx.snapshot().play.authored.ready.includes('nd_m4_graph_emitter')`));await stop('resetStopped');
 network.holdTexture=true;await click('#btn-play');if(!await waitFor(()=>Promise.resolve(network.pending.length>0)))throw new Error('Play未捕获延迟纹理');evidence.latePlay={requests:network.pending.map(r=>({...r}))};await stop('latePlayStopped');const held=await network.release();if(!await waitFor(()=>Promise.resolve(held.every(r=>r.networkId && network.finished.has(r.networkId)))))throw new Error('Play延迟响应未完成');await cdp.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');check('Play Stop后真实迟到纹理不复活',await cdp.eval('window.__editor.renderer.core.vfx===null && window.__editor.playCtl.ledger.pending===0'));
 await start();await click('#btn-pause');evidence.resizeBefore=await cdp.eval('({...window.__editor.renderer.core.sceneDepth.stats})');await cdp.send('Emulation.setDeviceMetricsOverride',{width:1320,height:900,deviceScaleFactor:1.5,mobile:false});
 if(!await waitFor(()=>cdp.eval('window.__editor.renderer.core.sceneDepth.stats.generation>'+evidence.resizeBefore.generation)))throw new Error('实际resize未生效');await cdp.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');evidence.resizeAfter=await cdp.eval('({...window.__editor.renderer.core.sceneDepth.stats,draws:window.__editor.renderer.core.vfx.stats.draws,active:window.__editor.renderer.core.vfx.stats.active})');
 evidence.resizedPixels=await verifyImpactVisibility(cdp,out,[0,1.2,-2],'graph-resized');check('实际resize新深度/尺寸下编译图继续绘制',evidence.resizeAfter.destroyed>evidence.resizeBefore.destroyed && evidence.resizeAfter.active>0 && evidence.resizedPixels.passed);await capture('07-graph-resized');await cdp.send('Emulation.clearDeviceMetricsOverride');await stop('resizeStopped');
 await open();const goodAsset=fs.readFileSync(assetCopy,'utf8'),goodMeta=fs.readFileSync(assetCopy+'.meta.json','utf8'),goodScene=fs.readFileSync(fixture,'utf8');
 try{
  await parameter(c,'sprite','节点模拟后端','gpu');await parameter(c,'sprite','节点混合方式','additive');await parameter(c,'emission','节点粒子容量','1024');await parameter(c,evidence.createdNode,'节点数值','2400');await parameter(c,'lifetime','节点数值','2');
  await saveGraph(c,a=>a.graph.nodes.find(n=>n.id==='sprite').params.backend==='gpu' && a.graph.nodes.find(n=>n.id==='emission').params.maxParticles===1024);evidence.pressureSource=JSON.parse(fs.readFileSync(assetCopy));
  const scene=JSON.parse(goodScene),source=scene.nodes.find(n=>n.id==='nd_m4_graph_emitter');for(let i=0;i<4;i++){const n=structuredClone(source);n.id='nd_graph_budget_'+i;n.name='验证用图预算作者 '+i;n.transform.position[0]+=(i+1)*.35;scene.nodes.push(n);}fs.writeFileSync(fixture,JSON.stringify(scene));network.graphProjection=true;await reload();await start();
  if(!await waitFor(()=>cdp.eval(`window.__editor.vfx.snapshot().play.authored.stats.emitted>0 && window.__editor.vfx.snapshot().play.authored.diagnostics.some(s=>/容量|预算/.test(s))`),{timeout:20000}))throw new Error('图动态预算未降级');await click('#btn-pause');evidence.pressure=(await snap()).play;
  check('真实图作者受控5x1024共享容量降级',evidence.pressure.authored.ready.length===5 && evidence.pressure.authored.gpu.capacity<=4096 && evidence.pressure.authored.gpu.particleOverflow>0 && evidence.pressure.authored.stats.emitted>0);
  evidence.pressureMethod='verification-only tmp scene contains five real VfxEmitter authors; browser maps formal graph URI+sidecar to the actual GUI-saved tmp graph bytes; no gameplay/damage/teleport hooks; normal formal Play was verified separately';
  evidence.pressureCost=await measureVfxCost(cdp,{onProgress:p=>fs.writeFileSync(path.join(out,'pressure-cost-progress.json'),JSON.stringify(p,null,2))});await capture('08-graph-budget-play');await stop('pressureStopped');
 }finally{network.graphProjection=false;fs.writeFileSync(fixture,goodScene);fs.writeFileSync(assetCopy,goodAsset);fs.writeFileSync(assetCopy+'.meta.json',goodMeta);}
 await reload();await start();await stop('beforeSwitchStopped');await click('.scene-current');if(!await waitFor(()=>cdp.eval('!!document.querySelector(".scene-browser-list .scene-choice")')))throw new Error('场景菜单未打开');
 await cdp.eval(`(()=>{const n=[...document.querySelectorAll('.scene-browser-list .scene-choice')].find(n=>n.innerText.includes(${JSON.stringify(emptyFixture)}));if(!n)throw new Error('空图场景未登记');n.dataset.graphEmpty='true';})()`);await click('.scene-choice[data-graph-empty="true"]');
 check('显式Stop后实际UI场景切换',await waitFor(()=>cdp.eval(`window.__editor.renderer.getDocument()?.id===${JSON.stringify(empty.id)}`)));await click('#btn-play');if(!await waitFor(()=>cdp.eval('window.__editor.vfx.snapshot().play.gpu?.textures===3')))throw new Error('空图场景合法旧武器未就绪');evidence.sceneSwap=(await snap()).play;
 check('新场景不复活旧图作者/GPU资源',evidence.sceneSwap.authored.ready.length===0 && evidence.sceneSwap.gpu.buffers===2 && !evidence.sceneSwap.authored.gpu?.handles);await stop('sceneSwapStopped');
}
