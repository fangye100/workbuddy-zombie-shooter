# MCP hello-world 探针

验证「本仓库自写 stdio MCP server」的最短链路，为 `tools/mcp-binding/`（绑定领域
MCP 入口，领域真源 = `apps/editor/src/services/binding/binding-session.ts`）探路。

## 自检

```bash
node tools/mcp-hello/probe.mjs   # spawn server → initialize → tools/list → tools/call
```

退出码 0 = NDJSON stdio 协议链路通（MCP stdio 传输是**换行分隔 JSON-RPC 2.0**，
不是 LSP 的 Content-Length 帧）。

## 注册到 ZCode（工作区级）

写进 `<repo>/.zcode/config.json` 的 `mcp.servers`（注意不是 `.agents/mcp.json`——
同 scope 有 `.zcode` 时后者会被整体忽略）：

```json
{
  "mcp": {
    "servers": {
      "aether-hello": {
        "command": "node",
        "args": ["tools/mcp-hello/server.mjs"]
      }
    }
  }
}
```

注册后**重启会话**生效（MCP server 在会话启动时连接）；状态看「Settings → MCP」。
工具会以 `mcp__aether-hello__hello_ping` 的形式出现（`mcp__<server>__<tool>`，
server 与工具名之间是双下划线）。
