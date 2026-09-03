# 自动化任务记忆 · Game Editor 重构质量审计与加固

## 任务
按 `docs/10 整体架构设计与长期发展规划`（注：该文**不在**线上资料库，线上只有 docs/01–05 + GameEditor 4 篇；以本地 `docs/` 为同源真源）
review 并加固 `game-design-zombie` 里「Game Editor Refactory」session（`0ca20fe`→`39675b8`，19 提交）的产出。

## 执行结果（2026-09-03 首次运行）
- 产出审计报告 `docs/12-Game-Editor-重构质量审计与加固.md`。
- 查出 2 个 P0、4 个 P1、4 个 P2；修复 12 项；新增 2 条 ADR（008 验证资产同入库 / 009 测试分层归位）。
- 四道门禁全绿：typecheck 0 error · vitest 100/100 · vite build → `dist/editor` · 冒烟 35 PASS(CONSOLE 0/EXCEPTIONS 0)。
- **只改工作区，未 add/commit** —— 遵守用户级 git 铁律，提交由用户拍板。

## 执行结果（2026-09-03 第 2 次运行 · 修正工作区空间）
- 用户反馈「空间给设置错了」：本 session 落在自动新建的 `automation-2026-09-03-00-53-53`，要求移回 `game-design-zombie`。
- **根因**：`automations.cwds` 里只有本条指向 `automation-2026-09-03-00-53-53`，其余 5 条都正确指向 `game-design-zombie`。
  已用 `automation_update` 修正 —— 只改 `sessions.cwd` 下次跑还会复发。
- 迁移三层元数据全部完成：`projects/*.jsonl`（复制+重写）、`sessions/<pid>.json`、
  `workbuddy.db` 的 `sessions.cwd` / `automation_runs.source_cwd` / `runs_json`，
  外加 `changes-index` / `changes-detail` / `artifact-index`。DB 已用 SQLite online backup 备份。
- 遗留：需用户**完全退出客户端（含托盘）重启**，再把侧栏切到 `game-design-zombie` 才看得到；
  重启后建议再跑一次 `game-design-zombie/.workbuddy/tmp/move-session/sync_session.py`（幂等）。

## 执行结果（2026-09-03 第 3 次运行 · L-3 装箱下沉，已完成）
- **L-3 做完**：`packLights/packToon/packPost/packMaterial` + 8 个 layout 常量 → `packages/render/src/frame-uniforms.ts`；`srgbToLinear/hexToLinear` → `@aether/core`；编辑器 `render()` 里 3 行 pack → 1 次 `packFrameUniforms({...})`。
- **关键设计**：引擎侧只声明装箱真正读到的字段（三个收窄接口），**不引入 `LabParams`**（ADR-007）；调用方传 `LabParams`，字段超集 + 结构化类型天然兼容。
- 新增 17 条单测，总量 100 → **117**。四道门禁全绿，`renderer.ts` 1946 → 1748 行。
- **顺带发现并处理了 P0 级自伤**：docs/12 §4 初版的「68% 实质逻辑」结论来自未入库的临时脚本 —— 审计报告自己违反 ADR-008。已把度量脚本固化为 `tools/verify/facade-metric.py`（`npm run verify:facade`），并订正 §4 数字。

## 执行结果（2026-09-03 第 4 次运行 · L-2 + L-1 标注，已完成）
- **L-2 做完**：引擎侧 `CoreHighlight.selected/hovered` → **`primary`/`secondary`**（buffer、uniforms 键、`isSel/isHover` 全同步）。编辑器的 `selected`/`hovered` **刻意不改** —— ADR-001 约束的是引擎公共签名，不是调用方内部命名；翻译点收敛到 `selection-outline.feature.ts` + uniforms 键映射两处。新增 7 条单测，117 → **124**。
- **L-1 标注 dormant**（代码未动）：`framegraph/graph.ts`(295) + `render/feature.ts`(130) 共 425 行零运行时消费者，只在文件头加 DORMANT 标记（含可复现核实命令 + 启用前置条件）。两个坑：framegraph 在 `tsconfig.check.json` include 里（typecheck 绿 ≠ 能用）；`apps/editor/src/features/*.feature.ts` 的 feature ≠ `RenderFeature`（命名撞车）。
- 四道门禁全绿：typecheck 0 · vitest 124/124(10 files) · build 183.67 kB · 冒烟 35 PASS/CONSOLE(0)/EXCEPTIONS(0)。
- 工作区共 41 项改动（含第 1 轮 27 改 5 新），截至本轮结束仍**未 add/commit** → 已在第 5 轮提交。

## 执行结果（2026-09-03 第 5 次运行 · 复验门禁 + 提交，已完成）
- **复验**：HEAD 已被别的 session 推进到 `6f93d62`（docs: 更正多 session git 提交归属规则），
  该提交吃掉了 `agents.md` / `.workbuddy/memory/MEMORY.md` / `2026-09-03.md`。
  重跑四道门禁确认未被带偏，全绿：typecheck 0 · vitest **124/124**(10 files) ·
  `npm run editor:build` 49 modules/183.67 kB · 冒烟 35 PASS/0 FAIL/0 SKIP, CONSOLE 0/EXCEPTIONS 0。
- **确认 L-2 是真的做完了**：除 `selection-outline.feature.ts` 外，`packages/render/src/renderer-core.ts`
  里字段名、buffer 名（`primaryToonBuf`/`secondaryMatBuf`…）、uniforms 键、注释全部中性化，
  `packages/` 内 grep `highlight` + `selected|hovered` 零命中。
- **提交 3 个**（只 add 本会话文件，未 `git add -A`；本轮工作区 41 项全部属于本会话，无他人在途改动）：
  1. `b16ee78 refactor(editor): Game Editor 重构质量加固 — ADR-008/009 + L-1/L-2/L-3`（35 文件）
  2. `0cb2f86 docs: 新增 Game Editor 重构质量审计报告（docs/12）`（2 文件）
  3. `chore(memory): 补本自动化第 5 轮执行记录`
- **踩坑**：`npm run build` 不是编辑器构建（是 sample-00），编辑器是 `npm run editor:build`；
  冒烟脚本名是 `editor:smoke`（无 `verify:smoke`）。带骨骼断言必须传 `--glb`
  `assets/characters/models/E-01/rigged/E01_Shambler_900_rigged_animated.glb`，
  不传则 H 组 3 条 SKIP（默认胶囊场景无骨骼）。
- **推前检查**：`git rev-list --left-right --count HEAD...origin/main` = `1 0`
  （本地领先 1、远端领先 0）→ 无分歧可安全 push。

## 执行结果（2026-09-03 第 6 次运行 · 资产库面板消失，已定位并修复）
- **用户报**：访问 `https://100.124.237.93:5100/`，底部 Asset Library 面板不见了。
- **真凶：广告拦截插件**。面板类名前缀是 **`ad-`**（`.ad-head`/`.ad-body`/`.ad-content`/`.ad-title`/
  `.ad-filter` + `data-ad` + `--ad-cell`），而 `ad-` 是 EasyList / uBlock Origin / AdGuard 的
  头号命中模式，被注入 `display:none !important`；`.ad-grip` 因不像广告词幸存 → 只剩 6px。
- **定性三特征**：无痕窗口正常（扩展默认禁用）+ `Ctrl+Shift+R` 无效（扩展每次重新注入）+
  项目自身 `display:none` 规则与观测**恰好相反**（项目只在 collapsed 时藏 body+grip、保留 head，
  实测 head=0/grip=6）。**headless 三条全不成立 → 探针再绿也证明不了没被拦。**
- **修复**：`ad-`→`asset-`、`adk-`→`akind-`、`data-ad`→`data-asset`，覆盖
  `index.html` / `asset-browser.ts` / `asset-inspector.ts` / `asset-util.ts` 四个文件。
  新增回归闸门 `tools/verify/guard-classprefix.mjs`（`npm run verify:prefix`），
  已自测（注入 4 处违规 exit 1；`load-asset`/`add-node`/`bad-idea` 零误报）。
- **两处漏网**（改名后必须全仓复查）：`asset-inspector.ts`/`asset-util.ts` 不在首轮扫描范围；
  且模板字面量 `adk-${kind}` 后跟 `$` 不是字母，`(?=[a-z])` 前瞻未命中。
- **踩坑：Python `open(p,'w')` 在 Windows 把 LF 写成 CRLF** → 整文件 diff（1700 行 → 还原后 274 行）。
  一律 `newline=''`；自查 `git diff --stat --ignore-cr-at-eol`。
- **验证**：typecheck 0 · vitest 124/124 · build 183.86 kB · 冒烟 35 PASS/0 FAIL/0 SKIP ·
  verify:prefix 通过 · dock-probe 与改名前基线逐项一致（`seg{grip:6,head:42,body:212,tree:212,content:212,sum:260}`）。
- **提交 1 个**：`750972d 修复资产库面板被广告拦截插件误杀：类名前缀 ad- → asset-`（8 文件 +274/−122）。
  推前检查本地领先 1、远端领先 0 → 已 push `f86455d..750972d`。
  ⚠️ 工作区里 `tools/verify/editor-smoke.mjs` 是**别的 session 在改**，本轮未动。
- **待用户确认**：开着广告拦截插件的普通窗口硬刷，面板是否恢复（headless 证不了的最终证据）。

## 执行结果（2026-09-03 第 7 次运行 · 建 content/ 生成层，收口 L-4 / L-7）
- **判断**：L-4 与 L-7 都卡在同一个前置（ADR-002 的 `content/` 生成层，docs/10 D3），
  分开修会各造一个临时方案 → 先建生成层，再顺带收两项。
- **建 `packages/content/`（L4）**：`scripts/gen-content.mjs`（纯 Node 零依赖）+
  `src/generated/{tokens,roster}.generated.ts` + `test/content.test.ts`(13 条)。
  `npm run content:gen` / `npm run content:check`（不同步 exit 1，已自测有效）。
- **三个关键发现**：
  ① `tokens.json` 的 `.grading.stops` 是完整规格，与 packPost 三处硬编码逐项对上
     （0.98 / #0E0C16 / #FFF6E2），L-7 可忠实收口不必编造；
  ② **content(L4) 高于 render(L3)，render 不能反向 import content** → L-7 只能按
     ADR-007 参数注入（`PostPackParams` 加 gradeMidMult/gradeShadowColor/gradeLightColor）；
  ③ **D3 原文「character.ts 改读生成物」目前做不到**：roster 是美术/设计资料库，
     承载不了 CharacterDef 的调参字段 → 只生成标识与可解析数值，
     11 项不可派生清单写进生成物头部（已入库，不靠口头传承）。
- **L-4 收口**：`CHARACTER_HEIGHT_M` → **`MODEL_RULER_HEIGHT_M`**（改名必要：
  roster 8 个角色 1.25~4.0 m 各不相同，原名暗示「角色都是这高度」是错的；它是归一化标尺），
  值取 `requireCharacter('E-04').heightMeters`。
- **新增遗留 L-8**：`gradeShadowMult` 0.95 vs 真源 0.78、`gradeShadowMix` 0.12 vs 真源 0.2
  （疑似抄了亮部的值）。**修正会改变画面**，属美术决策，交用户目视后定夺，审计不擅改。
- **验证**：vitest **141/141**（原 124）· build 53 modules/189.32 kB ·
  冒烟 35 PASS/0 FAIL/0 SKIP · content:check 同步 · verify:prefix 通过 · 本会话文件 typecheck 0 错误。
- **提交 `dc18c1d`**（18 文件 +1046/−29），已 push `a78ba66..dc18c1d`。
- **⚠️ 并行 session**：期间另一 session 在改 `renderer-core.ts`（+120 行，多画布改造）并新增
  `services/{asset-preview,skeleton-overlay}.ts`；typecheck 剩 2 条错误属他们在途半成品，**未触碰**。

## 下次运行要点
- **别重复修**：§3 的 12 项 + §6.1 的 L-3 + §6.2 的 L-2 + §6.3 的 L-1 dormant 标记 + §6.4 的 **L-4 / L-7**，都已做完。下次先跑六道门禁（typecheck / vitest / editor:build / editor:smoke / content:check / verify:prefix）看是否仍绿，再挑遗留项 **L-5 / L-6 / L-8**（docs/12 §6）。
- **L-8 需要用户拍板**（不能自动化代劳）：`params.ts` 的 grading 默认值是否对齐 tokens.json 真源。改动会改变画面，必须目视确认。
- **推荐下一个动作**：**资源生命周期下沉** —— `uploadMesh`(46) / `buildGridTexture`(48) / bind group 管理，仍在 `apps/editor/src/renderer.ts`。这是 D1 剩下的 5%。⚠️ 比 L-3 难一个量级：涉及 GPU 资源创建与销毁时机，**必须重做运行时验证**（不能只靠单测），建议先补 headless 断言再动手，且该和用户确认范围后再开始。
- **低风险可做项**：L-7（grading 三色硬编码 → 进 content/ 生成层）、L-4（`CHARACTER_HEIGHT_M` 由 roster 生成）—— 两者都依赖 `content/` 生成层，可打包成一个里程碑。L-6（docs/10/11/12 上资料库）是纯文档动作，随时可做。
- **复跑冒烟**：`npm run editor:smoke -- --glb assets/characters/models/E-01/rigged/E01_Shambler_900_rigged_animated.glb`（自起 dev server；注意本机 vite 走 https）。
- **遗留 L-6**：docs/10/11/12 都还没发到线上资料库，可用 `library` skill 补发。
- **若又发现 session 落在 `automation-*`**：先 `SELECT id, name, cwds FROM automations` 查根因，别只在 `sessions.cwd` 上打补丁。

## 已沉淀到别处的内容
- 判据陷阱（setCharacter 不增对象数 / #fatal 需 getComputedStyle）+ https dev server 配方 → 已更新 skill `webgpu-headless-validate`。
- 「自动化把 session 建到临时工作区」的完整排查与迁移流程 → 已更新 skill `workbuddy-workspace-repair`
  （含：`app/sessions.json` 是陈旧快照、真正生效的是 `sessions/<pid>.json`；活跃会话要复制而非原地改写）。
- 「网页元素不显示」的 14 层诊断阶梯 + 广告拦截类名前缀命中表 + 探针假绿反模式
  → 已新建 skill `ui-element-invisible-diagnosis`（用户级）。
- 详细结论 → `game-design-zombie/.workbuddy/memory/2026-09-03.md`。
