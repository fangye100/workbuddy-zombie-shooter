import {it,expect} from 'vitest';
import {WeaponCombat,type WeaponWorld} from '../src';
import type {WeaponArsenal} from '@aether/scene';
const raw=Object.values(import.meta.glob('../../../assets/weapons/prototype.weapons.json',{eager:true,import:'default'}))[0] as WeaponArsenal;
const weapon=()=>structuredClone(raw.definitions.find(w=>w.id==='launcher')!);
const world:WeaponWorld={actors:()=>[],actor:()=>null,damage:()=>0,displace:()=>{},blocked:()=>false,trace:(from,d,range)=>({actor:null,distance:range,point:[from[0]+d[0]*range,from[1]+d[1]*range,from[2]+d[2]*range]})};
it('定义复制失败原子拒绝，不泄漏租约或半发射特效，随后仍可正常发射',()=>{
  const c=new WeaponCombat(1),w=weapon(),before=c.projectilePoolStats();
  Object.assign(w,{uncloneable:()=>{}});
  expect(()=>c.fire(w,[0,1,0],[1,0,0],1,0,world)).toThrow();
  expect(c.effects).toEqual([]);expect(c.pendingProjectiles).toBe(0);expect(c.projectilePoolStats()).toEqual(before);
  c.fire(weapon(),[0,1,0],[1,0,0],1,1,world);expect(c.pendingProjectiles).toBe(1);c.clear();expect(c.projectilePoolStats().active).toBe(0);
});
it('私有投射物复用，保留每发定义快照/公开effect及向量引用，不污染历史观察',()=>{
  const c=new WeaponCombat(7),w=weapon();w.projectile.gravity=0;w.projectile.launchSpeedY=0;w.projectile.lifetimeSec=.1;
  c.fire(w,[0,1,0],[1,0,0],1,0,world);const effect=c.effects[0]!,from=effect.from,to=effect.to,copy=structuredClone(effect);
  w.projectile.lifetimeSec=10;c.step(1,.1,world);expect(c.pendingProjectiles).toBe(0);expect(c.projectilePoolStats()).toMatchObject({active:0,inactive:1,created:1});
  c.fire(w,[10,5,2],[0,0,1],1,2,world);expect(c.projectilePoolStats()).toMatchObject({active:1,created:1,reused:1});
  expect(effect.from).toBe(from);expect(effect.to).toBe(to);expect(effect.from).toEqual(copy.from);expect(effect.to).toEqual(copy.to);expect(c.effects.find(e=>e.kind==='projectile')).not.toBe(effect);
  c.clear();expect(c.pendingProjectiles).toBe(0);expect(c.effects).toEqual([]);expect(c.projectilePoolStats().active).toBe(0);
});
it('64发耗尽后无副作用；clear归还全部，再发射不重新创建wrapper',()=>{
  const c=new WeaponCombat(1),w=weapon();for(let i=0;i<64;i++)c.fire(w,[0,1,0],[1,0,0],1,i,world);
  const before=c.effects.length;expect(()=>c.fire(w,[0,1,0],[1,0,0],1,65,world)).toThrow('capacity');expect(c.effects).toHaveLength(before);
  c.clear();expect(c.projectilePoolStats()).toMatchObject({active:0,inactive:64,created:64});c.fire(w,[0,1,0],[1,0,0],1,66,world);expect(c.projectilePoolStats().created).toBe(64);
});
