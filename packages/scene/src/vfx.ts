import type { AssetRef, SceneDocument } from './document';

/** Independent asset version; scene weapon bindings already carry AssetRef. */
export const VFX_VERSION = 4;
export type VfxKind = 'muzzle' | 'trail' | 'impact' | 'sprite';
export interface VfxEffectDefinition {
  kind: VfxKind;
  texture: AssetRef & { guid: string };
  frames: number;
  duration: number;
  size: [number, number];
  color: string;
  blend: 'alpha' | 'additive';
  orientation?: 'camera' | 'surface';
  loop?: boolean;
  backend?: 'cpu' | 'gpu';
  emission?: {rate:number;maxParticles:number;speed:number;spreadDeg:number;acceleration?:[number,number,number]};
  sizeCurve?: Array<{t:number;value:number}>;
  colorCurve?: Array<{t:number;color:string}>;
  alphaCurve?: Array<{t:number;value:number}>;
}
export interface VfxAsset {
  version: number;
  id: string;
  name: string;
  status: 'accepted' | 'quarantined';
  effects: Record<string, VfxEffectDefinition>;
}
export function validVfxRef(value: unknown): value is AssetRef & {guid:string} {
  if (!value || typeof value !== 'object') return false;
  const r = value as AssetRef;
  return typeof r.guid === 'string' && !!r.guid && typeof r.path === 'string'
    && r.path.startsWith('assets/') && !/[\\?#]/.test(r.path) && r.path.split('/').every(s => !!s && s !== '.' && s !== '..');
}
export function validVfxCurve(value:unknown,kind:'size'|'color'|'alpha'):boolean {
  if(value===undefined)return true;if(!Array.isArray(value) || value.length<2 || value.length>8)return false;
  return value.every((p,i)=>p && typeof p.t==='number' && Number.isFinite(p.t) && p.t>=0 && p.t<=1 && (i===0?p.t===0:p.t>value[i-1].t) && (i!==value.length-1 || p.t===1) && (kind==='color'?typeof p.color==='string' && /^#[\da-f]{6}$/i.test(p.color):typeof p.value==='number' && Number.isFinite(p.value) && p.value>=0 && p.value<=(kind==='alpha'?1:8)));
}
export interface VfxEmitterComponent {kind:'VfxEmitter';enabled:boolean;resource:AssetRef & {guid:string};effectKey:string;seed:number;playing:boolean;direction:[number,number,number]}
export function validVfxEmitter(value:unknown):value is VfxEmitterComponent {
 if(!value || typeof value!=='object')return false;const c=value as VfxEmitterComponent;
 return c.kind==='VfxEmitter' && typeof c.enabled==='boolean' && typeof c.playing==='boolean' && validVfxRef(c.resource) && c.resource.path.endsWith('.vfx.json') && typeof c.effectKey==='string' && /^[a-z][a-z0-9-]{0,63}$/.test(c.effectKey) && Number.isInteger(c.seed) && c.seed>=0 && c.seed<=4294967295 && Array.isArray(c.direction) && c.direction.length===3 && c.direction.every(n=>Number.isFinite(n)) && Math.hypot(...c.direction)>.0001;
}
export function validateVfxAsset(value: unknown): string[] {
  if (!value || typeof value !== 'object') return ['VFX 资源必须是对象'];
  const a = value as VfxAsset, errors: string[] = [];
  if (![1,2,3,VFX_VERSION].includes(a.version)) errors.push(`不支持 VFX 版本 ${a.version}`);
  if (typeof a.id !== 'string' || !a.id || typeof a.name !== 'string' || !a.name.trim()) errors.push('VFX 缺少 id/name');
  if (!['accepted', 'quarantined'].includes(a.status)) errors.push('VFX 验收状态非法');
  if (!a.effects || typeof a.effects !== 'object' || Array.isArray(a.effects) || !Object.keys(a.effects).length || Object.keys(a.effects).length > 32) return [...errors, 'VFX effects 数量必须为 1–32'];
  const finite = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
  for (const [key, e] of Object.entries(a.effects)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(key) || !e || !(a.version===1?['muzzle','trail','impact']:['muzzle','trail','impact','sprite']).includes(e.kind)
      || !validVfxRef(e.texture) || !/\.(svg|png|webp)$/.test(e.texture.path)
      || !Number.isInteger(e.frames) || e.frames < 1 || e.frames > 16 || !finite(e.duration, .01, 5)
      || !Array.isArray(e.size) || e.size.length !== 2 || !e.size.every(n => finite(n, .001, 20))
      || typeof e.color !== 'string' || !/^#[\da-f]{6}$/i.test(e.color) || !['alpha', 'additive'].includes(e.blend)
      || e.orientation!==undefined && !['camera','surface'].includes(e.orientation) || e.loop!==undefined && typeof e.loop!=='boolean'
      || e.backend!==undefined && (a.version<4 || !['cpu','gpu'].includes(e.backend))
      || e.emission!==undefined && (!e.emission || !finite(e.emission.rate,.1,e.backend==='gpu'?2400:120) || !Number.isInteger(e.emission.maxParticles) || !finite(e.emission.maxParticles,1,e.backend==='gpu'?1024:128) || !finite(e.emission.speed,0,30) || !finite(e.emission.spreadDeg,0,180) || e.emission.acceleration!==undefined && (a.version<4 || !Array.isArray(e.emission.acceleration) || e.emission.acceleration.length!==3 || !e.emission.acceleration.every(n=>finite(n,-30,30))))
      || !validVfxCurve(e.sizeCurve,'size') || !validVfxCurve(e.colorCurve,'color') || !validVfxCurve(e.alphaCurve,'alpha')) errors.push(`VFX 效果 ${key} 参数非法`);
  }
  return errors;
}

/** Explicit asset migration; callers retain the raw disk object for CAS. */
export function migrateVfxAsset(value:unknown):VfxAsset {
  const errors=validateVfxAsset(value);if(errors.length)throw new Error(errors.join('；'));
  const next=structuredClone(value) as VfxAsset;next.version=VFX_VERSION;
  for(const e of Object.values(next.effects)){e.orientation??=e.kind==='impact'?'surface':'camera';e.loop??=false;e.backend??='cpu';}
  return next;
}

/** Explicit compatibility, never submit unsorted alpha to the additive compute path. */
export function gpuVfxReason(e:VfxEffectDefinition):string|null {
 if(e.kind!=='sprite' || e.blend!=='additive' || e.orientation==='surface' || !e.emission)return 'GPU模拟仅支持 camera/additive sprite 发射器，使用有界 CPU 兼容';
 return null;
}
export function cpuVfxCompatibility(e:VfxEffectDefinition):VfxEffectDefinition {
 const value=structuredClone(e);value.backend='cpu';if(value.emission){value.emission.rate=Math.min(120,value.emission.rate);value.emission.maxParticles=Math.min(128,value.emission.maxParticles);}return value;
}

export interface VfxBinding { resource:AssetRef & {guid:string}; effectKey:string; label?:string }
export interface VfxBindingsComponent { kind:'VfxBindings';enabled:boolean;bindings:Record<string,VfxBinding> }
/** Scene-wide opaque tags. Every duplicated enabled tag is excluded, never order-dependent. */
export function resolveVfxBindings(doc:SceneDocument):{bindings:Record<string,VfxBinding>;diagnostics:string[]} {
  const bindings:Record<string,VfxBinding>={},owners=new Map<string,string[]>(),diagnostics:string[]=[];
  for(const node of doc.nodes)for(const c of node.components)if(c.kind==='VfxBindings' && c.enabled)for(const [tag,b] of Object.entries(c.bindings)){
    const nodes=owners.get(tag)??[];nodes.push(node.id);owners.set(tag,nodes);bindings[tag]=b;
  }
  for(const [tag,nodes] of owners)if(nodes.length>1){delete bindings[tag];diagnostics.push(`VFX 标签冲突 ${tag}（节点 ${nodes.join('、')}），保留原表现`);}
  return {bindings,diagnostics};
}
export function validVfxBindings(value:unknown):value is VfxBindingsComponent {
  if(!value || typeof value!=='object')return false;const c=value as VfxBindingsComponent;
  return c.kind==='VfxBindings' && typeof c.enabled==='boolean' && !!c.bindings && typeof c.bindings==='object' && !Array.isArray(c.bindings) && Object.keys(c.bindings).length<=64 && Object.entries(c.bindings).every(([tag,b])=>/^[a-z][a-z0-9.-]{0,63}$/.test(tag) && !!b && validVfxRef(b.resource) && b.resource.path.endsWith('.vfx.json') && typeof b.effectKey==='string' && /^[a-z][a-z0-9-]{0,63}$/.test(b.effectKey) && (b.label===undefined || typeof b.label==='string'));
}
