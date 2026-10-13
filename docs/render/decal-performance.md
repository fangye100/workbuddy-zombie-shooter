# 程序贴花对象池与间接绘制

2026-10-14；基线 `ef239dac`，分支 `codex/procedural-decals-20261013`。默认使用 A，B 可显式切换。
本次保留 scene schema v21、现有九类 SDF、Game 规则与场景唯一真源。

## 方案与 owner

| 项目 | A：对象池 + 直接实例化 | B：同一对象池与坐标上传 + GPU 间接绘制 |
|---|---|---|
| CPU 寿命与规则预算 | 固定槽池；Game 提供不透明组标签 | 相同，避免CPU策略影响GPU比较 |
| 排序/数据 | priority、相机中心远到近、旧组合稳定 key；80B/项 | 相同 |
| GPU绘制 | `draw(6,N)`，1 storage buffer | 1 Compute dispatch：六视锥面检测、稳定前缀和、压缩；`drawIndirect` |
| 上传 | 80N B | 80N+16 B，不在CPU回读可见列表 |
| 自有GPU缓冲 | 输入容量 C | 输入 C + 输出 C + 间接参数16B + settings16B |
| 深度与混合 | less-equal、不写深度、预乘透明、aux不写 | 相同 |
| 全离屏 | 硬件裁剪，仍提交N项 | GPU参数instanceCount=0，仍有间接draw命令 |

Framework owner 是 `packages/render/src/decal-instances.ts`、`procedural-decals.ts`、
`decal-indirect.ts`、`renderer-core.ts`、`decal-preview.ts`。Game 规则与事件继续由
`packages/zombie-game/src/presentation/combat-decals.ts` 管理。Editor 只提供矩阵、权威
模拟时间、UI/MCP 和 Play 清理：`apps/editor/src/services/runtime-decals.ts`、`editor-agent.ts`、
`decal-workbench.ts`。没有新建第二份场景/游戏状态。

## 对象池契约

构造时预分配 capacity 个 Entry、position/rotation/size/style，空闲槽栈与插入顺序 Map
管理复用。满池淘汰最早实例；同id/非法输入在修改前拒绝。expiry/remove/removeOldest/clear
同步维护 groupCount。组标签不解释游戏语义，避免每次命中通过整个池的深复制/正则扫描统计。

`frame()` 是同步、只读借用，后续池操作会使旧视图失效；禁止跨异步持有或作为外部诊断返回。
mark 原始 opacity 不修改，额外 opacityScale 表示淡出，避免累乘。`snapshot()` 始终复制，
外部改副本不影响池。Reset 清运行池、换 runId，GPU批缓冲在本次Play内复用并于下帧更新；
Stop 发布空视图并释放贴花GPU资源。暂停/诊断不推进模拟时间。

FrameBuilder 复用记录、两张矩阵和打包缓冲；缓存独立 mark id，不能通过可变mark引用判断
缓存身份是否变化。透明顺序必须保留 `(receiver + ':' + id).localeCompare()` 的原语义；
分别比较receiver/id会在前缀下划线等合法身份下产生不同顺序。

`diagnostics()` 的 allocatedSlots 是实际构造槽数；emitted/reusedSlots 是本池实例累计值，
clear 不重置这两项。该诊断不统计整个JS运行时GC。事件输入、validation、首次缓冲/view
增长及外部snapshot仍可能分配，不能称全系统零分配。

## GPU B 的边界与失败行为

最多1024项（作者512 + 运行512）；256线程各处理4项，工作组内 flags/prefix 各1024个u32。
四角全部落在同一clip plane外才剔除；近面穿越的平面保守保留，不做深度遮挡剔除。
前缀和每轮读后/写后均有一致的barrier，压缩保持原排序；不能用原子append随机重排透明实例。

间接参数固定为四个u32 `[6,visibleCount,0,0]`，由 Compute 写入。prepare 编码在RenderPass前；
RendererCore 和独立预览共用同一SDF与布局。无CPU填visibleCount伪装GPU路径。
完整接口语义见 [WebGPU drawIndirect](https://www.w3.org/TR/webgpu/#dom-gpurendercommandsmixin-drawindirect)
及 [WGSL 一致性规则](https://gpuweb.github.io/gpuweb/wgsl/#uniformity-analysis)。

缓冲按pow2增长复用；模式切换、clear、Stop和destroy释放输入、输出、args、settings与未完成
的读回缓冲。生命周期generation与帧sequence分开：普通下一帧不废弃已采样结果，只禁止把旧
结果写入当前快照；clear/切换/增长期间返回null。GPU设备错误保留，不静默报成功。

GPU实例输入长度非法/超过容量时原子拒绝，不截断。全零输入不dispatch或draw；已有容量缓冲
可以保留直到明确clear，以避免频繁再分配。A/B都保留原九类图案、寿命、预算和输入隔离。

## 操作与复测

渲染 → 程序贴花工作区 → 绘制方案（临时）：A或B；场景与预览跟随选择。该设置只属于当前
渲染器，不是场景内容，不要求schema迁移或保存。MCP按既有instance/revision流程：

```json
{"name":"editor_decal_backend","arguments":{"instanceId":"<当前实例>","expectedRevision":"<scene_get revision>","backend":"indirect"}}
```

`editor_runtime.runtime.decals.gpu` 是最近帧诊断。只读 `editor_decal_gpu` 可显式读回所采样帧：
A的countSource=submitted、drawnInstances=输入数、visibleInstances=null；B的countSource=
gpu-frustum、visibleInstances=保守视锥候选数，不能称屏幕像素可见数。异步采样不用于每帧控制。

真实GPU基准在已运行的固定5100 HTTPS编辑器服务打开 `/decal-benchmark.html`，点击「开始完整
对比」；仅开发诊断页，不打入生产index入口。复用公开 `@aether/render`，不是复制另一份shader。
页面可重跑，先销毁前次预览/设备，错误也释放部分创建的资源。

CPU比较只隔离同一新packer下 `snapshot()` vs `frame()`，不是对旧版全部CPU成本的测量。
每组同数量、矩阵、seed、相机，复制/借用交替，4批预热+10批测量，每批100帧。
GPU比较32/128/256/512/1024项，0/约50%/约90%离屏，另256重叠及1024全离屏。A/B配对
交替，3批×32帧预热，10批×32帧测量。使用真实timestamp-query整批首pass到末render差/32，
B计入Compute、Render及pass间隙；输入/settings上传在时间戳窗口外，字节成本单独记录。
CPU编码也按批次elapsed/32，排除submit/GPU等待/读回；不是游戏整帧耗时。
单pass时间戳约65536ns量化，Compute细分保留gpuComputeMsQuantized标记，不用它作高精度结论。

每组在独立submit后复制RGBA16F target并逐通道按位比较；保留透明重叠顺序与所有九类SDF。
GPU计数、1024边界、空帧、映射中clear以及资源清空一并验证。时间戳无支持时报告null，
不以CPU墙钟代替GPU时间。输入只为合成基准，不新建场景文件外的游戏内容。

实际数据、独立审核与局限见 [A/B 验收记录](../evidence/decal-ab-20261014/acceptance.md)。
当前没有认证移动端、所有GPU、整游戏FPS、任意数量贴花或500NPC性能；透明overdraw、曲面/
跨墙角投影与材质DBuffer仍是独立问题。间接draw不自动消除这些成本。
