/** 刚性模型 socket：资产 final import-space 米制位置与 xyzw 单位四元数。 */
import type { AssetRef } from './document';
export interface SocketTransform { position: [number,number,number]; rotation: [number,number,number,number] }
export type ModelSockets = Record<string, SocketTransform>;
/** 名称引用不保存 GLB 数组下标。contact.position 为规整化 actor 米制偏移，随骨方向旋转。 */
export interface BoneSocket { bone: string; contact: SocketTransform }
/** 骨位置基准 + 规整化 actor 轴米制偏移；只跟平移，不继承骨方向。 */
export interface BonePositionSlot { bone: string; position: [number,number,number] }
export function validBonePositionSlot(v:unknown):v is BonePositionSlot {
  return record(v)&&typeof v.bone==='string'&&v.bone.trim().length>0&&v.bone.length<=256
    &&Array.isArray(v.position)&&v.position.length===3&&v.position.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=100);
}
export type BoneSockets = Record<string, BoneSocket>;
export interface ModelAttachment {
  id: string; model: AssetRef; parentSocket: string; childSocket: string;
  /** 按 key 覆盖子资产默认 socket；未列出的 key 继承 sidecar。 */
  sockets?: ModelSockets;
  offset: SocketTransform;
}
export const identitySocket = (): SocketTransform => ({ position:[0,0,0],rotation:[0,0,0,1] });
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const key=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z][\w-]{0,63}$/.test(v);
export function validSocketTransform(v:unknown):v is SocketTransform {
  if(!record(v))return false;
  return Array.isArray(v.position)&&v.position.length===3&&v.position.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=100)
    &&Array.isArray(v.rotation)&&v.rotation.length===4&&v.rotation.every(n=>typeof n==='number'&&Number.isFinite(n))&&Math.abs(Math.hypot(...v.rotation)-1)<.001;
}
export function validModelSockets(v:unknown):v is ModelSockets {
  return record(v)&&Object.keys(v).length<=32&&Object.entries(v).every(([k,s])=>key(k)&&validSocketTransform(s));
}
export function validBoneSockets(v:unknown):v is BoneSockets {
  return record(v)&&Object.keys(v).length<=16&&Object.entries(v).every(([k,s])=>key(k)&&record(s)&&typeof s.bone==='string'&&s.bone.trim().length>0&&s.bone.length<=256&&validSocketTransform(s.contact));
}
export function validModelAttachment(v:unknown):v is ModelAttachment {
  if(!record(v)||!key(v.id)||!key(v.parentSocket)||!key(v.childSocket)||!validSocketTransform(v.offset)||!record(v.model))return false;
  const ref=v.model;
  return typeof ref.path==='string'&&ref.path.startsWith('assets/')&&!ref.path.includes('\\')&&!ref.path.split('/').some(s=>!s||s==='.'||s==='..')
    &&typeof ref.guid==='string'&&!!ref.guid&&(v.sockets===undefined||validModelSockets(v.sockets));
}
/** 严格模型引用解析；缺 sidecar 的 legacy 伪 GUID 不用于正式装配。 */
export function validateModelAssetIdentity(ref:AssetRef,meta:{guid:string;kind:string}|null|undefined,exists=true):string[] {
  if(!exists)return [`E_MODEL_ASSET_MISSING: ${ref.path}`];
  if(!meta)return [`E_MODEL_META_MISSING: ${ref.path}`];
  if(meta.guid!==ref.guid)return [`E_MODEL_GUID: ${ref.path}`];
  if(meta.kind!=='gltf')return [`E_MODEL_ASSET_KIND: ${ref.path}`];
  return [];
}
/** 按 socket key 覆盖；null 显式禁用，undefined 继承，返回新对象不改资产默认。 */
export function resolveSocketDefaults<T>(defaults:Record<string,T>|null|undefined,override:Record<string,T>|null|undefined):Record<string,T>|null {
  return override===null||(override===undefined&&defaults===null)?null:structuredClone({...defaults,...override});
}
