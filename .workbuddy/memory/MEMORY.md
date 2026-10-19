# 项目长期记忆（末日尸潮 / Aether Game Editor）

> 跨 Agent 入口：[共享知识](../../docs/README.md)、[当前分层契约](../../docs/architecture/layers.md)、[CodeGraph](../../docs/knowledge/codegraph.md)、[游戏开发流程](../../docs/43-GameplayDevelopmentWorkflow.md)、[品质指南](../../docs/art/visual-quality-playbook.md)。
> 2026-10-11 精简重写：只保留仍然生效的铁律与教训，完整历史见 `docs/` 与 `.workbuddy/memory/YYYY-MM-DD.md`。
> 2026-10-19 双 Agent 审核校订：修正 schema 版本、行尾规则、武器挂接现状、maxHp 消费、剪贴板教训时效。
> 集成 schema 版本真源 = `packages/scene/src/document.ts` 的 `SCHEMA_VERSION`（2026-10-19 时为 v22，勿在本文写死）；僵尸模拟与表现属 `packages/zombie-game`；历史报告（36/37/39/42）数值属其记录版本，读实时文档为准。

## 🔴 铁律（git / 仓库）
- **提交即推送**（逐笔，禁攒本地）；只 add 本会话改的文件，**禁 `git add -A`**；中文 message。push 失败当场解决或上报。
- 🔴 **未经许可禁碰 `.git` 内部**（fsck/删建 refs/pack/gc/rebase），异常只报症状。长 git 操作 run_in_background。
- remote `git@github.com:fangye100/workbuddy-zombie-shooter.git`（SSH，**shooter**；空仓 shotter 勿推）。
- **pnpm 9**（禁 npm/yarn）；新 worktree 先 `pnpm install` + `git lfs pull`；**LFS 指针态禁跑 scene:gen**。
- 🔴 **行尾**：`.gitattributes` 已有 `* text=auto eol=lf`（2026-10-03 起），提交即规范 LF；但 Python 写文件仍一律二进制 wb（文本模式写出的 CRLF 会被 git add 拒绝，2026-10-11 交付 JSON 踩过）；行尾规范化单独 commit。
- TS5.9 泛型 TypedArray 在**源头**标 `<ArrayBuffer>`。
- 门禁：typecheck · vitest(`--no-file-parallelism`，判绿只认文件数，**必须脱沙箱**跑) · editor:build · editor:smoke(`--headed`) · content:check · verify:prefix · scene:gen · scene:check；探针 `editor:smoke:all`、`verify:stress`、`verify:camera`。editor-smoke 收尾清 `.workbuddy/tmp/ui-refine`，攒 50+ 文件会触发沙箱批量删除保护。
- 🔴 沙箱 headed Chrome `clipboard.readText()` 恒空串 → 断言改走 HUD 回显确切路径（历史教训；main `118821c` 已改 clipboard-probe 原生读回实现零跳过）；探针挂住留僵尸进程占 `.workbuddy/tmp/chrome-profile` → 杀无 `--type=` 的主进程。

## 环境 / 引擎
- 端口：编辑器 5100 / 游戏 5101；HTTPS + Tailscale（本机 100.124.237.93）。🔴 **5100 dev server 属主 worktree**，别的 worktree 改代码在浏览器验证不到；本 worktree 自证另起 5200。
- 🔴 沙箱里 `cmd &`/`nohup &` 起的进程活不过命令结束 → 一律 run_in_background。
- 🔴 项目文件走 `/__fs/file?path=`（统一入口 asset-util.ts，路径去前导斜杠）；SPA fallback 会 200+index.html 伪装成功。
- 容量：MAX_OBJECTS=64、MAX_MATERIAL_SLOTS=256、LIGHTS_FLOATS=40（1 dir+1 point）。静态物件走 SceneGraph，500 僵尸走 SoA+instancing。
- 🔴 `import.meta.glob` 必须相对路径（vite/vitest root 分裂，曾致行为注册零命中）。
- 关卡背景=虚空底+雾渐变，禁白 albedo 天穹；主光基准 1.4。

## Scene 数据层（铁律 AGENTS.md §2，全文 docs/14）
- 三真源：`packages/scene/src/` document.ts / project.ts / asset-meta.ts；改 schema 先改它+测试+迁移链。覆盖链：aether.project.json ⊃ meta.json → prefab → scene。
- 🔴 **schema 抬版 = 字段必须真被消费**（v4 loseCondition 是反例）。门禁测试禁 `node:fs`，用 `import.meta.glob`。
- `gen-level.mjs` 时间戳不幂等 → 跑完 `git checkout -- assets/scenes/act1/`。
- gizmo：RoomVolume/SpawnPoint 必须挂 MeshRenderer 否则隐形，颜色只用共享材质 s0-s6；boot 日志会说谎，看页面内探针。

## 战斗层 P5（docs/23，ADR-019）
- 🔴 **`RuntimeSession.applyDamage()` 是掉血唯一出口**；数值零魔法数字（stats.attack / PLAYER_WEAPON / stats.hp）。
- 波号按实际存在推进（existingWaves）；房间清空按 clearRule 分派，未实现规则报 `W_ROOM_CLEAR_RULE_UNSUPPORTED` 不冒充已清；终态 outcome 冻结不清场；0 血槽位 no-op + CombatEvent 带 generation/runId。
- LOD：Full 25m/Vat 60m/迟滞 10%；mobile 烘焙档 quality.ts。maxHp 已被 HUD 治疗门控与 payHeal 消费（run-hud.ts）。

## 相机（verify:camera 21 条）
- 自由相机 free-camera.ts：eye 是状态量、target 派生物；基向量用 `m4.orbitEye()` 反查，禁抄第二遍三角公式。
- scene v5 `Camera.yawMode`（'world'/'target'），play-camera.ts 消费；机位多写者（applySceneCamera/focusOn/pinch/downMoved 累计）。

## 绑定 / 蒙皮（docs/15）
- 骨架 22+5=27 骨（tip 槽位绝不过滤）；三处同源同步：humanik-template.ts / _tools/humanik_skeleton.json / rig_humanik.py。改半径唯一入口 `BindingPanel.setCylinderRadius()`。
- 🔴 E-01 最终骨架坐标与 12 方向包围/射线投票判据的局限、正侧双视图要求 → 详见 docs/15 与 2026-10-02 之前日志。镜像方向先跟用户确认。
- MCP 绑定 tools/mcp-binding：server 以自身目录为仓库锚点；骨骼修正必须截图看图 + 独立审核员子代理到 PASS。
- 🔴 两个易混量：`hipToAnkleY=0.97`（根位移缩放）vs `legLen=0.87`（IK 链比）。MVP 只双腿、离线烘焙。

## 3D 资产管线（docs/06）
- 🔴 **混元3D 走 WorkBuddy 内置链路**：`connect_cloud_service` 拿 clientTempToken（15 分钟过期，401 重取）→ `buddy-multimodal-generation.py 3d --image-base64`。命令行传不了大 base64 → 用 wrapper（本 worktree：`.workbuddy/tmp/weapons-hunyuan/gen3d_wrapper.py`，import 方式注入 argv）。限额 **日 5 次、并发 2**（429 浪费提交机会）；下载用 urllib 后台（沙箱拦前台下载；下载脚本 download_results.py 同目录）。
- 2026-10-11 武器批次：`assets/_delivery/WPN-20261011/`（WPN-07-LAUNCHER、WPN-MAG-01、WPN-MAG-02-SMG、WPN-SHELL-01、WPN-FUEL-01 源 GLB，均未标定/未减面）。
- **ImageGen `background:transparent` 不可信**（白底/棋盘假透明）→ keyout.py 抠底；ImageGen 有「AI生成」角标水印 → **先裁底部再喂 3D**。
- **LOD 铁律**：焊点 + `quadric_edge_collapse_with_texture(preserveboundary=False)`；glTF UV 逐顶点 → wedge 分裂；glb 手写容器对齐规则；LOD2/3 复用骨架 `prune_base`；面数 = roster.tris×3（下限 3000）。🔴 B-02 从未绑骨。
- 🔴 **武器本体现状（2026-10-12 更新，2026-10-19 校订）**：docs/31 §5 六武器本体**全部有源件**——WPN-01（`assets/art/models/WPN-01/`，提交 `e3bc6c4`）+ WPN-02..06（2026-10-12 混元生成，`assets/_delivery/WPN-20261012/`，100k 面+PBR，未归一化/未减面）；弹匣类源件在 `assets/_delivery/WPN-20261011/`。floor-1 场景 arsenal 七武器已挂真实 model AssetRef（含 guid，提交 `b8f60c3c`），placeholder 仅作兜底；源件接入流程仍需米制归一化（Y-up、枪口 +Z、主握把根原点）+ LOD + 挂点标定。
- 🔴 **混元 3D 额度按 UTC 日重置**（本地 08:00 刷新），429 = daily submit limit exceeded；**ImageGen 并行同秒提交会文件名撞车互相覆盖** → 串行或立即重命名。
- 交付约定（docs/38）：先交 `assets/_delivery/<批次>/<ID>/`，delivery.json 必填（ID/角色/版本/工具/许可/成功缺失项）；源资产到货 ≠ 运行时验收。

## PR / 评审闭环（pr-bot-review skill）
- Copilot review 只走 GitHub MCP `request_copilot_review`（camelCase `pullNumber`）；首个 bot review 到达后再等 3–5 分钟（第二轮常在 push 后才到）；定型前不修复、每条先复现再回复；批量回复用脚本 + `gh api -F body=@file`；`gh pr view --json` 无 `merged` 字段。
- 🔴 schema 抬版时 `tools/level/*.mjs` 版本常量是盲区 → level-scenes.test.ts 已防线。

## 浏览器验证（AGENTS.md §4）
- headed Chrome + 真实 GPU，禁 headless+SwiftShader；不加 --no-sandbox/--disable-dev-shm-usage；必加 --ignore-certificate-errors；固定 profile `.workbuddy/tmp/chrome-profile`。
- 自签 HTTPS 下 undici fetch 挂 → 原生 https.get(rejectUnauthorized:false)；vite 输出先 stripAnsi；**`CONSOLE ERRORS: 0` 才是关键指标**；写用户资产的脚本还原放 finally。

## 开发流程元教训
- 判别力实验前置（禁用修复→失败→恢复全过）；修「类」不修「字面」；先审后记；typecheck 归零是 commit 前置；独立子代理审核到 PASS；🔴 修完 bug 必须补防线。

## 线上资料库（workbuddy.cn/space）
- connect_open_platform 换票 → list-user-spaces → get_doc_reviews.py → submit_doc_edit.py（新增）/ submit_review_edit.py（改已有），均先 --dry-run；新建整篇用 create_doc.py。Table 只接受无属性、加删行列=整表重建。personal spaceId `GHweUCr3bUooHpT4dfdVQi`；team `cCwTkzCwCevtZDBkVGnFEv` 仅 reader。
- 🔴 PowerShell 捕获子进程 stdout 按本地码页解码 → 中文一律 Python wrapper（utf-8）写文件。

## Windows 沙箱环境坑
- Git Bash 可能突然损坏（基础命令 not found）→ 转 PowerShell 重定向到 tmp log 再 Read；文件操作优先专用工具。present_files 探不活自签 HTTPS → CDP 截图。
