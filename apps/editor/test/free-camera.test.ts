import { describe, it, expect } from 'vitest';
import { orbitEye } from '@aether/core';
import {
  FREE_CAM_IDLE,
  FREE_CAM_PITCH_LIMIT_DEG,
  FREE_CAM_SPEED_MPS,
  stepFreeCamera,
  type FreeCamInput,
} from '../src/services/free-camera';
import type { ViewCameraState } from '../src/services/play-camera';

/**
 * 自由飞行相机（编辑态 Scene View 机位）。
 *
 * 断言的是**方向对不对** —— 这类数学靠人开浏览器试是试不准的（尤其俯仰混入之后）。
 * 真源是 `m4.orbitEye()`，所以基向量一律拿它反查，不抄第二遍三角公式。
 */
const BASE: ViewCameraState = {
  target: [0, 0, 0],
  distance: 10,
  yaw: 0,
  elevationDeg: 0,
};

const inp = (over: Partial<FreeCamInput> = {}): FreeCamInput => ({ ...FREE_CAM_IDLE, ...over });

/** 从 orbitEye 反推的视线单位向量（eye → target） */
function lookDir(s: ViewCameraState): [number, number, number] {
  const eye = orbitEye(s.target, s.distance, s.yaw, s.elevationDeg);
  const v: [number, number, number] = [s.target[0] - eye[0], s.target[1] - eye[1], s.target[2] - eye[2]];
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

describe('stepFreeCamera · 平移方向', () => {
  it('W（forward=+1）走视线方向：yaw=0、俯角 0 → −Z（真源 orbitEye 反查）', () => {
    const s = stepFreeCamera(BASE, inp({ forward: 1 }), 1);
    const d = lookDir(BASE); // (0, 0, −1)
    expect(s.target[0]).toBeCloseTo(d[0] * FREE_CAM_SPEED_MPS, 6);
    expect(s.target[1]).toBeCloseTo(d[1] * FREE_CAM_SPEED_MPS, 6);
    expect(s.target[2]).toBeCloseTo(d[2] * FREE_CAM_SPEED_MPS, 6);
    expect(s.target[2]).toBeCloseTo(-FREE_CAM_SPEED_MPS, 6);
  });

  it('任意 yaw/俯角下 W 都严格沿视线走（不是拍脑袋的固定轴）', () => {
    for (const yaw of [0, 0.7, Math.PI / 2, 2.3, -1.1]) {
      for (const el of [-60, -20, 0, 35, 70]) {
        const st: ViewCameraState = { ...BASE, yaw, elevationDeg: el };
        const s = stepFreeCamera(st, inp({ forward: 1 }), 1);
        const d = lookDir(st);
        expect(s.target[0]).toBeCloseTo(d[0] * FREE_CAM_SPEED_MPS, 5);
        expect(s.target[1]).toBeCloseTo(d[1] * FREE_CAM_SPEED_MPS, 5);
        expect(s.target[2]).toBeCloseTo(d[2] * FREE_CAM_SPEED_MPS, 5);
      }
    }
  });

  it('S（forward=−1）反向走', () => {
    const s = stepFreeCamera(BASE, inp({ forward: -1 }), 1);
    expect(s.target[2]).toBeCloseTo(FREE_CAM_SPEED_MPS, 6);
  });

  it('D（right=+1）走**水平**右向 (cos yaw, 0, −sin yaw)：yaw=0 → +X', () => {
    const s = stepFreeCamera(BASE, inp({ right: 1 }), 1);
    expect(s.target[0]).toBeCloseTo(FREE_CAM_SPEED_MPS, 6);
    expect(s.target[1]).toBeCloseTo(0, 6);
    expect(s.target[2]).toBeCloseTo(0, 6);
  });

  it('yaw=90° 时右向变成 −Z（右向随 yaw 旋转，不是写死的世界轴）', () => {
    const s = stepFreeCamera({ ...BASE, yaw: Math.PI / 2 }, inp({ right: 1 }), 1);
    expect(s.target[0]).toBeCloseTo(0, 6);
    expect(s.target[2]).toBeCloseTo(-FREE_CAM_SPEED_MPS, 6);
  });

  it('🔴 forward 与 right 必须正交（曾把 X/Z 写反，导致斜向输入互相抵消走不动）', () => {
    for (const yaw of [0, 0.4, Math.PI / 2, 1.9, -2.5]) {
      const st: ViewCameraState = { ...BASE, yaw, elevationDeg: 0 };
      const f = stepFreeCamera(st, inp({ forward: 1 }), 1);
      const r = stepFreeCamera(st, inp({ right: 1 }), 1);
      const dot = f.target[0] * r.target[0] + f.target[1] * r.target[1] + f.target[2] * r.target[2];
      expect(Math.abs(dot)).toBeLessThan(1e-6);
    }
  });

  it('E（up=+1）只走世界 Y，与朝向无关', () => {
    const a = stepFreeCamera(BASE, inp({ up: 1 }), 1);
    const b = stepFreeCamera({ ...BASE, yaw: 1.2, elevationDeg: 40 }, inp({ up: 1 }), 1);
    expect(a.target[1]).toBeCloseTo(FREE_CAM_SPEED_MPS, 6);
    expect(b.target[1]).toBeCloseTo(FREE_CAM_SPEED_MPS, 6);
    expect(a.target[0]).toBeCloseTo(0, 6);
    expect(b.target[0]).toBeCloseTo(0, 6);
  });

  it('俯视时前进带**向下**分量（俯角为正 = 往下看）', () => {
    const st: ViewCameraState = { ...BASE, elevationDeg: 45 };
    const s = stepFreeCamera(st, inp({ forward: 1 }), 1);
    expect(s.target[1]).toBeLessThan(0); // 往下走
    expect(s.target[2]).toBeLessThan(0); // 同时朝 −Z
  });

  it('仰视时前进带向上分量', () => {
    const s = stepFreeCamera({ ...BASE, elevationDeg: -45 }, inp({ forward: 1 }), 1);
    expect(s.target[1]).toBeGreaterThan(0);
  });

  it('Shift 加速：同样时间走得更远', () => {
    const slow = stepFreeCamera(BASE, inp({ forward: 1 }), 1);
    const fast = stepFreeCamera(BASE, inp({ forward: 1, boost: true }), 1);
    expect(Math.abs(fast.target[2]!)).toBeGreaterThan(Math.abs(slow.target[2]!));
  });

  it('dt=0 不移动（首帧 dt 异常不会把相机弹飞）', () => {
    const s = stepFreeCamera(BASE, inp({ forward: 1, right: 1, up: 1 }), 0);
    expect(s.target).toEqual([0, 0, 0]);
  });

  it('斜向输入不比直线快（三轴归一化到长度 1）', () => {
    const straight = stepFreeCamera(BASE, inp({ forward: 1 }), 1);
    const diag = stepFreeCamera(BASE, inp({ forward: 1, right: 1 }), 1);
    const tri = stepFreeCamera(BASE, inp({ forward: 1, right: 1, up: 1 }), 1);
    const dStraight = Math.hypot(straight.target[0]!, straight.target[1]!, straight.target[2]!);
    const dDiag = Math.hypot(diag.target[0]!, diag.target[1]!, diag.target[2]!);
    const dTri = Math.hypot(tri.target[0]!, tri.target[1]!, tri.target[2]!);
    expect(dDiag).toBeCloseTo(dStraight, 5);
    expect(dTri).toBeCloseTo(dStraight, 5);
  });
});

describe('stepFreeCamera · 转向', () => {
  it('右拖 → yaw 减小（与视口 orbit 同符号，手感一致）', () => {
    const s = stepFreeCamera(BASE, inp({ dxPx: 100 }), 1);
    expect(s.yaw).toBeLessThan(0);
  });

  it('下拖 → 俯角增大（更往下看，与 orbit 同符号）', () => {
    const s = stepFreeCamera(BASE, inp({ dyPx: 100 }), 1);
    expect(s.elevationDeg).toBeGreaterThan(0);
  });

  it('俯仰限位：拖到底也停在 ±89°（越界会让 lookAt 的 up 与视线共线退化）', () => {
    const up = stepFreeCamera(BASE, inp({ dyPx: -100000 }), 1);
    const down = stepFreeCamera(BASE, inp({ dyPx: 100000 }), 1);
    expect(up.elevationDeg).toBe(-FREE_CAM_PITCH_LIMIT_DEG);
    expect(down.elevationDeg).toBe(FREE_CAM_PITCH_LIMIT_DEG);
  });

  it('🔴 转向是**原地转头**：eye 不动（改 target 来保 eye，否则会退化成绕 target 甩）', () => {
    const st: ViewCameraState = { ...BASE, target: [5, 1, -2], yaw: 0.8, elevationDeg: 30 };
    const eye0 = orbitEye(st.target, st.distance, st.yaw, st.elevationDeg);
    for (const [dx, dy] of [
      [40, 20],
      [-120, -60],
      [0, 300],
    ]) {
      const s = stepFreeCamera(st, inp({ dxPx: dx!, dyPx: dy! }), 1);
      const eye1 = orbitEye(s.target, s.distance, s.yaw, s.elevationDeg);
      expect(eye1[0]).toBeCloseTo(eye0[0], 5);
      expect(eye1[1]).toBeCloseTo(eye0[1], 5);
      expect(eye1[2]).toBeCloseTo(eye0[2], 5);
    }
  });

  it('移动是**整体平移 eye+target**：两者位移相同，distance 不掉', () => {
    const st: ViewCameraState = { ...BASE, target: [3, 2, 7], yaw: 1.1, elevationDeg: -25 };
    const s = stepFreeCamera(st, inp({ forward: 1, right: 1 }), 0.5);
    const d0 = Math.hypot(s.target[0] - st.target[0], s.target[1] - st.target[1], s.target[2] - st.target[2]);
    expect(d0).toBeGreaterThan(0);
    const e0 = orbitEye(st.target, st.distance, st.yaw, st.elevationDeg);
    const e1 = orbitEye(s.target, s.distance, s.yaw, s.elevationDeg);
    expect(e1[0] - e0[0]).toBeCloseTo(s.target[0] - st.target[0], 5);
    expect(e1[1] - e0[1]).toBeCloseTo(s.target[1] - st.target[1], 5);
    expect(e1[2] - e0[2]).toBeCloseTo(s.target[2] - st.target[2], 5);
  });

  it('distance 不受影响（自由飞行是改 target，不是改 orbit 半径）', () => {
    const s = stepFreeCamera({ ...BASE, distance: 33 }, inp({ forward: 1 }), 1);
    expect(s.distance).toBe(33);
  });
});
