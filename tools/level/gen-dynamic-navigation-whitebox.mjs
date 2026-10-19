/** 两条立体路径 + 两扇吊门，复用斜坡/楼梯白盒；不向宿主写入场景内容。 */
import fs from 'node:fs';
import {loadSceneContract} from '../scene/load-contract.mjs';
const scene=await loadSceneContract();
const doc=scene.migrateToLatest(JSON.parse(fs.readFileSync('assets/scenes/sandbox/navigation-3d-whitebox.scene.json','utf8'))).doc;
doc.id='sc_dynamic_navigation_whitebox';doc.name='动态障碍白盒 · 吊门 / 绕行 / 等待';
doc.meta.notes='橙色 A 门封闭斜坡，黄色 B 门初始打开：追击组绕楼梯。关闭 B 后两路都断，NPC 等待；打开 A 后恢复斜坡。面板按钮与 MCP editor_gate 共用 RuntimeSession。';
// 延长战斗验收窗口：玩家仍遵循正常攻击/受击，不制造无敌模式。
doc.nodes.find(n=>n.id===doc.playerStart).transform.position=[15,4,-2];
const box=(params,color)=>({kind:'MeshRenderer',enabled:true,source:{type:'builtin',shape:'box',params},materials:[{match:{by:'index',value:0},material:{type:'override',base:{type:'shared',id:'s1'},patch:{albedo:color,roughness:.9,metallic:0,halftoneScale:0,outlineScale:.2}}}],visible:true,layer:0,importScale:1});
function add(id,name,pos,components){doc.nodes.push({id,name,parent:null,transform:{position:pos,rotation:[0,0,0,1],scale:[1,1,1]},visible:true,pickable:true,prefab:null,components});}
function gate(id,name,z,depth,initialOpen,color){
  add(id,name,[4,3,z],[box([.5,4,depth],color),{kind:'Collider',enabled:true,shape:{type:'box',halfExtents:[.25,2,depth/2]},isTrigger:false,layer:0},
    {kind:'NavigationGate',enabled:true,openOffset:[0,4,0],travelSec:1.5,initialOpen}]);
  for(const side of [-1,1])add(`${id}_post_${side===1?'r':'l'}`,`${name}门柱`,[4,4,z+side*(depth/2+.2)],[box([.7,8,.4],'#566677')]);
  add(`${id}_beam`,`${name}横梁`,[4,8.2,z],[box([.7,.4,depth+.8],'#778899')]);
}
gate('nd_gate_ramp','A · 斜坡吊门',0,8,false,'#e7924d');
gate('nd_gate_stairs','B · 楼梯吊门',6,4,true,'#ecce61');
const errors=scene.validateSceneDocument(doc).filter(d=>d.severity==='error');if(errors.length)throw Error(JSON.stringify(errors));
const path='assets/scenes/sandbox/dynamic-navigation-whitebox.scene.json';fs.writeFileSync(path,JSON.stringify(doc,null,2)+'\n');
const project=JSON.parse(fs.readFileSync('aether.project.json','utf8'));if(!project.scenes.some(s=>s.id===doc.id))project.scenes.push({id:doc.id,path,name:doc.name,enabled:true});
fs.writeFileSync('aether.project.json',JSON.stringify(project,null,2)+'\n');console.log(`动态白盒已生成，${doc.nodes.length} 节点`);
