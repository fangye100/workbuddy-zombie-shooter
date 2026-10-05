import { it, expect } from 'vitest';
import { SceneContacts } from '../src/services/scene-contacts';
import type { CoreDynamicBatch } from '@aether/render';

const object = () => ({ visible: true, background: false, localMin: [-1, 0, -2], localMax: [1, 3, 2],
  modelMatrix: [2,0,0,0, 0,2,0,0, 0,0,2,0, 10,1,20,1] });
it('derives transformed feet and footprint while excluding backgrounds, hidden objects and floors', () => {
  const o = object(); const contacts = new SceneContacts();
  const data = contacts.build([o, {...o, visible: false}, {...o, background: true}, {...o, localMax: [1,0.1,2]}], null);
  expect(data.length).toBe(8); expect(data[0]).toBe(10); expect(data[1]).toBeCloseTo(1.016);
  expect(Array.from(data.slice(2,6))).toEqual([20,0,2,4]);
  expect(contacts.build([], null).length).toBe(0);
});
it('derives dynamic feet from scaled mesh bounds and limits reads to actual instances', () => {
  const vertices = new Float32Array(30); vertices.set([-1,-2,-1]); vertices.set([1,2,1],15);
  const instances = new Float32Array([3,5,7,0.4, 2,2,2,0, 1,1,1,0,0,0,0,0]);
  const batch = {vertices, instances, count: 4} as CoreDynamicBatch;
  const data = new SceneContacts().build([], [batch]);
  expect(data.length).toBe(8); expect(data[1]).toBeCloseTo(1.016);
  expect(data[4]).toBe(2); expect(data[5]).toBe(2);
});
