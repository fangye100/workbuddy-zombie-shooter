import { expect, it } from 'vitest';
import { renderPixelRatio } from '../src/services/render-resolution';
it('bounds large/high-DPI render targets while leaving small viewports and native opt-in intact', () => {
  expect(renderPixelRatio(1000, 600, 1)).toBe(1);
  const ratio = renderPixelRatio(1884, 1089, 1.5);
  expect(1884 * 1089 * ratio * ratio).toBeCloseTo(1280 * 800);
  expect(renderPixelRatio(1884, 1089, 1.5, true)).toBe(1.5);
  expect(renderPixelRatio(0, 0, 2)).toBe(2);
});
