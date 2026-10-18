import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicWriteText } from './project-write.mjs';

/** Caller holds the shared project lock. Preserve all sidecar fields except the source digest. */
export async function writeVfxWithMeta(abs,text) {
  const source=JSON.parse(text),metaPath=`${abs}.meta.json`;
  const before=await fs.readFile(abs,'utf8'),meta=JSON.parse(await fs.readFile(metaPath,'utf8'));
  if(meta.kind!=='vfx' || meta.guid!==source.id)throw new Error('VFX sidecar GUID/kind 不匹配');
  const updated={...meta,sourceHash:`sha256:${createHash('sha256').update(text).digest('hex')}`};
  await atomicWriteText(abs,text);
  try{await atomicWriteText(metaPath,JSON.stringify(updated,null,2)+'\n');}
  catch(error){await atomicWriteText(abs,before);throw error;}
}
