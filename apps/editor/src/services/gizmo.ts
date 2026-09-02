/**
 * GizmoService —— gizmo 交互状态 + 物体变换读写（transform 写回）+ 选中物体检视读数。
 *
 * gizmo 模式 / 空间 / 激活轴只持有交互状态，几何与管线在 core；getGizmoInfo 把当前帧
 * 算好的 gizmo 变换信息（来自 core）连同编辑器模式一起交给 main 做命中测试与拖拽。
 * setObjectPos/RotDeg/Quat/Scale 写回物体的 pos/rot/quat/scale（旋转真源是 quat）。
 */
import * as m4 from '@aether/core';
import type { LabRenderer } from '../renderer';
import type { GizmoMode, GizmoSpace } from '@aether/render';
import { meshStats } from '@aether/scene';

export class GizmoService {
  constructor(private readonly host: LabRenderer) {}

  /** 读选中物体的旋转四元数（gizmo 旋转需要） */
  getObjectQuat(index: number): m4.Quat | null {
    const o = this.host.state.objects[index];
    return o === undefined ? null : o.quat;
  }

  /** 读选中物体的可编辑状态（面板用） */
  getObjectState(index: number): {
    name: string;
    pos: [number, number, number];
    rot: [number, number, number];
    scale: number;
    materialIndex: number;
    stats: { vertices: number; triangles: number; boundaryEdges: number; components: number };
  } | null {
    const o = this.host.state.objects[index];
    if (o === undefined) return null;
    return {
      name: o.name,
      pos: [o.pos[0], o.pos[1], o.pos[2]],
      rot: [o.rot[0], o.rot[1], o.rot[2]],
      scale: o.scale,
      materialIndex: o.materialIndex,
      stats: meshStats(o.mesh),
    };
  }

  /** 子网格数量（层级面板据此决定能不能展开、材质面板据此自动落到唯一的 mesh 上） */
  getSubMeshCount(index: number): number {
    return this.host.state.objects[index]?.subMeshes.length ?? 0;
  }

  setObjectPos(index: number, axis: 0 | 1 | 2, v: number): void {
    const o = this.host.state.objects[index];
    if (o !== undefined) o.pos[axis] = v;
  }

  /**
   * 设置欧拉角分量。**注意入参单位是度**（面板滑块用度），内部 rot 始终存弧度 ——
   * 单位边界容易出错，所以函数名直接把 Deg 写出来；旋转真源是 quat，改完会同步重建。
   */
  setObjectRotDeg(index: number, axis: 0 | 1 | 2, deg: number): void {
    const o = this.host.state.objects[index];
    if (o !== undefined) {
      o.rot[axis] = (deg * Math.PI) / 180;
      o.quat = m4.eulerToQuat(o.rot[0], o.rot[1], o.rot[2]);
    }
  }

  /** gizmo 旋转：直接写入四元数，并把 rot 同步成欧拉角供面板显示 */
  setObjectQuat(index: number, q: m4.Quat): void {
    const o = this.host.state.objects[index];
    if (o !== undefined) {
      o.quat = q;
      o.rot = m4.quatToEuler(q);
    }
  }

  setGizmoMode(mode: GizmoMode): void {
    this.host.state.gizmoMode = mode;
  }

  setGizmoSpace(space: GizmoSpace): void {
    this.host.state.gizmoSpace = space;
  }

  setGizmoActiveAxis(axis: number | null): void {
    this.host.state.gizmoActiveAxis = axis;
  }

  /**
   * 返回当前帧算好的 gizmo 变换信息，供 main.ts 做命中测试与拖拽。
   * 无选中时返回 null。
   */
  getGizmoInfo():
    | {
        model: m4.Mat4;
        k: number;
        origin: [number, number, number];
        axes: [number, number, number][];
        mode: GizmoMode;
        space: GizmoSpace;
      }
    | null {
    const s = this.host.state;
    if (s.selectedIndex === null) return null;
    return {
      model: this.host.core.gizmoModel,
      k: this.host.core.gizmoK,
      origin: this.host.core.gizmoOrigin,
      axes: this.host.core.gizmoAxes,
      mode: s.gizmoMode,
      space: s.gizmoSpace,
    };
  }

  setObjectScale(index: number, v: number): void {
    const o = this.host.state.objects[index];
    if (o !== undefined) o.scale = Math.max(0.01, v);
  }
}
