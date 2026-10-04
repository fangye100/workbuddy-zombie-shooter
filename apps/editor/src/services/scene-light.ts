import type { SceneLoadResult } from '../renderer';
import type { LabParams } from '../params';

/** Apply the resolved scene slots, including disabled/absent slots on scene switches. */
export function applySceneLightParams(p: LabParams, result: Pick<SceneLoadResult, 'keyLight' | 'pointLight'>): void {
  const key = result.keyLight, point = result.pointLight;
  p.keyIntensity = key?.intensity ?? 0;
  if (key) Object.assign(p, { keyColor: key.color, keyAzimuth: key.azimuth, keyElevation: key.elevation });
  p.pointEnabled = point != null;
  p.pointIntensity = point?.intensity ?? 0;
  if (point) Object.assign(p, { pointColor: point.color, pointRange: point.range, pointPosition: [...point.position] });
}

/** Directional lights point down local -Y; shading consumes the opposite direction. */
export function lightAngles(q: readonly number[]): { azimuth: number; elevation: number } {
  const [x, y, z, w] = q as readonly [number, number, number, number];
  const lx = 2 * (x * y - w * z);
  const ly = 1 - 2 * (x * x + z * z);
  const lz = 2 * (y * z + w * x);
  return { azimuth: (Math.atan2(lx, lz) * 180 / Math.PI + 360) % 360,
    elevation: Math.asin(Math.max(-1, Math.min(1, ly))) * 180 / Math.PI };
}
