import {test} from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {editorSessionFlags} from './editor-smoke-lib.mjs';
import {probeOptions,profileOwners,ProbeInput} from './weapon-assembly.mjs';
const head='a'.repeat(40);
test('本任务严格TLS headed参数不绕证书；旧调用默认保持',()=>{
 const flags=editorSessionFlags({cdpPort:9348,headed:true,appUrl:'https://example.test',ignoreCertificateErrors:false});
 assert.ok(!flags.includes('--ignore-certificate-errors'));assert.ok(!flags.some(f=>f.includes('headless')||f.includes('swiftshader')));
 assert.ok(editorSessionFlags({cdpPort:9348,headed:true,appUrl:'https://example.test'}).includes('--ignore-certificate-errors'));
 assert.throws(()=>probeOptions([]),/expected-head/);assert.throws(()=>probeOptions(['--expected-head',head,'--url','https://localhost:5198']),/MagicDNS/);
 assert.throws(()=>probeOptions(['--expected-head',head,'--hold-ms','90000']),/有界/);assert.throws(()=>probeOptions(['--expected-head',head,'--out','assets/evidence']),/证据/);
});
test('profile归属精确匹配，不混淆别的Chrome目录',()=>{
 const profile=path.resolve('.workbuddy/tmp/chrome-profile');
 assert.deepEqual(profileOwners([{ProcessId:1,CommandLine:`chrome --user-data-dir="${profile}"`},{ProcessId:2,CommandLine:`chrome --user-data-dir="${profile}-other"`}],profile).map(p=>p.ProcessId),[1]);
});
test('中途输入失败仍尝试释放持有按键与鼠标，不注入runtime',async()=>{
 const calls=[];let fail=true;const cdp={async send(method,params){calls.push({method,params});if(params.type==='mousePressed'&&fail){fail=false;throw new Error('input failure');}}};
 const input=new ProbeInput(cdp);await input.key('w',true);await assert.rejects(input.pointer({x:50,y:60},true),/input failure/);assert.deepEqual(await input.release(),[]);
 assert.equal(calls.at(-2).params.type,'keyUp');assert.equal(calls.at(-2).params.code,'KeyW');assert.equal(calls.at(-1).params.type,'mouseReleased');assert.ok(calls.every(c=>c.method.startsWith('Input.')));
});
