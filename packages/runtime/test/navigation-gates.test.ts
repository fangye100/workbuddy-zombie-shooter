import {describe,it,expect} from 'vitest';
import {NavigationGates,gateOverlapsActor,type NavigationGateDesc} from '../src/navigation-gates';
import {nearestSolidHit} from '../src/solid-ray';
const gate:NavigationGateDesc={nodeId:'gate',world:new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,1.5,0,1]),shape:{type:'box',halfExtents:[.25,1.5,2]},bounds:{minX:-.25,maxX:.25,minY:0,maxY:3,minZ:-2,maxZ:2},openOffset:[0,4,0],travelSec:1,initialOpen:false};
describe('运动学门',()=>{
  it('可中途反向，弹道与连续姿态一致；reset 回作者初态且不修改输入',()=>{
    const before=structuredClone(gate),g=new NavigationGates([gate]);expect(nearestSolidHit([-2,1,0],[1,0,0],g.solids(),4)).toBeCloseTo(1.75);
    g.setOpen('gate',true);g.step(.5,()=>false);expect(g.snapshot()[0]!.progress).toBe(.5);expect(nearestSolidHit([-2,1,0],[1,0,0],g.solids(),4)).toBeNull();
    g.setOpen('gate',false);g.step(.25,()=>false);expect(g.snapshot()[0]!.progress).toBe(.25);g.reset();expect(g.snapshot()[0]!.state).toBe('closed');expect(gate).toEqual(before);
    expect(()=>g.setOpen('missing',true)).toThrow();expect(()=>g.step(NaN,()=>false)).toThrow();
  });
  it('关闭遇角色等待，角色离开后继续；同 XZ 异层不虚假阻挡',()=>{
    const g=new NavigationGates([{...gate,initialOpen:true}]),actor={x:0,y:0,z:0,radius:.3,height:2};g.setOpen('gate',false);
    for(let k=0;k<20;k++)g.step(.1,b=>gateOverlapsActor(b,actor));const s=g.snapshot()[0]!;
    expect(s.waiting).toBe(true);expect(s.bounds.minY).toBeGreaterThanOrEqual(1.99);
    for(let k=0;k<20;k++)g.step(.1,b=>gateOverlapsActor(b,{...actor,y:-5}));expect(g.snapshot()[0]!.state).toBe('closed');
    const copy=g.snapshot();copy[0]!.position[1]=99;copy[0]!.bounds.minY=99;expect(g.snapshot()[0]!.bounds.minY).toBe(0);
  });
});
