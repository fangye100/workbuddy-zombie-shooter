import {describe,it,expect,vi} from 'vitest';import raw from '../../../assets/scenes/sandbox/procedural-decal-whitebox.scene.json';
import {RuntimeDecals} from '../src/services/runtime-decals';import {loadLevelRuntime,RuntimeSession} from '@aether/zombie-game';import type {SceneDocument} from '@aether/scene';import type {LabRenderer} from '../src/renderer';
import combatRaw from '../../../assets/scenes/sandbox/combat-decal-whitebox.scene.json';import {composeQuat} from '@aether/core';
describe('运行贴花宿主生命周期',()=>{
  it('真实命中与伤害经过可见几何适配器，静态作者隔离，隐藏接收物拒绝，clear不重放',()=>{
    const doc=structuredClone(combatRaw) as unknown as SceneDocument,before=JSON.stringify(doc);
    const object=(nodeId:string,positions:number[][],min:[number,number,number],max:[number,number,number],pos:[number,number,number])=>{
      const vertices=new Float32Array(positions.length*15);positions.forEach((p,i)=>vertices.set(p,i*15));const matrix=new Float32Array(16);composeQuat(matrix,...pos,[0,0,0,1],1);
      return {nodeId,pos,quat:[0,0,0,1],scale:1,visible:true,removed:false,background:false,modelMatrix:matrix,localMin:min,localMax:max,mesh:{vertices,indices:new Uint32Array([0,1,2,0,2,3])},subMeshes:[{visible:true,indexStart:0,indexCount:6}]};
    };
    const objects=[object('nd_combat_wall',[[-6,-1.5,.25],[6,-1.5,.25],[6,1.5,.25],[-6,1.5,.25]],[-6,-1.5,-.25],[6,1.5,.25],[0,1.5,-6]),object('nd_nav3d_low',[[-12,0,-9],[12,0,-9],[12,0,9],[-12,0,9]],[-12,0,-9],[12,0,9],[0,0,0])];
    const r={getDocument:()=>doc,state:{objects},setRuntimeDecals:vi.fn(),core:{clearDecalResources:vi.fn(),decalSnapshot:()=>({})}} as unknown as LabRenderer;
    const rt=new RuntimeSession({desc:loadLevelRuntime(doc).desc!,seed:7}),host=new RuntimeDecals(r);host.start(rt);rt.setAim(0,-20);rt.setFire(true);rt.step();rt.setFire(false);host.sync(rt);
    const bullet=host.snapshot().marks[0]!;expect(bullet.receiver).toBe('nd_combat_wall');expect(bullet.mark.position[2]).toBeCloseTo(.25);expect(bullet.mark.rotation[0]).toBeCloseTo(Math.SQRT1_2);
    const npc=rt.view().find(e=>e.kind==='npc')!;rt.applyDamage(npc.id,5,rt.player()!.id);host.sync(rt);expect(host.snapshot().marks.some(e=>e.mark.pattern==='splatter')).toBe(true);
    host.command('clear',rt.runId);host.sync(rt);expect(host.snapshot().count).toBe(0);
    objects[0]!.visible=false;rt.run(12);rt.setFire(true);rt.step();rt.setFire(false);host.sync(rt);expect(host.snapshot().combat.noSurface).toBe(1);expect(host.snapshot().count).toBe(0);
    expect(()=>host.command('emit',rt.runId,{receiver:'nd_nav3d_low',ttlSec:1,fadeSec:0,mark:{...bullet.mark,id:'combat_reserved'}})).toThrow('保留');
    host.stop();expect(JSON.stringify(doc)).toBe(before);
  });
  it('使用权威 tick；暂停/读诊断不推进、淡出到期、reset 拒绝旧 runId、Stop释放且不改作者',()=>{
    const doc=structuredClone(raw) as unknown as SceneDocument,before=JSON.stringify(doc),clear=vi.fn(),publish=vi.fn();
    const r={getDocument:()=>doc,setRuntimeDecals:publish,core:{clearDecalResources:clear,decalSnapshot:()=>({instances:12,drawCalls:1,bufferBytes:4096})}} as unknown as LabRenderer;
    const rt=new RuntimeSession({desc:loadLevelRuntime(doc).desc!,seed:1}),host=new RuntimeDecals(r);host.start(rt);const id=rt.player()!.runId;
    const c=doc.nodes.find(n=>n.id==='nd_nav3d_low')!.components.find(c=>c.kind==='Decal')!;if(c.kind!=='Decal')throw Error('fixture');
    const input={receiver:'nd_nav3d_low',mark:{...c.marks[0]!,id:'rt'},ttlSec:2,fadeSec:1};host.command('emit',id,input);
    rt.run(45);host.sync(rt);expect(host.snapshot().marks[0]!.mark.opacity).toBeCloseTo(.45);const s=host.snapshot();host.sync(rt);expect(host.snapshot()).toEqual(s);
    expect(()=>host.command('emit',id,{...input,receiver:'missing'})).toThrow();expect(host.snapshot()).toEqual(s);
    rt.run(20);host.sync(rt);expect(host.snapshot().count).toBe(0);host.command('clear',id);expect(host.snapshot().time).toBeCloseTo(rt.tick*rt.fixedStep);
    rt.reset();host.start(rt);expect(()=>host.command('emit',id,input)).toThrow('代次');host.stop();expect(clear).toHaveBeenCalledTimes(1);expect(host.snapshot().count).toBe(0);expect(host.snapshot().runId).toBeNull();expect(JSON.stringify(doc)).toBe(before);
  });
});
