import { describe, expect, it, vi } from 'vitest';
import { CharacterTable } from '@aether/gameplay';
import { defaultNavigationSettings } from '@aether/scene';
import { ZombieCrowdNavigation, type ZombieNavigationPolicy } from '../src/crowd-navigation';
const nav={nodeId:'nd_nav',minX:-10,minZ:-10,maxX:10,maxZ:10,cellSize:.5,crowd:defaultNavigationSettings()};
const policy:ZombieNavigationPolicy={movable:()=>true,speed:()=>2,arrivalRange:()=>1.2,height:()=>2};
function world() {
  const t=new CharacterTable(16),player=t.spawn(0);t.radius[player]=.3;t.posX[player]=0;
  const npc=t.spawn(1);t.radius[npc]=.3;t.posX[npc]=4;
  return {t,player,npc,n:new ZombieCrowdNavigation(nav,[],16,0,0)};
}
describe('僵尸游戏导航策略适配',()=>{
  it('外部位移不能穿过玩家或站定 NPC，连续多次突扑仍保持圆盘间隔',()=>{
    const {t,player,npc,n}=world();
    for(let k=0;k<30;k++) {
      const [x,z]=n.moveActor(t,npc,-4,0);t.posX[npc]=x;t.posZ[npc]=z;
      expect(t.posX[npc]).toBeGreaterThanOrEqual(.62);
    }
    expect(n.snapshot().crowd.externalBlockedMoves).toBeGreaterThan(0);
    const [px]=n.moveActor(t,player,4,0);expect(px).toBeLessThan(.001);
    n.reset(0,0);expect(n.snapshot().crowd.externalBlockedMoves).toBe(0);
  });
  it('追击接近攻击距离，而不是叠到玩家中心；观察不推进状态',()=>{
    const {t,player,npc,n}=world();
    for(let i=0;i<180;i++)n.step(t,player,1/30,i/30,policy);
    expect(Math.hypot(t.posX[npc]!,t.posZ[npc]!)).toBeGreaterThan(.62);
    expect(Math.hypot(t.posX[npc]!,t.posZ[npc]!)).toBeLessThan(1.2);
    const position=[...t.posX],version=n.snapshot().flow.version;
    const copy=n.snapshot();copy.settings.maxNeighbors=32;copy.crowd.agents=999;
    expect(n.snapshot().settings.maxNeighbors).toBe(12);expect(n.snapshot().crowd.agents).toBe(2);
    expect([...t.posX]).toEqual(position);expect(n.snapshot().flow.version).toBe(version);
  });
  it('玩家移动时按预算完成流场；站定 NPC 仍参与观察，Reset 清掉解堵历史',()=>{
    const {t,player,npc,n}=world();
    for(let i=0;i<30;i++) {
      t.posX[player]=Math.sin(i*.2)*2;
      n.step(t,player,1/30,i/30,{...policy,movable:()=>false});
      expect(n.snapshot().flow.workLastStep).toBeLessThanOrEqual(nav.crowd.flowCellBudget);
    }
    expect(t.posX[npc]).toBe(4);expect(n.snapshot().flow.version).toBeGreaterThan(1);
    expect(n.snapshot().crowd.agents).toBe(2);expect(n.snapshot().crowd.moving).toBe(0);
    n.reset(0,0);expect(n.snapshot().crowd.stuckAgents).toBe(0);expect(n.snapshot().flow.pending).toBe(false);
  });
  it('密封不可达区等待，不直线穿墙；特殊移动使用同一连续碰撞',()=>{
    const walls=[{nodeId:'nd_wall',name:'墙',x:0,z:0,halfX:.05,halfZ:10,radius:0,shape:'box' as const,enabled:true}];
    const n=new ZombieCrowdNavigation(nav,walls,16,-3,0),t=new CharacterTable(16),p=t.spawn(0),npc=t.spawn(1);
    t.posX[p]=-3;t.posX[npc]=3;t.radius[p]=.3;t.radius[npc]=.3;
    for(let i=0;i<60;i++)n.step(t,p,1/30,i/30,policy);
    expect(t.posX[npc]).toBe(3);expect(n.snapshot().crowd.unreachableAgents).toBe(1);
    expect(n.move(3,0,-3,0,.3)[0]).toBeGreaterThanOrEqual(.35);
    expect(()=>new ZombieCrowdNavigation({...nav,cellSize:.00001},[],16,-3,0)).toThrow();
  });
  it('持续阻挡触发有期限的侧让，不接管站定攻击状态；零速度不误报',()=>{
    const {t,player,npc,n}=world();
    const blocked=vi.spyOn(n.world,'move').mockReturnValue(false);
    for(let i=0;i<20;i++)n.step(t,player,1/30,i/30,policy);
    expect(n.snapshot().crowd.yieldingAgents).toBe(1);
    n.step(t,player,1/30,20/30,{...policy,movable:()=>false});
    expect(n.snapshot().crowd.yieldingAgents).toBe(0);expect(t.posX[npc]).toBe(4);
    blocked.mockRestore();n.reset(0,0);
    const stopped={...policy,speed:()=>0};
    for(let i=0;i<60;i++)n.step(t,player,1/30,i/30,stopped);
    // 期望速度为零时不误报拥堵。
    expect(n.snapshot().crowd.stuckAgents).toBe(0);
  });
});
