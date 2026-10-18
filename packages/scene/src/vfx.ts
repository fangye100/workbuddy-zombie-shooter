import type { AssetRef, SceneDocument } from './document';

/** Independent asset version; scene weapon bindings already carry AssetRef. */
export const VFX_VERSION = 2;
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
export function validateVfxAsset(value: unknown): string[] {
  if (!value || typeof value !== 'object') return ['VFX 资源必须是对象'];
  const a = value as VfxAsset, errors: string[] = [];
  if (a.version !== 1 && a.version !== VFX_VERSION) errors.push(`不支持 VFX 版本 ${a.version}`);
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
      || e.orientation!==undefined && !['camera','surface'].includes(e.orientation) || e.loop!==undefined && typeof e.loop!=='boolean') errors.push(`VFX 效果 ${key} 参数非法`);
  }
  return errors;
}

/** Explicit asset migration; callers retain the raw disk object for CAS. */
export function migrateVfxAsset(value:unknown):VfxAsset {
  const errors=validateVfxAsset(value);if(errors.length)throw new Error(errors.join('；'));
  const next=structuredClone(value) as VfxAsset;next.version=VFX_VERSION;
  for(const e of Object.values(next.effects)){e.orientation??=e.kind==='impact'?'surface':'camera';e.loop??=false;}
  return next;
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
