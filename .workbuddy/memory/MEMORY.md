# 项目长期记忆（末日尸潮 / Aether Game Editor）

> 2026-10-02 精简重写：合并重复条目、删除已完结的过程细节。完整历史见 `docs/` 与 `.workbuddy/memory/YYYY-MM-DD.md`。

## 🔴 铁律
- **git**：提交即推送（逐笔），禁攒本地；只 add 本会话改的文件，禁 `git add -A`；中文 message。
- **未经许可禁碰 `.git` 内部**（fsck/删文件/建 refs/碰 pack/gc/rebase 改历史），异常只报告症状。长 git 操作用 run_in_background。
- remote `git@github.com:fangye100/workbuddy-zombie-shooter.git`（SSH，**shooter**；另有空仓 shotter）。
- **pnpm 9**（禁 npm/yarn）；新 worktree 先 `pnpm install` + `git lfs pull`，**LFS 指针态禁跑 scene:gen**。
- **Python 读写文本毁行尾**：改已存在文件一律二进制 rb→replace→wb。
- 🔴 **行尾纪律**：仓库标准是 LF，`.gitattributes` **没有** `text=auto eol=` 规则（只有 LFS 条目）→ 行尾靠工具自觉。曾发生 `main.ts` 被整文件写成 CRLF、后被某个功能 commit 整文件改回 LF（+3793/−3754，实质仅 39 行，blame 全毁）。**行尾规范化必须单独 commit，绝不混进功能提交。**
- TS5.9 泛型 TypedArray 要在**源头**标 `<ArrayBuffer>`，不是调用点 cast。
- 门禁：typecheck · vitest(`--no-file-parallelism`,判绿只认文件数，且**必须脱沙箱**：多 worker 抢写 ssr 缓存会 EPERM 静默掉整个文件) · editor:build · editor:smoke(`--headed`) · content:check · verify:prefix · scene:gen · scene:check。浏览器探针：`editor:smoke:all`（含 combat-probe / dynamic-skin-probe）、`verify:stress`（200 只压测）、`verify:camera`（相机双问题防线）。
- ⚠️ editor-smoke 收尾会清理 `.workbuddy/tmp/ui-refine`，历史临时文件攒到 50+ 会触发沙箱批量删除保护而中断（非产品回归）→ 跑前先手动清该目录。
- 🔴 **本沙箱 headed Chrome 的 `navigator.clipboard.readText()` 稳定返回空串** → editor-smoke 剪贴板核对按"环境不可核对"skip；产品行为由 HUD 回显确切路径断言（不接受"复制失败"）。
- 🔴 探针的 headed Chrome 若中途挂住会留僵尸进程占 `.workbuddy/tmp/chrome-profile`（后续启动附加到旧实例）→ 按命令行含该 user-data-dir 的**主进程**（无 `--type=`）杀。

## PR / 评审闭环（pr-bot-review skill 的实测要点）
- 申请 Copilot review 只走 GitHub 官方 MCP `request_copilot_review`（参数 camelCase `pullNumber`，空 body = 已受理，需轮询 reviews）；REST `requested_reviewers` 传 Copilot 是死路。
- 🔴 **首个 bot review 到达后再等 3–5 分钟**：本次 Copilot 第二轮是在我 push 之后才到的，7 条新 comment 里含 2 条 High。
- 定型前**不做任何修复**；每条 comment 先复现再判定；**每条都要回复**（认可 👍 + commit，拒绝给 file:line 依据）。
- 批量回复用脚本 + `gh api ... -F body=@file`（中文/反引号在 shell 里必炸）。
- `gh pr view --json` 没有 `merged` 字段（只有 `state`/`closedAt`）。
- 🔴 **schema 抬版时 `tools/level/*.mjs` 里的版本号常量是零报警盲区** —— 已补 `level-scenes.test.ts` 用 `?raw` glob 断言工具常量 === `SCHEMA_VERSION` 真源。

## 环境 / 引擎
- 端口：编辑器 5100 / 游戏 5101；须 HTTPS + Tailscale（本机 IP 100.124.237.93）。
- 🔴 **5100 上的 dev server 属于主 worktree `game-design-zombie`** —— 别的 worktree 改代码在浏览器里验证不到（假象）。查法：`Get-NetTCPConnection -LocalPort 5100` → PID → 看 CommandLine。本 worktree 自证要另起 5200。
- 🔴 沙箱：`cmd &` 起的进程活不过命令结束（Chrome 也一样）→ 一律 run_in_background。
- 不用 `core/src/ecs/world.ts` 当场景骨架。静态物件走 SceneGraph，500 僵尸走 SoA+instancing。
- 容量：MAX_OBJECTS=64、MAX_MATERIAL_SLOTS=256、LIGHTS_FLOATS=40（→ 只 1 dir+1 point，落选灯标黄）。
- 🔴 项目文件走 `/__fs/file?path=` 端点（统一入口 `asset-util.ts`，**路径先去掉前导斜杠**）；SPA fallback 会返 200+index.html 伪装成功。仅 dev 中间件有。
- 关卡背景 = 虚空底 + 雾渐变，**禁白 albedo 天穹**；主光基准 1.4；s1 材质 #707A8C。
- 🔴 **`import.meta.glob` 必须用相对路径**：vite 的绝对路径 `/assets/...` 按 root(=apps/editor) 解析，vitest 按仓库根解析 → 「编辑器断、测试绿」的宿主分裂。行为注册 glob 曾因此**从第一天起零命中**（2026-10-02 修复，commit e7861ac，仍无自动化防线）。

## Scene 数据层（铁律 AGENTS.md §2，全文 docs/14）
- 三份真源：`packages/scene/src/` 的 document.ts / project.ts / asset-meta.ts。改 schema 先改它 + 补测试 + 补迁移链。
- 覆盖链：`aether.project.json` ⊃ `<file>.meta.json` → `*.prefab.json` → `*.scene.json`。
- 门禁测试禁用 `node:fs`（无 @types/node）→ 用 `import.meta.glob`。
- 🔴 **schema 抬版 = 字段必须真被消费**。反例（2026-10-02 审查发现）：v4 的 `loseCondition` 写了定义/迁移/测试/场景文件，但运行时零消费、失败判定仍硬编码 → 假数据载体；且磁盘数据版本分裂（floor-1=v4、floor-2/3=v3、sandbox=v2、sim/*=v3），靠运行时迁移兜底，`gen-level.mjs` 一跑就出 v3→v4 diff。
- `node tools/level/gen-level.mjs` 一层一关；**时间戳不幂等**（每次刷新 meta.createdAt/updatedAt）→ 跑完记得 `git checkout -- assets/scenes/act1/` 还原。
- gizmo 铁律：RoomVolume/SpawnPoint 必须同时挂 MeshRenderer（否则编辑器隐形），NavZone 豁免；颜色只能用共享材质 s0-s6。**boot 日志会说谎**，真机验证看页面内探针。

## 战斗层 P5（docs/23，ADR-019）· 2026-10-02 已完成 C1–C5
- **红线：`RuntimeSession.applyDamage()` 是掉血唯一出口**（击杀事件/受击高亮/胜负/回收全挂在这）。任何直写 `table.health` = 不可审计。
- 数值零魔法数字：NPC 四态走 `stats.attack`，手枪走 `PLAYER_WEAPON`，血量真源 `stats.hp`（E-01=60、玩家=100）。
- WaveScheduler：`wave≤0` 归 1（旧数据兼容）；清空→2s 间隔→下一波；容量不足**推迟重试不丢波**（`W_SPAWN_CAPACITY` 诊断按 code|nodeId 去重）。
- 🔴 波号按**实际存在**的推进（`existingWaves`/`nextExistingWave`）：硬编码首波=1、`nextWave++` 会造幽灵 wave-start、稀疏波号跳波、wave=1.5 静默跳过（schema 加 `E_SPAWN_WAVE` + 装载期 `W_SPAWN_WAVE_FRACTIONAL`）。
- 🔴 房间清空按 `clearRule` 分派（`isRoomSatisfied`）：kill-all/none 才清；interact/elite-dead 本轮未实现 → `W_ROOM_CLEAR_RULE_UNSUPPORTED` + **不冒充已清**（旧实现会发假 floor-clear）。后果：floor-1 的 nd_f1r1 是 interact，**该层现在打不通**（真相如此）。
- 终态 `outcome`：game-over/floor-clear 即冻结（step 短路），**不自动清场**。
- 0 血槽位 no-op（`applyDamage` 开头）：玩家死后槽位保留（isAlive 仍 true），不闸住会重复 kill 事件 + 重跑死亡路径。`CombatEvent` 带 `generation`/`runId`/`sourceGeneration`（裸 slot 会被回收顶替）。
- P4 M4 已完成（docs/24）：LOD 接线（Full 25m/Vat 60m/迟滞 10%，远处退胶囊）、mobile 烘焙档（`packages/render/src/quality.ts`，项目 targetTier 驱动）、200 只压测（`verify:stress`）。
- ⚠️ `maxHp` 仍只写不读（HUD 属 P8，未接线）；`hitFlash` 已修（每 tick 衰减 + view() 暴露）。

## 相机（2026-10-03 完成，用户实报双问题）
- **编辑器自由相机**：`apps/editor/src/services/free-camera.ts`。🔴 eye 是状态量、target 是派生物
  （转向=原地转头保 eye 不动）；基向量必须用 `m4.orbitEye()` 反查，**禁抄第二遍三角公式**
  （曾 X/Z 写反 → forward/right 共线、斜向走不动）。操作：✈ 按钮/V 开关、Esc 退出、
  WASD/QE/Shift、拖拽转头、滚轮调速 1–80 m/s。Play 期间拒入 + 进 Play 自动退出（§2.4）。
- **上帝视角不跟转身**：scene **v5** `Camera.yawMode`（'world' 缺省锁世界方向 / 'target' 肩后），
  migrateV4ToV5 补缺省，`play-camera.ts:190` 消费，validate 报 E_CAM_YAW_MODE。8 场景已迁 v5。
- **机位归属**：编辑态也有多套写者 —— `applySceneCamera`（飞行中到达→暂存，退出补应用）、
  `focusOn`（freeCamOn 直接忽略）、双指 pinch（飞行中忽略第二根）、freecam pointermove 分支
  **必须累计 downMoved**（漏了 → 拖拽松手被当轻点拾取）。
- 门禁 `verify:camera`（21 条）：K1 飞行/原地转头/Play 拒入/拖拽不拾取；K2 上帝视角
  （yaw Δ<1e-6 + 判别力守卫：玩家位移>0.3m、朝向翻转≈π）。就绪闸门绑真源
  （aether.project.json→startIndex→场景 editorCamera；场景弧度、主视图存度）。
- Camera 组件无 Inspector UI（所有字段 JSON-only，既有状态）；'target' 需手改 JSON。

## 绑定 / 蒙皮（全文 docs/15）
- P0 已修（按骨 id 聚合邻域 / WeightMode 下拉 / 写 sidecar 前 validateAssetMeta）。P1 未修：PEN_SCALE 不尺度不变、包裹体外硬权重 1.0、无权重视图热力图。
- 骨架 22+5=27 骨（tip 保留槽位零，**绝不过滤数组**）；同源三处同步改：humanik-template.ts / _tools/humanik_skeleton.json / rig_humanik.py。
- 改半径唯一入口 `BindingPanel.setCylinderRadius()`（主视口/面板/2D drawSkin 三路径都要响应）。
- 🔴 **E-01 最终骨架**（R2L 镜像，commit f17710e，左右 Δ=0）：Hips (0,1.040,−0.150) · Spine (0,1.150,−0.260) · Spine1 (0,1.300,−0.280) · Spine2 (0,1.600,−0.200) · Neck (0,1.700,+0.100) · Head (0,1.900,+0.230) · RightArm (−0.265,1.650,−0.042) · RightForeArm (−0.364,1.250,−0.130) · RightHand (−0.434,0.845,−0.002) · RightUpLeg (−0.170,0.995,−0.130) · RightLeg (−0.210,0.498,−0.084) · RightFoot (−0.220,0.110,−0.310) · RightToeBase (−0.263,0.040,−0.110)。
- 🔴 定位判据（两个都**判不了「在对的位置」**，只用于排除明显错误）：
  - **12 方向包围**会假 PASS（测"周围有没有几何"，夹缝也高分）；
  - **射线奇偶投票**（Möller–Trumbore 与高模求交，奇数=在内，6 轴 ≥3/6）是真判据，但**区分不出高度**。
  - → 定位必须靠解剖标志 + 骨段比 + 用户判读；**任何位置判定都要正/侧两视图都过**。
- 教训：比值是诊断指标不是目标函数；量测必须用高模（LOD 噪声极大）；**镜像方向先跟用户确认**（曾把 R→L 做成 L→R 被纠正）；wrapper 定稿后必须先发正/侧全貌图给用户确认。

## MCP 绑定（tools/mcp-binding，分支 followup/pr1-copilot-review）
- 16 工具，让 Agent 看见绑定结果并导出 rigged GLB。`mcp-binding:build` / `mcp-binding:check`。注册 `.zcode/config.json`；工具名 `mcp__aether-binding__<tool>`。
- 🔴 **server 以自身所在目录为仓库锚点**——注册哪个 worktree 就读写哪个 worktree。
- 🔴 骨骼视觉修正纪律：必须截图看图修正（禁数值盲调）；每轮过**独立审核员子代理**到 PASS（禁自证）；先 joint 后 wrapper；对位时关 proxy；破损衣物不算轮廓。
- 🔴 画布尺寸不固定 → 别用硬编码像素常数标定，优先用网格参考线（面板 `drawGrid()` / MCP `render{grid}`）。
- 方法已存 skill `binding-geometry-audit`。

## Retargeting（docs/16/16A/16B）
- MR-01..06 已入 main；剩真实 mocap 验收、标定 UI、MR-07/08。
- 🔴 接触锁脚要求 `SourceCalibration.markers` **显式**足底标记，未标定=不做。`pelvisHeightM` 是相对量，不得再减 planeY。
- 🔴 两个易混量：`hipToAnkleY=0.97`（根位移缩放）vs `legLen=0.87`（IK 链比）。MVP 只双腿、离线烘焙。

## 3D 资产管线（docs/06）
- 管线：front.png → 混元图生3D → decimate_cluster(面积保持>80%) → bake_lowpoly(xatlas) → rig_character → retarget_bvh → validate_glb。两套 Python：云端/绑骨 versions/3.13.12；减面/烘焙 envs/default。混元图生3D 5 次/天(429)、不能带 --prompt。
- 🔴 **混元3D 现走 WorkBuddy 内置链路**（2026-10-05）：自备 key 的 hunyuan-3d skill 已失效（401）。用 `connect_cloud_service` 拿 clientTempToken（**15 分钟过期**，401 即重取）→ `buddy-multimodal-generation.py 3d --image-base64`（命令行传不了大 base64，用 wrapper 在 python 内部读文件转 base64，`.workbuddy/tmp/gen3d_wrapper.py`）。限额：**日 5 次、并发 2**（429 会浪费提交机会，先查并发再提）。GLB+预览图下载用 urllib 后台跑（前台 Invoke-WebRequest 被沙箱拦）。
- **LOD 铁律**：花脸根因是几何（聚类减面跨部位）→ 焊点 + `quadric_edge_collapse_with_texture(preserveboundary=False)`；glTF UV 逐顶点 ≠ OBJ vt 逐面角 → 必须 wedge 分裂；glb 手写容器 JSON 填 0x20、BIN 填 \x00、双 chunk 4 字节对齐；绑骨侧网格缩放到 2.05m 且脚底 y=0；LOD2/3 复用骨架必须 `prune_base`。
- 面数 = roster.tris × 3（下限 3000）。🔴 **B-02 从未绑骨**（无 rigged/）。
- 🔴 **ImageGen `background:transparent` 不可信**：返回 RGB 实底，常见白底或**棋盘格假透明**；VFX 源帧抠底用 `.workbuddy/tmp/keyout.py`（白底 flood-fill 保黑边内白核 / 棋盘格亮度阈值+开运算+最大连通域；`--inner-clear` 清环内填充、`--no-loose` 保白色内容）。

## 浏览器验证（AGENTS.md §4）
- **headed Chrome + 真实 GPU**，禁 headless+SwiftShader；不加 `--no-sandbox`/`--disable-dev-shm-usage`；必加 `--ignore-certificate-errors`；固定 profile `.workbuddy/tmp/chrome-profile`。
- 自签 HTTPS 下 undici `fetch()` 挂 → 用原生 `https.get(rejectUnauthorized:false)`；vite 输出带 ANSI → 先 stripAnsi。
- 时序坑：HUD 每 0.4s 刷新（采样 >700ms）；draw 基线轮询到连续两次相同再取。写用户资产的脚本**还原放 finally**。
- **`CONSOLE ERRORS: 0` 才是关键指标**（不是 PASS 数）。

## 开发 / 审核流程（元教训）
- 🔴 **判别力实验是交付前置**：每条回归自证「禁用修复→失败→恢复全过」；差分 oracle 必须对错误敏感。
- 修"类"不修"字面"；**先审后记**（docs 不得预写复审结论）；typecheck 归零是 commit 前置（vitest 全绿会掩盖类型错误）；读回 oracle 不得用被测代码的 helper。
- 独立审核闭环：独立子代理自跑门禁 + file:line 证据 + 分级 → 修复 → 复审到 PASS。
- 🔴 **修完 bug 必须补防线**：抓不到 = 会复发（尤其只能靠人开浏览器才能发现的缺陷）。

## 线上资料库（workbuddy.cn/space）
- 流程：connect_open_platform 换票 → list-user-spaces 判 category → get_doc_reviews.py → submit_doc_edit.py(新增)/submit_review_edit.py(改已有)。本地 docs/ 是真源。
- 🔴 Table 只接受无属性；仅 delete/insert_before/insert_after；加删行列=整表重建 → rowHeader 永久丢失。新建整篇用 create_doc.py（先 `--dry-run`）。
- personal spaceId `GHweUCr3bUooHpT4dfdVQi`；team `cCwTkzCwCevtZDBkVGnFEv` 仅 reader。
- 🔴 PowerShell 捕获子进程 stdout 按本地码页解码 → **中文 UTF-8 不可逆丢失**。返回中文的脚本一律用 Python 包装器（`encoding="utf-8"`）写文件。

## 环境坑（Windows 沙箱）
- Git Bash 会突然损坏（dirname/cd/head/tail not found）→ 用 PowerShell（重定向到 `.workbuddy/tmp/*.log` 再 Read）+ Write/Read/Glob/Grep。
- `nohup & disown` 起的进程活不过命令结束 → 用 run_in_background。
- present_files 探不活自签 HTTPS → 用 CDP 截图。
