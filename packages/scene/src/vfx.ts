import type { AssetRef, SceneDocument } from './document';
import {validateVfxGraphAsset} from './vfx-graph';

/** Independent asset version; scene weapon bindings already carry AssetRef. */
export const VFX_VERSION = 9;
export type VfxKind = 'muzzle' | 'trail' | 'impact' | 'sprite' | 'ribbon' | 'decal';
export interface VfxDecalDefinition {depth:number;maxAngle:number;normalOffset:number}
export interface VfxDecalComponent {kind:'VfxDecal';enabled:boolean;resource:AssetRef & {guid:string};effectKey:string;playing:boolean;receivers:string[];layerMask:number;priority:number}
export function validVfxDecal(value:unknown):value is VfxDecalComponent {
 if(!value || typeof value!=='object')return false;const c=value as VfxDecalComponent;
 return c.kind==='VfxDecal' && typeof c.enabled==='boolean' && typeof c.playing==='boolean' && validVfxRef(c.resource) && c.resource.path.endsWith('.vfx.json') && typeof c.effectKey==='string' && /^[a-z][a-z0-9-]{0,63}$/.test(c.effectKey) && Array.isArray(c.receivers) && c.receivers.length>=1 && c.receivers.length<=16 && c.receivers.every(id=>typeof id==='string' && !!id) && new Set(c.receivers).size===c.receivers.length && Number.isInteger(c.layerMask) && c.layerMask>=1 && c.layerMask<=4294967295 && Number.isInteger(c.priority) && c.priority>=0 && c.priority<=3;
}
export interface VfxRibbonDefinition {maxPoints:number;minDistance:number;breakDistance:number;uvMetersPerTile:number}
export interface VfxMotion {points:[number,number,number][];seconds:number;loop:boolean}
/** Eye-space metres. Omitted means the original hard intersection, never an implicit default fade. */
export interface VfxSoftParticleDefinition {fadeDistance:number;bias:number}
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
  ribbon?:VfxRibbonDefinition;
  softParticle?:VfxSoftParticleDefinition;
  /** Bounded simulation-time curl and within-frame UV advection; CPU simulation + GPU raster. */
  flow?:{strength:number;speed:number};
  decal?:VfxDecalDefinition;
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
export interface VfxEmitterComponent {kind:'VfxEmitter';enabled:boolean;resource:AssetRef & {guid:string};effectKey:string;seed:number;playing:boolean;direction:[number,number,number];motion?:VfxMotion}
export function validVfxMotion(value:unknown):value is VfxMotion {
 if(!value || typeof value!=='object')return false;const m=value as VfxMotion;
 return Array.isArray(m.points) && m.points.length>=2 && m.points.length<=32 && m.points.every(p=>Array.isArray(p) && p.length===3 && p.every(v=>typeof v==='number' && Number.isFinite(v) && Math.abs(v)<=100)) && m.points.some(p=>Math.hypot(...p.map((v,i)=>v-m.points[0]![i]!))>1e-8) && typeof m.seconds==='number' && Number.isFinite(m.seconds) && m.seconds>=.1 && m.seconds<=120 && typeof m.loop==='boolean';
}
export function validVfxEmitter(value:unknown):value is VfxEmitterComponent {
 if(!value || typeof value!=='object')return false;const c=value as VfxEmitterComponent;
 return c.kind==='VfxEmitter' && typeof c.enabled==='boolean' && typeof c.playing==='boolean' && validVfxRef(c.resource) && c.resource.path.endsWith('.vfx.json') && typeof c.effectKey==='string' && /^[a-z][a-z0-9-]{0,63}$/.test(c.effectKey) && Number.isInteger(c.seed) && c.seed>=0 && c.seed<=4294967295 && Array.isArray(c.direction) && c.direction.length===3 && c.direction.every(n=>Number.isFinite(n)) && Math.hypot(...c.direction)>.0001 && (c.motion===undefined || validVfxMotion(c.motion));
}
export function validateVfxAsset(value: unknown): string[] {
  if (!value || typeof value !== 'object') return ['VFX 资源必须是对象'];
  if(Object.hasOwn(value,'graph'))return validateVfxGraphAsset(value);
  const a = value as VfxAsset, errors: string[] = [];
  if (![1,2,3,4,5,6,7,8,VFX_VERSION].includes(a.version)) errors.push(`不支持 VFX 版本 ${a.version}`);
  if (typeof a.id !== 'string' || !a.id || typeof a.name !== 'string' || !a.name.trim()) errors.push('VFX 缺少 id/name');
  if (!['accepted', 'quarantined'].includes(a.status)) errors.push('VFX 验收状态非法');
  if (!a.effects || typeof a.effects !== 'object' || Array.isArray(a.effects) || !Object.keys(a.effects).length || Object.keys(a.effects).length > 32) return [...errors, 'VFX effects 数量必须为 1–32'];
  const finite = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
  for (const [key, e] of Object.entries(a.effects)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(key) || !e || !(a.version===1?['muzzle','trail','impact']:a.version<5?['muzzle','trail','impact','sprite']:a.version<7?['muzzle','trail','impact','sprite','ribbon']:['muzzle','trail','impact','sprite','ribbon','decal']).includes(e.kind)
      || !validVfxRef(e.texture) || !/\.(svg|png|webp)$/.test(e.texture.path)
      || !Number.isInteger(e.frames) || e.frames < 1 || e.frames > 16 || !finite(e.duration, .01, 5)
      || !Array.isArray(e.size) || e.size.length !== 2 || !e.size.every(n => finite(n, .001, 20))
      || typeof e.color !== 'string' || !/^#[\da-f]{6}$/i.test(e.color) || !['alpha', 'additive'].includes(e.blend)
      || e.orientation!==undefined && !['camera','surface'].includes(e.orientation) || e.loop!==undefined && typeof e.loop!=='boolean'
      || e.backend!==undefined && (a.version<4 || !['cpu','gpu'].includes(e.backend))
      || e.kind==='ribbon' && (e.backend==='gpu' || e.orientation==='surface' || !e.ribbon || !Number.isInteger(e.ribbon.maxPoints) || !finite(e.ribbon.maxPoints,2,128) || !finite(e.ribbon.minDistance,.001,2) || !finite(e.ribbon.breakDistance,.01,20) || e.ribbon.breakDistance<=e.ribbon.minDistance || !finite(e.ribbon.uvMetersPerTile,.01,20) || e.frames!==1 || e.size[1]!==1 || e.emission!==undefined)
      || e.kind==='decal' && (a.version<7 || e.backend==='gpu' || e.orientation!=='surface' || e.frames!==1 || e.emission!==undefined || e.softParticle!==undefined || !e.decal || !finite(e.decal.depth,.01,20) || !finite(e.decal.maxAngle,1,89.9) || !finite(e.decal.normalOffset,.0001,.03))
      || e.decal!==undefined && (a.version<7 || e.kind!=='decal')
      || e.ribbon!==undefined && (a.version<5 || e.kind!=='ribbon')
      || e.softParticle!==undefined && (a.version<6 || !e.softParticle || !finite(e.softParticle.fadeDistance,.01,5) || !finite(e.softParticle.bias,0,1))
      || e.flow!==undefined && (a.version<9 || e.kind!=='sprite' || !e.flow || !finite(e.flow.strength,0,.6) || !finite(e.flow.speed,.1,8))
      || e.emission!==undefined && (!e.emission || !finite(e.emission.rate,.1,e.backend==='gpu'?2400:120) || !Number.isInteger(e.emission.maxParticles) || !finite(e.emission.maxParticles,1,e.backend==='gpu'?1024:128) || !finite(e.emission.speed,0,30) || !finite(e.emission.spreadDeg,0,180) || e.emission.acceleration!==undefined && (a.version<4 || !Array.isArray(e.emission.acceleration) || e.emission.acceleration.length!==3 || !e.emission.acceleration.every(n=>finite(n,-30,30))))
      || !validVfxCurve(e.sizeCurve,'size') || !validVfxCurve(e.colorCurve,'color') || !validVfxCurve(e.alphaCurve,'alpha')) errors.push(`VFX 效果 ${key} 参数非法`);
    if(e?.kind==='ribbon' && e.softParticle!==undefined)errors.push(`VFX 效果 ${key}: Ribbon 暂不支持 softParticle，不能忽略交界衰减参数`);
  }
  return errors;
}

/** Explicit asset migration; callers retain the raw disk object for CAS. */
export function migrateVfxAsset(value:unknown):VfxAsset {
  if(value && typeof value==='object' && Object.hasOwn(value,'graph'))throw new Error('VFX图必须通过图编译器读取；禁止把派生effects作为编辑真源');
  const errors=validateVfxAsset(value);if(errors.length)throw new Error(errors.join('；'));
  const next=structuredClone(value) as VfxAsset;next.version=VFX_VERSION;
  for(const e of Object.values(next.effects)){e.orientation??=e.kind==='impact'?'surface':'camera';e.loop??=false;e.backend??='cpu';}
  return next;
}

/** Explicit compatibility, never submit unsorted alpha to the additive compute path. */
export function gpuVfxReason(e:VfxEffectDefinition):string|null {
 if(e.flow)return 'GPU模拟暂不支持 flow 卷动，使用有界 CPU 模拟与 GPU 流动材质';
 if(e.softParticle)return 'GPU模拟暂不采样场景深度，softParticle 使用有界 CPU 兼容';
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
