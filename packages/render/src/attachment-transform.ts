/** 中性刚性 socket 数学。无游戏状态、动作、时钟或资产加载。 */
import { mat4, composeQuat, quatMul, type Quat } from '@aether/core';
import type { SocketTransform } from '@aether/scene';
import { rotateVec3 } from './two-bone-ik';
export const inverseRotation=(q:Quat):Quat=>[-q[0],-q[1],-q[2],q[3]];
export function composeSocket(a:SocketTransform,b:SocketTransform):SocketTransform {
  const p=rotateVec3(a.rotation,b.position);
  return {position:p.map((n,i)=>n+a.position[i]!) as [number,number,number],rotation:[...quatMul(a.rotation,b.rotation)]};
}
export function inverseSocket(a:SocketTransform):SocketTransform {
  const q=inverseRotation(a.rotation);
  return {position:[...rotateVec3(q,[-a.position[0],-a.position[1],-a.position[2]])],rotation:[...q]};
}
/** H·contact·inverse(modelSocket)，包括实际 partial/reach-clamped 的 H。 */
export function attachedModelFrame(hand:SocketTransform,contact:SocketTransform,modelSocket:SocketTransform):SocketTransform {
  return composeSocket(composeSocket(hand,contact),inverseSocket(modelSocket));
}
export function socketMatrix(frame:SocketTransform,scale=1):Float32Array<ArrayBuffer> {
  const m=mat4();composeQuat(m,...frame.position,frame.rotation,scale);return m;
}
/** 返回平移及去掉正均匀尺度的方向；拒绝镜像、非均匀尺度与 shear。 */
export function rigidFromMatrix(m:Float32Array):SocketTransform|null {
  if(m.length!==16||!Array.from(m).every(Number.isFinite))return null;
  const columns=[0,4,8].map(i=>[m[i]!,m[i+1]!,m[i+2]!]),s=columns.map(c=>Math.hypot(...c));
  if(s[0]!<=1e-9||s.some(x=>Math.abs(x-s[0]!)>s[0]!*1e-5))return null;
  const c=columns.map(v=>v.map(x=>x/s[0]!));
  const dot=(a:number[],b:number[])=>a.reduce((n,v,i)=>n+v*b[i]!,0);
  if(Math.abs(dot(c[0]!,c[1]!))>1e-5||Math.abs(dot(c[0]!,c[2]!))>1e-5||Math.abs(dot(c[1]!,c[2]!))>1e-5)return null;
  const det=c[0]![0]!*(c[1]![1]!*c[2]![2]!-c[1]![2]!*c[2]![1]!)-c[1]![0]!*(c[0]![1]!*c[2]![2]!-c[0]![2]!*c[2]![1]!)+c[2]![0]!*(c[0]![1]!*c[1]![2]!-c[0]![2]!*c[1]![1]!);
  if(det<.99999)return null;
  const [a,b,d]=c as [number[],number[],number[]],trace=a[0]!+b[1]!+d[2]!;
  let q:number[];
  if(trace>0){const t=Math.sqrt(trace+1)*2;q=[(b[2]!-d[1]!)/t,(d[0]!-a[2]!)/t,(a[1]!-b[0]!)/t,t/4];}
  else if(a[0]!>b[1]!&&a[0]!>d[2]!){const t=Math.sqrt(1+a[0]!-b[1]!-d[2]!)*2;q=[t/4,(b[0]!+a[1]!)/t,(d[0]!+a[2]!)/t,(b[2]!-d[1]!)/t];}
  else if(b[1]!>d[2]!){const t=Math.sqrt(1+b[1]!-a[0]!-d[2]!)*2;q=[(b[0]!+a[1]!)/t,t/4,(d[1]!+b[2]!)/t,(d[0]!-a[2]!)/t];}
  else{const t=Math.sqrt(1+d[2]!-a[0]!-b[1]!)*2;q=[(d[0]!+a[2]!)/t,(d[1]!+b[2]!)/t,t/4,(a[1]!-b[0]!)/t];}
  const length=Math.hypot(...q);
  return {position:[m[12]!,m[13]!,m[14]!],rotation:q.map(x=>x/length) as [number,number,number,number]};
}
