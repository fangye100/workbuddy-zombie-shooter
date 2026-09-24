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
- 🔴 **5100 上的 dev server 属于主 worktree `game-design-zombie`**（不是本 worktree）——
  浏览器看到的永远不是 `-worktree-01` 的代码，改动「验证不到」是假象。
  查法：`Get-NetTCPConnection -LocalPort 5100` → PID → `Get-CimInstance Win32_Process` 看 CommandLine。
  本 worktree 要验证自己起：`pnpm exec vite --config apps/editor/vite.config.ts --port 5200 --strictPort`
  （run_in_background），再 `curl -sk https://localhost:5200/src/... | grep <新符号>` 确认是新代码。
- 🔴 沙箱：`cmd &` 起的进程活不过命令结束（Chrome 也一样）→ 一律用 run_in_background。
- 不用 `core/src/ecs/world.ts` 当场景骨架（remove 空实现/strideOf 硬编码）。静态物件走 SceneGraph，500 僵尸走 SoA+instancing。
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

### 🔁 wrapper 阶段（2026-09-24，E-01）
- **offset 是主要病灶**：11 根被拖去追破布（`LeftLeg [0,-0.130,0.200]` 等）→ 全清零后 unwrapped **2160→1178**。
- 🔴 **22 根全 `manual:true` 时 `autoFitCylinders()` 静默空操作**（`skin-proxy.ts:153` `continue`，changed=[]）。
- 🔴 **半径禁用分位数反推**：p90 在包破布 → 四肢半径变肉身 1.9–2.8× 且跨部位抢权重。
  用**密度峰值**（包内 dr 直方图 bin 5mm 取峰）或解剖经验值。僵尸类破损模型尤其如此。
- 定稿：offset 全清零 + 半径回原手工值，仅改 `Spine2` top 0.240→0.200/med→0.210、`Neck` 0.090→0.105。
  `unwrappedVerts=1280/4209 (30.4%)`，其余 30% 是破布/腐肉/描边壳（按设计不包）。
- 🔴 **出图投影必须含圆柱**：`render.ts` auto-fit 把 capsules ± 半径纳入包围盒；
  只按 mesh 算变换会**错位 17cm**（HD 标签浮在头顶上方）。关节阶段图不受影响（那时关圆柱）。
- 🔴 **纪律（用户令）**：wrapper 定好位置后**必须先发正/侧全貌图给用户核对，确认后才继续**。

### 🔁 下肢重审（2026-09-24，用户指「大腿和 hip 的 joint 太低」）
- **真裆 = y 0.980**（逐层两腿内缘间隙骤降点：0.97 时 4.5cm → 0.98 骤降 2.1cm）。
  🔴 别把「中轴最低网格点」当真裆（我误报过 0.855，那是破布/臀沟）。
- 定稿：`LeftUpLeg/RightUpLeg` 0.900→**0.995**、`Hips` 1.000→**1.040**（只改 y，
  x/z 高模复核本就对：腿截面中心 L+0.162/R−0.153 vs 现值 ±0.170）。commit `bfa60cf`。
- 🔴 **比值是诊断指标，不是目标函数**：第一版按「大腿:小腿=1.0」反推得 0.970，
  正好压在裆线上 → 被独立审核员驳回。**先定解剖位置（髋在裆上方 2–4cm），再用比例检查**。
- 下肢量测**必须用高模**（LOD 4209 点做 4cm 带只有 6–17 点，噪声极大）。
- 新判据「**12 方向射线包围**」（高模横截层 12 方向 0.32m 内是否打到几何）：
  ≥11/12 在肉里 / ≤9 边缘 / ≤6 悬空。⚠️ 验证不了高度（改前的 0.900 也 11–12/12）。

### 🔁 颈部审计（2026-09-24，用户指「脖子太低」）
- **颈柱 = y 1.48–1.68**（高模 `|x|<0.08` 的 z 连通块：背壳/颈柱/下颌三块，下颌 1.64 起出现）。
  柱轴斜向前上：1.50 中心 z=+0.060 → 1.62 +0.095 → 1.68 +0.100。
- 当前 `Neck (0,1.610,+0.020)` 包围 12/12 但在**躯干实体**、颈柱后方 ~7cm；`Neck→Head=0.358` 过长。
- 候选 A1.700 / **B1.660（推荐）** / C1.620 / D1.560；z 取颈柱值（1.660 处 +0.100）。**待用户定**。

### 🔁 脚踝/脚掌（2026-09-24，用户指「侧面的脚踝和脚掌要靠后」）
- 实测：脚 z ∈ [−0.421(脚跟), +0.037(脚尖)]，**脚长 0.458m**；**脚背顶面 y≈0.125**
  （y=0.12 层还有脚尖，y=0.13 层脚尖消失只剩靴筒）。
  🔴 踝部「最细截面」在 y=0.21 是**靴筒缩口**，不能当踝高。
- 定稿（commit `2531f14`）：`LeftFoot/RightFoot` z −0.250→**−0.310**、y 0.080→**0.110**；
  `LeftToeBase/RightToeBase` z −0.080→**−0.110**。踝落在脚长 24%（参考 25%）。
  大腿:小腿比不变（1.08/1.11）。高模闭环 front 6/6、side 6/6、12 方向全 12/12。
- 🔴 **判 run 归属必须用高模**：LOD 在 y=0.110 的 1.2cm 带里顶点太少 → **假阴性全判悬空**。

### 🔁 颈部（2026-09-24，用户指「脖子太低」）
- 颈柱（`|x|<0.08` 的 z 连通块）y **1.48–1.68**，下颌 1.64 起出现；柱轴斜向前上
  （z 中心 1.50 的 +0.060 → 1.62 +0.095 → 1.68 +0.100）。
- 🔴 **光看 y 不够**：改前 `Neck (0,1.610,+0.020)` 的 y 在颈柱 62% 处，但该高度颈柱是
  `[+0.082..+0.114]` → **z=+0.020 落在柱后 6cm 的空隙里**（背壳与脖子之间）。
  斜柱状部位（前伸僵尸颈、驼背脊柱）**必须两轴一起定**。
- 定稿（commit `5fb0832`）：`Neck` → **`(0, 1.700, +0.100)`**。`Neck->Head` 0.358→**0.239**、
  `Spine2->Neck` 0.322→0.438。高模闭环 front/side 各 13/13、射线奇偶 6/6 在内。
- 🔴 **待定**：**左膝 `LeftLeg` z=−0.082 在网格外约 2cm**（y=0.507 处左腿几何
  z∈[−0.232,−0.064]、中心 −0.148；**在网格内的 z 只有 [−0.14,−0.10]**）；
  右膝 `RightLeg` z=−0.084 刚好卡边界。用户「膝还可以」是正面判断，侧面左膝偏前。

### 🔴 判「在不在肉里」的真判据：射线奇偶（12 方向会假 PASS）
- **12 方向包围测的是「周围有没有几何」，不是「点在不在肉里」** ——
  夹在两层之间的空隙也得高分：E-01 Neck 改前（在空隙里）9/12、改后（在柱内）**也 9/12**，
  **区分不出来**。只能做快速体检。
- 真判据 = **Möller–Trumbore 射线与高模 OBJ 三角面求交，交点数奇数 = 在内部**，
  6 轴向投票 ≥3/6 判在内。E-01 全关节实测 6/6（除 tip 骨）。
- **还能量「合法区域」**：固定 (x,y) 沿 z 扫描看在网格内的 z 区间。
- ⚠️ `*Tip` 骨恒在外是**预期**（tip 不参与蒙皮）→ 别误判为缺陷。
- ⚠️ 前提是封闭流形；有孔洞的减面模型只报「判据不适用」。
- 🔴 **单视图 OK ≠ 对**：左膝正面看对称、侧面偏前 2cm。任何「位置对不对」都必须正/侧两视图都过。

### 📐 量化坐标参考线（2026-09-24 新增，默认开）
- 编辑器面板 `drawGrid()`（`binding-panel.ts`）+ MCP `render` 的 `grid` 参数。
- 与 `project()` **严格对称**反算可见世界范围 → 读数 = 数格子 × step，**标定这一步被消掉**
  （以往每次换截图方式都要重推像素↔世界，还读错过脚趾）。
- 验证：网格 44/44 命中（≤1px）；关节标记偏差 ≤0.4px（面板 `scale=295.62`、`originY=h*0.92`）。
- 🔴 **`render.ts` 的 auto-fit 无条件含 marker ±0.02**（不看 showMarkers）——
  自写叠加脚本必须 `withMarkers:true` 才对齐（false 时错 2.66px，true 时 0.51px）。

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
- 🏁 **E-01 绑定审核结论（hy4，2026-09-24）**：手臂链 x 全线偏内 —— 肘 +8.8cm、腕 **+16.9cm（落在左大腿上）**，6 关节中 **5 个悬空**；根因是 x 按「贴身」填（0.27→0.33→0.30 递减）而网格手臂**外张**（0.284→0.418→0.469 递增）。LeftFoot 偏内 7.5cm。🔴 **E-01 网格本身左右不对称**（手臂 1.5–3.5cm、**小腿 8cm**）→ **禁纯镜像，须左右分别对位**。报告 `.workbuddy/tmp/hy4/REVIEW-E01-binding-hy4.md`。**✅ 已修复并推送**（commit `1f35198`，2026-09-24）：左右分别对位改 14 关节，闭环 20/20 落在 run 内，scene:check 通过。肩/髋关节因不可测而保持不动。
- 🔁 **hy4 第二轮（用户看着图判读，commit `3b349ff` + `8d18c3c`）**：肘 1.135/1.120 → **1.250**（用户选定，x/z 取该高度臂截面实测中点），
  肩 `LeftArm/RightArm` 1.450 → **1.580**（与锁骨同高），四条臂关节 z **+0.020** 前移。
  最终骨段：L 肩→肘 0.350 / 肘→腕 0.404 / 腕→指尖 0.388；R 0.347 / 0.430 / 0.408；闭环 20/20、0 悬空。
  🔴 **教训**：臂近直时肘没有几何拐点，纯数值推断会自证空转 —— 出「候选高度横线对照图 + 单选」让用户点，一次收敛。
  用户判读与解剖比例冲突时（肘 1.25 使上臂比手短）→ 照做 + 立刻量化副作用上报，用户随即同意提肩。

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
