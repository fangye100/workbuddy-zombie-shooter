import {it,expect} from 'vitest';
import {VfxPool,VfxEmitters,sampleVfxCurve} from '../src/index';
const effect={kind:'sprite' as const,texture:{path:'assets/vfx/a.svg',guid:'a'},frames:1,duration:1,size:[1,1] as [number,number],color:'#ffffff',blend:'alpha' as const,emission:{rate:30,maxParticles:64,speed:2,spreadDeg:20}};
it('fixed tick catchup and split updates reproduce seeds/births, pause does not emit, stop/restart reuses bounded handle',()=>{
 const a=new VfxEmitters(new VfxPool()),b=new VfxEmitters(new VfxPool()),anchor={position:[0,0,0] as const,direction:[1,0,0] as const};
 for(let t=0;t<=8;t++)a.update('x',effect,anchor,t,1/30,7,1,8);
 b.update('x',effect,anchor,0,1/30,7,1,8);b.update('x',effect,anchor,8,1/30,7,1,8);
 expect(a.pool.active).toEqual(b.pool.active);const count=a.stats.emitted;a.update('x',effect,anchor,8,1/30,7);expect(a.stats.emitted).toBe(count);
 a.stop('x');a.update('x',effect,anchor,10,1/30,7);expect(a.activeHandles).toHaveLength(1);expect(a.activeHandles[0]!.epoch).toBe(2);expect(a.stats.restarted).toBe(1);
});
it('per-emitter/handle/shared budgets remain bounded and recover after stop/expiry',()=>{
 const p=new VfxPool(2),e=new VfxEmitters(p,1),anchor={position:[0,0,0] as const};
 e.update('x',effect,anchor,0,1/30,0);e.update('x',effect,anchor,10,1/30,0);expect(p.active).toHaveLength(2);expect(e.stats.dropped).toBeGreaterThan(0);
 expect(e.update('y',effect,anchor,11,1/30,0)).toBe(false);expect(e.stats.handleOverflow).toBe(1);e.stop('x');p.advance(2);expect(e.update('y',effect,anchor,12,1/30,0)).toBe(true);expect(p.active).toHaveLength(1);
 expect(sampleVfxCurve([{t:0,value:0},{t:.5,value:2},{t:1,value:0}],.25)).toBe(1);
});

it('eviction then recreation of the same handle cannot collide with tail particles or bounded dedup history',()=>{
 const p=new VfxPool(20),e=new VfxEmitters(p,1),a={position:[0,0,0] as const};e.update('x',effect,a,0,1/30,7);const first=p.active[0]!.key;e.stop('x');e.update('y',effect,a,1,1/30,7);e.stop('y');expect(e.update('x',effect,a,2,1/30,7)).toBe(true);expect(p.active).toHaveLength(3);expect(p.active[2]!.key).not.toBe(first);
});
