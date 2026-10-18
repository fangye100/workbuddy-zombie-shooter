import { validateVfxAsset, validVfxRef, type AssetMeta, type AssetRef, type VfxAsset } from '@aether/scene';
import { fileUrl, readProjectFile } from '../asset-util';

export async function readVfxAsset(ref:AssetRef):Promise<VfxAsset> {
  if(!validVfxRef(ref) || !ref.path.endsWith('.vfx.json'))throw new Error('VFX 引用需要 .vfx.json 和 GUID');
  const [source,sidecar]=await Promise.all([readProjectFile(ref.path),readProjectFile(`${ref.path}.meta.json`)]);
  if(!source.ok || !sidecar.ok)throw new Error(`VFX 读取失败：${ref.path}`);
  const errors=validateVfxAsset(source.json),meta=sidecar.json as AssetMeta;
  if(errors.length)throw new Error(errors.join('；'));
  const asset=source.json as VfxAsset;
  if(asset.id!==ref.guid || meta.guid!==ref.guid || meta.kind!=='vfx')throw new Error(`VFX GUID 不匹配：${ref.path}`);
  if(asset.status!=='accepted' || meta.userData?.status==='quarantined')throw new Error(`VFX 资源被隔离：${ref.path}`);
  return asset;
}
export async function readVfxTexture(ref:AssetRef):Promise<ImageBitmap> {
  const meta=await readProjectFile(`${ref.path}.meta.json`);
  const m=meta.json as AssetMeta;
  if(!meta.ok || m.guid!==ref.guid || m.kind!=='texture' || m.userData?.status==='quarantined')throw new Error(`VFX 贴图身份/状态非法：${ref.path}`);
  const res=await fetch(fileUrl(ref.path));if(!res.ok)throw new Error(`VFX 贴图 HTTP ${res.status}`);
  const blob=await res.blob();
  // SVG needs explicit raster dimensions; embedded intrinsic width/height are authored in the source.
  return createImageBitmap(blob,{premultiplyAlpha:'none',colorSpaceConversion:'none'});
}
