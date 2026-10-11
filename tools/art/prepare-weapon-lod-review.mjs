/** 预算内候选检视入口；不写 rawsource，不自动授予玩法/美术验收状态。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const root=fileURLToPath(new URL('../../',import.meta.url));
const scratch=path.join(root,'.workbuddy/tmp/wpn-integration');
const bundle=path.join(scratch,'lod-review-scene.mjs');
await build({entryPoints:[path.join(root,'packages/scene/src/index.ts')],bundle:true,platform:'node',format:'esm',outfile:bundle,tsconfig:path.join(root,'tsconfig.check.json')});
const {createEmptySceneDocument,createDefaultAssetMeta,validateAssetMeta,validateSceneDocument,validateProject,parseGlb,VERTEX_FLOATS}=await import(pathToFileURL(bundle).href);
const check=process.argv.includes('--check');
const refresh=process.argv.includes('--refresh-candidates');
if(check&&refresh)throw new Error('--check 禁止刷新 sidecar');
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const write=(p,data)=>{
 if(data.meta&&fs.existsSync(path.join(root,p))){const previous=read(p);data.meta.createdAt=previous.meta.createdAt;data.meta.updatedAt=previous.meta.updatedAt;}
 fs.writeFileSync(path.join(root,p),JSON.stringify(data,null,2)+'\n');
};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const ids=['WPN-07-LAUNCHER','WPN-MAG-01','WPN-MAG-02-SMG','WPN-SHELL-01','WPN-FUEL-01'];
const scenePath='assets/scenes/sandbox/weapon-lod-review.scene.json';
function valid(label,diagnostics){const errors=diagnostics.filter(d=>d.severity==='error');if(errors.length)throw new Error(`${label}: ${JSON.stringify(errors)}`);}
function mul(a,b){const [x,y,z,w]=a,[X,Y,Z,W]=b;return [w*X+x*W+y*Z-z*Y,w*Y-x*Z+y*W+z*X,w*Z+x*Y-y*X+z*W,w*W-x*X-y*Y-z*Z];}
function quaternion(degrees){let q=[0,0,0,1];degrees.forEach((angle,axis)=>{const half=angle*Math.PI/360,r=[0,0,0,Math.cos(half)];r[axis]=Math.sin(half);q=mul(r,q);});return q;}
function rotate(v,q){const u=[q[0],q[1],q[2]],cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];const t=cross(u,v).map(n=>2*n),c=cross(u,t);return v.map((n,i)=>n+q[3]*t[i]+c[i]);}
function metaFor(file,data){
 const bytes=fs.readFileSync(path.join(root,file)),hash=sha(bytes),side=file+'.meta.json';
 const existing=fs.existsSync(path.join(root,side));
 if(check&&!existing)throw new Error(`缺少 ${side}`);
 const meta=existing?read(side):createDefaultAssetMeta('as_'+sha(Buffer.from(file)).slice(0,12),'gltf');
 const changed=existing&&meta.sourceHash!=='sha256:'+hash;
 if(changed&&(!refresh||meta.userData?.status!=='visual-review-candidate'||meta.sourceHash!=='sha256:'+data.previousGlbHash))throw new Error(`过期 ${side}，拒绝未经 provenance 核对的覆盖`);
 if(!existing){meta.sourceHash='sha256:'+hash;meta.userData={...data,variant:'game_ready',file:path.basename(file),status:'visual-review-candidate'};}
 if(changed){meta.sourceHash='sha256:'+hash;meta.userData={...meta.userData,...data};}
 valid(side,validateAssetMeta(meta));
 if(meta.importer.normalizeHeightM!==null||meta.importer.upAxisFlip)throw new Error('候选必须显式米制 Y-up');
 if(!check&&(!existing||changed))write(side,meta);
 const model=parseGlb(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),null,'y');
 if(model.triangles!==data.triangles)throw new Error(`${file} tris 失配`);
 const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString()),primitive=gltf.meshes[0].primitives[0];
 const counts=['POSITION','NORMAL','TEXCOORD_0'].map(k=>gltf.accessors[primitive.attributes[k]]?.count);
 if(counts.some(n=>n!==counts[0])||!counts[0])throw new Error(`${file}: 位置/法线/UV accessor数量失配`);
 const img=gltf.images[0],bv=gltf.bufferViews[img.bufferView],binAt=28+bytes.readUInt32LE(12),png=bytes.subarray(binAt+(bv.byteOffset??0));
 if(img.mimeType!=='image/png'||png.readUInt32BE(16)>1024||png.readUInt32BE(20)>1024)throw new Error(`${file}: BaseColor超过1024`);
 // 静态 GltfResult 不暴露 normalization；实际自动居中偏移由 Python report 的米制 bounds 记录。
 for(let i=0;i<model.mesh.vertices.length;i+=VERTEX_FLOATS)for(let k=0;k<11;k++)if(!Number.isFinite(model.mesh.vertices[i+k]))throw new Error(`${file}: 非有限位置/法线/UV`);
 return {file,guid:meta.guid,triangles:model.triangles};
}
const reports=ids.map(id=>read(`assets/art/models/${id}/lod-report.json`));
for(const report of reports){
 if(report.pipelineHash!==sha(fs.readFileSync(path.join(root,'tools/art/build-weapon-lods.py'))))throw new Error(`${report.id}: pipeline hash过期`);
 for(const [helper,hash] of Object.entries(report.helperHashes))if(hash!==sha(fs.readFileSync(path.join(root,helper))))throw new Error(`${report.id}: helper hash过期`);
}
const doc=createEmptySceneDocument('WPN-20261011 · Reference / LOD 三向对照（候选未验收）');
doc.id='sc_weapon_lod_review';doc.editorCamera={target:[0,4,0],distance:22,yaw:0,elevation:0};
doc.environment=structuredClone(read('assets/scenes/sandbox/weapon-source-review.scene.json').environment);
doc.nodes.find(n=>n.id===doc.entryCamera).components[0]={kind:'Camera',enabled:true,mode:'fixed',fovDeg:35,near:.001,far:100,followTarget:null,pitchDeg:0,distance:22,yawOffsetDeg:0,yawMode:'world'};
doc.meta.notes='每行一件，每组 Reference/LOD0/LOD1/LOD2；每组三槽侧+Z/端+X/俯+Y（Shell底火-Y）。相同展示比例，不按LOD extents再缩放。候选不等于玩法或美术通过。无额外地面网格。';
const files=[];
reports.forEach((report,i)=>{
 const prefix=`assets/art/models/${report.id}/game_ready/`;
 if(report.sourceHash!==sha(fs.readFileSync(path.join(root,report.source))))throw new Error(`${report.id} raw hash失配`);
 const lods=report.levels.map(level=>{
  if(level.errors.length||level.triangles>report.recipe.targets[level.level])throw new Error(`${report.id} 硬门禁失败`);
  if(level.hash!==sha(fs.readFileSync(path.join(root,prefix+level.file))))throw new Error(`${report.id} LOD hash失配`);
  return {...metaFor(prefix+level.file,{assetId:report.id,triangles:level.triangles,level:level.level,algorithm:level.algorithm+(level.surfaceTransfer?'+source-surface-atlas':''),
   ...(level.surfaceTransfer?{previousGlbHash:level.surfaceTransfer.previousGlbHash,surfaceTransfer:level.surfaceTransfer.method,textureFile:level.surfaceTransfer.textureFile}:{}),
   source:report.source,sourceHash:report.sourceHash,report:`assets/art/models/${report.id}/lod-report.json`,
   calibrationSpace:'parseGlb(buffer,null,y) final import-space',canonicalToImportTranslation:level.parserRecenterMeters.map(n=>-n),
   socketsStatus:'未标定；场景 override 优先于未来 sidecar 默认；当前无对应角色真实握点认证'}),center:level.parserRecenterMeters,raw:false};
 });
 let reference;
 if(report.repairedReference){
  const ref=report.repairedReference;
  reference={...metaFor(prefix+ref.file,{assetId:report.id,triangles:ref.triangles,algorithm:'local-source-repair',source:report.source,sourceHash:report.sourceHash,
   calibrationSpace:'parseGlb final import-space',status:'visual-review-candidate'}),center:ref.parserRecenterMeters,raw:false};
 }else{
  const meta=read(report.source+'.meta.json');
  reference={file:report.source,guid:meta.guid,triangles:report.sourceTriangles,raw:true};
 }
 const display=1.25/Math.max(...report.dimensionsM),sourceQ=quaternion(report.recipe.rotationDeg);
 const views=[{label:'侧 +Z',q:[0,0,0,1]},{label:'端 +X',q:quaternion([0,-90,0])},
  {label:report.id==='WPN-SHELL-01'?'底火 -Y':'俯 +Y / 插入端',q:quaternion([report.id==='WPN-SHELL-01'?-90:90,0,0])}];
 [reference,...lods].forEach((item,l)=>views.forEach((view,k)=>{
  const q=item.raw?mul(view.q,sourceQ):view.q;
  let offset;
  if(item.raw){const rc=rotate(report.rawNodeBakedCenterSource,sourceQ);offset=rotate(rc.map((n,a)=>(n-report.originRotatedSource[a])*report.scaleXYZ[0]),view.q);}
  else offset=rotate(item.center,view.q);
  const grid=[(l*3+k-5.5)*1.65,(4-i)*1.8,0];
  doc.nodes.push({id:`nd_wpn_lod_${i}_${l}_${k}`,name:`${report.id} · ${l===0?(item.raw?'Raw规范化参考':'局部修复参考'):'LOD'+(l-1)} · ${view.label} · ${item.triangles} tris`,
   parent:null,prefab:null,visible:true,pickable:true,category:'武器LOD候选检视',
   transform:{position:grid.map((n,a)=>n+offset[a]*display),rotation:q,scale:Array(3).fill(display*(item.raw?report.scaleXYZ[0]:1))},
   components:[{kind:'MeshRenderer',enabled:true,source:{type:'asset',ref:{path:item.file,guid:item.guid}},
    materials:[{match:{by:'index',value:0},material:{type:'override',base:{type:'shared',id:'s1'},patch:{albedo:'#ffffff',roughness:.8,metallic:0,specMix:0,outlineScale:.1,halftoneScale:0}}}],visible:true,layer:4,importScale:1}]});
  files.push(item.file);
 }));
});
doc.dependencies=[...new Set(files)];valid(scenePath,validateSceneDocument(doc));
if(doc.nodes.filter(n=>n.components.some(c=>c.kind==='MeshRenderer')).length!==60)throw new Error('需恰好60mesh');
const rawPath='assets/scenes/sandbox/weapon-source-fixed-views.scene.json';
const rawDoc=structuredClone(doc);rawDoc.id='sc_weapon_source_fixed_views';rawDoc.name='WPN-20261011 · 原源固定三向（缺陷对照）';
rawDoc.editorCamera={target:[0,4,0],distance:12,yaw:0,elevation:0};
rawDoc.nodes=rawDoc.nodes.filter(n=>!n.components.some(c=>c.kind==='MeshRenderer'));
rawDoc.meta.notes='原 GLB 节点变换后按同配方规范化展示；固定侧+Z/端+X/俯+Y，Shell第三槽为底火-Y。仅scene显示变换，不写rawsource。与LOD scene相同材质/展示比例；仍非源美术验收。';
reports.forEach((report,i)=>{
 const qSource=quaternion(report.recipe.rotationDeg),display=1.25/Math.max(...report.dimensionsM),meta=read(report.source+'.meta.json');
 const center=rotate(report.rawNodeBakedCenterSource,qSource);
 const views=[[0,0,0],[0,-90,0],[report.id==='WPN-SHELL-01'?-90:90,0,0]];
 views.forEach((angles,k)=>{
  const view=quaternion(angles),offset=rotate(center.map((n,a)=>(n-report.originRotatedSource[a])*report.scaleXYZ[0]),view);
  const template=doc.nodes.find(n=>n.id===`nd_wpn_lod_${i}_0_${k}`),node=structuredClone(template);
  node.id=`nd_wpn_raw_fixed_${i}_${k}`;node.name=`${report.id} · Raw · ${k===0?'侧+Z':k===1?'端+X':report.id==='WPN-SHELL-01'?'底火-Y':'俯+Y'} · ${report.sourceTriangles} tris`;
  node.transform={position:[(k-1)*1.65,(4-i)*1.8,0].map((n,a)=>n+offset[a]*display),rotation:mul(view,qSource),scale:Array(3).fill(display*report.scaleXYZ[0])};
  node.components[0].source={type:'asset',ref:{path:report.source,guid:meta.guid}};rawDoc.nodes.push(node);
 });
});
rawDoc.dependencies=reports.map(r=>r.source);valid(rawPath,validateSceneDocument(rawDoc));
const focusedPath='assets/scenes/sandbox/weapon-surface-transfer-review.scene.json';
let focusedDoc=null;
if(reports.every(r=>r.levels[0].surfaceTransfer)){
 focusedDoc=structuredClone(rawDoc);focusedDoc.id='sc_weapon_surface_transfer_review';focusedDoc.name='Mag01 / Shell · 源 / 转移前 / 转移后';
 focusedDoc.editorCamera={target:[0,1,0],distance:18,yaw:0,elevation:0};
 focusedDoc.nodes=focusedDoc.nodes.filter(n=>!n.components.some(c=>c.kind==='MeshRenderer'));
 focusedDoc.meta.notes='18 mesh 两行：Mag01 / Shell，每行 Raw / ddfb08f旧LOD0 / 源表面atlas新LOD0，三朝向；每组三槽侧+Z/端+X/插入+Y或底火-Y。同几何同尺度材质；重投影不认证真实源端面已修复。';
 [1,3].forEach((i,row)=>{
  const report=reports[i],level=report.levels[0],baseline=`assets/art/models/${report.id}/game_ready/${report.id}_pre_surface_transfer_lod0.glb`;
  if(sha(fs.readFileSync(path.join(root,baseline)))!==(level.surfaceTransfer.comparisonBaselineGlbHash??level.surfaceTransfer.previousGlbHash))throw new Error('转移前基线 hash 失配');
  const old=metaFor(baseline,{assetId:report.id,triangles:level.triangles,algorithm:level.algorithm,baselineHead:'ddfb08f0fea9a8e8ce574a78eb03bc496915db2e',
   calibrationSpace:'parseGlb final import-space',purpose:'源表面转移前对照，不挂正式玩法'});
  for(let group=0;group<3;group++)for(let view=0;view<3;view++){
   const template=group===0?rawDoc.nodes.find(n=>n.id===`nd_wpn_raw_fixed_${i}_${view}`):doc.nodes.find(n=>n.id===`nd_wpn_lod_${i}_1_${view}`);
   const node=structuredClone(template);node.id=`nd_wpn_surface_${row}_${group}_${view}`;
   node.name=`${report.id} · ${['Raw规范化','ddfb转移前LOD0','源表面转移后LOD0'][group]} · ${['侧+Z','端+X',row===0?'插入+Y':'底火-Y'][view]}`;
   const oldGrid=group===0?(view-1)*1.65:(3+view-5.5)*1.65;
   node.transform.position[0]+=(group*3+view-4)*1.65-oldGrid;node.transform.position[1]+=(1-row)*2.2-(4-i)*1.8;
   if(group===1)node.components[0].source={type:'asset',ref:{path:baseline,guid:old.guid}};
   focusedDoc.nodes.push(node);
  }
 });
 focusedDoc.dependencies=[...new Set(focusedDoc.nodes.flatMap(n=>n.components.filter(c=>c.kind==='MeshRenderer').map(c=>c.source.ref.path)))];
 valid(focusedPath,validateSceneDocument(focusedDoc));
}
if(check){
 const saved=read(scenePath);valid(scenePath,validateSceneDocument(saved));
 if(JSON.stringify(saved.nodes)!==JSON.stringify(doc.nodes)||JSON.stringify(saved.dependencies)!==JSON.stringify(doc.dependencies))throw new Error('场景fixture漂移');
 const project=read('aether.project.json');valid('project',validateProject(project));if(!project.scenes.some(s=>s.id===doc.id&&s.path===scenePath&&s.enabled))throw new Error('未登记场景');
 const rawSaved=read(rawPath);valid(rawPath,validateSceneDocument(rawSaved));if(JSON.stringify(rawSaved.nodes)!==JSON.stringify(rawDoc.nodes))throw new Error('原源三向fixture漂移');
 if(!project.scenes.some(s=>s.id===rawDoc.id&&s.path===rawPath&&s.enabled))throw new Error('未登记原源三向场景');
 if(focusedDoc){const saved=read(focusedPath);valid(focusedPath,validateSceneDocument(saved));if(JSON.stringify(saved.nodes)!==JSON.stringify(focusedDoc.nodes))throw new Error('转移前后fixture漂移');if(!project.scenes.some(s=>s.id===focusedDoc.id&&s.path===focusedPath&&s.enabled))throw new Error('未登记转移前后场景');}
}else{
 write(scenePath,doc);write(rawPath,rawDoc);const project=read('aether.project.json');
 if(!project.scenes.some(s=>s.id===doc.id))project.scenes.push({id:doc.id,path:scenePath,name:doc.name,enabled:true});
 if(!project.scenes.some(s=>s.id===rawDoc.id))project.scenes.push({id:rawDoc.id,path:rawPath,name:rawDoc.name,enabled:true});
 if(focusedDoc){write(focusedPath,focusedDoc);if(!project.scenes.some(s=>s.id===focusedDoc.id))project.scenes.push({id:focusedDoc.id,path:focusedPath,name:focusedDoc.name,enabled:true});}
 valid('project',validateProject(project));write('aether.project.json',project);
}
console.log(JSON.stringify({scenePath,meshes:60,status:'visual-review-candidate',reports:reports.map(r=>({id:r.id,levels:r.levels.map(l=>({tris:l.triangles,algorithm:l.algorithm,diagnostics:l.diagnostics,silhouetteIoU:l.silhouetteIoU}))}))},null,2));
