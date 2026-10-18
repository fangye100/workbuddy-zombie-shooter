import {describe,it,expect} from 'vitest';import {rayVisibleMesh} from '../src/mesh-ray';import {nearestSolidContact,solidCollider} from '../src/solid-ray';import {composeQuat} from '@aether/core';
describe('可见接收面与世界法线',()=>{
 it('缩放/倾斜平面返回世界距离，隐藏子网格与背后表面不接收',()=>{
  const vertices=new Float32Array(45);vertices.set([-1,0,-1],0);vertices.set([1,0,-1],15);vertices.set([0,0,1],30);
  const matrix=new Float32Array(16);composeQuat(matrix,2,3,0,[0,0,Math.sin(.2),Math.cos(.2)],1);matrix[0]!*=2;matrix[1]!*=2;
  const input={vertices,indices:new Uint32Array([0,1,2]),matrix,min:[-1,0,-1] as [number,number,number],max:[1,0,1] as [number,number,number],ranges:[{visible:true,indexStart:0,indexCount:3}]};
  const hit=rayVisibleMesh(input,[2,5,0],[0,-1,0],3)!;expect(hit.distance).toBeCloseTo(2);expect(hit.normal[0]).toBeCloseTo(-Math.sin(.4));expect(hit.normal[1]).toBeCloseTo(Math.cos(.4));
  input.ranges[0]!.visible=false;expect(rayVisibleMesh(input,[2,5,0],[0,-1,0],3)).toBeNull();input.ranges[0]!.visible=true;expect(rayVisibleMesh(input,[2,1,0],[0,-1,0],3)).toBeNull();
 });
 it('有限碰撞体保留稳定NodeId与法线，inside不伪造表面',()=>{
  const matrix=new Float32Array(16);composeQuat(matrix,4,0,0,[0,0,0,1],2);const s=solidCollider('wall',{type:'box',halfExtents:[1,1,1]},matrix);
  expect(nearestSolidContact([0,0,0],[1,0,0],[s],9)).toMatchObject({nodeId:'wall',distance:2,point:[2,0,0],normal:[-1,0,0]});expect(nearestSolidContact([4,0,0],[1,0,0],[s],9)).toBeNull();
 });
});
