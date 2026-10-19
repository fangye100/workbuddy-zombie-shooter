/** 五件新本体的原源检视；复用正式 parser/sidecar/scene，不减面或命名猜测部件。 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const root=fileURLToPath(new URL('../../',import.meta.url));
const batch='assets/_delivery/WPN-20261012';
const scenePath='assets/scenes/sandbox/weapon-body-source-review.scene.json';
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const write=(p,data)=>{const target=path.join(root,p);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(data,null,2)+'\n');};
const valid=(label,diagnostics)=>{const errors=diagnostics.filter(d=>d.severity==='error');if(errors.length)throw new Error(label+': '+JSON.stringify(errors));};

/** 网格接缝按位置网格焊接，仅统计，不删面；连通块不代表命名部件。 */
export function geometryFacts(vertices,indices,stride,tolerance=1e-6){
 const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity],keys=new Map(),positions=[],map=[];
 for(let i=0;i<vertices.length;i+=stride){
  const p=Array.from(vertices.slice(i,i+3));if(p.some(n=>!Number.isFinite(n)))throw new Error('源位置非有限');
  p.forEach((n,k)=>{low[k]=Math.min(low[k],n);high[k]=Math.max(high[k],n);});
  const key=p.map(n=>Math.round(n/tolerance)).join(',');let id=keys.get(key);
  if(id===undefined){id=positions.length;keys.set(key,id);positions.push(p);}map.push(id);
 }
 const parent=positions.map((_,i)=>i),find=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
 const join=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[b]=a;};
 const faces=[],edges=new Map();let degenerate=0;
 for(let i=0;i<indices.length;i+=3){
  const ids=Array.from(indices.slice(i,i+3),n=>map[n]);if(ids.some(n=>n===undefined))throw new Error('源索引越界');
  if(new Set(ids).size!==3){degenerate++;continue;}faces.push(ids);join(ids[0],ids[1]);join(ids[1],ids[2]);
  for(let k=0;k<3;k++){const a=ids[k],b=ids[(k+1)%3],key=a<b?a+','+b:b+','+a;edges.set(key,(edges.get(key)??0)+1);}
 }
 const groups=new Map();for(const ids of faces){const id=find(ids[0]);let g=groups.get(id);if(!g){g={triangles:0,low:[Infinity,Infinity,Infinity],high:[-Infinity,-Infinity,-Infinity]};groups.set(id,g);}g.triangles++;for(const v of ids)positions[v].forEach((n,k)=>{g.low[k]=Math.min(g.low[k],n);g.high[k]=Math.max(g.high[k],n);});}
 return {bounds:{low,high,dimensions:high.map((n,k)=>n-low[k])},topology:{method:'position-grid-weld-statistics-only',toleranceSourceUnits:tolerance,weldedVertices:positions.length,components:groups.size,boundaryEdges:[...edges.values()].filter(n=>n===1).length,nonManifoldEdges:[...edges.values()].filter(n=>n>2).length,degenerateAfterWeld:degenerate,largestComponents:[...groups.values()].sort((a,b)=>b.triangles-a.triangles).slice(0,8),semanticParts:'pending-visual-region-review; components are not named parts'}};
}
export function sourceViews(longAxis){
 const s=Math.SQRT1_2;
 return longAxis===2?
  [{label:'侧+X',rotation:[0,-s,0,s]},{label:'长轴端+Z（符号待定）',rotation:[0,0,0,1]},{label:'俯+Y',rotation:[s,0,0,s]},{label:'长轴端-Z（符号待定）',rotation:[0,1,0,0]}]:
  [{label:'侧+Z',rotation:[0,0,0,1]},{label:'长轴端+X（符号待定）',rotation:[0,-s,0,s]},{label:'俯+Y',rotation:[s,0,0,s]},{label:'长轴端-X（符号待定）',rotation:[0,s,0,s]}];
}
async function prepare(){
 const check=process.argv.includes('--check'),scratch=path.join(root,'.workbuddy/tmp/wpn-integration'),bundle=path.join(scratch,'body-review-scene.mjs');fs.mkdirSync(scratch,{recursive:true});
 await build({entryPoints:[path.join(root,'packages/scene/src/index.ts')],bundle:true,platform:'node',format:'esm',outfile:bundle,tsconfig:path.join(root,'tsconfig.check.json'),logLevel:'error'});
 const api=await import(pathToFileURL(bundle).href),delivery=read(batch+'/delivery.json'),items=[];
 for(const item of delivery.items){
  const source=`${batch}/${item.id}/${item.id}.glb`,bytes=fs.readFileSync(path.join(root,source));
  if(bytes.toString('ascii',0,4)!=='glTF'||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length||bytes.length!==item.glbBytes)throw new Error(source+': GLB/header/delivery长度失配');
  const jsonLength=bytes.readUInt32LE(12),json=JSON.parse(bytes.subarray(20,20+jsonLength).toString()),primitives=json.meshes.flatMap(m=>m.primitives);
  if(primitives.length!==1||json.skins?.length||json.animations?.length)throw new Error(source+': 本批期望单primitive静态源');
  const model=api.parseGlb(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),null,'y');
  const facts=geometryFacts(model.mesh.vertices,model.mesh.indices,api.VERTEX_FLOATS),hash=sha(bytes),metaPath=source+'.meta.json',exists=fs.existsSync(path.join(root,metaPath));
  if(check&&!exists)throw new Error(metaPath+': 缺失');
  const meta=exists?read(metaPath):api.createDefaultAssetMeta('as_'+sha(Buffer.from(source)).slice(0,12),'gltf');
  if(exists&&meta.sourceHash!=='sha256:'+hash)throw new Error(metaPath+': 源hash失配，拒绝静默覆盖');
  if(!exists){meta.sourceHash='sha256:'+hash;meta.userData={assetId:item.id,variant:'raw-source-review',status:'source-review-pending',sourceDelivery:batch+'/delivery.json',sourceUnits:'未标定生成单位；displayScale不是米制',axisContract:'保留节点变换后的Y-up；长轴符号/握区/分件待目检',inspectionScene:scenePath,sourceTriangles:model.triangles};}
  valid(metaPath,api.validateAssetMeta(meta));if(meta.importer.normalizeHeightM!==null||meta.importer.upAxisFlip)throw new Error(metaPath+': 原源检视禁止归一化/翻轴');
  const primitive=primitives[0],texture=json.materials[primitive.material??0].pbrMetallicRoughness.baseColorTexture.index,image=json.images[json.textures[texture].source],view=json.bufferViews[image.bufferView],binStart=28+jsonLength,png=bytes.subarray(binStart+(view.byteOffset??0),binStart+(view.byteOffset??0)+view.byteLength);
  if(image.mimeType!=='image/png'||png.toString('ascii',1,4)!=='PNG')throw new Error(source+': 期望内嵌PNG BaseColor');
  const longAxis=facts.bounds.dimensions.indexOf(Math.max(...facts.bounds.dimensions)),views=sourceViews(longAxis);
  const report={id:item.id,source,guid:meta.guid,sourceHash:'sha256:'+hash,bytes:bytes.length,triangles:model.triangles,renderVertices:model.vertices,meshes:json.meshes.length,primitives:primitives.length,skins:json.skins?.length??0,nodeTransforms:json.nodes.map(n=>({name:n.name,rotation:n.rotation??[0,0,0,1],translation:n.translation??[0,0,0],scale:n.scale??[1,1,1]})),baseColorSize:[png.readUInt32BE(16),png.readUInt32BE(20)],coordinateSpace:'parseGlb(buffer,null,y) final import-space; node transform + automatic XZ centre/Y bottom, source units',...facts,longAxis:['X','Y','Z'][longAxis],muzzleSign:'pending-headed-end-view',gripAndParts:'pending-headed-region-review; no parts extracted',targetDimsM:item.targetDimsM,lodTarget:item.lodTarget,displayScale:1.6/Math.max(...facts.bounds.dimensions),views};
  const reportPath=`assets/art/models/${item.id}/source-report.json`;
  if(check){if(JSON.stringify(read(reportPath))!==JSON.stringify(report))throw new Error(reportPath+': 源事实过期');}
  else{if(!exists)write(metaPath,meta);write(reportPath,report);}items.push({...report,reportPath});
 }
 const project=read('aether.project.json');
 if(check){
  const doc=read(scenePath);valid(scenePath,api.validateSceneDocument(doc));valid('aether.project.json',api.validateProject(project));
  if(!project.scenes.some(s=>s.id===doc.id&&s.path===scenePath&&s.enabled))throw new Error('场景未登记');
  const meshes=doc.nodes.flatMap(n=>n.components.filter(c=>c.kind==='MeshRenderer'));if(meshes.length!==items.length*4)throw new Error('固定视图数量失配');
  for(const item of items)for(let j=0;j<item.views.length;j++){const n=doc.nodes.find(n=>n.id===`nd_wpn_body_${items.indexOf(item)}_${j}`),m=n?.components.find(c=>c.kind==='MeshRenderer');if(!n||m.source.type!=='asset'||m.source.ref.path!==item.source||m.source.ref.guid!==item.guid||JSON.stringify(n.transform.rotation)!==JSON.stringify(item.views[j].rotation)||n.transform.scale.some(s=>s!==item.displayScale)||!doc.dependencies.includes(item.source))throw new Error(item.id+': 固定引用/旋转/尺度失配');}
 }else{
  if(fs.existsSync(path.join(root,scenePath)))throw new Error('已有检视scene，拒绝覆盖；复验请 --check');
  const doc=api.createEmptySceneDocument('WPN-20261012 · 五件本体原源固定方向（未验收）');doc.id='sc_weapon_body_source_review';doc.editorCamera={target:[0,6.8,0],distance:17,yaw:0,elevation:0};doc.environment=structuredClone(read('assets/scenes/sandbox/weapon-source-fixed-views.scene.json').environment);
  doc.nodes.find(n=>n.id===doc.entryCamera).components[0]={kind:'Camera',enabled:true,mode:'fixed',fovDeg:35,near:.01,far:100,followTarget:null,pitchDeg:0,distance:17,yawOffsetDeg:0,yawMode:'world'};
  items.forEach((item,i)=>item.views.forEach((view,j)=>doc.nodes.push({id:`nd_wpn_body_${i}_${j}`,name:`${item.id} · 原源 · ${view.label}`,parent:null,prefab:null,visible:true,pickable:true,category:'武器本体源检视',transform:{position:[(j-1.5)*2.1,1.6+(4-i)*2.4,0],rotation:view.rotation,scale:Array(3).fill(item.displayScale)},components:[{kind:'MeshRenderer',enabled:true,source:{type:'asset',ref:{path:item.source,guid:item.guid}},materials:[{match:{by:'index',value:0},material:{type:'override',base:{type:'shared',id:'s1'},patch:{albedo:'#ffffff',roughness:.8,metallic:0,specMix:0,outlineScale:.1,halftoneScale:0}}}],visible:true,layer:4,importScale:1}]})));
  doc.dependencies=items.map(i=>i.source);doc.meta.notes='每行一件、三正交方向+负长轴端面；节点旋转将标注源面朝向编辑相机+Z。源GLB不改，展示缩放非米制，不认证炮口正号/握点/分件/PBR。选择准确Hierarchy名称后单独按F，无需gizmo猜视角。';
  valid(scenePath,api.validateSceneDocument(doc));project.scenes.push({id:doc.id,path:scenePath,name:doc.name,enabled:true});valid('aether.project.json',api.validateProject(project));write(scenePath,doc);write('aether.project.json',project);
 }
 console.log(JSON.stringify({mode:check?'check':'prepare',scenePath,items:items.map(i=>({id:i.id,guid:i.guid,sourceHash:i.sourceHash,triangles:i.triangles,baseColorSize:i.baseColorSize,longAxis:i.longAxis,components:i.topology.components,largestComponents:i.topology.largestComponents.map(g=>g.triangles),reportPath:i.reportPath}))},null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))prepare().catch(error=>{console.error(error);process.exitCode=1;});
