import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {prepareWeaponAssemblyPlayer} from './weapon-assembly-defaults.mjs';
const read=p=>JSON.parse(fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8'));
const calibration=read('assets/art/calibration/weapon-assembly-trial.json'),meta=read(calibration.character.asset.path+'.meta.json');
const fixture=()=>read('assets/scenes/act1/floor-1.scene.json');
test('新生成玩家使用真实 rig、既有动作及双手控制，种子模型与场景契约一致',()=>{
 const doc=fixture(),player=doc.nodes.find(n=>n.id===doc.playerStart),mesh=player.components.find(c=>c.kind==='MeshRenderer');
 mesh.source={type:'builtin',mesh:'box'};delete mesh.bodyIk;delete mesh.sharedMotion;
 prepareWeaponAssemblyPlayer(doc,calibration,meta,false);
 assert.deepEqual(mesh.source.ref,calibration.character.asset);assert.deepEqual(mesh.sharedMotion,meta.sharedMotion);
 assert.equal(mesh.bodyIk.controls.filter(c=>['rightHand','leftHand'].includes(c.part)&&c.enabled&&c.weight===1).length,2);
 const seed=read('assets/weapons/prototype.weapons.json'),rules=doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules');
 for(const a of seed.definitions){const b=rules.arsenal.definitions.find(w=>w.id===a.id);assert.deepEqual(a.presentation.model,b.presentation.model);assert.deepEqual(a.presentation.assembly,b.presentation.assembly);}
});
test('已有配置不被覆盖；生成高度变更只校准独立模拟marker',()=>{
 const doc=fixture(),player=doc.nodes.find(n=>n.id===doc.playerStart),mesh=player.components.find(c=>c.kind==='MeshRenderer');mesh.bodyIk=null;const before=structuredClone(mesh);player.transform.position[1]=.12;
 prepareWeaponAssemblyPlayer(doc,calibration,meta,true);assert.deepEqual(mesh,before);
 const pistol=doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules').arsenal.definitions.find(w=>w.id==='pistol');assert.ok(Math.abs(pistol.presentation.markers.muzzle.position[1]-.567)<1e-12);
 assert.deepEqual(meta,read(calibration.character.asset.path+'.meta.json'));
});
