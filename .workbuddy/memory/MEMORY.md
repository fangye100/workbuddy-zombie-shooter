# 项目长期记忆

## 铁律（git / 编码）
- 🔴 **提交即推送**（2026-09-08 立）：本地每产生一个 commit 必须当场 push，多笔则逐笔推，**禁止攒在本地**。未推送提交是唯一无法从远端恢复的部分。push 失败必须当场解决或上报。
- 只 add 本会话改的文件，禁 `git add -A`（并行 session 会吞别人在途改动）；中文 commit message。
- 🔴 未经许可禁碰 `.git` 内部（fsck/删文件/建 refs/碰 pack）。异常只报告症状。
- 🔴 长 git 操作（stash/gc/repack/clone）必须 run_in_background 或显式加大 timeout。
- remote `git@github.com:fangye100/workbuddy-zombie-shooter.git`（SSH；拼写 shooter，另有空仓 shotter）。
- 🔴 Python 读写文本毁行尾：文本模式**读**就把 CRLF 归一成 LF，`newline=''` 只挡写不挡读（main.ts 1814 行惨案）。改已存在文件一律**二进制** rb→replace→wb。自查 `git diff --stat` vs `--ignore-cr-at-eol`。已提交未 push 的行尾事故**用新提交修，不要 amend**。

## git 灾难恢复（2026-09-08 实证）
- 症状：dubious ownership；`.git/refs/` 与 `packed-refs` 同时消失；`objects/pack/` 只剩 .idx + multi-pack-index、无 .pack 数据文件。
- 诊断：`.git/index` 常幸存，**用 Python 解析它**（DIRC v2：12 字节头，每条目 62 字节固定 + 路径 + 补齐 8 字节）即得损坏瞬间被跟踪的完整清单 —— 判定「丢了什么」的决定性证据。reflog 通常随 refs 一起没。
- 恢复四步：① `mv .git .git.broken-<日期>`（不删）② `git clone --no-checkout <url> <tmp>`（**必须用 `C:/...` 路径**，Git Bash 的 `/c/...` 静默失败、不建目录、退出码被管道掩盖）③ 把 `tmp/.git` 挪进来 + 旧 `config` 覆盖（保住 LFS filter 与 remote）④ `git read-tree HEAD` 填 index（--no-checkout 不写 index）。
- 之后 status 的 D 列表 = 工作区丢失但远端仍在的文件，`git checkout HEAD -- <dir>` 整目录恢复。LFS 验证看**文件大小**（MB 级=真实内容；~130 字节=没 smudge 的指针）。损坏的 `.git` 用 `.git/info/exclude` 本地排除，别提交。

## ADR 速查（全文见 docs/10 + docs/14）
001 渲染真源唯一化 · 002 资料库运行时单一真源 · 003 验证分层 · 005 包体 @aether/* · 007 render(L3) 不反向依赖 content(L4) · 008 验证资产与结论同入库 · 009 测试同位 · 010 场景唯一数据载体 · 011 Node/Component(AoS)+SoA ECS · 012 扁平节点表+parent · 013 JSON+SCHEMA_VERSION+迁移链 · 014 Edit/Play 分离 · 015 aether.project.json 锚点 · 016 sidecar 同名 .meta.json · 017 脚本=行为注册表

## 真源
- roster.json(npc5+boss3，顶层键非 characters) + tokens.json → content:gen → packages/content/src/generated/*；content:check 不同步 exit 1。
- ⚠️ roster.json 承载不了 CharacterDef（缺胶囊半径/质量/转向/视野/受伤盒等 11 项）——硬生成=把编造数字洗成单一真源，比硬编码更坏。
- L-8 待用户决策：params.ts gradeShadowMult 0.95 vs 真源 0.78、gradeShadowMix 0.12 vs 0.2（改了变画面）。

## 编辑器 / 引擎
- 端口 编辑器 5100 / 游戏 5101（agents.md §1）。脚本名坑：**测试是 `npm test`（无 vitest 脚本）**；build=sample-00；编辑器 editor:build；冒烟 editor:smoke（无 verify:smoke，传 --glb 才启用骨骼断言）。
- 🔴 不用 core/src/ecs/world.ts 当场景骨架（remove 空实现/strideOf 硬编码/isChanged 恒真）。静态物件走 SceneGraph，500 僵尸走 SoA+instancing。
- 容量：MAX_OBJECTS=64 超限必须报错不能静默丢；MAX_MATERIAL_SLOTS=256；LIGHTS_FLOATS=40 → 只 1 dir+1 point，多灯按 priority 取 top-1+top-1、落选标黄。
- 🔴 项目文件必须走 `/__fs/file?path=` 端点：vite root=apps/editor，项目根文件不在其下 → SPA fallback 返 HTTP 200 + index.html，`res.ok` 为真、只有 `res.json()` 抛 `Unexpected token '<'` 才暴露。统一入口 asset-util.ts 的 fileUrl()/readProjectFile()。仅 dev 中间件有。

## Scene 数据层（铁律 agents.md §2/§2.5，全文 docs/14）
- **S1 已完成**（514f7aa）：场景内容来自 assets/scenes/sandbox/default.scene.json。判据 `renderer.getSceneSource()`（null=没读文件）。
- 路线 S0(完)→**S1(完)**→S2 保存/Inspector→S3 Play→S4 灯光组件化→S5 prefab→S6 接 ai/gameplay。**S2 第一件事：把 userData 的 bob/aoMin·aoMax/background/category 提到正式 schema。**
- 三份真源：document.ts(场景)/project.ts(项目)/asset-meta.ts(sidecar)。改 schema 先改它 + 补测试 + 补迁移链。
- 归属判定：① 换全新空场景还在不在？不在→.scene。② 丢了能从源 GLB 反推？能→不存。
- 覆盖链：aether.project.json ⊃ `<file>.meta.json` → `*.prefab.json` → `*.scene.json`，每级只存差异。guid→path 索引落 `.workbuddy/cache/`(不进 git)。不落盘三类：派生/烘焙→cache/；UI 状态→localStorage；Play 运行时→内存。
- 🔴 门禁测试禁用 node:fs（无 @types/node，types 白名单）→ 用 `import.meta.glob(...)`。tools/scene/gen-asset-meta.mjs：28 sidecar，merge 不覆盖手改。

## 骨架 tip 骨 —— 22 + 5 = 27（旧记忆写 26 的已过期）
- `LeftHandTip / RightHandTip / LeftToeTip / RightToeTip / HeadTip`。HUMANIK_ORDER 27 项（0..26），参与 skin 的仍是 22 根（skinBones()）。
- 🔴 **索引对齐铁律**：joints[] 写的是 HUMANIK_ORDER 下标，tip 只能「保留槽位 + 权重置零」，**绝不能过滤数组**——一过滤后面所有 joint index 整体错位。
- tip 三不：不产生 wrapper、不参与 skin（权重恒 0），但仍是骨架节点（进 skins[].joints、有 IBM、可被动画驱动）；tip **不是**重定向目标。同源三处必须一起改：humanik-template.ts、_tools/humanik_skeleton.json、rig_humanik.py。姿势夹具**摆 Hand 时必须一起摆 tip**。
- 骨骼「会话存、结果不存」：E04_Bulwark_1600_rigged_animated.glb 已含 22 关节+IBM+权重+6 动画 → 结果随 GLB 落盘(LFS)；.meta.rig 只存装配方。

## 绑定/蒙皮（全文 docs/15；P0 均已修）
- 🔴 **P0-1 已修**：smoothSkinWeights 按**槽位 k** 而非**骨 id** 做邻域平均 → 实测无关骨拿到 **18.8%**。修法：展开成 Map<jointId,w> 累加，按 joint id 聚合再取 top-4；修复后 v0 只剩骨0=0.625 骨1=0.375，Σ=1。附带坐标量化焊接（SmoothWeldOptions）解决 split-normal 硬边切断扩散。
- 🔴 **P0-2 已修**：`if (cylinders !== undefined)` 而 ensureCylinders() 载入即建 → UI 上 Bind Skin 永远走包裹体路径，computeLbsWeights 成死代码。修法：WeightMode='wrapper'|'distance' + 面板下拉。
- **P0-3 已修**：saveBinding 写 sidecar 前先 validateAssetMeta，不合法拒绝写。
- UI §3.1–3.6 已修（53a5e32）：头部5组/危险降级/半径双输入/帮助折叠/未导出徽标，冒烟9条DOM断言锁死。
- P1 未修：PEN_SCALE=8.0 不尺度不变；包裹体外顶点硬权重 1.0 兜底；**无 Undo/Redo**；无预算数字；无权重热力图。验证手法：binding/ 下临时建 __probe.test.ts 直跑真实模块，打印后**立即删除**。

## Skin Wrapper 半径
- 三条路径都必须响应半径：主 3D 视口（buildCylinderOverlay）、面板正/侧视 3D（buildCylinderOverlayFromSegments）、2D 降级（drawSkin）。**顶点数看不出半径变化**，判据是几何指纹（debugCylinderStats 的 sum + bbox；面板用 BindingView3D.cylinderSum），冒烟 L2e/L2f/L2g 已固化。
- 改半径只有一条路径：BindingPanel.setCylinderRadius()。拖拽时半径 = 指针到骨轴的垂距，必须用**直线**不是线段（distPointToLine2d）。合成 PointerEvent 的 setPointerCapture 会抛 → try/catch。

## 3D 资产生成管线（全文 docs/06）
- pipeline_character.py：front.png → 混元图生3D → decimate_cluster(质检=表面积保持率>80%) → bake_lowpoly(xatlas) → rig_character → retarget_bvh → validate_glb。入口 gen3d_from_image.py。
- 两套 Python：云端/绑骨 versions/3.13.12(requests)；减面/烘焙 envs/default(pymeshlab+xatlas)。混元图生3D 5 次/天(429)且不能带 --prompt。export_labmesh 用 (x,-z,y)，极性反 --up-flip。

## WebGPU
编码期陷阱→skill webgpu-coding-pitfalls；运行时验证→skill webgpu-headless-validate。tsc+vite build 全绿照样线上炸——usage 错配/uniform offset 对齐/bind group visibility/WGSL 编译错误只在运行时暴露。

## 冒烟环境坑
- `editor:smoke` 默认复用 5100 上已在跑的编辑器；5100 不在时它自己起 vite 但 readiness 探测失败并**卡死**（实测 1h39m）。跑前先 `curl -sk https://localhost:5100/` 确认。
- 已知遗留失败（非本次引入）：autoFitCylinders 断言读 LeftArm 拿到旧值 0.091，而钩子返回的 oRadiiImmediate/Persist 都已是正确 0.057492 —— 断言读取路径与半径表不同步。E-04 恢复后从 118 PASS/4 FAIL 改善到 123 PASS/1 FAIL。

## 门禁（8 道，收尾全跑）
typecheck · npm test · editor:build · editor:smoke · content:check · verify:prefix · scene:gen · scene:check

## 线上资料库（workbuddy.cn/space）
- 流程：connect_open_platform 换票(1800s) → list-user-spaces 判 category(personal 直接写/team 停等) → get_doc_reviews.py --page-id → submit_doc_edit.py(新增) / submit_review_edit.py(改已有)。
- 🔴 Table 只接受无属性（带 rowHeader 被拒）；仅 delete/insert_before/insert_after，禁 update；加删行列=整表重建 → rowHeader 永久丢失。回读 content 是往返安全表示，别照抄回写。新建整篇用 create_doc.py。本地 docs/ 是真源。线上节点：docs/09 → FNfRd1b8idYncNDIdKBmvQ；docs/14 §14–§15 → 48WumseQVdiYkWOQL2pz94。
