import fs from 'node:fs';
import {loadSceneContract} from '../scene/load-contract.mjs';
const schema=await loadSceneContract();
export const combatDecalConfig=()=>({kind:'DecalEmitter',enabled:true,capacity:256,maxPerFrame:32,groundProbeM:.6,surfaceSnapM:.45,rules:[
  {id:'bullet',event:'weapon-solid-impact',pattern:'bullet-hole',color:'#b3a186',size:[.22,.22],opacity:.95,ttlSec:35,fadeSec:5,maxAlive:128,cooldownSec:0,normalOffset:.004,style:{coverage:.9,edgeWidth:.02,irregularity:.7,detail:.7}},
  {id:'blood',event:'npc-damage',pattern:'splatter',color:'#982c3c',size:[.85,.7],opacity:.86,ttlSec:22,fadeSec:5,maxAlive:96,cooldownSec:.18,normalOffset:.006,style:{coverage:.92,edgeWidth:.015,irregularity:.8,detail:.65}},
  {id:'acid',event:'acid-land',pattern:'acid',color:'#91bc38',size:[2.4,2.4],opacity:.84,ttlSec:7,fadeSec:2,maxAlive:32,cooldownSec:0,normalOffset:.008,style:{coverage:1,edgeWidth:.02,irregularity:.65,detail:.6}},
]});
function write(path,doc){const errors=schema.validateSceneDocument(doc).filter(d=>d.severity==='error');if(errors.length)throw Error(JSON.stringify(errors));fs.writeFileSync(path,JSON.stringify(doc,null,2)+'\n');}
for(let i=1;i<=3;i++){
 const path=`assets/scenes/act1/floor-${i}.scene.json`,doc=schema.migrateToLatest(JSON.parse(fs.readFileSync(path,'utf8'))).doc;
 const owner=doc.nodes.find(n=>n.components.some(c=>c.kind==='RunRules'));if(!owner)throw Error('缺少玩法规则所有者');
 owner.components=owner.components.filter(c=>c.kind!=='DecalEmitter');owner.components.push(combatDecalConfig());write(path,doc);
 if(i===1){
  // 原街景墙未声明射线实体。资产的 POSITION 包围范围生成原点对齐的保守 box；
  // 命中痕迹仍通过可见三角形复核，碰撞代理不等于可见墙面。
  for(const n of doc.nodes.filter(n=>n.id.startsWith('nd_f1_street_wall_'))){
   if(n.components.some(c=>c.kind==='Collider'))continue;
   const mesh=n.components.find(c=>c.kind==='MeshRenderer');if(mesh?.source.type!=='asset')continue;
   const bytes=fs.readFileSync(mesh.source.ref.path),gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
   if(gltf.nodes.some(n=>n.matrix||n.translation||n.rotation||n.scale))throw Error('墙体包围导出需要先应用GLB节点变换');
   const boxes=gltf.meshes.flatMap(m=>m.primitives.map(p=>gltf.accessors[p.attributes.POSITION]));
   const halfExtents=[0,1,2].map(axis=>Math.max(...boxes.flatMap(b=>[Math.abs(b.min[axis]),Math.abs(b.max[axis])])));
   n.components.push({kind:'Collider',enabled:true,shape:{type:'box',halfExtents},isTrigger:false,layer:0});
  }
  write(path,doc);
 }
}
const doc=schema.migrateToLatest(JSON.parse(fs.readFileSync('assets/scenes/sandbox/navigation-3d-whitebox.scene.json','utf8'))).doc;
doc.id='sc_combat_decal_whitebox';doc.name='战斗贴花白盒 · 弹孔 / 受击血迹 / 酸池';
const keep=['nd_nav3d_low','nd_nav3d_player','nd_nav3d_key','nd_nav3d_camera','nd_nav3d_nav','nd_nav3d_room','nd_nav3d_spawn_ramp','nd_nav3d_spawn_stairs'];
doc.nodes=doc.nodes.filter(n=>keep.includes(n.id));const node=id=>doc.nodes.find(n=>n.id===id);
node('nd_nav3d_low').transform.position=[0,0,0];node('nd_nav3d_low').components.find(c=>c.kind==='MeshRenderer').source.params=[24,18];node('nd_nav3d_low').components.find(c=>c.kind==='NavSurface').size=[24,18];
node('nd_nav3d_player').transform.position=[0,0,0];
for(const id of ['nd_nav3d_nav','nd_nav3d_room']){node(id).transform.position=[0,0,0];node(id).components[0].bounds={center:[0,0,0],size:[24,8,18]};}
node('nd_nav3d_room').components[0].clearRule='interact';node('nd_nav3d_nav').components[0].surface.agentRadius=.6;
node('nd_nav3d_spawn_ramp').transform.position=[4,0,-3];node('nd_nav3d_spawn_ramp').name='近战受击测试';node('nd_nav3d_spawn_ramp').components[0].count=3;node('nd_nav3d_spawn_ramp').components[0].radius=.3;
node('nd_nav3d_spawn_stairs').transform.position=[-5,0,1];node('nd_nav3d_spawn_stairs').name='酸液投射测试';node('nd_nav3d_spawn_stairs').components[0].characterId='E-03';node('nd_nav3d_spawn_stairs').components[0].count=1;node('nd_nav3d_spawn_stairs').components[0].radius=.05;
node('nd_nav3d_camera').transform.position=[0,0,0];const camera=node('nd_nav3d_camera').components[0];Object.assign(camera,{distance:16,pitchDeg:48,yawOffsetDeg:0});
const floor=JSON.parse(fs.readFileSync('assets/scenes/act1/floor-1.scene.json','utf8')),rules=structuredClone(floor.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules'));delete rules.bossAttack;
node('nd_nav3d_room').components.push(rules,combatDecalConfig());
const mesh=(size,color)=>({kind:'MeshRenderer',enabled:true,source:{type:'builtin',shape:'box',params:size},materials:[{match:{by:'index',value:0},material:{type:'override',base:{type:'shared',id:'s1'},patch:{albedo:color,roughness:.9,halftoneScale:0,outlineScale:.2}}}],visible:true,layer:0,importScale:1});
doc.nodes.push({id:'nd_combat_wall',name:'实弹接收墙 · 向南开火',parent:null,transform:{position:[0,1.5,-6],rotation:[0,0,0,1],scale:[1,1,1]},visible:true,pickable:true,prefab:null,components:[mesh([12,3,.5],'#b6ac98'),{kind:'Collider',enabled:true,shape:{type:'box',halfExtents:[6,1.5,.25]},isTrigger:false,layer:0}]});
doc.editorCamera={target:[0,.5,0],distance:23,yaw:0,elevation:.85};doc.meta.notes='真实武器射线生成弹孔，NPC正伤害生成脚下血迹，E-03成功落地生成酸液残留；禁止以editor_decal人工emit代替战斗验收。';
const path='assets/scenes/sandbox/combat-decal-whitebox.scene.json';write(path,doc);
const project=JSON.parse(fs.readFileSync('aether.project.json'));if(!project.scenes.some(s=>s.id===doc.id))project.scenes.push({id:doc.id,path,name:doc.name,enabled:true});fs.writeFileSync('aether.project.json',JSON.stringify(project,null,2)+'\n');
console.log('三关事件规则 + 9节点真实战斗白盒已生成');
