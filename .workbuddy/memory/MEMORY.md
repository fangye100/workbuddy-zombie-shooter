# 项目长期记忆

## 项目规则（用户定，必须遵守）
- **每完成一个任务（feature / fix / 文档 / 素材批次），收尾时必须 `git add -A && git commit`，
  用规范的中文 commit message 概括改动**。不要攒多个任务一起提；不要留未提交的脏工作区。

## ⚠️ 新会话开工前必读
- `画布施工交接单.md`（项目根）—— 含 ardot 环境自检、9 个角色 Frame 落位、06-09 截图校验要点、节点 ID 总表、风格速查。
- 开场指令：「读 `画布施工交接单.md` 和 `assets/characters/roster.json`，按交接单施工。」
- **ardot 有两道门，都要开**（2026-09-01 定案，详见交接单 §0.1）：
  ① `~/.workbuddy/settings.json` → `enabledPlugins` 加 `"mcp-ardot-mcp-app@workbuddy-builtin": true`（已开，
     备份 `settings.json.bak-ardot-20260831`）；改完必须完全退出客户端再重启。
  ② **账号灰度 `productFeatures.EnableArdot`**，服务端下发，读 `~/.workbuddy/cache/acc-product-config-v3.json`。
     判定实现在 app.asar：`isEnableArdotDesignEnabled(f) = globalThis["__ARDOT_DESIGN_UNGATE__"]===true || f?.EnableArdot===true`。
     门②关着的证据：`~/.workbuddy/logs/AppStartup.log` 里的 `[ArdotDesignFeatureNotEnabled] value=false`。
- **与版本更新无关**。当前 5.4.5（build fa1d65ec…），安装于 2026-08-30；更新服务每次都返回
  `No update available (HTTP 204)`。**本地没有任何旧版本可回滚**，不要往「更新 bug / 回滚」方向找。
- **工具索引是会话启动快照**：已存在的会话（含恢复/续接的）索引是旧的，会话内怎么试都补不回来 ——
  这是最容易误判成「还是不行」的原因。验证必须**开全新会话**。
- **排除的错误假设**（别再走）：不是专家面板里的「Ardot 设计专家」（`app/cache/experts/manifest.json`
  的历史缓存，拼作 `adort`，已不在可安装目录）；不是 `mcp.json`；不是 `.in_use` 锁文件；
  不需要重装 / 回滚客户端。
- **只剩 2 个工具是常态**：`mcp__ardot__open_design` / `create_design`。其余 20+
  （batch_edit / fetch_editor_state / capture_screenshot…）在 `mcp-apps-diag.log` 里记为
  `rejected: missing_ui_resourceUri`，**必须先 `open_design` 打开面板后才会动态出现**。
- **`mcp-apps-diag.log` 是唯一能定性的地方**：看最后一条 `catalog.refresh` 的
  `liveApps` / `failedConfigIds`，一次即可区分「插件没装 / 装了没启用 / 启用了没进索引」。
  别再用 ToolSearch 反复试。
- **6 个 ardot 技能 2026-09-01 前全部未启用**（已补进 `enabledPlugins`，8 → 14 条，
  备份 `settings.json.bak-ardot-skills-20260901`）：`skill-ardot-design-core` /
  `-design-router` / `-ui-design` / `-poster` / `-slides` / `-design-to-code`。
  其中 **`skill-ardot-design-core/0.1.2/` 是画布操作的唯一权威文档**，写 `batch_edit`
  前必读：`references/ardot-schema.md`、`tool-usage/batch-edit.md`、`rules/design-rules.md`。
- **batch_edit 三条硬约束**：① binding 名只在**单次调用内**有效，跨批次必须用上一步返回的真实 ID；
  ② 每次调用最多 **25 ops**，一批失败**整批回滚**；③ 禁用 `textColor`/`backgroundColor`/`alignItems`/
  `justifyContent`/`borderRadius`/`color`，正确写法是 `fill` / `cornerRadius` /
  `primaryAxisAlignItems` / `counterAxisAlignItems`，字重用数字字符串 `"700"`。
  没有 image 节点类型 —— 图用 `G(nodeId, "ai", prompt)` 打进 frame 的 fill。

## 末日尸潮游戏 UI
- 风格定位：美漫卡通描边、高饱和撞色、硬边偏移阴影（comic-book / brutalism-arcade 混合）
- 核心 token：墨线 #14110F、纸张 #F5E7C8、尸绿 #8FD14F、血红 #E8402A、警示黄 #FFC531、电光青 #2BC4D6、毒紫 #9B5DE5、传说金 #FF9F1C
- 字体：中文 Sarasa Gothic SC；数字/英文展示 Inter Black
- 控件模式：按钮统一 4-6px 黑色描边 + 6px 硬边投影；HUD 面板深色底高对比；稀有度色条用于卡片顶部
- 设计文件：Ardot `末日尸潮 · 横屏肉鸽射击 UI`（fileId 720788949675822），共 9 屏（01-05 流程 + 06-09 god view 实战参考）

## 角色 roster（唯一真源）
- `assets/characters/roster.json` — 5 普通敌(E-01..E-05) + 3 Boss(B-01..B-03)，含外形/数据/攻击/弱点/AI 提示词/画布施工单；`角色设定圣经.html` 为人类审阅版
- 关卡结构：4 幕 × 3 波。Act1 城郊公路 / Act2 废弃仓库 / Act3 地铁隧道 / Act4 生化医院
- 设计铁律：god view 55° 下角色仅几十像素，**剪影必须 0.3s 可辨**；每个敌人的剪影关键词互不相同
- 预警形状语言分级：扇形(E-01) → 直线(E-02/E-04) → 落点圈(E-03) → 弧形(B-01) → 十字(B-02) → 体态突变(B-03)
- 画布待施工：Frame 1560×900 ×9，行 y=2640/3680/4720，列 x=0/1700/3400（10-14 NPC，15 索引，16-18 Boss）
- **施工载荷已就绪（开工首选）**：`assets/characters/ardot_batch_edit.md` —— 9 Frame 的
  `batch_edit` 逐条脚本，21 个代码块 / 380 ops，8 角色各 2 步 + 索引页 5 步，全部 ≤25 ops。
  由 `assets/characters/_tools/gen_ardot_payload.py` 从 roster + tokens 生成，
  **改完真源重跑脚本，不要手改 md**。执行时只需把上一步返回的节点 ID 填进 `<<...>>` 占位符。
- 施工图 HTML `角色Frame施工图.html`（`_tools/gen_canvas_preview.py` 生成）退居**人工评审底稿**。
- 索引页 8 个 48px 剪影是**手工 SVG**（按 roster.silhouette 落形，不耗 AI 额度），三视图出完后需回校。
- 角色三视图 **24/24 已出齐**（2026-09-01 凌晨补完最后 8 张）。`_tools/check_assets.py` 可校验；
  审阅页 `assets/characters/角色美术素材审阅.html`、施工图 `角色Frame施工图.html` 均已嵌真图。
- **ImageGen 不能并行**：4 张并行会因 output_dir 竞态互相覆盖 / 同名撞车，必须顺序出、出完即重命名归位。

## 3D 化管线（混元 3D，2026-09-01 跑通 E-04）
- 总纲见 `docs/06-从2D概念图到3D游戏模型管线.md`（概念图标准化 → AI 生成 → 重拓扑/UV/贴图
  → Maya HumanIK → Mixamo 重定向 → 导出）。
- **唯一入口脚本 `assets/characters/_tools/gen3d_from_image.py`**，
  **不要**直接调 `buddy-cloud.py` 的 `--image-base64`：那是命令行参数，本地 PNG 的 base64 约 2 MB，
  远超 Windows 命令行长度上限（~32K），必失败。封装脚本把 buddy-cloud.py 当模块 import
  复用其签名/轮询，base64 从文件读，token 走 `--token-stdin` 管道。
- 产物字段是 **`ResultFile3Ds`**（大写 `Type`/`Url`/`PreviewImageUrl`），不是 `ResultFiles`；
  解析错会**静默返回空数组**（任务其实 DONE）。`Type=OBJ` 的产物是 **.zip**，需解压。
- 重跑前先想清楚：脚本支持 `--job-id` 只查询下载、**不重新提交**，避免重复烧额度。
- 产物目录 `assets/characters/models/<ID>/`（glb / fbx / obj-zip / 预览图 / `viewer.html`）。
- `viewer.html` 用 model-viewer（3 CDN fallback），**必须走 HTTP**（`python -m http.server 18899`），
  file:// 下 fetch 会被拦。present_files 传 localhost URL 即可在内置浏览器打开。
- 现状：E-04 已出 80000 tris 高模（0 骨骼 0 动画），roster 预算 1600 tris → 需减面 98%。
  其余 7 个角色未生成（每个约 45 额度、3-5 分钟）。

## 风格资产（唯一真源）
- 目录 `assets/style/`：`tokens.json` → `_tools/gen_assets.py` → `.ase` 色板 / `.cube` LUT；另有 `tokens.css`、`风格圣经.html`
- 铁律：toon 分阶按 NdotL 在材质着色器做，**不要**用 LUT 在最终颜色亮度上分阶（会误伤固有色暗的材质）
- 描边 = inverted hull，线宽存顶点色 R 通道（0-1 → 0-8mm），必须做摄像机距离补偿
- 半调网点只叠暗部（lum < 0.45），1080p 网点 4-6px，强度 ≤ 0.25
- 引擎对齐（Aether / WebGPU）：描边 Pass 在 Opaque 之后；半调 + LUT 在 Tonemap 之后、Grading 之前

## 模型资产管线（E-04 事故后的定案，后续角色必读）
- 混元 glb 顶点 split per-UV-vertex，pymeshlab QEM 减面前**必须先焊接+修非流形**（make_game_ready.py / decimate_to_budget.py 已修）；但焊接后 QEM 仍会出单点扇形尖刺 → **首选 `decimate_cluster.py`（空间聚类减面，对病态拓扑免疫）**
- 减面质检判据：**表面积保持率**（健康 >80%；平均单面面积恒定+总面积等比缩水 = 退化删面）
- 混元产物**脚在 z-max**：export_labmesh.py 的 to_y_up 已定案 `(x,-z,y)`，极性相反的模型用 `--up-flip`；判定极性用切片法（脚底端 2% 高度有 ~0.05m² 水平面）
- 完整链路：decimate_cluster → bake_lowpoly(xatlas) → export_labmesh → 拷 mesh.ts 进 lab → 无头截图验证
- 当前 E-04 内置模型是修复后的正立版（2083 顶点/1575 面），typecheck 0 error

## Game Editor（apps/lab/shader-lab）· 子网格与材质槽（2026-09-01 定案）
- **材质三层（Unity 语义）**：shared（params.materials 6 条，改=全局）→ instance（库里克隆的独立条目，
  可跨 mesh 复用、随 JSON 导出）→ override（挂在单条子网格上的局部副本）。优先级 override > instance > shared。
  纯逻辑在 `src/materials.ts`（`slotState` / `slotSource` / `MaterialLibrary`），渲染器不再自己判优先级。
- **铁律**：在共享材质上调参会自动 `ensureOverride()` 转覆盖 —— 用户「改这个 mesh」永远不会误伤全局共享材质。
  面板三个动作：换成库里已有材质 / 新建实例 / 保存覆盖为实例；「保存覆盖」= promote 进库，共享材质不动。
- 渲染：材质 uniform 按子网格分槽（`slotBase + s`，MAX_MATERIAL_SLOTS=256）、变换按物体分槽（MAX_OBJECTS=64），
  容量固定 → 换模型只需 `rebuildAllBindGroups()`，不重建 buffer。主 pass / 描边 / 选中 / 悬停全部逐子网格
  `drawIndexed(count, 1, indexStart)`，所以悬停某个 mesh 节点只描那一段轮廓。
- 层级树：对象节点可展开 → 子 mesh 节点（独立显隐 + 材质名徽章，徽章按 shared/instance/override 配色）。
  GLB 的 `parseGlb().subMeshes`（primitive 区间）已接进 `setCharacter()`，导入的模型能真的拆出多个 mesh 节点。
- 自动化钩子：`window.__editor = { camera, elevation, params, renderer }`；Mesh 材质面板按钮带 `data-mm`。
- 回归：`materials.test.ts`（12 例，钉数据隔离）+ 无头 CDP（25 断言，见下）。
- **⚠️ 推翻旧结论**：本环境**能**跑真实 headless WebGPU（Chrome 152 + SwiftShader，HUD 出 Draw/Tri、
  截图有 3D 画面）。之前记的「`navigator.gpu` 全 undefined」是假阴性（复用旧 profile / 缺
  `--enable-unsafe-swiftshader`）。配方与三个坑见 `~/.workbuddy/skills/webgpu-headless-validate`。
- **技术沉淀（2026-09-01）**：`docs/09-Game-Editor-核心技术沉淀.md` 已发布资料库在线文档
  （nodeId `FNfRd1b8idYncNDIdKBmvQ`，https://www.workbuddy.cn/space/d/FNfRd1b8idYncNDIdKBmvQ）。
  审计 refine 点全部带【refine】标注与缺陷根因，新会话/新人可直接当教材；验证方法论已是
  三层分层版（含 headless WebGPU 假阴性更正）。

## 换模型材质绑定继承（2026-09-02，material-property-panel 分支，885cb3c）
- **绑定身份链**：GLB node extras（zombieNodeId/meshId/nodeId/id，缺省 `auto-<nodeIndex>`）
  → nodePath（root→leaf 名字链）→ primitiveKey（材质名，缺省 `#<index>`）。
  匹配两层：① nodeId 精确（**双侧 auto-ID 必须 leaf 同名**，否则跨模型撞车）；
  ② 反向路径打分（leaf→root 连续段数；孤儿 -0.5；平局**拒继**不猜）。
  未认领旧绑定进**孤儿池**，留给再下次替换（artist 删了又补回的场景）。
- primitive 三级匹配：key 精确 → index 兜底 → 剩余顺序对齐；override 深拷贝继承。
- **worktree 用 npm 装依赖会漂版本**（typescript 5.9/@webgpu/types 0.1.72 → TS2345 一片）；
  主仓 pnpm 钉 5.6.3/0.1.49。修法 `npm install --no-save` 钉同版；仓库不跟踪 lockfile。
- E2E：`Temp/game-editor-check/cdp-hier-binding.mjs`（内存造 GLB + DataTransfer 注入 file input）。
