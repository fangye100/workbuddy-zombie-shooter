# 项目协作规则 (agents.md)

本文件是给 AI 协作会话（WorkBuddy Agent）的项目级硬性规则。**改项目前先读本文件。**

## 0. 包管理器：pnpm（2026-09-15 定）

- 真源是 `package.json` 的 `"packageManager": "pnpm@9.0.0"`；**锁文件 `pnpm-lock.yaml` 已入库，依赖装法一律 `pnpm install`**。
- 禁止用 npm/yarn 安装（会生成竞争锁文件、绕过锁定的版本）；历史遗留的 npm 安装痕迹已在 2026-09-15 清除。
- worktree 新建/迁移后先 `pnpm install` + `git lfs pull` 再干活——node_modules 不跨目录共享；LFS 若未检出，工作区里全是指针文本（131 字节），`scene:check` 会报一堆哈希失配（2026-09-15 踩过：28 项失配的真实原因是未 smudge，不是 meta 过期，**禁止**用 scene:gen 去"修"）。

## 1. 本地服务必须经 Tailscale 可达（固定端口 + HTTPS）

- **固定端口**（改端口须同步改这里 + 对应 vite.config 的 `port`/`strictPort`）：
  | 服务 | 脚本 | 端口 | 配置 |
  |---|---|---|---|
  | Game Editor (WebGPU) | `pnpm run lab` / `pnpm run editor` | **5100** | `apps/editor/vite.config.ts` |
  | M0 GPU 初始化示例（完整玩法走编辑器 Play） | `pnpm run dev` | **5101** | `apps/samples/00-init/vite.config.ts` |
- vite `server` 必须保持：`host: true`（监听所有网卡含 Tailscale 虚拟网卡
  100.124.237.93 / `*.ts.net`）、`allowedHosts: true`（放行 `*.ts.net` 避免 403）、
  `strictPort: true`（端口被占直接报错，不漂到 5101+/5102+）。
- **禁止**把 `server.host` 改回 `localhost`/`127.0.0.1`/具体 IP，会切断 Tailscale 访问。
- 经 Tailscale 访问**必须用 HTTPS**：WebGPU / SharedArrayBuffer 都需要 secure context，
  HTTP 下 `navigator.gpu` 为 `undefined` → 黑屏。证书由 `tailscale cert <magicdns>` 生成
  （`fangye-win11-office.tail6b29a2.ts.net.crt/.key`），放 `.workbuddy/tmp/certs/`（已 gitignore），
  vite 检测到即自动走 HTTPS；缺失则退回 HTTP（仅本机 localhost 可用）。
- 访问地址（以 5100 为例，M0 示例把端口换成 5101）：
  - `https://localhost:5100`（本机）
  - `https://100.124.237.93:5100`（Tailscale IP）
  - `https://fangye-win11-office.tail6b29a2.ts.net:5100`（Tailscale MagicDNS 域名，推荐）

## 2. 🔴 场景是游戏开发的唯一数据载体（铁律，2026-09-04 立）

> 完整架构设计见 `docs/14-Scene系统与场景数据持久化架构设计.md`；
> 数据字典真源 = `packages/scene/src/document.ts`（改 schema 先改那里，再写测试）。

### 2.1 硬性要求

- **一切游戏内容都是场景数据**。网格 / 灯光 / 相机 / 刷怪点 / 房间语义 / 导航区，
  只能是场景文件里的**节点与组件**。代码里 `new` 出来的地面、写死的灯光参数、硬编码的相机位置，
  一律视为 bug —— 它意味着这段内容没有持久化、不可版本化、不可复用、不可程序生成。
- **场景文件是唯一真源，编辑器只是它的读写器 + 运行器**。编辑器不得"拥有"场景
  （即：场景状态不得只存在于内存对象里，必须能完整序列化回文件）。
- **新增任何场景语义前先扩 schema**，再写运行时与 UI。反过来做 = 又造一份不可持久化的状态。
- **引用一律用稳定 `NodeId`，禁用数组下标做跨节点引用**
  （`parent` / `followTarget` / prefab override 的 propertyPath 都走 id）。
  编辑器现有的 `objects[]` 下标寻址是运行时表示，不是存储格式，两者不要混。

### 2.2 明确禁止

- ❌ 在 `LabRenderer` / `main.ts` / 任何引擎代码里硬编码场景物件、灯光、相机。
- ❌ 把 `GPUBuffer` / `GPUTexture` / `Float32Array` 顶点数据写进场景文件（只存 `AssetRef` 引用）。
- ❌ 在场景文件里内联 GLB / 贴图（会同时毁掉 git diff 与 LFS）。
- ❌ 在 `Script` 组件里存代码字符串（只存 `behavior` 注册 key + `params`；JSON 携带可执行文本 = 远程代码执行入口）。
- ❌ 静默修数据：旧版本、缺字段、断链、超容量，一律产出 diagnostic 显式告知用户。
- ❌ 改 schema 不补迁移链。每次 `SCHEMA_VERSION` +1 **必须**同时补一条迁移函数 + 一条测试。

### 2.3 格式与容量硬约束

- 格式：**JSON**（`.scene.json` / `.prefab.json`），扁平节点表 + `parent` 引用（不用嵌套树）。
- 目录：`assets/scenes/**`、`assets/prefabs/**`、`assets/materials/library.mat.json`。
- 字段必须带 `schemaVersion`，加载时走迁移链；版本高于当前支持值 → **拒绝加载**，不静默降级。
- 容量上限（引擎写死，超了必须报错而不是静默丢弃）：
  | 常量 | 值 | 含义 |
  |---|---|---|
  | `MAX_OBJECTS` | **64** | 场景**静态物件**上限（变换 uniform 槽位） |
  | `MAX_MATERIAL_SLOTS` | 256 | 材质槽位（逐子网格） |
  | `LIGHTS_FLOATS` | 40 | 10×vec4 → **1 主光(directional) + 1 点光** |
- **500 僵尸属运行时热实体，不得走场景静态物件路径**，必须走 instancing / 批处理（Phase 2）。
- 多灯降级：场景可声明任意多盏灯，运行时按 `priority` 取 top-1 + top-1，落选者在编辑器里**标黄提示**。

### 2.4 Play Mode 纪律

- Play 前对场景做**快照**；Play 中只改 runtime 副本；Stop 时**整体回滚 + 释放全部 Play 期 GPU 资源**。
- Play 期的每一次 GPU 资源分配都必须登记进 PlaySession，Stop 时逐个 `destroy()`
  （项目已在 `removeObject` 上踩过"只打墓碑不释放"的泄漏坑，不要再踩）。
- 编辑器相机（`editorCamera`）与游戏相机（`Camera` 组件）**严格分离**，互不影响。

### 2.5 项目容器、资产元数据与脚本

- **项目锚点 = 仓库根 `aether.project.json`**（真源 `packages/scene/src/project.ts`）。
  所有相对路径、场景清单、`layers[]` 层表、渲染档位、材质库/行为目录指针都在这里。
  **新场景必须登记进 `scenes[]`**，否则"通关后加载哪个场景"没有数据落点。
  层表前 8 项是内置层（`Default`/`Character`/`Pickup`/`Trigger`…）—— **`layer` 索引语义靠它稳定，禁止改名**。
- **资产附加数据必须落 sidecar `<源文件名>.meta.json`**（真源 `packages/scene/src/asset-meta.ts`），
  与源资产同目录。**禁止只在内存里保存** —— 绑定继承快照、身高归一化系数、骨骼绑定会话、
  T/A-pose 反解结果、动画配置、导入参数（焊接/AO/up-flip/拆子网格）全部属于这一类，
  现在它们刷新即丢，这是正在发生的数据丢失。
  - **归属判定**：问一句「换一个全新的空场景，这个数据还在不在？」
    在 → `.meta.json`；不在 / 场景特有 → `.scene.json`。
  - **sidecar 不用集中索引**：集中 `assetdb.json` 是合并冲突制造机。
    guid→path 索引是**派生产物**，启动时扫描重建，落 `.workbuddy/cache/`（不进 git）。
  - 场景里的 `AssetRef.path` 目前在用的同时**必须落 `guid`**（重命名/移动文件不丢引用）。
- **脚本 = 行为注册表，场景绝不存代码字符串**（ADR-017）。
  - 行为是代码资产（`assets/behaviors/*.ts`），**必须同时声明 `BehaviorDef.params` 参数 schema**，
    否则 Inspector 画不出控件，Script 组件只能手改 JSON —— 等于没有功能。
  - 场景只存 `{ behavior: 'spawn-wave', params: { count: 12 } }`。
  - 参数 schema 覆盖 `number/int/bool/string/color/nodeRef/assetRef/enum` 八种控件类型。
  - 行为被删 / 参数改名 → 报 `warning` 并降级为空操作，**不阻塞加载**（一个挂掉的行为不该让场景打不开）。
  - Play 模式下**禁用行为热重载**（正在跑的实体持有旧闭包）。
- **门禁（第 7、8 道，与 `content:check` 同构）**：
  - `pnpm run scene:gen` —— 新增/改动 GLB 后批量生成 sidecar。
    **merge 而非覆盖**，绝不冲掉已有 `.meta.json` 里手改的 `bindings`/`rig`/`userData`。
  - `pnpm run scene:check` —— ① 元数据与源文件 hash 同步；② 校验项目文件 + 全部 `.meta.json`
    + 全部 `.scene.json`，并查跨文件约束（guid 唯一、孤儿元数据、场景 id 唯一）。失败 exit 1。
  - **改动任何 `assets/**` 的资产或场景后必须跑 `scene:check`**，与改 `roster.json` 必须跑
    `content:gen` + `pnpm run content:check` 同理。
  - 注：门禁测试用 `import.meta.glob` 而非 `node:fs` —— 本仓库未装 `@types/node`，
    且 tsconfig 的 `types` 是白名单。别改成 `node:fs`，会引入类型依赖并需要手动登记新资产。

## 3. Git 提交纪律（澄清红线歧义）

- **正常 `git add` / `git commit` / `git push` 是被允许、且是硬性要求的**：每完成一个任务
  收尾必须提交，使用规范中文 commit message，不留脏工作区。
- 🔴 **提交即推送（2026-09-08 新增，强制）**：本地每产生一个 commit，必须在同一次收尾里
  `git push` 到远端，**禁止把 commit 攒在本地**。本地未推送的提交是唯一无法从远端恢复的
  部分——2026-09-08 事故中一次 `.git` 损坏就让本地 5 个未推送提交的对象全部丢失，
  内容虽在工作区侥幸存活，但提交历史与作者日期永久没了。攒本地提交 = 主动制造单点故障。
  - 一个任务产出多笔 commit 时：**逐笔 push**，不要等全部提交完再一次性推。
  - push 失败（网络、远端拒绝、非快进）**必须当场解决或明确上报**，禁止以「稍后再推」为由搁置。
- 🔴 **红线只禁「手动操作 `.git` 目录内部原始数据」**：`git fsck`、删 `.git` 内文件、手建
  refs、直接碰 pack、`git gc --prune` 等直接读写对象库的动作，未经许可一律禁止。
  发现仓库异常（dubious ownership、refs 缺失、对象损坏）只报告症状、等用户指令，**不要自行动手修复**。
- 多 session 并行时：**每个 session 只负责提交自己业务范围内的修改文件**，不禁止各 session
  自行提交。提交时只 `git add` 本会话改动的那些文件，禁止 `git add -A` 一把抓整个工作区
  （会误吞其他 session 在途的改动）。push 时避开与其他 session 在同一分支同时推。
- 远程 `origin = git@github.com:fangye100/workbuddy-zombie-shooter.git`（只走 SSH；
  拼写是 **shooter**；另有拼写相近的空仓 **shotter** 勿推）。
- 大二进制资产（角色概念图、模型 `*.glb/*.fbx/*.obj/*.zip/*.ply`、贴图等）走 **Git LFS**
  （见 `.gitattributes`），`git add` 会被自动转成 LFS 指针，不要手动绕过。

## 4. 浏览器与 Web 操作 → 统一走 web-debug skill

> 🔴 **所有 web/浏览器操作（运行时验证、页面自动化、截图、登录授权、dev server 探活）
> 先检查 `web-debug` skill（`~/.agents/skills/web-debug/SKILL.md`），存在时加载并按其方向路由。
> **未安装时，先读取仓库内 [浏览器验证入口](docs/browser-verification.md)，使用其受支持工具与门禁路径。**
> 通用方法与坑（实例枚举/profile 选择/Chrome 136+ 端口限制/CDP 机制/登录墙
> 停下问用户/headed+真实 GPU/截图 base64 回传/vite·SPA·自签 HTTPS 坑）已全部迁移至该
> skill；缺少该本机 Skill 不阻断仓库内已有的验证路径。此处保留本项目锚点：

- 门禁工具：`editor:smoke` = `tools/verify/editor-smoke.mjs`（已支持 `--headed`，默认
  headless 兼容 CI；**本机验证一律带 `--headed`**）；手写 CDP 连已运行 dev server 用
  `tools/verify/cdp-verify.mjs`。
- 本项目自动化固定 profile：`.workbuddy/tmp/chrome-profile`（已 gitignore；保留
  证书/登录态/窗口状态，`editor-smoke.mjs --headed` 默认复用它，不要删除重建）。
- 本机环境：win11 + NVIDIA Lovelace —— 属 skill ref A/D 里的「headless+SwiftShader
  起不来 CDP、禁止 `--no-sandbox`/`--disable-dev-shm-usage`」机器类别。
- 编辑器地址：`https://localhost:5100` / Tailscale 域名（见 §1）；冒烟跑前先探活（skill ref F §1）。


## 5. CodeGraph-first code navigation

- CodeGraph is an installed MCP capability, not optional project memory. Read the
  [portable MCP connection/query guide](docs/knowledge/codegraph.md). Discover
  its current tools through the selected client's `tools/list`; if tool exposure
  is missing, try the installed supported stdio server before declaring it absent.
- For project/module structure, responsibility discovery, dependency/call analysis,
  impact assessment and refactoring, **query CodeGraph first**. Do not begin by
  rebuilding the project's architecture with broad grep/rg searches. Start with
  `project_map` / `module_overview`, then narrow to file-qualified `get_ast_node`,
  `get_call_graph`, `find_references`, `semantic_code_search` or `ast_search` as
  appropriate; supported arguments come from the installed MCP tool schema.
- Before using results, confirm the intended checkout/worktree, branch/commit,
  tool version, source roots/exclusions and indexing completion. Initialize or
  refresh through supported operations when necessary, including after changes.
  The audited roots are `apps`, `assets`, `packages`, `tools`; check root-level
  configuration separately. `.code-graph/` is a local derived cache, not business
  data or a Git-distributed artifact; another checkout's index is not a substitute.
- Use graph results to locate the relevant source, then read it to verify critical
  callers, receiver types, ownership and failure paths. Targeted text search is
  for filling known graph gaps and confirming facts, rather than the primary
  means of discovering code structure. Simple exact text edits do not require
  unnecessary whole-project graph analysis.
- If CodeGraph MCP/index is unavailable, fails after a reasonable attempt, or
  cannot cover the needed relation, state the concrete limitation and use source
  reads/targeted search as fallback. Do not silently skip graph-first navigation,
  fabricate graph evidence, or turn a local tool limitation into a full task block.
- Follow truncated/paginated results and inspect parser errors/unresolved calls.
  File/symbol coverage does not prove correct call resolution. Distinguish
  extracted/inferred/ambiguous edges, production/tests, type/runtime imports and
  dormant/active modules. Verify same-name set/has/find receivers before using
  their edges as evidence of coupling.
- Trace Worker URL/messages, import.meta.glob registration/injection and
  HTTP/WebSocket/MCP dispatch across both endpoints when relevant; a missing
  static edge is not evidence of dead code. A type import is not runtime use.
- Do not infer runtime cost, execution frequency or refactoring priority from
  incoming counts/centrality alone. Architecture reports record source snapshot,
  query scope/count definitions/confidence and representative source evidence;
  Agent-written summaries follow the same rule regardless of model capability.
- Read [the verified structure map](docs/44-CodeGraph代码结构图谱.md) for owners and
  known limitations. Source, schemas and ADRs remain authoritative. Graph checks
  supplement affected-owner tests and acceptance gates: default Vitest covers
  apps/packages TS tests, while tools' Node/Python tests use separate runners;
  scene/content/motion gates and headed Play/GPU validation still apply.

## 6. Mandatory Editor / Framework / Game separation

- Read [the ownership contract](docs/architecture/layers.md) before cross-module
  development. `tools/architecture/layers.json` is the enforced dependency map.
  Framework packages provide reusable mechanisms and data contracts; Zombie
  rules/state live in `packages/zombie-game`, authored content in scene/asset data,
  and authoring UX/adapters in `apps/editor`.
- Framework must not depend on game/content/editor. Game core must not depend on
  DOM presentation/editor. Game presentation must not depend on editor. Type-only,
  re-export, dynamic-import, Worker and glob dependencies also obey these rules.
  Cross-package consumers use public `@aether` entries; no reverse compatibility
  re-exports, duplicate game state or new gameplay formulas in editor bootstrap.
- Generic weapons/collision/author commands remain `@aether/runtime`; Zombie
  level loading, campaign simulation, rewards, attack policies and game Play
  composition use `@aether/zombie-game`. HUD/input/audio have explicit game
  presentation subpaths. A new game gets its own package and supplies policies;
  do not patch Zombie-specific behavior into reusable framework classes.
- Run `pnpm run architecture:check` after source/dependency moves or cross-layer
  changes, plus affected-owner tests. The gate is also in CI. New package ownership
  and public entries must be explicit in the manifest. Do not weaken the manifest
  or add exceptions just to pass a failing check; repair ownership or inject a port.
- The gate checks source edges, not semantic reuse. Review game-specific constants,
  generated code and message dispatch in source. Legacy v15 game-oriented scene
  contracts require explicit schema/migration work before extension extraction;
  their preservation is not permission to add unrelated responsibilities there.

## 7. Repository knowledge is shared by all Agents

- Start documentation discovery at [docs/README.md](docs/README.md) and the
  [knowledge catalog](docs/knowledge/catalog.json). Use `pnpm run knowledge:find
  -- --topic <topic>` or filter by role/status. No WorkBuddy-only memory service
  is required. Read the relevant source/guide rather than loading all daily logs.
- Current source/schema/project data is authoritative for implementation.
  Design docs describe intent; acceptance reports and WorkBuddy logs are historical
  evidence at their recorded revision. Check current source before reusing a
  historical command, value, ownership claim or acceptance result.
- Cite full repository paths and headings, plus commits for historical evidence.
  Catalog IDs remain stable across renames; numeric document prefixes are not
  unique. Important session conclusions must become versioned `docs/` guides
  with owner, contracts, failure paths, actual validation and remaining work.
- Add/update catalog entries when publishing documents or changing source routes;
  run `pnpm run knowledge:check`. Preserve historical logs and unrelated drafts.
  Do not promote obsolete memory instructions into current rules, or adopt
  untracked deliveries as published/accepted assets.
