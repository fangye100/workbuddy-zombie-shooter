import type {SceneDocument} from '@aether/scene';
import {readProjectFile,writeProjectFile} from '../asset-util';

/** A temporary working copy of an already registered identity, never a new project scene. */
export async function resolveVfxFixture(path:string,registeredId:string):Promise<string>{
  if(!/^\.workbuddy\/tmp\/vfx-m1\/[a-zA-Z0-9_-]+\.scene\.json$/.test(path))throw new Error('VFX 验收副本路径必须位于 .workbuddy/tmp/vfx-m1/');
  const r=await readProjectFile(path);if(!r.ok || (r.json as SceneDocument)?.id!==registeredId)throw new Error('验收副本必须保留已登记场景的身份');
  return path;
}
export async function createVfxFixture(doc:SceneDocument,currentUrl:string):Promise<string>{
  const path=`.workbuddy/tmp/vfx-m1/copy-${crypto.randomUUID()}.scene.json`;
  const written=await writeProjectFile(path,{content:JSON.stringify(doc,null,2)+'\n',baseHash:'missing'});
  if(!written.ok)throw new Error(written.error??'验收副本创建失败');
  const url=new URL(currentUrl);url.searchParams.set('vfxFixture',path);url.searchParams.delete('play');return url.href;
}
