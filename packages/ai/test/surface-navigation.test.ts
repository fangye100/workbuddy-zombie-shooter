import {describe,it,expect} from 'vitest';
import {SurfaceNavigation,type NavigationSurface} from '../src/surface-navigation';
const options={cellSize:.5,maxSlopeDeg:40,maxStepM:.3,agentRadius:.3,agentHeight:1.8};
const floor=(id:string,x:number,y:number,width:number,z=-3,depth=6):NavigationSurface=>({id,origin:[x,y,z],u:[x+width,y,z],v:[x,y,z+depth]});
const ramp:NavigationSurface={id:'ramp',origin:[0,0,-3],u:[6,3,-3],v:[0,0,3]};
function bake(nav:SurfaceNavigation,x:number,y:number,z:number){expect(nav.requestGoal(x,y,z)).toBe(true);let n=0;while(nav.isPending&&n++<10000){nav.step(64);expect(nav.workLastStep).toBeLessThanOrEqual(64);}expect(nav.isPending).toBe(false);}
describe('三维地表导航',()=>{
  it('沿连续坡面上行/下行并保持脚底高度，不把终点高度一次性写入',()=>{
    const nav=new SurfaceNavigation([floor('low',-6,0,6),ramp,floor('high',6,3,6)],options);
    bake(nav,10,3,0);const p={x:-4,y:0,z:0,surface:-1},d={x:0,z:0};let slopes=0;
    for(let k=0;k<500;k++){
      expect(nav.direction(p.x,p.y,p.z,d)).toBe(true);const before={...p};
      expect(nav.move(p.x,p.y,p.z,p.x+d.x*.06,p.z+d.z*.06,.3,p)).toBe(true);
      expect(Math.abs(p.y-before.y)).toBeLessThan(.06);
      if(p.x>0&&p.x<6){expect(p.y).toBeCloseTo(p.x/2,5);slopes++;}
    }
    expect(p.x).toBeGreaterThan(9);expect(p.y).toBe(3);expect(slopes).toBeGreaterThan(50);
    bake(nav,-4,0,0);
    for(let k=0;k<500;k++){nav.direction(p.x,p.y,p.z,d);nav.move(p.x,p.y,p.z,p.x+d.x*.06,p.z+d.z*.06,.3,p);}
    expect(p.x).toBeLessThan(-3);expect(p.y).toBe(0);
  });
  it('同 XZ 叠层不自动连接；目标移动不会取消在途烘焙',()=>{
    const nav=new SurfaceNavigation([floor('lower',-4,0,8),floor('upper',-4,4,8)],options);bake(nav,0,4,0);
    expect(nav.direction(0,0,0,{x:0,z:0})).toBe(false);
    const p={x:0,y:0,z:0,surface:-1};nav.move(0,0,0,1,1,.3,p);expect(p.y).toBe(0);
    for(let k=0;k<1000;k++){nav.requestGoal(Math.sin(k)*2,4,0);nav.step(64);expect(nav.workLastStep).toBeLessThanOrEqual(64);}
    expect(nav.snapshot().version).toBeGreaterThan(2);
  });
  it('逐级楼梯连通，超高台阶、悬崖、陡坡和净空不足不穿越',()=>{
    const stairs=Array.from({length:10},(_,i)=>floor(`step${i}`,i,i*.2,1));
    const nav=new SurfaceNavigation(stairs,options);bake(nav,8.5,1.6,0);
    expect(nav.direction(.5,0,0,{x:0,z:0})).toBe(true);
    const p={x:.5,y:0,z:0,surface:-1};nav.move(.5,0,0,8.5,0,.3,p);expect(p.y).toBeCloseTo(1.6);
    const wall=new SurfaceNavigation([floor('a',-4,0,4),floor('b',0,1,4)],options);bake(wall,2,1,0);
    expect(wall.direction(-2,0,0,{x:0,z:0})).toBe(false);wall.move(-2,0,0,2,0,.3,p);expect(p.x).toBeLessThan(0);expect(p.y).toBe(0);
    nav.move(2.5,.4,0,2.5,10,.3,p);expect(p.z).toBeLessThanOrEqual(2.71);
    const steep=new SurfaceNavigation([{id:'steep',origin:[0,0,0],u:[2,6,0],v:[0,0,4]}],options);expect(steep.snapshot().rejectedSurfaces).toEqual(['steep']);
    const ceiling=new SurfaceNavigation([floor('f',-4,0,8)],options,[{minX:-.5,maxX:.5,minY:1,maxY:1.2,minZ:-3,maxZ:3}]);bake(ceiling,2,0,0);expect(ceiling.direction(-2,0,0,{x:0,z:0})).toBe(false);
  });
  it('拒绝超容量和非法参数，不把未支撑点当作已到达',()=>{
    expect(()=>new SurfaceNavigation([floor('huge',0,0,1000,0,1000)],options)).toThrow(/262144/);
    expect(()=>new SurfaceNavigation([], {...options,cellSize:0})).toThrow();
    const nav=new SurfaceNavigation([floor('f',-4,0,8)],options);expect(nav.requestGoal(0,3,0)).toBe(false);
  });
  it('支撑引用不豁免另一楼层顶棚；调用者修改输入不改变已建图的地表',()=>{
    const lower=floor('lower',-4,0,8),upper={...floor('upper',-4,1,8),supportCollider:'slab'};
    const cfg={...options},obstacle={id:'slab',minX:-4,maxX:4,minY:.8,maxY:1,minZ:-3,maxZ:3};
    const nav=new SurfaceNavigation([lower,upper],cfg,[obstacle]);bake(nav,0,1,0);
    const p={x:0,y:0,z:0,surface:-1};expect(nav.move(0,0,0,1,0,.3,p)).toBe(false);
    expect(nav.move(0,1,0,1,0,.3,p)).toBe(true);
    cfg.cellSize=100;obstacle.maxY=100;(upper.origin as number[])[1]=50;
    expect(nav.move(0,1,0,1,0,.3,p)).toBe(true);expect(p.y).toBe(1);expect(nav.options.cellSize).toBe(.5);
  });
});
