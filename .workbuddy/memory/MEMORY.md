# 项目长期记忆（末日尸潮 / Aether Game Editor）

## 🔴 铁律
- **git**：提交即推送（逐笔），禁攒本地；只 add 本会话改的文件，禁 `git add -A`；中文 message（`git commit -F <utf8文件>`）。
- **未经许可禁碰 `.git` 内部**（fsck/删文件/建 refs/碰 pack/gc），异常只报告症状。长 git 操作用 run_in_background。
- remote `git@github.com:fangye100/workbuddy-zombie-shooter.git`（SSH，**shooter**；另有空仓 shotter）。
- **pnpm 9**（禁 npm/yarn）；新 worktree 先 `pnpm install` + `git lfs pull`，**LFS 指针态禁跑 scene:gen**。
- **Python 读写文本毁行尾**：改已存在文件一律二进制 rb→replace→wb。
- TS5.9 泛型 TypedArray 要在**源头**标 `<ArrayBuffer>`，不是调用点 cast。
- 门禁（8 道，收尾全跑）：typecheck · pnpm test · editor:build · editor:smoke · content:check · verify:prefix · scene:gen · scene:check

## 环境 / 引擎
- 端口：编辑器 5100 / 游戏 5101；须 HTTPS + Tailscale。
- 🔴 不用 `core/src/ecs/world.ts` 当场景骨架（remove 空实现/strideOf 硬编码）。静态物件走 SceneGraph，500 僵尸走 SoA+instancing。
- 容量：MAX_OBJECTS=64（超限必须报错）、MAX_MATERIAL_SLOTS=256、LIGHTS_FLOATS=40 → 只 1 dir+1 point，落选灯标黄。
- 🔴 项目文件走 `/__fs/file?path=` 端点（vite root=apps/editor，SPA fallback 会返 200+index.html 伪装成功）；统一入口 asset-util.ts，**路径先去掉前导斜杠**。仅 dev 中间件有。
- 场景灯光已接线：`environment` + 第一个启用 `Light` → `applySceneEnvironment()`。主光基准 1.4；s1 材质 #707A8C。关卡背景 = 虚空底 + 雾渐变，**禁白 albedo 天穹**。

## Scene 数据层（铁律 agents.md §2，全文 docs/14）
- 三份真源：`packages/scene/src/` 的 document.ts(场景) / project.ts(项目) / asset-meta.ts(sidecar)。改 schema 先改它 + 补测试 + 补迁移链。
- 覆盖链：`aether.project.json` ⊃ `<file>.meta.json` → `*.prefab.json` → `*.scene.json`（每级只存差异）。guid→path 索引落 `.workbuddy/cache/`。
- 归属判定：换全新空场景还在不在？不在→.scene；能从源 GLB 反推→不存。
- 🔴 门禁测试禁用 `node:fs`（无 @types/node）→ 用 `import.meta.glob`。
- 待办：userData 的 bob/aoMin·aoMax/background/category 提到正式 schema。
- 关卡生成：`node tools/level/gen-level.mjs`（一层一关，幂等）。🔴 gizmo 铁律：RoomVolume/SpawnPoint 必须同时挂 MeshRenderer（否则编辑器隐形），NavZone 豁免；gizmo 颜色只能用共享材质 s0-s6。真机验证 `verify-level.mjs`，**boot 日志会说谎**，看页面内探针。

## 绑定 / 蒙皮（全文 docs/15；当前主线 MCP 化）
- P0 已修：按骨 id 聚合邻域；WeightMode 下拉；写 sidecar 前 validateAssetMeta。P1 未修：PEN_SCALE 不尺度不变、包裹体外硬权重 1.0、无权重视图热力图。
- 骨架 22+5=27 骨（tip 保留槽位置零，**绝不过滤数组**）；同源三处同步改：humanik-template.ts / _tools/humanik_skeleton.json / rig_humanik.py。骨骼「会话存、结果不存」。
- 改半径唯一入口 `BindingPanel.setCylinderRadius()`；三条路径都要响应（主视口/面板/2D drawSkin）；判据是几何指纹不是顶点数。

## MCP 绑定实验（分支 followup/pr1-copilot-review，2026-09-23 主线）
- `tools/mcp-binding/`：把 `BindingSession` 暴露成 MCP stdio server（`aether-binding`，16 工具），让 Agent 能**看见**绑定结果并导出 rigged GLB。分层：`src/**` 纯 TS（禁 node import）→ esbuild → `dist/domain.mjs` ← `server.mjs`(node:fs/PNG)。
- 脚本：`pnpm run mcp-binding:build` / `mcp-binding:check`（=probe 全链路断言）。
- 注册：`.zcode/config.json` 的 `mcp.servers`（存在 `.zcode/` 时 `.agents/mcp.json` 被忽略）；工具名 `mcp__aether-binding__<tool>`。
- 🔴 **server 以自身所在目录为仓库锚点**——注册哪个 worktree 就读写哪个 worktree 的资产。
- 🔴 **骨骼视觉修正纪律（README §强制）**：必须自己截图看图修正（禁数值聚类盲调）；一次截图批量算完一侧+中轴再 mirror；每轮过**独立审核员子代理**直到 PASS（禁止自证）；**先 joint 后 wrapper**，joint 需用户确认；对位时 `wrappers.set(false)` 关 proxy；破损衣物不算轮廓。
- 双路径不共享内存态（MCP server 与浏览器各有独立 session）→ 一时段只走一条**写**路径，切换先 save 再 hydrate。
- 像素↔世界标定（370×760 画布）：`px=185+305.4·(x|z)`、`py=699.2−305.4·y`；换截图方式必须重推重验。
- **投影复现标定（760×1000 toon）**：scale 471.8 px/m；照 `render.ts` auto-fit 复现包围盒（mesh ∪ 关节±0.02）后**误差 <0.7px**，像素↔世界可双向换算。**渲染必须 mesh-only**（骨架线会割断剪影）。判据 = 关节投影是否落在 run 内，**悬空 = 铁证错**。方法已存 skill `binding-geometry-audit`。
- 🏁 **E-01 绑定审核结论（hy4，2026-09-24）**：手臂链 x 全线偏内 —— 肘 +8.8cm、腕 **+16.9cm（落在左大腿上）**，6 关节中 **5 个悬空**；根因是 x 按「贴身」填（0.27→0.33→0.30 递减）而网格手臂**外张**（0.284→0.418→0.469 递增）。LeftFoot 偏内 7.5cm。🔴 **E-01 网格本身左右不对称**（手臂 1.5–3.5cm、**小腿 8cm**）→ **禁纯镜像，须左右分别对位**。报告 `.workbuddy/tmp/hy4/REVIEW-E01-binding-hy4.md`，**尚未写入 sidecar**。

## Retargeting（全文 docs/16/16A/16B）
- MR-01..06 已交付并入 main（f9e1be8）；剩真实 mocap 验收、首次标定创建 UI、MR-07/08。
- 🔴 接触锁脚要求 `SourceCalibration.markers` **显式**足底标记，未标定=不做。`pelvisHeightM` = 骨盆到支撑面**相对量**，不得再减 planeY。
- 🔴 两个易混量：`hipToAnkleY=0.97`（根位移缩放）vs `legLen=0.87`（IK 链比）。手臂不走 IK，MVP 只双腿，**离线烘焙**。
- 单位上下文 targetUnitCtx 独立保留（不跨资产）；setTarget/setTargetCalibration 全事务化。

## 3D 资产管线（全文 docs/06）
- 管线：front.png → 混元图生3D → decimate_cluster(面积保持>80%) → bake_lowpoly(xatlas) → rig_character → retarget_bvh → validate_glb。两套 Python：云端/绑骨 versions/3.13.12；减面/烘焙 envs/default。混元图生3D 5 次/天(429)、不能带 --prompt。
- **LOD 铁律**：花脸根因是几何（聚类减面三角形跨部位）→ 焊点 + `quadric_edge_collapse_with_texture(preserveboundary=False)`；混元高模本体是封闭流形；glTF UV 逐顶点 ≠ OBJ vt 逐面角 → 必须 wedge 分裂；glb 手写容器 JSON 填 0x20、BIN 填 \x00、双 chunk 4 字节对齐；绑骨侧网格必须缩放到 2.05m 且脚底 y=0（LOD1 不缩放）；LOD2/3 复用骨架必须 `prune_base`。
- 面数 = roster.tris × 3（下限 3000）。🔴 **B-02 从未绑骨**（无 rigged/），只有 LOD0+LOD1。

## 浏览器验证（WebGPU，AGENTS.md §4）
- **headed Chrome + 真实 GPU**，禁 headless+SwiftShader；**不加** `--no-sandbox`/`--disable-dev-shm-usage`；**必加** `--ignore-certificate-errors`；固定 profile `.workbuddy/tmp/chrome-profile`。优先复用已开 tab。
- 自签 HTTPS 下 undici `fetch()` 挂 → 用原生 `https.get(rejectUnauthorized:false)`；vite 输出带 ANSI → 先 stripAnsi 再匹配。
- 遗留失败（脚本侧，非产品回归）：5 条冒烟硬编码 sandbox 期望 vs 实际 floor-1；1 条 autoFitCylinders 活引用 bug。**`CONSOLE ERRORS: 0` 才是关键指标**。
- 时序坑：HUD 每 0.4s 刷新（采样间隔 >700ms）；draw 基线轮询到连续两次相同再取。写用户资产的脚本**还原必须放 finally**。

## 开发 / 审核流程（元教训）
- 🔴 **判别力实验是交付前置**：每条回归自证「禁用修复→失败→恢复全过」；差分 oracle 观测量必须对错误敏感。
- 修"类"不修"字面"；**先审后记**（docs 不得预写复审结论）；typecheck 归零是 commit 前置（vitest 全绿会掩盖类型错误）；读回 oracle 不得用被测代码的 helper。
- 独立审核闭环（用户认可）：独立子代理自跑门禁 + file:line 证据 + VERDICT/P0–P3 → 修复 → 复审到 PASS。

## 线上资料库（workbuddy.cn/space）
- 流程：connect_open_platform 换票 → list-user-spaces 判 category(personal 可写/team 停等) → get_doc_reviews.py → submit_doc_edit.py(新增) / submit_review_edit.py(改已有)。本地 docs/ 是真源。
- 🔴 Table 只接受无属性；仅 delete/insert_before/insert_after；加删行列=整表重建 → rowHeader 永久丢失。新建整篇用 create_doc.py。
- personal spaceId `GHweUCr3bUooHpT4dfdVQi`；team `cCwTkzCwCevtZDBkVGnFEv` 仅 reader。
- 🔴 PowerShell 捕获子进程 stdout 会按本地码页解码 → **中文 UTF-8 不可逆丢失**。凡返回中文的脚本一律用 Python 包装器 `subprocess.run(capture_output=True, encoding="utf-8")` 直接写文件。
- 新建整篇先 `--dry-run` 看 `content=ok`；回读验收 failedCount/fatalCount 必须为 0。

## 环境坑（Windows 沙箱）
- Git Bash 会突然损坏（dirname/cd/head/tail not found）→ 用 PowerShell（重定向到 `.workbuddy/tmp/*.log` 再 Read）+ Write/Read/Glob/Grep。
- `nohup & disown` 起的进程活不过命令结束 → 用 run_in_background。
- present_files 探不活自签 HTTPS → 用 CDP 截图。
