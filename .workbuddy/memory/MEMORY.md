# 项目长期记忆

## 项目规则（铁律）
- 每完成一个任务收尾必须 `git add <本会话文件> && git commit && git push`，规范中文 commit message，不留脏工作区（**不是 `git add -A`**，见下条）。
- 🔴 Git 红线：未经许可禁止触碰 `.git` 内部（修复/fsck/删文件/建 refs/碰 pack 全禁）。发现异常只报告症状等指令。多 session 并行时每个 session 只负责提交自己业务范围内的修改文件（只 `git add` 本会话改的，禁止 `git add -A` 一把抓整树吞别人在途改动），不禁止各 session 自行提交；push 避开同分支并发。
- 远程 `origin = git@github.com:fangye100/workbuddy-zombie-shooter.git`（只走 SSH；拼写是 shooter，另有空仓 shotter 勿推）。

## 资料 / 真源（改前先改这里）
- 角色真源 `assets/characters/roster.json`（8 角色全量数据驱动）；风格真源 `assets/style/tokens.json`（→ `gen_assets.py` 出 .ase/.cube）。
- 画布施工看 `画布施工交接单.md`；ardot 两道门（settings `enabledPlugins` + 账号灰度 `EnableArdot`）详见该交接单，已开。
- 线上资料库（`docs/09` 镜像，nodeId `FNfRd1b8idYncNDIdKBmvQ`）需登录、未入 git——以本地 `docs/` 为同源真源。

## 引擎与编辑器（架构定案，2026-09-02）
- **头号架构债 = 两套平行代码**：`packages/render` 仅 130 行接口桩，而 `apps/lab/shader-lab` 有 ~13K 行真实 WebGPU 渲染器（renderer 2611 / gltf 1178 / ui 1917 / materials 三层语义）。
- **决策 ADR-001 渲染真源唯一化**：把 lab 的 renderer/gltf/materials 上提进 `packages/render|scene|gfx`；编辑器重构为 `apps/editor` 消费 packages，自身不带渲染器。详见 `docs/10-整体架构设计与长期发展规划.md`（含双轨长期路线图 Phase0–4）。
- 引擎真实落地：`ai`(流场寻路/战斗/行为 1759 行，最成熟) · `gameplay`(SoA 角色表 436) · `gfx`(device/handle) · `core`(app/ecs) · `framegraph`(Pass DAG)。规划里 platform/scene/assets/animation/physics/vfx/ui/audio 等尚未建——不为空包建目录。
- 验证方法论（docs/09 §7，已证伪 headless 假阴性）：数学 Node 直测 + headless WebGPU(Chrome152 + `--enable-unsafe-swiftshader`) + CDP 视觉像素判定 → 应作为引擎级 CI 标准。
- 换模型材质绑定：GLB node extras → nodePath → primitiveKey 三层匹配；nodeId 精确匹配须双侧 leaf 同名否则撞车；未认领进孤儿池。
- **端口（2026-09-03 订正，b25506c 锁定）**：**编辑器 5100**，**最终游戏 5101**（HMR / Tailscale HTTPS 同套合约）。以 `apps/editor/vite.config.ts` 的 `port` 为准。
- **脚本名坑（易踩）**：`npm run build` 构建的是 sample-00，**编辑器**是 `npm run editor:build`（产物走 5100）；冒烟是 `npm run editor:smoke`（无 `verify:smoke`），且需传 `--glb <rigged.glb>` 才会启用骨骼动画断言组，不传则 3 条 SKIP。另有 `verify:glb` / `verify:uv` / `verify:facade` / `verify:dock`（见下）。`lab`/`lab:build` 只是 `editor*` 的兼容别名。
- **资产库面板「不见了」陷阱**：`apps/editor/src/asset-browser.ts` 的 `zh.assets.collapsed === '1'` 持久化在 localStorage —— 折叠后 `.ad-body` / `.ad-grip` `display:none`、`height:auto`，视觉上只剩标题栏，容易被误判为「整个 dock 没了」。F12 → Application → Local Storage 删 `zh.assets.collapsed` / `zh.ui.dockH` → Ctrl+Shift+R 即恢复。已固化 `tools/verify/dock-probe.mjs`（`node tools/verify/dock-probe.mjs`）专查 dock 运行时状态，遇到类似报告可直接复跑。
- **ADR-008 验证资产与结论同入库**：任何「跑了 X 条断言 / Y 条全绿」的结论，其脚本/配置/产物必须一并进版本库，否则结论不可复现（曾因临时脚本导致 docs/12 的「68%」数字无法复算）。
- **ADR-009 测试与被测代码同位**：`packages/*` 测试进 `packages/<pkg>/test/`，`apps/*` 测试进 `apps/<app>/test/`；禁止引擎测试寄居 app 的 `src/`，禁止测试反向依赖上层。
- dormant 模块：`packages/framegraph/src/graph.ts` + `packages/render/src/feature.ts` 共 425 行零运行时消费者，已加 DORMANT 标记但未删；注意 `apps/editor/src/features/*.feature.ts` 的 feature 与 `RenderFeature` **不是同一个东西**（命名撞车）。

## 3D 资产生成管线（E-04 跑通）
- 入口 `assets/characters/_tools/gen3d_from_image.py`（勿直接调 buddy-cloud `--image-base64`，本地 PNG base64 超 Windows 命令行长度上限）。
- 减面首选 `decimate_cluster.py`（对病态拓扑免疫）；质检硬判据 = 表面积保持率 >80%。混元产物脚在 z-max，`export_labmesh` 用 `(x,-z,y)`，极性反用 `--up-flip`。

## 名册全角色绑定流水线（2026-09-02 跑通，6/8 完成）
- **全链路脚本 `assets/characters/_tools/pipeline_character.py`**：概念图 front.png → 混元图生3D(80000 tris) → decimate_cluster → bake_lowpoly(xatlas UV+贴图) → rig_character → retarget_bvh(烤6段) → validate_glb。单角色一条命令跑完。
- **rig_character.py**（rig_e04.py 的通用化）：支持任意角色、按切片法**自动判定朝上轴极性**（脚在 z-max/z-min）、按 roster 身高取名；E-04 回归产物与 rig_e04.py 仅 y 轴恒定 3.6e-4 偏移（脚精确落地 y=0），bind-pose LBS max_err=1.12e-7。
- **两套 Python 环境必须分开**：云端/绑骨用 `binaries/python/versions/3.13.12`（要 requests）；减面/烘焙用 `binaries/python/envs/default`（要 pymeshlab+xatlas）。
- **headless 验证**：`cdp-rigged.mjs`（参数化，GLB 路径走命令行）任意角色 20 断言；E-01/E-02/E-03/E-04/E-05/B-01 均 20/20 PASS（0 console/0 exception）。
- **⚠️ 混元每日提交上限 = 5 次/天**（dimension hy-3d，HTTP 429）。本日已用满：E-01/E-02/E-03/E-05/B-01 共 5 次 → **B-02/B-03 被限流挡住**，次日额度刷新或单独补跑 `pipeline_character.py --id B-02 --id B-03` 即可。
- 图生3D **不能同时带 --prompt**（API 拒 "Prompt和ImageBase64不能同时存在"）。
- 现状：E-01/E-02/E-03/E-04/E-05/B-01 六个角色 rig+anim 全齐；B-02/B-03 待次日额度。
- worktree 内用 npm 装依赖会漂版本（TS 5.9/@webgpu/types 0.1.72 → 一片 TS2345）；主仓 pnpm 钉 5.6.3 / 0.1.49，修法 `npm install --no-save` 钉同版。
