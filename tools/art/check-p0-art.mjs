/** Content gate: runtime bytes, source provenance, sidecar identity and atlas UV bounds. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url));
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const hash=p=>createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex');
const failures=[];
const check=(ok,message)=>{if(!ok)failures.push(message);};
for(const e of read('assets/art/p0-intake.json').models){
 const report=e.status==='delivered'?read(`assets/art/models/${e.id}/lod-report.json`):null;
 if(report){check(JSON.stringify(report.recipe)===JSON.stringify(e),`${e.id}: stale recipe`);check(report.sourceHash===hash(`assets/art/sources/${e.id}/${e.id}_source.glb`),`${e.id}: stale source`);
  if(e.simplification?.profile==='architecture-v2')check(report.structureMethodHash===hash('tools/art/architecture-quality.py'),`${e.id}: stale structural checks`);
 }
 for(let lod=0;lod<3;lod++){
  const file=`assets/art/models/${e.id}/game_ready/${e.id}_lod${lod}.glb`,meta=read(file+'.meta.json'),actual=hash(file);
  check(meta.userData.assetId===e.id,`${file}: missing asset ID`);
  check(meta.sourceHash==='sha256:'+actual,`${file}: stale sidecar hash`);
  if(report){const level=report.levels[lod];check(level.hash===actual&&level.errors.length===0,`${file}: failed/stale LOD gate`);
   if(e.simplification?.profile==='architecture-v2')check(!!level.structure&&['measured','insufficient-planar-coverage'].includes(level.structure.status),`${file}: missing structure diagnostic`);
   if(e.status==='delivered')check(!meta.userData.identicalPlaceholderLODs&&meta.userData.status!=='placeholder',`${file}: obsolete placeholder state`);
  }
  else check(meta.userData.status==='placeholder',`${file}: missing placeholder label`);
 }
}
for(const id of ['SKY-01','VFX-ATLAS-01']){
 const file=`assets/art/textures/${id}/${id}.png`;
 check(read(file+'.meta.json').sourceHash==='sha256:'+hash(file),`${file}: stale hash`);
}
const atlas=read('assets/art/textures/VFX-ATLAS-01/delivered-layout.json'),cells=new Set();let frameCount=0;
for(const [id,e] of Object.entries(atlas.effects)){
 check(e.frames===e.frameData.length,`${id}: frame count mismatch`);
 for(const f of e.frameData){
  frameCount++;const [x,y,w,h]=f.pixelRect;
  check(x>=0&&y>=0&&x+w<=atlas.atlasSize&&y+h<=atlas.atlasSize,`${id}: rect outside atlas`);
  check(f.uvOffset[0]===x/atlas.atlasSize&&f.uvOffset[1]===y/atlas.atlasSize&&f.uvScale[0]===w/atlas.atlasSize&&f.uvScale[1]===h/atlas.atlasSize,`${id}: UV mismatch`);
  check(!cells.has(f.row*atlas.grid+f.col),`${id}: overlapping cells`);cells.add(f.row*atlas.grid+f.col);
 }
}
check(frameCount===64&&Object.keys(atlas.effects).length===23,'Atlas inventory mismatch');
const project=read('aether.project.json');
for(const s of project.scenes){
 const scene=read(s.path),refs=scene.nodes.flatMap(n=>n.components.flatMap(c=>c.kind==='MeshRenderer'&&c.source.type==='asset'?[c.source.ref]:[]));
 if(scene.environment.sky?.texture)refs.push(scene.environment.sky.texture);
 for(const ref of refs.filter(r=>r.path.startsWith('assets/art/'))){
  check(read(ref.path+'.meta.json').guid===ref.guid,`${s.path}: stale GUID ${ref.path}`);
  check(scene.dependencies.includes(ref.path),`${s.path}: dependency missing ${ref.path}`);
 }
 check(scene.nodes.filter(n=>n.components.some(c=>c.kind==='MeshRenderer')).length<=64,`${s.path}: object overflow`);
}
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
else console.log(`P0: ${read('assets/art/p0-intake.json').models.length*3} model LODs, 2 textures, 23 effects / 64 frames and scene references verified. Visual approval is separate.`);
