import {it,expect} from 'vitest';
import {CharacterTable,CharacterPool,AssemblyQueue} from '../src';

it('角色按原型预热与LIFO复用，槽位0有效，耗尽-1；战斗状态清理不影响其他原型',()=>{
  const t=new CharacterTable(3),p=new CharacterPool(t);
  expect(p.prewarm(1,2)).toBe(2);expect(p.prewarm(2,2)).toBe(1);expect(t.aliveCount).toBe(0);
  const a=p.acquire(1),b=p.acquire(1),c=p.acquire(2);expect([a,b,c]).toEqual([1,0,2]);expect(p.acquire(1)).toBe(-1);
  t.health[a]=99;t.cooldownUntil[a]=20;t.velX[a]=3;t.animTime[a]=5;
  p.release(a);expect(()=>p.release(a)).toThrow('duplicate');expect(t.aliveCount).toBe(2);expect(t.defId[c]).toBe(2);
  expect(p.acquire(1)).toBe(a);expect([t.health[a],t.cooldownUntil[a],t.velX[a],t.animTime[a]]).toEqual([0,0,0,0]);
  expect(()=>p.release(99)).toThrow('foreign');p.dispose();expect(t.aliveCount).toBe(3);p.release(a);p.release(b);p.release(c);
  expect(t.aliveCount).toBe(0);expect(t.spawn(7)).toBeGreaterThanOrEqual(0);
});

it('clear释放休眠保留的SoA槽，外部销毁/重分配不误伤新代次实体',()=>{
  const t=new CharacterTable(2),p=new CharacterPool(t);p.prewarm(1,2);p.clear();
  expect(p.stats().pooled).toBe(0);const a=t.spawn(5),b=t.spawn(5);expect([a,b].sort()).toEqual([0,1]);expect(t.spawn(5)).toBe(-1);
  t.destroy(0);t.destroy(1);const x=p.acquire(1);t.destroy(x);const foreign=t.spawn(2);
  expect(foreign).toBe(x);expect(()=>p.release(x)).toThrow();expect(t.isAlive(foreign)).toBe(true);
  t.destroy(foreign);expect(p.acquire(1)).toBeGreaterThanOrEqual(0);p.dispose();
});

it('外部销毁后其他bucket重分配先退休旧ownership，旧原型可恢复；stats.defs保持曾缓存原型语义',()=>{
  const t=new CharacterTable(1),p=new CharacterPool(t);
  const a=p.acquire(1);expect(p.stats()).toEqual({defs:0,pooled:0});expect(p.acquire(2)).toBe(-1);expect(p.prewarm(3,0)).toBe(0);expect(p.stats().defs).toBe(0);
  t.destroy(a);const b=p.acquire(2);expect(b).toBe(a);p.release(b);expect(p.stats()).toEqual({defs:1,pooled:1});
  p.clear();const again=p.acquire(1);expect(again).toBe(a);p.release(again);expect(p.stats()).toEqual({defs:2,pooled:1});
});

it.each([1,2])('外部销毁后同原型在容量%s恢复借出，不在factory重入或泄漏dormant槽',capacity=>{
  const t=new CharacterTable(capacity),p=new CharacterPool(t),a=p.acquire(1);t.destroy(a);
  const b=p.acquire(1);expect(b).toBe(a);expect(t.aliveCount).toBe(1);p.release(b);p.clear();
  for(let i=0;i<capacity;i++)expect(t.spawn(9)).toBeGreaterThanOrEqual(0);expect(t.spawn(9)).toBe(-1);
});

it('外部销毁休眠槽后预热同bucket可恢复，其他原型新代次保持活跃',()=>{
  const t=new CharacterTable(2),p=new CharacterPool(t);p.prewarm(1,2);t.destroy(0);const other=t.spawn(9);
  expect(other).toBe(0);expect(p.prewarm(1,2)).toBe(0);expect(t.isAlive(other)).toBe(true);expect(p.stats().pooled).toBe(1);
  t.destroy(other);expect(p.prewarm(1,1)).toBe(1);expect(p.stats().pooled).toBe(2);
});

it('销毁dormant只回收一次；未分配槽不能被activate，旧spawn/destroy计数不变',()=>{
  const t=new CharacterTable(1),x=t.spawnDormant(1);expect(x).toBe(0);t.destroy(x);t.destroy(x);
  expect(t.aliveCount).toBe(0);expect(()=>t.activate(x)).toThrow('not allocated');expect(t.spawn(1)).toBe(x);expect(t.spawn(1)).toBe(-1);t.destroy(x);expect(t.aliveCount).toBe(0);
});

it('装配请求共享通用池：排序/预算/满容量重试不变，完成与clear归还并复用',()=>{
  const t=new CharacterTable(1),p=new CharacterPool(t),done:number[]=[];
  const q=new AssemblyQueue(p,(slot,def)=>{done.push(def);expect(t.defId[slot]).toBe(def);});
  q.request(1,0,0,0,0,1);q.request(2,10,0,0,0,1);expect(q.pump(10)).toBe(1);expect(done).toEqual([1]);expect(q.pendingCount).toBe(1);
  p.release(0);p.clear();expect(q.pump(1)).toBe(1);expect(done).toEqual([1,2]);expect(q.poolStats()).toMatchObject({active:0,inactive:2,created:2});
  q.request(3,0,0,0,0,1);expect(q.poolStats().created).toBe(2);q.clear();expect(q.pendingCount).toBe(0);expect(q.poolStats().active).toBe(0);
});

it('装配出队后的角色池/回调失败均归还请求对象，满容量重排仍保持租用',()=>{
  const p=new CharacterPool(new CharacterTable(1)),q=new AssemblyQueue(p,()=>{throw new Error('callback');});
  q.request(-1,0,0,0,0,1);expect(()=>q.pump(1)).toThrow('defId');expect(q.pendingCount).toBe(0);expect(q.poolStats().active).toBe(0);
  q.request(1,0,0,0,0,1);expect(()=>q.pump(1)).toThrow('callback');expect(q.poolStats().active).toBe(0);
  p.release(0);p.dispose();q.request(1,0,0,0,0,1);expect(()=>q.pump(1)).toThrow('disposed');expect(q.poolStats().active).toBe(0);
});
