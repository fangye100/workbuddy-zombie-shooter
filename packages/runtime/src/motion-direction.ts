/** 通用表现层：世界平面速度转换为面向方向的四向步态，不改变模拟速度。 */
export function motionDirection(dx: number, dz: number, yaw: number): 'f' | 'b' | 'l' | 'r' | null {
  if (![dx, dz, yaw].every(Number.isFinite) || Math.hypot(dx, dz) < 1e-6) return null;
  // 与模拟/射线一致：yaw = atan2(dz, dx)，零角面向 +X。
  const forward = dx * Math.cos(yaw) + dz * Math.sin(yaw);
  const right = -dx * Math.sin(yaw) + dz * Math.cos(yaw);
  return Math.abs(forward) >= Math.abs(right) ? forward >= 0 ? 'f' : 'b' : right >= 0 ? 'r' : 'l';
}
