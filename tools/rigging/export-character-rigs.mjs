/** Export the saved NPC binding sessions through the actual MCP server, then
 * normalize whole rigs (mesh + local offsets + inverse binds) to roster height.
 * Existing joints/cylinders are never repositioned. Source GLBs remain untouched.
 * Run from the repository root: node tools/rigging/export-character-rigs.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'../..');
process.chdir(root);
const temp='.workbuddy/tmp/npc-rig-20261007';mkdirSync(temp,{recursive:true});
const json=p=>JSON.parse(readFileSync(p,'utf8'));
const writeJson=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
await build({entryPoints:['tools/mcp-binding/src/domain-entry.ts'],bundle:true,platform:'node',format:'esm',outfile:'tools/mcp-binding/dist/domain.mjs',tsconfig:'tsconfig.check.json'});
await build({entryPoints:['tools/motion/domain-entry.ts'],bundle:true,platform:'node',format:'esm',outfile:`${temp}/delivery-api.mjs`,tsconfig:'tsconfig.check.json'});
const {parseGlb,createSkinState,evalJointMatrices}=await import(pathToFileURL(resolve(temp,'delivery-api.mjs')));
const chars=json('assets/_data/asset-manifest.json').characters;
const roster=readFileSync('packages/content/src/generated/roster.generated.ts','utf8');
const heights=new Map(roster.split(/\n {2}\{\n/).slice(1).map(b=>[/\bid:\s*"([^"]+)"/.exec(b)?.[1],Number(/\bheightMeters:\s*([0-9.]+)/.exec(b)?.[1])]));
if(heights.size!==9||[...heights.values()].some(h=>!Number.isFinite(h)))throw Error('Invalid roster heights');
const child=spawn(process.execPath,['tools/mcp-binding/server.mjs'],{cwd:root,stdio:['pipe','pipe','inherit']});
let seq=1,buffer='';const pending=new Map();
child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
 buffer+=chunk;let end;
 while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let r;try{r=JSON.parse(line);}catch{continue;}
 const p=pending.get(r.id);if(!p)continue;pending.delete(r.id);clearTimeout(p.timer);if(r.error)p.reject(Error(JSON.stringify(r.error)));else p.resolve(r.result);}
});
child.on('exit',code=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('MCP exited '+code));}pending.clear();});
function rpc(method,params){return new Promise((resolve,reject)=>{const id=seq++;pending.set(id,{resolve,reject,timer:setTimeout(()=>reject(Error('MCP timed out: '+method)),180000)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
async function tool(name,args={}){const r=await rpc('tools/call',{name,arguments:args});if(r.isError)throw Error(JSON.stringify(r.content));const text=r.content?.find(c=>c.type==='text')?.text;if(!text)throw Error('Missing MCP result');return JSON.parse(text);}
/** Uniformly scale GLB space while preserving topology, UVs, weights and textures. */
function scaleRig(bytes,target){
 const model=parseGlb(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),null);
 let min=Infinity,max=-Infinity;for(let i=1;i<model.mesh.vertices.length;i+=15){min=Math.min(min,model.mesh.vertices[i]);max=Math.max(max,model.mesh.vertices[i]);}
 const scale=target/(max-min),jsonLength=bytes.readUInt32LE(12),doc=JSON.parse(bytes.subarray(20,20+jsonLength).toString()),bin=Buffer.from(bytes.subarray(28+jsonLength));
 if(doc.animations?.length)throw Error('Only rig-only exports may be uniformly normalized');
 if(Math.abs(scale-1)<1e-6)return Buffer.from(bytes);
 const scaled=new Set();
 function floats(ai,translationsOnly=false){if(scaled.has(ai))return;scaled.add(ai);const a=doc.accessors[ai],view=doc.bufferViews[a.bufferView];if(a.componentType!==5126||a.sparse)throw Error('Unsupported rig float accessor');
 const width=a.type==='MAT4'?16:3,step=view.byteStride??width*4,offset=(view.byteOffset??0)+(a.byteOffset??0);
 for(let i=0;i<a.count;i++)for(const k of translationsOnly?[12,13,14]:[0,1,2]){const o=offset+i*step+k*4;bin.writeFloatLE(bin.readFloatLE(o)*scale,o);}
 if(!translationsOnly)for(const key of ['min','max'])if(a[key])a[key]=a[key].map(v=>v*scale);
 }
 for(const m of doc.meshes)for(const p of m.primitives)floats(p.attributes.POSITION);
 for(const s of doc.skins)floats(s.inverseBindMatrices,true);
 for(const n of doc.nodes){if(n.translation)n.translation=n.translation.map(v=>v*scale);if(n.matrix)for(const k of [12,13,14])n.matrix[k]*=scale;}
 const data=Buffer.from(JSON.stringify(doc)),padded=Buffer.alloc(Math.ceil(data.length/4)*4,32);data.copy(padded);
 const out=Buffer.alloc(28+padded.length+bin.length);out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(padded.length,12);out.writeUInt32LE(0x4e4f534a,16);padded.copy(out,20);out.writeUInt32LE(bin.length,20+padded.length);out.writeUInt32LE(0x004e4942,24+padded.length);bin.copy(out,28+padded.length);return out;
}
function verify(bytes,height){
 const m=parseGlb(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),null),sk=m.skeleton;if(!sk||sk.joints.length!==27||!m.mesh.weights||!m.image)throw Error('Incomplete rig');
 const palette=new Float32Array(28*16);evalJointMatrices(createSkinState(sk,[]),palette);
 let error=0,min=Infinity,max=-Infinity;for(let j=0;j<27;j++)for(let k=0;k<16;k++)error=Math.max(error,Math.abs(palette[j*16+k]-(k%5===0?1:0)));
 for(let i=0;i<m.mesh.vertices.length/15;i++){let sum=0;for(let k=0;k<4;k++){const w=m.mesh.weights[i*4+k];if(!Number.isFinite(w)||w<0||m.mesh.joints[i*4+k]>=27)throw Error('Invalid weights');sum+=w;}if(Math.abs(sum-1)>1e-5)throw Error('Unnormalized skin');min=Math.min(min,m.mesh.vertices[i*15+1]);max=Math.max(max,m.mesh.vertices[i*15+1]);}
 if(error>1e-5||Math.abs(max-min-height)>1e-5)throw Error('Rig normalization broke bind matrices/height');return {bones:27,vertices:m.mesh.vertices.length/15,triangles:m.mesh.indices.length/3,height:max-min,restError:error};
}
const output=[];
try{
 await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'character-rig-delivery',version:'1.0'}});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 for(const c of chars.filter(c=>c.id!=='H-01')){
  const source='assets/'+c.lods.find(l=>l.file.includes('/textured/')).file,meta=json(source+'.meta.json');
  if(!meta.bindingEditor?.positions)throw Error(c.id+' has no saved joint session');
  if(meta.sourceHash!==hash(readFileSync(source)))throw Error(c.id+' source hash is stale');
  const original=JSON.stringify({positions:meta.bindingEditor.positions,cylinders:meta.bindingEditor.cylinders});
  await tool('load_model',{path:source});await tool('set_options',{weightMode:'volumetric',volumetric:{resolution:48,depth:1,tolerance:.001}});await tool('save');
  const saved=json(source+'.meta.json');if(original!==JSON.stringify({positions:saved.bindingEditor.positions,cylinders:saved.bindingEditor.cylinders}))throw Error('Saved author joints changed: '+c.id);
  const candidate=`${temp}/${c.id}-volume-source.glb`,exported=await tool('export_glb',{outPath:candidate,bindPose:'source',overwrite:true});
  if(!exported.stats.volumetric.converged||exported.stats.zeroWeightVerts)throw Error(c.id+' solver did not converge');
  const stem=source.split('/').at(-1).replace(/_baked\.glb$/,'_animation_ready.glb'),path=`assets/characters/models/${c.id}/rigged/${stem}`,bytes=scaleRig(readFileSync(candidate),heights.get(c.id)),stats=verify(bytes,heights.get(c.id));
  mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path,bytes);
  const guid='as_'+createHash('sha256').update(path).digest('hex').slice(0,16),ref={path,guid};
  writeJson(path+'.meta.json',{schemaVersion:1,guid,kind:'gltf',importer:{...meta.importer,normalizeHeightM:heights.get(c.id)},bindings:[],rig:null,animations:null,
   sourceHash:hash(bytes),updatedAt:new Date().toISOString(),sharedMotion:{library:{path:'assets/animations/mixamo/shared.motion.json',guid:'as_mixamo_shared_motion'},profile:'npc',defaultState:'idle',speed:1},
   userData:{characterId:c.id,characterName:c.name,variant:'rigged',file:stem,animationReady:true,sourceAsset:{path:source,guid:meta.guid},sourceHash:meta.sourceHash,bindingSession:source+'.meta.json',bindingRulerHeightM:2.05,exportedHeightM:heights.get(c.id),bindPose:'source',weightSmoothing:{algorithm:'adaptive-volume-diffusion-v2',iterations:saved.bindingEditor.smoothIters,lambda:saved.bindingEditor.smoothLambda},rigidSelections:saved.bindingEditor.rigidRegions?.map(r=>({name:r.name,bone:r.bone,vertices:r.vertices?.length??null}))??[],embeddedAnimationClips:0}});
  output.push({id:c.id,ref,source,stats,solver:exported.stats.volumetric});console.log(c.id+' exported: '+stats.vertices+' vertices / '+stats.bones+' bones / '+stats.height.toFixed(2)+'m');
 }
}finally{child.kill();}
// H-01 already has approved LOD0 weights; only unify stored space and roster height.
const hpath='assets/characters/models/H-01/rigged/H01_SCAVENGER_LOD0_animation_ready.glb',hmeta=json(hpath+'.meta.json'),hbytes=scaleRig(readFileSync(hpath),heights.get('H-01')),hstats=verify(hbytes,heights.get('H-01'));
writeFileSync(hpath,hbytes);hmeta.sourceHash=hash(hbytes);hmeta.updatedAt=new Date().toISOString();hmeta.userData.exportedHeightM=heights.get('H-01');writeJson(hpath+'.meta.json',hmeta);output.push({id:'H-01',ref:{path:hpath,guid:hmeta.guid},stats:hstats});
writeJson(temp+'/delivery.json',output);
