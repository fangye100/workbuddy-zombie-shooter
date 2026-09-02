/**
 * gizmo.feature —— 组装 Transform Gizmo 的 CoreGizmo。
 *
 * 从 host.state 读取选中物体与 gizmo 交互状态，连同物体的世界原点与（local 空间下的）
 * 旋转四元数，产出 CoreGizmo 交给 RendererCore。几何 / 命中测试在 core，编辑器只装箱语义。
 * 同样不引入 registerFeature 钩子，packages/render 零改动。
 */
import * as m4 from '@aether/core';
import type { LabRenderer } from '../renderer';
import type { CoreGizmo } from '@aether/render';

export function buildGizmo(host: LabRenderer): CoreGizmo | null {
  const s = host.state;
  const selIdx = s.selectedIndex;
  if (selIdx === null) return null;
  const o = s.objects[selIdx];
  if (o === undefined || o.removed || !o.visible) return null;
  const origin: [number, number, number] = [o.pos[0], o.pos[1], o.pos[2]];
  const q: m4.Quat = s.gizmoSpace === 'local' ? o.quat : [0, 0, 0, 1];
  return { origin, quat: q, mode: s.gizmoMode, activeAxis: s.gizmoActiveAxis };
}
