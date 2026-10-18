import {describe,it,expect} from 'vitest';
import {loadLevelRuntime} from '../src/loader';
import {RuntimeSession} from '../src/session';
import type {SceneDocument} from '@aether/scene';
const files=import.meta.glob('../../../assets/scenes/sandbox/navigation-3d-whitebox.scene.json',{eager:true,import:'default'}) as Record<string,SceneDocument>;
function make(){const doc=structuredClone(Object.values(files)[0]!);const loaded=loadLevelRuntime(doc);if(!loaded.desc)throw Error(JSON.stringify(loaded.diagnostics));return new RuntimeSession({desc:loaded.desc,capacity:512,seed:7});}
describe('白盒场景的三维游戏闭环',()=>{
  it('整波多个刷怪点中后一个预检失败，不产生半波、幽灵槽位或重复第一批',()=>{
    const loaded=loadLevelRuntime(structuredClone(Object.values(files)[0]!)),desc=loaded.desc!;
    desc.rooms[0]={...desc.rooms[0]!,minX:-6,maxX:0,minY:-.5,maxY:1};
    desc.spawns=[{...desc.spawns[0]!,x:-4,y:0,z:-1,radius:.1,count:5},{...desc.spawns[1]!,x:-3,y:0,z:1,radius:2000,count:5}];
    const s=new RuntimeSession({desc,capacity:64,seed:7}),p=s.playerEntityId;
    s.table.posX[p]=-3;s.table.posY[p]=0;s.table.posZ[p]=0;
    s.step();s.step();expect(s.countNpc()).toBe(0);expect(s.view()).toHaveLength(1);expect(s.tick).toBe(2);
    expect(s.diagnostics().some(d=>d.code==='W_SPAWN_NAVIGATION')).toBe(true);
    expect(s.sessionEvents.filter(e=>e.type==='wave-start')).toHaveLength(0);
  });
  it('包含玩家的高度/半径预检；调试散布失败整批不改实体表',()=>{
    for(const key of ['agentHeight','agentRadius'] as const){
      const doc=structuredClone(Object.values(files)[0]!);
      for(const n of doc.nodes)for(const c of n.components){if(c.kind==='SpawnPoint')c.count=0;if(c.kind==='NavZone')c.surface![key]=key==='agentHeight'?1.7:.2;}
      const loaded=loadLevelRuntime(doc);expect(loaded.desc).not.toBeNull();
      expect(()=>new RuntimeSession({desc:loaded.desc!,seed:7})).toThrow(/角色/);
    }
    const s=make(),before=s.view();
    expect(()=>s.debugSpawn('E-01',-3,0,17,2000,0)).toThrow(/安全上限/);
    expect(s.view()).toEqual(before);
    expect(()=>s.debugSpawn('E-01',NaN,0,1)).toThrow(/非法/);expect(s.view()).toEqual(before);
    expect(s.debugSpawn('E-01',-3,0,1,.1,0)).toBe(1);
  });
  it('房间交互的高度筛选与三维房间进入一致',()=>{
    const s=make(),room={...s.desc.rooms[0]!,minY:-.5,maxY:1};
    expect(s.insideRoom(room,s.player()!)).toBe(false);
    expect(s.insideRoom(room,{...s.player()!,y:0})).toBe(true);
  });
  it('从实际场景派生高度，坡道和楼梯追击组到达高台，叠层和孤岛保持不可达',()=>{
    const s=make();expect(s.countNpc()).toBe(12);expect(s.player()?.y).toBe(4);
    const initial=s.view().filter(e=>e.kind==='npc');const start=new Map(initial.map(e=>[e.id,{...e}]));let onRamp=0,onStairs=0;
    for(let k=0;k<600;k++){
      s.step();
      for(const e of s.view().filter(e=>e.kind==='npc')){
        const before=start.get(e.id)!;
        if(e.sourceNodeId==='nd_nav3d_spawn_under'||e.sourceNodeId==='nd_nav3d_spawn_island'){
          expect(e.y).toBe(before.y);expect(Math.abs(e.x-before.x)).toBeLessThan(1);expect(Math.abs(e.z-before.z)).toBeLessThan(1);
        }
        if(e.x>0&&e.x<8&&e.z<3.6){expect(e.y).toBeCloseTo(e.x/2,4);onRamp++;}
        if(e.x>0&&e.x<8&&e.z>4.35){expect(e.y).toBeCloseTo(Math.floor(e.x/.5)*.25,4);onStairs++;}
      }
    }
    expect(onRamp).toBeGreaterThan(30);expect(onStairs).toBeGreaterThan(30);
    const climbers=s.view().filter(e=>e.kind==='npc'&&e.sourceNodeId!== 'nd_nav3d_spawn_under'&&e.sourceNodeId!=='nd_nav3d_spawn_island');
    expect(climbers.every(e=>e.x>=8&&e.y===4)).toBe(true);
    expect(s.navigationSnapshot().crowd.unreachableAgents).toBe(4);
    s.reset();expect(s.player()?.y).toBe(4);expect(s.tick).toBe(0);
  });
  it('玩家下坡和反向追击保留高度；不可从台边瞬移到正下方楼层',()=>{
    const s=make();
    // 先让玩家绕开本场景追击组，再走坡面中心线。
    s.setInput(-1,0);for(let k=0;k<120;k++)s.step();s.setInput(0,0);
    const p=s.player()!;expect(p.x).toBeLessThan(8);expect(p.y).toBeCloseTo(Math.max(0,p.x/2),4);
    s.setInput(0,-1);for(let k=0;k<180;k++)s.step();
    const edge=s.player()!;expect(edge.z).toBeGreaterThanOrEqual(-3.7);expect(edge.y).toBeGreaterThanOrEqual(0);
  });
  it('同 XZ 不同楼层不触发近战，也不能被同高度平射或区域武器穿层伤害',()=>{
    const s=make(),t=s.table,p=s.playerEntityId,n=s.view().find(e=>e.sourceNodeId==='nd_nav3d_spawn_under')!;
    t.posX[n.id]=t.posX[p]!;t.posZ[n.id]=t.posZ[p]!;t.posY[n.id]=0;
    for(let k=0;k<60;k++)s.step();expect(t.behavior[n.id]).not.toBe(2);expect(t.health[p]).toBe(t.maxHp[p]);
    const hp=t.health[n.id];s.setAim(t.posX[p]!+5,t.posZ[p]!);s.setFire(true);for(let k=0;k<20;k++)s.step();expect(t.health[n.id]).toBe(hp);
  });
});
