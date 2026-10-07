import { validAudioAssetInfo, type AssetRef, type AudioAssetInfo } from '@aether/scene';

const urls=import.meta.glob('../../../../assets/audio/**/*.wav',{eager:true,query:'?url',import:'default'}) as Record<string,string>;
const metas=import.meta.glob('../../../../assets/audio/**/*.wav.meta.json',{eager:true,import:'default'}) as Record<string,{guid:string;audio:AudioAssetInfo}>;
export interface AudioResource {url:string;info:AudioAssetInfo}
export function audioResource(ref:AssetRef):AudioResource {
  const key='../../../../'+ref.path,meta=metas[key+'.meta.json'],url=urls[key];
  if(!url || !meta || meta.guid!==ref.guid || !validAudioAssetInfo(meta.audio))throw new Error(`Audio AssetRef unavailable or mismatched: ${ref.path}`);
  return {url,info:meta.audio};
}
