# 项目长期记忆

## 铁律（git / 编码）
- 收尾 `git add <本会话文件> && git commit && git push`，中文 message。只 add 自己改的，禁 `git add -A`（并行 session 会吞别人在途改动）；push 避同分支并发。
- 🔴 未经许可禁碰 `.git` 内部（fsck/删文件/建 refs/碰 pack）。异常只报告症状。
- remote `origin = git@github.com:fangye100/workbuddy-zombie-shooter.git`（SSH；拼写 shooter，另有空仓 shotter）。
- 🔴 Python 读写文本会毁行尾：`open(p,'w')` 加 `newline=''` **只挡住写**，挡不住读 —— 文本模式**读**就把 `\r\n` 归一成 `\n`，再 `newline=''` 写回仍然把 CRLF 文件整文件转成 LF（main.ts 1814 行惨案，2026-09-07）。
  改已存在文件的正确姿势：**二进制** `open(p,'rb').read()` → `bytes.replace` → `open(p,'wb').write()`。
  自查 `git diff --cached --stat --ignore-cr-at-eol` 应远小于 `--stat`；中招用二进制 `replace(b'\n', b'\r\n')` 还原。
- ⚠️ 边界：文件本身已是 CRLF 时保持一致性（main.ts / models.ts），勿整文件改写。
- 已提交未 push 的行尾事故**用新提交修，不要 amend**（并行 session 可能已基于它往下走）。

## ADR 速查（全文 docs/10 + docs/14）
001 渲染真源唯一化 · 002 资料库运行时单一真源 · 003 验证分层 · 005 包体 @aether/* · 007 render(L3) 不反向依赖 content(L4) · 008 验证资产与结论同入库 · 009 测试同位 · 010 场景唯一数据载体 · 011 Node/Component(AoS)+SoA ECS · 012 扁平节点表+parent · 013 JSON+SCHEMA_VERSION+迁移链 · 014 Edit/Play 分离 · 015 aether.project.json 锚点 · 016 sidecar 同名 .meta.json · 017 脚本=行为注册表

## 真源（改前先改这里）
- roster.json(npc5+boss3，顶层键非 characters) + tokens.json → content:gen → packages/content/src/generated/*；content:check 不同步 exit 1。
- ⚠️ roster.json 承载不了 CharacterDef（缺胶囊半径/质量/转向/视野/受伤盒等 11 项）。硬生成=把编造数字洗成单一真源，比硬编码更坏。
- L-8 待用户决策：params.ts gradeShadowMult 0.95 vs 真源 0.78、gradeShadowMix 0.12 vs 0.2（改了变画面，美术决策）。

## 编辑器 / 引擎
- 端口 编辑器 5100 / 游戏 5101（agents.md §1）。
- 脚本名坑：build=sample-00；编辑器 editor:build；冒烟 editor:smoke（无 verify:smoke，传 --glb 才启用骨骼断言）；verify:glb|uv|facade|dock|prefix；lab* 是别名。
- 引擎落地：ai(最成熟)/gameplay/gfx/core/framegraph。dormant：framegraph/graph.ts + render/feature.ts（标 DORMANT 未删）。
- 🔴 不用 core/src/ecs/world.ts 当场景骨架（remove 空实现/strideOf 硬编码/isChanged 恒真）。静态物件走 SceneGraph，500 僵尸走 SoA+instancing。
- 容量：MAX_OBJECTS=64 超限必须报错不能静默丢；MAX_MATERIAL_SLOTS=256；LIGHTS_FLOATS=40 → 只 1 dir+1 point，多灯按 priority 取 top-1+top-1、落选标黄。
- 资产库面板「不见了」：ad- 前缀全改 asset-（750972d，闸门 verify:prefix）；localStorage zh.assets.collapsed/zh.ui.dockH 删掉硬刷。tools/verify/dock-probe.mjs 基线 seg{grip:6,head:42,body:212,sum:260}。
- 🔴 项目文件必须走 `/__fs/file?path=` 端点，不能直接 fetch 路径：vite root=apps/editor，项目根 assets/**/aether.project.json 不在其下 → SPA fallback 返 HTTP 200+index.html，`res.ok` 为真只有 `res.json()` 抛 `Unexpected token '<'` 才暴露；`if(!res.ok)` 拦不住。统一入口 `asset-util.ts` 的 `fileUrl()`/`readProjectFile()`（降级但保留 error 字段）。该端点仅 dev 中间件有，生产构建无。

## Scene 数据层（铁律 agents.md §2/§2.5，全文 docs/14）
- **S1 已完成**（2026-09-04，commit `514f7aa`）：场景内容来自 `assets/scenes/sandbox/default.scene.json`。链路 `resolveStartScenePath()`(读 project 的 scenes[startIndex]) → `renderer.loadScene()` → `migrateToLatest` → `SceneGraph.fromDocument` → `updateWorldTransforms` → `instantiateScene` → `applySpecs`。构造期 `buildDefaultSpecs()` 降为 fallback。判据 `renderer.getSceneSource()`（null=没读文件）。
- 路线 S0(完)→**S1(完)**→S2 保存/Inspector→S3 Play→S4 灯光组件化→S5 prefab→S6 接 ai/gameplay。**S2 第一件事：把 userData 的 bob/aoMin·aoMax/background/category 提到正式 schema。**
- 三份真源：document.ts(场景)/project.ts(项目)/asset-meta.ts(sidecar)。改 schema 先改它+补测试+补迁移链。
- 归属判定两句：① 换全新空场景还在不在？不在→.scene。② 丢了能从源 GLB 反推？能→不存。
- 四层容器+覆盖链：aether.project.json ⊃ `<file>.meta.json`(保留源扩展名) → `*.prefab.json` → `*.scene.json`，每级只存差异。
- 不用集中索引（assetdb.json 是合并冲突制造机）；guid→path 索引启动扫描重建落 `.workbuddy/cache/`(不进 git)。
- 不落盘三类：派生/烘焙→cache/；UI 状态→localStorage；Play 运行时→内存 Stop 即弃。
- 分层修正：scene/geometry.ts 定性共享契约层允许被 L3 依赖；graph.ts/document.ts 才是 L4（只改注释）。
- ⚠️ schema 两已修坑：MaterialRef 撞 render/materials.ts→MaterialBindingRef；MaterialPatch 字段须与 MaterialState 逐个对齐（emissiveColor 非 emissive，清单 MATERIAL_STATE_FIELDS）。
- 🔴 门禁测试禁用 node:fs（无 @types/node，types 白名单）→ 用 `import.meta.glob('/assets/**/*.meta.json',{eager:true,import:'default'})`。
- tools/scene/gen-asset-meta.mjs（非 tools/gen-asset-meta.mjs）：28 sidecar。merge 不覆盖手改；身高读 roster.generated.ts 的 heightMeters，断言 8 角色否则抛错。门禁必须验证会拦：maxSubMeshes=0/重复 guid/漏 sidecar 三种注入已实测 exit 1。

### 骨骼：会话存，结果不存
- E04_Bulwark_1600_rigged_animated.glb(300KB) 已含 22 关节+IBM+JOINTS_0/WEIGHTS_0+6 动画 → 结果已随导出 GLB 落盘(LFS)，抄进 .meta=双真源比丢失更糟。
- .meta.rig 只装配方：session.positions/bindPose/skinCylinders + export.*(falloff/eps/maxInfluences/smooth×/mirrorWeights) + tposeLocalRotations。不存 mirrorPairs（humanik-template MIRROR_PAIRS 由 template 派生）。
- rig.exported 取代 weightsBaked：false=结果只在内存(发 W_META_RIG_NOT_EXPORTED)；true=结果在 GLB，.meta.rig 降历史记录运行时不读。
- S0d 编辑器侧未做：binding-panel.ts 的 positions/bindPose/cylinders 等全是实例私有字段、无落盘路径（依赖 S1 Inspector）。

### 脚本（ADR-017）
代码资产 + BehaviorParamSchema 必须有（没它 Inspector 画不出控件=功能等于没有）。场景只存 {behavior,params}，绝不存代码字符串。行为失效 warning 降级空操作不阻塞加载。

## 3D 资产生成管线
- 全链路 assets/characters/_tools/pipeline_character.py：front.png → 混元图生3D → decimate_cluster(病态拓扑免疫；质检=表面积保持率>80%) → bake_lowpoly(xatlas) → rig_character → retarget_bvh → validate_glb。入口 gen3d_from_image.py（勿直接调 buddy-cloud --image-base64，超 Windows 命令行长度上限）。
- 两套 Python 分开：云端/绑骨 binaries/python/versions/3.13.12(requests)；减面/烘焙 binaries/python/envs/default(pymeshlab+xatlas)。
- 混元图生3D 5 次/天(429)且不能带 --prompt。export_labmesh 用 (x,-z,y)，极性反 --up-flip。headless cdp-rigged.mjs 20 断言，8/8 角色 rig+anim 全齐。

## WebGPU
编码期陷阱→skill webgpu-coding-pitfalls；运行时验证→skill webgpu-headless-validate。一句话：tsc+vite build 全绿照样线上炸——usage 错配/uniform offset 对齐/bind group visibility/WGSL 编译错误只在运行时暴露。

## 骨架 tip（尖端）骨 —— 22 + 5 = 27（2026-09-08 核实：已加 HeadTip，不再是 26）
- 手腕末端 + 脚趾末端 + 头顶尖端：`LeftHandTip / RightHandTip / LeftToeTip / RightToeTip / HeadTip`。
  `HUMANIK_ORDER` 现为 27 项，索引 0..26；参与 skin 的仍是 22 根（`skinBones()`）。
  HeadTip 是后加的（0.14 m，解决「头顶顶点被脖子抢走」），旧文档/旧记忆写 26 的已过期。
- 🔴 **索引对齐铁律**：`joints[]` 写的是 `HUMANIK_ORDER` 下标，**tip 只能「保留槽位 + 权重置零」，绝不能过滤数组**——一过滤后面所有 joint index 整体错位。
- tip 三不：不产生 wrapper mesh、不产生 skin wrapper、不参与 skin 计算（权重恒 0）。但它**仍是骨架节点**（进 `skins[].joints`、有 node/IBM、可被动画驱动）。
- tip **不是**重定向目标（`retargetBvh` 映射用 `skinBones()`，否则误报「缺 4 根骨」）。
- 正收益：影响胶囊 = 骨 head → 其**第一个子骨** head；Hand/ToeBase 原本是叶子（胶囊退化成点），有了 tip 才拿到长度。
- 同源三处必须一起改：`humanik-template.ts`、`assets/characters/_tools/humanik_skeleton.json`、`rig_humanik.py`。
- 姿势夹具（vitest `poseLeftArm` / 冒烟 A-pose）**摆 Hand 时必须一起摆 tip**，否则手尖留在 T-pose 位置被误报成「离轴骨」。
- 编辑器/引擎侧 `unposed` 徽标是死代码（从不置 true）；不改，因为铁律是「绑定是动词，绑完骨架姿势即定，绝不跳回 T-pose」。

## 绑定/蒙皮评审结论（2026-09-08，全文 docs/15）
- 🔴 **P0-1 已实证**：`smoothSkinWeights` 按**槽位 k** 而非**骨 id** 做邻域平均（`joints` 原样拷贝不参与）→
  骨交界处顶点的邻居槽位 1（真实第二骨 40%）被灌进本顶点槽位 1（w=0 的骨）→ 实测无关骨拿到 **18.8%**。
  圆柱体权重多为单骨 100%，其槽位 1/2/3 填的是 w=0 且稳定排序后**索引最小的骨 = Hips/Spine/Spine1**
  → 关节周围一圈顶点把权重交给脊柱。修法：平滑前展开成 `Map<jointId,w>` 累加，按 joint id 聚合再取 top-4。
- 🔴 **P0-2**：`binding-export` 走 `if (cylinders !== undefined)` 分支，而 `ensureCylinders()` 在
  **setModel 时载入即建** → `getCylinders()` 永远非 null → **UI 上每一次 Bind Skin 都走圆柱体路径**，
  `computeLbsWeights` 在 UI 是死代码，`BindExportInput` 的 `falloff/eps/maxInfluences` 是**死参数**（无人传）。
- P0-3：无权重热力图、无变形预览（`cylinder-overlay` 只画圆柱体，grep 权重只命中注释）。
- P1：`PEN_SCALE=8.0` 是绝对米制（粗骨碾压细骨、不尺度不变）；包裹体外顶点硬权重 1.0 兜底；
  平滑邻接靠三角面索引 → split-normal 描边模型硬边会切断扩散；**无 Undo/Redo**（grep 零命中）；
  无预算数字（`BindExportStats` 已算出 zeroWeightVerts 等却只进 console）。
- 验证手法可复用：在 binding/ 下临时建 `__probe.test.ts`，`npx vitest run <路径>` 直跑真实模块，打印后**立即删除**。

## Skin Wrapper（包裹器）半径
- 三条绘制路径都必须响应半径：主 3D 视口（`buildCylinderOverlay`，吃实时关节矩阵）、面板正/侧视 3D（`buildCylinderOverlayFromSegments`，吃 boneSegments）、无 WebGPU 时的 2D 降级（`drawSkin`）。
- **顶点数看不出半径变化**（改半径不增不减顶点）。判据是几何指纹：`renderer.debugCylinderStats()` 的 `sum`（顶点坐标绝对值之和）+ bbox；面板 3D 用 `BindingView3D.cylinderSum`。冒烟 L2e/L2f/L2g 已固化。
- 改半径只有一条路径：`BindingPanel.setCylinderRadius()`（滑块 / 视图拖拽 / 自动化钩子共用），杜绝「钩子能改、UI 改不动」的假绿。
- 视图里拖圆柱体 = 改半径：**半径 = 指针到骨轴的垂距**，垂距必须用**直线**不是线段（`distPointToLine2d`；线段版靠近骨两端会被端点距离撑大），只改点中的那一段。
- 合成 PointerEvent 没有真实 pointer，`setPointerCapture` 会抛 → 必须 try/catch。

## 冒烟环境坑
- `editor:smoke` 默认**复用 5100 上已在跑的编辑器**。5100 不在时它会自己起 vite，但 readiness 探测在新端口上会失败并**卡死**（实测卡了 1h39m，只能 TaskStop）。跑之前先 `curl -sk https://localhost:5100/` 确认；卡住就换回 5100。

## 门禁（8 道，收尾全跑）
typecheck · vitest · editor:build · editor:smoke · content:check · verify:prefix · scene:gen · scene:check

## 线上资料库（workbuddy.cn/space）同步
- 可直接读写不用用户手动。流程：connect_open_platform 换票(token 1800s) → space.workspace.list-user-spaces 判 category(personal 直接写/team 停等) → get_doc_reviews.py --page-id 取最新 content+blockId → submit_doc_edit.py(新增/追加) 或 submit_review_edit.py(改已有)。脚本根 `C:/Program Files/WorkBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/skills/library/`。
- 🔴 组件语法硬约束：`<Table>` 只接受无属性（带 rowHeader 被拒「仅允许: 无属性」）；Table 仅 delete/insert_before/insert_after，禁 update；加删行列=delete+insert_after 整表重建 → 代价：重建后 rowHeader 永久丢失（官方固有代价，非操作失误）。
- 回读 content 是往返安全表示：Code 块包 ``` 围栏、`_` `[]` `*` 加 `\` 转义——别照抄回写。
- 新建整篇用 create_doc.py（只吃 Markdown 禁组件）。本地 docs/ 是真源。线上节点：docs/09 → `FNfRd1b8idYncNDIdKBmvQ`；docs/14 §14–§15 镜像 → `48WumseQVdiYkWOQL2pz94`。改了本地文档要同步线上。
