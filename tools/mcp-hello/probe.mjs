/**
 * mcp-hello 探针的自检客户端：spawn server.mjs，走完
 * initialize → notifications/initialized → tools/list → tools/call 全链路，
 * 每步断言响应形状。退出码 0 = 协议链路通。
 *
 * 用法：node tools/mcp-hello/probe.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
const pending = new Map(); // id → {resolve, reject, timer}
let nextId = 1;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf('\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line === '') continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg !== null && typeof msg === 'object' && 'id' in msg && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if ('error' in msg) p.reject(new Error(`RPC ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  }
});

function call(method, params = undefined) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method };
  if (params !== undefined) msg.params = params;
  child.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve,
      reject,
      timer: setTimeout(() => reject(new Error(`超时: ${method}`)), 5000),
    });
  });
}

function notify(method) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
}

/**
 * 单独验证版本协商：initialize 一会话只能握一次手，故另起一个短命子进程，
 * 发 `version` 后只读 initialize 响应里的 protocolVersion。
 */
function negotiate(version) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
    let b = '';
    const finish = (v) => {
      clearTimeout(timer);
      c.kill();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), 5000);
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (chunk) => {
      b += chunk;
      const nl = b.indexOf('\n');
      if (nl < 0) return;
      let msg;
      try {
        msg = JSON.parse(b.slice(0, nl).trim());
      } catch {
        return;
      }
      finish(msg?.result?.protocolVersion ?? null);
    });
    c.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: 'mcp-hello-probe', version: '0.1.0' },
        },
      }) + '\n',
    );
  });
}

const checks = [];
const check = (name, ok) => {
  checks.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
};

try {
  const init = await call('initialize', {
    protocolVersion: '2025-03-26', // 发支持集内的旧版本：验证 server 回显（协商成功）
    capabilities: {},
    clientInfo: { name: 'mcp-hello-probe', version: '0.1.0' },
  });
  check('initialize 返回 serverInfo', init?.serverInfo?.name === 'aether-mcp-hello');
  check('initialize 声明 tools 能力', init?.capabilities?.tools !== undefined);
  check('协议版本回显支持集内的客户端版本', init?.protocolVersion === '2025-03-26');

  const fallback = await negotiate('1999-01-01');
  check('不支持版本回己方支持版本（不回显任意输入）', fallback === '2025-06-18');

  notify('notifications/initialized');

  const list = await call('tools/list');
  const tool = list?.tools?.find((t) => t.name === 'hello_ping');
  check('tools/list 含 hello_ping', tool !== undefined);
  check('hello_ping 带 inputSchema', tool?.inputSchema?.type === 'object');

  const res = await call('tools/call', { name: 'hello_ping', arguments: { text: 'agent-bridge' } });
  check('tools/call 回显文本', res?.content?.[0]?.text === 'pong: agent-bridge');

  const unknown = await call('tools/call', { name: 'nope' }).then(
    () => null,
    (e) => String(e),
  );
  check('未知工具返回 JSON-RPC error', typeof unknown === 'string' && unknown.includes('unknown tool'));
} catch (err) {
  check(`链路异常：${String(err)}`, false);
} finally {
  child.kill();
}

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed} PASS / ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
