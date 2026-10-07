import { describe,it,expect } from 'vitest';
import { WeaponSystem,WeaponCombat,RuntimeSession,RunProgress,loadLevelRuntime, type WeaponWorld, type WeaponActor } from '../src';
import { validWeaponArsenal,migrateToLatest,validateSceneDocument,type WeaponArsenal,type SceneDocument,type RunRulesComponent } from '@aether/scene';
import { rayCapsuleY } from '@aether/gameplay';
const files=import.meta.glob('../../../assets/weapons/*.json',{eager:true,import:'default'});
const scenes=import.meta.glob('../../../assets/scenes/act1/*.scene.json',{eager:true,import:'default'});
const arsenal=()=>structuredClone(files['../../../assets/weapons/prototype.weapons.json'] as WeaponArsenal);
const definition=(id:string)=>arsenal().definitions.find(w=>w.id===id)!;
function fixture(points:number[]=[3,5,7]) {
  const actors:WeaponActor[]=points.map((x,id)=>({id,generation:1,x,z:0,radius:.3,hp:500}));
  let wall=Infinity;
  const world:WeaponWorld={actors:()=>actors.filter(a=>a.hp>0),actor:id=>actors.find(a=>a.id===id && a.hp>0)??null,
    trace:(from,direction,range,ignore,radius=0)=>{
      let distance=direction[0]>0?Math.min(range,(wall-from[0])/direction[0]):range,target=null;
      for(const a of actors){if(a.hp<=0 || ignore.has(a.id))continue;const h=rayCapsuleY([from[0],from[1]+radius,from[2]],direction,a.x,a.z,a.radius+radius,2+2*radius);if(h!==null && h<distance){distance=h;target=a;}}
      return {actor:target,distance,point:[from[0]+direction[0]*distance,from[1]+direction[1]*distance,from[2]+direction[2]*distance]};
    },blocked:(a,b)=>Math.min(a[0],b[0])<=wall && Math.max(a[0],b[0])>=wall,
    damage:(id,n)=>{const a=actors[id]!,dealt=Math.min(a.hp,n);a.hp=Math.max(0,a.hp-n);return dealt;},
    displace:(id,from,n)=>{actors[id]!.x+=Math.sign(actors[id]!.x-from[0])*n;}
  };
  return {actors,world,wall:(x:number)=>wall=x};
}
describe('scene-owned weapon contract',()=>{
  it('accepts null resource placeholders, rejects duplicate IDs, missing grip/quaternion and unsafe asset refs',()=>{
    const a=arsenal();expect(validWeaponArsenal(a)).toBe(true);
    a.definitions[1]!.id='pistol';expect(validWeaponArsenal(a)).toBe(false);
    const b=arsenal();b.definitions[0]!.presentation.markers.primaryGrip.rotation=[0,0,0,0];expect(validWeaponArsenal(b)).toBe(false);
    const c=arsenal();c.definitions[0]!.presentation.model={path:'assets/../secret.glb',guid:'bad'};expect(validWeaponArsenal(c)).toBe(false);
  });
  it('migrates v12 pistol explicitly without altering its ammo or existing custom arsenal',()=>{
    const doc=structuredClone(scenes['../../../assets/scenes/act1/floor-1.scene.json'] as SceneDocument);doc.schemaVersion=12;
    const rules=doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules')! as RunRulesComponent;
    const keep=structuredClone(rules.arsenal);expect(migrateToLatest(doc).doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules')).toMatchObject({arsenal:keep});
    delete (rules as unknown as Record<string,unknown>).arsenal;
    const migrated=migrateToLatest(doc);expect(migrated.applied).toEqual(['unified-weapon-arsenal','scene-audio-cue-mapping']);
    const next=migrated.doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules')! as RunRulesComponent;
    expect(next.arsenal.definitions).toHaveLength(1);expect(next.arsenal.definitions[0]!.ammo.magazineSize).toBe(rules.weapon.magazineSize);
    expect(validateSceneDocument(migrated.doc).filter(d=>d.severity==='error')).toEqual([]);
    expect((rules as unknown as Record<string,unknown>).arsenal).toBeUndefined();
    rules.weapon.magazineSize=-1;expect(migrateToLatest(doc).diagnostics.some(d=>d.severity==='error')).toBe(true);
  });
});
describe('single equipment/ammo/timing owner',()=>{
  it('blocks double shots and firing while switching; retains each magazine on return',()=>{
    const w=new WeaponSystem(arsenal());expect(w.beginFire()).toBe(true);expect(w.beginFire()).toBe(false);
    expect(w.equip('shotgun')).toBe(true);expect(w.beginFire()).toBe(false);expect(w.equip('unknown')).toBe(false);
    w.advance(.4);expect(w.active.id).toBe('shotgun');expect(w.state.magazine).toBe(6);
    w.beginFire();w.equip('pistol');w.advance(.4);expect(w.state.magazine).toBe(17);
  });
  it('reloads finite magazines, reloads shells one at a time and allows loaded-shell interruption',()=>{
    const w=new WeaponSystem(arsenal());w.state.magazine=0;expect(w.reload()).toBe(true);expect(w.beginFire()).toBe(false);
    w.advance(1.59);expect(w.state.magazine).toBe(0);w.advance(.02);expect(w.state.magazine).toBe(18);expect(w.state.reserve).toBe(102);
    w.equip('shotgun');w.advance(.4);w.state.magazine=0;w.reload();w.advance(.55);
    expect(w.state.magazine).toBe(1);expect(w.reloadRemaining).toBe(.55);expect(w.beginFire()).toBe(true);expect(w.reloadRemaining).toBe(0);
    w.equip('chainsaw');w.advance(.4);expect(w.reload()).toBe(false);expect(w.beginFire()).toBe(true);
  });
  it('cancels reload on unequip, charges upgrades atomically and rejects invalid carry without mutation',()=>{
    const w=new WeaponSystem(arsenal());w.state.magazine=0;w.reload();w.equip('sniper');w.advance(.4);
    expect(w.states.get('pistol')!.magazine).toBe(0);
    expect(w.upgrade(()=>false)).toBe(false);expect(w.state.level).toBe(1);
    let charged=0;expect(w.upgrade(n=>{charged+=n;return true;})).toBe(true);expect(charged).toBe(15);expect(w.capacity).toBe(7);
    const good=w.snapshot(),bad=structuredClone(good);bad.states[0]!.magazine=999999;
    expect(w.restore(bad)).toBe(false);expect(w.snapshot()).toEqual(good);
    const other=new WeaponSystem(arsenal());expect(other.restore(good)).toBe(true);expect(other.snapshot()).toEqual(good);
  });
  it('fires animation hooks only for successful actions, emits reload stages, isolates observers and outputs grip/recoil',()=>{
    const w=new WeaponSystem(arsenal()),events:string[]=[];
    w.setAnimationHooks({onFire:p=>{events.push(p.event.action);p.markers.muzzle.position[0]=99;throw new Error('observer');},onReloadStage:p=>events.push(p.stage!)});
    w.beginFire();w.beginFire();w.advance(.1);
    expect(events).toEqual(['fire']);expect(w.poseIntent.recoil.translation[0]).toBeLessThan(0);expect(w.active.presentation.markers.muzzle.position[0]).toBe(.3);
    expect(w.hookErrors).toHaveLength(1);expect(w.state.magazine).toBe(17);
    w.state.magazine=0;w.reload();w.advance(1.6);expect(events.slice(1)).toEqual(['magazine-out','magazine-in','chamber']);
    expect(w.poseIntent.markers.primaryGrip.effector).toBe('right-hand');expect(w.poseIntent.markers.supportGrip.effector).toBe('left-hand');
  });
  it('rejects legacy carry atomically when its old magazine exceeds a custom single-weapon capacity',()=>{
    const doc=structuredClone(scenes['../../../assets/scenes/act1/floor-1.scene.json'] as SceneDocument);
    const rules=doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules')! as RunRulesComponent;
    rules.arsenal.definitions=[definition('pistol')];rules.arsenal.definitions[0]!.ammo.magazineSize=2;
    const p=new RunProgress(rules,7),before=p.snapshot(50),legacy={...before,magazine:18,scrap:99};delete legacy.weapons;
    expect(p.restore(legacy,100)).toBe(false);expect(p.snapshot(50)).toEqual(before);
    legacy.magazine=1;expect(p.restore(legacy,100)).toBe(true);expect(p.magazine).toBe(1);expect(p.scrap).toBe(99);
  });
});
describe('concrete ballistics and damage effects',()=>{
  it('hitscan stops at the nearest actor; piercing hits several but stops at walls',()=>{
    const f=fixture(),c=new WeaponCombat(7);
    c.fire(definition('pistol'),[0,1,0],[1,0,0],12,0,f.world);expect(f.actors.map(a=>a.hp)).toEqual([488,500,500]);
    f.wall(6);c.fire(definition('sniper'),[0,1,0],[1,0,0],70,1,f.world);expect(f.actors.map(a=>a.hp)).toEqual([418,430,500]);
    expect(c.effects.at(-1)!.to[0]).toBe(6);
  });
  it('pellets fan across the cone; melee cannot hit distant or behind actors',()=>{
    const f=fixture([3,5]),c=new WeaponCombat(7);c.fire(definition('shotgun'),[0,1,0],[1,0,0],8,0,f.world);
    expect(c.effects.filter(e=>e.kind==='pellet')).toHaveLength(7);expect(f.actors[0]!.hp).toBeLessThan(500);
    const g=fixture([1,-1,5]);c.fire(definition('chainsaw'),[0,1,0],[1,0,0],9,1,g.world);
    expect(g.actors.map(a=>a.hp)).toEqual([491,500,500]);expect(c.slow(0,1)).toBe(.75);expect(c.slow(0,2)).toBe(1);
  });
  it('flame applies finite DoT, respects walls and does not transfer statuses to reused slots',()=>{
    const f=fixture([3,5]),c=new WeaponCombat(7);f.wall(4);
    c.fire(definition('flame'),[0,1,0],[1,0,0],3,0,f.world);
    for(let t=1;t<=60;t++)c.step(t,1/30,f.world);
    expect(f.actors[0]!.hp).toBeCloseTo(485,5);expect(f.actors[1]!.hp).toBe(500);expect(c.burning).toHaveLength(0);
    c.fire(definition('flame'),[0,1,0],[1,0,0],3,61,f.world);f.actors[0]!.generation=2;const hp=f.actors[0]!.hp;
    c.step(62,1/30,f.world);expect(f.actors[0]!.hp).toBe(hp);
  });
  it('SMG uses its own cadence and projectile causes no instant damage, then explodes with LOS',()=>{
    const w=new WeaponSystem(arsenal());w.equip('smg');w.advance(.4);w.beginFire();w.advance(.09);expect(w.beginFire()).toBe(true);
    const f=fixture([4,6]),c=new WeaponCombat(7);f.wall(5.5);const launcher=definition('launcher');launcher.projectile.gravity=0;launcher.projectile.launchSpeedY=0;
    c.fire(launcher,[0,1,0],[1,0,0],42,0,f.world);expect(f.actors[0]!.hp).toBe(500);expect(c.pendingProjectiles).toBe(1);
    for(let t=1;t<=30;t++)c.step(t,1/30,f.world);
    expect(f.actors[0]!.hp).toBe(458);expect(f.actors[1]!.hp).toBe(500);expect(c.pendingProjectiles).toBe(0);
  });
  it('bounds the projectile pool explicitly and preserves seeded scatter determinism',()=>{
    const f=fixture([]),c=new WeaponCombat(7),w=definition('launcher');
    for(let i=0;i<64;i++)c.fire(w,[0,1,0],[1,0,0],42,i,f.world);
    expect(c.canFire(w)).toBe(false);expect(()=>c.fire(w,[0,1,0],[1,0,0],42,65,f.world)).toThrow(/capacity/);c.clear();expect(c.pendingProjectiles).toBe(0);
    const run=(seed:number)=>{const q=new WeaponCombat(seed);for(let i=0;i<5;i++)q.fire(definition('smg'),[0,1,0],[1,0,0],6,i,f.world);return q.effects.map(e=>e.to);};
    expect(run(7)).toEqual(run(7));expect(run(8)).not.toEqual(run(7));
  });
  it('uses authored launch lift and expires at lifetime or the first ground crossing',()=>{
    const f=fixture([]),c=new WeaponCombat(7),w=definition('launcher');
    w.projectile.gravity=0;w.projectile.launchSpeedY=2;w.projectile.lifetimeSec=.1;
    c.fire(w,[0,1,0],[1,0,0],42,0,f.world);c.step(1,.05,f.world);
    expect(c.effects.find(e=>e.kind==='projectile')!.position[1]).toBeCloseTo(1.1);
    c.step(2,.05,f.world);expect(c.pendingProjectiles).toBe(0);
    expect(c.effects.filter(e=>e.kind==='explosion')).toHaveLength(1);
    c.clear();w.projectile.gravity=100;w.projectile.launchSpeedY=0;w.projectile.lifetimeSec=3;
    c.fire(w,[0,.1,0],[1,0,0],42,3,f.world);c.step(4,.1,f.world);
    expect(c.pendingProjectiles).toBe(0);
    const hit=c.effects.find(e=>e.kind==='explosion')!;
    expect(hit.position[1]).toBe(.05);expect(hit.position[0]).toBeLessThan(.1);
  });
});
it('session shares one ammo owner, carries the whole arsenal across floors, resets effects and freezes on choices',()=>{
  const make=(floor:number)=>new RuntimeSession({desc:loadLevelRuntime(structuredClone(scenes[`../../../assets/scenes/act1/floor-${floor}.scene.json`] as SceneDocument)).desc!,seed:7});
  const s=make(1);expect(s.progress!.weapons).toBe(s.weapons);
  expect(s.equipWeapon('smg')).toBe(true);for(let i=0;i<13;i++)s.step();s.setFire(true);s.step();expect(s.weapons.state.magazine).toBe(31);
  s.progress!.scrap=100;expect(s.upgradeWeapon()).toBe(true);
  const carry=s.progress!.snapshot(s.player()!.hp),next=make(2);expect(next.restoreRun(carry)).toBe(true);expect(next.weapons.snapshot()).toEqual(s.weapons.snapshot());
  const p=new RunProgress(s.progress!.rules,7);const before=p.snapshot(50),bad={...carry,weapons:{...carry.weapons!,states:[]}};
  expect(p.restore(bad,100)).toBe(false);expect(p.snapshot(50)).toEqual(before);
  for(let i=0;i<s.progress!.rules.firstChoiceKills;i++)s.progress!.recordKill();const tick=s.tick,ammo=s.weapons.snapshot();
  s.step();expect(s.tick).toBe(tick);expect(s.weapons.snapshot()).toEqual(ammo);expect(s.equipWeapon('pistol')).toBe(false);
  s.reset();expect(s.weapons.active.id).toBe('pistol');expect(s.weaponCombat.effects).toHaveLength(0);expect(s.weapons.state.level).toBe(1);
});
