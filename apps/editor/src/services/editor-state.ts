/**
 * EditorState —— 编辑器拥有的全部可变状态。
 *
 * 把原先散落在 LabRenderer 上的「场景语义」状态（物体表 / 选中悬停 / gizmo 交互 /
 * 材质库 / 帧计数等）集中到这里。LabRenderer 的 render() 与 GPU 装箱逻辑仍读
 * `this.state.*`，services 通过 `host.state` 读写。这样状态有单一真源，
 * services 抽取时不需要把状态在 LabRenderer 与服务间来回搬（ADR-001：编辑器是消费者）。
 */
import type { GizmoMode, GizmoSpace, MatchReportEntry } from '@aether/render';
import { MaterialLibrary } from '../materials';
import { defaultParams, type LabParams } from '../params';
import type { SceneObject, RenderStats } from '../renderer';

export class EditorState {
  /** 场景全部物体（墓碑用 removed 标记，下标恒定以稳定 uniform 槽位） */
  objects: SceneObject[] = [];
  /** 参数引用：材质 API 按 id 回查共享材质（引用恒定，无拷贝） */
  params: LabParams = defaultParams();

  /** 选中物体索引；null = 无选中 */
  selectedIndex: number | null = null;
  /** 选中的子网格下标；null = 选中整个物体（层级树点到父节点） */
  selectedSub: number | null = null;
  /** 选中高亮 bind group（白色细描边），null = 无选中 */
  selBindGroup: GPUBindGroup | null = null;

  /** 层级面板悬停高亮的物体索引（与选中白线区分开），null = 无悬停 */
  hoveredIndex: number | null = null;
  /** 悬停的子网格下标；null = 整个物体 */
  hoveredSub: number | null = null;
  /** 层级面板悬停高亮 bind group（尸绿），null = 无悬停 */
  hoverBindGroup: GPUBindGroup | null = null;

  /** 每个「子网格」一个 bind group（依赖 core 布局，换模型后整体重建） */
  bindGroups: GPUBindGroup[][] = [];

  /** Transform Gizmo 交互状态（几何 / 管线 / 资源在 core，这里只持有模式） */
  gizmoMode: GizmoMode = 'translate';
  gizmoSpace: GizmoSpace = 'world';
  gizmoActiveAxis: number | null = null;

  /** HUD / 面板统计 */
  stats: RenderStats = { width: 0, height: 0, drawCalls: 0, triangles: 0 };

  /** 帧序号：canvas 矩形缓存按帧失效 */
  frameCounter = 0;
  /** 上一帧时间（秒），动画推进 dt 用；-1 = 首帧 */
  lastFrameTime = -1;

  /** 最近一次换模型绑定继承报告（模型信息行展示）；无继承动作时 null */
  lastMatchReport: MatchReportEntry[] | null = null;

  /** canvas 矩形缓存（每帧最多量一次，避免悬停时反复 getBoundingClientRect） */
  cachedRect: DOMRect | null = null;
  cacheFrame = -1;

  /** 材质库（用户实例）；共享材质仍在 params.materials 里，按 id 回查 */
  library = new MaterialLibrary();
}
