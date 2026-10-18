/** Finite scene solids. Navigation projections are deliberately not shot geometry. */
import { invert, rayAabb } from '@aether/core';
import type { Mat4 } from '@aether/core';
import { rayCapsuleY, raySphere } from '@aether/gameplay';
import type { ColliderComponent, NodeId } from '@aether/scene';
export interface SolidColliderDesc {
  nodeId: NodeId;
  /** Local centered box/sphere, or centered Y capsule with total height. */
  shape: ColliderComponent['shape'];
  worldToLocal: Mat4;
}
type V3 = readonly [number, number, number];

export function solidCollider(nodeId: NodeId, shape: ColliderComponent['shape'], world: Mat4): SolidColliderDesc {
  const determinant = world[0]! * (world[5]! * world[10]! - world[9]! * world[6]!)
    - world[4]! * (world[1]! * world[10]! - world[9]! * world[2]!)
    + world[8]! * (world[1]! * world[6]! - world[5]! * world[2]!);
  if (!world.every(Number.isFinite) || !Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error('碰撞体世界变换不可逆，无法精确判断子弹遮挡');
  if (!['box', 'sphere', 'capsule'].includes(shape.type)) throw new Error('不支持的子弹遮挡形状');
  const size = shape.type === 'box' ? shape.halfExtents : shape.type === 'capsule' ? [shape.radius, shape.height] : [shape.radius];
  if (!size.every((x) => Number.isFinite(x) && x > 0)) throw new Error('碰撞体尺寸必须为有限正数');
  const worldToLocal = invert(new Float32Array(16), world);
  if (!worldToLocal.every(Number.isFinite)) throw new Error('碰撞体逆矩阵不可表示');
  return { nodeId, shape: JSON.parse(JSON.stringify(shape)) as ColliderComponent['shape'], worldToLocal };
}

/** Unit world direction -> world distance for the supplied SceneGraph world matrix.
 * Parent transforms follow the graph's established TRS composition. */
export function raySolid(origin: V3, direction: V3, solid: SolidColliderDesc, sweepRadius=0): number | null {
  const m = solid.worldToLocal;
  const transform = (v: V3, point: boolean): [number, number, number] => [
    m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2] + (point ? m[12]! : 0),
    m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2] + (point ? m[13]! : 0),
    m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2] + (point ? m[14]! : 0),
  ];
  const o = transform(origin, true); const vector = transform(direction, false);
  const length = Math.hypot(...vector);
  if (!Number.isFinite(length) || length <= 0) return null;
  const d: [number, number, number] = [vector[0] / length, vector[1] / length, vector[2] / length];
  const s = solid.shape; let hit: number | null;
  const inflate:[number,number,number]=[Math.hypot(m[0]!,m[4]!,m[8]!),Math.hypot(m[1]!,m[5]!,m[9]!),Math.hypot(m[2]!,m[6]!,m[10]!)].map(n=>n*sweepRadius) as [number,number,number];
  const radial=Math.max(...inflate);
  if (s.type === 'box') {
    // Conservative Minkowski bounds for swept spheres; exact finite solids for ordinary rays.
    const h = s.halfExtents.map((n,i)=>n+inflate[i]!) as [number,number,number];
    const t = rayAabb(...o, ...d, [-h[0], -h[1], -h[2]], h);
    hit = t < 0 ? null : t;
  } else if (s.type === 'sphere') {
    if (Math.hypot(...o) <= s.radius+radial) return 0;
    hit = raySphere(o, d, 0, 0, 0, s.radius+radial);
  } else {
    const halfSegment = Math.max(0, s.height / 2 - s.radius);
    const closestY = Math.max(-halfSegment, Math.min(halfSegment, o[1]));
    if (Math.hypot(o[0], o[1] - closestY, o[2]) <= s.radius+radial) return 0;
    const height = 2 * (halfSegment + s.radius+radial);
    hit = rayCapsuleY([o[0], o[1] + height / 2, o[2]], d, 0, 0, s.radius+radial, height);
  }
  return hit === null ? null : hit / length;
}

export function nearestSolidHit(origin: V3, direction: V3, solids: readonly SolidColliderDesc[], range: number,sweepRadius=0): number | null {
  let nearest = Infinity;
  for (const solid of solids) {
    const hit = raySolid(origin, direction, solid,sweepRadius);
    if (hit !== null && hit <= range && hit < nearest) nearest = hit;
  }
  return nearest === Infinity ? null : nearest;
}

export interface SolidContact { nodeId: NodeId; distance: number; point: [number, number, number]; normal: [number, number, number] }
/** Surface normal uses inverse transpose, including nonuniform/parent scale. */
export function nearestSolidContact(origin: V3, direction: V3, solids: readonly SolidColliderDesc[], range: number, sweepRadius=0): SolidContact | null {
  let result: SolidContact | null = null;
  for (const solid of solids) {
    const distance = raySolid(origin, direction, solid, sweepRadius);
    if (distance === null || distance > range || result && distance >= result.distance) continue;
    const point = origin.map((v,i) => v + direction[i]! * distance) as [number,number,number], m = solid.worldToLocal;
    const local = [m[0]!*point[0]+m[4]!*point[1]+m[8]!*point[2]+m[12]!, m[1]!*point[0]+m[5]!*point[1]+m[9]!*point[2]+m[13]!, m[2]!*point[0]+m[6]!*point[1]+m[10]!*point[2]+m[14]!];
    const s = solid.shape; let n = [...local];
    if (s.type === 'box') {
      const axis = [0,1,2].reduce((a,b) => Math.abs(Math.abs(local[b]!)-s.halfExtents[b]!) < Math.abs(Math.abs(local[a]!)-s.halfExtents[a]!) ? b : a);
      n = [0,0,0]; n[axis] = Math.sign(local[axis]!) || 1;
    } else if (s.type === 'capsule') { const h = Math.max(0,s.height/2-s.radius); n[1] = local[1]!-Math.max(-h,Math.min(h,local[1]!)); }
    const normal: [number,number,number] = [m[0]!*n[0]!+m[1]!*n[1]!+m[2]!*n[2]!,m[4]!*n[0]!+m[5]!*n[1]!+m[6]!*n[2]!,m[8]!*n[0]!+m[9]!*n[1]!+m[10]!*n[2]!];
    const length = Math.hypot(...normal);
    for(let i=0;i<3;i++) normal[i] = length > 1e-9 ? normal[i]!/length : -direction[i]!;
    result = { nodeId:solid.nodeId, distance, point, normal };
  }
  return result;
}
