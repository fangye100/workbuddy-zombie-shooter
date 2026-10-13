import {describe,it,expect} from 'vitest';
import {DecalPool,packDecalMark,DecalFrameBuilder,DECAL_INSTANCE_FLOATS} from '../src/decal-instances';
import {mat4,composeQuat} from '@aether/core';
import {type DecalMark,createEmptySceneDocument,DEFAULT_DECAL_STYLE,DECAL_PATTERNS} from '@aether/scene';
const mark:DecalMark={id:'m',pattern:'splatter',position:[0,0,0],rotation:[0,0,0,1],size:[2,4],color:'#ff0000',opacity:1,seed:7,normalOffset:.01,priority:0};
describe('程序贴花实例与运行池',()=>{
  it('斜面/墙面法线及非均匀缩放保持米制偏移，颜色在 HDR 线性空间；退化拒绝',()=>{
    const out=new Float32Array(DECAL_INSTANCE_FLOATS),world=mat4();composeQuat(world,2,3,4,[Math.SQRT1_2,0,0,Math.SQRT1_2],2);
    world[0]!*=1.5;world[1]!*=1.5;world[2]!*=1.5;
    packDecalMark(out,0,mark,world);expect(out[0]).toBe(2);expect(out[1]).toBe(3);expect(out[2]).toBeCloseTo(4.01);expect(out[4]).toBe(3);expect(out[9]).toBeCloseTo(-4);expect(out[12]).toBe(1);
    composeQuat(world,0,0,0,[0,0,Math.sin(Math.PI/12),Math.cos(Math.PI/12)],1);packDecalMark(out,0,mark,world);expect(out[0]).toBeCloseTo(-.005);expect(out[1]).toBeCloseTo(Math.sqrt(3)*.005);
    world.fill(0);expect(()=>packDecalMark(out,0,mark,world)).toThrow('退化');
  });
  it('有界溢出、复制隔离、重复与非法输入原子拒绝、模拟暂停/淡出/到期与清空',()=>{
    const pool=new DecalPool(2),input={receiver:'floor',mark:structuredClone(mark),ttlSec:2,fadeSec:1};pool.emit(input);input.mark.color='#ffffff';expect(pool.snapshot().marks[0]!.mark.color).toBe('#ff0000');
    expect(()=>pool.emit(input)).toThrow('已存在');expect(()=>pool.emit({...input,ttlSec:NaN})).toThrow();expect(pool.snapshot().count).toBe(1);
    pool.advance(1.5);const s=pool.snapshot();expect(s.marks[0]!.mark.opacity).toBe(.5);pool.advance(1.5);expect(pool.snapshot()).toEqual(s);s.marks[0]!.mark.opacity=0;expect(pool.snapshot().marks[0]!.mark.opacity).toBe(.5);
    pool.emit({...input,mark:{...mark,id:'b'}});pool.emit({...input,mark:{...mark,id:'c'}});expect(pool.snapshot().evicted).toBe(1);expect(pool.snapshot().marks.map(m=>m.mark.id)).toEqual(['b','c']);
    expect(()=>pool.advance(1)).toThrow();pool.advance(4);expect(pool.snapshot().count).toBe(0);pool.clear();expect(pool.snapshot().time).toBe(0);
  });
  it('作者和运行痕迹稳定透明排序，隐藏/缺失接收者不画，不占静态节点数',()=>{
    const doc=createEmptySceneDocument('decal'),p=new DecalPool();p.emit({receiver:'f',mark:{...mark,id:'rt',priority:2},ttlSec:3,fadeSec:1});
    doc.nodes.push({id:'f',name:'f',parent:null,transform:{position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]},visible:true,pickable:true,prefab:null,components:[{kind:'Decal',enabled:true,marks:[{...mark,seed:9}]}]});
    const b=new DecalFrameBuilder(),world=mat4();const data=b.build(doc,()=>world,p.snapshot(),[0,5,10]);expect(data).toHaveLength(DECAL_INSTANCE_FLOATS*2);expect(data[7]).toBe(9);expect(data[DECAL_INSTANCE_FLOATS+7]).toBe(7);expect(b.build(doc,()=>null,p.snapshot(),[0,5,10])).toHaveLength(0);
  });
  it('九类稳定索引与80字节打包，缺省形态及显式参数按相同布局传GPU',()=>{
    const data=new Float32Array(DECAL_INSTANCE_FLOATS*2),world=mat4();
    for(const [index,pattern] of DECAL_PATTERNS.entries()) {packDecalMark(data,0,{...mark,pattern},world);expect(data[3]).toBe(index);}
    packDecalMark(data,0,mark,world);expect(Array.from(data.slice(16,20))).toEqual([DEFAULT_DECAL_STYLE.coverage,expect.closeTo(DEFAULT_DECAL_STYLE.edgeWidth),DEFAULT_DECAL_STYLE.irregularity,DEFAULT_DECAL_STYLE.detail]);
    packDecalMark(data,DECAL_INSTANCE_FLOATS,{...mark,style:{coverage:.6,edgeWidth:0,irregularity:.8,detail:1}},world);
    expect(Array.from(data.slice(36,40))).toEqual([expect.closeTo(.6),0,expect.closeTo(.8),1]);expect(data[7]).toBe(mark.seed);
  });
});

it('固定槽复用和标签计数在全局淘汰、到期、手动删除与清空后正确；借用帧与复制帧一致',()=>{
  const pool=new DecalPool(2),input={receiver:'floor',mark:structuredClone(mark),ttlSec:2,fadeSec:1};
  pool.emit(input,0,'one');const row=pool.frame().marks[0]!,position=row.mark.position;
  pool.emit({...input,mark:{...mark,id:'second'}},0,'two');pool.emit({...input,mark:{...mark,id:'third'}},0,'one');
  expect(pool.groupCount('one')).toBe(1);expect(pool.groupCount('two')).toBe(1);
  expect(pool.frame().marks[1]).toBe(row);expect(pool.frame().marks[1]!.mark.position).toBe(position);expect(row.mark.id).toBe('third');
  expect(pool.diagnostics()).toMatchObject({allocatedSlots:2,emitted:3,reusedSlots:1,active:2,free:0});
  pool.advance(1.5);const builder=new DecalFrameBuilder(),world=mat4();
  const copied=builder.build(null,()=>world,pool.snapshot(),[0,5,10]).slice();
  expect(builder.build(null,()=>world,pool.frame(),[0,5,10])).toEqual(copied);expect(row.mark.opacity).toBe(1);
  expect(pool.removeOldest('two')).toBe(true);expect(pool.groupCount('two')).toBe(0);expect(pool.removeOldest('two')).toBe(false);
  const before=pool.snapshot();expect(()=>pool.emit({...input,ttlSec:0},0,'one')).toThrow();expect(pool.snapshot()).toEqual(before);
  pool.advance(2);expect(pool.groupCount('one')).toBe(0);expect(pool.diagnostics().free).toBe(2);
  pool.emit(input,0,'two');pool.clear();expect(pool.frame().count).toBe(0);expect(pool.groupCount('two')).toBe(0);
  pool.emit(input,0,'two');expect(pool.remove('floor','m')).toBe(true);expect(pool.remove('floor','m')).toBe(false);expect(pool.groupCount('two')).toBe(0);
});

it('同优先级/距离的稳定身份排序保持旧组合key语义，NodeId前缀下划线不改变透明混合',()=>{
 const p=new DecalPool(2);p.emit({receiver:'a',mark:{...mark,id:'a',seed:1},ttlSec:1,fadeSec:0});p.emit({receiver:'a_',mark:{...mark,id:'a',seed:2},ttlSec:1,fadeSec:0});
 const keys=['a:a','a_:a'].sort((a,b)=>a.localeCompare(b));const data=new DecalFrameBuilder().build(null,()=>mat4(),p.frame(),[0,2,0]);
 expect([data[7],data[27]]).toEqual(keys.map(k=>k==='a:a'?1:2));
});

it('槽位改用新ID后刷新透明排序key，不沿用可变mark引用中的旧key',()=>{
 const p=new DecalPool(2),b=new DecalFrameBuilder(),world=mat4(),input={receiver:'r',mark,ttlSec:10,fadeSec:0};
 p.emit({...input,mark:{...mark,id:'aaa',seed:1}});p.emit({...input,mark:{...mark,id:'middle',seed:2}});b.build(null,()=>world,p.frame(),[0,2,0]);
 p.remove('r','aaa');p.emit({...input,mark:{...mark,id:'zzz',seed:3}});
 const data=b.build(null,()=>world,p.frame(),[0,2,0]);expect([data[7],data[27]]).toEqual([2,3]);
});
