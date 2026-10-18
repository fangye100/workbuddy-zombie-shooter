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
