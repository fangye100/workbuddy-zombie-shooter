import { it, expect } from 'vitest';
import { SceneContacts } from '../src/services/scene-contacts';
import { DYNAMIC_INSTANCE_FLOATS, type CoreDynamicBatch } from '@aether/render';

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
  const instances = new Float32Array(DYNAMIC_INSTANCE_FLOATS); instances.set([3,5,7,0.4, 2,2,2,0]);
  const batch = {vertices, instances, count: 4} as CoreDynamicBatch;
  const data = new SceneContacts().build([], [batch]);
  expect(data.length).toBe(8); expect(data[1]).toBeCloseTo(1.016);
  expect(data[4]).toBe(2); expect(data[5]).toBe(2);
});
it('动画与过渡字段不会被下一只 NPC 当作位置和缩放，丢弃不完整的末行', () => {
  const vertices = new Float32Array(30); vertices.set([-1,-2,-1]); vertices.set([1,2,1],15);
  const instances = new Float32Array(DYNAMIC_INSTANCE_FLOATS*2+DYNAMIC_INSTANCE_FLOATS-1);
  instances.set([3,5,7,.4,2,2,2,8192,1,1,1,900,120,.7,1,28,.9,65536,999,888]);
  instances.set([30,4,40,-.8,3,1,4,8192,1,1,1,1000,120,.4,1,28,.8,65536,777,666],DYNAMIC_INSTANCE_FLOATS);
  instances.fill(10000,DYNAMIC_INSTANCE_FLOATS*2);
  const batch = {vertices,instances,count:3} as CoreDynamicBatch;
  const data = new SceneContacts().build([], [batch]);
  expect(data.length).toBe(16);
  expect(Array.from(data.slice(0,1))).toEqual([3]); expect(data[1]).toBeCloseTo(1.016);
  expect(data[2]).toBe(7); expect(data[4]).toBe(2); expect(data[5]).toBe(2);
  expect(data[8]).toBe(30); expect(data[9]).toBeCloseTo(2.016);
  expect(data[10]).toBe(40); expect(data[12]).toBe(3); expect(data[13]).toBe(4);
  expect(new SceneContacts().build([], [{...batch,count:1}])).toHaveLength(8);
  expect(new SceneContacts().build([], [{...batch,instances:new Float32Array(DYNAMIC_INSTANCE_FLOATS-1)}])).toHaveLength(0);
});
