import {describe,expect,it} from 'vitest';
import type {SceneDocument} from '@aether/scene';
import {PlaySession} from '../../src/play-session';
const scenes=import.meta.glob('../../../../assets/scenes/{sandbox/weapon-assembly-trial,act1/floor-1}.scene.json',{eager:true,import:'default'});
const data=Object.values(import.meta.glob('../../../../assets/art/calibration/weapon-assembly-trial.json',{eager:true,import:'default'}))[0] as {simulationCalibration:{zeroRecoilActorMuzzle:Record<string,[number,number,number]>};holdSlots:Record<string,{position:[number,number,number]}>};
describe('模拟发射点与零recoil理想模型枪口四向校准',()=>{
 for(const [path,raw] of Object.entries(scenes))for(const weapon of ['pistol','shotgun','smg','sniper','chainsaw','flame','launcher'])it.each([0,Math.PI/2,Math.PI,-Math.PI/2])(`${path} ${weapon} yaw=%s`,yaw=>{
  const doc=structuredClone(raw) as SceneDocument,session=new PlaySession();expect(session.play(doc).ok).toBe(true);
  const runtime=session.runtime!,p=runtime.player()!,node=doc.nodes.find(n=>n.id===doc.playerStart)!;
  runtime.weapons.equippedId=weapon;runtime.setAim(p.x+10*Math.cos(yaw),p.z+10*Math.sin(yaw));runtime.setFire(true);runtime.step();runtime.setFire(false);
  const shot=runtime.lastShot!,m=data.simulationCalibration.zeroRecoilActorMuzzle[weapon]!,dx=Math.cos(yaw),dz=Math.sin(yaw);
  expect(shot.tick).toBe(runtime.tick-1);expect(runtime.weapons.poseIntent.recoil.pitchDeg).toBe(0);
  // 每个场景可独立校准 Hip 持握点，使用作者基准之外的位移，保留四向世界坐标校验。
  const slot=runtime.weapons.active.presentation.assembly!.holdSlot!,base=data.holdSlots[weapon]!.position;
  const delta=slot.position.map((v,i)=>v-base[i]!),mx=m[0]+delta[2]!,my=m[1]+delta[1]!,mz=m[2]-delta[0]!;
  const ideal=[p.x+dx*mx-dz*mz,my+node.transform.position[1],p.z+dz*mx+dx*mz];
  expect(Math.hypot(...shot.from.map((v,i)=>v-ideal[i]!))).toBeLessThan(1e-6);session.stop();
 });
});
