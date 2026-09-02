/**
 * selection-outline.feature —— 组装选中 / 悬停高亮的 CoreHighlight。
 *
 * 这是编辑器侧的 feature：从 host.state 读取选中 / 悬停状态与已建好的高亮 bind group，
 * 产出一份 CoreHighlight 交给 RendererCore。不引入 registerFeature 运行时钩子，
 * packages/render 零改动（ADR-001：编辑器是消费者）。
 */
import type { LabRenderer } from '../renderer';
import type { CoreHighlight } from '@aether/render';

export function buildSelectionOutline(host: LabRenderer): CoreHighlight {
  const s = host.state;
  const selIdx = s.selectedIndex;
  const selSub = s.selectedSub;
  const hovIdx = s.hoveredIndex;
  const hovSub = s.hoveredSub;
  const selBg = s.selBindGroup;
  const hovBg = s.hoverBindGroup;
  return {
    selected:
      selIdx !== null && selBg !== null
        ? { objIndex: selIdx, sub: selSub, bindGroup: selBg }
        : null,
    hovered:
      hovIdx !== null && hovIdx !== selIdx && hovBg !== null
        ? { objIndex: hovIdx, sub: hovSub, bindGroup: hovBg }
        : null,
  };
}
