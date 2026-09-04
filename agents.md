# 项目协作规则 (agents.md)

本文件是给 AI 协作会话（WorkBuddy Agent）的项目级硬性规则。**改项目前先读本文件。**

## 1. 本地服务必须经 Tailscale 可达（固定端口 + HTTPS）

- **固定端口**（改端口须同步改这里 + 对应 vite.config 的 `port`/`strictPort`）：
  | 服务 | 脚本 | 端口 | 配置 |
  |---|---|---|---|
  | Game Editor (WebGPU) | `npm run lab` / `npm run editor` | **5100** | `apps/editor/vite.config.ts` |
  | 最终游戏 | `npm run dev` | **5101** | `apps/samples/00-init/vite.config.ts` |
- vite `server` 必须保持：`host: true`（监听所有网卡含 Tailscale 虚拟网卡
  100.124.237.93 / `*.ts.net`）、`allowedHosts: true`（放行 `*.ts.net` 避免 403）、
  `strictPort: true`（端口被占直接报错，不漂到 5101+/5102+）。
- **禁止**把 `server.host` 改回 `localhost`/`127.0.0.1`/具体 IP，会切断 Tailscale 访问。
- 经 Tailscale 访问**必须用 HTTPS**：WebGPU / SharedArrayBuffer 都需要 secure context，
  HTTP 下 `navigator.gpu` 为 `undefined` → 黑屏。证书由 `tailscale cert <magicdns>` 生成
  （`fangye-win11-office.tail6b29a2.ts.net.crt/.key`），放 `.workbuddy/tmp/certs/`（已 gitignore），
  vite 检测到即自动走 HTTPS；缺失则退回 HTTP（仅本机 localhost 可用）。
- 访问地址（以 5100 为例，最终游戏把端口换成 5101）：
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

## 3. Git 提交纪律（澄清红线歧义）

- **正常 `git add` / `git commit` / `git push` 是被允许、且是硬性要求的**：每完成一个任务
  收尾必须提交，使用规范中文 commit message，不留脏工作区。
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
