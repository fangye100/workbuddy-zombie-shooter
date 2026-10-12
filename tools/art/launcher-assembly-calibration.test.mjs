/** f5真实失效肩链回归；不是GPU姿态/手指/全身碰撞批准。 */
import fs from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
const read=p=>JSON.parse(fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8'));
await build({stdin:{contents:"export * from '@aether/render';export * from '@aether/core';export * from '@aether/zombie-game/presentation/weapon-model';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:'.workbuddy/tmp/wpn-integration/launcher-calibration-test-api.mjs',tsconfig:'tsconfig.check.json',logLevel:'error'});
const a=await import('../../.workbuddy/tmp/wpn-integration/launcher-calibration-test-api.mjs');
const def=read('assets/weapons/prototype.weapons.json').definitions.find(d=>d.id==='launcher'),sockets=read(def.presentation.model.path+'.meta.json').modelSockets;
const spec=def.presentation.assembly.attachments[0],child=read(spec.model.path+'.meta.json').modelSockets;
const grip=a.composeSocket(a.composeSocket(a.composeSocket(sockets[spec.parentSocket],spec.offset),a.inverseSocket(child[spec.childSocket])),child.primaryGrip);
const records=read('tools/art/fixtures/launcher-shoulders-f5.json'),distance=(x,y)=>Math.hypot(...x.map((n,i)=>n-y[i]));
test('f5实际静态/入位/右手最紧/晚段左手最紧/upperReady肩链都有15mm余量',()=>{
 for(const sample of records.samples){
  const req=a.weaponModelProjection(def,sample.pose,sample.yaw,sample.actorRotation,sockets,{id:sample.primary.controlId,socket:{contact:sample.primary.contact}},{id:sample.dependent.controlId,socket:{contact:sample.dependent.contact}},grip).request;
  for(const [hand,control] of [['Right',req.primary],['Left',req.dependent]]){
   const joint=name=>sample.chains.find(q=>q.name===hand+name).position;
   const length=distance(joint('Arm'),joint('ForeArm'))+distance(joint('ForeArm'),joint('Hand'));
   const target=a.composeSocket(a.composeSocket(req.target,control.modelSocket),a.inverseSocket(control.contact)).position;
   assert.ok(length-distance(joint('Arm'),target)>=.015-1e-7,`${sample.frame}/${hand}真实肩球余量失败`);
  }
 }
});
test('三档预算、scale、sourceHash、稳定GUID及非位置BIN后处理记录完整',()=>{
 for(const [owner,name,guid] of [['WPN-07-LAUNCHER','lod-report.json','as_f2f39beb7444'],['WPN-SHELL-01','WPN-07-LAUNCHER-round-derived-fit-report.json',read(spec.model.path+'.meta.json').guid]]){
  const report=read(`assets/art/models/${owner}/${name}`);assert.equal(report.ergonomicNormalization.factor,.9);
  assert.equal(report.sourceHash,createHash('sha256').update(fs.readFileSync(report.source)).digest('hex'));
  for(const l of report.levels){const p=`assets/art/models/${owner}/game_ready/${l.file}`,meta=read(p+'.meta.json');assert.equal(meta.sourceHash,'sha256:'+l.hash);assert.ok(l.triangles<=report.recipe.targets[l.level]);assert.match(l.ergonomicNormalization.nonPositionBinHash,/^[a-f0-9]{64}$/);}
  assert.equal(read(`assets/art/models/${owner}/game_ready/${report.levels[0].file}.meta.json`).guid,guid);
 }
 for(const scene of ['sandbox/weapon-assembly-trial','act1/floor-1','act1/floor-2','act1/floor-3']){
  const w=read(`assets/scenes/${scene}.scene.json`).nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules').arsenal.definitions.find(d=>d.id==='launcher');
  assert.deepEqual(w.presentation.assembly,def.presentation.assembly);assert.equal(w.presentation.lengthM,.675);
 }
});
test('新静态模型枪口四向与持久模拟marker一致，未重复yaw或将local点当actor点',()=>{
 const pose={...records.samples[0].pose,action:'idle',phase:0,recoil:{translation:[0,0,0],pitchDeg:0}};
 for(const yaw of [0,Math.PI/2,Math.PI,-Math.PI/2]){
  const actor=[0,Math.sin((Math.PI/2-yaw)/2),0,Math.cos((Math.PI/2-yaw)/2)],s=records.samples[0];
  const req=a.weaponModelProjection(def,pose,yaw,actor,sockets,{id:s.primary.controlId,socket:{contact:s.primary.contact}},{id:s.dependent.controlId,socket:{contact:s.dependent.contact}},grip).request;
  const root={position:a.rotateVec3(actor,req.target.position),rotation:a.quatMul(actor,req.target.rotation)},muzzle=a.composeSocket(root,sockets.muzzle),forward=a.rotateVec3(muzzle.rotation,[1,0,0]);
  assert.ok(Math.abs(forward[0]-Math.cos(yaw))<1e-7&&Math.abs(forward[2]-Math.sin(yaw))<1e-7);
  const marker=def.presentation.markers.muzzle.position,calibration=read('assets/art/calibration/weapon-assembly-trial.json').simulationCalibration;
  const source=[marker[0],marker[1]-calibration.referenceActorY+calibration.capsuleHalfM,marker[2]];
  const rotated=a.rotateVec3([0,-Math.sin(yaw/2),0,Math.cos(yaw/2)],source);
  assert.ok(distance(muzzle.position,rotated)<1e-7);
 }
});
