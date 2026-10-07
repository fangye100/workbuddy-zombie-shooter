import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { editorAgentPlugin } from './broker.mjs';

test('actual stdio adapter discovers workflow through a loopback broker without a browser', { timeout:10000 }, async t => {
  let middleware;
  const ws = new EventEmitter(); ws.clients = new Set();
  const server = http.createServer((req,res) => { void middleware(req,res,() => {res.statusCode=404;res.end();}); });
  editorAgentPlugin().configureServer({ws,httpServer:server,middlewares:{use:fn=>{middleware=fn;}}});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => server.close());
  const child = spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url)),'--url',`http://localhost:${server.address().port}`],{stdio:['pipe','pipe','pipe']});
  t.after(() => child.kill());
  const waiting = new Map(); let sequence=0, stderr='';
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  createInterface({input:child.stdout}).on('line',line => {
    const value=JSON.parse(line); const callback=waiting.get(value.id); waiting.delete(value.id); callback?.resolve(value);
  });
  child.on('error',error => {for(const callback of waiting.values())callback.reject(error);});
  child.on('exit',code => {for(const callback of waiting.values())callback.reject(new Error(`Adapter exited ${code}: ${stderr}`));});
  const call=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++sequence;waiting.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  const init=await call('initialize',{protocolVersion:'2025-06-18'});
  assert.equal(init.result.serverInfo.version,'0.2.0'); assert.match(init.result.instructions,/editor_workflow/);
  const listed=await call('tools/list'); assert.equal(listed.result.tools.length,14);
  const workflow=await call('tools/call',{name:'editor_workflow',arguments:{}});
  assert.equal(workflow.result.isError,false); assert.equal(workflow.result.structuredContent.workflow.contractVersion,1);
  assert.equal((await call('tools/call',{name:'editor_instances',arguments:{}})).result.structuredContent.instances.length,0);
  const invalid=await call('tools/call',{name:'editor_workflow',arguments:{instanceId:'unexpected'}});
  assert.equal(invalid.result.isError,true); assert.equal(invalid.result.structuredContent.code,'INVALID_ARGUMENTS');
  const missing=await call('tools/call',{name:'editor_runtime',arguments:{instanceId:'missing'}});
  assert.equal(missing.result.structuredContent.code,'EDITOR_DISCONNECTED');
});
