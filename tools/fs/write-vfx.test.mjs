import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeVfxWithMeta} from './write-vfx.mjs';
test('VFX writes update source digest and preserve sidecar author fields; mismatched identity cannot write',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'vfx-write-')),p=path.join(root,'a.vfx.json');
 try{await fs.writeFile(p,'{"id":"a"}\n');await fs.writeFile(`${p}.meta.json`,JSON.stringify({kind:'vfx',guid:'a',userData:{keep:42},sourceHash:'old'}));const out='{"id":"a","name":"new"}\n';await writeVfxWithMeta(p,out);
 const meta=JSON.parse(await fs.readFile(`${p}.meta.json`,'utf8'));assert.equal(meta.userData.keep,42);assert.equal(meta.sourceHash,`sha256:${createHash('sha256').update(out).digest('hex')}`);
 await assert.rejects(writeVfxWithMeta(p,'{"id":"b"}'));assert.equal(await fs.readFile(p,'utf8'),out);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
