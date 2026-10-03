/**
 * 自由飞行相机（Free Camera）——编辑态的 Unity/Unreal 式 Scene View 机位。
 *
 * ## 为什么需要它
 *
 * 编辑器原本只有 **orbit 相机**（绕 target 转）+ **pan**（平移 target）+ 缩放。
 * 看一个摆好的房间够用，但要看关卡**内部**（走廊、房间深处、天花板下方）就做不到：
 * orbit 永远绕着外面那个 target 转，进不去。Unity / Unreal 的 Scene View 给的答案是
 * "WASD 自由飞行 + 鼠标转向"，本模块补的就是这个。
 *
 * ## 与 Play 相机的边界
 *
 * Free camera 只作用于**编辑态**。Play 期间相机归 `PlayCameraController`（游戏相机，
 * 由场景的 Camera 组件决定），两者互不干扰 —— 编辑器相机与游戏相机严格分离
 * （AGENTS.md §2.4）。
 *
 * ## 纯函数的原因
 *
 * 位移/转向数学抽成 `stepFreeCamera()` 不碰任何 DOM 与全局状态，可以单测：
 * "按 W 应该往视线方向走、按 D 应该往右走、抬头时前进应该带上升分量" —— 这些
 * 靠人肉开浏览器试是试不准的（尤其是俯仰混入后方向对不对）。
 */

import { orbitEye } from '@aether/core';
import type { ViewCameraState } from './play-camera';

/** 基础飞行速度（米/秒） */
export const FREE_CAM_SPEED_MPS = 8;
/** Shift 加速倍率 */
export const FREE_CAM_BOOST = 3;
/** 鼠标转向灵敏度（弧度/像素），与视口 orbit 手感接近 */
export const FREE_CAM_RAD_PER_PX = 0.0045;
/** 俯仰灵敏度（度/像素） */
export const FREE_CAM_DEG_PER_PX = 0.25;
/** 俯仰限位（度）。±89 留 1° 余量避免 lookAt 的 up 与视线共线退化 */
export const FREE_CAM_PITCH_LIMIT_DEG = 89;

export interface FreeCamInput {
  /** +1 = 沿视线前进，−1 = 后退（W/S） */
  forward: number;
  /** +1 = 向右平移（D），−1 = 向左（A）。**水平**右向，不受俯仰影响 */
  right: number;
  /** +1 = 世界上升（E / Space），−1 = 下降（Q） */
  up: number;
  /** 本帧鼠标横向位移（像素）。右拖为正 */
  dxPx: number;
  /** 本帧鼠标纵向位移（像素）。下拖为正 */
  dyPx: number;
  boost: boolean;
}

export const FREE_CAM_IDLE: FreeCamInput = {
  forward: 0,
  right: 0,
  up: 0,
  dxPx: 0,
  dyPx: 0,
  boost: false,
};

function clampAxis(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/**
 * 推进一帧自由相机。纯函数：同样的输入 + 同样的 state 必得同样的结果。
 *
 * ## 状态量是 eye，不是 target
 *
 * 视口的相机模型是 **orbit 参数化**（`target` + `distance` + yaw/elevation），
 * 自由飞行要的却是「我在哪、我朝哪」。两者必须桥接，桥接错了手感就废了：
 *
 * - 直接改 yaw/elevation 而留着 target 不动 → 那是 **orbit**（eye 绕 target 甩），
 *   不是原地转头。飞到房间中间一转头，人整个被甩到墙外去了。
 * - 正确做法：**eye 是状态量，target 是派生物**。
 *   转向 = 保持 eye 不动、按新朝向重算 target；位移 = 平移 eye、target 跟着走。
 *
 * ## 相机基（必须以 `m4.orbitEye()`（packages/core/src/math.ts:199）为准，别凭记忆写）
 *
 *   eye     = target + (sin yaw·cos el, sin el, cos yaw·cos el)·distance
 *   forward = normalize(target − eye) = (−sin yaw·cos el, −sin el, −cos yaw·cos el)
 *   right   = normalize(forward × worldUp) = (cos yaw, 0, −sin yaw)
 *
 * 曾经把 X/Z 写反 → forward 与 right 共线、W+D 斜向互相抵消走不动，且只在 yaw≠0
 * 才暴露。所以位移方向一律用 `orbitEye` 反查，不再抄第二遍三角公式（单测同理）。
 *
 * @param dt 秒。≤0 时只应用转向（不移动）—— 避免首帧 dt 异常把相机弹飞
 */
export function stepFreeCamera(
  s: ViewCameraState,
  input: FreeCamInput,
  dt: number,
  speedMps = FREE_CAM_SPEED_MPS,
): ViewCameraState {
  // ---- 转向 ----
  // 符号与视口 orbit 完全一致：右拖 → yaw 减小；下拖 → 俯角增大（更往下看）
  const yaw = s.yaw - input.dxPx * FREE_CAM_RAD_PER_PX;
  let elevationDeg = s.elevationDeg + input.dyPx * FREE_CAM_DEG_PER_PX;
  if (elevationDeg > FREE_CAM_PITCH_LIMIT_DEG) elevationDeg = FREE_CAM_PITCH_LIMIT_DEG;
  if (elevationDeg < -FREE_CAM_PITCH_LIMIT_DEG) elevationDeg = -FREE_CAM_PITCH_LIMIT_DEG;

  // 转向**前**的眼点：转向要保住它，所以先拿到。
  const eye = orbitEye(s.target, s.distance, s.yaw, s.elevationDeg);

  // ---- 位移（沿**新**朝向的基）----
  // forward：orbitEye 在 distance=1、target=原点时直接返回单位偏移向量 o，
  // 而 forward = −o。用真源算，杜绝再写错一次。
  const o = orbitEye([0, 0, 0], 1, yaw, elevationDeg);
  const dirX = -o[0];
  const dirY = -o[1];
  const dirZ = -o[2];
  // 水平右向 = normalize(forward × worldUp)，退化成 (cos yaw, 0, −sin yaw)
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);

  // 轴长归一化：三轴两两正交，所以「输入向量长度 = 世界位移 / step」。
  // 不归一化的话 W+D 斜向会比直线快 √2 倍（Unity/Unreal 的飞行相机也是归一化的）。
  let f = clampAxis(input.forward);
  let r = clampAxis(input.right);
  let u = clampAxis(input.up);
  const inLen = Math.hypot(f, r, u);
  if (inLen > 1) {
    f /= inLen;
    r /= inLen;
    u /= inLen;
  }

  const step = dt > 0 ? speedMps * (input.boost ? FREE_CAM_BOOST : 1) * dt : 0;
  const eyeX = eye[0] + (dirX * f + rightX * r) * step;
  const eyeY = eye[1] + (dirY * f + u) * step; // 升降走世界 Y，与朝向无关
  const eyeZ = eye[2] + (dirZ * f + rightZ * r) * step;

  // ---- target 回写：target = eye − o·distance ----
  return {
    target: [eyeX - o[0] * s.distance, eyeY - o[1] * s.distance, eyeZ - o[2] * s.distance],
    distance: s.distance,
    yaw,
    elevationDeg,
  };
}
