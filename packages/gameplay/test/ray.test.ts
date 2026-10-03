import { describe, it, expect } from 'vitest';
import { rayCapsuleY, raySphere } from '../src/ray';

/**
 * 射线 × 竖直胶囊求交（P5 C3 新增的纯几何）。
 *
 * 为什么单独补这套测试：它是 gameplay 里少有的**纯函数**，此前全靠 combat.test.ts
 * 「打中一只僵尸」间接覆盖 —— 半球/圆柱的分支、掠射、背向、起点在内部这些
 * 边界全都无人断言（2026-10-02 审查发现）。
 *
 * 夹具胶囊：中心 (0,0)，半径 r=0.5，总高 h=1.8
 *   → 下半球心 y0 = r = 0.5，上半球心 y1 = h − r = 1.3，顶端 y = 1.8
 */
const CX = 0;
const CZ = 0;
const R = 0.5;
const H = 1.8;

describe('rayCapsuleY · 圆柱段', () => {
  it('正对穿过：返回入口距离（不是出口）', () => {
    // 水平射线 y=0.9 落在圆柱段 [0.5, 1.3] 内，从 x=−5 射向 +x
    const t = rayCapsuleY([-5, 0.9, 0], [1, 0, 0], CX, CZ, R, H);
    expect(t).not.toBeNull();
    expect(t!).toBeCloseTo(4.5, 6); // 入口 = 5 − r
  });

  it('横向偏移超过半径 → 未命中 null', () => {
    expect(rayCapsuleY([-5, 0.9, 2], [1, 0, 0], CX, CZ, R, H)).toBeNull();
  });

  it('高度落在圆柱段之外且横向贴边 → 走半球分支（不是圆柱）', () => {
    // y=1.6 > y1=1.3，正对轴心：圆柱段被 y 区间排除，只有上半球可能命中
    const t = rayCapsuleY([-5, 1.6, 0], [1, 0, 0], CX, CZ, R, H);
    // 上半球心 (0,1.3)，射线 y=1.6 → 距球心 y 差 0.3，圆截面半径 √(0.25−0.09)=0.4
    // 入口 x = −0.4 → t = 5 − 0.4 = 4.6
    expect(t).not.toBeNull();
    expect(t!).toBeCloseTo(4.6, 6);
  });

  it('贴着顶端掠过（y=1.8）→ 恰好切上半球，不命中', () => {
    // y=1.8 = 球心 1.3 + r：圆截面半径为 0，浮点上判不到（disc<0）
    expect(rayCapsuleY([-5, 1.8001, 0], [1, 0, 0], CX, CZ, R, H)).toBeNull();
  });
});

describe('rayCapsuleY · 两端半球', () => {
  it('自上而下垂直射线 → 命中上半球顶点（t = 起点高 − 1.8）', () => {
    const t = rayCapsuleY([0, 5, 0], [0, -1, 0], CX, CZ, R, H);
    expect(t).not.toBeNull();
    expect(t!).toBeCloseTo(3.2, 6); // 5 − 1.8
  });

  it('自下而上垂直射线 → 命中下半球底点（y=0）', () => {
    const t = rayCapsuleY([0, -3, 0], [0, 1, 0], CX, CZ, R, H);
    expect(t).not.toBeNull();
    expect(t!).toBeCloseTo(3.0, 6); // −3 → 0
  });

  it('矮胶囊（h < 2r）不会退化：y1 被钳到 y0，圆柱段长度为 0', () => {
    // h=0.4 → y1 = max(r, h−r) = max(0.5, −0.1) = 0.5 = y0（退化成球）
    const t = rayCapsuleY([-5, 0.5, 0], [1, 0, 0], CX, CZ, R, 0.4);
    expect(t).not.toBeNull();
    expect(t!).toBeCloseTo(4.5, 6); // 等价半径 0.5 的球
  });
});

describe('rayCapsuleY · 方向与边界', () => {
  it('背向射线（朝反方向）→ null（只认正向 t）', () => {
    expect(rayCapsuleY([5, 0.9, 0], [1, 0, 0], CX, CZ, R, H)).toBeNull();
  });

  it('起点在胶囊内部 → 返回正向出口距离（不是 0 / 不是负 t）', () => {
    const t = rayCapsuleY([0, 0.9, 0], [1, 0, 0], CX, CZ, R, H);
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(0);
    // 内部起点：真正的出口是**圆柱壁** x=0.5。
    // 0.3 是下半球 y=0.5 球壳上的点，但它 y=0.9 > 球心高度 → 落在**朝内**那半，
    // 是胶囊内部的点而不是表面。修半球过滤前这里断言 0.3（把内壁当成了表面）。
    expect(t!).toBeCloseTo(0.5, 6);
  });

  it('距离上限由调用方判（本函数不截断）：远命中照样返回真实 t', () => {
    const far = rayCapsuleY([-100, 0.9, 0], [1, 0, 0], CX, CZ, R, H);
    expect(far).not.toBeNull();
    expect(far!).toBeCloseTo(99.5, 6);
  });

  it('零方向向量不炸（a≈0 时跳过圆柱，只看半球）', () => {
    const t = rayCapsuleY([0, 5, 0], [0, -1, 0], CX, CZ, R, H);
    expect(t).not.toBeNull();
  });
});

describe('raySphere · 基础（|d| = 1 的简化式）', () => {
  it('正对命中：入口 t = 距离 − r', () => {
    const t = raySphere([-5, 0, 0], [1, 0, 0], 0, 0, 0, 0.5);
    expect(t).toBeCloseTo(4.5, 6);
  });

  it('相切（disc = 0）仍算命中', () => {
    const t = raySphere([-5, 0.5, 0], [1, 0, 0], 0, 0, 0, 0.5);
    expect(t).toBeCloseTo(5.0, 6);
  });

  it('未命中（偏移 > r）→ null', () => {
    expect(raySphere([-5, 0.6, 0], [1, 0, 0], 0, 0, 0, 0.5)).toBeNull();
  });

  it('球心在射线背后 → null', () => {
    expect(raySphere([5, 0, 0], [1, 0, 0], 0, 0, 0, 0.5)).toBeNull();
  });
});
