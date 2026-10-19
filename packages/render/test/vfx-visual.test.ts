import {it,expect} from 'vitest';
import {sampleVfxVisual} from '../src/vfx-visual';
it('flow curls continuously in simulation age, freezes without ticks and leaves original anchors/velocity intact',()=>{
 const p={key:'flow',seed:7,priority:1,position:[0,1,0] as const,velocity:[9,0,0] as const,age:.2,effect:{kind:'sprite' as const,texture:{path:'assets/a.svg',guid:'a'},frames:3,duration:.5,size:[.65,1.9] as [number,number],color:'#ffffff',blend:'alpha' as const,flow:{strength:.35,speed:2.3}}};
 const a=sampleVfxVisual(p);expect(sampleVfxVisual(p)).toEqual(a);expect(a.position[0]).toBeCloseTo(1.8);expect(a.position[2]).not.toBe(0);
 const b=sampleVfxVisual({...p,age:.2+1/30});expect(b.position).not.toEqual(a.position);expect(Math.abs(b.position[2]!-a.position[2]!)).toBeLessThan(.2);expect(p.position).toEqual([0,1,0]);expect(p.velocity).toEqual([9,0,0]);
});
it('size/color/alpha curves interpolate normalized lifetime and velocity without altering source facts',()=>{
 const p={key:'a',seed:0,priority:1,position:[1,2,3] as const,velocity:[2,0,0] as const,age:.5,effect:{kind:'sprite' as const,texture:{path:'assets/vfx/a.svg',guid:'a'},frames:1,duration:1,size:[1,1] as [number,number],color:'#ffffff',blend:'alpha' as const,sizeCurve:[{t:0,value:0},{t:1,value:2}],colorCurve:[{t:0,color:'#000000'},{t:1,color:'#ffffff'}],alphaCurve:[{t:0,value:1},{t:1,value:0}]}};
 const v=sampleVfxVisual(p);expect(v.position).toEqual([2,2,3]);expect(v.size).toBe(1);expect(v.color).toEqual([.5,.5,.5]);expect(v.alpha).toBe(.5);expect(p.position).toEqual([1,2,3]);expect(sampleVfxVisual({...p,effect:{...p.effect,color:'#000000'}}).color).toEqual([0,0,0]);
});
it('CPU compatibility retains acceleration with fixed-step semi-implicit displacement',()=>{const p={key:'a',seed:0,priority:1,position:[0,2,0] as const,velocity:[1,0,0] as const,age:.5,simulationStep:1/30,effect:{kind:'sprite' as const,texture:{path:'assets/a.svg',guid:'a'},frames:1,duration:1,size:[1,1] as [number,number],color:'#ffffff',blend:'alpha' as const,emission:{rate:30,maxParticles:32,speed:1,spreadDeg:0,acceleration:[0,-3,0] as [number,number,number]}}};expect(sampleVfxVisual(p).position).toEqual([.5,1.6,0]);});
