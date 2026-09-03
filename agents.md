# 项目协作规则 (agents.md)

本文件是给 AI 协作会话（WorkBuddy Agent）的项目级硬性规则。**改项目前先读本文件。**

## 1. 编辑器必须经 Tailscale 可达

- Game Editor (WebGPU) dev 服务：`npm run lab` → 端口 **5178**。
- vite `server` 必须保持：
  - `host: true` —— 监听所有网卡，含 Tailscale 虚拟网卡（100.124.237.93 / `*.ts.net`）。
    手机或异地设备经 Tailscale 访问编辑器依赖这一项；只绑 localhost 会收不到外部请求。
  - `allowedHosts: true` —— 放行 `*.ts.net` 等任意 Host。否则 Vite 的 host-check 会在
    应用层返回 `403 Blocked request. This host is not allowed.`，表现为「连得上但打不开」。
- **禁止**把 `server.host` 改回 `localhost` / `127.0.0.1` / 某个具体 IP，会切断 Tailscale 访问。
- 经 Tailscale 访问**必须用 HTTPS**：WebGPU 只在 secure context 下可用，HTTP 下
  `navigator.gpu` 为 `undefined` → 黑屏。证书由 `tailscale cert <magicdns>` 生成
  （`fangye-win11-office.tail6b29a2.ts.net.crt/.key`），放在 `.workbuddy/tmp/certs/`
  （已 gitignore），vite 检测到即自动走 HTTPS；缺失则退回 HTTP（仅本机 localhost 可用）。
- 访问地址（三选一）：
  - `https://localhost:5178`（本机）
  - `https://100.124.237.93:5178`（Tailscale IP）
  - `https://fangye-win11-office.tail6b29a2.ts.net:5178`（Tailscale MagicDNS 域名，推荐）

## 2. Git 提交纪律（澄清红线歧义）

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
