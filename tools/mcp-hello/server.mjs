/**
 * MCP hello-world 探针（零依赖，Node ≥20 直接跑）。
 *
 * 用途：验证「本仓库自写一个 stdio MCP server」的最短链路 ——
 * initialize 握手 → tools/list → tools/call，全部走**换行分隔 JSON-RPC 2.0**
 *（MCP stdio 传输 = NDJSON，不是 LSP 的 Content-Length 帧）。
 *
 * 这是后续 `tools/mcp-binding/`（绑定领域 MCP 入口，领域真源 =
 * apps/editor/src/services/binding/binding-session.ts）的链路探针：
 * 协议通了，后面的 server 只差把工具表映射到 BindingSession 方法。
 *
 * 自测：node tools/mcp-hello/probe.mjs
 * 注册到 ZCode：见同目录 README.md。
 */

const SERVER_INFO = { name: 'aether-mcp-hello', version: '0.1.0' };
/** 兜底协议版本：客户端没带版本时回复本 server 支持的版本 */
const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'hello_ping',
    description: '探针：回显传入的文本（验证 tools/call 链路）',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function handleRequest(req) {
  const { id, method, params } = req;
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          // 版本协商：客户端报了支持的版本就回它的，没报回自己的兜底
          //（正式 server 应在版本不支持时回己方版本并让对方降级，探针从简）
          protocolVersion:
            typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    case 'tools/call': {
      const name = params?.name;
      if (name !== 'hello_ping') {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `unknown tool: ${String(name)}` },
        });
        return;
      }
      const text = params?.arguments?.text ?? '';
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `pong: ${text}` }] },
      });
      return;
    }
    default:
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not found: ${String(method)}` },
      });
  }
}

// ── NDJSON stdio 主循环 ──
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf('\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line === '') continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // 坏行忽略：stdio 上噪声不该打死 server
    }
    // 通知（无 id）不回复，如 notifications/initialized
    if (msg !== null && typeof msg === 'object' && 'id' in msg) {
      handleRequest(msg);
    }
  }
});
