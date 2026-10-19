# 引擎通用对象池与模块适配

2026-10-18；开发基线 main `ec1c8422`，分支 `codex/object-pool-framework-20261018`。
公共入口 `@aether/core`，源码 `packages/core/src/object-pool.ts`。不增加场景字段、GPU
实例格式或第二份游戏状态；不要求被池化对象继承基类。

## 职责与接入范围

| 模块 | 底层复用与保留行为 |
|---|---|
| Core | `IObjectPool<T>` / `ObjectPool<T>`，身份、容量、借还、预热、退休和统计 |
| Render / DecalPool | 预热固定 Entry 及其向量/style，使用通用池借还；原插入 Map 管FIFO，原组标签管预算，512运行上限不变，场景可配置更小容量 |
| Gameplay / CharacterPool | 按 defId 分桶的 `ObjectPool<number>`，槽位0有效；保留SoA、稳定索引、休眠及原接口-1耗尽语义 |
| Gameplay / AssemblyQueue | 池化私有请求；保留优先级、每帧预算、满表重新排队；成功、取消和异常路径归还请求 |
| Runtime / WeaponCombat | 私有 Projectile wrapper 与direction向量复用，仍限制64发；每发武器定义独立复制，命中/到期/clear归还 |
| Game / Editor | 通过原Runtime/Gameplay/Render入口使用同一机制，不另建池，不移动游戏规则或MCP状态 |

当前实际战斗使用 WeaponCombat 和运行贴花；CharacterPool/AssemblyQueue 是已有通用
Gameplay能力，其适配并不表示 RuntimeSession 刷怪已改为按原型休眠池。该游戏当前继续
使用 CharacterTable 的数值槽分配/回收，避免改变多原型共享容量及代次/RNG行为。

ECS World 与 CharacterTable 自身的 TypedArray/free-list 是数值存储分配器；AI
AttackTokenPool 是攻击配额；gfx LruCache 是缓存淘汰。它们不属于借还对象生命周期，
保留原有职责。FrameBuilder、GPU批缓冲是渲染工作集，也不强制转换为对象池。

## 公共API与失败行为

```ts
import {ObjectPool} from '@aether/core';
const pool = new ObjectPool({
  create: () => ({position: [0, 0, 0], elapsed: 0}),
  capacity: 128, maxRetained: 64,
  onRelease: value => { value.elapsed = 0; },
});
pool.prewarm(32);
const value = pool.tryAcquire();
if (value !== null) {
  try { value.elapsed = 1; /* 使用当前借用 */ }
  finally { pool.release(value); }
}
pool.dispose();
```

- `capacity`：active+inactive的总硬限，默认 `Number.MAX_SAFE_INTEGER`；不是按帧预算。
  `maxRetained`：归还后可缓存的闲置上限，默认 min(256,capacity)，0表示归还即销毁。
  两者为整数，capacity≥1，0≤maxRetained≤capacity；不会挤掉正在使用的对象。
- `create(): T|null`：null明确表示暂时不能提供资源。undefined/thenable非法。
  `tryAcquire()`仅在工厂null或硬容量耗尽时返回null；`acquire()`此时抛
  `PoolExhaustedError`。工厂/hook/ownership异常原样抛出，不伪装成耗尽。
- `prewarm(n)`是目标闲置数，受硬容量和缓存上限限制；返回实际闲置数。
  不触发acquire/release hook；部分成功仍保留合法缓存。CharacterPool旧接口的count
  表示新增预热数，适配器转换，外部语义不变。
- 借还按Map的SameValueZero身份识别，支持对象与数值句柄（包括0）。LIFO复用；
  foreign或闲置时重复归还抛 `PoolOwnershipError`，不调用reset/destroy。
  工厂返回当前owned的同一identity时拒绝，不销毁合法借用；销毁后可重新分配同一句柄。
- `clear()`仅销毁闲置缓存；`dispose()`立即封闭池、清闲置，active稍后归还时销毁。
  已dispose仍可合法归还，重复dispose幂等；不是强制撤销全部外部借用。
- `invalidate(value)`用于明确失效的资源，退休指定active/idle identity，跳过onRelease、
  执行onDestroy。调用方必须确保旧借用不能再使用；常规回收仍用release。
- hooks均为同步、单线程契约。同一池在factory/hook内禁止生命周期写操作重入，
  `getStats`/has/isActive可读。检测到thenable时抛错并清理ownership，不承诺回滚异步
  函数已启动的副作用，也不是Promise/GPU异步资源池。
- onAcquire/onRelease失败后退休该值并尝试销毁；主异常与清理异常同时发生则
  AggregateError保留二者。clear/dispose逐项清理到底后汇总销毁异常。
  统计的destroyed指已经移出ownership的次数，不保证失败的销毁回调已释放外部资源。
- getStats返回独立快照：active/inactive/total、created/destroyed、acquired/reused、
  highWater、capacity/maxRetained/disposed。reused表示从闲置缓存借出，包含首次预热
  值；Decal的reusedSlots另表示曾实际emit过的Entry再次使用，预热不算emit。
  生命周期hook执行中存在临时交接状态，计数不能代替跨回调的事务快照。

归还后不得继续使用引用。裸对象/number不带租约token，不能拒绝“旧持有者归还后，该值
已重新借出，旧持有者再次归还”的ABA场景；需要严格跨代次保护的系统继续使用generation
或独立租约协议，不能把普通池身份校验当成ECS generation。

## 模块细节

CharacterTable记录allocated位，休眠槽与未分配槽可区分；destroy休眠槽也正确回收且
不减错aliveCount。retirementVersion仅在有效destroy时递增，CharacterPool只在版本
变化时检查失效ownership，避免每次热借用扫描整表。外部直接destroy后，旧池在再次
acquire/prewarm前按generation退休失效记录，不伤害其他原型的新代次实体。直接篡改
公开数组不属于有效分配生命周期。stats().defs仍是“曾真正缓存过槽位的原型数”，
首次/失败acquire或0预热不增加；stats().pooled仍为闲置总数。

DecalPool保留非法输入/重复id先拒绝、满池FIFO、组计数、模拟时间、TTL/fade、原opacity
与额外opacityScale、snapshot复制及frame同步借用契约。clear归还active并保留预热
资源，不调用通用clear销毁缓存；累计emitted/reusedSlots保留。闲置LIFO身份顺序不是
跨clear的公开持久化契约，frame本就禁止跨池操作持有。GPU A/B、80B实例格式和排序不变。

Projectile只复用私有wrapper。公开WeaponEffect、from/to/position向量及burning观察
数据不能贸然池化：lastShot等消费者保留其引用，复用会改写历史。definition clone
在发布effect或借用前完成，复制失败时无半发射/租约；在途弹药不受后续升级修改影响。

## 验证和复现

```powershell
pnpm exec vitest run packages/core/test/object-pool.test.ts packages/gameplay/test/character-pool.test.ts packages/runtime/test/projectile-pool.test.ts packages/render/test/decal-instances.test.ts
node tools/verify/object-pool-regression.mjs --base ec1c8422573c1e2f19d99919f4b7e80685ff1a2b
pnpm run typecheck
pnpm run architecture:check
pnpm run knowledge:check
```

差分工具从明确Git基线读取三个模块，单独构建新旧API，固定输入/种子比较250个贴花、
40个角色池及300个武器状态；两边共享当前依赖和资产，不是完整历史checkout。武器
差分的空world不认证碰撞/伤害（由owner测试覆盖）。不读取或改写Git内部原始数据。结果与CPU样本落
`.workbuddy/tmp/object-pool-regression/result.json`。生产回归仍需scene/战斗/Editor owner
与有界面GPU，不能用这份CPU差分证明所有游戏业务或所有GPU性能。

微基准对20,000次emit/周期性clear交替测量6批，不包含渲染。通用Map身份与生命周期
检查增加少量CPU成本，相比旧贴花专用空闲栈更慢；不宣称FPS提升或整个游戏零分配。
复用热路径不创建新的Entry/Projectile/请求wrapper，但验证、字符串、公开快照、武器
定义复制、JS容器内部行为及GPU资源仍有各自成本。验收与独立审核见
[本次记录](../evidence/object-pool-20261018/acceptance.md)。
