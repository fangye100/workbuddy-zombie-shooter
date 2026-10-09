import { expect, it } from 'vitest';
import { motionDirection } from '../src/motion-direction';
it('四向步态根据面向而非世界轴选择，无速度和非法输入无动作', () => {
  expect(motionDirection(1, 0, 0)).toBe('f');
  expect(motionDirection(-1, 0, 0)).toBe('b');
  expect(motionDirection(0, 1, 0)).toBe('r');
  expect(motionDirection(0, -1, 0)).toBe('l');
  expect(motionDirection(0, 1, Math.PI / 2)).toBe('f');
  expect(motionDirection(1, 0, Math.PI / 2)).toBe('l');
  expect(motionDirection(0, 0, 0)).toBeNull();
  expect(motionDirection(NaN, 0, 0)).toBeNull();
});
