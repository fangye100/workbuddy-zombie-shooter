/**
 * PickingService —— 屏幕 ↔ 世界拾取与投影。
 *
 * pointerRay（屏幕坐标 → 世界射线）、worldToScreen（世界 → 屏幕像素）、
 * pickAtAll / pickAt（逐三角形命中测试，穿透循环用）。相机矩阵由 core 提供，
 * 物体表与 canvas 矩形缓存走 host.state / host.canvasRect。
 */
import * as m4 from '@aether/core';
import type { LabRenderer } from '../renderer';
import { pointInAabb } from '../renderer';

export class PickingService {
  constructor(private readonly host: LabRenderer) {}

  /** 当前帧相机世界坐标（用于 gizmo 拖拽平面定向） */
  getEye(): [number, number, number] {
    return [this.host.core.eyeVec[0], this.host.core.eyeVec[1], this.host.core.eyeVec[2]];
  }

  /** 指针屏幕坐标 → 世界射线（near=o，远点用于求方向）。client 取 canvas 实时矩形换算 NDC */
  pointerRay(clientX: number, clientY: number): { o: [number, number, number]; d: [number, number, number] } | null {
    const rect = this.host.canvasRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    const near = this.host.unproject(this.host.core.invViewProj, ndcX, ndcY, 0);
    const far = this.host.unproject(this.host.core.invViewProj, ndcX, ndcY, 1);
    let dx = far[0] - near[0];
    let dy = far[1] - near[1];
    let dz = far[2] - near[2];
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl;
    dy /= dl;
    dz /= dl;
    return { o: near, d: [dx, dy, dz] };
  }

  /** 世界坐标 → 屏幕像素（clientX/clientY 同一坐标系）。behind=true 表示在相机背后（投影翻转，不可用于命中） */
  worldToScreen(p: readonly [number, number, number]): { x: number; y: number; behind: boolean } {
    const m = this.host.core.viewProj;
    const cx = m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!;
    const cy = m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!;
    const cw = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!;
    const rect = this.host.canvasRect();
    if (Math.abs(cw) < 1e-9) return { x: rect.left, y: rect.top, behind: true };
    const ndcX = cx / cw;
    const ndcY = cy / cw;
    return {
      x: rect.left + ((ndcX + 1) / 2) * rect.width,
      y: rect.top + ((1 - (ndcY + 1) / 2)) * rect.height,
      behind: cw <= 0,
    };
  }

  /**
   * 鼠标 NDC（x,y ∈ [-1,1]，y 已翻转）反投影成世界射线，与所有可拾取物体逐三角形求交，
   * 返回命中列表（每物体取最小 t），按距离近→远排序。穿透拾取（Alt+点击循环）用。
   */
  pickAtAll(ndcX: number, ndcY: number): { index: number; t: number }[] {
    const near = this.host.unproject(this.host.core.invViewProj, ndcX, ndcY, 0);
    const far = this.host.unproject(this.host.core.invViewProj, ndcX, ndcY, 1);
    const ox = this.host.core.eyeVec[0];
    const oy = this.host.core.eyeVec[1];
    const oz = this.host.core.eyeVec[2];
    let dx = far[0] - near[0];
    let dy = far[1] - near[1];
    let dz = far[2] - near[2];
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl;
    dy /= dl;
    dz /= dl;

    const best = new Map<number, number>(); // 物体索引 → 该物体最小命中 t
    const objects = this.host.state.objects;
    for (let i = 0; i < objects.length; i++) {
      const o = objects[i]!;
      if (!o.pickable || o.removed || !o.visible || o.background) continue;
      const M = o.modelMatrix;
      // 预剔除：先把局部 AABB 变到世界空间（8 个角点），射线打不中这个盒子就跳过逐三角形求交。
      // 场景里物体一多、或导入 80k 面高模后，这一步能省掉绝大多数三角形测试。
      {
        const bb = this.host.worldAabb(o);
        if (
          m4.rayAabb(ox, oy, oz, dx, dy, dz, bb.min, bb.max) < 0 &&
          !pointInAabb(ox, oy, oz, bb.min, bb.max)
        ) {
          continue;
        }
      }
      const idx = o.mesh.indices;
      const v = o.mesh.vertices;
      // 逐子网格求交，跳过隐藏的那几条 —— 与渲染一致：
      // 画面上看不见的 mesh 绝不该被点中（否则 Alt 穿透循环会「选中空气」）
      for (const sm of o.subMeshes) {
        if (!sm.visible) continue;
        const end = Math.min(sm.indexStart + sm.indexCount, idx.length);
        for (let t = sm.indexStart; t < end; t += 3) {
          const a = idx[t]!;
          const b = idx[t + 1]!;
          const c = idx[t + 2]!;
          // 局部顶点 → 世界（w=1，无需透视除法）
          const ax = v[a * 15]!;
          const ay = v[a * 15 + 1]!;
          const az = v[a * 15 + 2]!;
          const bx = v[b * 15]!;
          const by = v[b * 15 + 1]!;
          const bz = v[b * 15 + 2]!;
          const cx = v[c * 15]!;
          const cy = v[c * 15 + 1]!;
          const cz = v[c * 15 + 2]!;
          const awx = M[0]! * ax + M[4]! * ay + M[8]! * az + M[12]!;
          const awy = M[1]! * ax + M[5]! * ay + M[9]! * az + M[13]!;
          const awz = M[2]! * ax + M[6]! * ay + M[10]! * az + M[14]!;
          const bwx = M[0]! * bx + M[4]! * by + M[8]! * bz + M[12]!;
          const bwy = M[1]! * bx + M[5]! * by + M[9]! * bz + M[13]!;
          const bwz = M[2]! * bx + M[6]! * by + M[10]! * bz + M[14]!;
          const cwx = M[0]! * cx + M[4]! * cy + M[8]! * cz + M[12]!;
          const cwy = M[1]! * cx + M[5]! * cy + M[9]! * cz + M[13]!;
          const cwz = M[2]! * cx + M[6]! * cy + M[10]! * cz + M[14]!;
          const tHit = m4.rayTri(ox, oy, oz, dx, dy, dz, awx, awy, awz, bwx, bwy, bwz, cwx, cwy, cwz);
          if (tHit > 1e-4 && tHit < (best.get(i) ?? Infinity)) {
            best.set(i, tHit);
          }
        }
      }
    }
    return [...best.entries()].map(([index, t]) => ({ index, t })).sort((a, b) => a.t - b.t);
  }

  /** 最近命中物体索引（普通点击拾取） */
  pickAt(ndcX: number, ndcY: number): number | null {
    return this.pickAtAll(ndcX, ndcY)[0]?.index ?? null;
  }
}
