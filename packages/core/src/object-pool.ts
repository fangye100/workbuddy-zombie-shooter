/** 同步、按身份管理的资源池。归还后不得继续使用引用；不提供 generation 租约。 */
export interface ObjectPoolOptions<T extends {}> {
  create(): T | null;
  /** 活跃+闲置的总硬上限，与闲置缓存上限分开。 */
  capacity?: number;
  maxRetained?: number;
  onAcquire?(value: T): void;
  onRelease?(value: T): void;
  onDestroy?(value: T): void;
}
export interface ObjectPoolStats {
  readonly active: number; readonly inactive: number; readonly total: number;
  readonly capacity: number; readonly maxRetained: number; readonly disposed: boolean;
  readonly created: number; readonly destroyed: number; readonly acquired: number;
  readonly reused: number; readonly highWater: number;
}
export interface IObjectPool<T extends {}> {
  acquire(): T;
  tryAcquire(): T | null;
  release(value: T): void;
  /** 显式退休失效资源（包括活跃值），跳过归还hook；旧持有者不得继续使用。 */
  invalidate(value: T): void;
  /** 达到目标闲置数；返回实际闲置数，不调用借出/归还 hook。 */
  prewarm(target: number): number;
  has(value: T): boolean;
  isActive(value: T): boolean;
  getStats(): ObjectPoolStats;
  /** 只销毁闲置缓存，不撤销已有借用。 */
  clear(): void;
  /** 封闭池；仍在借用的值在归还时销毁。 */
  dispose(): void;
}
export class PoolExhaustedError extends Error {
  constructor() { super('ObjectPool capacity exhausted or factory unavailable'); this.name='PoolExhaustedError'; }
}
export class PoolOwnershipError extends Error {
  constructor(message: string) { super(message); this.name='PoolOwnershipError'; }
}
function synchronous(result: unknown): void {
  if (result && (typeof result==='object'||typeof result==='function') && typeof (result as {then?: unknown}).then==='function') {
    // 不让已返回的 rejected Promise 产生额外 unhandled rejection；异步副作用无法回滚。
    void Promise.resolve(result).catch(()=>{});
    throw new TypeError('ObjectPool callbacks must be synchronous');
  }
}

export class ObjectPool<T extends {}> implements IObjectPool<T> {
  private readonly idle: T[]=[];
  private readonly owned=new Map<T, boolean>();
  private active=0;
  private busy=false;
  private disposed=false;
  private created=0;
  private destroyed=0;
  private acquired=0;
  private reused=0;
  private highWater=0;
  readonly capacity: number;
  readonly maxRetained: number;
  // 复制函数引用，调用方以后修改 options 不改变池契约。
  private readonly factory: ObjectPoolOptions<T>['create'];
  private readonly onAcquire: ObjectPoolOptions<T>['onAcquire'];
  private readonly onRelease: ObjectPoolOptions<T>['onRelease'];
  private readonly onDestroy: ObjectPoolOptions<T>['onDestroy'];
  constructor(options: ObjectPoolOptions<T>) {
    this.capacity=options.capacity??Number.MAX_SAFE_INTEGER;
    this.maxRetained=options.maxRetained??Math.min(256,this.capacity);
    if (!Number.isSafeInteger(this.capacity)||this.capacity<1||!Number.isSafeInteger(this.maxRetained)||this.maxRetained<0||this.maxRetained>this.capacity)
      throw new RangeError('ObjectPool capacity/maxRetained invalid');
    if (typeof options.create!=='function') throw new TypeError('ObjectPool requires a factory');
    this.factory=options.create;this.onAcquire=options.onAcquire;this.onRelease=options.onRelease;this.onDestroy=options.onDestroy;
  }
  private enter(requireOpen=true): void {
    if(this.busy)throw new Error('ObjectPool lifecycle mutation is not reentrant');
    if(requireOpen&&this.disposed)throw new Error('ObjectPool disposed');
    this.busy=true;
  }
  private create(): T | null {
    const value=this.factory();synchronous(value);
    if(value===null)return null;
    if(value===undefined)throw new TypeError('ObjectPool factory returned undefined');
    // 工厂别名属于已有合法借用，不能调用其 destroy。
    if(this.owned.has(value))throw new PoolOwnershipError('ObjectPool factory returned an owned value');
    this.owned.set(value,false);this.created++;
    return value;
  }
  private destroy(value: T): void {
    this.owned.delete(value);this.destroyed++;
    synchronous(this.onDestroy?.(value));
  }
  private failed(value: T, error: unknown): never {
    try {this.destroy(value);} catch(cleanup) {throw new AggregateError([error,cleanup],'ObjectPool callback and cleanup failed');}
    throw error;
  }
  acquire(): T {const value=this.tryAcquire();if(value===null)throw new PoolExhaustedError();return value;}
  tryAcquire(): T | null {
    this.enter();
    try {
      const reused=this.idle.length>0;
      const value=reused?this.idle.pop()!:(this.owned.size<this.capacity?this.create():null);
      if(value===null)return null;
      this.owned.set(value,true);this.active++;
      try {synchronous(this.onAcquire?.(value));}
      catch(error) {this.active--;this.failed(value,error);}
      this.acquired++;if(reused)this.reused++;this.highWater=Math.max(this.highWater,this.active);
      return value;
    } finally {this.busy=false;}
  }
  release(value: T): void {
    this.enter(false);
    try {
      if(this.owned.get(value)!==true)throw new PoolOwnershipError('ObjectPool foreign value or duplicate release');
      this.owned.set(value,false);this.active--;
      try {synchronous(this.onRelease?.(value));}
      catch(error) {this.failed(value,error);}
      if(this.disposed||this.idle.length>=this.maxRetained)this.destroy(value);
      else this.idle.push(value);
    } finally {this.busy=false;}
  }
  invalidate(value: T): void {
    this.enter(false);
    try {
      if(!this.owned.has(value))throw new PoolOwnershipError('ObjectPool foreign value');
      if(this.owned.get(value))this.active--;
      // 与 Map 的 SameValueZero 身份规则保持一致（含NaN与±0）。
      else this.idle.splice(this.idle.findIndex(v=>v===value||Object.is(v,value)),1);
      this.destroy(value);
    } finally {this.busy=false;}
  }
  prewarm(target: number): number {
    if(!Number.isSafeInteger(target)||target<0)throw new RangeError('ObjectPool prewarm target invalid');
    this.enter();
    try {
      const limit=Math.min(target,this.maxRetained);
      while(this.idle.length<limit&&this.owned.size<this.capacity){const value=this.create();if(value===null)break;this.idle.push(value);}
      return this.idle.length;
    } finally {this.busy=false;}
  }
  has(value: T): boolean {return this.owned.has(value);}
  isActive(value: T): boolean {return this.owned.get(value)===true;}
  getStats(): ObjectPoolStats {return {active:this.active,inactive:this.idle.length,total:this.owned.size,capacity:this.capacity,maxRetained:this.maxRetained,disposed:this.disposed,created:this.created,destroyed:this.destroyed,acquired:this.acquired,reused:this.reused,highWater:this.highWater};}
  private clearIdle(): void {
    const errors: unknown[]=[];
    while(this.idle.length){try{this.destroy(this.idle.pop()!);}catch(error){errors.push(error);}}
    if(errors.length)throw new AggregateError(errors,'ObjectPool destroy callbacks failed');
  }
  clear(): void {this.enter(false);try{this.clearIdle();}finally{this.busy=false;}}
  dispose(): void {
    this.enter(false);
    try{if(this.disposed)return;this.disposed=true;this.clearIdle();}finally{this.busy=false;}
  }
}
