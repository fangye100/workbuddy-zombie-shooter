/** Bind exported rigs to the manifest, production player and persisted acceptance scene. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
process.chdir(resolve(import.meta.dirname,'../..'));
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const write=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const delivery=read('.workbuddy/tmp/npc-rig-20261007/delivery.json'),byId=new Map(delivery.map(r=>[r.id,r]));
if(byId.size!==9)throw Error('Export and validate all nine character rigs before integration');
const manifest=read('assets/_data/asset-manifest.json');
for(const c of manifest.characters){
 const r=byId.get(c.id);if(!r)throw Error('Missing '+c.id);
 const tier={label:c.id==='H-01'?'LOD0 · +骨骼 · 动作就绪':'LOD2 · +骨骼 · 体积蒙皮',file:r.ref.path.replace(/^assets\//,''),tris:r.stats.triangles,verts:r.stats.vertices,bytes:readFileSync(r.ref.path).length};
 const index=c.lods.findIndex(l=>l.label.includes('+骨骼'));if(index<0)c.lods.push(tier);else c.lods[index]=tier;c.joints=27;
}
writeFileSync('assets/_data/asset-manifest.json',JSON.stringify(manifest,null,1)+'\n');
const player=byId.get('H-01'),sharedMotion=read(player.ref.path+'.meta.json').sharedMotion;
for(const floor of [1,2,3]){
 const path=`assets/scenes/act1/floor-${floor}.scene.json`,scene=read(path),oldPaths=[];
 for(const n of scene.nodes)for(const c of n.components)if(c.kind==='MeshRenderer'&&c.playBinding==='player'){
  oldPaths.push(c.source.ref.path);c.source={type:'asset',ref:player.ref};c.sharedMotion=sharedMotion;
 }
 if(oldPaths.length!==1)throw Error('Expected exactly one production player on floor '+floor);
 scene.dependencies=scene.dependencies.map(p=>oldPaths.includes(p)?player.ref.path:p);write(path,scene);
}
const sandboxPath='assets/scenes/sandbox/shared-motion-runtime.scene.json',sandbox=read(sandboxPath);
for(const n of sandbox.nodes){
 const id=n.id==='nd_motion_player'||n.id==='nd_motion_h01'?'H-01':n.id.startsWith('nd_motion_E-')?n.id.replace('nd_motion_',''):null;
 if(!id)continue;const r=byId.get(id);n.name=n.name.replace('22 bones','27 bones');
 for(const c of n.components)if(c.kind==='MeshRenderer')c.source={type:'asset',ref:r.ref};
}
write(sandboxPath,sandbox);
const gallery=structuredClone(sandbox),modelTemplate=structuredClone(sandbox.nodes.find(n=>n.id==='nd_motion_E-01')),spawnTemplate=structuredClone(sandbox.nodes.find(n=>n.id==='nd_motion_spawn_E-01'));
gallery.id='sc_character_rig_validation';gallery.name='角色 Rig · 9 角色共享动作验收';
gallery.editorCamera={target:[0,1,3],distance:27,yaw:0,elevation:.27};
gallery.nodes=gallery.nodes.filter(n=>!n.id.startsWith('nd_motion_E-')&&!n.id.startsWith('nd_motion_spawn_'));
for(const n of gallery.nodes)if(n.id==='nd_motion_h01'){
 n.transform.position=[-2,0,8];for(const c of n.components)if(c.kind==='MeshRenderer')c.editorOnly=true;
}else if(n.id==='nd_motion_player')n.transform.position=[2,0,8];
manifest.characters.filter(c=>c.id!=='H-01').forEach((c,i)=>{
 const r=byId.get(c.id),position=[(i%4-1.5)*4,0,Math.floor(i/4)*4];
 const node=structuredClone(modelTemplate);node.id='nd_rig_'+c.id;node.name=c.id+' · '+c.name+' · 27 bones';node.transform.position=position;
 for(const m of node.components)if(m.kind==='MeshRenderer'){m.source={type:'asset',ref:r.ref};m.editorOnly=true;m.sharedMotion={...read(r.ref.path+'.meta.json').sharedMotion,defaultState:'walk'};}
 gallery.nodes.push(node);
 const spawn=structuredClone(spawnTemplate);spawn.id='nd_rig_spawn_'+c.id;spawn.name='Runtime · '+c.id+' · '+c.name;spawn.transform.position=position;
 for(const s of spawn.components)if(s.kind==='SpawnPoint'){s.characterId=c.id;s.delaySec=0;s.wave=1;}
 gallery.nodes.push(spawn);
});
gallery.meta={...gallery.meta,updatedAt:new Date().toISOString(),author:'character-rig-delivery',notes:'Edit: nine textured character rigs using shared motions. Play: eight runtime NPCs plus player. Static NPC previews are editorOnly; Stop restores them. B-03 IV stand, bag and tubes rigidly follow LeftHand.'};
const galleryPath='assets/scenes/sandbox/character-rig-validation.scene.json';write(galleryPath,gallery);
const project=read('aether.project.json');if(!project.scenes.some(s=>s.id===gallery.id))project.scenes.push({path:galleryPath,id:gallery.id,name:gallery.name,enabled:true});write('aether.project.json',project);
console.log('Integrated 9 rigs, 3 production floors and persisted Play validation scene.');
