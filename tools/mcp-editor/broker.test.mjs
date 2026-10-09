import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { editorAgentPlugin } from './broker.mjs';

function fixture(t) {
  const ws = new EventEmitter(); ws.clients = new Set();
  const httpServer = new EventEmitter(); let middleware;
  editorAgentPlugin().configureServer({ws, httpServer, middlewares: {use: value => {middleware = value;}}});
  t.after(() => httpServer.emit('close'));
  function client(id, send = () => {}) {
    const peer = {send}; ws.clients.add(peer);
    ws.emit('aether:hello', {instanceId: id}, peer); return peer;
  }
  function request(name, args = {}, options = {}) {
    const req = Readable.from([JSON.stringify({name, arguments: args})]);
    Object.assign(req, {method:'POST',url:'/__editor/call',headers:options.headers ?? {},socket:{remoteAddress:options.address ?? '127.0.0.1'}});
    return new Promise((resolve, reject) => {
      const res = {statusCode:0,setHeader(){},end(body){resolve({status:this.statusCode,body:JSON.parse(body)});}};
      Promise.resolve(middleware(req,res,()=>reject(new Error('Unexpected next')))).catch(reject);
    });
  }
  return {ws,httpServer,client,request};
}

test('broker refuses remote/origin requests and malformed tool arguments', async t => {
  const f=fixture(t);
  for (const options of [{address:'100.124.237.93'},{headers:{origin:'https://other.example'}}]) {
    const r=await f.request('editor_instances',{},options); assert.equal(r.status,403); assert.equal(r.body.code,'LOCAL_ONLY');
  }
  const workflow=await f.request('editor_workflow');
  assert.equal(workflow.status,200);assert.equal(workflow.body.workflow.contractVersion,2);
  assert.equal((await f.request('editor_workflow',{instanceId:'unexpected'})).body.code,'INVALID_ARGUMENTS');
  assert.equal((await f.request('editor_workflow',{}, {headers:{origin:'https://other.example'}})).body.code,'LOCAL_ONLY');
  assert.equal((await f.request('scene_get',{})).body.code,'INVALID_ARGUMENTS');
  assert.equal((await f.request('scene_get',{instanceId:'missing',extra:true})).body.code,'INVALID_ARGUMENTS');
  assert.equal((await f.request('scene_get',{instanceId:'missing'})).body.code,'EDITOR_DISCONNECTED');
});

test('only the selected live client may answer and duplicate identities cannot hijack it', async t => {
  const f=fixture(t); let notify; const dispatched=new Promise(resolve=>{notify=resolve;});
  const selected=f.client('chosen',(_name,request)=>notify(request));
  const other=f.client('other'); f.ws.emit('aether:hello',{instanceId:'chosen'},other);
  const response=f.request('scene_get',{instanceId:'chosen'});
  const sent=await dispatched;
  f.ws.emit('aether:reply',{requestId:sent.requestId,result:{ok:false,wrong:true}},other);
  f.ws.emit('aether:reply',{requestId:sent.requestId,result:{ok:true,document:{name:'selected'}}},selected);
  assert.deepEqual((await response).body,{ok:true,document:{name:'selected'}});
  f.ws.clients.delete(selected);
  const instances=await f.request('editor_instances');
  assert.deepEqual(instances.body.instances.map(x=>x.instanceId),['other']);
});

test('timeout warns that a write may have executed rather than authorizing a blind retry', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t); let notify; const dispatched=new Promise(resolve=>{notify=resolve;});
  f.client('chosen',(_name,request)=>notify(request));
  const response=f.request('scene_save',{instanceId:'chosen',expectedRevision:'read-first'});
  const sent=await dispatched; t.mock.timers.tick(45000);
  const result=(await response).body;
  assert.equal(result.code,'TIMEOUT'); assert.equal(result.requestId,sent.requestId);
  assert.match(result.message,/may have run/);
});

test('server shutdown resolves pending requests and clears the timeout', async t => {
  const f=fixture(t); let notify; const dispatched=new Promise(resolve=>{notify=resolve;});
  f.client('chosen',(_name,request)=>notify(request));
  const response=f.request('scene_get',{instanceId:'chosen'});
  await dispatched; f.httpServer.emit('close');
  assert.equal((await response).body.code,'EDITOR_DISCONNECTED');
});
