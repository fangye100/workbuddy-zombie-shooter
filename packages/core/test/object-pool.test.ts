import {describe,it,expect} from 'vitest';
import {ObjectPool,PoolExhaustedError,PoolOwnershipError} from '../src';

describe('ObjectPool 通用同步生命周期',()=>{
  it('预热不借出，按身份LIFO复用，容量和缓存上限独立，统计隔离',()=>{
    let seq=0;const hooks:string[]=[];
    const p=new ObjectPool({capacity:3,maxRetained:2,create:()=>({id:++seq}),onAcquire:v=>{hooks.push('get'+v.id);},onRelease:v=>{hooks.push('put'+v.id);},onDestroy:v=>{hooks.push('destroy'+v.id);}});
    expect(p.prewarm(99)).toBe(2);expect(hooks).toEqual([]);
    const a=p.acquire(),b=p.acquire(),c=p.acquire();expect([a.id,b.id,c.id]).toEqual([2,1,3]);
    expect(p.tryAcquire()).toBeNull();expect(()=>p.acquire()).toThrow(PoolExhaustedError);
    p.release(a);p.release(b);p.release(c);expect(hooks.at(-1)).toBe('destroy3');
    expect(p.acquire()).toBe(b);expect(p.isActive(b)).toBe(true);expect(p.has(c)).toBe(false);
    const snapshot=p.getStats();expect(snapshot).toMatchObject({active:1,inactive:1,total:2,created:3,destroyed:1,acquired:4,reused:3,highWater:3});
    p.release(b);expect(snapshot.active).toBe(1);expect(p.getStats().active).toBe(0);
  });
  it('支持0数值句柄，工厂null为暂时不可用，异常继续抛',()=>{
    let available=false;const p=new ObjectPool<number>({create:()=>available?0:null,maxRetained:0});
    expect(p.tryAcquire()).toBeNull();available=true;expect(p.acquire()).toBe(0);p.release(0);expect(p.acquire()).toBe(0);
    const error=new Error('factory');expect(()=>new ObjectPool({create:()=>{throw error;}}).tryAcquire()).toThrow(error);
  });
  it('拒绝外来/闲置双归还和工厂别名，不销毁正在使用的合法identity',()=>{
    const same={},foreign={};let destroyed=0;
    const p=new ObjectPool({create:()=>same,onDestroy:()=>{destroyed++;}});
    expect(p.acquire()).toBe(same);expect(()=>p.acquire()).toThrow(PoolOwnershipError);expect(destroyed).toBe(0);
    expect(()=>p.release(foreign)).toThrow(PoolOwnershipError);p.release(same);expect(()=>p.release(same)).toThrow(PoolOwnershipError);
    expect(p.getStats()).toMatchObject({active:0,inactive:1,total:1});p.clear();expect(destroyed).toBe(1);
    // 资源销毁后，工厂可以重新分配同一个裸句柄。
    expect(p.acquire()).toBe(same);
  });
  it('clear只清idle，dispose封闭新借用并等待active归还，反复dispose不重复销毁',()=>{
    let seq=0;const destroyed:number[]=[];
    const p=new ObjectPool({create:()=>++seq,capacity:3,maxRetained:3,onDestroy:v=>{destroyed.push(v);}});
    p.prewarm(3);const live=p.acquire();p.clear();expect(destroyed).toHaveLength(2);expect(p.isActive(live)).toBe(true);
    p.dispose();p.dispose();expect(()=>p.tryAcquire()).toThrow('disposed');expect(()=>p.prewarm(1)).toThrow('disposed');
    p.release(live);expect(destroyed).toHaveLength(3);expect(p.getStats()).toMatchObject({disposed:true,total:0,active:0,inactive:0});
  });
  it.each(['onAcquire','onRelease'] as const)('%s失败销毁值、恢复容量，保留清理异常',hook=>{
    const primary=new Error('primary'),cleanup=new Error('cleanup');let broken=true;
    const p=new ObjectPool({capacity:1,create:()=>({}),[hook]:()=>{if(broken)throw primary;},onDestroy:()=>{if(broken)throw cleanup;}});
    let caught:unknown;
    try{const a=p.acquire();p.release(a);}catch(error){caught=error;}
    expect(caught).toBeInstanceOf(AggregateError);expect((caught as AggregateError).errors).toEqual([primary,cleanup]);
    expect(p.getStats()).toMatchObject({total:0,active:0,inactive:0,destroyed:1});broken=false;const next=p.acquire();p.release(next);
  });
  it('批量销毁出错仍清到尾；dispose立刻封闭且读统计允许，生命周期重入拒绝',()=>{
    let calls=0;const p=new ObjectPool({capacity:3,maxRetained:3,create:()=>({}),onDestroy:()=>{calls++;expect(p.getStats().disposed).toBe(true);expect(()=>p.prewarm(1)).toThrow('reentrant');throw new Error('destroy');}});
    p.prewarm(3);expect(()=>p.dispose()).toThrow(AggregateError);expect(calls).toBe(3);expect(p.getStats().total).toBe(0);p.dispose();
    let q:ObjectPool<object>;q=new ObjectPool({create:()=>({}),onAcquire:()=>{q.acquire();}});
    expect(()=>q.acquire()).toThrow('reentrant');expect(q.getStats().total).toBe(0);
  });
  it('拒绝异步hook/工厂、非法容量和预热值，不将其记为成功借用',()=>{
    expect(()=>new ObjectPool({capacity:0,create:()=>({})})).toThrow(RangeError);
    expect(()=>new ObjectPool({capacity:2,maxRetained:3,create:()=>({})})).toThrow(RangeError);
    const p=new ObjectPool({create:()=>({}),onAcquire:async()=>{}});expect(()=>p.acquire()).toThrow('synchronous');expect(p.getStats().total).toBe(0);
    const bad=new ObjectPool({create:()=>Promise.resolve({})});expect(()=>bad.acquire()).toThrow('synchronous');
    expect(()=>p.prewarm(-1)).toThrow(RangeError);expect(()=>p.prewarm(.5)).toThrow(RangeError);
  });
  it('factory部分预热失败保留合法对象，下次继续；active计入硬容量',()=>{
    let seq=0,fail=true;const p=new ObjectPool({capacity:3,maxRetained:3,create:()=>{if(seq===1&&fail)throw new Error('factory');return {id:++seq};}});
    expect(()=>p.prewarm(3)).toThrow('factory');expect(p.getStats().inactive).toBe(1);const active=p.acquire();fail=false;
    expect(p.prewarm(3)).toBe(2);expect(p.getStats().total).toBe(3);p.release(active);expect(p.getStats().inactive).toBe(3);
  });
  it('显式退休活跃/闲置失效资源，跳过reset但执行销毁，销毁异常也完成ownership清理',()=>{
    let seq=0,released=0,broken=false;const retired:number[]=[];
    const p=new ObjectPool({create:()=>++seq,capacity:3,maxRetained:3,onRelease:()=>{released++;},onDestroy:v=>{retired.push(v);if(broken)throw new Error('destroy');}});
    p.prewarm(3);const a=p.acquire();p.invalidate(a);expect(released).toBe(0);expect(p.isActive(a)).toBe(false);expect(()=>p.release(a)).toThrow(PoolOwnershipError);
    p.invalidate(1);expect(p.getStats()).toMatchObject({active:0,inactive:1,total:1,destroyed:2});
    broken=true;expect(()=>p.invalidate(2)).toThrow('destroy');expect(p.getStats().total).toBe(0);expect(retired.sort()).toEqual([1,2,3]);
  });
  it('退休使用与Map一致的SameValueZero，NaN不误删其他缓存；±0为同一身份',()=>{
    let n=0;const values=[NaN,1],destroyed:number[]=[];
    const p=new ObjectPool({create:()=>values[n++]!,capacity:2,maxRetained:2,onDestroy:v=>{destroyed.push(v);}});
    p.prewarm(2);p.invalidate(NaN);expect(p.getStats()).toMatchObject({total:1,inactive:1,active:0});expect(p.acquire()).toBe(1);expect(p.has(NaN)).toBe(false);expect(destroyed).toEqual([NaN]);
    let zero=0;const z=new ObjectPool({create:()=>zero++?-0:0,capacity:2,maxRetained:2});z.acquire();expect(()=>z.acquire()).toThrow(PoolOwnershipError);z.release(-0);z.invalidate(0);expect(z.getStats().total).toBe(0);
  });
  it('固定种子混合借还/clear压力下身份唯一、计数与容量始终一致',()=>{
    const p=new ObjectPool({capacity:23,maxRetained:12,create:()=>({})}),live:object[]=[];let seed=7;
    for(let i=0;i<5000;i++){
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      if(seed%7===0)p.clear();
      else if(seed%2&&live.length){const n=seed%live.length;p.release(live[n]!);live.splice(n,1);}
      else {const value=p.tryAcquire();if(value!==null){expect(live.includes(value)).toBe(false);live.push(value);}}
      const s=p.getStats();expect(s.active).toBe(live.length);expect(s.total).toBe(s.active+s.inactive);expect(s.total).toBeLessThanOrEqual(23);expect(s.inactive).toBeLessThanOrEqual(12);
    }
    for(const value of live)p.release(value);p.dispose();expect(p.getStats().total).toBe(0);
  });
});
