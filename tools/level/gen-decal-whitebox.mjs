import fs from 'node:fs';import {loadSceneContract} from '../scene/load-contract.mjs';
const schema=await loadSceneContract();
const doc=schema.migrateToLatest(JSON.parse(fs.readFileSync('assets/scenes/sandbox/navigation-3d-whitebox.scene.json','utf8'))).doc;
doc.id='sc_procedural_decal_whitebox';doc.name='程序贴花白盒 · 平地 / 坡道 / 墙面 / 遮挡';
doc.editorCamera={target:[4,1.8,1],distance:30,yaw:.5,elevation:.72};
doc.meta.notes='五种确定性程序图案；下平台阴影遮挡测试、斜坡贴附、墙面弹孔、上平台叠层隔离。Play MCP 可发运行痕迹并检验寿命与 Stop。';
for(const n of doc.nodes)for(const c of n.components){if(c.kind==='SpawnPoint')c.count=0;if(c.kind==='RoomVolume')c.clearRule='interact';}
const mark=(id,pattern,position,size,color,seed,rotation=[0,0,0,1])=>({id,pattern,position,rotation,size,color,opacity:.9,seed,normalOffset:.008,priority:0});
const patch=(id,marks)=>doc.nodes.find(n=>n.id===id).components.push({kind:'Decal',enabled:true,marks});
patch('nd_nav3d_low',[
  mark('blood','splatter',[-1.4,0,-2.1],[1.6,1.6],'#a12f38',31),mark('soot','scorch',[1.3,0,-2.1],[1.6,1.6],'#353542',71),
  mark('split','crack',[-1.4,0,-1.5],[1.9,1.7],'#182430',9),mark('warning','hazard',[1.3,0,-1.5],[1.8,1.4],'#e8bb31',10),
  mark('occlusion','splatter',[0,0,1.3],[2.8,2.8],'#6aa82b',21),mark('hole','bullet-hole',[1.3,0,2.2],[1.5,1.5],'#afa38f',8),
]);
patch('nd_nav3d_ramp',[mark('ramp-splat','splatter',[-2,0,0],[2.8,2.2],'#8e2839',4),mark('ramp-crack','crack',[1.6,0,0],[2.8,2.2],'#203045',17)]);
patch('nd_nav3d_high',[mark('upper-soot','scorch',[-1.6,0,-1],[2.8,2.4],'#3b3541',39),mark('upper-warning','hazard',[1.7,0,-1],[2.2,1.7],'#ebb337',4)]);
const mesh=(size,color)=>({kind:'MeshRenderer',enabled:true,source:{type:'builtin',shape:'box',params:size},materials:[{match:{by:'index',value:0},material:{type:'override',base:{type:'shared',id:'s1'},patch:{albedo:color,roughness:.9,outlineScale:.2,halftoneScale:0}}}],visible:true,layer:0,importScale:1});
function add(id,name,position,components){doc.nodes.push({id,name,parent:null,transform:{position,rotation:[0,0,0,1],scale:[1,1,1]},visible:true,pickable:true,prefab:null,components});}
add('nd_decal_wall','墙面 · 正面弹孔 / 裂纹',[-3,1.8,-.9],[mesh([5.6,3.6,.3],'#c1b39c'),{kind:'Decal',enabled:true,marks:[mark('wall-hole','bullet-hole',[-1,0,.15],[1.8,1.8],'#6b5944',56,[Math.SQRT1_2,0,0,Math.SQRT1_2]),mark('wall-crack','crack',[1,.1,.15],[1.9,2.5],'#30241b',8,[Math.SQRT1_2,0,0,Math.SQRT1_2])]}]);
add('nd_decal_occluder','遮挡柱 · 贴花不得透过',[-3,.8,3.3],[mesh([1.1,1.6,1.1],'#658496')]);
const errors=schema.validateSceneDocument(doc).filter(d=>d.severity==='error');if(errors.length)throw Error(JSON.stringify(errors));
const path='assets/scenes/sandbox/procedural-decal-whitebox.scene.json';fs.writeFileSync(path,JSON.stringify(doc,null,2)+'\n');
const project=JSON.parse(fs.readFileSync('aether.project.json'));if(!project.scenes.some(s=>s.id===doc.id))project.scenes.push({id:doc.id,path,name:doc.name,enabled:true});fs.writeFileSync('aether.project.json',JSON.stringify(project,null,2)+'\n');
// 正式第一层只加入场景痕迹，不改变碰撞、路径、人物或既有材质。
const floorPath='assets/scenes/act1/floor-1.scene.json',floor=JSON.parse(fs.readFileSync(floorPath));
const receiver=floor.nodes.find(n=>n.id==='nd_f1_street');let decals=receiver.components.find(c=>c.kind==='Decal');
if(!decals){decals={kind:'Decal',enabled:true,marks:[]};receiver.components.push(decals);}
decals.marks=decals.marks.filter(m=>!m.id.startsWith('street-proc-'));
for(let i=0;i<24;i++){
  const pattern=i%5===0?'splatter':i%3===0?'scorch':'crack',x=4+i*2.4,z=Math.sin(i*2.399)*3.8;
  decals.marks.push(mark(`street-proc-${i}`,pattern,[x-33,.12,z],[1.1+(i%4)*.3,.8+(i%3)*.3],pattern==='splatter'?'#702432':pattern==='scorch'?'#2e2b34':'#222633',i*137));
}
const floorErrors=schema.validateSceneDocument(floor).filter(d=>d.severity==='error');if(floorErrors.length)throw Error(JSON.stringify(floorErrors));fs.writeFileSync(floorPath,JSON.stringify(floor,null,2)+'\n');
console.log(`贴花白盒 ${doc.nodes.length} 节点 / 12 作者痕迹，第一层 24 街道痕迹`);
