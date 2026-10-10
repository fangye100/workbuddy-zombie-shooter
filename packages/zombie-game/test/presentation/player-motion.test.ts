import { describe, expect, it } from 'vitest';
import { playerMotionChoice, weaponHandGoals } from '../../src/presentation/player-motion';
import { WeaponSystem } from '@aether/runtime';
import { legacyWeaponArsenal } from '@aether/scene';
describe('player region presentation policy',()=>{
  const states={idle:{},walk:{},run:{},walk_r:{},shoot:{},reload:{},ready:{}};
  const input={states,defaultState:'idle',speed:3,locomotionState:'walk_r',runId:1};
  it.each(['fire','reload','equip','unequip'] as const)('keeps gait while %s has its own request and phase',action=>{
    const choice=playerMotionChoice({...input,weapon:{action,clip:`pistol-${action}`,fallback:'idle',phase:.4,startTick:6,weaponId:'pistol'}});
    expect(choice.base).toBe('walk_r');expect(choice.phase).toBe(.4);
    expect(choice.upper).toBe(action==='fire'?'shoot':action==='reload'?'reload':'ready');
    expect(choice.diagnostics.length).toBe(action==='equip'||action==='unequip'?1:0);
  });
  it('keeps ready pose at rest, does not animate held fire input, and never uses locomotion as an upper fallback',()=>{
    expect(playerMotionChoice({...input,weapon:null})).toMatchObject({base:'walk_r',upper:'ready',phase:null});
    expect(playerMotionChoice({...input,speed:0,weapon:null}).base).toBe('idle');
    const choice=playerMotionChoice({...input,states:{idle:{},walk:{}},weapon:{action:'equip',clip:'missing',fallback:'walk',phase:.5,startTick:1,weaponId:'pistol'}});
    expect(choice).toMatchObject({base:'walk',upper:null});expect(choice.diagnostics[0]).toContain('WEAPON_CLIP_MISSING');
  });
  it('maps actual weapon markers/recoil and switching to different world hand goals without mutating pose intent',()=>{
    const weapons=new WeaponSystem(legacyWeaponArsenal({magazineSize:5,reserveRounds:10,reloadSec:1}));
    const pose=weapons.poseIntent,before=structuredClone(pose),idle=weaponHandGoals(pose,[2,1,3],Math.PI/2);
    expect(idle.right).toEqual([2,1,3]);expect(idle.left[2]).toBeGreaterThan(idle.right[2]);
    const recoil=weaponHandGoals({...pose,recoil:{translation:[-.05,0,0],pitchDeg:10}},[2,1,3],0);expect(recoil.right[0]).toBeCloseTo(1.95);
    const lowered=weaponHandGoals({...pose,action:'unequip',phase:1},[2,1,3],0);expect(lowered.right[1]).toBeCloseTo(.75);
    expect(weaponHandGoals({...pose,action:'equip',phase:0},[2,1,3],0)).toEqual(lowered);
    expect(pose).toEqual(before);
  });
});
