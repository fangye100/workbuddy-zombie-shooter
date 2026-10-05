/** Sidecar annotations are merged; GUIDs survive future replacement deliveries. */
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {authoredGlb,pngRgb} from '../level/authored-glb.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const write=(p,v)=>fs.writeFileSync(path.join(root,p),JSON.stringify(v,null,2)+'\n');
const template=read('assets/art/models/ENV-MID-01/game_ready/ENV-MID-01_lod0.glb.meta.json');
function annotate(file,kind,userData){
 const absolute=path.join(root,file), side=absolute+'.meta.json';
 const meta=fs.existsSync(side)?JSON.parse(fs.readFileSync(side,'utf8')):{...structuredClone(template),guid:'as_'+createHash('sha256').update(file).digest('hex').slice(0,12),kind,userData:{}};
 meta.sourceHash='sha256:'+createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
 meta.userData={...meta.userData,...userData};
 write(file+'.meta.json',meta);
}
for(const e of read('assets/art/p0-intake.json').models)for(let lod=0;lod<3;lod++){
 annotate(`assets/art/models/${e.id}/game_ready/${e.id}_lod${lod}.glb`,'gltf',{
  assetId:e.id,status:e.status==='placeholder'?'placeholder':'runtime-candidate',lod,
  provenance:e.status==='placeholder'?'tools/art/build-p0-placeholders.mjs':`assets/art/sources/${e.id}/${e.id}_source.glb`,
  replacementContract:'Keep runtime path, sidecar GUID, metre scale and ground/grip pivot.',
  ...(e.status==='placeholder'?{reason:e.reason,identicalPlaceholderLODs:true}:{report:`assets/art/models/${e.id}/lod-report.json`}),
 });
}
annotate('assets/art/textures/SKY-01/SKY-01.png','texture',{assetId:'SKY-01',status:'runtime-candidate',mapping:'cloud-band-upper-hemisphere-pole-fade',sourceDelivery:'P0-20261005'});
annotate('assets/art/textures/VFX-ATLAS-01/VFX-ATLAS-01.png','texture',{
 assetId:'VFX-ATLAS-01',status:'quarantined',layout:'assets/art/textures/VFX-ATLAS-01/delivered-layout.json',
 reason:'Explosion has rectangular residue; smoke clips cells. Sequences are affine variants. GPU integration pending repaired alpha/padding acceptance.',
});
// One authored decal mesh replaces six separate static-object slots. Geometry lives in the asset.
const p=[],n=[],u=[],ix=[];
for(let i=0;i<6;i++){
 const z=i*2,a=p.length/3;
 p.push(-1.7,.006,z-.325,-1.7,.006,z+.325,1.7,.006,z+.325,1.7,.006,z-.325);
 n.push(0,1,0,0,1,0,0,1,0,0,1,0);u.push(0,0,0,1,1,1,1,0);ix.push(a,a+1,a+2,a,a+2,a+3);
}
const file='assets/art/models/road/game_ready/crosswalk.glb';fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});
fs.writeFileSync(path.join(root,file),authoredGlb('Six painted stripes',p,n,u,ix,pngRgb(2,2,()=>[255,255,255])));
annotate(file,'gltf',{status:'authored',provenance:'tools/art/prepare-p0-meta.mjs'});
