# 剪贴板读回修复与完整验收（2026-10-19）

基线 `22becc569009d71f9283f956d2d89f5b6b8377d9`，分支
`codex/object-pool-framework-20261018`，检出
`C:/Users/fangy/Documents/Projects/visual-quality-20261007/game-design-zombie`。
本记录与对应工具修复在同笔提交，源码指纹见 [source-snapshot.json](source-snapshot.json)。

## 定位与修复

旧核心套件使用 DOM `btn.click()` 触发复制，并把原生读回空值/拒绝视为 SKIP；
HUD 成功并不能认证系统剪贴板内容。定向观察复现了编辑器失焦：focus=false、
activation=false，原生 writeText 抛 `NotAllowedError: Document is not focused`，
随后 execCommand 返回 false。这条被观察的失败轮次没有计入通过结果。

相同固定 Profile 的独立校准证明浏览器原生 writeText/readText 与 Windows
Set/Get-Clipboard 均能传递已知 nonce，排除了“本机剪贴板无法读回”的先前判断。
聚焦并真实鼠标点击后，focus/activation=true，应用原生 writeText resolved、没有进入
execCommand 降级，原生读回精确匹配。见 [定向诊断](diagnosis.json) 与
[原生/Windows校准](calibration.json)。观察器只委托原生 API 记录状态；**最终正式套件没有观察器或 API 替换**。

修复归属 `tools/verify`，应用 `copyText` 与菜单实现保持现有实现。本轮不需修改游戏规则：

- `clipboard-probe.mjs` 先 bringToFront，检查实际焦点、可见、启用及点击中心未遮挡，
  再发真实右键打开资产菜单、真实左键执行复制。不使用 focus emulation。
- 复制相对路径后，等待精确 HUD 与原生 readText 同时匹配。每轮独占夹具保证预期路径唯一。
- 再复制绝对路径覆盖前次内容，期望由 Node path.resolve 独立推导，不沿用产品端点返回值。
- 读空、旧值、拒绝、失焦、挂起及 CDP 异常都失败，不再 SKIP。权限授权失败也向外传播，
  由启动器既有清理释放自建 Chrome。读回有5秒外层 deadline，命令仍有共享 CDP 上限。
- 只返回已知 HUD 与匹配/长度/焦点/错误元信息，不输出无关剪贴板正文，不预写期望路径。

## 实际验证

```powershell
pnpm run editor:smoke:all -- --headed --out .workbuddy/tmp/clipboard-repair/all-1
```

2026-10-18 23:57:55.802 至 2026-10-19 00:00:24.908（UTC+8），实际串行四套件，
主命令退出0、aggregate.ok=true、四子进程status=0、notRun=[]。

| 套件 | PASS | FAIL | SKIP | console.error / 未捕获异常 |
|---|---:|---:|---:|---|
| 核心 editor-smoke | 125 | 0 | 0 | 0 / 0 |
| 绑定 editor-binding-smoke | 111 | 0 | 0 | 0 / 0 |
| 战斗 combat-probe | 18 | 0 | 0 | 0 / 0 |
| 动态蒙皮 dynamic-skin-probe | 35 | 0 | 0 | 0 / 0 |
| 合计 | **289** | **0** | **0** | **0 / 0** |

相对路径读回 matches=true、length=34；随后绝对路径 matches=true、length=111；
两者 readable=true、focused=true、error=null，且 HUD 精确匹配。不是只看 HUD 或空字符串。
前置单跑核心也是125/0/0；一轮带诊断观察器的试跑曾在末尾语言刷新超时，不作为验收通过，
最终无观察器的单跑及聚合均实际完成双语来回刷新。

原始结果：[聚合](aggregate-results.json)、[完整输出](aggregate-console.txt)、
[核心](core-results.json)、[绑定](binding-results.json)、[战斗](combat-results.json)、
[动态蒙皮](skin-results.json)。战斗仍验证真实输入击杀、跨波边界、死亡冻结与Stop释放；
动态蒙皮仍验证精确503故障、代理降级、下一局恢复及GPU palette重传。

严格 HTTPS MagicDNS、1600×1000 headed Chrome 155、项目固定 profile，
实际编辑器 GPUDevice.adapterInfo 为 secure=true、fallback=false、vendor=nvidia、
architecture=lovelace。未使用软件GPU或忽略证书参数。绑定沿用同一 headed 受控启动路径。
本轮自建 Chrome/Vite 已按 finally 退出，5100/9333 没有遗留监听。

已查看实际截图：[核心白盒](editor-core.png)、[战斗第二波](combat-wave2.png)、
[动态蒙皮与代理](dynamic-skin.png)。截图展示运行现场，精确剪贴板内容以原生读回结果为证据。
这些是工具/白盒运行验收，不将其延伸为正式关卡美术、帧预算或全平台品质认证。

## 回归、独立审核与范围

- `node --test tools/verify/clipboard-probe.test.mjs tools/verify/editor-smoke-lib.test.mjs tools/verify/game-probe-oracles.test.mjs`：
  **19/19**，见 [测试输出](unit-console.txt)。新增5项覆盖真实输入及焦点/遮挡前提、
  读空/旧值/HUD不匹配、权限拒绝/失焦、原生挂起及CDP断连，不把失败改成跳过。
- `pnpm run architecture:check`：338文件，errors=[]；`git diff --check`：通过。
- `pnpm run knowledge:check`：通过。没有资产/场景变更，本轮不重复资产门禁。
- 独立子代理 `/root/decal_gpu_review` 只读终审无P0/P1/P2或提交阻断，实际重跑19项通过，
  并核对完整四套件日志、权限失败传播、超时与隐私；未用其Node测试代替主代理headed验收。
- CodeGraph 0.167.0先查 project_map 与 asset-util/main/共享启动器的定向 module_overview，
  再读源码核实菜单→copyText、CDP→真实输入两端。修改后增量更新4文件、41节点，
  本轮0解析错误；embeddings为4007/8072，未宣称全图关系完整。

本轮请求无未完成项。旧记录的剪贴板未认证限制由本记录闭环，历史计数保留。
仅提交本任务工具、回归与中文知识/证据；其他检出、角色资源及并行会话修改保持原位。
