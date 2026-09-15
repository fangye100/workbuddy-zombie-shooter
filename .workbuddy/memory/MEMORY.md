# 项目长期记忆

## 🔴 铁律（git / 编码）
- **提交即推送**：每产生一个 commit 当场 push，多笔逐笔推，禁攒本地。push 失败当场解决或上报。
- 只 add 本会话改的文件，禁 `git add -A`（并行 session 会吞别人在途改动）；中文 commit message。
- **未经许可禁碰 `.git` 内部**（fsck / 删文件 / 建 refs / 碰 pack）。异常只报告症状。
- 长 git 操作（stash/gc/repack/clone）必须 run_in_background 或显式加大 timeout。
- remote `git@github.com:fangye100/workbuddy-zombie-shooter.git`（SSH；拼 shooter，另有空仓 shotter）。
- **Python 读写文本毁行尾**：文本模式读就把 CRLF 归一成 LF，`newline=''` 只挡写不挡读。改已存在文件一律**二进制** rb→replace→wb。自查 `git diff --stat` vs `--ignore-cr-at-eol`。已提交未 push 的行尾事故**用新提交修，不要 amend**。

## git 灾难恢复（2026-09-08 实证）
- 症状：dubious ownership；`.git/refs/` 与 `packed-refs` 同时消失；`objects/pack/` 只剩 .idx、无 .pack。
- 诊断：`.git/index` 常幸存，**用 Python 解析它**（DIRC v2：12 字节头，每条目 62 字节固定 + 路径 + 补齐 8 字节）即得损坏瞬间被跟踪的完整清单。
- 恢复四步：① `mv .git .git.broken-<日期>`（不删）② `git clone --no-checkout <url> <tmp>`（**必须用 `C:/...` 路径**，Git Bash 的 `/c/...` 静默失败）③ 把 `tmp/.git` 挪进来 + 旧 `config` 覆盖（保住 LFS filter 与 remote）④ `git read-tree HEAD` 填 index。
- LFS 验证看**文件大小**（MB 级=真实内容；~130 字节=没 smudge 的指针）。损坏的 `.git` 用 `.git/info/exclude` 本地排除。

## ADR 速查（全文 docs/10 + docs/14）
001 渲染真源唯一化 · 002 资料库运行时单一真源 · 003 验证分层 · 005 包体 @aether/* · 007 render(L3) 不反向依赖 content(L4) · 008 验证资产与结论同入库 · 009 测试同位 · **010 场景唯一数据载体** · 011 Node/Component(AoS)+SoA ECS · 012 扁平节点表+parent · 013 JSON+SCHEMA_VERSION+迁移链 · 014 Edit/Play 分离 · **015 aether.project.json 锚点** · 016 sidecar 同名 .meta.json · **017 脚本=行为注册表**

## 真源
- roster.json(npc5+boss3，顶层键非 characters) + tokens.json → content:gen → packages/content/src/generated/*；content:check 不同步 exit 1。
- ⚠️ roster.json 承载不了 CharacterDef（缺胶囊半径/质量/转向/视野/受伤盒等 11 项）——硬生成=把编造数字洗成单一真源，比硬编码更坏。
- L-8 待决策：params.ts gradeShadowMult 0.95 vs 真源 0.78、gradeShadowMix 0.12 vs 0.2（改了变画面）。

## 编辑器 / 引擎
- 端口 编辑器 5100 / 游戏 5101。**测试是 `npm test`（无 vitest 脚本）**；build=sample-00；editor:build；冒烟 editor:smoke（传 --glb 才启用骨骼断言）。
- 🔴 不用 core/src/ecs/world.ts 当场景骨架（remove 空实现/strideOf 硬编码/isChanged 恒真）。静态物件走 SceneGraph，500 僵尸走 SoA+instancing。
- 容量：MAX_OBJECTS=64 超限必须报错不能静默丢；MAX_MATERIAL_SLOTS=256；LIGHTS_FLOATS=40 → 只 1 dir+1 point，多灯按 priority 取 top-1+top-1、落选标黄。
- 🔴 项目文件必须走 `/__fs/file?path=` 端点（vite root=apps/editor，项目根文件不在其下 → SPA fallback 返 HTTP 200 + index.html，`res.ok` 为真、只有 `res.json()` 抛 `Unexpected token '<'` 才暴露）。统一入口 asset-util.ts 的 fileUrl()/readProjectFile()。仅 dev 中间件有。

## Scene 数据层（铁律 agents.md §2/§2.5，全文 docs/14）
- 路线 S0(完)→S1(完)→S2 保存/Inspector→S3 Play→S4 灯光组件化→S5 prefab→S6 接 ai/gameplay。**S2 第一件事：把 userData 的 bob/aoMin·aoMax/background/category 提到正式 schema。**
- 三份真源：document.ts(场景)/project.ts(项目)/asset-meta.ts(sidecar)。改 schema 先改它 + 补测试 + 补迁移链。
- 归属判定：① 换全新空场景还在不在？不在→.scene。② 丢了能从源 GLB 反推？能→不存。
- 覆盖链：aether.project.json ⊃ `<file>.meta.json` → `*.prefab.json` → `*.scene.json`，每级只存差异。guid→path 索引落 `.workbuddy/cache/`(不进 git)。
- 🔴 门禁测试禁用 node:fs（无 @types/node）→ 用 `import.meta.glob(...)`。

## 骨架 tip 骨 —— 22 + 5 = 27
- `LeftHandTip / RightHandTip / LeftToeTip / RightToeTip / HeadTip`；HUMANIK_ORDER 27 项，参与 skin 的仍是 22 根。
- 🔴 **索引对齐铁律**：joints[] 写的是 HUMANIK_ORDER 下标，tip 只能「保留槽位 + 权重置零」，**绝不能过滤数组**。
- tip：不产生 wrapper、不参与 skin（权重恒 0），不进重定向目标。同源三处必须一起改：humanik-template.ts、_tools/humanik_skeleton.json、rig_humanik.py。
- 骨骼「会话存、结果不存」：E04_..._rigged_animated.glb 已含 22 关节+IBM+权重+6 动画；.meta.rig 只存装配方。

## 绑定/蒙皮（全文 docs/15；P0 已修）
- P0-1 按骨 id 而非槽位 k 聚合邻域平均（修前无关骨拿到 18.8%）；P0-2 WeightMode='wrapper'|'distance' 下拉（原 `if (cylinders !== undefined)` 让 computeLbsWeights 成死代码）；P0-3 写 sidecar 前先 validateAssetMeta。UI §3.1–3.6 已修（53a5e32）。
- P1 未修：PEN_SCALE 不尺度不变；包裹体外顶点硬权重 1.0 兜底；**无 Undo/Redo**；无权重热力图。验证手法：binding/ 下临时建 __probe.test.ts 直跑真实模块，打印后**立即删除**。
- 半径三条路径都要响应：主视口 buildCylinderOverlay / 面板 buildCylinderOverlayFromSegments / 2D drawSkin。**顶点数看不出半径变化**，判据是几何指纹（debugCylinderStats sum+bbox）。改半径唯一入口 BindingPanel.setCylinderRadius()；拖拽半径=指针到骨轴**直线**垂距；合成 PointerEvent 的 setPointerCapture 会抛 → try/catch。

## 动画重定向与 Motion Match（设计定稿 2026-09-10，未实现；全文 docs/16）
- 🔴 **旋转守恒 ≠ 位置守恒**：retarget.ts 只守 `Q_tgt·d_tgt = Q_src·d_src`，**没守末端效应器世界位置** —— 滑步与幅度失真的唯一病根。
- 修法：抽末端世界轨迹 → 按**链比**（腿/臂/脊柱各自算，非全局 scale）映射 → 两骨解析 IK 反解 → 接触帧脚锁定 + 根回退。
- 🔴 两个易混的量：`hipToAnkleY = 0.97`（根位移缩放，改动破坏 retarget.test.ts 40+ 断言）；`legLen = 0.87`（IK 链比与可达半径）。差 11%。
- **手臂不走 IK**（用户已定）。MVP 只有双腿走 IK，中轴全 FK。T1/T2 退化检验是基石 ⟹ L1 只能用**各向同性**缩放。极向量取自源姿态；IK 只叠加 swing，twist 保留。
- **离线烘焙，不是 runtime IK**：输出 RetargetClip 烘进 GLB animations[]。

## 3D 资产生成管线（全文 docs/06）
- pipeline_character.py：front.png → 混元图生3D → decimate_cluster(质检=表面积保持率>80%) → bake_lowpoly(xatlas) → rig_character → retarget_bvh → validate_glb。入口 gen3d_from_image.py。
- 两套 Python：云端/绑骨 versions/3.13.12(requests)；减面/烘焙 envs/default(pymeshlab+xatlas)。混元图生3D 5 次/天(429) 且不能带 --prompt。export_labmesh 用 (x,-z,y)，极性反 --up-flip。

## WebGPU / 冒烟 / 浏览器验证（AGENTS.md §4）
- 编码期陷阱→skill webgpu-coding-pitfalls；运行时验证→skill webgpu-headless-validate。tsc+vite build 全绿照样线上炸。
- **headed Chrome + 真实 GPU，禁止 headless + SwiftShader**；🔴 不要加 `--no-sandbox`/`--disable-dev-shm-usage`（本沙箱反而起不来）；固定 profile `.workbuddy/tmp/chrome-profile`，优先复用已开 tab。
- `editor:smoke` 5100 不在时自起 vite 但 readiness 探测失败并**卡死**（实测 1h39m）→ 跑前先 `curl -sk https://localhost:5100/`。
- 已知遗留失败：autoFitCylinders 断言读 LeftArm 拿旧值 0.091（钩子返回的已是正确 0.057492）—— 断言读取路径与半径表不同步。
- 🔴 冒烟硬编码 sandbox 期望（13 物体/15 节点），但启动场景已是 floor-1（18 物件）→ 恒 5 FAIL。待办：断言改成从实际加载的场景文件派生。
- 自签 HTTPS 下 undici `fetch()` 挂 → 探针用原生 `https.get`(`rejectUnauthorized:false`)。vite 输出带 ANSI → 匹配端口前先 stripAnsi。

## 场景灯光（2026-09-14 已接线，57e5a90）
- `environment` + 第一个启用的 `Light` 组件 → loadScene 返回 → main.ts `applySceneEnvironment()` 写面板参数 + syncAll。场景是真源，面板滑块是读写器；方向（方位/仰角）schema 没有，仍归编辑器。
- 灯光基准：主光 1.4；s1 材质 #707A8C（原 #1B1F2B 在主题曝光下被 AgX 暗部压缩推到近黑）。
- 🔴 关卡背景 = 虚空底 + 主题雾距离渐变，**不要用白 albedo 天穹**。
- CDP 探针：.workbuddy/tmp/light-probe.mjs / closeup-probe.mjs / png-sample.mjs（像素采样——眼睛会被对比度骗）。

## 关卡生成（一层一关，2026-09-09 落地）
- `node tools/level/gen-level.mjs [--start=floor-2]`——设计表在脚本内（FLOORS/ROOM_SPECS/THEMES），生成 assets/scenes/act1/floor-N.scene.json 并登记 project.json、切 startIndex。幂等可重跑。
- 🔴 gizmo 铁律（已门禁化）：RoomVolume/SpawnPoint 必须同时挂 MeshRenderer，否则编辑器里隐形（instantiate 只渲染 MeshRenderer）。门禁 packages/scene/test/level-scenes.test.ts。NavZone 故意豁免。
- 🔴 gizmo 颜色只能用共享材质 s0-s6：override 的 patch 被 resolveMaterialId 丢弃，自定义颜色无效。
- 真机验证：`node tools/level/verify-level.mjs`。⚠️ **boot 日志会说谎**，要看页面内探针（Runtime.evaluate 读 DOM/fetch project.json）。
- 编辑器 boot 已修：loadScene 带回 editorCamera 并应用、boot 后 refreshHierarchy、ZOOM_MAX/PAN_LIMIT 放开到 120。切换预览层后**刷新浏览器页面**才生效。

## Headless Runtime（2026-09-15 落地，分支 feature/headless-runtime）
- 架构定调：**运行时中心 > 编辑器中心**。runtime 纯 CPU、零 GPU、确定性（固定种子 RNG），Agent 拿到完整反馈闭环；渲染只是可插拔视图。
- `packages/runtime/`（不 import 任何 @aether/*，四种宿主可复用）：types.ts（AgentKind/CharacterStats/SpawnRequest/AgentView）+ world.ts（SoA 列 + makeRng + addPlayer/spawn/tick/view/snapshot）。分离是 O(n²)，500 僵尸前必须换空间网格。
- `npm run runtime:build` = tsc → CJS 到 `.workbuddy/tmp/runtime`；`npm run sim` = build + `node tools/level/sim-level.mjs`。
- `tools/level/sim-level.mjs`：读 floor-N.scene.json → 解析 RoomVolume/SpawnPoint → 建 World → 推进 → **导出快照 `.scene.json`** → 登记 project.json。参数 `--floor --times --seed --focus`。
- **「人能看到画面」的路径**：headless 跑完导出普通 .scene.json，编辑器零改动即可打开——不必等 Play 模式（S3）。三阶段：① 静态快照（已完成）② 编辑器 Play 桥接 ③ 游戏本体 5101。
- 编辑器现状三问结论：① 无 NPC 判别机制（category 纯展示、layer 有 Character 层但引擎不消费、SceneNode 无 tag）；② 不改引擎只能到数据层，到不了行为层（GLB 渲染被 renderer.ts:803 硬跳过）；③ **运行时动态加载执行独立脚本不支持且架构禁止**（ADR-017；assets/behaviors/ 不存在、defineBehavior 仅在注释出现）。
- 后续路线：① 行为注册表 ② Play 模式骨架 ③ 单房 spawn 闭环 ④ 多实例渲染（instancing）。

## 门禁（8 道，收尾全跑）
typecheck · npm test · editor:build · editor:smoke · content:check · verify:prefix · scene:gen · scene:check

## 线上资料库（workbuddy.cn/space）
- 流程：connect_open_platform 换票(1800s) → list-user-spaces 判 category(personal 直接写/team 停等) → get_doc_reviews.py --page-id → submit_doc_edit.py(新增) / submit_review_edit.py(改已有)。
- 🔴 Table 只接受无属性；仅 delete/insert_before/insert_after，禁 update；加删行列=整表重建 → rowHeader 永久丢失。新建整篇用 create_doc.py。本地 docs/ 是真源。线上节点：docs/09 → FNfRd1b8idYncNDIdKBmvQ；docs/14 §14–§15 → 48WumseQVdiYkWOQL2pz94。

## 环境坑（Windows 沙箱）
- Git Bash 会突然损坏（`dirname/cd/head/tail: command not found` + wsl.exe 拦截）→ 改用 PowerShell（重定向到 `.workbuddy/tmp/*.log` 再 Read，直接输出常被吞；中文乱码但功能正常）+ Write/Read/Glob/Grep 工具。
- `nohup ... & disown` 起的进程活不过命令结束 → 用 run_in_background。真正 unattached 需系统级方案（schtasks/服务），**须先征求用户授权**。
- present_files 探不活自签 HTTPS（curl -sk 返 200 但工具报 not reachable）→ 改用 CDP 截图。
