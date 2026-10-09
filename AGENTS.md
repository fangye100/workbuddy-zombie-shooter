# 项目协作规则（AGENTS.md）

本文件是全部开发 Agent（含 WorkBuddy、Codex）的项目级必读入口。**改项目前先读本文件**，
再通过[共享知识入口](docs/README.md)定位任务相关契约。

## 项目语言约定：中文优先

- **本项目中文优先**：日常沟通、开发报告、评审说明、文档和提交说明默认使用简体中文；用户明确要求其他语言时遵从用户要求。
- **本项目报告、设计说明、开发指南、验收记录及新增文档默认使用简体中文。**
- 中文约定适用于所有开发 Agent，优先于本机“文档优先英文”等默认设置。
- 代码标识、API/协议字段、路径、命令、稳定 ID 和必须精确引用的错误原文保持原样；
  机器可读目录的字段/分类值不翻译，面向人的标题、说明和建议章节使用中文。
- 更新旧文档时延续项目的中文风格；历史测量、提交、证据和结论不得因翻译而改写。

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
- 运行时群体（含 500-NPC 配置）必须走动态 instancing/批处理，不占用静态场景槽位。
  当前已有该路径，但不能据此认证任意数量或设备的性能。
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
  不得笼统认定这些字段均已实现，应检查 schema、写入和重载路径。已实现的可复用编辑数据
  必须通过 sidecar 保存/重载；只留内存的实现属于持久化缺陷。
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


## 5. CodeGraph 优先的代码导航

- CodeGraph 是已安装的 MCP 能力，不是可选的项目记忆。先读[连接与查询指南](docs/knowledge/codegraph.md)。
  通过所选客户端的 `tools/list` 发现工具；未暴露时，先尝试已安装且受支持的 stdio 服务，
  不能直接断言工具不存在。
- 项目/模块结构、职责、依赖/调用、影响分析和重构必须**先查 CodeGraph**，不得先用大范围
  grep/rg 重建架构。先 `project_map`/`module_overview`，再按需使用指定文件的
  `get_ast_node`、`get_call_graph`、`find_references`、`semantic_code_search` 或
  `ast_search`；参数以已安装 MCP schema 为准。
- 使用结果前确认目标检出目录/worktree、分支/提交、工具版本、源码根/排除项和索引完成
  状态。按需用受支持接口初始化/刷新，改动后同样适用。核对根目录为 `apps`、`assets`、
  `packages`、`tools`；根级配置另外检查。`.code-graph/` 是本地派生缓存，不是业务数据
  或 Git 交付物，其他检出目录的索引不能代替当前索引。
- 图谱用于定位源码，再读源码验证关键调用者、接收者类型、职责及失败路径。定向文本搜索
  用于补图谱盲区和确认事实，不是主要结构发现手段。简单精确文本编辑不要求整项目图分析。
- MCP/索引不可用、合理尝试后仍失败或不能覆盖所需关系时，说明具体限制，回退源码阅读/
  定向搜索。不得静默跳过、编造图谱证据或把局部工具限制扩大为整项阻断。
- 跟进截断/分页，检查解析错误和未解析调用。文件/符号覆盖不证明调用解析正确。
  区分 extracted/inferred/ambiguous、生产/测试、类型/运行时引用和未启用/活跃模块。
  使用同名 set/has/find 关系判断耦合前核对接收者。
- Worker URL/消息、`import.meta.glob` 注册/注入及 HTTP/WebSocket/MCP 派发须追踪两端。
  静态关系缺失不能证明死代码；类型 import 不等于运行时使用。
- 不根据入边次数/中心性推导运行成本、频率或重构优先级。架构报告必须说明源码快照、
  查询范围、计数口径、可信度及代表性源码证据；Agent 报告遵循同一规则。
- 阅读[已核对结构图谱](docs/44-CodeGraph代码结构图谱.md)了解职责和限制；源码、schema、
  ADR 仍是真源。图谱检查补充 owner 测试/验收：默认 Vitest 覆盖 apps/packages TS 测试，
  tools 的 Node/Python 测试使用独立运行器；scene/content/motion 门禁及有界面 Play/GPU
  验证仍须按任务执行。

## 6. 强制区分 Editor / Framework / Game

- 跨模块开发前读[分层契约](docs/architecture/layers.md)。`tools/architecture/layers.json`
  是强制依赖清单。Framework 提供通用机制/数据契约；僵尸游戏规则/状态在
  `packages/zombie-game`，内容在场景/资产数据，编辑 UX/适配器在 `apps/editor`。
- Framework 禁止依赖 game/content/editor；游戏内核禁止依赖 DOM 表现/editor；游戏表现
  禁止依赖 editor。类型、重新导出、动态 import、Worker 和 glob 同样遵守边界。
  跨包使用公共 `@aether` 入口，禁止反向兼容导出、重复游戏状态或在编辑器启动处新增玩法公式。
- 通用武器/碰撞/编辑命令属于 `@aether/runtime`；僵尸关卡装载、模拟、奖励、攻击策略和
  游戏 Play 组合属于 `@aether/zombie-game`。HUD/输入/音频使用明确的表现层子路径。
  新游戏使用自己的包和策略，不能将僵尸专有行为塞进可复用 Framework。
- 源码/依赖迁移或跨层改动后运行 `pnpm run architecture:check` 及相关 owner 测试；CI
  同样执行门禁。新包职责/公共入口须在清单中声明。不得为通过检查削弱清单或加例外，
  应修正职责或注入接口。
- 门禁检查源码依赖，不认证语义复用；仍需评审游戏常量、生成代码及消息派发。
  v15 中旧游戏特有场景契约的抽离需要明确 schema/迁移任务，保留旧字段不代表可以继续
  添加不相关职责。

## 7. 全部 Agent 共享仓库知识

- 从 [docs/README.md](docs/README.md) 和[知识目录](docs/knowledge/catalog.json)查找文档。
  使用 `pnpm run knowledge:find -- --topic <topic>` 或按职责/状态过滤，不依赖 WorkBuddy
  专有记忆服务。读取相关源码/指南，不必加载全部日报。
- 当前源码/schema/项目数据定义实现；设计表达意图，验收/WorkBuddy 日志是对应版本的
  历史证据。复用旧命令、参数、职责或验收结论前确认当前源码。
- 引用完整仓库路径和章节，历史证据还带提交。目录 ID 在重命名后保持稳定，数字前缀不唯一。
  重要会话结论应形成版本化 `docs/` 指南，说明职责、契约、失败路径、实际验证和剩余工作。
- 发布文档或改源码入口时更新目录，并运行 `pnpm run knowledge:check`。保留历史日志及
  其他会话草稿，不把过期记忆指令提升成当前规则，也不把未跟踪交付当作已发布/已验收资产。
- 当前指南必须使用当前源码/测试路径、有效的定向命令及明确能力限制。单加提示不足以修复
  正文中的旧命令。职责/schema 变更后更新相关指南和目录；历史测量保留原日期/版本并指向
  替代契约。索引刷新或构建成功不会自动更新验收结论。
