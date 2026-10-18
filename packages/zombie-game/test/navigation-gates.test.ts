import {describe,it,expect} from 'vitest';
import raw from '../../../assets/scenes/sandbox/dynamic-navigation-whitebox.scene.json';
import type {SceneDocument} from '@aether/scene';
import {loadLevelRuntime} from '../src/loader';
import {RuntimeSession} from '../src/session';
const fixture=()=>structuredClone(raw) as unknown as SceneDocument;
function session(){const doc=fixture(),r=loadLevelRuntime(doc);expect(r.diagnostics.filter(d=>d.severity==='error')).toEqual([]);const s=new RuntimeSession({desc:r.desc!,seed:7});s.table.health[s.playerEntityId]=s.table.maxHp[s.playerEntityId]=1e6;return s;}
describe('场景动态吊门闭环',()=>{
  it('贴门接触写回 Float32 后可后退、可开门，真实穿入仍阻止关门',()=>{
    const doc=fixture();for(const n of doc.nodes)for(const c of n.components){if(c.kind==='SpawnPoint')c.count=0;if(c.kind==='RoomVolume')c.clearRule='interact';}
    const s=new RuntimeSession({desc:loadLevelRuntime(doc).desc!,seed:7}),p=s.playerEntityId;
    // 连续碰撞截断到 x=3.4、坡面 y=1.7 后写回权威 Float32 表的同一站位。
    s.table.posX[p]=3.4;s.table.posY[p]=1.7;s.table.posZ[p]=0;
    const contact=s.table.posX[p]!;expect(contact+s.table.radius[p]!).toBeGreaterThan(3.75);
    s.setInput(-1,0);s.run(10);expect(s.table.posX[p]).toBeLessThan(contact-.1);
    s.table.posX[p]=3.4;s.table.posY[p]=1.7;s.setInput(0,0);s.setGateOpen('nd_gate_ramp',true);s.run(50);
    expect(s.gateSnapshot()[0]!.state).toBe('open');
    s.setInput(1,0);s.run(20);expect(s.table.posX[p]).toBeGreaterThan(4.25);s.setInput(0,0);
    s.table.posX[p]=4;s.table.posY[p]=2;s.setGateOpen('nd_gate_ramp',false);s.run(60);
    expect(s.gateSnapshot()[0]!.waiting).toBe(true);
    s.table.posX[p]=2;s.table.posY[p]=1;s.run(60);expect(s.gateSnapshot()[0]!.state).toBe('closed');
  });
  it('门从静态底图与静态弹道集合抽离，局部偏移随节点旋转缩放；作者数据不变',()=>{
    const doc=fixture(),n=doc.nodes.find(n=>n.id==='nd_gate_ramp')!;n.transform.rotation=[0,0,Math.sin(Math.PI/4),Math.cos(Math.PI/4)];n.transform.scale=[1,2,1];
    const before=structuredClone(doc),r=loadLevelRuntime(doc);expect(r.desc!.navigationGates?.length).toBe(2);
    expect(r.desc!.navigationGates![0]!.openOffset[0]).toBeCloseTo(-8);expect(r.desc!.obstacles.some(o=>o.nodeId===n.id)).toBe(false);expect(r.desc!.shotColliders.some(o=>o.nodeId===n.id)).toBe(false);expect(doc).toEqual(before);
  });
  it('斜坡门关闭时 NPC 沿楼梯绕行，脚底保持真实高度',()=>{
    const s=session();let staircase=false;
    for(let k=0;k<700;k++){s.step();for(const e of s.view())if(e.sourceNodeId==='nd_nav3d_spawn_ramp'&&e.x>0&&e.x<8&&e.z>4&&(e.y??0)>0)staircase=true;}
    expect(staircase).toBe(true);expect(s.gateSnapshot()[0]!.state).toBe('closed');
    expect(s.view().filter(e=>e.sourceNodeId==='nd_nav3d_spawn_ramp'&&e.x>8&&(e.y??0)>3.9).length).toBeGreaterThan(0);
  });
  it('两路关门无路等待；开门途中不穿透，完成后恢复坡道，reset 恢复两门初态',()=>{
    const s=session();s.setGateOpen('nd_gate_stairs',false);s.run(160);
    expect(s.gateSnapshot().every(g=>g.state==='closed')).toBe(true);
    expect(s.view().filter(e=>e.kind==='npc').every(e=>e.x<4||e.sourceNodeId==='nd_nav3d_spawn_under'||e.sourceNodeId==='nd_nav3d_spawn_island')).toBe(true);
    expect(s.navigationSnapshot().crowd.unreachableAgents).toBeGreaterThanOrEqual(8);
    s.setGateOpen('nd_gate_ramp',true);s.run(20);
    expect(s.gateSnapshot()[0]!.state).toBe('opening');expect(s.view().filter(e=>e.sourceNodeId==='nd_nav3d_spawn_ramp').every(e=>e.x<4)).toBe(true);
    s.run(720);expect(s.gateSnapshot()[0]!.state).toBe('open');expect(s.view().filter(e=>(e.sourceNodeId==='nd_nav3d_spawn_ramp'||e.sourceNodeId==='nd_nav3d_spawn_stairs')&&e.x>8&&(e.y??0)>3.9)).toHaveLength(8);
    s.reset();expect(s.gateSnapshot().map(g=>g.state)).toEqual(['closed','open']);expect(()=>s.setGateOpen('missing',true)).toThrow();
  });
});
