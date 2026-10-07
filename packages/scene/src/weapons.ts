import type { AssetRef } from './document';

export type WeaponBehavior = 'hitscan' | 'pellets' | 'piercing' | 'projectile' | 'melee' | 'flame';
export type WeaponAction = 'idle' | 'fire' | 'reload' | 'equip' | 'unequip';
export interface WeaponMarker { position: [number,number,number]; rotation: [number,number,number,number]; effector: 'right-hand' | 'left-hand' | 'none' }
export interface WeaponDefinition {
  id: string; name: string; nameEn: string; description: string;
  behavior: WeaponBehavior;
  damage: number; cooldownSec: number; rangeM: number; spreadDeg: number; pellets: number; penetration: number;
  projectile: { speedMps: number; launchSpeedY: number; gravity: number; radiusM: number; lifetimeSec: number };
  effects: { blastRadiusM: number; burnDps: number; burnSec: number; slowFrac: number; slowSec: number; knockbackM: number };
  ammo: { magazineSize: number; reserveRounds: number; reloadSec: number; perShot: number; reloadMode: 'magazine' | 'shell' | 'none' };
  upgrades: { maxLevel: number; baseCost: number; costStep: number; damageStep: number; hasteStep: number; magazineStep: number };
  presentation: {
    model: AssetRef | null; placeholder: 'pistol' | 'shotgun' | 'smg' | 'sniper' | 'chainsaw' | 'flame' | 'launcher';
    color: string; lengthM: number;
    /** Metres, weapon-local Y-up/+X barrel axis; quaternion xyzw. Effectors are semantics, not rig bone names. */
    markers: Record<'primaryGrip' | 'supportGrip' | 'muzzle' | 'magazine' | 'chamber', WeaponMarker>;
    procedural: { recoilM: number; recoilPitchDeg: number; recoilSec: number; magazineOutPhase: number; magazineInPhase: number; chamberPhase: number };
    animations: Record<WeaponAction, { clip: string; fallback: string; resource: AssetRef | null }>;
    vfx: { muzzle: string; trail: string; impact: string; resource: AssetRef | null };
  };
}
export interface WeaponArsenal { equipped: string; switchSec: number; definitions: WeaponDefinition[] }
const id = (s: unknown): s is string => typeof s === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(s);
const num = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
const integer = (n: unknown, min: number, max: number): boolean => num(n,min,max) && Number.isInteger(n);
function resource(value: unknown): boolean {
  if(value===null)return true;
  if(!value || typeof value!=='object')return false;
  const r=value as AssetRef;
  return typeof r.path==='string' && r.path.startsWith('assets/') && !r.path.includes('\\') && !r.path.split('/').some(s=>!s || s==='.' || s==='..') && typeof r.guid==='string' && !!r.guid;
}
export function validWeaponDefinition(value: unknown): value is WeaponDefinition {
  if(!value || typeof value!=='object')return false;const w=value as WeaponDefinition;
  if(!id(w.id) || ![w.name,w.nameEn,w.description].every(s=>typeof s==='string') || !w.name.trim() || !w.nameEn.trim()
    || !['hitscan','pellets','piercing','projectile','melee','flame'].includes(w.behavior))return false;
  if(!num(w.damage,.001,100000) || !num(w.cooldownSec,.02,30) || !num(w.rangeM,.1,200) || !num(w.spreadDeg,0,180) || !integer(w.pellets,1,32) || !integer(w.penetration,1,32))return false;
  const p=w.projectile,e=w.effects,a=w.ammo,u=w.upgrades,v=w.presentation;
  if(!p || !num(p.speedMps,.1,300) || !num(p.launchSpeedY,-50,50) || !num(p.gravity,0,100) || !num(p.radiusM,0,2) || !num(p.lifetimeSec,.05,30))return false;
  if(!e || !num(e.blastRadiusM,0,30) || !num(e.burnDps,0,10000) || !num(e.burnSec,0,30) || !num(e.slowFrac,0,.95) || !num(e.slowSec,0,30) || !num(e.knockbackM,0,20))return false;
  if(!a || !['magazine','shell','none'].includes(a.reloadMode) || !integer(a.magazineSize,0,10000) || !integer(a.reserveRounds,0,10000000) || !integer(a.perShot,0,100) || !num(a.reloadSec,0,30))return false;
  if(a.reloadMode==='none' ? a.perShot!==0 : a.magazineSize<1 || a.perShot<1 || a.perShot>a.magazineSize || a.reloadSec<=0)return false;
  if(!u || !integer(u.maxLevel,1,20) || !integer(u.baseCost,1,100000) || !integer(u.costStep,0,100000) || !num(u.damageStep,0,5) || !num(u.hasteStep,0,2) || !integer(u.magazineStep,0,100))return false;
  if(!v || !resource(v.model) || !['pistol','shotgun','smg','sniper','chainsaw','flame','launcher'].includes(v.placeholder) || !/^#[\da-f]{6}$/i.test(v.color) || !num(v.lengthM,.05,3))return false;
  if(!v.markers || !(['primaryGrip','supportGrip','muzzle','magazine','chamber'] as const).every(k=>{const m=v.markers[k];return !!m && Array.isArray(m.position) && m.position.length===3 && m.position.every(n=>num(n,-3,3)) && Array.isArray(m.rotation) && m.rotation.length===4 && m.rotation.every(Number.isFinite) && Math.abs(Math.hypot(...m.rotation)-1)<.001 && ['right-hand','left-hand','none'].includes(m.effector);} ))return false;
  const proc=v.procedural;
  if(!proc || !num(proc.recoilM,0,.5) || !num(proc.recoilPitchDeg,0,60) || !num(proc.recoilSec,.02,3) || ![proc.magazineOutPhase,proc.magazineInPhase,proc.chamberPhase].every(n=>num(n,0,1)) || proc.magazineOutPhase>proc.magazineInPhase || proc.magazineInPhase>proc.chamberPhase)return false;
  if(!v.animations || !(['idle','fire','reload','equip','unequip'] as const).every(k=>{const a=v.animations[k];return !!a && typeof a.clip==='string' && !!a.clip && typeof a.fallback==='string' && !!a.fallback && resource(a.resource);} ))return false;
  return !!v.vfx && [v.vfx.muzzle,v.vfx.trail,v.vfx.impact].every(id) && resource(v.vfx.resource);
}
export function validWeaponArsenal(value: unknown): value is WeaponArsenal {
  if(!value || typeof value!=='object')return false;const a=value as WeaponArsenal;
  return num(a.switchSec,.05,5) && Array.isArray(a.definitions) && a.definitions.length>0 && a.definitions.length<=16
    && a.definitions.every(validWeaponDefinition) && new Set(a.definitions.map(w=>w.id)).size===a.definitions.length && a.definitions.some(w=>w.id===a.equipped);
}

/** Explicit v12 compatibility payload. Invalid legacy values remain invalid, never silently repaired. */
export function legacyWeaponArsenal(ammo: {magazineSize:number;reserveRounds:number;reloadSec:number}, ballistic={damage:12,cooldownSec:.35,rangeM:18}): WeaponArsenal {
  const animations=Object.fromEntries((['idle','fire','reload','equip','unequip'] as const).map(k=>[k,{clip:`pistol-${k}`,fallback:k==='fire'?'attack':'idle',resource:null}])) as WeaponDefinition['presentation']['animations'];
  return {equipped:'pistol',switchSec:.35,definitions:[{id:'pistol',name:'手枪',nameEn:'Pistol',description:'Legacy pistol compatibility',behavior:'hitscan',...ballistic,spreadDeg:0,pellets:1,penetration:1,
    projectile:{speedMps:30,launchSpeedY:0,gravity:0,radiusM:0,lifetimeSec:2},effects:{blastRadiusM:0,burnDps:0,burnSec:0,slowFrac:0,slowSec:0,knockbackM:0},
    ammo:{...ammo,perShot:1,reloadMode:'magazine'},upgrades:{maxLevel:5,baseCost:15,costStep:10,damageStep:.2,hasteStep:.08,magazineStep:2},
    presentation:{model:null,placeholder:'pistol',color:'#ffc531',lengthM:.3,markers:weaponMarkers(.3),procedural:{recoilM:.055,recoilPitchDeg:8,recoilSec:.2,magazineOutPhase:.2,magazineInPhase:.65,chamberPhase:.85},animations,vfx:{muzzle:'ink-flash',trail:'ink-tracer',impact:'ink-hit',resource:null}}}]};
}
export function weaponMarkers(lengthM:number): WeaponDefinition['presentation']['markers'] {
  const marker=(position:WeaponMarker['position'],effector:WeaponMarker['effector']='none'):WeaponMarker=>({position,rotation:[0,0,0,1],effector});
  return {primaryGrip:marker([0,0,0],'right-hand'),supportGrip:marker([lengthM*.4,0,0],'left-hand'),muzzle:marker([lengthM,0,0]),magazine:marker([lengthM*.12,-.1,0]),chamber:marker([lengthM*.3,.04,0])};
}
