import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeFractureWithMeta} from './write-fracture.mjs';
import {withProjectWriteLock} from './project-write.mjs';

test('fracture writes update source digest and preserve sidecar author fields; mismatched identity cannot write',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'fracture-write-')),p=path.join(root,'a.fracture.json');
 try{await fs.writeFile(p,'{"id":"a"}'+String.fromCharCode(10));await fs.writeFile(p+'.meta.json',JSON.stringify({kind:'fracture',guid:'a',userData:{keep:7},sourceHash:'old'}));const out='{"id":"a","name":"new"}'+String.fromCharCode(10);await writeFractureWithMeta(p,out);
 const meta=JSON.parse(await fs.readFile(p+'.meta.json','utf8'));assert.equal(meta.userData.keep,7);assert.equal(meta.kind,'fracture');assert.equal(meta.sourceHash,'sha256:'+createHash('sha256').update(out).digest('hex'));
 await assert.rejects(writeFractureWithMeta(p,'{"id":"b"}'));assert.equal(await fs.readFile(p,'utf8'),out);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('sidecar原子替换失败会回滚源文件，不留下半保存或丢作者字段',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'fracture-write-rollback-')),p=path.join(root,'a.fracture.json'),metaPath=p+'.meta.json';
 const source='{"id":"a","name":"before"}\n',meta=JSON.stringify({kind:'fracture',guid:'a',sourceHash:'before',userData:{keep:7}})+'\n';
 const rename=fs.rename;
 try{
  await fs.writeFile(p,source);await fs.writeFile(metaPath,meta);
  fs.rename=async(from,to)=>{if(to===metaPath)throw new Error('controlled sidecar replace failure');return rename(from,to);};
  await assert.rejects(withProjectWriteLock(root,()=>writeFractureWithMeta(p,'{"id":"a","name":"after"}\n')),/controlled sidecar/);
  assert.equal(await fs.readFile(p,'utf8'),source);assert.equal(await fs.readFile(metaPath,'utf8'),meta);
  assert.equal((await fs.readdir(root)).filter(x=>x.endsWith('.tmp')).length,0);
 }finally{
  fs.rename=rename;
  const absolute=await fs.realpath(root),parent=await fs.realpath(os.tmpdir());
  assert.ok(absolute.startsWith(parent+path.sep)&&path.basename(absolute).startsWith('fracture-write-rollback-'));
  await fs.rm(absolute,{recursive:true,force:true});
 }
});
