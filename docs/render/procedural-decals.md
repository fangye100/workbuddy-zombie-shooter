# 程序性表面贴花

2026-10-13；首期基线 `384b381` / schema v19；独立视觉复审及类型扩充基线 `d18cfb7` / 当前 schema v20。
分支 `codex/procedural-decals-20261013`。
首期是显式平面痕迹，不是跨墙角投影或完整材质 DBuffer。所有颜色经过现有 HDR 后处理。

## 归属与持久化

| Owner | 真源与职责 |
|---|---|
| Framework / Scene | `packages/scene/src/decals.ts`、`document.ts`、`migrate.ts`：图案、局部变换、稳定 mark id、v18→v19 迁移及诊断 |
| Framework / Render | `decal-instances.ts`：通用有界池和打包；`procedural-decals.ts`：WGSL 与 GPU 实例批；`renderer-core.ts`：帧编码和资源释放 |
| Editor | `services/runtime-decals.ts`：稳定 NodeId 接收者、权威 tick、Play 生命周期；`renderer.ts`：提供接收物的实际可见世界矩阵；MCP 传输不拥有第二份场景 |
| Editor / 可视化工作区 | `services/decal-workbench.ts`：独立参数 UI；`decal-draft.ts`：隔离草稿、稳定接收者和并发冲突检查；Framework 的 `decal-preview.ts` 复用场景贴花 SDF 管线 |
| Game / Content | 第一层街道的 24 个作者痕迹来自场景；本期没有增加伤害规则或自动生成 NPC 血迹/弹孔的玩法策略 |

`Decal` 组件挂在既有静态 `MeshRenderer` 接收节点。`marks[]` 每项持有稳定 `id`、
`pattern`、局部 `position/rotation`、`size`、`color/opacity`、`seed`、`normalOffset`、
`priority`；实例身份是 `receiver NodeId + mark id`，不使用数组下标跨节点引用。
因此不增加 mesh、材质或静态物件槽，也不扩宽 64 节点/物件契约。

平面在 mark 的局部 XZ，法线为 +Y；四元数可以转到墙面。节点世界矩阵包含父级及运行
物体变换，接收者隐藏或缺失时不绘制。局部尺寸随接收者变换，法线偏移保持世界米制。
LOD 改变不重新生成痕迹；需要作者保证指定平面仍贴合其 LOD 表面。

图案：`splatter`、`scorch`、`crack`、`hazard`、`bullet-hole`、`acid`、`oil`、`paper`、`rubble`。WGSL 直接生成覆盖与漫画
墨边/网点；同一 seed 保持图案稳定，无贴图 IO、纹理分配或隔离图集的静默解禁。
现有 VFX 图集仍按原 quarantine 状态处理，未来图集接入需单独透明/mip 验收。

每项尺寸 0.01–100m、opacity 0–1、seed 整数 0–65535、法线偏移 0.001–0.05m、
priority 整数 -100–100。重复 id、非法值、未启用/非静态接收者以及全场作者痕迹超过
512 均产出 `E_DECAL_*`；不静默截断。v18→19 和 v19→20 迁移深复制旧内容，仅升级版本；
不会向旧作者 marks 注入形态字段，也不编造游戏事件。

## 图案覆盖与形态参数

独立视觉/VFX 子代理对照 `docs/31` 的 DEC 系列和 `docs/38` 酸液残留要求，判定旧五类
不足，最小补齐酸液、油污、散纸、碎石。九类覆盖本次已声明的静态表面痕迹需求；瞬时
闪光、飞行酸团、爆炸和危险预警仍归战斗 VFX，不应为了增加种类把它们混入静态贴花。

| pattern | 图案与用途 | 形态参数的具体作用 |
|---|---|---|
| splatter | 暗红飞溅和分离滴点 | 墨边、轮廓扰动、滴点和网点密度 |
| scorch | 中心深、外缘浅的断笔焦痕 | 不规则轮廓及透明缺口；减少完整圆章感 |
| crack | 多段、宽窄变化、分叉裂纹 | 种子调整走向，不规则度调整折点，细节增加分叉 |
| hazard | 无矩形框的破损斜条漆 | 种子/不规则度/细节调整磨损；不是危险范围提示 |
| bullet-hole | 深墨中心、崩口和4–6条短放射裂缝 | 种子/不规则度改变长度角度，细节控制数量，墨边可调 |
| acid | 黄绿液池、深绿边、2–3个浅色气泡环 | 轮廓扰动、墨边及气泡密度；不含伤害逻辑 |
| oil | 两个相连蓝黑色块和局部断墨边 | 细节控制内部两档色块，轮廓与断墨可调，不做摄影镜面反射 |
| paper | 5–7张分离纸片，短墨线替代文字 | 种子旋转、缺角及纸片数量，无投影阴影 |
| rubble | 4–6个大碎片和少量小片 | 细节控制数量，不规则度改变半径/散布，角度和墨边可调；不提供3D高度或碰撞 |

`DecalMark.style` 可选，但提供时必须完整声明四项；非法、缺字段及未知字段都拒绝：

```json
{"coverage":0.9,"edgeWidth":0.015,"irregularity":0.65,"detail":0.5}
```

缺省为 coverage=1、edgeWidth=.025、irregularity=.5、detail=.5。coverage（.2–1）控制
图案在平面内的占比；edgeWidth（0–.1）是局部归一化墨边宽度，0可去边；irregularity/
detail（0–1）控制不规则度/细节密度。具体图案不需要每个参数都有同一效果：hazard
本来就没有矩形墨边，因此不显示墨边宽度控件；crack的墨边参数控制裂缝笔触粗细。size仍控制实际世界尺寸，不用coverage
代替几何大小。改变图案保留当前颜色；按钮「使用图案推荐色与形态」明确应用推荐值。
迁移保持数据，但修正了旧图案的造型，并不保证旧版本像素完全一致。

## 渲染与寿命

先画静态物件与动态角色深度，再绘制贴花；深度测试 `less-equal`、不写深度、
premultiplied alpha 混合，aux 写掩码为 0，透明矩形不参与 inverted-hull 描边。
按 priority、距相机远到近、稳定身份排序；排序的是实例中心，不保证交叉透明平面的
完美排序。优先级主要用于共面叠加。GPU 采用一个实例批、一张有界 storage buffer；
视锥之外的片元由 GPU 裁剪，未新增 CPU 遮挡剔除。

运行池容量 512，满时淘汰最早实例并增加 `evicted`；非法输入/重复 id 拒绝且不修改池。
寿命最长 120s，fadeSec 在 0–ttlSec。只消费宿主提供的 `tick * fixedStep`；暂停、读取
诊断或页面停留不推进。Reset 清池并切换 runId，Stop 清空运行痕迹并释放批缓冲，
作者组件不受影响。编辑态后续重建作者批缓冲属于编辑器资源，不是残留 Play 痕迹。

这是一张平面，不读取接收面的材质/法线缓冲，也不裁切任意网格。必须显式给定局部
表面位置和方向；摆到轮廓以外会悬空，不自动吸附地面/另一个楼层。曲面、墙角、变形
蒙皮、法线/粗糙度覆盖及跨面 projector 尚未实现。大量重叠仍可能导致 overdraw；
一次 draw 不能证明手机性能。每个 GPU 实例为 20 floats / 80B（5×vec4），最后一组
包含四项形态参数；CPU packer、WGSL 和工作区预览共享布局，最多1024作者+运行实例仍合批。

## Agent 编辑闭环

作者痕迹用 `scene_get → scene_edit_nodes` 替换完整接收节点 → `scene_validate` →
`scene_save → scene_open → scene_get`；保留原 MeshRenderer、导航/碰撞和无关 marks。
可视化编辑入口是 **渲染 → 程序贴花工作区…**。从选中静态物体进入，未选中时优先打开
已有贴花的接收物。左侧独占 GPU 预览，右侧管理接收物和稳定 mark id 列表，支持新增、
复制、删除和全部现有参数：九种图案、种子、颜色、不透明度、四项形态参数、宽深、局部位置、朝向
四元数、法线偏移、优先级以及组件启用。提供朝上/朝前/朝右预设与四元数归一化。

参数只改工作区草稿，实时图案与场景共享 `ProceduralDecalPass`，不复制 SDF 公式。
预览自动居中和适配尺寸；图案正视忽略朝向，局部俯视/前视/立体视角展示局部朝向。
位置、接收节点变换及法线偏移的实际摆放效果在**应用后的场景**中查看；此预览不是
完整场景克隆，棋盘背景也不代表游戏材质和后处理。预览辅助体不写入场景文件。

**应用到场景**通过 `SpawnEditStore.editNodes` 完整校验并生成一条可撤销的作者命令；
接收节点被其他编辑改变时拒绝应用，不覆盖新值。删除最后一个 mark 会移除组件。
未应用的草稿阻止工作区关闭、场景保存、Play 启动和 MCP 场景写入；可以明确放弃。
应用后使用现有场景保存/重载；MCP 仍通过完整节点编辑相同数据，无第二份持久化状态。
工作区关闭及 HMR 时销毁实例/帧缓冲和预览 target，并解绑独占画布；Resize 先释放旧 target。

运行痕迹用新工具 `editor_decal`，必须在 Play 并使用当前 runId/revision：

```json
{"action":"emit","runId":1,"expectedRevision":"<scene_get revision>","instanceId":"<选定实例>","decal":{"receiver":"nd_nav3d_low","ttlSec":2,"fadeSec":1,"mark":{"id":"runtime_1","pattern":"splatter","position":[0,0,0],"rotation":[0,0,0,1],"size":[2,2],"color":"#8e2839","opacity":0.9,"seed":7,"normalOffset":0.008,"priority":1}}}
```

`action:clear` 只清运行池；作者痕迹仍在。命令接收不等于已绘制，须推进模拟并读取
`editor_runtime.runtime.decals`，再用 headed GPU 确认。诊断含 time/count/capacity/
evicted/marks/runId 和最后绘制帧 GPU instances/drawCalls/bufferBytes；GPU 字段可能
比刚发出的命令滞后一帧。

白盒 `assets/scenes/sandbox/procedural-decal-whitebox.scene.json`：49 节点、40 静态 mesh、
18 作者痕迹；生成器 `node tools/level/gen-decal-whitebox.mjs` 同时维护第一层街道的
24 个 `street-proc-*` 和9个 `street-surface-*` 痕迹，保留其他作者 marks。后九个只使用
油污、纸片和碎石装饰；不静态放置代表活动伤害的酸液颜色。白盒酸液是样例，不是有效
游戏伤害区。运行示例不会制造场景文件外的地面。

门禁：相关 Scene/Render/Editor owner 测试、typecheck、editor:build、architecture:check、
scene:check、knowledge:check、Node MCP/场景契约测试。实际 GPU 与持久化结果见
`docs/evidence/procedural-decals-20261013/acceptance.md`；未验证手机或任意复杂接收面。
独立工作区的实际 UI、保存重载及 GPU 证据见
`docs/evidence/decal-workbench-20261013/acceptance.md`（基线 `bccb365`）。
独立视觉复审、类型缺口及修正后的实际结果见
`docs/evidence/decal-vfx-20261013/acceptance.md`；目前未自动将战斗事件转换为血迹、弹孔或酸液。
