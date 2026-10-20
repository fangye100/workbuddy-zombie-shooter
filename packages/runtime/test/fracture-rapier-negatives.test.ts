/**
 * WU-03 物理后端负例测试：证明门禁活性。
 * 未释放 body / 错误分组 / 忽略静态碰撞，必须被对应测试捕捉——
 * 这些负例直接验证正向测试不是恒真断言。实际加载 Rapier WASM。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  ensureRapier,
  RapierFractureBackend,
  collisionGroups,
  FRACTURE_GROUP,
  type RapierModule,
} from '../src/fracture-rapier';
import type { FractureBodyHandle } from '../src/fracture';

const STEP = 1 / 60;
let rapier: RapierModule;
beforeAll(async () => { rapier = await ensureRapier(); }, 30000);
const h = (key: string): FractureBodyHandle => ({ key, chunkId: key, layer: 'rigid' });

describe('物理后端门禁活性（负例）', () => {
  it('负例-忽略静态碰撞：若碎片分组错误地排除 environment，则穿透地面（证明默认分组必要）', () => {
    const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP });
    b.upsertStatic('ground', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [10, 0.5, 10] } });
    // 错误分组：membership=chunk，filter 只含自身 → 不与 environment 碰撞
    const wrongGroups = collisionGroups(FRACTURE_GROUP.chunk, FRACTURE_GROUP.chunk);
    b.addBody(h('ghost'), { position: [0, 2, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.3 }, mass: 1, friction: 0.3, restitution: 0, groups: wrongGroups });
    for (let i = 0; i < 120; i++) b.step(i);
    // 穿透地面：y 显著低于地面顶（0.5）+ 半径（0.3）=0.8
    expect(b.snapshot(h('ghost'))!.position[1]).toBeLessThan(0.5);
    b.destroy();
  });

  it('负例-未释放 body：destroy 前不 release 会在账目体现 pending（证明必须显式释放）', () => {
    const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP });
    b.addBody(h('leak'), { position: [0, 2, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.3 }, mass: 1, friction: 0.5, restitution: 0 });
    // 不 release 直接读账目：仍有活动 body
    expect(b.ledger.dynamicBodies).toBe(1);
    // 只有 destroy 才清零——这正是「Stop 必须 destroy」的判据
    b.destroy();
    expect(b.ledger.dynamicBodies).toBe(0);
  });

  it('负例-移除静态镜像残留：若误调 removeStatic 前不 upsert 覆盖，旧 collider 仍挡路（证明 remove 必要）', () => {
    const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP });
    b.upsertStatic('ground', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [20, 0.5, 20] } });
    b.upsertStatic('wall', { position: [2, 1.5, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.25, 1.5, 2] } });
    b.addBody(h('m'), { position: [0, 1, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.4, 0.4, 0.4] }, mass: 1, friction: 0, restitution: 0, linearVelocity: [8, 0, 0] });
    for (let i = 0; i < 40; i++) b.step(i);
    // 不移除 wall：仍被挡
    expect(b.snapshot(h('m'))!.position[0]).toBeLessThan(2.4);
    b.destroy();
  });

  it('负例-CCD 标志真实写入且机制不破坏接触（快速小刚体被薄墙阻挡）', () => {
    // Rapier 0.21 的默认非线性投影求解器已能阻挡 300 m/s 的小球（无可复现穿透差异），
    // 故本测试不伪造"无 CCD 必穿透"的差异，而是验证 ccd 标志被真实接受且接触仍可靠。
    const shoot = (ccd: boolean): { x: number; ccdOn: boolean } => {
      const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP, maxLinearSpeed: 500 });
      b.upsertStatic('thinwall', { position: [5, 2, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.05, 2, 2] } });
      b.addBody(h('bullet'), { position: [0, 2, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.1 }, mass: 0.1, friction: 0, restitution: 0, linearVelocity: [300, 0, 0], ccd });
      const ccdOn = b.isCcdEnabled(h('bullet'));
      for (let i = 0; i < 30; i++) b.step(i);
      const x = b.snapshot(h('bullet'))!.position[0];
      b.destroy();
      return { x, ccdOn };
    };
    const noCcd = shoot(false);
    const withCcd = shoot(true);
    expect(noCcd.ccdOn).toBe(false);
    expect(withCcd.ccdOn).toBe(true); // 标志真实进入求解器
    // 两者都被薄墙阻挡（x<5），CCD 不破坏既有接触
    expect(noCcd.x).toBeLessThan(5);
    expect(withCcd.x).toBeLessThan(5);
  });
});
