/** WU08完整引用准入：原生Scene Apply/Preview，精确IO故障，正式文件不写入。 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {runGameProbe} from './game-probe-lib.mjs';
import {createRecorder,makeArgParser,waitFor} from './editor-smoke-lib.mjs';
import {clickFocusedElement} from './clipboard-probe.mjs';
const {arg,has}=makeArgParser(process.argv),outDir=path.resolve(arg('out','.workbuddy/tmp/wu08-admission'));
if(!has('headed'))throw new Error('本机真实GPU验收必须 --headed');
const P='assets/fracture/p01-barrel/p01-barrel.fracture.json',profile=JSON.parse(fs.readFileSync(P,'utf8'));
const proxyPath='assets/fracture/p01-barrel/_wu08-virtual-convex.glb',proxyGuid='as_wu08_virtual_convex';
const bytes=fs.readFileSync(profile.chunks[0].mesh.path),proxyMeta=JSON.parse(fs.readFileSync(profile.chunks[0].mesh.path+'.meta.json','utf8'));
proxyMeta.guid=proxyGuid;profile.chunks[0].proxy.shape={type:'convex',mesh:{path:proxyPath,guid:proxyGuid}};
const profileText=JSON.stringify(profile),profileMeta=JSON.parse(fs.readFileSync(P+'.meta.json','utf8'));
const hash=x=>createHash('sha256').update(x).digest('hex');profileMeta.sourceHash='sha256:'+hash(profileText);
const originals=[P,P+'.meta.json','aether.project.json','assets/scenes/sandbox/fracture-wu06.scene.json',profile.source.model.path,profile.source.model.path+'.meta.json',...profile.chunks.flatMap(c=>[c.mesh.path,c.mesh.path+'.meta.json'])];
const fileHashes=Object.fromEntries(originals.map(p=>[p,hash(fs.readFileSync(p))]));
const sourcePaths=['packages/runtime/src/fracture-activation.ts','packages/runtime/src/doc-diff.ts','apps/editor/src/services/author-resource-document.ts','apps/editor/src/services/fracture-panel.ts','apps/editor/src/services/fracture-preview.ts','apps/editor/src/services/fracture-author-draft.ts','tools/verify/wu08-admission-probe.mjs','tools/verify/game-probe-lib.mjs','tools/verify/editor-smoke-lib.mjs'];
const sourceHashes=Object.fromEntries(sourcePaths.map(p=>[p,hash(fs.readFileSync(p))]));
const {results,check,summary}=createRecorder(),state=cdp=>cdp.eval('window.__editor.fractureAuthor.snapshot()');
async function settle(cdp){await cdp.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');}
async function click(cdp,text){const e=`[...document.querySelectorAll('#fracture-panel button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
 if(!await waitFor(()=>cdp.eval(`!!(${e})&&!(${e}).matches(':disabled')`),{timeout:15000}))throw Error('控件未就绪 '+text);
 await cdp.eval(`(${e}).scrollIntoView({block:'center'})`);await settle(cdp);await clickFocusedElement(cdp,e);}
async function enter(cdp,label,value){const e=`document.querySelector('#fracture-panel [aria-label=${JSON.stringify(label)}]')`;
 await cdp.eval(`(${e}).scrollIntoView({block:'center'})`);await settle(cdp);await clickFocusedElement(cdp,e);
 for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});
 await cdp.send('Input.insertText',{text:String(value)});for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9});}
async function applied(cdp){if(!await waitFor(async()=>{const s=await state(cdp);return !s.applyingNode&&!s.applyingAsset&&!s.locked;},{timeout:20000}))throw Error('Apply没有完成');}
async function holdAssetMeta(cdp,target){await cdp.eval(`(()=>{const original=window.fetch;let release;const gate=new Promise(r=>release=r),r=window.__assetAdmissionGate={used:false,finished:false,release,restore:()=>window.fetch=original};window.fetch=async(...args)=>{const response=await original(...args),input=args[0],u=new URL(typeof input==='string'?input:input.url,location.href);if(!r.used&&u.pathname==='/__fs/file'&&u.searchParams.get('path')===${JSON.stringify(target+'.meta.json')}){r.used=true;const ok=await gate;r.finished=true;if(!ok)throw new Error('late asset admission failure');}return response;};return true;})()`);}
async function assetEntered(cdp){if(!await waitFor(()=>cdp.eval('window.__assetAdmissionGate.used'),{timeout:10000}))throw Error('资产Apply未进入真实引用IO');}
process.exitCode=await runGameProbe({name:'wu08-admission',outDir,port:Number(arg('port',5100)),cdpPort:Number(arg('cdp',9498)),chromePath:arg('chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),headed:true,windowPosition:'1920,80',windowSize:'1600,1000',scene:'assets/scenes/sandbox/fracture-wu06.scene.json',results,check,summary},async({cdp,details})=>{
 details.gitHead=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();details.sourceHashes=sourceHashes;details.formalFileHashes=fileHashes;
 details.variant={note:'仅当前tab的profile响应改为合法独立convex引用；虚拟IO提供正式chunk原字节，所有原文件不写入。',path:proxyPath,guid:proxyGuid,byteHash:hash(bytes),profileTextHash:hash(profileText)};
 // 受控IO只提供当前tab的验证数据；正常请求仍交给真实devfs。
 await cdp.eval(`(()=>{const original=window.fetch,P=${JSON.stringify(P)},proxy=${JSON.stringify(proxyPath)},profile=${JSON.stringify(profileText)},profileMeta=${JSON.stringify(profileMeta)},proxyMeta=${JSON.stringify(proxyMeta)},data=Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),c=>c.charCodeAt(0));
 const r=window.__wu08Admission={mode:'ok',target:'',hits:0,payload:null,payloadHash:null,metaHash:null,restore:()=>window.fetch=original};
 const badContent=async()=>{if(r.payload)return r.payload;const buffer=r.target===proxy?data.slice().buffer:await(await original('/__fs/file?path='+encodeURIComponent(r.target))).arrayBuffer(),v=new DataView(buffer);let off=12,jstart=-1,jlength=0,bin=0;
  while(off+8<=buffer.byteLength){const n=v.getUint32(off,true),type=v.getUint32(off+4,true);if(type===0x4e4f534a){jstart=off+8;jlength=n;}if(type===0x004e4942)bin=off+8;off+=8+n+(4-n%4)%4;}if(jstart<0)throw Error('合法GLB故障夹具缺JSON');
  if(r.mode==='binary-content'){const b=new Uint8Array(buffer);let p=jstart;while([32,9,10,13].includes(b[p]))p++;b[p]=33;}
  else{const json=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,jstart,jlength))),positions=new Set(json.meshes.flatMap(m=>m.primitives.map(p=>p.attributes.POSITION)));for(const index of positions){const a=json.accessors[index],b=json.bufferViews[a.bufferView];if(a.componentType!==5126)throw Error('POSITION故障夹具需FLOAT');const stride=b.byteStride??12,start=bin+(b.byteOffset??0)+(a.byteOffset??0);for(let i=0;i<a.count;i++)v.setFloat32(start+i*stride,NaN,true);}}
  r.payload=buffer;r.payloadHash='sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),x=>x.toString(16).padStart(2,'0')).join('');return buffer;};
 window.fetch=async(...args)=>{const input=args[0],u=new URL(typeof input==='string'?input:input.url,location.href),p=u.searchParams.get('path');if(u.pathname!=='/__fs/file')return original(...args);
  if(p===P)return new Response(profile,{headers:{'Content-Type':'application/json'}});if(p===P+'.meta.json')return new Response(JSON.stringify(profileMeta),{headers:{'Content-Type':'application/json'}});
  const metaRequest=p===r.target+'.meta.json',binaryRequest=p===r.target;
  if((r.mode==='binary-content'||r.mode==='binary-nonfinite')&&(metaRequest||binaryRequest)){r.hits++;const bad=await badContent();if(binaryRequest)return new Response(bad);const response=p===proxy+'.meta.json'?new Response(JSON.stringify(proxyMeta)):await original(...args),meta=await response.json();meta.sourceHash=r.payloadHash;r.metaHash=meta.sourceHash;return new Response(JSON.stringify(meta),{headers:{'Content-Type':'application/json'}});}
  if(r.mode!=='ok'&&(metaRequest||binaryRequest)){
   r.hits++;
   if(metaRequest&&!r.mode.startsWith('binary-')){if(r.mode==='meta-missing')throw new Error('WU08 current sidecar missing');const response=p===proxy+'.meta.json'?new Response(JSON.stringify(proxyMeta)):await original(...args),meta=await response.json();
    if(r.mode==='guid')meta.guid='as_current_wrong';if(r.mode==='kind')meta.kind='fracture';if(r.mode==='quarantined')meta.userData={...meta.userData,status:'quarantined'};if(r.mode==='future')meta.schemaVersion=999;return new Response(JSON.stringify(meta),{headers:{'Content-Type':'application/json'}});}
   if(binaryRequest&&r.mode==='binary-missing')throw new Error('WU08 current binary missing');if(binaryRequest&&r.mode==='binary-invalid')return new Response(new Uint8Array(4));
  }
  if(p===proxy+'.meta.json')return new Response(JSON.stringify(proxyMeta),{headers:{'Content-Type':'application/json'}});if(p===proxy)return new Response(data,{headers:{'Content-Type':'application/octet-stream'}});return original(...args);};return true;})()`);
 try{
  await clickFocusedElement(cdp,`document.querySelector('.insp-tab[data-tab="scene"]')`);
  const node=`document.querySelector('#fracture-panel [aria-label="碎裂作者节点"]')`,index=await cdp.eval(`Array.from((${node}).options).findIndex(o=>o.value==='nd_fr_barrel')`);
  if(index<0)throw Error('正式P01节点不可达');await clickFocusedElement(cdp,node);
  for(const key of ['Home',...Array(index).fill('ArrowDown'),'Enter','Tab'])for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode:({Home:36,ArrowDown:40,Enter:13,Tab:9})[key]});
  await enter(cdp,'碎裂资源路径',P);await click(cdp,'打开碎裂资源');if(!await waitFor(async()=>{const s=await state(cdp);return !s.resourceLoading&&s.path===P;},{timeout:10000}))throw Error('原资产表单打开失败');
  await enter(cdp,'碎裂寿命 s','9');details.cases=[];
  const refs={source:profile.source.model.path,chunk:profile.chunks[0].mesh.path,convex:proxyPath};
  for(const [kind,target]of Object.entries(refs))for(const mode of ['guid','kind','quarantined','future','meta-missing','binary-missing','binary-invalid','binary-content','binary-nonfinite']){
   const label=kind+'/'+mode,before=await cdp.eval('JSON.stringify(window.__editor.renderer.getDocument())'),expectedStage=mode==='quarantined'?'quarantined':mode==='meta-missing'?'ref-read':mode.startsWith('binary-')?'ref-binary':'ref-identity';
   const assetBefore=await state(cdp),assetBeforeJson=JSON.stringify(assetBefore.asset),ttl=assetBefore.asset.playback.lifetimeSec===9?'10':'9';await enter(cdp,'碎裂寿命 s',ttl);
   const value=String(Number(await cdp.eval(`document.querySelector('#fracture-panel [aria-label="初始耐久"]').value`))+1);
   await enter(cdp,'初始耐久',value);await cdp.eval(`Object.assign(window.__wu08Admission,{target:${JSON.stringify(target)},mode:${JSON.stringify(mode)},hits:0,payload:null,payloadHash:null,metaHash:null})`);await click(cdp,'应用碎裂配置');await applied(cdp);
   const after=await cdp.eval('JSON.stringify(window.__editor.renderer.getDocument())'),apply=await cdp.eval(`({hits:window.__wu08Admission.hits,status:document.querySelector('#fracture-panel [role=status]').textContent,pending:document.querySelector('#fracture-panel [aria-label="初始耐久"]').value,ttl:document.querySelector('#fracture-panel [aria-label="碎裂寿命 s"]').value,payloadHash:window.__wu08Admission.payloadHash,metaHash:window.__wu08Admission.metaHash,bytes:window.__wu08Admission.payload?.byteLength??0,declared:window.__wu08Admission.payload?new DataView(window.__wu08Admission.payload).getUint32(8,true):0})`);
   const record={kind,mode,target,beforeHash:hash(before),afterHash:hash(after),apply};details.cases.push(record);
   const alignedContent=!['binary-content','binary-nonfinite'].includes(mode)||apply.payloadHash===apply.metaHash&&/^sha256:[0-9a-f]{64}$/.test(apply.payloadHash)&&apply.bytes>20&&apply.bytes===apply.declared;
   check(label+'：坏引用Apply拒绝，原Document与新草稿保留',before===after&&apply.hits>0&&apply.pending===value&&apply.ttl===ttl&&apply.status.includes(target)&&apply.status.includes(expectedStage)&&alignedContent,JSON.stringify(record));
   await cdp.eval('window.__wu08Admission.hits=0');await click(cdp,'应用碎裂资产参数');await applied(cdp);
   const assetAfter=await state(cdp);record.assetApply={beforeHash:hash(assetBeforeJson),afterHash:hash(JSON.stringify(assetAfter.asset)),beforeUndo:assetBefore.assetUndoDepth,afterUndo:assetAfter.assetUndoDepth,hits:await cdp.eval('window.__wu08Admission.hits'),diagnostic:assetAfter.diagnostic};
   check(label+'：资产Apply同样拒绝，原资产与历史/草稿保留',record.assetApply.beforeHash===record.assetApply.afterHash&&record.assetApply.beforeUndo===record.assetApply.afterUndo&&record.assetApply.hits>0&&assetAfter.diagnostic.includes(target)&&assetAfter.diagnostic.includes(expectedStage)&&await cdp.eval(`document.querySelector('#fracture-panel [aria-label="碎裂寿命 s"]').value`)===ttl,JSON.stringify(record.assetApply));
   await cdp.eval('window.__wu08Admission.hits=0');await click(cdp,'开始/重播碎裂预览');if(!await waitFor(async()=>!!(await state(cdp)).preview.diagnostic,{timeout:15000}))throw Error(label+' Preview没有诊断');
   record.preview=await cdp.eval(`(()=>{const e=window.__editor,s=e.fractureAuthor.snapshot();return {hits:window.__wu08Admission.hits,ready:s.preview.ready,diagnostic:s.preview.diagnostic,backend:e.fractureAuthor.resources()?.backend()?.ledger??null,meshes:[...e.renderer.core.dynamicMeshes.keys()].filter(x=>x.startsWith(s.preview.owner+':')).length};})()`);
   check(label+'：同一当前引用在World/GPU前拒绝',record.preview.hits>0&&!record.preview.ready&&record.preview.backend===null&&record.preview.meshes===0&&record.preview.diagnostic.includes(target)&&record.preview.diagnostic.includes(expectedStage),JSON.stringify(record.preview));
   await cdp.eval("window.__wu08Admission.mode='ok'");await click(cdp,'应用碎裂资产参数');await applied(cdp);const recoveredAsset=await state(cdp);
   record.assetRecovery={ttl:recoveredAsset.asset.playback.lifetimeSec,undo:recoveredAsset.assetUndoDepth};check(label+'：恢复后原资产草稿Apply为一笔历史',recoveredAsset.asset.playback.lifetimeSec===Number(ttl)&&recoveredAsset.assetUndoDepth===assetBefore.assetUndoDepth+1,JSON.stringify(record.assetRecovery));
   await click(cdp,'应用碎裂配置');await applied(cdp);
   record.recoveredDurability=await cdp.eval(`window.__editor.renderer.getDocument().nodes.find(n=>n.id==='nd_fr_barrel').components.find(c=>c.kind==='Destructible').maxDurability`);
   check(label+'：恢复后原场景草稿Apply成功',record.recoveredDurability===Number(value));
   await click(cdp,'开始/重播碎裂预览');if(!await waitFor(async()=>(await state(cdp)).preview.ready,{timeout:20000}))throw Error(label+' 恢复没有就绪');await click(cdp,'触发碎裂预览');
   if(!await waitFor(async()=>{const s=(await state(cdp)).preview;return s.active===profile.chunks.length&&!s.takingOver&&!s.sourceVisible;},{timeout:15000}))throw Error(label+' 恢复没有真实draw回执');
   record.recovery=await cdp.eval(`(()=>{const e=window.__editor,s=e.fractureAuthor.snapshot().preview;return {active:s.active,bodies:e.fractureAuthor.resources().backend().ledger.dynamicBodies,sourceVisible:s.sourceVisible,pool:s.stats.poolActive,owner:s.owner,meshes:[...e.renderer.core.dynamicMeshes.keys()].filter(x=>x.startsWith(s.owner+':')).length};})()`);
   check(label+'：恢复后真实物理/GPU接管',record.recovery.active===profile.chunks.length&&record.recovery.bodies===profile.chunks.length&&!record.recovery.sourceVisible&&record.recovery.meshes>0,JSON.stringify(record.recovery));await click(cdp,'停止碎裂预览');
  }
  // 保留真实引用fetch，仅延后其响应；新输入和关闭/新Apply分别隔离旧异步结果。
  const stable=await state(cdp),stableJson=JSON.stringify(stable.asset);await enter(cdp,'碎裂寿命 s','7');await holdAssetMeta(cdp,profile.source.model.path);
  try{
   await click(cdp,'应用碎裂资产参数');await assetEntered(cdp);await enter(cdp,'碎裂寿命 s','8');await cdp.eval('window.__assetAdmissionGate.release(true)');await applied(cdp);
   const changed=await state(cdp);details.changedDuringAdmission={before:hash(stableJson),after:hash(JSON.stringify(changed.asset)),undoBefore:stable.assetUndoDepth,undoAfter:changed.assetUndoDepth,diagnostic:changed.diagnostic};
   check('资产Apply校验期间的新输入保留，旧候选不改资产/历史',JSON.stringify(changed.asset)===stableJson&&changed.assetUndoDepth===stable.assetUndoDepth&&await cdp.eval(`document.querySelector('#fracture-panel [aria-label="碎裂寿命 s"]').value`)==='8'&&changed.diagnostic.includes('新的资产输入'),JSON.stringify(details.changedDuringAdmission));
  }finally{await cdp.eval('window.__assetAdmissionGate.restore()');}
  await holdAssetMeta(cdp,profile.source.model.path);
  try{
   await click(cdp,'应用碎裂资产参数');await assetEntered(cdp);await clickFocusedElement(cdp,`document.querySelector('#fracture-panel > summary')`);await waitFor(async()=>!(await state(cdp)).applyingAsset,{timeout:5000});
   await clickFocusedElement(cdp,`document.querySelector('#fracture-panel > summary')`);await enter(cdp,'碎裂寿命 s','12');await click(cdp,'应用碎裂资产参数');await applied(cdp);
   const latest=await state(cdp),latestJson=JSON.stringify(latest.asset),diagnostic=latest.diagnostic;await cdp.eval('window.__assetAdmissionGate.release(false)');await waitFor(()=>cdp.eval('window.__assetAdmissionGate.finished'),{timeout:5000});await settle(cdp);
   const final=await state(cdp);details.closedDuringAdmission={ttl:final.asset.playback.lifetimeSec,undo:final.assetUndoDepth,diagnostic:final.diagnostic};
   check('关闭面板后的迟到资产准入失败不覆盖新Apply/历史/诊断',latest.asset.playback.lifetimeSec===12&&JSON.stringify(final.asset)===latestJson&&final.assetUndoDepth===latest.assetUndoDepth&&final.diagnostic===diagnostic&&!final.applyingAsset,JSON.stringify(details.closedDuringAdmission));
  }finally{await cdp.eval('window.__assetAdmissionGate.restore()');}
 }finally{await cdp.eval('window.__wu08Admission?.restore()');}
 details.sourceChanges=sourcePaths.filter(p=>hash(fs.readFileSync(p))!==sourceHashes[p]);details.fileChanges=originals.filter(p=>hash(fs.readFileSync(p))!==fileHashes[p]);
 if(details.sourceChanges.length||details.fileChanges.length)throw Error('验收期间源或正式文件字节变化：'+JSON.stringify({source:details.sourceChanges,files:details.fileChanges}));
});
