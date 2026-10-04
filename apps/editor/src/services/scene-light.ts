/** Directional lights point down local -Y; shading consumes the opposite direction. */
export function lightAngles(q: readonly number[]): { azimuth: number; elevation: number } {
  const [x, y, z, w] = q as readonly [number, number, number, number];
  const lx = 2 * (x * y - w * z);
  const ly = 1 - 2 * (x * x + z * z);
  const lz = 2 * (y * z + w * x);
  return { azimuth: (Math.atan2(lx, lz) * 180 / Math.PI + 360) % 360,
    elevation: Math.asin(Math.max(-1, Math.min(1, ly))) * 180 / Math.PI };
}
