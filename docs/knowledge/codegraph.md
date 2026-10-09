# 开发 Agent 的 CodeGraph MCP 使用指南

## 连接目标检出目录

2026-10-09 已通过实际 MCP `initialize`、`tools/list`、`project_map`/
`module_overview` 验证本机服务器为 `code-graph-mcp 0.167.0`。
Agent 看到的具体工具名取决于客户端，不依赖某家产品的记忆或工具命名空间。

支持 stdio MCP 的客户端使用已安装的 `code-graph`，参数为 `serve`，工作目录必须是
**实际检出目录**。PowerShell 用 `Get-Command code-graph` 查本机位置，其他主机使用
等效方法。不要复制别人的全局安装路径、修改全局客户端设置或静默安装软件。Windows
客户端不能直接执行 `.cmd`/`.ps1` 包装时，先定位本机已安装的 Node CLI 入口再使用。
本仓库不替用户注册客户端，也不新增 MCP 授权。

1. 记录 `git branch --show-current`、`git rev-parse HEAD`、已有修改范围、服务器版本、
   根目录和索引完成状态；根级配置另外读取。
2. 核对根目录：`apps`、`assets`、`packages`、`tools`。`.code-graph/` 是忽略的派生缓存，
   不复制其他 worktree 的索引，不发布 SQLite 数据。
3. 使用受支持的索引接口/CLI 刷新（本次版本为 `code-graph incremental-index`）。
   尊重其他索引进程的锁；刷新不完整/过期要说明，不删除锁或中断其他会话。有的版本打印
   锁警告后仍继续索引，需同时记录警告与返回结果，不能据此认定独占、无竞争刷新。
4. 用 `tools/list` 确认当前参数，先查 `project_map` 和指定路径的 `module_overview`，
   再做指定文件的 AST/引用/调用查询。优先小范围，跟进预算遗漏、分页或受支持的完整导出。

初始化后的 MCP 调用示例：

```json
{"name":"project_map","arguments":{"max_tokens":10000}}
```

```json
{"name":"module_overview","arguments":{"path":"packages/zombie-game/src/session.ts","include_deps":true,"deps_depth":1,"max_tokens":10000}}
```

## 解读与回退

阅读定位到的源码，确认 import、方法接收者、动态派发及职责。区分生产/测试、类型/
运行时依赖和 extracted/inferred/ambiguous 调用。本版本目录概览可能返回
`dependencies_unavailable`，应改查具体文件，不能当作“没有依赖”。同名 `set`、`find`、
`clear` 可产生歧义关系；本次控制模块的关系用源码 import 核实，没有直接判定耦合。
深度 1 也会出现此问题：关系列表不是 AST import 清单。

只含导出的入口文件可能返回 `files_count: 0`/“No files found”，但同时提供导出依赖。
必须读真实入口和源码门禁再判断文件/包缺失。`project_map.entry_points: []` 也不表示
编辑器没有入口。

Worker URL/消息、`import.meta.glob`、注册表注入及 HTTP/WebSocket/MCP 派发须核对
两端。静态关系缺失不能证明死代码。报告解析错误、未解析调用和快照范围，不用调用次数
推导成本、频率或品质。

若当前客户端没暴露 MCP，但已安装 stdio 服务仍可用，可用受支持的 MCP 客户端调用。
合理尝试后两条路径都不可用，再说明具体错误并回退到定向源码阅读/搜索，其他工作继续。
不得编造图谱结果。

[结构图谱](../44-CodeGraph代码结构图谱.md)区分 2026-10-09 当前源码复核和保留的
2026-10-08 测量。[当前职责](../architecture/layers.md)及 `architecture:check`
约束新代码。迁移后刷新索引；类型检查、owner 测试、scene/content/motion 门禁和有界面
真实 GPU 路径仍是必要的行为证据。
