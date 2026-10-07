/** Explicit author constraints for held props. Coordinates use the binding source
 * mesh ruler. Applied after diffusion/mirror/smoothing so a rigid prop cannot leak
 * into nearby feet. Later regions win; constraints never alter joint placement. */
import { HUMANIK_ORDER, isTipBone, type Vec3 } from './humanik-template';
import type { SkinWeights } from './binding-math';

export interface RigidSkinRegion {
  name: string;
  bone: string;
  start: Vec3;
  end: Vec3;
  radius: number;
  /** Optional soft boundary, useful where generated props are fused into skin. */
  feather?: number;
  /** Exact selection on the unchanged source mesh, overriding the capsule. */
  vertices?: number[];
  selectionHash?: string;
}
export function skinSelectionHash(vertices: Float32Array): string {
  const bytes = new Uint8Array(vertices.buffer,vertices.byteOffset,vertices.byteLength);
  let hash = 2166136261;
  for (const b of bytes) hash = Math.imul(hash ^ b,16777619);
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8,'0')}`;
}
export function validateRigidRegions(value: unknown, vertexCount?: number): asserts value is RigidSkinRegion[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('刚性部件必须为最多 64 项的数组');
  for (const r of value) {
    if (!r || typeof r !== 'object' || Object.keys(r).some(k => !['name','bone','start','end','radius','feather','vertices','selectionHash'].includes(k)) ||
      typeof r.name !== 'string' || !r.name.trim() || r.name.length > 100 ||
      typeof r.bone !== 'string' || !HUMANIK_ORDER.includes(r.bone) || isTipBone(r.bone) ||
      ![r.start,r.end].every(p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)) ||
      typeof r.radius !== 'number' || !Number.isFinite(r.radius) || r.radius <= 0 || r.radius > 2 ||
      (r.feather !== undefined && (!Number.isFinite(r.feather) || r.feather < 0 || r.feather > 2)) ||
      (r.vertices !== undefined && (!Array.isArray(r.vertices) || !r.vertices.length || r.vertices.length > 200000 ||
        !r.vertices.every((i: number) => Number.isSafeInteger(i) && i >= 0 && (vertexCount === undefined || i < vertexCount)) ||
        typeof r.selectionHash !== 'string' || !/^fnv1a32:[0-9a-f]{8}$/.test(r.selectionHash))))
      throw new Error('刚性部件需要 name、有效变形 bone、start/end 三元坐标和 0..2m 的正 radius');
  }
}
export function applyRigidRegions(skin: SkinWeights, vertices: Float32Array, stride: number, regions: RigidSkinRegion[]): SkinWeights {
  validateRigidRegions(regions, vertices.length/stride);
  if (regions.some(r => r.vertices && r.selectionHash !== skinSelectionHash(vertices))) throw new Error('刚性部件顶点选择与源网格不匹配，请重新选择');
  if (!regions.length) return skin;
  const joints = skin.joints.slice(), weights = skin.weights.slice();
  for (const r of regions) {
    const d = r.end.map((v,k) => v-r.start[k]!), den = d.reduce((s,v)=>s+v*v,0), bone = HUMANIK_ORDER.indexOf(r.bone);
    if (r.vertices) {
      for (const i of r.vertices) { joints.fill(0,i*4,i*4+4); weights.fill(0,i*4,i*4+4); joints[i*4]=bone; weights[i*4]=1; }
      continue;
    }
    for (let i=0;i<vertices.length/stride;i++) {
      const p = [vertices[i*stride]!,vertices[i*stride+1]!,vertices[i*stride+2]!];
      const t = den ? Math.max(0,Math.min(1,d.reduce((s,v,k)=>s+(p[k]!-r.start[k]!)*v,0)/den)) : 0;
      const distance = Math.hypot(...p.map((v,k)=>v-r.start[k]!-t*d[k]!));
      const feather=r.feather ?? 0;
      if (distance > r.radius+feather) continue;
      const f=distance<=r.radius?1:1-(distance-r.radius)/feather, blend=f*f*(3-2*f);
      const accum=new Map<number,number>();
      for(let k=0;k<4;k++)accum.set(joints[i*4+k]!, (accum.get(joints[i*4+k]!)??0)+weights[i*4+k]!*(1-blend));
      accum.set(bone,(accum.get(bone)??0)+blend);
      const rank=[...accum].sort((a,b)=>b[1]-a[1]).slice(0,4),sum=rank.reduce((s,p)=>s+p[1],0);
      joints.fill(0,i*4,i*4+4); weights.fill(0,i*4,i*4+4);
      rank.forEach(([j,w],k)=>{joints[i*4+k]=j;weights[i*4+k]=w/sum;});
    }
  }
  return {joints,weights};
}
