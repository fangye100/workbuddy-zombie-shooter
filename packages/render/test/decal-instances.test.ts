import {describe,it,expect} from 'vitest';
import {DecalPool,packDecalMark,DecalFrameBuilder} from '../src/decal-instances';
import {mat4,composeQuat} from '@aether/core';
import {type DecalMark,createEmptySceneDocument} from '@aether/scene';
const mark:DecalMark={id:'m',pattern:'splatter',position:[0,0,0],rotation:[0,0,0,1],size:[2,4],color:'#ff0000',opacity:1,seed:7,normalOffset:.01,priority:0};
describe('程序贴花实例与运行池',()=>{
  it('斜面/墙面法线及非均匀缩放保持米制偏移，颜色在 HDR 线性空间；退化拒绝',()=>{
    const out=new Float32Array(16),world=mat4();composeQuat(world,2,3,4,[Math.SQRT1_2,0,0,Math.SQRT1_2],2);
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
    const b=new DecalFrameBuilder(),world=mat4();const data=b.build(doc,()=>world,p.snapshot(),[0,5,10]);expect(data).toHaveLength(32);expect(data[7]).toBe(9);expect(data[23]).toBe(7);expect(b.build(doc,()=>null,p.snapshot(),[0,5,10])).toHaveLength(0);
  });
});
