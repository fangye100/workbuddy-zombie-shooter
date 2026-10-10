import { describe, expect, it } from 'vitest';
import { createAvoidanceBuffers, PredictiveCrowdSolver, type AvoidanceOptions } from '../src/crowd-avoidance';
import { FlowField, FlowFieldIntegrator, SpatialHash, UNREACHABLE } from '../src/navigation';
const options:AvoidanceOptions={maxNeighbors:12,timeHorizonSec:1,skinM:.02,acceleration:100,collisionIterations:6,stuckWindowSec:.2,stuckProgressRatio:.2};
function setup(count=2) {
  const b=createAvoidanceBuffers(count),s=new PredictiveCrowdSolver(-20,-20,20,20,1,count);b.count=count;
  for(let i=0;i<count;i++){b.ids[i]=i;b.generation[i]=1;b.radius[i]=.3;b.maxSpeed[i]=2;b.movable[i]=1;b.maxY[i]=2;}
  return {b,s};
}
describe('预测避让与群体接触',()=>{
  it('相距大于旧九宫格范围时提前让步，而非碰撞后推开',()=>{
    const {b,s}=setup();b.x[0]=-2;b.x[1]=2;b.vx[0]=2;b.vx[1]=-2;b.preferredX[0]=2;b.preferredX[1]=-2;
    s.solve(b,options,1/30);
    expect(s.snapshot().velocityConstraints).toBe(2);
    expect(Math.hypot(b.outX[0]!-2,b.outZ[0]!)).toBeGreaterThan(.01);
    expect(Math.hypot(b.nextX[0]!-b.nextX[1]!,b.nextZ[0]!-b.nextZ[1]!)).toBeGreaterThan(.62);
  });
  it('不移动的角色仍占位，避让承担全部责任',()=>{
    const {b,s}=setup();b.x[0]=-.5;b.movable[1]=0;b.preferredX[0]=2;b.vx[0]=2;
    s.solve(b,options,1/30);
    expect(b.nextX[1]).toBe(0);expect(b.nextZ[1]).toBe(0);
    expect(Math.hypot(b.nextX[0]!,b.nextZ[0]!)).toBeGreaterThanOrEqual(.619);
    expect(s.snapshot().moving).toBe(1);
  });
  it('完全重合确定性分开，速度有限，按高度/层过滤',()=>{
    const a=setup(),c=setup();
    a.s.solve(a.b,options,1/30);c.s.solve(c.b,options,1/30);
    expect(Array.from(a.b.nextX)).toEqual(Array.from(c.b.nextX));
    expect(Math.hypot(a.b.nextX[0]!-a.b.nextX[1]!,a.b.nextZ[0]!-a.b.nextZ[1]!)).toBeGreaterThan(.619);
    expect(Math.hypot(a.b.outX[0]!,a.b.outZ[0]!)).toBeLessThanOrEqual(2.00001);
    const d=setup();d.b.minY[1]=3;d.b.maxY[1]=5;d.s.solve(d.b,options,1/30);
    expect(d.s.snapshot().velocityConstraints).toBe(0);expect(d.s.snapshot().residualOverlapPairs).toBe(0);
  });
  it('邻居按最近距离排序，不依赖桶内首批枚举',()=>{
    const {b,s}=setup(4);b.x[0]=0;b.x[1]=2.5;b.x[2]=.5;b.x[3]=3;b.movable.fill(0);b.movable[0]=1;b.preferredX[0]=2;
    s.solve(b,{...options,maxNeighbors:1},1/30);
    expect(b.outX[0]).toBeLessThanOrEqual(0);
  });
  it('稳定身份的停滞历史不随打包下标变化，槽位复用清空历史',()=>{
    const {b,s}=setup();b.x[0]=-2;b.x[1]=2;b.preferredX.fill(1);
    const blocked={move:()=>false};s.solve(b,options,.1,blocked);
    // 同一实体改为只装在 packed[0]；另一个实体死亡。
    b.count=1;b.ids[0]=1;b.x[0]=2;s.solve(b,options,.1,blocked);s.solve(b,options,.1,blocked);
    expect(b.stuck[0]).toBe(1);
    b.generation[0]=2;s.solve(b,options,.1,blocked);expect(b.stuck[0]).toBe(0);
    s.reset();s.solve(b,options,.1,blocked);expect(b.stuck[0]).toBe(0);
  });
  it('容量和非法数据不静默截断',()=>{
    const {b,s}=setup();b.count=3;expect(()=>s.solve(b,options,.1)).toThrow();
    b.count=2;b.x[0]=NaN;expect(()=>s.solve(b,options,.1)).toThrow();
    b.x[0]=0;b.ids[1]=0;expect(()=>s.solve(b,options,.1)).toThrow('Duplicate crowd identity');
    const h=new SpatialHash(-5,-5,5,5,1,2);h.build(new Float32Array(2),new Float32Array(2),2);
    expect(()=>h.queryRange(0,0,1,new Int32Array(1))).toThrow();
  });
  it('环形桶剪枝与穷举最近邻一致，包括边界和等距稳定排序',()=>{
    const n=64,h=new SpatialHash(-8,-8,8,8,1,n),x=new Float32Array(n),z=new Float32Array(n),ids=new Int32Array(n);
    for(let i=0;i<n;i++){x[i]=((i*37)%157)/10-7.8;z[i]=((i*53)%157)/10-7.8;ids[i]=n-i;}
    h.build(x,z,n);
    const out=new Int32Array(12),distances=new Float64Array(12);
    for(let i=0;i<n;i++) {
      const count=h.queryNearest(x[i]!,z[i]!,5,12,out,distances,x,z,ids,j=>j!==i);
      const expected=Array.from({length:n},(_,j)=>j).filter(j=>j!==i&&(x[j]!-x[i]!)**2+(z[j]!-z[i]!)**2<=25)
        .sort((a,b)=>((x[a]!-x[i]!)**2+(z[a]!-z[i]!)**2)-((x[b]!-x[i]!)**2+(z[b]!-z[i]!)**2)||ids[a]!-ids[b]!).slice(0,12);
      expect(Array.from(out.slice(0,count))).toEqual(expected);
    }
  });
});
describe('分帧流场',()=>{
  it('积分和流向构建共用预算，完成前旧场保持原子可读',()=>{
    const f=new FlowField({width:16,height:16,cellSize:1,originX:0,originZ:0}),s=new FlowFieldIntegrator(f);
    expect(s.step(7)).toBe(false);expect(s.setGoal(.5,.5)).toBe(true);
    while(s.isPending){s.step(7);expect(s.workLastStep).toBeLessThanOrEqual(7);}
    expect(f.version).toBe(1);const old=Array.from(f.integration),x=Array.from(f.flowX);
    s.setGoal(15.5,15.5);s.step(7);expect(Array.from(f.integration)).toEqual(old);expect(Array.from(f.flowX)).toEqual(x);
    while(s.isPending)s.step(7);expect(f.version).toBe(2);expect(f.integration[255]).toBe(0);
  });
  it('持续变化的目标不取消当前工作，不允许穿越对角墙角',()=>{
    const f=new FlowField({width:4,height:4,cellSize:1,originX:0,originZ:0}),s=new FlowFieldIntegrator(f);
    f.setBlocked(1,0,true);f.setBlocked(0,1,true);s.setGoal(.5,.5);
    for(let i=0;i<40;i++){s.step(2);s.setGoal(i%2?3.5:2.5,3.5);}
    expect(f.version).toBeGreaterThan(0);
    while(s.isPending)s.step(2);
    expect(f.integration[0]).toBe(UNREACHABLE);
    expect(s.setGoal(NaN,0)).toBe(false);expect(()=>s.step(0)).toThrow();
  });
});
