import type { AssetRef } from './document';

/** Independent asset version; scene weapon bindings already carry AssetRef. */
export const VFX_VERSION = 1;
export type VfxKind = 'muzzle' | 'trail' | 'impact';
export interface VfxEffectDefinition {
  kind: VfxKind;
  texture: AssetRef;
  frames: number;
  duration: number;
  size: [number, number];
  color: string;
  blend: 'alpha' | 'additive';
}
export interface VfxAsset {
  version: number;
  id: string;
  name: string;
  status: 'accepted' | 'quarantined';
  effects: Record<string, VfxEffectDefinition>;
}
export function validVfxRef(value: unknown): value is AssetRef {
  if (!value || typeof value !== 'object') return false;
  const r = value as AssetRef;
  return typeof r.guid === 'string' && !!r.guid && typeof r.path === 'string'
    && r.path.startsWith('assets/') && !/[\\?#]/.test(r.path) && r.path.split('/').every(s => !!s && s !== '.' && s !== '..');
}
export function validateVfxAsset(value: unknown): string[] {
  if (!value || typeof value !== 'object') return ['VFX 资源必须是对象'];
  const a = value as VfxAsset, errors: string[] = [];
  if (a.version !== VFX_VERSION) errors.push(`不支持 VFX 版本 ${a.version}`);
  if (typeof a.id !== 'string' || !a.id || typeof a.name !== 'string' || !a.name.trim()) errors.push('VFX 缺少 id/name');
  if (!['accepted', 'quarantined'].includes(a.status)) errors.push('VFX 验收状态非法');
  if (!a.effects || typeof a.effects !== 'object' || Array.isArray(a.effects) || !Object.keys(a.effects).length || Object.keys(a.effects).length > 32) return [...errors, 'VFX effects 数量必须为 1–32'];
  const finite = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
  for (const [key, e] of Object.entries(a.effects)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(key) || !e || !['muzzle', 'trail', 'impact'].includes(e.kind)
      || !validVfxRef(e.texture) || !/\.(svg|png|webp)$/.test(e.texture.path)
      || !Number.isInteger(e.frames) || e.frames < 1 || e.frames > 16 || !finite(e.duration, .01, 5)
      || !Array.isArray(e.size) || e.size.length !== 2 || !e.size.every(n => finite(n, .001, 20))
      || typeof e.color !== 'string' || !/^#[\da-f]{6}$/i.test(e.color) || !['alpha', 'additive'].includes(e.blend)) errors.push(`VFX 效果 ${key} 参数非法`);
  }
  return errors;
}
