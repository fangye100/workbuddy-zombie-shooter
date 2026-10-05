/** A registered authoring scene for comparing all three LODs with visible stable IDs. */
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import path from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const bundle=path.join(root,'.workbuddy/tmp/p0-scene-bundle.mjs');
await build({entryPoints:[path.join(root,'packages/scene/src/index.ts')],bundle:true,platform:'node',format:'esm',outfile:bundle,tsconfig:path.join(root,'tsconfig.check.json')});
const {createEmptySceneDocument}=await import(pathToFileURL(bundle).href);
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const write=(p,v)=>fs.writeFileSync(path.join(root,p),JSON.stringify(v,null,2)+'\n');
const doc=createEmptySceneDocument('P0 · LOD 与占位资产验收');doc.id='sc_p0_art_gallery';
const floor=read('assets/scenes/act1/floor-1.scene.json');
doc.environment=structuredClone(floor.environment);doc.environment.fog.density=0;doc.environment.sky.textureYaw=65;
doc.editorCamera={target:[4,0,9.5],distance:29,yaw:.4,elevation:.85};
doc.nodes=doc.nodes.filter(n=>n.id===doc.entryCamera).concat(floor.nodes.filter(n=>n.components.some(c=>c.kind==='Light')).map(n=>({...n,id:n.id.replace('nd_f1','nd_p0')})));
const entries=read('assets/art/p0-intake.json').models;
entries.forEach((e,row)=>{
 const dimensions=e.status==='delivered'?read(`assets/art/models/${e.id}/lod-report.json`).dimensions:[e.size[0],e.size[2],e.size[1]];
 const scale=2.8/Math.max(...dimensions);
 for(let lod=0;lod<3;lod++){
  const file=`assets/art/models/${e.id}/game_ready/${e.id}_lod${lod}.glb`;
  doc.nodes.push({id:`nd_p0_${row}_${lod}`,name:`${e.id} · LOD${lod}${e.status==='placeholder'?'【占位】':''} · 展示比例 ${scale.toFixed(3)}`,
   parent:null,prefab:null,visible:true,pickable:true,category:e.id,
   transform:{position:[lod*4,0,row*3.8],rotation:[0,0,0,1],scale:[scale,scale,scale]},
   components:[{kind:'MeshRenderer',enabled:true,visible:true,layer:4,importScale:1,
    source:{type:'asset',ref:{path:file,guid:read(file+'.meta.json').guid}},
    materials:[{match:{by:'index',value:0},material:{type:'override',base:{type:'shared',id:'s1'},patch:{albedo:'#ffffff',outlineScale:.1,halftoneScale:.1,roughness:.9,metallic:0,specMix:0}}}],
   }],
  });
 }
});
doc.dependencies=doc.nodes.flatMap(n=>n.components.flatMap(c=>c.kind==='MeshRenderer'?[c.source.ref.path]:[]));
doc.dependencies.push(doc.environment.sky.texture.path);
const file='assets/scenes/sandbox/p0-art-gallery.scene.json';write(file,doc);
const project=read('aether.project.json');if(!project.scenes.some(s=>s.id===doc.id))project.scenes.push({id:doc.id,path:file,name:doc.name,enabled:true});write('aether.project.json',project);
