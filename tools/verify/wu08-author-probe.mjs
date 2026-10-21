/** WU08真实作者路径；只写每轮独占的profile/场景副本，清理时保留其它项目修改。 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {withProjectWriteLock,atomicWriteText,writeTypedAssetWithMeta} from '../fs/project-write.mjs';
import {runGameProbe,playPaused,stopProbe} from './game-probe-lib.mjs';
import {createRecorder,waitFor,sleep,waitForEditorReady,makeArgParser} from './editor-smoke-lib.mjs';
const {arg,has}=makeArgParser(process.argv),root=process.cwd();
const outDir=path.resolve(arg('out','.workbuddy/tmp/wu08-author'));
const token=randomUUID().replaceAll('-','').slice(0,10),prefix=`assets/fracture/_wu08-${token}`,scene=`assets/scenes/custom/wu08-${token}.scene.json`;
const refs={object:{path:prefix+'/p01.fracture.json',guid:'as_wu08p'+token},npc:{path:prefix+'/e04.fracture.json',guid:'as_wu08e'+token}};
const originals={object:'assets/fracture/p01-barrel/p01-barrel.fracture.json',npc:'assets/fracture/e04-bulwark/e04-bulwark.fracture.json'};
const {results,check,summary}=createRecorder();
const originalBytes=Object.fromEntries(Object.values(originals).flatMap(p=>[p,p+'.meta.json']).map(p=>[p,fs.readFileSync(p)]));
const baseline={};
const json=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const sourcePaths=[...new Set([...execFileSync('git',['ls-files','-z','--','apps/editor/src','packages/runtime/src','packages/render/src','packages/scene/src','packages/zombie-game/src'],{encoding:'utf8'}).split('\0').filter(Boolean),
 'apps/editor/src/services/author-resource-document.ts','apps/editor/src/services/fracture-author-draft.ts','apps/editor/src/services/fracture-panel.ts','apps/editor/src/services/fracture-preview.ts',
 'apps/editor/vite.config.ts','tools/fs/project-write.mjs','tools/fs/rename-project.mjs','tools/verify/wu08-author-probe.mjs'])];
const sourceHashes=Object.fromEntries(sourcePaths.map(p=>[p,hash(fs.readFileSync(p))]));
async function key(cdp,key,code=key,modifiers=0){const vk={Home:36,End:35,Enter:13,Tab:9,ArrowDown:40,Escape:27};await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers,windowsVirtualKeyCode:vk[key]??0});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers,windowsVirtualKeyCode:vk[key]??0});}
async function click(cdp,selector,button='left'){
 const p=await waitFor(async()=>{
  await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(e)e.scrollIntoView({block:'center'});})()`);
  return cdp.eval(`(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.matches(':disabled'))return null;const r=e.getBoundingClientRect(),x=Math.min(innerWidth-5,r.x+r.width/2),y=r.y+r.height/2;return e.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`);
 },{timeout:15000,interval:50,label:'控件完成重排且实际可用 '+selector});
 if(!p)throw new Error('控件不可用或被遮挡：'+selector);
 await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button,clickCount:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button,clickCount:1});
}

async function textClick(cdp,text,scope='#fracture-panel'){
 const id='wu08-'+randomUUID();const selector=await cdp.eval(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(scope+' button, '+scope+' summary')})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw new Error('找不到控件 '+${JSON.stringify(text)});e.dataset.wu08=${JSON.stringify(id)};return '[data-wu08="'+e.dataset.wu08+'"]';})()`);
 try{await click(cdp,selector);if(text==='应用碎裂配置'||text==='应用碎裂资产参数')await waitFor(async()=>{const s=await state(cdp);return !s.applyingNode&&!s.applyingAsset;},{timeout:15000,label:'当前引用准入完成'});}finally{await cdp.eval(`document.querySelector(${JSON.stringify(selector)})?.removeAttribute('data-wu08')`);}
}
async function fill(cdp,label,value,scope='#fracture-panel'){
 await input(cdp,`${scope} [aria-label=${JSON.stringify(label)}]`,value);
}
async function input(cdp,selector,value,finish='Tab'){
 await click(cdp,selector);
 await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});
 await cdp.send('Input.insertText',{text:String(value)});await key(cdp,finish);
}
async function pick(cdp,label,value){const sel=`#fracture-panel [aria-label=${JSON.stringify(label)}]`,index=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});return [...e.options].findIndex(o=>o.value===${JSON.stringify(value)});})()`);if(index<0)throw new Error('缺少选项 '+value);await click(cdp,sel);await key(cdp,'Home');for(let i=0;i<index;i++)await key(cdp,'ArrowDown');await key(cdp,'Enter');await key(cdp,'Tab');}
const state=cdp=>cdp.eval('window.__editor.fractureAuthor.snapshot()');
const status=cdp=>cdp.eval(`document.querySelector('#fracture-panel [role=status]').textContent`);
const readField=(cdp,label)=>cdp.eval(`document.querySelector('#fracture-panel [aria-label=${JSON.stringify(label)}]').value`);
async function shot(cdp,name){const x=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(outDir,name+'.png'),Buffer.from(x.data,'base64'));}
async function open(cdp,kind,nodeId){await pick(cdp,'碎裂作者节点',nodeId);await fill(cdp,'碎裂资源路径',refs[kind].path);const previous=(await state(cdp)).openId;await textClick(cdp,'打开碎裂资源');if(!await waitFor(async()=>{const s=await state(cdp);return s.openId>previous&&!s.resourceLoading&&s.path===refs[kind].path;},{timeout:10000,label:'真实资源表单完成'}))throw new Error(await status(cdp));}
async function checked(cdp,label,value){const selector=`#fracture-panel [aria-label=${JSON.stringify(label)}]`;if(await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).checked`)!==value)await click(cdp,selector);}
async function start(cdp){await textClick(cdp,'开始/重播碎裂预览');if(!await waitFor(async()=> (await state(cdp)).preview.ready,{timeout:30000,label:'Preview正式准入/World'}))throw new Error(await status(cdp));}
async function stop(cdp){await textClick(cdp,'停止碎裂预览');await sleep(100);}
async function takeover(cdp){if(!await waitFor(async()=>{const s=(await state(cdp)).preview;return s.triggered&&!s.sourceVisible&&!s.takingOver&&s.active>0;},{timeout:12000,label:'真实GPU绘制回执接管'}))throw new Error(JSON.stringify(await state(cdp)));}
async function holdResources(cdp){return cdp.eval(`(()=>{
 const e=window.__editor,c=e.renderer.core,s=e.fractureAuthor.snapshot().preview,b=e.fractureAuthor.resources();
 const runtime=b.runtime,backend=b.backend(),world=backend.world,held=[];
 const wrap=(resource,kind)=>{if(held.some(x=>x.resource===resource))return;const x={resource,kind,calls:0},destroy=resource.destroy.bind(resource);resource.destroy=()=>{x.calls++;destroy();};held.push(x);};
 for(const [id,m]of c.dynamicMeshes)if(id.startsWith(s.owner+':'))for(const k of ['vbuf','ibuf','skinVb'])wrap(m[k],'mesh');
 for(const slot of c.dynamicOwnedInstSlots.get(s.owner)??[])if(slot)for(const k of ['buf','poseBuf','rigidBuf'])wrap(slot[k],'instance');
 for(const [id,m]of c.dynamicMaterials)if(id.startsWith(s.owner+':'))wrap(m.texture,'texture');
 const free=world.free.bind(world),record={owner:s.owner,runtime,backend,world,worldFreeCalls:0,held,handles:runtime.active.map(x=>x.handle),sharedCalls:0};world.free=()=>{record.worldFreeCalls++;free();};
 const shared=c.frameBuf,sharedDestroy=shared.destroy.bind(shared);shared.destroy=()=>{record.sharedCalls++;sharedDestroy();};window.__wu08Held=record;
 return {owner:s.owner,bodies:backend.ledger.dynamicBodies,meshes:held.filter(x=>x.kind==='mesh').length,instances:held.filter(x=>x.kind==='instance').length,textures:held.filter(x=>x.kind==='texture').length};
})()`);}
async function released(cdp){return cdp.eval(`(()=>{const h=window.__wu08Held;return {owner:h.owner,disposed:h.runtime.disposed,active:h.runtime.active.length,pool:h.runtime.stats.poolActive,queue:h.runtime.stats.queuedEvents,backend:h.backend.ledger,worldFreeCalls:h.worldFreeCalls,oldHandlesNull:h.handles.every(x=>h.backend.snapshot(x)===null),resources:h.held.map(x=>({kind:x.kind,calls:x.calls})),sharedCalls:h.sharedCalls};})()`);}
const releasedOkay=r=>r.disposed&&r.active===0&&r.pool===0&&r.queue===0&&r.backend.destroyed&&r.backend.dynamicBodies===0&&r.worldFreeCalls===1&&r.oldHandlesNull&&r.resources.length>0&&r.resources.every(x=>x.calls===1)&&r.sharedCalls===0;
async function gateRead(cdp,target){await cdp.eval(`(()=>{const original=window.fetch;let release;const gate=new Promise(r=>release=r),record={used:false,release,restore:()=>{window.fetch=original;}};window.__wu08Pending=record;window.fetch=async(...args)=>{const response=await original(...args);const input=args[0],url=new URL(typeof input==='string'?input:input.url,location.href);if(!record.used&&url.pathname==='/__fs/file'&&url.searchParams.get('path')===${JSON.stringify(target)}){record.used=true;const ok=await gate;if(!ok)throw new Error('WU08 late IO failure');}return response;};})()`);}
async function entered(cdp){if(!await waitFor(()=>cdp.eval('window.__wu08Pending.used'),{timeout:10000,label:'实际IO边界已进入'}))throw new Error('没有进入受控读取');}
async function releaseRead(cdp,ok){await cdp.eval(`window.__wu08Pending.release(${ok});window.__wu08Pending.restore()`);await sleep(150);}
async function makeFixtures(){await withProjectWriteLock(root,async()=>{
 fs.mkdirSync(prefix,{recursive:true});for(const kind of ['object','npc']){
  const a=json(originals[kind]),meta=json(originals[kind]+'.meta.json');a.id=refs[kind].guid;a.name+=' · WU08独占验收副本';
  if(kind==='object'){
    const chunk=a.chunks[0],source=chunk.mesh.path,target=prefix+'/chunk-copy.glb',chunkMeta=json(source+'.meta.json');
    chunkMeta.guid='as_wu08c'+token;fs.writeFileSync(target,fs.readFileSync(source),{flag:'wx'});fs.writeFileSync(target+'.meta.json',JSON.stringify(chunkMeta,null,2)+'\n',{flag:'wx'});chunk.mesh={path:target,guid:chunkMeta.guid};
  }
  const text=JSON.stringify(a,null,2)+'\n';meta.guid=a.id;meta.sourceHash='sha256:'+hash(text);
  fs.writeFileSync(refs[kind].path,text,{flag:'wx'});fs.writeFileSync(refs[kind].path+'.meta.json',JSON.stringify(meta,null,2)+'\n',{flag:'wx'});baseline[kind]=a;
 }
});}
async function cleanup(){await withProjectWriteLock(root,async()=>{
 const projectPath=path.resolve('aether.project.json'),project=json(projectPath),owned=project.scenes.find(s=>s.path===scene);
 if(owned){if(!fs.existsSync(scene)||json(scene).id!==owned.id)throw new Error('独占场景身份已改变，拒绝自动清理');project.scenes=project.scenes.filter(s=>s!==owned);await atomicWriteText(projectPath,JSON.stringify(project,null,2)+'\n');fs.unlinkSync(scene);}
 const absolute=fs.realpathSync(prefix),allowed=path.resolve(root,'assets/fracture');
 if(!absolute.startsWith(allowed+path.sep)||path.basename(absolute)!=='_wu08-'+token)throw new Error('独占夹具清理路径越界');fs.rmSync(absolute,{recursive:true});
 for(const [p,b]of Object.entries(originalBytes))if(!fs.readFileSync(p).equals(b))throw new Error('正式profile被验收改写：'+p);
});}
try{
 await makeFixtures();
 process.exitCode=await runGameProbe({name:'wu08-author',outDir,port:Number(arg('port',5100)),cdpPort:Number(arg('cdp',9498)),chromePath:arg('chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),headed:has('headed'),windowPosition:'1920,80',windowSize:'1600,1000',scene:'assets/scenes/sandbox/fracture-wu06.scene.json',results,check,summary},async({cdp,details})=>{
  details.fixture={scene,refs,baselineHashes:Object.fromEntries(Object.entries(originalBytes).map(([p,b])=>[p,hash(b)]))};
  details.sourceHashes=sourceHashes;details.gitHead=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  await textClick(cdp,'文件','.tb-menus');await textClick(cdp,'另存为新场景…','.tb-menus');
  await fill(cdp,'场景名称','WU08作者验收 '+token,'dialog');await fill(cdp,'新场景路径',scene,'dialog');await textClick(cdp,'创建并登记','dialog');
  if(!await waitFor(()=>cdp.eval(`!![...document.querySelectorAll('dialog button')].find(b=>b.textContent==='打开新场景')`),{timeout:10000}))throw new Error('原场景创建未完成');
  const time=await cdp.eval('performance.timeOrigin');await textClick(cdp,'打开新场景','dialog');await waitForEditorReady(cdp,{afterTimeOrigin:time,expectedScene:scene});
  check('原菜单创建并登记独占场景，完整导航到新文档',json('aether.project.json').scenes.some(s=>s.path===scene)&&json(scene).name==='WU08作者验收 '+token);
  await click(cdp,'.insp-tab[data-tab="scene"]');
  await open(cdp,'object','nd_fr_barrel');await textClick(cdp,'移除碎裂配置');
  const component=()=>cdp.eval(`window.__editor.renderer.getDocument().nodes.find(n=>n.id==='nd_fr_barrel').components.find(c=>c.kind==='Destructible')??null`);
  check('原组件命令移除Destructible',await component()===null);
  await textClick(cdp,'撤销碎裂场景修改');await waitFor(async()=>await component()!==null,{timeout:10000});check('原History Undo恢复真实组件',await component()!==null);await waitFor(async()=>!(await state(cdp)).locked&&await cdp.eval('window.__editor.renderer.pendingAssetCount===0'),{timeout:15000,label:'Undo原作者投影完成'});
  await textClick(cdp,'重做碎裂场景修改');await waitFor(async()=>await component()===null,{timeout:10000});check('原History Redo重新删除组件',await component()===null);await waitFor(async()=>!(await state(cdp)).locked,{timeout:15000,label:'Redo原作者投影完成'});
  await open(cdp,'object','nd_fr_barrel');await checked(cdp,'启用碎裂配置',true);await fill(cdp,'初始耐久','63');await checked(cdp,'允许燃烧',true);await textClick(cdp,'应用碎裂配置');
  const configured=await component();check('真实表单新增配置/GUID/path/初始耐久与触发策略',configured?.profile.path===refs.object.path&&configured.profile.guid===refs.object.guid&&configured.maxDurability===63&&configured.trigger.burn,JSON.stringify(configured));
  await fill(cdp,'初始耐久','-1');await textClick(cdp,'应用碎裂配置');check('非法初始耐久保留输入且不改已应用组件',(await component())?.maxDurability===63&&await readField(cdp,'初始耐久')==='-1');
  await pick(cdp,'碎裂作者节点','nd_w6_barrel_b');await pick(cdp,'碎裂作者节点','nd_fr_barrel');check('切换NodeId后返回仍保留该节点非法草稿',await readField(cdp,'初始耐久')==='-1'&&(await component())?.maxDurability===63);await fill(cdp,'初始耐久','63');
  const beforeApplyMeta=json(refs.object.path+'.meta.json');await fill(cdp,'初始耐久','64');
  await withProjectWriteLock(root,()=>atomicWriteText(path.resolve(refs.object.path+'.meta.json'),JSON.stringify({...beforeApplyMeta,guid:'as_wrongcurrentguid'},null,2)+'\n'));
  await textClick(cdp,'应用碎裂配置');check('打开面板后GUID外改，Apply共用当前准入并保留草稿',(await component())?.maxDurability===63&&await readField(cdp,'初始耐久')==='64'&&(await status(cdp)).includes('GUID'));
  await withProjectWriteLock(root,()=>atomicWriteText(path.resolve(refs.object.path+'.meta.json'),JSON.stringify(beforeApplyMeta,null,2)+'\n'));await textClick(cdp,'应用碎裂配置');check('GUID恢复后同一草稿可Apply',(await component())?.maxDurability===64);await fill(cdp,'初始耐久','63');await textClick(cdp,'应用碎裂配置');
  await fill(cdp,'碎裂寿命 s','7.5');await fill(cdp,'碎裂淡出 s','1.1');await fill(cdp,'碎裂优先级','2');await textClick(cdp,'应用碎裂资产参数');
  check('资产Apply未写磁盘，源配方仍为原值',json(refs.object.path).playback.lifetimeSec===baseline.object.playback.lifetimeSec);
  await textClick(cdp,'撤销碎裂资产参数');check('资产Undo走同一历史值',Number(await readField(cdp,'碎裂寿命 s'))===baseline.object.playback.lifetimeSec);
  await textClick(cdp,'重做碎裂资产参数');check('资产Redo恢复未保存参数',Number(await readField(cdp,'碎裂寿命 s'))===7.5);
  await fill(cdp,'碎裂寿命 s','-1');await textClick(cdp,'应用碎裂资产参数');check('非法数值保留表单/已应用与磁盘不变',await readField(cdp,'碎裂寿命 s')==='-1'&&(await status(cdp)).includes('非法')&&json(refs.object.path).playback.lifetimeSec===baseline.object.playback.lifetimeSec);
  await fill(cdp,'碎裂寿命 s','7.5');await textClick(cdp,'应用碎裂资产参数');
  await start(cdp);await cdp.eval('(()=>{window.__wu08BeforeUndo=window.__editor.fractureAuthor.resources().backend();return true;})()');await textClick(cdp,'撤销碎裂资产参数');
  check('资产Undo使旧Preview退役，避免继续消费过期参数',!(await state(cdp)).preview.ready&&await cdp.eval('window.__wu08BeforeUndo.ledger.destroyed'));await textClick(cdp,'重做碎裂资产参数');
  await start(cdp);await textClick(cdp,'触发碎裂预览');await sleep(1200);const p01=(await state(cdp)).preview;
  check('未保存参数经过正式准备/真物理预览',p01.active===baseline.object.chunks.length&&!await cdp.eval('window.__editor.playCtl.isPlaying'),JSON.stringify({active:p01.active,event:p01.event?.position,stats:p01.stats}));
  const paused=p01.tick;await sleep(100);check('Pause经过墙钟仍冻结', (await state(cdp)).preview.tick===paused);await textClick(cdp,'碎裂预览单步');check('Step恰推进一次', (await state(cdp)).preview.tick===paused+1);
  await takeover(cdp);details.firstResources=await holdResources(cdp);check('预览实际分配独立GPU几何/实例/贴图和真World',details.firstResources.meshes>0&&details.firstResources.instances>0&&details.firstResources.textures>0&&details.firstResources.bodies>0,JSON.stringify(details.firstResources));
  await shot(cdp,'p01-preview');await stop(cdp);details.firstReleased=await released(cdp);check('Stop实际destroy预览GPU/归还body和lease/free World且共享Editor存活',releasedOkay(details.firstReleased),JSON.stringify(details.firstReleased));
  await textClick(cdp,'保存碎裂资产');if(!await waitFor(async()=>!(await state(cdp)).assetDirty,{timeout:10000}))throw new Error(await status(cdp));
  const saved=fs.readFileSync(refs.object.path);check('原devfs/CAS保存配方及sidecar摘要',json(refs.object.path).playback.lifetimeSec===7.5&&json(refs.object.path+'.meta.json').sourceHash==='sha256:'+hash(saved));
  // 真实磁盘外部改动仅发生在本轮独占副本；没有替换产品CAS或写接口。
  await fill(cdp,'碎裂寿命 s','8');await textClick(cdp,'应用碎裂资产参数');
  await withProjectWriteLock(root,async()=>{const external=json(refs.object.path);external.name+=' external CAS';await writeTypedAssetWithMeta(path.resolve(refs.object.path),JSON.stringify(external,null,2)+'\n','fracture');});
  await textClick(cdp,'保存碎裂资产');await waitFor(async()=>(await status(cdp)).includes('外部修改'),{timeout:10000});
  check('真实CAS冲突保留作者参数并拒绝覆盖外改', (await state(cdp)).assetDirty&&Number(await readField(cdp,'碎裂寿命 s'))===8&&json(refs.object.path).playback.lifetimeSec===7.5&&json(refs.object.path).name.endsWith('external CAS'));
  await textClick(cdp,'从磁盘重载碎裂资产');await waitFor(async()=>!(await state(cdp)).assetDirty,{timeout:10000});
  check('明确重载接受磁盘当前版本',Number(await readField(cdp,'碎裂寿命 s'))===7.5);
  const meta=json(refs.object.path+'.meta.json');await withProjectWriteLock(root,()=>atomicWriteText(path.resolve(refs.object.path+'.meta.json'),JSON.stringify({...meta,userData:{...meta.userData,status:'quarantined'}},null,2)+'\n'));
  await textClick(cdp,'开始/重播碎裂预览');await waitFor(async()=>(await status(cdp)).includes('隔离'),{timeout:5000});check('面板打开后外改隔离在World/GPU前拒绝',!(await state(cdp)).preview.ready&&await cdp.eval('window.__editor.fractureAuthor.resources()===null'));
  await withProjectWriteLock(root,()=>atomicWriteText(path.resolve(refs.object.path+'.meta.json'),JSON.stringify(meta,null,2)+'\n'));await start(cdp);check('恢复accepted后重新预览成功',(await state(cdp)).preview.ready);await stop(cdp);
  await click(cdp,'.hier-row.fn[data-fn-node="nd_fr_spawn"]');await waitFor(async()=>(await state(cdp)).nodeId==='nd_fr_spawn',{timeout:3000});check('原层级功能体选择驱动正确NPC作者目标',(await state(cdp)).nodeId==='nd_fr_spawn');await click(cdp,'.insp-tab[data-tab="scene"]');
  await open(cdp,'npc','nd_fr_spawn');await checked(cdp,'启用碎裂配置',true);await textClick(cdp,'应用碎裂配置');
  await start(cdp);for(let i=0;i<12;i++)await textClick(cdp,'碎裂预览单步');const before=(await state(cdp)).preview;details.npcBefore=before;
  await shot(cdp,'npc-intact');await cdp.eval(`(()=>{const e=window.__editor,s=e.fractureAuthor.snapshot().preview,b=e.renderer.dynamicBatches.find(b=>b.meshId===s.owner+':source:'+s.tick);if(!b||e.renderer.core.dynamicBatchState([b])!=='ready')throw new Error('完整源模型尚未真实绘制');window.__wu08IntactSurface=new Float32Array(b.vertices);})()`);
  await textClick(cdp,'触发碎裂预览');await takeover(cdp);
  details.surface=await cdp.eval(`(()=>{const source=window.__wu08IntactSurface,r=window.__editor.fractureAuthor.resources().runtime,map=new Map(),key=(x,y,z)=>x+','+y+','+z;
   for(const chunk of r.active){const v=chunk.bakedVertices;for(let i=0;i<v.length;i+=15){const p=[v[i],v[i+1],v[i+2]],k=key(...p.map(x=>Math.round(x*10000)));let a=map.get(k);if(!a)map.set(k,a=[]);a.push(p);}}
   let maxError=0,matched=0;for(let i=0;i<source.length;i+=15){const p=[source[i],source[i+1],source[i+2]],q=p.map(x=>Math.round(x*10000));let best=Infinity;
    for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++)for(const b of map.get(key(q[0]+x,q[1]+y,q[2]+z))??[])best=Math.min(best,Math.hypot(p[0]-b[0],p[1]-b[1],p[2]-b[2]));
    if(best<3e-5)matched++;maxError=Math.max(maxError,best);}
   return {sourceVertices:source.length/15,matched,maxError,tolerance:3e-5};})()`);
  check('NPC完整已绘制源表面到碎块全部顶点连续，按接收骨名而非actor下标',details.surface.matched===details.surface.sourceVertices&&details.surface.maxError<details.surface.tolerance,JSON.stringify(details.surface));
  for(let i=0;i<6;i++)await textClick(cdp,'碎裂预览单步');const after=(await state(cdp)).preview;
  check('真实刷怪点非bind当前姿态触发正式10块/大3小7',before.tick===12&&Object.values(baseline.npc.npc.boneMap).every(b=>before.event.npcPose[b]?.length===16)&&before.event.npcPose.Hips.some((v,i)=>Math.abs(v-(i%5===0?1:0))>1e-3)&&after.active===10&&after.stats.rigidActive===3,JSON.stringify({before:{tick:before.tick,position:before.event.position,joints:Object.keys(before.event.npcPose).length},after:{tick:after.tick,active:after.active,stats:after.stats}}));
  await shot(cdp,'npc-fracture');await stop(cdp);
  await textClick(cdp,'保存碎裂场景');if(!await waitFor(()=>json(scene).nodes.find(n=>n.id==='nd_fr_barrel').components.find(c=>c.kind==='Destructible')?.maxDurability===63,{timeout:10000}))throw new Error('作者场景未存盘');
  const diskScene=json(scene),npc=diskScene.nodes.find(n=>n.id==='nd_fr_spawn').components.find(c=>c.kind==='SpawnPoint');
  check('场景Save包含物体和NPC完整GUID/path',npc.deathFracture.profile.path===refs.npc.path&&npc.deathFracture.profile.guid===refs.npc.guid&&diskScene.nodes.find(n=>n.id==='nd_fr_barrel').components.find(c=>c.kind==='Destructible').profile.guid===refs.object.guid);
  await open(cdp,'object','nd_fr_barrel');await fill(cdp,'初始耐久','64');await textClick(cdp,'应用碎裂配置');
  await withProjectWriteLock(root,async()=>{const external=json(scene);external.name+=' external scene CAS';await atomicWriteText(path.resolve(scene),JSON.stringify(external,null,2)+'\n');});
  await textClick(cdp,'保存碎裂场景');await waitFor(()=>cdp.eval(`document.querySelector('.scene-status').textContent.includes('外部修改')`),{timeout:10000});
  check('场景真实CAS拒绝外改并保留当前已应用/未保存配置',(await component())?.maxDurability===64&&json(scene).nodes.find(n=>n.id==='nd_fr_barrel').components.find(c=>c.kind==='Destructible').maxDurability===63&&json(scene).name.endsWith('external scene CAS'));
  const recoveryOrigin=await cdp.eval('performance.timeOrigin');await textClick(cdp,'文件','.tb-menus');await textClick(cdp,'重新载入当前场景','.tb-menus');
  await waitFor(()=>cdp.eval(`!![...document.querySelectorAll('dialog button')].find(b=>b.textContent==='放弃修改并继续')`),{timeout:5000});await textClick(cdp,'放弃修改并继续','dialog');await waitForEditorReady(cdp,{afterTimeOrigin:recoveryOrigin,expectedScene:scene});
  check('CAS后原导航明确放弃本地修改，重载外改版本而非强写覆盖',(await component())?.maxDurability===63&&await cdp.eval(`window.__editor.renderer.getDocument().name.endsWith('external scene CAS')`));
  const timeOrigin=await cdp.eval('performance.timeOrigin');await cdp.send('Page.reload');await waitForEditorReady(cdp,{afterTimeOrigin:timeOrigin,expectedScene:scene});
  check('Stop/Edit整页reload换timeOrigin并恢复场景参数',await cdp.eval('performance.timeOrigin')!==timeOrigin&&(await component())?.maxDurability===63);
  await click(cdp,'.insp-tab[data-tab="scene"]');await open(cdp,'object','nd_fr_barrel');check('整页reload重新打开资产保留全部播放策略',Number(await readField(cdp,'碎裂寿命 s'))===7.5&&Number(await readField(cdp,'碎裂淡出 s'))===1.1&&Number(await readField(cdp,'碎裂优先级'))===2);
  await start(cdp);await textClick(cdp,'触发碎裂预览');await takeover(cdp);check('重载后再次正式Preview', (await state(cdp)).preview.active===baseline.object.chunks.length);details.secondResources=await holdResources(cdp);await stop(cdp);details.secondReleased=await released(cdp);check('多轮预览新owner可用且第二轮实际资源释放',details.firstResources.owner!==details.secondResources.owner&&releasedOkay(details.secondReleased),JSON.stringify(details.secondReleased));
  // 仅替换真实queue.writeBuffer的目标rigid上传故障；保留实际renderer/后端与其它上传。
  await start(cdp);await cdp.eval(`(()=>{const c=window.__editor.renderer.core,q=c.device.queue,original=q.writeBuffer.bind(q),s=window.__editor.fractureAuthor.snapshot().preview,sourceCount=s.batches.length;window.__wu08Fault={calls:0,restore:()=>{q.writeBuffer=original;}};q.writeBuffer=(buffer,...args)=>{const slots=c.dynamicOwnedInstSlots.get(s.owner)??[];if(slots.some((x,i)=>i>=sourceCount&&x?.rigidBuf===buffer)){window.__wu08Fault.calls++;throw new Error('WU08 actual rigid upload fault');}return original(buffer,...args);};})()`);
  await textClick(cdp,'触发碎裂预览');await waitFor(async()=>!!(await state(cdp)).preview.diagnostic,{timeout:10000});details.gpuFault=await cdp.eval(`(()=>{const e=window.__editor,s=e.fractureAuthor.snapshot();return {preview:s.preview,backend:e.fractureAuthor.resources()?.backend()?.ledger,calls:window.__wu08Fault.calls,playing:e.playCtl.isPlaying};})()`);
  check('真实rigid上传失败保留完整源表现并取消本事件body/lease',details.gpuFault.calls>0&&details.gpuFault.preview.sourceVisible&&details.gpuFault.preview.active===0&&details.gpuFault.preview.stats.poolActive===0&&details.gpuFault.backend.dynamicBodies===0&&!details.gpuFault.playing,JSON.stringify(details.gpuFault));
  await cdp.eval('window.__wu08Fault.restore()');await stop(cdp);await start(cdp);await textClick(cdp,'触发碎裂预览');await takeover(cdp);check('真实GPU故障解除后新预览恢复接管',(await state(cdp)).preview.active===baseline.object.chunks.length);await stop(cdp);
  // 原生Stop/选中切换/面板关闭，对应实际fetch边界的迟到成功/失败。
  await gateRead(cdp,refs.object.path+'.meta.json');await textClick(cdp,'开始/重播碎裂预览');await entered(cdp);await stop(cdp);
  await fill(cdp,'碎裂寿命 s','-1');await textClick(cdp,'应用碎裂资产参数');const newDiagnostic=await status(cdp);await releaseRead(cdp,false);
  check('meta迟到失败跨原生Stop不覆盖新草稿诊断/不复活World',await status(cdp)===newDiagnostic&&await readField(cdp,'碎裂寿命 s')==='-1'&&await cdp.eval('window.__editor.fractureAuthor.resources()===null'));
  await fill(cdp,'碎裂寿命 s','7.5');await textClick(cdp,'应用碎裂资产参数');
  await gateRead(cdp,baseline.object.source.model.path);await textClick(cdp,'开始/重播碎裂预览');await entered(cdp);await pick(cdp,'碎裂作者节点','nd_w6_barrel_b');await fill(cdp,'初始耐久','999');await releaseRead(cdp,true);
  check('源GLB迟到成功跨真实选择切换不复活也不改新节点草稿',(await state(cdp)).nodeId==='nd_w6_barrel_b'&&await readField(cdp,'初始耐久')==='999'&&!(await state(cdp)).preview.ready&&await cdp.eval(`window.__editor.renderer.getDocument().nodes.find(n=>n.id==='nd_w6_barrel_b').components.find(c=>c.kind==='Destructible').maxDurability===40`));
  await fill(cdp,'初始耐久','40');await open(cdp,'object','nd_fr_barrel');await start(cdp);
  if(!await waitFor(()=>cdp.eval(`(()=>{const e=window.__editor,s=e.fractureAuthor.snapshot().preview,b=e.renderer.dynamicBatches.filter(b=>b.owner===s.owner);return b.length>0&&e.renderer.core.dynamicBatchState(b)==='ready';})()`),{timeout:10000,label:'当前owner完整源真实draw回执'}))throw new Error('面板关闭资源捕获前没有实际GPU绘制');
  details.beforeClose=await holdResources(cdp);
  await gateRead(cdp,baseline.object.chunks[0].mesh.path);await textClick(cdp,'触发碎裂预览');await entered(cdp);await click(cdp,'#fracture-panel > summary');await waitFor(async()=>!(await state(cdp)).preview.ready,{timeout:3000});await releaseRead(cdp,true);
  details.closedReleased=await released(cdp);check('chunkGLB迟到成功跨面板关闭，旧World/GPU真实释放且不复活',releasedOkay(details.closedReleased)&&!(await state(cdp)).preview.ready,JSON.stringify(details.closedReleased));await click(cdp,'#fracture-panel > summary');
  await playPaused(cdp);const play=await cdp.eval(`(()=>{const r=window.__editor.playCtl.session.runtime;return {objects:r.destructibleSnapshot(),spawns:r.desc.spawns,runId:r.runId};})()`);
  check('重载后真实Play读取原作者配置',play.objects.find(o=>o.nodeId==='nd_fr_barrel')?.hp===63&&play.spawns.find(s=>s.nodeId==='nd_fr_spawn')?.deathFracture.profile.guid===refs.npc.guid,JSON.stringify(play));await stopProbe(cdp,check);
  // 从原资产浏览器/Inspector进入，再通过原右键改名事务移动一份独占chunk。
  await checkedAssetRecursive(cdp);await input(cdp,'[data-asset="filter"]',refs.object.path);
  const profileItem=`[data-asset="content"] [data-path=${JSON.stringify(refs.object.path)}]`;await waitFor(()=>cdp.eval(`!!document.querySelector(${JSON.stringify(profileItem)})`),{timeout:10000});await click(cdp,profileItem);
  await textClick(cdp,'编辑碎裂配方与预览','.insp-pane[data-pane="asset"]');await waitFor(async()=>!(await state(cdp)).resourceLoading&&(await state(cdp)).path===refs.object.path,{timeout:10000});check('原资产Inspector入口可达同一配方/预览表单',(await state(cdp)).path===refs.object.path);
  const oldChunk=prefix+'/chunk-copy.glb',newChunk=prefix+'/chunk-renamed.glb';await input(cdp,'[data-asset="filter"]',oldChunk);
  const chunkItem=`[data-asset="content"] [data-path=${JSON.stringify(oldChunk)}]`;await waitFor(()=>cdp.eval(`!!document.querySelector(${JSON.stringify(chunkItem)})`),{timeout:10000});await click(cdp,chunkItem,'right');await textClick(cdp,'重命名…','#ctx-menu');await input(cdp,'.asset-rename','chunk-renamed.glb','Enter');
  if(!await waitFor(()=>fs.existsSync(newChunk)&&!fs.existsSync(oldChunk),{timeout:20000,label:'原改名事务完成'}))throw new Error('chunk改名未落盘');
  await waitFor(async()=>!(await state(cdp)).resourceLoading,{timeout:10000});const renamed=json(refs.object.path),renamedMeta=json(refs.object.path+'.meta.json');
  check('typed refs改名真实更新profile与sidecar源hash、GUID保持',renamed.chunks[0].mesh.path===newChunk&&renamed.chunks[0].mesh.guid===json(newChunk+'.meta.json').guid&&renamedMeta.sourceHash==='sha256:'+hash(fs.readFileSync(refs.object.path))&&!fs.existsSync(oldChunk+'.meta.json'));
  await click(cdp,'.insp-tab[data-tab="scene"]');await open(cdp,'object','nd_fr_barrel');await start(cdp);await textClick(cdp,'触发碎裂预览');await takeover(cdp);check('改名后的当前资源再次正式预览成功',(await state(cdp)).preview.active===baseline.object.chunks.length);await stop(cdp);
  await click(cdp,'.scene-current');await waitFor(()=>cdp.eval(`!![...document.querySelectorAll('.scene-choice')].find(b=>b.querySelector('small')?.textContent===${JSON.stringify(scene)})`),{timeout:5000});
  const selector=await cdp.eval(`(()=>{const b=[...document.querySelectorAll('.scene-choice')].find(b=>b.querySelector('small')?.textContent===${JSON.stringify(scene)});b.dataset.wu08='reopen';return '[data-wu08="reopen"]';})()`);const previous=await cdp.eval('performance.timeOrigin');await click(cdp,selector);await waitForEditorReady(cdp,{afterTimeOrigin:previous,expectedScene:scene});check('原场景选择器可重新打开保存后的例子',true);
  details.saved={scene:diskScene,objectProfile:json(refs.object.path),npcProfile:json(refs.npc.path)};
  details.sourceChanges=sourcePaths.filter(p=>hash(fs.readFileSync(p))!==sourceHashes[p]);check('真实验收期间受测生产源码与工具冻结不变',details.sourceChanges.length===0,JSON.stringify(details.sourceChanges));
 });
}finally{await cleanup();}

async function checkedAssetRecursive(cdp){if(!await cdp.eval(`document.querySelector('[data-asset="recursive"]').checked`))await click(cdp,'[data-asset="recursive"]');}
