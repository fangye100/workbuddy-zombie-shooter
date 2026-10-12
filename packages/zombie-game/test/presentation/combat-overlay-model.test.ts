import {afterEach,describe,expect,it,vi} from 'vitest';
import type {RuntimeSession} from '@aether/zombie-game';
import type {WeaponModelView} from '../../src/presentation/weapon-model';
import {CombatOverlay} from '../../src/presentation/combat-overlay';
import {drawHeldWeapon,drawWeaponEffect} from '../../src/presentation/weapon-ink';
vi.mock('../../src/presentation/weapon-ink',()=>({drawHeldWeapon:vi.fn(),drawWeaponEffect:vi.fn()}));
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
describe('真实模型门控与同tick视觉起点',()=>{
 it('未注入/尚未有效时保留占位；有效模型隐藏；迟到历史效果不挪到新枪口',()=>{
  const canvas={hidden:false,width:0,height:0,setAttribute(){},getContext:()=>({setTransform(){},clearRect(){}}),getBoundingClientRect:()=>({width:100,height:100,left:0,top:0})};
  vi.stubGlobal('document',{createElement:()=>canvas,getElementById:()=>({append(){}})});vi.stubGlobal('window',{devicePixelRatio:1});
  const runtime={runId:1,tick:1,fixedStep:1/60,outcome:'running',weaponCombat:{effects:[],burning:[]},table:{capacity:0},danger:null,enemyAttacks:{effects:[]},combatEvents:[]} as unknown as RuntimeSession;
  const project=()=>({x:0,y:0,behind:false});new CombatOverlay(project).update(runtime);expect(drawHeldWeapon).toHaveBeenCalledOnce();
  const view:WeaponModelView={visible:false,weaponId:'pistol',frameStamp:1,muzzle:{position:[1,2,3],rotation:[0,0,0,1]},diagnostics:[]};
  const overlay=new CombatOverlay(project,()=>view);overlay.update(runtime);expect(drawHeldWeapon).toHaveBeenCalledTimes(2);
  view.visible=true;overlay.update(runtime);expect(drawHeldWeapon).toHaveBeenCalledTimes(2);
  const effect={id:7,weaponId:'pistol',kind:'shot',tick:0,from:[4,5,6],to:[9,9,9]} as unknown as RuntimeSession['weaponCombat']['effects'][number];runtime.weaponCombat.effects.push(effect);
  overlay.update(runtime);expect(vi.mocked(drawWeaponEffect).mock.lastCall![2].from).toEqual([1,2,3]);expect(effect.from).toEqual([4,5,6]);
  Object.assign(runtime,{tick:2});view.muzzle!.position=[10,20,30];overlay.update(runtime);expect(vi.mocked(drawWeaponEffect).mock.lastCall![2].from).toEqual([1,2,3]);
  overlay.update(null);overlay.update(runtime);expect(vi.mocked(drawWeaponEffect).mock.lastCall![2].from).toEqual([4,5,6]);
 });
});
