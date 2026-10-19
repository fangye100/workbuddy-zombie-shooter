import { VFX_GRAPH_VERSION,validateVfxAsset, validVfxRef, type AssetMeta, type AssetRef, type VfxAsset,type VfxGraphAsset } from '@aether/scene';
import { fileUrl, readProjectFile } from '../asset-util';
import {compileVfxGraph} from '@aether/runtime';

export async function readVfxAsset(ref:AssetRef,{allowGraph=true,onDiagnostic=(message:string)=>console.info(message)}:{allowGraph?:boolean;onDiagnostic?:(message:string)=>void}={}):Promise<VfxAsset> {
  if(!validVfxRef(ref) || !ref.path.endsWith('.vfx.json'))throw new Error('VFX 引用需要 .vfx.json 和 GUID');
  const [source,sidecar]=await Promise.all([readProjectFile(ref.path),readProjectFile(`${ref.path}.meta.json`)]);
  if(!source.ok || !sidecar.ok)throw new Error(`VFX 读取失败：${ref.path}`);
  const errors=validateVfxAsset(source.json),meta=sidecar.json as AssetMeta;
  if(errors.length)throw new Error(errors.join('；'));
  const raw=source.json as VfxAsset;
  let asset=raw;
  if(Object.hasOwn(raw,'graph')){
    if(!allowGraph)throw new Error('此资源的图是唯一真源，请使用“VFX · 可视节点图”编辑；禁止保存派生effects');
    const result=compileVfxGraph(raw);if(!result.asset)throw new Error(result.diagnostics.join('；'));asset=result.asset;
    const graph=(raw as unknown as VfxGraphAsset).graph;if(graph.version<VFX_GRAPH_VERSION)onDiagnostic(`VFX图兼容读取 v${graph.version}→${VFX_GRAPH_VERSION}，磁盘仅在保存时升级：${ref.path}`);
  }
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
  if(ref.path.endsWith('.svg')){
    const url=URL.createObjectURL(blob),image=new Image();
    try{image.src=url;await image.decode();
      if(!image.naturalWidth || !image.naturalHeight || image.naturalWidth>4096 || image.naturalHeight>4096)throw new Error('VFX SVG 尺寸超限');
      const canvas=new OffscreenCanvas(image.naturalWidth,image.naturalHeight),context=canvas.getContext('2d');if(!context)throw new Error('无法栅格化 VFX SVG');context.drawImage(image,0,0);return canvas.transferToImageBitmap();
    }finally{URL.revokeObjectURL(url);}
  }
  return createImageBitmap(blob,{premultiplyAlpha:'none',colorSpaceConversion:'none'});
}
