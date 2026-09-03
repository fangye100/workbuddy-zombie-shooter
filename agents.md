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
