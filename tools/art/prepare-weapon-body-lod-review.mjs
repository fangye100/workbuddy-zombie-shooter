/** 五本体 raw/独立LOD同尺度三向；使用正式parser和稳定GUID，不批准候选。 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const root=fileURLToPath(new URL('../../',import.meta.url));
const check=process.argv.includes('--check'),scenePath='assets/scenes/sandbox/weapon-body-lod-review.scene.json';
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const write=(p,d)=>fs.writeFileSync(path.join(root,p),JSON.stringify(d,null,2)+'\n');
const sha=b=>createHash('sha256').update(b).digest('hex');
const bundle=path.join(root,'.workbuddy/tmp/wpn-integration/body-lod-review-scene.mjs');
await build({entryPoints:[path.join(root,'packages/scene/src/index.ts')],bundle:true,platform:'node',format:'esm',outfile:bundle,tsconfig:path.join(root,'tsconfig.check.json'),logLevel:'error'});
const api=await import(pathToFileURL(bundle).href);
const valid=(p,ds)=>{const errors=ds.filter(d=>d.severity==='error');if(errors.length)throw new Error(p+': '+JSON.stringify(errors));};
const mul=(a,b)=>{const [x,y,z,w]=a,[X,Y,Z,W]=b;return [w*X+x*W+y*Z-z*Y,w*Y-x*Z+y*W+z*X,w*Z+x*Y-y*X+z*W,w*W-x*X-y*Y-z*Z];};
const rotate=(v,q)=>{const c=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],u=q.slice(0,3),t=c(u,v).map(n=>2*n),d=c(u,t);return v.map((n,i)=>n+q[3]*t[i]+d[i]);};
const qy=deg=>[0,Math.sin(deg*Math.PI/360),0,Math.cos(deg*Math.PI/360)];
const views=[{label:'侧+X',q:qy(-90)},{label:'枪口+Z / 锯齿端候选',q:[0,0,0,1]},{label:'俯+Y',q:[Math.SQRT1_2,0,0,Math.SQRT1_2]}];
const doc=api.createEmptySceneDocument('WPN-20261012 · 原源 / LOD0 / LOD1 / LOD2 三向（候选）');
doc.id='sc_weapon_body_lod_review';doc.editorCamera={target:[0,4,0],distance:22,yaw:0,elevation:0};
doc.environment=structuredClone(read('assets/scenes/sandbox/weapon-body-source-review.scene.json').environment);
doc.nodes.find(n=>n.id===doc.entryCamera).components[0]={kind:'Camera',enabled:true,mode:'fixed',fovDeg:35,near:.001,far:100,followTarget:null,pitchDeg:0,distance:22,yawOffsetDeg:0,yawMode:'world'};
doc.meta.notes='五行×四组×三朝向=60mesh；每件raw+三档共用displayScale，不按LOD bounds重新缩放。原源仅scene旋转/尺度/中心补偿，未改GLB。选择准确Hierarchy名称后F；炮口、齿端、握区、表面仍需GPU检视。';
const items=read('assets/_delivery/WPN-20261012/delivery.json').items;
for(let i=0;i<items.length;i++){
 const id=items[i].id,prefix=`assets/art/models/${id}/`,report=read(prefix+'lod-report.json');
 if(sha(fs.readFileSync(path.join(root,report.source)))!==report.sourceHash||sha(fs.readFileSync(path.join(root,'tools/art/build-weapon-body-lods.py')))!==report.pipelineHash)throw new Error(id+': source/pipeline hash失配');
 for(const [p,h] of Object.entries(report.helperHashes))if(sha(fs.readFileSync(path.join(root,p)))!==h)throw new Error(p+': helper过期');
 const sourceMeta=read(report.source+'.meta.json'),sourceQ=qy(report.recipe.rotationDeg[1]),display=1.25/Math.max(...report.dimensionsM);
 const entries=[{file:report.source,guid:sourceMeta.guid,triangles:report.sourceTriangles,raw:true},...report.levels.map(l=>{
  if(l.errors.length||l.triangles>report.recipe.targets[l.level])throw new Error(id+': 数值门禁失败');
  const file=prefix+'game_ready/'+l.file,bytes=fs.readFileSync(path.join(root,file)),side=file+'.meta.json',hash=sha(bytes);
  if(hash!==l.hash)throw new Error(file+': hash失配');
  const exists=fs.existsSync(path.join(root,side));if(check&&!exists)throw new Error(side+': 缺少');
  const meta=exists?read(side):api.createDefaultAssetMeta('as_'+sha(Buffer.from(file)).slice(0,12),'gltf');
  if(exists&&meta.sourceHash!=='sha256:'+hash)throw new Error(side+': 已有hash变更需显式provenance更新');
  if(!exists){meta.sourceHash='sha256:'+hash;meta.userData={assetId:id,variant:'game_ready',file:path.basename(file),level:l.level,status:'visual-review-candidate',source:report.source,sourceHash:report.sourceHash,report:prefix+'lod-report.json',canonical:'Y-up / +Z forward',calibrationSpace:'parseGlb final import-space metre',canonicalToImportTranslation:l.parserRecenterMeters.map(n=>-n)};}
  const missingFile=!meta.userData?.file;if(missingFile){if(check)throw new Error(side+': 缺少文件标签');meta.userData={...meta.userData,file:path.basename(file)};}
  valid(side,api.validateAssetMeta(meta));if(meta.importer.normalizeHeightM!==null||meta.importer.upAxisFlip)throw new Error(side+': 隐式翻轴/缩放');
  const model=api.parseGlb(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),null,'y');if(model.triangles!==l.triangles||l.textureSize.some(n=>n>1024))throw new Error(file+': tris/texture门禁失败');
  for(let p=0;p<model.mesh.vertices.length;p+=api.VERTEX_FLOATS)for(let a=0;a<11;a++)if(!Number.isFinite(model.mesh.vertices[p+a]))throw new Error(file+': 非有限属性');
  if(!check&&(!exists||missingFile))write(side,meta);
  return {file,guid:meta.guid,triangles:l.triangles,raw:false,center:l.parserRecenterMeters};
 })];
 for(let l=0;l<entries.length;l++)for(let k=0;k<views.length;k++){
  const entry=entries[l],view=views[k],q=entry.raw?mul(view.q,sourceQ):view.q;
  const center=entry.raw?rotate(report.rawNodeBakedCenterSource,sourceQ).map((n,a)=>(n-report.originRotatedSource[a])*report.scaleXYZ[0]):entry.center;
  const offset=rotate(center,view.q),grid=[(l*3+k-5.5)*1.65,(4-i)*1.8,0];
  doc.nodes.push({id:`nd_body_lod_${i}_${l}_${k}`,name:`${id} · ${l===0?'Raw规范化参考':'LOD'+(l-1)} · ${view.label} · ${entry.triangles} tris`,parent:null,prefab:null,visible:true,pickable:true,category:'本体LOD候选',transform:{position:grid.map((n,a)=>n+offset[a]*display),rotation:q,scale:Array(3).fill(display*(entry.raw?report.scaleXYZ[0]:1))},components:[{kind:'MeshRenderer',enabled:true,source:{type:'asset',ref:{path:entry.file,guid:entry.guid}},materials:[{match:{by:'index',value:0},material:{type:'override',base:{type:'shared',id:'s1'},patch:{albedo:'#ffffff',roughness:.8,metallic:0,specMix:0,outlineScale:.1,halftoneScale:0}}}],visible:true,layer:4,importScale:1}]});
  doc.dependencies.push(entry.file);
 }
}
doc.dependencies=[...new Set(doc.dependencies)];valid(scenePath,api.validateSceneDocument(doc));
const project=read('aether.project.json');
if(check){const saved=read(scenePath);valid(scenePath,api.validateSceneDocument(saved));if(JSON.stringify(saved.nodes)!==JSON.stringify(doc.nodes)||JSON.stringify(saved.dependencies)!==JSON.stringify(doc.dependencies))throw new Error('固定检视scene漂移');if(!project.scenes.some(s=>s.id===doc.id&&s.path===scenePath&&s.enabled))throw new Error('未登记');}
else{if(fs.existsSync(path.join(root,scenePath))){const old=read(scenePath);doc.meta.createdAt=old.meta.createdAt;}write(scenePath,doc);if(!project.scenes.some(s=>s.id===doc.id))project.scenes.push({id:doc.id,path:scenePath,name:doc.name,enabled:true});write('aether.project.json',project);}
valid('project',api.validateProject(project));console.log(JSON.stringify({scenePath,meshes:60,status:'visual-review-candidate'},null,2));
