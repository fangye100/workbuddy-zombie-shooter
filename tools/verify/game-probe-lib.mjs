/** 战斗/动态蒙皮探针的受控headed生命周期；断言和场景oracle由各探针负责。 */
import fs from 'node:fs';
import path from 'node:path';
import {ensureServer,launchEditorSession,waitForEditorReady,normalizeEditorState,isHardwareGpu} from './editor-smoke-lib.mjs';

export async function navigateProbeScene(cdp,url,scene) {
  const next=new URL(url);next.searchParams.set('scene',scene);
  const previous=await cdp.eval('performance.timeOrigin');
  await cdp.send('Page.navigate',{url:next.href});
  return waitForEditorReady(cdp,{afterTimeOrigin:previous,expectedScene:scene});
}

/** 点真实工具栏；同一任务内立即暂停，资产装配期间不让模拟先耗尽玩家生命。 */
export async function playPaused(cdp) {
  return cdp.eval(`(()=>{
    const e=window.__editor;
    if(!document.querySelector('#btn-stop').disabled)throw new Error('Play前应已停止');
    window.__gameProbeAuthor={document:JSON.stringify(e.renderer.getDocument()),state:JSON.stringify(e.renderer.snapshotAuthorState()),objects:e.renderer.getObjectList().length};
    document.querySelector('#btn-play').click();
    if(!e.playCtl.isPlaying)throw new Error('Play启动失败：'+e.playCtl.error);
    document.querySelector('#btn-pause').click();
    if(!e.playCtl.isPaused)throw new Error('Play后暂停失败');
    return {runId:e.playCtl.session.runtime.runId,tick:e.playCtl.tick};
  })()`);
}

export async function stopProbe(cdp,check) {
  const state=await cdp.eval(`(async()=>{
    const e=window.__editor,baseline=window.__gameProbeAuthor;
    if(!baseline)throw new Error('缺少Play前作者基线');
    const objects=baseline.objects;
    document.querySelector('#btn-stop').click();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return {stopped:!e.playCtl.isPlaying,ledger:e.playCtl.ledger,ids:e.renderer.debugDynamicMeshIds(),
      runtime:e.playCtl.session.runtime===null,objects,afterObjects:e.renderer.getObjectList().length,
      sameDocument:baseline.document===JSON.stringify(e.renderer.getDocument()),sameState:baseline.state===JSON.stringify(e.renderer.snapshotAuthorState())};
  })()`);
  check('Stop恢复作者文档与静态物件',state.stopped&&state.runtime&&state.sameDocument&&state.sameState&&state.objects===state.afterObjects,JSON.stringify(state));
  check('Stop释放全部Play资源与动态GPU批次',state.ledger.registered>0&&state.ledger.disposed===state.ledger.registered&&state.ledger.pending===0&&state.ids.length===0,JSON.stringify(state.ledger));
  return state;
}

export async function runGameProbe(options,scenario) {
  const {name,outDir,port,cdpPort,chromePath,headed,scene,results,check,summary}=options;
  fs.mkdirSync(outDir,{recursive:true});
  const {server,url}=await ensureServer(port,'apps/editor/vite.config.ts');
  let appUrl,chrome,cdp,ws,hardware=null,executionError=null;
  const details={};
  try {
    appUrl=new URL(options.url??(url.startsWith('https:')?url.replace('localhost','fangye-win11-office.tail6b29a2.ts.net'):url));
    appUrl.searchParams.set('scene',scene);
    ({chrome,cdp,ws}=await launchEditorSession({chromePath,cdpPort,headed,appUrl:appUrl.href,
      windowSize:options.windowSize??'1600,1000',ignoreCertificateErrors:false,setupTimeoutMs:20000}));
    await cdp.send('Page.navigate',{url:appUrl.href});
    await waitForEditorReady(cdp,{expectedScene:scene});
    await normalizeEditorState(cdp);
    hardware=await cdp.eval(`(()=>{const info=window.__editor.renderer.core.device.adapterInfo;return {secure:isSecureContext,fallback:info?.isFallbackAdapter,info:info?{vendor:info.vendor,architecture:info.architecture,description:info.description}:null};})()`);
    check('secure context与实际编辑器硬件GPU',headed?isHardwareGpu(hardware):hardware.secure===true,JSON.stringify(hardware));
    await scenario({cdp,outDir,details,url:appUrl.href});
    return summary(cdp.consoleErrors,cdp.exceptions);
  } catch(error) {
    executionError=error;
    check('探针完整执行到末尾',false,error.message);
    let timer;
    try {
      if(cdp){const shot=await Promise.race([cdp.send('Page.captureScreenshot',{format:'png'}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('失败截图超时')),3000);})]);fs.writeFileSync(path.join(outDir,name+'-failure.png'),Buffer.from(shot.data,'base64'));}
    } catch {} finally {clearTimeout(timer);}
    return summary(cdp?.consoleErrors??[],cdp?.exceptions??[]);
  } finally {
    try {fs.writeFileSync(path.join(outDir,name+'-results.json'),JSON.stringify({scene,url:appUrl?.href??null,hardware,details,results,consoleErrors:cdp?.consoleErrors??[],exceptions:cdp?.exceptions??[]},null,2)+'\n');}
    catch(error){console.error('探针报告写入失败：',error.message);if(!executionError)throw error;}
    finally {ws?.close();try{chrome?.kill();}catch{}try{server?.kill();}catch{}}
  }
}
