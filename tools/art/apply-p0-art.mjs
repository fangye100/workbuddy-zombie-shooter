/** Offline scene authoring. Never constructs scene content inside the renderer. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function applyP0Art(doc,root){
 const depth=Number(/floor(\d+)/.exec(doc.id)?.[1]);
 if(![1,2,3].includes(depth))throw new Error('Unsupported P0 scene');
 const prefix=`nd_f${depth}`;
 const ref=file=>({path:file,guid:JSON.parse(fs.readFileSync(path.join(root,file+'.meta.json'),'utf8')).guid});
 if(doc.environment.sky)Object.assign(doc.environment.sky,{texture:ref('assets/art/textures/SKY-01/SKY-01.png'),textureMix:.68,textureYaw:40});
 if(depth===1){
  // Only redundant paint nodes are removed; gameplay identity and authored props survive.
  doc.nodes=doc.nodes.filter(n=>!new RegExp(`^${prefix}_crosswalk_[1-5]$`).test(n.id));
  const stripes=doc.nodes.find(n=>n.id===`${prefix}_crosswalk_0`);
  stripes.components.find(c=>c.kind==='MeshRenderer').source={type:'asset',ref:ref('assets/art/models/road/game_ready/crosswalk.glb')};
  function place(id,asset,lod,position,yaw,name,unlit=false){
   let n=doc.nodes.find(n=>n.id===id);if(!n){n={id,prefab:null};doc.nodes.push(n);}
   Object.assign(n,{name,parent:null,visible:true,pickable:true,category:asset.includes('FAR')?'远景':'中景',
    transform:{position,rotation:[0,Math.sin(yaw/2),0,Math.cos(yaw/2)],scale:[1,1,1]},
    components:[{kind:'MeshRenderer',enabled:true,visible:true,layer:3,importScale:1,
      source:{type:'asset',ref:ref(`assets/art/models/${asset}/game_ready/${asset}_lod${lod}.glb`)},
      materials:[{match:{by:'index',value:0},material:{type:'override',base:{type:'shared',id:'s1'},patch:{
       albedo:'#ffffff',roughness:.94,metallic:0,specMix:0,outlineScale:asset.includes('FAR')?0:.25,halftoneScale:.12,unlit,
      }}}],
    }],
   });
  }
  place(`${prefix}_backdrop`,'ENV-FAR-01',1,[0,-.2,-60],0,'ENV-FAR-01 · 冷色城市天际线',true);
  place(`${prefix}_art_far_repeat`,'ENV-FAR-01',1,[64,-.2,-67],0,'ENV-FAR-01 · 远侧城市延伸',true);
  place(`${prefix}_art_mid01`,'ENV-MID-01',1,[-7,0,-24],0,'ENV-MID-01 · 红砖公寓');
  place(`${prefix}_art_mid02`,'ENV-MID-02',1,[14,0,-27],-.3,'ENV-MID-02 · 街角楼');
  place(`${prefix}_art_mid03`,'ENV-MID-03',0,[48,0,-26],0,'ENV-MID-03 · 修车库【占位·待正式资产】');
  place(`${prefix}_art_far02`,'ENV-FAR-02',0,[48,0,-88],0,'ENV-FAR-02 · 工业天际线【占位·待正式资产】',true);
 }
 doc.dependencies=[...new Set([...doc.nodes.flatMap(n=>n.components.flatMap(c=>c.kind==='MeshRenderer'&&c.source.type==='asset'?[c.source.ref.path]:[])),...(doc.environment.sky?.texture?[doc.environment.sky.texture.path]:[])])];
 const count=doc.nodes.filter(n=>n.components.some(c=>c.kind==='MeshRenderer')).length;
 if(count>64)throw new Error(`Static object budget exceeded: ${count}`);
 return doc;
}
const root=fileURLToPath(new URL('../../',import.meta.url));
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))for(const depth of [1,2,3]){
 const file=path.join(root,`assets/scenes/act1/floor-${depth}.scene.json`);
 fs.writeFileSync(file,JSON.stringify(applyP0Art(JSON.parse(fs.readFileSync(file,'utf8')),root),null,2)+'\n');
}
