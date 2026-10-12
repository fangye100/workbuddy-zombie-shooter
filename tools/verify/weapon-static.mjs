/** 固定候选场景的真实 UI 截图；只读对象身份，选择/滚动/聚焦全部使用 CDP Input。 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {sleep,waitFor} from './editor-smoke-lib.mjs';
export const STATIC_SCENES=['assets/scenes/sandbox/weapon-body-lod-review.scene.json','assets/scenes/sandbox/weapon-fit-review.scene.json'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function staticNodes(root,scene,ids){
 const doc=JSON.parse(fs.readFileSync(path.join(root,scene),'utf8'));
 return ids.map(id=>{const node=doc.nodes.find(n=>n.id===id),mesh=node?.components.find(c=>c.kind==='MeshRenderer');
  if(!mesh||mesh.source.type!=='asset')throw new Error('指定 NodeId 不是候选资产网格 '+id);
  const ref=mesh.source.ref,assetPath=path.resolve(root,ref.path);
  if(!assetPath.startsWith(path.join(root,'assets')+path.sep)||!ref.guid)throw new Error('无效候选 AssetRef '+id);
  const meta=JSON.parse(fs.readFileSync(assetPath+'.meta.json','utf8'));
  if(meta.guid!==ref.guid)throw new Error('候选GUID不一致 '+id);
  return {id,name:node.name,transform:node.transform,asset:{...ref,sha256:hash(fs.readFileSync(assetPath)),metaSha256:hash(fs.readFileSync(assetPath+'.meta.json'))}};
 });
}
async function domPoint(cdp,selector){
 return cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;for(const r of e.getClientRects()){const x=r.x+Math.min(r.width,80)/2,y=r.y+Math.min(r.height,16)/2,t=document.elementFromPoint(x,y);if(r.width>5&&r.height>5&&x>0&&y>0&&x<innerWidth&&y<innerHeight&&(t===e||e.contains(t)))return {x,y};}return null;})()`);
}
export async function captureStatic(cdp,input,options,report,check){
 const nodes=staticNodes(options.root,options.staticScene,options.nodeIds);report.requestedNodes=nodes;
 if(!await waitFor(()=>cdp.eval(`(()=>{const e=window.__editor;return e.renderer.pendingAssetCount===0&&${JSON.stringify(nodes.map(n=>({id:n.id,name:n.name})))}.every(n=>{const i=e.renderer.state.objects.findIndex(o=>o.nodeId===n.id&&!o.removed);return i>=0&&document.querySelector('#hierarchy .hier-row[data-index="'+i+'"]:not(.hier-sub) .hier-name')?.textContent===n.name;});})()`),{timeout:30000,interval:200}))throw new Error('候选资产/Hierarchy 名称未同步，拒绝点击陈旧fallback列表');
 const snapshot=()=>cdp.eval(`(async()=>{const e=window.__editor,d=e.renderer.getDocument(),digest=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v)))),b=>b.toString(16).padStart(2,'0')).join('');return {sceneId:d.id,source:e.renderer.getSceneSource()?.url,state:e.playCtl.state,frame:e.renderer.state.frameCounter,documentSha256:await digest(d),nodesSha256:await digest(d.nodes)};})()`);
 const before=await snapshot(),expectedId=JSON.parse(fs.readFileSync(path.join(options.root,options.staticScene),'utf8')).id;
 report.staticBefore=before;check('静态场景身份/编辑态',before.sceneId===expectedId&&before.state==='stopped',before);if(!report.checks.at(-1).ok)throw new Error('静态场景身份或编辑态不符');
 const click=async selector=>{const point=await domPoint(cdp,selector);if(!point)throw new Error('静态控件未实际可见 '+selector);await input.pointer(point,true);await input.pointer(point,false);report.actions.push({click:selector,point,atMs:Date.now()});};
 await click('.insp-tab[data-tab="inspector"]');
 for(const group of ['hierarchy','selection'])if(await cdp.eval(`document.querySelector('#${group}')?.open===false`))await click('#'+group+'>summary');
 for(const node of nodes){
  const index=await cdp.eval(`window.__editor.renderer.state.objects.findIndex(o=>o.nodeId===${JSON.stringify(node.id)}&&!o.removed)`);if(index<0)throw new Error('实际渲染对象缺失 '+node.id);
  const selector=`#hierarchy .hier-row[data-index="${index}"]:not(.hier-sub) .hier-name`;
  let point;
  for(let attempt=0;attempt<12;attempt++){
   point=await domPoint(cdp,selector);if(point)break;
   const scroll=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const closed=e.closest('details:not([open])');if(closed)return {closed:'#hierarchy details.hier-cat:not([open])>summary'};let p=e.parentElement;while(p&&!(p.scrollHeight>p.clientHeight+1&&/auto|scroll/.test(getComputedStyle(p).overflowY)))p=p.parentElement;if(!p)return null;const r=p.getBoundingClientRect(),a=e.getBoundingClientRect(),x=r.x+r.width/2,y=Math.max(5,Math.min(innerHeight-5,r.y+r.height/2)),hit=document.elementFromPoint(x,y);return hit&&p.contains(hit)?{x,y,delta:Math.max(-1200,Math.min(1200,a.y+a.height/2-y))}:null;})()`);
   if(scroll?.closed){await click(scroll.closed);continue;}if(!scroll||Math.abs(scroll.delta)<1)throw new Error('Hierarchy 行遮挡/不可滚动 '+node.id);
   await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:scroll.x,y:scroll.y,deltaX:0,deltaY:scroll.delta});report.actions.push({input:'wheel',nodeId:node.id,...scroll,atMs:Date.now()});await sleep(180);
  }
  if(!point)throw new Error('Hierarchy 有界滚动未找到 '+node.id);await input.pointer(point,true);await input.pointer(point,false);await sleep(150);
  const cameraBefore=await cdp.eval('structuredClone(window.__editor.camera)');await input.tap('f');await sleep(450);
  // 检视栏可能保留用户滚动位置；真实wheel把已选对象行带入视口。
  for(let attempt=0;attempt<6&&!await domPoint(cdp,'#selection .row .val');attempt++){
   const scroll=await cdp.eval(`(()=>{const e=document.querySelector('#selection .row .val');let p=e?.parentElement;while(p&&!(p.scrollHeight>p.clientHeight+1&&/auto|scroll/.test(getComputedStyle(p).overflowY)))p=p.parentElement;if(!p)return null;const r=p.getBoundingClientRect(),a=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,delta:Math.max(-1200,Math.min(1200,a.y-r.y-30))};})()`);
   if(!scroll)break;await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:scroll.x,y:scroll.y,deltaX:0,deltaY:scroll.delta});report.actions.push({input:'inspector-wheel',...scroll,atMs:Date.now()});await sleep(150);
  }
  const identity=await cdp.eval(`(()=>{const e=window.__editor,i=e.renderer.getSelected(),o=e.renderer.state.objects[i],row=document.querySelector('#hierarchy .hier-row[data-index="'+i+'"]:not(.hier-sub)'),inspector=document.querySelector('#selection .row .val'),save=[...document.querySelectorAll('#selection button')].find(b=>b.textContent==='保存场景'),r=inspector?.getBoundingClientRect(),hit=r?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2):null;return {nodeId:o?.nodeId,name:o?.name,visible:o?.visible,selectedRow:row?.classList.contains('sel'),hierarchyName:row?.querySelector('.hier-name')?.textContent,inspectorName:inspector?.textContent,inspectorVisible:!!r&&r.width>0&&r.height>0&&(hit===inspector||inspector.contains(hit)),saveDisabled:save?.disabled,focus:document.activeElement?.tagName,frame:e.renderer.state.frameCounter,editorCamera:e.renderer.state.cam};})()`);
  const focus=await cdp.eval(`(()=>{const e=window.__editor,i=e.renderer.getSelected();return {camera:structuredClone(e.camera),bounds:e.renderer.getObjectBounds(i),selectedSub:e.renderer.getSelectedSub(),selectedSubRow:!!document.querySelector('#hierarchy .hier-row.hier-sub.sel[data-obj="'+i+'"]')};})()`);
  const hierarchyPoint=await domPoint(cdp,selector),inspectorPoint=await domPoint(cdp,'#selection .row .val'),sample=await snapshot();identity.inspectorVisible=!!inspectorPoint;identity.inspectorPoint=inspectorPoint;identity.focusEvidence={before:cameraBefore,...focus};
  const focused=focus.bounds&&focus.camera?.target?.every((n,i)=>Math.abs(n-focus.bounds.center[i])<1e-3)&&Number.isFinite(focus.camera.distance)&&focus.camera.distance>0;
  check('固定视图 '+node.id,identity.nodeId===node.id&&identity.name===node.name&&identity.visible&&(identity.selectedRow||focus.selectedSubRow)&&identity.hierarchyName===node.name&&identity.inspectorName===node.name&&identity.inspectorVisible&&identity.saveDisabled===true&&!!hierarchyPoint&&focused&&sample.nodesSha256===before.nodesSha256,{...identity,hierarchyPoint,author:sample});
  if(!report.checks.at(-1).ok)throw new Error('固定视图身份/Inspector/Save/作者节点不符 '+node.id);
  const {data}=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}),bytes=Buffer.from(data,'base64'),file=node.id+'.png';fs.writeFileSync(path.join(options.out,file),bytes);
  report.screenshots.push({file,nodeId:node.id,name:node.name,asset:node.asset,sha256:hash(bytes),width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),identity,frameBefore:sample.frame,frameAfter:(await snapshot()).frame,atMs:Date.now()});
 }
 report.staticAfter=await snapshot();check('静态作者节点/磁盘场景保持',before.nodesSha256===report.staticAfter.nodesSha256&&hash(fs.readFileSync(path.join(options.root,options.staticScene)))===report.sceneSha256,report.staticAfter);
}
