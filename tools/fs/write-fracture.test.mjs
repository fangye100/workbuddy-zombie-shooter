import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeFractureWithMeta} from './write-fracture.mjs';

test('fracture writes update source digest and preserve sidecar author fields; mismatched identity cannot write',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'fracture-write-')),p=path.join(root,'a.fracture.json');
 try{await fs.writeFile(p,'{"id":"a"}'+String.fromCharCode(10));await fs.writeFile(p+'.meta.json',JSON.stringify({kind:'fracture',guid:'a',userData:{keep:7},sourceHash:'old'}));const out='{"id":"a","name":"new"}'+String.fromCharCode(10);await writeFractureWithMeta(p,out);
 const meta=JSON.parse(await fs.readFile(p+'.meta.json','utf8'));assert.equal(meta.userData.keep,7);assert.equal(meta.kind,'fracture');assert.equal(meta.sourceHash,'sha256:'+createHash('sha256').update(out).digest('hex'));
 await assert.rejects(writeFractureWithMeta(p,'{"id":"b"}'));assert.equal(await fs.readFile(p,'utf8'),out);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
