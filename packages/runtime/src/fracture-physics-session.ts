/**
 * WU-03 物理后端会话组合：把 RapierFractureBackend 挂进 Preview/Play 式生命周期。
 *
 * WASM 模块代码经 ensureRapier() 共享；World/body/collider 按 session 隔离。
 * generation 守卫保证 Stop/换场景后迟到的异步初始化不复活旧 World；
 * dispose() 真实释放并满足「Stop 后账目 pending=0」的判据。这是供宿主
 * （如 PlayController 的 registerResource）使用的窄组合入口，不复制第二套模拟。
 */

import { createRapierBackend, type RapierFractureBackend, type RapierBackendOptions } from './fracture-rapier';

export interface FracturePhysicsSession {
  /** 当前后端；异步初始化未完成或已被 generation 取消时为 null。 */
  readonly backend: RapierFractureBackend | null;
  readonly generation: number;
  /** 真实释放后端并使本 session 的 generation 失效（随后 init 不再写入）。 */
  dispose(): void;
  readonly disposed: boolean;
}

/**
 * 创建一个物理 session。调用方在 Play/Preview 启动时 new，在 Stop 时 dispose()
 * （通常经 PlaySession.registerResource 登记）。可随后调用 start() 异步初始化；
 * 若在初始化 resolve 前 dispose()，backend 保持 null（迟到取消）。
 */
export function createFracturePhysicsSession(): FracturePhysicsSession & {
  start(opts: RapierBackendOptions): Promise<RapierFractureBackend | null>;
} {
  let generation = 0;
  let backend: RapierFractureBackend | null = null;
  let disposed = false;
  return {
    get backend() { return backend; },
    get generation() { return generation; },
    get disposed() { return disposed; },
    async start(opts: RapierBackendOptions): Promise<RapierFractureBackend | null> {
      const myGen = generation;
      const created = await createRapierBackend(opts, () => !disposed && generation === myGen);
      if (created === null) return null;
      // 二次守卫：await 期间若被 dispose，created 为 null（不会到这里）；
      // 若 generation 已变（新 start），不覆盖新 backend。
      if (disposed || generation !== myGen) { created.destroy(); return null; }
      backend = created;
      return created;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation++;
      if (backend) { backend.destroy(); backend = null; }
    },
  };
}
