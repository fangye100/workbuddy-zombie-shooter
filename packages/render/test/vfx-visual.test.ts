import {it,expect} from 'vitest';
import {sampleVfxVisual} from '../src/vfx-visual';
it('size/color/alpha curves interpolate normalized lifetime and velocity without altering source facts',()=>{
 const p={key:'a',seed:0,priority:1,position:[1,2,3] as const,velocity:[2,0,0] as const,age:.5,effect:{kind:'sprite' as const,texture:{path:'assets/vfx/a.svg',guid:'a'},frames:1,duration:1,size:[1,1] as [number,number],color:'#ffffff',blend:'alpha' as const,sizeCurve:[{t:0,value:0},{t:1,value:2}],colorCurve:[{t:0,color:'#000000'},{t:1,color:'#ffffff'}],alphaCurve:[{t:0,value:1},{t:1,value:0}]}};
 const v=sampleVfxVisual(p);expect(v.position).toEqual([2,2,3]);expect(v.size).toBe(1);expect(v.color).toEqual([.5,.5,.5]);expect(v.alpha).toBe(.5);expect(p.position).toEqual([1,2,3]);
});
