import { describe, expect, it } from 'vitest';
import { DiscCollisionWorld, discContactFraction, type DiscSolid } from '../src/disc-collision';
const bounds={minX:-10,minZ:-10,maxX:10,maxZ:10};
const box:DiscSolid={x:0,z:0,halfX:.05,halfZ:4,radius:0,shape:'box',enabled:true};
describe('连续圆盘静态碰撞',()=>{
  it('高速突扑在另一圆盘前停止，初始接触可以离开但不能继续深入',()=>{
    const f=discContactFraction(-4,0,4,0,.4,0,0,.35);
    expect(-4+8*f).toBeCloseTo(-.75,4);
    expect(discContactFraction(-.75,0,1,0,.4,0,0,.35)).toBe(0);
    expect(discContactFraction(-.75,0,-2,0,.4,0,0,.35)).toBe(1);
    expect(discContactFraction(-4,2,4,2,.4,0,0,.35)).toBe(1);
  });
  it('高速移动不能跨过薄墙，且沿墙滑动',()=>{
    const w=new DiscCollisionWorld(bounds,[box]),out={x:0,z:0};
    expect(w.move(-4,0,4,3,.3,out)).toBe(true);
    expect(out.x).toBeLessThanOrEqual(-.35);expect(out.z).toBeCloseTo(3,3);
    expect(w.canOccupy(out.x,out.z,.3)).toBe(true);
  });
  it('圆柱碰撞不使用大矩形替代，边界和完全重合起点显式修正',()=>{
    const w=new DiscCollisionWorld(bounds,[{...box,shape:'sphere',radius:1}]),out={x:0,z:0};
    expect(w.move(-4,0,4,0,.3,out)).toBe(true);expect(out.x).toBeLessThan(-1.29);
    expect(w.move(0,0,0,0,.3,out)).toBe(true);expect(w.canOccupy(out.x,out.z,.3)).toBe(true);
    expect(w.move(5,5,20,20,.3,out)).toBe(true);expect(out.x).toBeLessThanOrEqual(9.7);expect(out.z).toBeLessThanOrEqual(9.7);
    expect(w.canOccupy(NaN,0,.3)).toBe(false);
  });
  it('挤满的不可行位置返回失败，非法输入拒绝',()=>{
    const w=new DiscCollisionWorld(bounds,[{...box,halfX:10,halfZ:10}]),out={x:0,z:0};
    expect(w.move(0,0,1,1,.3,out)).toBe(false);expect(out).toEqual({x:0,z:0});
    expect(()=>w.move(0,0,NaN,0,.3,out)).toThrow();
    expect(()=>new DiscCollisionWorld({...bounds,maxX:-10},[])).toThrow();
  });
  it('沿远坐标墙面滑动并存回 Float32 时不会积累微穿透',()=>{
    const w=new DiscCollisionWorld({minX:0,minZ:-20,maxX:80,maxZ:20},[{...box,x:40,z:11,halfX:.25,halfZ:9}]),out={x:0,z:0};
    let x=Math.fround(40.59),z=12;
    for(let i=0;i<100;i++) {
      expect(w.move(x,z,x-.000009,z+.01,.34,out)).toBe(true);
      x=Math.fround(out.x);z=Math.fround(out.z);
      expect(w.canOccupy(x,z,.34)).toBe(true);
    }
  });
});
