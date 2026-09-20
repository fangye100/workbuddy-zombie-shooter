# 项目长期记忆

## 🔴 铁律（git / 编码）
- **提交即推送**：每产生一个 commit 当场 push，多笔逐笔推，禁攒本地。push 失败当场解决或上报。
- 只 add 本会话改的文件，禁 `git add -A`（并行 session 会吞别人在途改动）；中文 commit message（用 `git commit -F <utf8 文件>`）。
- **未经许可禁碰 `.git` 内部**（fsck / 删文件 / 建 refs / 碰 pack）。异常只报告症状。
- 长 git 操作（stash/gc/repack/clone）必须 run_in_background 或加大 timeout。
- remote `git@github.com:fangye100/workbuddy-zombie-shooter.git`（SSH；拼 shooter，另有空仓 shotter）。
- **Python 读写文本毁行尾**：文本模式读就把 CRLF 归一成 LF。改已存在文件一律**二进制** rb→replace→wb。自查 `git diff --stat` vs `--ignore-cr-at-eol`。已提交未 push 的行尾事故**用新提交修，不要 amend**。

## git 灾难恢复（2026-09-08 实证）
- 症状：dubious ownership；`.git/refs/` 与 `packed-refs` 同时消失；`objects/pack/` 只剩 .idx 无 .pack。
- 诊断：`.git/index` 常幸存，**用 Python 解析它**（DIRC v2：12 字节头 + 每条目 62 字节固定 + 路径 + 补齐 8 字节）即得损坏瞬间被跟踪的完整清单。
- 恢复四步：① `mv .git .git.broken-<日期>`（不删）② `git clone --no-checkout <url> <tmp>`（**必须用 `C:/...` 路径**，Git Bash 的 `/c/...` 静默失败）③ `tmp/.git` 挪进来 + 旧 `config` 覆盖（保 LFS filter 与 remote）④ `git read-tree HEAD` 填 index。
- LFS 验证看**文件大小**（MB 级=真实内容；~130 字节=没 smudge 的指针）。坏的 `.git` 用 `.git/info/exclude` 本地排除。

## ADR 速查（全文 docs/10 + docs/14）
001 渲染真源唯一化 · 002 资料库运行时单一真源 · 003 验证分层 · 005 包体 @aether/* · 007 render(L3) 不反向依赖 content(L4) · 008 验证资产与结论同入库 · 009 测试同位 · **010 场景唯一数据载体** · 011 Node/Component(AoS)+SoA ECS · 012 扁平节点表+parent · 013 JSON+SCHEMA_VERSION+迁移链 · 014 Edit/Play 分离 · **015 aether.project.json 锚点** · 016 sidecar 同名 .meta.json · **017 脚本=行为注册表**

## 真源
- roster.json(npc5+boss3，顶层键非 characters) + tokens.json → content:gen → packages/content/src/generated/*；content:check 不同步 exit 1。
- ⚠️ roster.json 承载不了 CharacterDef（缺胶囊半径/质量/转向/视野/受伤盒等 11 项）——硬生成=把编造数字洗成单一真源，比硬编码更坏。
- L-8 待决策：params.ts gradeShadowMult 0.95 vs 真源 0.78、gradeShadowMix 0.12 vs 0.2（改了变画面）。

## 环境定案（2026-09-15）
- 🔴 包管理器 = **pnpm 9**（锁文件已入库，禁 npm/yarn——会产生竞争锁文件）；worktree 新建/迁移后先 `pnpm install` + `git lfs pull`，**LFS 指针态禁跑 scene:gen**（scene:check 报一堆哈希失配的真因是未 smudge，不是 meta 过期）。
- TS5.9 泛型 TypedArray 要求**源头**标注 `<ArrayBuffer>`（MeshData/SkeletonData/Mat4 等 ~19 文件已标），不是调用点 cast。

## 编辑器 / 引擎
- 端口 编辑器 5100 / 游戏 5101（agents.md §1）。脚本：测试 `pnpm test`(=vitest run)；build=sample-00；编辑器 editor:build；冒烟 editor:smoke（传 --glb 才启用骨骼断言）。
- 🔴 不用 core/src/ecs/world.ts 当场景骨架（remove 空实现/strideOf 硬编码/isChanged 恒真）。静态物件走 SceneGraph，500 僵尸走 SoA+instancing。
- 容量：MAX_OBJECTS=64（静态，根因是 transformBuf 大小）超限必须报错不能静默丢；MAX_MATERIAL_SLOTS=256；LIGHTS_FLOATS=40 → 只 1 dir+1 point，多灯按 priority 取 top-1+top-1、落选标黄。
- 🔴 项目文件必须走 `/__fs/file?path=` 端点：vite root=apps/editor，项目根文件不在其下 → SPA fallback 返 HTTP 200 + index.html，`res.ok` 为真、只有 `res.json()` 抛 `Unexpected token '<'` 才暴露。统一入口 asset-util.ts 的 fileUrl()/readProjectFile()/writeProjectFile()。仅 dev 中间件有。**路径要先去掉前导斜杠**，`getSceneSource().url` 带前导 `/`。

## Scene 数据层（铁律 agents.md §2/§2.5，全文 docs/14）
- 三份真源：document.ts(场景)/project.ts(项目)/asset-meta.ts(sidecar)。改 schema 先改它 + 补测试 + 补迁移链。
- 归属判定：① 换全新空场景还在不在？不在→.scene。② 丢了能从源 GLB 反推？能→不存。
- 覆盖链：aether.project.json ⊃ `<file>.meta.json` → `*.prefab.json` → `*.scene.json`，每级只存差异。guid→path 索引落 `.workbuddy/cache/`(不进 git)。
- 🔴 门禁测试禁用 node:fs（无 @types/node）→ 用 `import.meta.glob(...)`。
- S0/S1 已完成；待办第一件事：把 userData 的 bob/aoMin·aoMax/background/category 提到正式 schema。

## 关卡生成（一层一关，2026-09-09）
- `node tools/level/gen-level.mjs [--start=floor-2]`——设计表在脚本内；生成 assets/scenes/act1/floor-N.scene.json，登记 project.json 并切 startIndex。幂等可重跑。
- 🔴 gizmo 铁律（已门禁化）：RoomVolume/SpawnPoint 必须同时挂 MeshRenderer，否则编辑器里隐形（instantiate 只渲染 MeshRenderer）。NavZone 故意豁免。门禁 packages/scene/test/level-scenes.test.ts。
- 🔴 gizmo 颜色只能用共享材质 s0-s6：override 的 patch 被 resolveMaterialId 丢弃。
- 真机验证 `node tools/level/verify-level.mjs`。⚠️ **boot 日志会说谎**，要看页面内探针（CDP Runtime.evaluate 读 DOM/fetch）。

## Headless Runtime（分支 feature/headless-runtime，全文 docs/17 + docs/18）
- 架构定调：**运行时中心 > 编辑器中心**。「Node 和浏览器必须共用装载与游戏规则」；每类运行状态只能有一个权威 owner。
- `packages/runtime/`：loader(场景→运行描述) / session(世界) / play-session(播放状态机) / spawn-edit(领域编辑命令+撤销) / spawn-ab(A/B 指纹) / doc-diff(路径级差异)。依赖 scene/content/gameplay/ai（纯 CPU），**不依赖 render 与编辑器**。
- 已完成：WU-1 装载与 playerStart(v3) · WU-2 session(CharacterTable+FlowField) · WU-3 动态实例渲染 · WU-4 Play/Pause/Step/Stop · WU-5 刷怪点编辑闭环。下一站 WU-6 收尾报告。
- 🔴 刷怪点每个用 `mixSeed(种子, nodeId)` 派生**独立 RNG 流**；共用一条流时改 A 的 count 会把 B/C 的散布整体平移，局部编辑就不成立。
- 「人能看到画面」的路径：headless 跑完导出普通 .scene.json，编辑器零改动即可打开。
- 编辑器现状：无 NPC 判别机制（category 纯展示，引擎不消费 layer）；**运行时动态加载执行脚本架构禁止**（ADR-017）。

## 骨架 tip 骨 —— 22 + 5 = 27
- `LeftHandTip / RightHandTip / LeftToeTip / RightHandTip / HeadTip`；HUMANIK_ORDER 27 项，参与 skin 的仍是 22 根。
- 🔴 **索引对齐铁律**：joints[] 写的是 HUMANIK_ORDER 下标，tip 只能「保留槽位 + 权重置零」，**绝不能过滤数组**。
- tip 不产生 wrapper、不参与 skin、不进重定向目标。同源三处一起改：humanik-template.ts、_tools/humanik_skeleton.json、rig_humanik.py。
- 骨骼「会话存、结果不存」：E04_..._rigged_animated.glb 含 22 关节+IBM+权重+6 动画；.meta.rig 只存装配方。

## 绑定/蒙皮（全文 docs/15；P0 已修）
- P0-1 按骨 id 而非槽位 k 聚合邻域平均（修前无关骨拿到 18.8%）；P0-2 WeightMode='wrapper'|'distance' 下拉；P0-3 写 sidecar 前先 validateAssetMeta。
- P1 未修：PEN_SCALE 不尺度不变；包裹体外顶点硬权重 1.0；**无 Undo/Redo**；无权重热力图。
- 半径三条路径都要响应：主视口 buildCylinderOverlay / 面板 buildCylinderOverlayFromSegments / 2D drawSkin。**顶点数看不出半径变化**，判据是几何指纹。改半径唯一入口 BindingPanel.setCylinderRadius()；合成 PointerEvent 的 setPointerCapture 会抛 → try/catch。

## 动画重定向与 Motion Match（设计定稿未实现，全文 docs/16）
- 🔴 **旋转守恒 ≠ 位置守恒**：retarget.ts 没守末端效应器世界位置 —— 滑步与幅度失真的病根。修法：末端世界轨迹 → 按链比映射 → 两骨解析 IK → 接触帧脚锁定。
- 🔴 两个易混的量：`hipToAnkleY = 0.97`（根位移缩放，改了破坏 40+ 断言）；`legLen = 0.87`（IK 链比）。差 11%。
- **手臂不走 IK**（用户已定），MVP 只有双腿 IK。T1/T2 退化检验 ⟹ L1 只能各向同性缩放。极向量取自源姿态；IK 只叠加 swing，twist 保留。**离线烘焙**，不是 runtime IK。

## 3D 资产生成管线（全文 docs/06）
- pipeline_character.py：front.png → 混元图生3D → decimate_cluster(质检=表面积保持率>80%) → bake_lowpoly(xatlas) → rig_character → retarget_bvh → validate_glb。入口 gen3d_from_image.py。
- 两套 Python：云端/绑骨 versions/3.13.12(requests)；减面/烘焙 envs/default(pymeshlab+xatlas)。混元图生3D 5 次/天(429) 且不能带 --prompt。export_labmesh 用 (x,-z,y)，极性反 --up-flip。

## WebGPU / 浏览器验证（AGENTS.md §4）
- 编码期陷阱→skill webgpu-coding-pitfalls；运行时验证→skill webgpu-headless-validate。tsc+vite build 全绿照样线上炸。
- **headed Chrome + 真实 GPU，禁止 headless + SwiftShader**；🔴 不加 `--no-sandbox`/`--disable-dev-shm-usage`；🔴 必须加 `--ignore-certificate-errors`（新 profile 不信任自签证书 → 停在警告页，页面根本不加载，极易误判成"应用起不来"）。固定 profile `.workbuddy/tmp/chrome-profile`。
- `editor:smoke` 自带 dev server：5100 不在时会自起 vite（2026-09-19 实测成功并自停）；历史上曾探测失败**卡死** 1h39m，跑前仍建议确认 5100 状态。
- 已知遗留失败（非本次引入；2026-09-19 合并态实测 127 PASS / 6 FAIL）：5 条冒烟硬编码 sandbox 期望（13 物体/固定名/category/pickable）vs 实际启动场景 act1/floor-1（19 物体）；1 条 autoFitCylinders 断言自身活引用 bug。6 条均为脚本侧问题、非产品回归；`CONSOLE ERRORS: 0` 才是关键指标。
- 🔴 实机探针的时序坑：HUD 每 0.4s 才刷新（采样间隔要 >700ms）；draw 基线要轮询到连续两次相同再取。
- 🔴 **写用户资产的验证脚本：还原必须放 `finally`**，且校验失败也要还原；把「原文长度合理」也做成断言。
- 自签 HTTPS 下 undici `fetch()` 挂 → 用原生 `https.get`(`rejectUnauthorized:false`)。vite 输出带 ANSI → 匹配前先 stripAnsi。

## 场景灯光（2026-09-14 已接线）
- `environment` + 第一个启用的 `Light` → loadScene 返回 → main.ts `applySceneEnvironment()`。场景是真源，面板滑块是读写器；方向（方位/仰角）schema 没有，仍归编辑器。
- 灯光基准：主光 1.4；s1 材质 #707A8C（原 #1B1F2B 被 AgX 暗部压缩推到近黑）。
- 🔴 关卡背景 = 虚空底 + 主题雾距离渐变，**不要用白 albedo 天穹**。
- CDP 探针：.workbuddy/tmp/light-probe.mjs / closeup-probe.mjs / png-sample.mjs（像素采样——眼睛会被对比度骗）。

## Retargeting（全文 docs/16/16A/16B；生产 binding/motion-retarget/ + retarget-session/retarget-workbench）
- 状态：MR-01..06 已交付（16 轮审核全 PASS + 用户侧确认 05058af）；**剩真实 mocap 2m/0.5m 蒙皮验收、首次标定创建 UI（视口拾取）、MR-07/08**。
- 🔴 接触要求 SourceCalibration.markers **显式**足底标记（.heel/.ball 按骨名+部位身份对应）；未标定=不做世界锁脚，不从动画推导。`pelvisHeightM` 契约=骨盆到支撑面**相对量**，任何判据/管线不得再减 planeY。
- 🔴 标定兼容判据（换骨架停用）：只用**骨盆相对骨架几何**（根 OFFSET/位置通道/世界摆放无关）+ **链推导足类**（3 骨腿链末端骨）逐标记 ±35% 带宽 + **资产归属**（assetKey：入口A=绑定会话、入口B=物体引用；完整标定与单位上下文都不跨资产沿用）。根 OFFSET ≠ 世界骨盆高（有位置通道时采样世界根由通道决定）。
- 🔴 单位上下文（targetUnitCtx）独立保留：同资产编辑保留、换资产不沿用、cm 推断兜底（人形区间 [0.1,5]m）；setTarget/syncTarget/setTargetCalibration **全事务化**（构建失败完整回滚旧标定）。
- L0 retargetBvh 只作映射诊断报告；动画产物一律走新管线；`hook.anim` 形状兼容冒烟。浏览器定向验证脚本 `.workbuddy/tmp/verify-workbench.mjs`（34 断言，A–L 段）。

## 开发/审核流程（元教训，2026-09-15/16 实证）
- 🔴 **判别力实验是交付前置**：每条新回归自证「禁用修复→测试失败→恢复全过」；差分 oracle 的观测量必须对被测错误敏感（pelvisHeightM 对单位敏感 ✓，planeY 恒≈0 ✗）。
- 修"类"不修"字面"；**先审后记**（docs 不得预写复审结论）；typecheck 归零是 commit 前置（vitest 全绿会掩盖类型错误）；读回 oracle 不得用被测代码自己的 helper（自证）。
- 独立审核闭环模式（用户认可）：独立子代理自跑门禁 + file:line 证据 + VERDICT/P0–P3 → 逐项修复 → 复审，直到 PASS。

## 门禁（8 道，收尾全跑）
typecheck · pnpm test · editor:build · editor:smoke · content:check · verify:prefix · scene:gen · scene:check

## 线上资料库（workbuddy.cn/space）
- 流程：connect_open_platform 换票(1800s) → list-user-spaces 判 category(personal 直接写/team 停等) → get_doc_reviews.py --page-id → submit_doc_edit.py(新增) / submit_review_edit.py(改已有)。
- 🔴 Table 只接受无属性；仅 delete/insert_before/insert_after，禁 update；加删行列=整表重建 → rowHeader 永久丢失。新建整篇用 create_doc.py。本地 docs/ 是真源。
- 线上节点：docs/09 → FNfRd1b8idYncNDIdKBmvQ；docs/14 §14–§15 → 48WumseQVdiYkWOQL2pz94；**docs/06 §7（3D 角色资产 LOD 管线·路线 A）→ PoRjTxrLfqhGrHQYENM1UA**。
- personal 空间 spaceId = `GHweUCr3bUooHpT4dfdVQi`（我的文档）；team 空间 `cCwTkzCwCevtZDBkVGnFEv` 本账号仅 reader，不可写。
- 脚本路径：`<library skill>/space_api.py`、`doc/create_doc.py`、`doc/get_doc_reviews.py`（**不在 `doc/scripts/` 下**）。
- 🔴 **PowerShell 捕获子进程 stdout 再重定向会按本地码页解码，中文 UTF-8 字节在非法序列处被替换 → 不可逆丢失**（事后用 latin1→utf-8 往返也修不回）。凡调这类会返回中文的脚本，一律用 Python 包装器 `subprocess.run(capture_output=True, encoding="utf-8")` **直接写文件**，不经 PowerShell 捕获。
- 新建整篇的判据：先 `--dry-run`（本地校验、不发 HTTP、不需 token），看 `content=ok`；正式创建后回读验收，`failedCount`/`fatalCount` 必须为 0。

## 3D 资产 LOD 管线（路线 A，2026-09-18 定稿，全文 docs/06 §7）
- **铁律 1**：贴图「花脸」的根因是**几何**不是 UV 算法 —— 聚类减面产出的三角形横跨模型不同部位，采任何贴图都花。正解 = 焊点 + pymeshlab `..._quadric_edge_collapse_with_texture`（`preserveboundary=False`）。
- **铁律 2**：混元高模几何本体是**封闭流形**（焊点后 E=1.5F / 边界 0 / 非流形 0）；表面的 20%「边界边」是 UV 切分假象，别用 `preserveboundary=True` 去保护（会让 QEM 卡死不动）。
- **铁律 3**：glTF `TEXCOORD_0` 是**逐顶点**属性，OBJ 的 vt 是逐面角 → 必须做 wedge 顶点分裂，否则 UV 错配、全身偏色。
- **铁律 4**：glb 手写容器 —— JSON chunk 填充用**空格 0x20**（`\x00` 会让 `JSON.parse` 抛错）、BIN 才用 `\x00`、`buffers[0].byteLength` 要同步扩、双 chunk 都 4 字节对齐。
- **铁律 5**：低模 UV 与原生意一致时**直接内嵌原生 4096² 贴图**，零烘焙；换贴图不必重跑减面。
- **铁律 6**：绑骨侧网格必须等比缩放到骨架高度 2.05 m 且脚底 y=0（HumanIK 骨点是固定世界坐标）；**LOD1 不缩放**。
- **铁律 7**：LOD2/3 复用既有骨架时**必须 `prune_base`** 丢弃旧网格 accessor，否则体积反超 LOD1（5.03 vs 3.07MB）；原始模板存 `.pre-uvkeep.bak` 保证幂等。
- 工具：`decimate_uvkeep.py`（LOD1）/ `rig_uvkeep.py`（LOD2/3，`--char all` 批量）/ `verify-batch-lods.mjs`（浏览器逐档断言）。
- 面数定档 = roster.tris × 3（下限 3000）：E-01 3000 / E-02 3300 / E-03 3600 / E-04 4800 / E-05 3000 / B-01 12600 / B-02 18000 / B-03 15600。
- 🔴 **B-02 从未绑骨**（无 `rigged/` 目录），只有 LOD0+LOD1 两档；补骨骼档需先跑绑骨管线。
- 质检判据：面积保持 >90%、边界/非流形 0、UV 密度 p99/med <3、**点到面**距离（不是点到点）。

## 环境坑（Windows 沙箱）
- Git Bash 会突然损坏（`dirname/cd/head/tail: command not found` + wsl.exe 被拦）→ 改用 PowerShell（重定向到 `.workbuddy/tmp/*.log` 再 Read，直接输出常被吞；中文乱码但功能正常）+ Write/Read/Glob/Grep 工具。
- `nohup ... & disown` 起的进程活不过命令结束 → 用 run_in_background。真正 unattached 需系统级方案（schtasks/服务），**须先征求用户授权**。
- present_files 探不活自签 HTTPS → 改用 CDP 截图。
