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
export function raySolid(origin: V3, direction: V3, solid: SolidColliderDesc): number | null {
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
  if (s.type === 'box') {
    const h = s.halfExtents;
    const t = rayAabb(...o, ...d, [-h[0], -h[1], -h[2]], h);
    hit = t < 0 ? null : t;
  } else if (s.type === 'sphere') {
    if (Math.hypot(...o) <= s.radius) return 0;
    hit = raySphere(o, d, 0, 0, 0, s.radius);
  } else {
    const halfSegment = Math.max(0, s.height / 2 - s.radius);
    const closestY = Math.max(-halfSegment, Math.min(halfSegment, o[1]));
    if (Math.hypot(o[0], o[1] - closestY, o[2]) <= s.radius) return 0;
    const height = 2 * (halfSegment + s.radius);
    hit = rayCapsuleY([o[0], o[1] + height / 2, o[2]], d, 0, 0, s.radius, height);
  }
  return hit === null ? null : hit / length;
}

export function nearestSolidHit(origin: V3, direction: V3, solids: readonly SolidColliderDesc[], range: number): number | null {
  let nearest = Infinity;
  for (const solid of solids) {
    const hit = raySolid(origin, direction, solid);
    if (hit !== null && hit <= range && hit < nearest) nearest = hit;
  }
  return nearest === Infinity ? null : nearest;
}
