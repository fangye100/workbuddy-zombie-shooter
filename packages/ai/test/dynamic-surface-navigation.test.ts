import {describe,it,expect} from 'vitest';
import {SurfaceNavigation,type NavigationSurface} from '../src/surface-navigation';
const options={cellSize:.5,maxSlopeDeg:40,maxStepM:.3,agentRadius:.3,agentHeight:2};
const floor:NavigationSurface={id:'floor',origin:[-6,0,-3],u:[6,0,-3],v:[-6,0,3]};
const door={id:'gate',minX:-.25,maxX:.25,minY:0,maxY:3,minZ:-3,maxZ:3};
function finish(nav:SurfaceNavigation){let n=0;while(nav.isPending&&n++<10000){nav.step(32);expect(nav.workLastStep).toBeLessThanOrEqual(32);}expect(nav.isPending).toBe(false);}
describe('动态障碍 overlay',()=>{
  it('超大或远处障碍只检查已有图格，不遍历无限空白世界',()=>{
    const nav=new SurfaceNavigation([floor],options);nav.requestGoal(4,0,0);finish(nav);
    nav.setDynamicObstacles([{...door,minX:1e20,maxX:2e20,minZ:1e20,maxZ:2e20}]);expect(nav.snapshot().overlayWork).toBe(0);
    nav.setDynamicObstacles([{...door,minX:-1e20,maxX:1e20,minZ:-1e20,maxZ:1e20}]);finish(nav);expect(nav.direction(-4,0,0,{x:0,z:0})).toBe(false);
    expect(nav.snapshot().overlayWork).toBeLessThan(nav.snapshot().cellCount*20);
  });
  it('关闭立即使旧路线失效，预算重算后无路等待；打开恢复同目标路线且不重建底图',()=>{
    const nav=new SurfaceNavigation([floor],options);nav.requestGoal(4,0,0);finish(nav);const count=nav.snapshot().cellCount;
    expect(nav.direction(-4,0,0,{x:0,z:0})).toBe(true);
    nav.setDynamicObstacles([door]);expect(nav.direction(-4,0,0,{x:0,z:0})).toBe(false);finish(nav);
    expect(nav.direction(-4,0,0,{x:0,z:0})).toBe(false);
    const p={x:0,y:0,z:0,surface:-1};nav.move(-2,0,0,2,0,.3,p);expect(p.x).toBeLessThan(-.5);
    nav.setDynamicObstacles([]);finish(nav);expect(nav.direction(-4,0,0,{x:0,z:0})).toBe(true);expect(nav.snapshot().cellCount).toBe(count);
  });
  it('短门自动绕行；连续门姿态只在可达拓扑变化时重新计算目标场',()=>{
    const nav=new SurfaceNavigation([floor],options);nav.requestGoal(4,0,0);finish(nav);
    nav.setDynamicObstacles([{...door,minZ:-1,maxZ:1}]);finish(nav);
    const version=nav.snapshot().version;nav.setDynamicObstacles([{...door,minZ:-1,maxZ:1,minY:.1,maxY:3.1}]);expect(nav.isPending).toBe(false);expect(nav.snapshot().version).toBe(version);
    const p={x:-4,y:0,z:0,surface:-1},d={x:0,z:0};let detour=0;
    for(let k=0;k<400;k++){expect(nav.direction(p.x,p.y,p.z,d)).toBe(true);nav.move(p.x,p.y,p.z,p.x+d.x*.04,p.z+d.z*.04,.3,p);detour=Math.max(detour,Math.abs(p.z));}
    expect(p.x).toBeGreaterThan(3);expect(detour).toBeGreaterThan(1.3);
  });
  it('抬起途中按真实高度判断净空，同 XZ 上层不受下层门影响；拒绝错误输入且快照隔离',()=>{
    const nav=new SurfaceNavigation([floor,{...floor,id:'upper',origin:[-6,5,-3],u:[6,5,-3],v:[-6,5,3]}],options);
    nav.requestGoal(4,5,0);finish(nav);nav.setDynamicObstacles([door]);finish(nav);expect(nav.direction(-4,5,0,{x:0,z:0})).toBe(true);
    const p={x:0,y:0,z:0,surface:-1};nav.setDynamicObstacles([{...door,minY:1,maxY:4}]);nav.move(-2,0,0,2,0,.3,p);expect(p.x).toBeLessThan(0);
    nav.setDynamicObstacles([{...door,minY:2.1,maxY:5.1}]);nav.move(-2,0,0,2,0,.3,p);expect(p.x).toBe(2);
    const snapshot=nav.snapshot();expect(()=>nav.setDynamicObstacles([{...door,maxY:NaN}])).toThrow();expect(nav.snapshot()).toEqual(snapshot);
    nav.setDynamicObstacles([door]);door.minY=100;nav.move(-2,0,0,2,0,.3,p);expect(p.x).toBeLessThan(0);door.minY=0;
  });
});
