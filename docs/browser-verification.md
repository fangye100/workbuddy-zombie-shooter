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
