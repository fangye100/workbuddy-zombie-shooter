/**
 * SelectionService —— 选中 / 悬停状态机。
 *
 * 持有选中的物体与子网格下标、悬停高亮，并把「状态变化」翻译成引擎侧的高亮
 * bind group 重建（通过 host.buildSelectionBindGroup / buildHighlightBindGroup）。
 * 状态存于 host.state，本服务只负责读写与触发 GPU 反应（LabRenderer 仍是消费者）。
 */
import type { LabRenderer } from '../renderer';

export class SelectionService {
  constructor(private readonly host: LabRenderer) {}

  /**
   * 选中某物体（null = 取消选中）。会建好白色高亮 bind group。
   * sub 为 null = 选中整个物体（层级树点到父节点）；否则只描那一条子网格的轮廓。
   */
  selectObject(index: number | null, sub: number | null = null): void {
    const s = this.host.state;
    s.selectedIndex = index;
    s.selectedSub = index === null ? null : this.host.clampSub(index, sub);
    for (const o of s.objects) o.selected = false;
    if (index !== null && index >= 0 && index < s.objects.length) {
      s.objects[index]!.selected = true;
      this.host.buildSelectionBindGroup(index);
    } else {
      s.selBindGroup = null;
    }
  }

  getSelected(): number | null {
    return this.host.state.selectedIndex;
  }

  /** 当前选中的子网格下标（null = 整个物体 / 无选中） */
  getSelectedSub(): number | null {
    return this.host.state.selectedSub;
  }

  /**
   * 层级面板悬停高亮。只改索引 + 按需重建一个 bind group：
   * 不重建 UI、不遍历场景、不触发任何面板刷新，鼠标扫过零压力。
   * sub 非 null 时只高亮那一条子网格。
   */
  setHovered(index: number | null, sub: number | null = null): void {
    const s = this.host.state;
    const next = this.isHighlightable(index) ? index : null;
    // 没有目标时子网格下标必须为 null（保持「悬停的是整物体还是某条 mesh」的语义）
    const nextSub = next === null ? null : this.host.clampSub(next, sub);
    if (next === s.hoveredIndex && nextSub === s.hoveredSub) return;
    s.hoveredIndex = next;
    s.hoveredSub = nextSub;
    s.hoverBindGroup =
      next === null
        ? null
        : this.host.buildHighlightBindGroup(next, this.host.core.hoverToonBuf, this.host.core.hoverMatBuf, 'hover');
  }

  getHovered(): number | null {
    return this.host.state.hoveredIndex;
  }

  private isHighlightable(index: number | null): boolean {
    if (index === null) return false;
    const o = this.host.state.objects[index];
    return o !== undefined && !o.removed && o.visible;
  }
}
