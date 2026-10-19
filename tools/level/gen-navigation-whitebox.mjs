/** 可复现的三维导航白盒。所有可见内容与导航语义都写入场景，不在宿主硬编码。 */
import fs from 'node:fs';
import {loadSceneContract} from '../scene/load-contract.mjs';
const scene=await loadSceneContract();
const doc=scene.createEmptySceneDocument('三维导航白盒 · 斜坡 / 楼梯 / 叠层');
doc.id='sc_navigation_3d_whitebox';doc.nodes=[];doc.entryCamera='nd_nav3d_camera';doc.playerStart='nd_nav3d_player';doc.loseCondition='player-death';
doc.editorCamera={target:[6,2,1],distance:32,yaw:.85,elevation:.65};
doc.meta.notes='白盒验收：玩家在高台；蓝色坡道与黄色楼梯连接下平台；下层红色区域与孤岛不可达。WASD 移动可反向验证。';
function node(id,name,position,components=[],rotation=[0,0,0,1],parent=null){
  const n={id,name,parent,transform:{position,rotation,scale:[1,1,1]},visible:true,pickable:true,prefab:null,components};doc.nodes.push(n);return n;
}
function mesh(shape,params,color){return {kind:'MeshRenderer',enabled:true,source:{type:'builtin',shape,params},materials:[{match:{by:'index',value:0},material:{type:'override',base:{type:'shared',id:'s1'},patch:{albedo:color,roughness:.9,metallic:0,halftoneScale:0,outlineScale:.2}}}],visible:true,layer:0,importScale:1};}
function surface(id,name,pos,width,depth,color,rotation=[0,0,0,1]){
  return node(id,name,pos,[mesh('plane',[width,depth],color),{kind:'NavSurface',enabled:true,size:[width,depth]}],rotation);
}
surface('nd_nav3d_low','下平台 · Y=0',[-3,0,2],6,12,'#e4e7eb');
const angle=Math.atan(.5);
surface('nd_nav3d_ramp','蓝色斜坡 · 26.565° · Y=0→4',[4,2,0],Math.hypot(8,4),8,'#7ac9e5',[0,0,Math.sin(angle/2),Math.cos(angle/2)]);
surface('nd_nav3d_high','上平台 · Y=4',[12,4,2],8,12,'#dce1e8').components[1].supportCollider='nd_nav3d_high_slab';
surface('nd_nav3d_under','叠层隔离区 · Y=0',[12,0,0],8,8,'#d6a6a1');
surface('nd_nav3d_island','不可达孤岛 · Y=8',[23,8,0],6,8,'#db9baa');
for(let i=0;i<16;i++){
  surface(`nd_nav3d_step_${i}`,`楼梯 ${i+1} · 每级 0.25m`,[i*.5+.25,i*.25,6],.5,4,i%2?'#d6c794':'#f0d792');
  node(`nd_nav3d_step_mesh_${i}`,'楼梯实体侧面',[i*.5+.25,i*.25-.16,6],[mesh('box',[.5,.28,4],'#b8a877')]);
}
node('nd_nav3d_high_slab','上平台实体与子弹遮挡',[12,3.83,2],[mesh('box',[8,.3,12],'#bcc4d0'),{kind:'Collider',enabled:true,shape:{type:'box',halfExtents:[4,.15,6]},isTrigger:false,layer:0}]);
node('nd_nav3d_player','玩家起点 · Y=4',[13,4,0]);
node('nd_nav3d_key','主光',[0,0,0],[{kind:'Light',enabled:true,type:'directional',color:'#fff7e8',intensity:1.5,range:0,spotAngle:0,castShadow:false,priority:100}]);
node('nd_nav3d_camera','固定全景验收机位',[6,2,1],[{kind:'Camera',enabled:true,fovDeg:50,near:.1,far:200,mode:'fixed',followTarget:null,pitchDeg:40,distance:32,yawOffsetDeg:48,yawMode:'world'}]);
node('nd_nav3d_nav','三维导航作用域',[10,3,2],[{kind:'NavZone',enabled:true,bounds:{center:[10,3,2],size:[36,16,16]},cellSize:.5,baked:null,crowd:scene.defaultNavigationSettings(),surface:{maxSlopeDeg:40,maxStepM:.3,agentRadius:.35,agentHeight:2.2}}]);
node('nd_nav3d_room','白盒运行房间',[10,3,2],[{kind:'RoomVolume',enabled:true,roomType:'combat',theme:'none',bounds:{center:[10,3,2],size:[36,16,16]},clearRule:'kill-all',clearTarget:null,depth:1}]);
function spawn(id,name,pos,count,radius){node(id,name,[pos[0]-10,pos[1]-3,pos[2]-2],[{kind:'SpawnPoint',enabled:true,characterId:'E-01',count,wave:1,trigger:'room-enter',delaySec:0,radius,prefab:null}],undefined,'nd_nav3d_room');}
spawn('nd_nav3d_spawn_ramp','坡道追击组',[-4,0,-1],4,.7);
spawn('nd_nav3d_spawn_stairs','楼梯追击组',[-3,0,6],4,.7);
spawn('nd_nav3d_spawn_under','叠层隔离组',[12,0,0],2,.6);
spawn('nd_nav3d_spawn_island','不可达孤岛组',[23,8,0],2,.6);
const errors=scene.validateSceneDocument(doc).filter(d=>d.severity==='error');if(errors.length)throw Error(JSON.stringify(errors));
const path='assets/scenes/sandbox/navigation-3d-whitebox.scene.json';fs.writeFileSync(path,JSON.stringify(doc,null,2)+'\n');
const project=JSON.parse(fs.readFileSync('aether.project.json','utf8'));
if(!project.scenes.some(s=>s.id===doc.id))project.scenes.push({id:doc.id,path,name:doc.name,enabled:true});
fs.writeFileSync('aether.project.json',JSON.stringify(project,null,2)+'\n');
console.log(`白盒已生成：${path}，${doc.nodes.length} 节点`);
