# 美漫僵尸游戏画面品质提升指南

沉淀自 2026-10-04–05 场景品质开发，是可复用知识入口；交付报告保留版本特定结果。
早期实现说明描述品质分支至 `e3bc6c4`，不代表分支已合入或美术匹配完成。
后续更新见第 9–11 节，当前规则和源码契约优先于历史记录。

## 1. 先统一美术语言，再增加细节

Gameplay 参考使用深色描边、克制背景、暖色危险提示、青色功能点、紫色 UI 及多层街景。
各关玩法不同，美术语言统一。保留本地 GDD 的俯视相机，不能为了复制插画肩部高度构图
改变玩法契约。

精修顺序：

1. 固定可复现游戏视角，明确玩家、威胁、可通行路径和交互目标。
2. 建立大轮廓及近/中/远明度分离，先填背景大面，再处理细碎表面。
3. 对齐主光、冷填光、材质色板和色调映射，保留角色/建筑阴影面。
4. 加地面接触、克制描边及稳定纹理细节。
5. 加实际事件驱动的战斗强调，移动/战斗中再检查，不只看空场景。

高角度更暴露屋顶/地面，生成资产需完整屋顶、女儿墙、退台、雨篷。优先大手绘色块和
结构线，不用密集扫描噪点；源预览须经实际 toon、曝光和投影尺寸检查。
曾发现补给店/棚/泵遮挡道路，移到路后改善交互可见性且不动玩法节点；远 skyline 同样
放在玩法空间后。增加遮挡屋顶细节不能解决构图问题。
程序化几何适合构图、重复道路、大轮廓及明确缺资产；特色中景可用定制源模型，两种来源
都不自动证明最终品质。见[需求](../31-美漫画风资产需求与生成提示词.md)、
[场景精修](../28-EnvironmentSceneQualityPass.md)、[参考比较](../30-ComicRenderingAcceptance.md)。

## 2. 先诊断渲染，再重画资产

### 颜色与 uniform 契约

曾有两个让优质纹理显示错误的缺陷：AgX 未对线性输入做对数曝光编码；饱和度读取 padding。
当前 AgX 转工作空间、编码曝光、施加对比曲线后回线性 sRGB，post 只做一次显示转换。
饱和度在 float 10、`midG.z`，`midG.y` 是 padding；CPU 对象正确不证明 Shader 读对位置。

回归用生产 packer 和 Shader 一起测黑、灰、亮度单调、中灰、高光及 RGB 分离，测饱和度
0/1 和显示空间 ink 例外；这些探针分离颜色数学与构图，并补充可见比较。不要用极端
曝光/纹理色修饰坏转换，先确定 sRGB 解码、线性照明、tone mapping 和显示编码边界。
保留暗描边，同时不压死材质暗部。
源码：[common Shader](../../packages/render/src/shaders/common.wgsl.ts)、
[post Shader](../../packages/render/src/shaders/post.wgsl.ts)、
[装箱](../../packages/render/src/frame-uniforms.ts)、[历史 GPU 探针](../evidence/comic-matching-2026-10-05/gpu-probes.json)。

### 光、线与接地

- 主光方向与视线应有区分以显形体。高角度下先比较侧低光/正面高光，再提高对比。
  参数落场景，不把单一强度当普适规则。
- 按屏幕尺寸调背景线重；重建小碎面配强描边会发黑，必要时降低远景材质描边。
- 当前接触椭圆帮助道具/角色接地，不是方向阴影贴图，不能证明屋顶真实遮光。
- 静态 Shader 的 `unlit` 只跳过主光分阶，仍乘主光并加填光等，不是可靠独立照明诊断，
  不能靠开启它修拉伸 UV。

源码：[场景 Shader](../../packages/render/src/shaders/scene.wgsl.ts)、
[接触 Pass](../../packages/render/src/contact-shadows.ts)、[接触投影](../../apps/editor/src/services/scene-contacts.ts)。

### 静态与动画材质都要成立

动画批次曾只用代理颜色、静态显示贴图。BaseColor 必须进入实例角色路径，包括绑定与
生命周期，Asset Browser 贴图预览不能证明玩家/群体接入。生成 albedo mip 和各向异性
采样减远处闪烁；移动中检查稳定性，替换/Stop 检查自有纹理释放。不可把不透明 albedo
假设直接用于透明 VFX。
源码：[albedo](../../packages/render/src/albedo-texture.ts)、
[动态 Shader](../../packages/render/src/shaders/dynamic.wgsl.ts)、[资源职责](../../packages/render/src/renderer-core.ts)。

## 3. 将生成源转成可用资产

### 明确配方，只归一化一次

原始源、提取 BaseColor、预览及来源与运行派生分开。约 50 万三角形源不会因命名 LOD0
而适合运行；P0 的运行 LOD0 本身已优化。先应用 glTF 层级再判断 up：原始顶点像 Z-up，
但节点旋转已变 Y-up，二次校正会把建筑放倒。保持等比，建筑底部中心 pivot，武器明确
持握/前向；不对建筑套角色身高归一化。需求 W×D×H 对应 X×Z×Y，GLB bounds 是 X/Y/Z；
展示缩放不等于物理尺寸。

### 每级都从同一原始源生成

纹理感知减面，保护 UV seam；不同 UV 岛的同位置顶点不可互换。各级独立从原始源生成，
不逐级连减。记录源 hash、配方、目标、输出 hash 和实测，识别过期输出。

| P0 数值门禁 | 阈值 | 不能证明 |
|---|---|---|
| 位置/UV | 属性有限 | 美术表面品质 |
| 面积 | 源 90–110% | 局部窗/顶变形 |
| bounds 漂移 | ≤5% | 全角度轮廓 |
| 面数目标 | 误差 ≤5% | 设备帧时间 |
| 拓扑 | 相对焊接源不增边界/非流形数量 | 修复源本身缺陷 |

这是 P0 实现门禁，不是所有资产通用标准。先暂存，再发布；发布检查配方/源/输出 hash
和数值，**不强制视觉通过**，重新生成使视觉待复核。
反例：FAR-01 的 6k 模型过数值门禁，却把窗纹理拉成三角形；改为 20k/14k/10k 并在
场景选 14k LOD1 后改善。弱描边/改灯不能修 UV；调整配方，另量性能，不为原预算降门禁。

并排检查各级，再从游戏相机近看 UV、远看轮廓/噪点。三份文件不等于自动距离切换、流式
装载或手机预算；环境当前选择明确 LOD 引用。
见[构建器](../../tools/art/build-p0-lods.py)、[配方](../../assets/art/p0-intake.json)、
[原交付与预算](../32-P0-asset-intake-2026-10-05.md)、[比较画廊](../evidence/p0-art-intake-2026-10-05/lod-gallery.png)。

## 4. 精修必须可编辑、可替换

摆放、氛围/光都在场景 JSON，离线工具编辑资产/场景，渲染消费。新语义先 schema/迁移/
验证，再运行时/UI；稳定 NodeId、AssetRef path/GUID、新场景登记。
占位与未来资源共用米制、轴/pivot、稳定路径/GUID、明确状态及可见层级标签。早期 P0
MID-03/FAR-02 使用 3 份相同廉价占位，后续替换见第 9 节；相同占位不冒充独立减面级。
最终模型审核后替 bytes/更新 meta，保持身份和摆放。

精修遵守容量：第一层 64 静态槽，6 条装饰斑马线离线并为 1 个 GLB，保留首 NodeId，
只删冗余装饰，回收 5 槽而不改引擎上限。玩法语义节点不能这样合并；NPC 走实例路径。
可复用资产事实进 sidecar，场景选择进场景；生成/注释合并并保 GUID。重生成可能覆盖
手工编辑，接受前看 diff。
见[契约](../../packages/scene/src/document.ts)、[占位构建](../../tools/art/build-p0-placeholders.mjs)、
[美术编辑](../../tools/art/apply-p0-art.mjs)、[meta 合并](../../tools/art/prepare-p0-meta.mjs)、
[画廊](../../tools/art/build-p0-gallery.mjs)。

## 5. 天空/背景同时检查映射与生命周期

左右无缝不等于真实等距柱状全景。SKY-01 是绘制云带，当前上半球映射并在地平线/极区
淡出以遮不适合区域，是表现折衷，不是重建缺失全景。天空位于无穷远，不占静态槽；
blend/yaw/AssetRef 落场景。俯视相机可只见少量天空，还要精修可见 skyline/地面，不能
为天空截图改游戏相机。

异步旧场景 decode 不得覆盖新场景。当前 loader 校 path/GUID，用 generation 拒绝迟到
结果，关闭 bitmap，显式报错并回退程序天空；替换/清除 GPU 纹理释放。测试失败路径及
Apply→Save→Reload。`editorCamera.elevation` 存弧度，面板 cameraElevation 是度；
面板输入 0.5 近地平线，不是约 29°。保留转换边界，编辑/游戏相机分离。
见[天空 Pass](../../packages/render/src/comic-sky.ts)、[异步 loader](../../apps/editor/src/services/sky-texture.ts)、
[氛围编辑](../../apps/editor/src/services/atmosphere-panel.ts)、[相机转换](../../apps/editor/src/main.ts)。

## 6. 漫画反馈与共享图集

战斗 ink 跟随实际射击/伤害：曳光、起点闪、粉尘、命中、伤害数字和击杀字。表现不制造
伤害/暴击，实体移除后保事件位置，过滤旧 run，用模拟时间让暂停反馈冻结。当前是
Canvas 反馈，不是带深度遮挡的 GPU 粒子。

图集清单需效果 ID、帧数/时间、像素矩形、UV offset/scale、pivot 和 alpha 约定。
按 bytes 核验，不信交付摘要：P0 实际 23 效果/64 格，摘要却写 16。明暗底检查假棋盘、
矩形残留、裁烟和被抠掉细线；缩放/旋转/淡出单帧不是独立手绘序列，必须看运动。
交付图集因残底/格边裁切隔离；GPU 接入前修 alpha、RGB bleed/padding、明确 straight/
premultiplied-alpha，并验证缩小/mip 不串格。**这些修复和共享 GPU 图集渲染未完成。**
共享纹理减少纹理切换；减少 draw call 还需兼容管线/混合/深度和合批/实例，不是改 UV
就自动合批。
见[combat ink](../../packages/zombie-game/src/presentation/combat-ink.ts)、[需求契约](comic-vfx-atlas-v1.json)、
[实际布局](../../assets/art/textures/VFX-ATLAS-01/delivered-layout.json)、[接入处理](../32-P0-asset-intake-2026-10-05.md)。

## 7. 排障索引

| 症状 | 优先区分检查 | 处理方向 |
|---|---|---|
| 泛白/异常灰 | 生产 post 装箱与灰/色探针 | 先修转换/偏移 |
| 静态有贴图，动画平色 | 动态材质/纹理绑定 | BaseColor 进入实例路径 |
| Play 后跨街黑色交叉条纹 | 接触阴影是否按 `DYNAMIC_INSTANCE_FLOATS` 读取实例 | [步长修复与实际 GPU 对照](../architecture/crowd-and-decals-20261010.md#2-黑色交叉阴影原因修复与验证)，保留正常阴影 |
| 远建筑闪/黑 | mip、描边、投影尺寸 | 稳定采样，减线噪 |
| 减面后窗变三角 | 同光贴图源/LOD 比较 | 保护 UV 或增预算 |
| 建筑倒下/LOD 尺寸变 | 节点变换/配方 | 只归一化一次，保米制/pivot |
| 道具挡补给 | 真游戏相机 | 移装饰，不改玩法语义 |
| 天空地平线可用/头顶拉伸 | 源投影/极区 | 约定淡出或更好源 |
| 换场景出现旧天空 | 故意延迟旧 decode | 拒迟到并释放 bitmap |
| 图集盒/光晕/裁切 | 明暗底 alpha 和动画 | 隔离，修抠图/保护带 |

## 8. 验收与证据纪律

记录版本、场景、资产/LOD、游戏相机、视口/DPR/render scale、灯光/曝光和运行状态。
同构图比较，每次改一个疑因；临时观察相机需标记并恢复。分别检查：

1. **数据**：GUID、schema/迁移、源/派生 hash、引用/容量；改资产/场景跑 scene:check。
   不重新生成 meta 来掩盖未 smudge 的 LFS 指针。
2. **行为**：编辑、保存、异步失败、资源职责测试；构建/类型只证明编译。
3. **可见编辑**：开正确场景、等资产完成、edit/apply/save/reload、检查坏引用、Play/Stop
   恢复。直接 input hook 只证明该 hook，不证明未走的键盘/菜单。
4. **真实 GPU**：有界面、安全上下文、硬件 adapter、玩法/比较视图、GPU/浏览器错误。
   按当前规则，不复制历史启动 flags；空控制台不是美术通过。

桌面 FPS 点样不证明持续/手机性能；旧全关卡运行不自动认证新美术。区分完成关卡、
装载/回滚、视觉及设备性能，每个结论绑定实际版本。

### 历史证据与待完成项

- [环境精修](../28-EnvironmentSceneQualityPass.md)：构图、摆放及早期第一层输入运行。
- [玩家外观](../29-PlayerAppearanceAcceptance.md)：已有 H-01 表现范围。
- [美漫渲染](../30-ComicRenderingAcceptance.md)：色探针、动画贴图、天空/接地和反馈限制。
- [P0 接入](../32-P0-asset-intake-2026-10-05.md)：当时预算、画廊、天空持久化/失败及 Play/Stop。

原 P0 时 MID-03/FAR-02、图集修复/GPU、玩家武器接入、手机剖析和设计匹配未完成；
MID-03/FAR-02 后续已交付（第 9 节），不可沿用旧缺模型清单。画廊手枪不证明玩家接入，
后续程序武器与最终资源区分如下。完整 MCP 仍独立开发范围。

## 9. 建筑 LOD 与连续街道（2026-10-07 更新）

MID-03/FAR-02 已到货，同时收到 MID-04/05/06，预算/场景/版本证据见
[街景交付](../36-StreetQualityAndArchitecturalLOD.md)，上方早期数据不是当前验收。

- 比较保端点贴图 QEM 与自由顶点迁移。保护法线/边界/UV seam，开启 planar quadrics，
  屋顶/窗/桥预算不足就提高；配置不能保证源或减面完美直线。
- 全局面积/bounds 可漏局部折顶。输出局部法线/偏移对相干源平面比较，报告覆盖率；
  噪声源可能使指标不确定，不能把覆盖不足当通过，或把原斜顶/破损当新增折面。
  近距离贴图与游戏视图分开验收。
- 只合批无引用身份且工具能正确烘焙变换的装饰，保留玩法节点/保留 NodeId，不猜不支持的
  父缩放/旋转。
- GLB parser 即使禁归一化仍重置 X/Z 中心、Y 接地；世界空间烘焙街道必须在场景恢复
  原中心/最小 Y，否则有效 GLB 也会挪路缘/埋路漆。
- 断开的道路/人行面改连续表面，外围地面铺到 skyline 下。重复建筑不能藏露底空缺；从入口、
  补给区、末房检查整条近/中/远景。
- 合并动画后重生成保最新玩家 rig、共享动作和游戏相机，生成前后核真实组件；断言缺失节点
  不能证明保留。

## 10. 群体节奏与攻击可读性（2026-10-07）

增加 NPC 增加重叠攻击；普通名额和时序范围落场景，精英明确区分。距离/冷却/许可满足
才 windup，预备锁目标，再真实运动/碰撞；大范围扇形不能代替投射物/扑击/冲刺。
每 NPC 独立种子流用于感知、追击决策、预备、恢复、冷却，同 seed 可复现；测试同距离错峰
和距离外不预备。伤害/死亡即时，动画从自己的预备起点开始，随机循环偏移不等于决策错峰。
普通攻击楔形归 debug，酸落点、冲刺路和爆炸预警保玩法可读。效果只消费模拟时间/事实。
键鼠走可见真实输入；触摸检查 pointer 归属、取消、暂停/blur 清理。合成多指夹具与实体手机
分开，不用响应式布局/桌面点样认证手机。见[战斗交付](../37-CombatInputAndPopulationQuality.md)
及[追加资源](../38-GameplayActionAndVfxAssetBrief.md)。

## 11. 当前职责与资源边界（2026-10-09）

场景/资产保内容，render 保通用 GPU/Shader，游戏 HUD/ink/audio 在 zombie-game/presentation。
Editor 投影编辑/运行事实，不增加伤害/奖励公式。见[分层契约](../architecture/layers.md)。
7 种武器有业务行为和接受动作 hook。[程序化武器表现](../../packages/zombie-game/src/presentation/weapon-ink.ts)
消费持握/枪口/换弹意图，但不装载任意武器模型 AssetRef 或自动绑手。HumanIK torso/head
瞄准和开火步态已集成；最终持握/后坐/填装资源消费独立。共享 VFX 图集 GPU 渲染仍未完成。
资源可用、业务实现、程序化表现、最终美术验收分别报告。
[音频 resolver](../../packages/zombie-game/src/presentation/game-audio-assets.ts)使用相对模块的
Vite glob，迁移可让 mock/构建通过但真实资源失效；先核场景 AssetRef/GUID 和 glob，再
走真实 Play。[重构证据](../architecture/acceptance-2026-10-09.md)记录 22 take 装载/清理，
不代表新的人工审听或概念图通过。
