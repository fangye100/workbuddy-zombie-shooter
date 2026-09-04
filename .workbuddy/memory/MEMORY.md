# 项目长期记忆

## 铁律
- 收尾 `git add <本会话文件> && git commit && git push`，中文 message。**只 add 自己改的，禁 `git add -A`**（并行 session 会吞别人在途改动）；push 避同分支并发。
- 🔴 未经许可禁碰 `.git` 内部（fsck/删文件/建 refs/碰 pack）。异常只报告症状。
- remote `origin = git@github.com:fangye100/workbuddy-zombie-shooter.git`（SSH；拼写 **shooter**，另有空仓 shotter）。
- 🔴 Python 写文本会 LF→CRLF，`open(p,'w')` 一律加 `newline=''`。自查 `git diff --cached --stat --ignore-cr-at-eol` 应远小于 `--stat`；中招用二进制 `replace(b'\r\n',b'\n')`。

## ADR 速查（全文 `docs/10` + `docs/14`）
001 渲染真源唯一化 · 002 资料库为运行时单一真源 · 003 验证分层 · 005 包体 `@aether/*` · 007 render(L3) 不反向依赖 content(L4) · 008 验证资产与结论同入库 · 009 测试与被测代码同位 · 010 场景为唯一数据载体 · 011 Authoring=Node/Component(AoS)+热实体 SoA ECS · 012 扁平节点表+parent · 013 JSON+SCHEMA_VERSION+迁移链 · 014 Edit/Play 严格分离 · 015 `aether.project.json` 为锚点 · 016 资产附加数据走同名 sidecar · 017 脚本=行为注册表

## 真源（改前先改这里）
- `assets/characters/roster.json`（npcs5+bosses3，**顶层键不是 characters**）+ `assets/style/tokens.json` → `npm run content:gen` → `packages/content/src/generated/*.generated.ts`；`content:check` 不同步 exit 1。
- **生成器铁律**：解析失败抛错不填 0；复合串取首个数值 + 原始串保留（`heightRaw`）。
- ⚠️ `roster.json` 承载不了 `CharacterDef`（缺胶囊半径/质量/转向/视野/受伤盒等 11 项，清单在 `roster.generated.ts` 头）。**硬生成 = 把编造数字洗成单一真源，比硬编码更坏。**
- L-8 待用户决策勿擅改：`params.ts` `gradeShadowMult` 0.95 vs 真源 0.78、`gradeShadowMix` 0.12 vs 0.2（改了变画面，属美术决策）。

## 编辑器 / 引擎
- 端口 **编辑器 5100 / 游戏 5101**（`agents.md` §1）。
- **脚本名坑**：`npm run build` 是 sample-00；编辑器是 `editor:build`；冒烟 `editor:smoke`（无 `verify:smoke`），传 `--glb <rigged.glb>` 才启用骨骼断言组。另有 `verify:glb|uv|facade|dock|prefix`。`lab*` 只是别名。
- 引擎落地：`ai`(最成熟) · `gameplay` · `gfx` · `core` · `framegraph`。其余未建——不为空包建目录。dormant：`framegraph/graph.ts` + `render/feature.ts`（已标 DORMANT 未删）。
- 🔴 **不要用 `core/src/ecs/world.ts` 当场景骨架**（remove 空实现 / strideOf 硬编码 / isChanged 恒真）。静态物件走 SceneGraph，500 僵尸走 SoA + instancing。
- 容量硬约束：`MAX_OBJECTS=64` 超限**必须报错不能静默丢**；`MAX_MATERIAL_SLOTS=256`；`LIGHTS_FLOATS=40` → **只支持 1 dir + 1 point**，多灯按 `priority` 取 top-1+top-1、**落选者标黄**。
- 资产库面板「不见了」两成因 → 方法论见 skill `ui-element-invisible-diagnosis`。本项目事实：`ad-` 前缀全改 `asset-`（commit `750972d`，闸门 `verify:prefix`）；localStorage `zh.assets.collapsed`/`zh.ui.dockH` 删掉硬刷。`tools/verify/dock-probe.mjs` 分段高度基线 `{grip:6,head:42,body:212,sum:260}`。

## Scene 数据层（铁律见 `agents.md` §2/§2.5，全文 `docs/14`）
- 三份真源：`document.ts`(场景) / `project.ts`(项目) / `asset-meta.ts`(sidecar)。改 schema 先改它 + 补测试 + 补迁移链。
- **归属判定两句**：① 换全新空场景还在不在？不在 → `.scene`。② **这段数据丢了能不能从源 GLB 反推出来？能 → 不存**。
- **四层容器 + 覆盖链**：`aether.project.json` ⊃ `<file>.meta.json`（保留源扩展名，a.glb 与 a.obj 不撞车）→ `*.prefab.json` → `*.scene.json`，每级只存差异。
- **不用集中索引**（`assetdb.json` 是合并冲突制造机）；guid→path 索引启动扫描重建落 `.workbuddy/cache/`（不进 git）。
- **不落盘三类**：派生/烘焙 → `.workbuddy/cache/`；UI 状态 → localStorage；Play 运行时 → 内存 Stop 即弃。
- 分层修正：`scene/geometry.ts` 定性为**共享契约层**允许被 L3 依赖；`graph.ts`/`document.ts` 才是 L4（只改注释，不移动文件）。
- ⚠️ schema 两个已修的坑：`MaterialRef` 撞 `render/materials.ts` → `MaterialBindingRef`；`MaterialPatch` 字段须与 `MaterialState` 逐个对齐（`emissiveColor` 非 `emissive`，清单见 `MATERIAL_STATE_FIELDS`）。
- 🔴 **门禁测试禁用 `node:fs`**（无 `@types/node`，`types` 是白名单）→ 用 `import.meta.glob('/assets/**/*.meta.json',{eager:true,import:'default'})`。
- `tools/scene/gen-asset-meta.mjs`（⚠️ 不是 `tools/gen-asset-meta.mjs`）：28 个 sidecar。**merge 不覆盖**手改字段；身高读 `roster.generated.ts` 的 `heightMeters`，断言 8 角色否则抛错。
- 门禁必须验证会拦住错误：`maxSubMeshes=0` / 重复 guid / 漏 sidecar 三种注入已实测精确报错 exit 1。

### 骨骼：会话存，结果不存（2026-09-04 实证订正）
- `E04_Bulwark_1600_rigged_animated.glb`（300KB）已含 22 关节 + IBM + JOINTS_0/WEIGHTS_0 + 6 动画 → **结果已随导出 GLB 落盘(LFS)**，抄进 `.meta` = **双真源，比丢失更糟**。
- `.meta.rig` 只装**配方**：`session.positions` / `session.bindPose` / `session.skinCylinders` / `export.*`(falloff/eps/maxInfluences/smooth×/mirrorWeights) / `tposeLocalRotations`。**不存 `mirrorPairs`**（`humanik-template.ts` 的 `MIRROR_PAIRS`，由 `template` 派生）。
- `rig.exported` 取代 `weightsBaked`：`false` = 结果只在内存（发 `W_META_RIG_NOT_EXPORTED`）；`true` = 结果在 GLB，`.meta.rig` 降为历史记录、运行时不读。
- S0d 编辑器侧对接未做：`binding-panel.ts` 的 positions/bindPose/cylinders 等**全是实例私有字段、无落盘路径**（依赖 S1 Inspector）。

### 脚本（ADR-017）
代码资产 + **`BehaviorParamSchema` 必须有**（没它 Inspector 画不出控件 = 功能等于没有）。场景只存 `{behavior,params}`，**绝不存代码字符串**（RCE + 无法重构）。行为失效 warning 降级空操作，不阻塞加载。

## 3D 资产生成管线
- 入口 `assets/characters/_tools/gen3d_from_image.py`（勿直接调 buddy-cloud `--image-base64`，超 Windows 命令行长度上限）。
- 全链路 `pipeline_character.py`：front.png → 混元图生3D → `decimate_cluster`（对病态拓扑免疫，质检判据 = 表面积保持率 >80%）→ bake_lowpoly(xatlas) → rig_character → retarget_bvh → validate_glb。
- **两套 Python 分开**：云端/绑骨 `binaries/python/versions/3.13.12`（requests）；减面/烘焙 `binaries/python/envs/default`（pymeshlab+xatlas）。
- 混元图生3D **5 次/天**（429），且**不能带 `--prompt`**。`export_labmesh` 用 `(x,-z,y)`，极性反用 `--up-flip`。
- headless `cdp-rigged.mjs`（参数化）20 断言，**8/8 角色 rig+anim 全齐**。

## WebGPU
编码期陷阱 → skill `webgpu-coding-pitfalls`；运行时验证 → skill `webgpu-headless-validate`。
一句话：**tsc + vite build 全绿照样线上炸** —— usage 错配 / uniform offset 对齐 / bind group visibility / WGSL 编译错误只在运行时暴露。

## 门禁（8 道，收尾全跑）
`typecheck` · `vitest` · `editor:build` · `editor:smoke` · `content:check` · `verify:prefix` · `scene:gen` · `scene:check`

## 线上资料库（workbuddy.cn/space）同步
- **可直接读写，不用用户手动**（2026-09-04 纠正：此前误判为无写权限）。流程：`connect_open_platform` 换票 → `space.workspace.list-user-spaces` 判 category（`personal` 直接写，`team` 停等确认）→ `get_doc_reviews.py --page-id` 取最新 content 与 blockId → `submit_doc_edit.py`（新增/追加）或 `submit_review_edit.py`（改已有内容）。token 走 `--token-stdin`，**有效期 1800s** 过期重取。
- 脚本根 `C:/Program Files/WorkBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/skills/library/`；API 全清单见其 `api-manifest.json`。
- 🔴 **组件语法硬约束**：`<Table>` 提交时**只接受无属性**（带 `rowHeader` 直接被拒：「仅允许: 无属性」）；`Table` 只允许 `delete`/`insert_before`/`insert_after`，**禁止 `update`**；加删行列 = `delete` + `insert_after` 整表重建。
  → **代价：重建后原表 `rowHeader` 永久丢失、无法恢复**（服务端默认只给 `readonly`）。这是官方路径的固有代价，不是操作失误。
- 回读 content 是**往返安全表示**：Code 块被包 ``` 围栏、纯文本里 `_` `[]` `*` 被加 `\` 转义 —— 都是回读侧标记不是内容污染，**别照抄回写**。
- 新建整篇文档用 `create_doc.py`（**只吃 Markdown，禁止组件**）。
- 本地 `docs/` 是真源。线上节点：`docs/09` → `FNfRd1b8idYncNDIdKBmvQ`；docs/14 §14–§15 镜像 → `48WumseQVdiYkWOQL2pz94`。改了本地文档要同步线上。
