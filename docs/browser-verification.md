# 浏览器验证入口

本机未安装可选 `web-debug` Skill 时，使用本仓库入口，不安装或恢复归档 Skill。
先读适用的主机/浏览器/GPU 规则，初始化控制前还须读 Chrome 连接/恢复说明。
若已安装本机 Skill，则按其工具路由执行。

## 交互验证

使用当前受支持浏览器工具及其返回文档，发现实际 browser/profile/tab，以专用测试标签
验证，保留其他会话标签。确认目标检出、场景和业务完成状态。连接失败按恢复流程，不能
用自定义 CDP 绕过、替换扩展或重启无关服务；登录障碍需要用户操作，本地验证可继续。

## 仓库内本地验收路径

`tools/verify/editor-smoke.mjs` 及共享库用于受控验收。此 Windows/NVIDIA 主机必须
有界面并使用真实硬件：

```powershell
pnpm run editor:smoke -- --headed
```

默认端口 5100，探针前确认服务来自目标检出，保固定端口、host、strictPort、HTTPS/
Tailscale。默认 Chrome profile/CDP 被他人占用时，不 kill 或删 profile；改用支持的
交互工具，或停止这条验证路径并报告具体归属冲突。

探针必要时启动临时服务并管理自身测试会话，不启动未记录的长期替代服务。明确启动的
长期服务须 detached，并记录工作目录、日志和准确停止方法。

验证 `isSecureContext`、真实硬件 adapter、GPU/浏览器错误。headless/SwiftShader
不证明本机视觉品质，不加 `--no-sandbox`/`--disable-dev-shm-usage` 绕过此主机问题；
不全局禁 TLS 或用隐藏 API 跳证书提示。

使用可见实际场景，区分代码 input hook 与真实 UI 路径。Edit→Apply→Save→Reload 和
Play→Stop/资源清理分别检查；截图及状态记录版本/范围，构建或仅出现 canvas 不够。
画面匹配/证据纪律见[品质指南](art/visual-quality-playbook.md)，历史硬件范围见
[P0 接入](32-P0-asset-intake-2026-10-05.md)。


## 核心冒烟的场景与启动契约（2026-10-18）

`editor:smoke` 先读取 `aether.project.json` 的真实起始场景，按稳定 NodeId 核对
可见物件、背景、分类、拾取属性及层级，再切换到已登记的
`assets/scenes/sandbox/editor-smoke.scene.json` 完成可重复交互。该夹具有非零位移的
父子 MeshRenderer、一个 SpawnPoint 和足够静态槽位，不能要求美术关卡碰巧具备测试拓扑。
项目 startIndex 不随测试改变；fixture 仍经过正常场景装载，不在引擎里硬编码造物件。

启动不能只等 `window.__editor` 或 canvas：这个 hook 在异步资产装载及服务挂接前已存在。
共享 `waitForEditorReady` 等待正确场景来源、pendingAssetCount=0、帧循环已出帧、
资产库/预览服务及有效画布；reload 还要求 performance.timeOrigin 改变，避免读到上一页。
该等待有外层 deadline，CDP eval 失联也必须失败；失败截图最多3秒。自建 Chrome/Vite
在 finally 清理，报告写入失败也不跳过进程清理，复用的服务不由探针终止。

headed 的硬件判据读取**实际编辑器 GPUDevice.adapterInfo**，必须有设备信息且
isFallbackAdapter=false，并排除 SwiftShader/llvmpipe/software；未知信息不算真实GPU。
HTTPS 默认使用本机证书匹配的 `fangye-win11-office.tail6b29a2.ts.net`，可通过 `--url`
指定可验证证书的目标地址；核心与绑定套件均不添加证书忽略 flag。

资产改名使用每轮独占的 `.smoke/editor-ui-*` 目录，在 finally 校验边界并清理。
`.workbuddy` 是协调/恢复目录，禁止拿它作可改名夹具。LOD 测试选择发布清单中有真实
GLB 及 sidecar、面数明显不同的 H-01 两档，仍验证切换后实际面数；不接管未交接高模。
导入模型后经编辑命令撤销恢复干净作者状态，不能仅删除 renderer 物体后继续测试保存/改名。

headed 窗口由 `tools/verify/editor-smoke-lib.mjs` 默认固定在 Windows DISPLAY1
（`--window-position=1920,80`），不覆盖用户在主屏与其他显示器上的工作；需要换屏时
显式传 `--window-position`。headless 不设置窗口位置。

共用启动帮助器改动后，串行运行两个 headed 套件（同一固定 profile 不可并发使用）：

```powershell
node --test tools/verify/editor-smoke-lib.test.mjs
pnpm exec vitest run apps/editor/test/dock-layout.test.ts
pnpm run editor:smoke -- --headed --out .workbuddy/tmp/editor-core
pnpm run editor:smoke:binding -- --headed --out .workbuddy/tmp/editor-binding
```

每个输出目录包含结果 JSON、错误列表及截图。断言失败、console error、未捕获异常均使
退出码非零；SKIP 必须单独报告，不能写成验证成功。`editor:smoke:all` 还组合 combat 与
动态蒙皮探针；上述两套件通过不等于该聚合命令所有探针通过，也不等于美术匹配验收。
本次实际结果见[2026-10-18验收记录](evidence/editor-smoke-20261018/acceptance.md)。


## 战斗、动态蒙皮与四套件聚合（2026-10-18）

本机一次执行全部浏览器门禁：

```powershell
pnpm run editor:smoke:all -- --headed --out .workbuddy/tmp/editor-all
```

`tools/verify/editor-smoke-all.mjs` 串行启动核心、绑定、战斗、动态蒙皮四个进程，
逐套转发参数，各有独立输出子目录，最后生成 `aggregate-results.json`。
Windows 未传 `--headed` 会明确失败；任一套件失败即非零退出，后续列入 `notRun`，
不能把未执行当作成功。也可单独运行：

```powershell
node tools/verify/combat-probe.mjs --headed --out .workbuddy/tmp/combat
node tools/verify/dynamic-skin-probe.mjs --headed --out .workbuddy/tmp/skin
node --test tools/verify/editor-smoke-lib.test.mjs tools/verify/game-probe-oracles.test.mjs
```

这两条探针先检查真实起始场景，再装载项目已登记的
`assets/scenes/sandbox/game-probes.scene.json`。战斗编成按场景稳定父引用、房间、启用状态、
room-enter 与实际波号推导。白盒用真实鼠标瞄准与 J 键完成指定身份 NPC 击杀，核对玩家
来源、弹药、弹道和模拟减员；仅后续清场使用公开 applyDamage，波次间隔用手动固定步
加速验证。白盒不携带奖励选择/街景遮挡，不能借它证明正式关卡平衡性。

动态蒙皮以“场景需求∩有骨架档”装配，不能要求加载全 manifest。Play 后立即暂停，
避免装配耗时使玩家先死亡；正式玩家的作者模型由独立呈现管线负责，不能恒要求玩家胶囊。
活跃批次按在场实体、LOD 和玩家抑制规则核对，逐行校验 flags、base、jointStride 与
完整 pose 矩阵边界。移动动画观察匹配 runId/id/generation，并核对实际位移、clip、
phase 与实例 pose；不要求静止/攻击末帧也随墙钟变化。

B-02 当前已有 rig-only 模型，探针不能再声称它本来缺档。故障测试仅在自建白盒 target
拦截 B-02 精确 GET GLB 请求并响应503；meta/BVH/其他角色请求继续，实际路径/响应单独记录。
产品必须给出明确装配诊断并显示 flags0 代理。finally 撤销拦截后重新 Play，验证 B-02
恢复真模型/flags1、诊断清除、新 runId 及 GPU palette 再上传；没有修改源资产或 sidecar。
预期503/降级警告是显式故障证据，不等于正常场景装载失败被静默放过。

Stop 与 Play **前**的作者文档/快照/物件数比对，等待正常渲染帧更新动态列表后检查批次
为空及资源 ledger 全释放。共享 CDP 每条命令默认30秒超时，断连及发送失败同样释放
pending；超时/失败不能留下成功结果。实际四套件结果见
[完整聚合验收记录](evidence/game-probes-20261018/acceptance.md)。


## 剪贴板原生读回验收（2026-10-19）

资产菜单的复制实现归 `apps/editor/src/asset-util.ts` / `main.ts`；本次修复的是
`tools/verify` 的浏览器输入与验收判据。`clipboard-probe.mjs` 先通过
`Page.bringToFront` 聚焦，核对真实焦点、目标可见/可用且未被遮挡，再发送 CDP 鼠标输入：
右键资产打开菜单、左键执行复制。不能用 DOM `btn.click()` 冒充这条用户路径。

核心套件分别验证相对路径和绝对路径：每轮独占夹具保证路径不沿用旧剪贴板值，绝对路径
由 Node `path.resolve` 独立推导，不拿产品 `/__fs/info` 的返回当预期。两次复制均须 HUD
精确匹配，并经未替换的 `navigator.clipboard.readText()` 精确读回；只记录匹配、长度、
焦点和错误，不输出无关剪贴板文本。没有预写期望路径、剪贴板 mock 或焦点模拟。

读空、读到旧值、权限拒绝、失焦或超时都使验收失败，**不再降级 SKIP**。原生读回和
CDP 等待均有上限；请求预授权失败也直接终止本套件，不能静默继续。测试使用独占
profile 的当前系统剪贴板，需保留真实可见 Chrome；无权限环境应明确失败并排查。

```powershell
node --test tools/verify/clipboard-probe.test.mjs tools/verify/editor-smoke-lib.test.mjs tools/verify/game-probe-oracles.test.mjs
pnpm run editor:smoke:all -- --headed --out .workbuddy/tmp/editor-all
```

本轮四套件 **289 PASS / 0 FAIL / 0 SKIP**，见
[剪贴板修复与完整验收](evidence/clipboard-20261019/acceptance.md)。此前报告中的空值
与跳过保留为当时事实，不能继续据此认定本机剪贴板不可验证。
