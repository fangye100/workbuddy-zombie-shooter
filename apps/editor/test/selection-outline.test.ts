import { describe, expect, it } from 'vitest';
import { buildSelectionOutline } from '../src/features/selection-outline.feature';
import type { LabRenderer } from '../src/renderer';

/**
 * 这是「编辑器语义 → 引擎中性槽位」的**唯一翻译点**（L-2，2026-09-03）。
 *
 * 引擎侧只知道 primary / secondary 两层高亮（`CoreHighlight`），
 * selected / hovered 这套交互词汇必须在 `buildSelectionOutline` 这里就翻译完。
 * 这个测试钉死的是翻译规则本身 —— 尤其「悬停与选中同物体时不再画第二层」，
 * 这条在引擎里是 `!isPrimary` 的短路，改错了不会有编译错误，只会多画一圈描边。
 */

const BG_A = { label: 'a' } as unknown as GPUBindGroup;
const BG_B = { label: 'b' } as unknown as GPUBindGroup;

function fakeHost(s: {
  selectedIndex?: number | null;
  selectedSub?: number | null;
  hoveredIndex?: number | null;
  hoveredSub?: number | null;
  selBindGroup?: GPUBindGroup | null;
  hoverBindGroup?: GPUBindGroup | null;
}): LabRenderer {
  return {
    state: {
      selectedIndex: s.selectedIndex ?? null,
      selectedSub: s.selectedSub ?? null,
      hoveredIndex: s.hoveredIndex ?? null,
      hoveredSub: s.hoveredSub ?? null,
      selBindGroup: s.selBindGroup ?? null,
      hoverBindGroup: s.hoverBindGroup ?? null,
    },
  } as unknown as LabRenderer;
}

describe('buildSelectionOutline · 编辑器语义 → 引擎中性槽位', () => {
  it('只有选中时：第一层有值，第二层为 null', () => {
    const h = buildSelectionOutline(
      fakeHost({ selectedIndex: 3, selectedSub: 1, selBindGroup: BG_A }),
    );
    expect(h.primary).toEqual({ objIndex: 3, sub: 1, bindGroup: BG_A });
    expect(h.secondary).toBeNull();
  });

  it('只有悬停时：第一层为 null，第二层有值', () => {
    const h = buildSelectionOutline(
      fakeHost({ hoveredIndex: 5, hoveredSub: null, hoverBindGroup: BG_B }),
    );
    expect(h.primary).toBeNull();
    expect(h.secondary).toEqual({ objIndex: 5, sub: null, bindGroup: BG_B });
  });

  it('悬停与选中是同一物体时：第二层必须让位（否则会多画一圈描边）', () => {
    const h = buildSelectionOutline(
      fakeHost({
        selectedIndex: 2,
        hoveredIndex: 2,
        selBindGroup: BG_A,
        hoverBindGroup: BG_B,
      }),
    );
    expect(h.primary).not.toBeNull();
    expect(h.secondary).toBeNull();
  });

  it('选中与悬停是不同物体时：两层并存，索引各归各位', () => {
    const h = buildSelectionOutline(
      fakeHost({
        selectedIndex: 2,
        selectedSub: 0,
        hoveredIndex: 7,
        hoveredSub: 3,
        selBindGroup: BG_A,
        hoverBindGroup: BG_B,
      }),
    );
    expect(h.primary).toEqual({ objIndex: 2, sub: 0, bindGroup: BG_A });
    expect(h.secondary).toEqual({ objIndex: 7, sub: 3, bindGroup: BG_B });
  });

  it('状态有值但 bind group 还没建好时：该层退化为 null（引擎不允许空 bindGroup）', () => {
    const h = buildSelectionOutline(
      fakeHost({ selectedIndex: 1, hoveredIndex: 4, hoverBindGroup: BG_B }),
    );
    expect(h.primary).toBeNull();
    expect(h.secondary).toEqual({ objIndex: 4, sub: null, bindGroup: BG_B });
  });

  it('全空场景：两层都是 null，不产生任何高亮绘制', () => {
    const h = buildSelectionOutline(fakeHost({}));
    expect(h.primary).toBeNull();
    expect(h.secondary).toBeNull();
  });

  it('产出的键只有 primary / secondary —— 编辑器语义词不得越过这条边界', () => {
    const h = buildSelectionOutline(
      fakeHost({
        selectedIndex: 1,
        hoveredIndex: 2,
        selBindGroup: BG_A,
        hoverBindGroup: BG_B,
      }),
    ) as unknown as Record<string, unknown>;
    expect(Object.keys(h).sort()).toEqual(['primary', 'secondary']);
  });
});
