/**
 * WU-03 物理后端会话组合：把 RapierFractureBackend 挂进 Preview/Play 式生命周期。
 *
 * WASM 模块代码经 ensureRapier() 共享；World/body/collider 按 session 隔离。
 * generation 守卫保证 Stop/换场景后迟到的异步初始化不复活旧 World；
 * dispose() 真实释放并满足「Stop 后账目 pending=0」的判据。这是供宿主
 * （如 PlayController 的 registerResource）使用的窄组合入口，不复制第二套模拟。
 *
 * 重复启动语义：任何时刻至多拥有一份活动/待分配 World。已有活动后端或进行中的
 * 初始化时再 start 视为重复启动，明确拒绝（返回已拒绝诊断）；如需重启须先 dispose()。
 * 这样 Stop 不会留下活动 World（重复/并发 start 不再覆盖唯一 backend 引用）。
 */

import { createRapierBackend, type RapierFractureBackend, type RapierBackendOptions } from './fracture-rapier';

export interface FracturePhysicsSession {
  /** 当前后端；异步初始化未完成或已被 generation 取消时为 null。 */
  readonly backend: RapierFractureBackend | null;
  readonly generation: number;
  /** 是否已有活动后端或进行中的初始化（此时重复 start 会被拒绝）。 */
  readonly busy: boolean;
  /** 真实释放后端并使本 session 的 generation 失效（随后 init 不再写入）。 */
  dispose(): void;
  readonly disposed: boolean;
}

export interface FracturePhysicsSessionStart {
  /** start 结果：'started' 新后端就绪；'rejected' 重复/并发启动被拒；'cancelled' 迟到/已 dispose。 */
  status: 'started' | 'rejected' | 'cancelled';
  backend: RapierFractureBackend | null;
}

/**
 * 创建一个物理 session。调用方在 Play/Preview 启动时 new，在 Stop 时 dispose()
 * （通常经 PlaySession.registerResource 登记）。start() 异步初始化；任何时刻至多
 * 一份活动/待分配 World：busy（已有后端或进行中初始化）时重复 start 返回 rejected，
 * 不覆盖、不新建第二份 World；初始化 resolve 前 dispose() 则该次 start 返回 cancelled。
 */
export function createFracturePhysicsSession(): FracturePhysicsSession & {
  start(opts: RapierBackendOptions): Promise<FracturePhysicsSessionStart>;
} {
  let generation = 0;
  let backend: RapierFractureBackend | null = null;
  let initializing = false;
  let disposed = false;
  return {
    get backend() { return backend; },
    get generation() { return generation; },
    get busy() { return backend !== null || initializing; },
    get disposed() { return disposed; },
    async start(opts: RapierBackendOptions): Promise<FracturePhysicsSessionStart> {
      // 重复/并发启动：已有活动后端或进行中初始化，明确拒绝，不覆盖唯一引用。
      if (backend !== null || initializing) return { status: 'rejected', backend: null };
      if (disposed) return { status: 'cancelled', backend: null };
      initializing = true;
      const myGen = generation;
      let created: RapierFractureBackend | null = null;
      try {
        created = await createRapierBackend(opts, () => !disposed && generation === myGen);
      } finally {
        initializing = false;
      }
      if (created === null) return { status: 'cancelled', backend: null };
      // 二次守卫：await 期间被 dispose（generation 变）或已有新 backend，销毁迟到结果。
      if (disposed || generation !== myGen || backend !== null) { created.destroy(); return { status: 'cancelled', backend: null }; }
      backend = created;
      return { status: 'started', backend: created };
    },
    dispose(): void {
      if (disposed && backend === null && !initializing) return;
      disposed = true;
      generation++;
      if (backend) { backend.destroy(); backend = null; }
    },
  };
}
