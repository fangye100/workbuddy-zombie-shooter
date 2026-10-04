import { it, expect } from 'vitest';
import { defaultParams } from '../src/params';
import { applySceneLightParams } from '../src/services/scene-light';

it('enables the authored point-light slot on load and clears stale slots on a scene switch', () => {
  const p = defaultParams();
  expect(p.pointEnabled).toBe(false);
  applySceneLightParams(p, { keyLight: { nodeId: 'key', color: '#ffe4b0', intensity: 1.15, azimuth: 130, elevation: 48 },
    pointLight: { nodeId: 'beacon', color: '#ffc06b', intensity: 2.4, range: 11, position: [33, 4.5, -3] } });
  expect(p.pointEnabled).toBe(true); expect(p.pointPosition).toEqual([33, 4.5, -3]);
  expect(p.pointIntensity).toBe(2.4); expect(p.keyIntensity).toBe(1.15);
  applySceneLightParams(p, { keyLight: null, pointLight: null });
  expect(p.pointEnabled).toBe(false); expect(p.pointIntensity).toBe(0); expect(p.keyIntensity).toBe(0);
});
