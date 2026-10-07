import { describe, it, expect } from 'vitest';
import { AudioFramePlanner, RuntimeSession, loadLevelRuntime, type EnemyAttackEffect } from '../src';
import type { SceneDocument, RunRulesComponent } from '@aether/scene';
const files = import.meta.glob('../../../assets/scenes/act1/*.scene.json', { eager:true, import:'default' });
function fixture() {
  const doc = structuredClone(files['../../../assets/scenes/act1/floor-1.scene.json'] as SceneDocument);
  const config = (doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules') as RunRulesComponent).audio!;
  const session = new RuntimeSession({desc:loadLevelRuntime(doc).desc!,seed:7});
  return {session,config,planner:new AudioFramePlanner()};
}
describe('audio presentation consumes gameplay facts',()=>{
  it('plays accepted shots once, never cooldown attempts, and does not change ammo or animation hooks',()=>{
    const {session:s,config,planner:p}=fixture();
    let hooks=0;s.weapons.setAnimationHooks({onFire:()=>{hooks++;}});
    p.update(s,config,false);s.setFire(true);s.step();
    const before=s.weapons.snapshot();
    expect(p.update(s,config,false).shots.filter(q=>q.key.startsWith('weapon:'))).toHaveLength(1);
    expect(p.update(s,config,false).shots).toHaveLength(0);
    expect(s.weapons.snapshot()).toEqual(before);expect(hooks).toBe(1);
    s.step();expect(p.update(s,config,false).shots.filter(q=>q.key.startsWith('weapon:'))).toHaveLength(0);
  });
  it('consumes paused events without replay and permits fresh events after a reset',()=>{
    const {session:s,config,planner:p}=fixture();s.setFire(true);s.step();
    expect(p.update(s,config,true)).toEqual({shots:[],loops:[]});
    expect(p.update(s,config,false).shots).toHaveLength(0);
    s.reset();s.setFire(true);s.step();
    expect(p.update(s,config,false).shots.filter(q=>q.key.startsWith('weapon:'))).toHaveLength(1);
  });
  it('runs the flame loop only while firing and stops it on release, pause, reload and outcome',()=>{
    const {session:s,config,planner:p}=fixture();s.equipWeapon('flame');for(let i=0;i<13;i++)s.step();
    s.setFire(true);s.step();expect(p.update(s,config,false).loops.map(q=>q.key)).toContain('held:flame');
    s.setFire(false);expect(p.update(s,config,false).loops.map(q=>q.key)).not.toContain('held:flame');
    s.setFire(true);expect(p.update(s,config,true).loops).toEqual([]);
    s.weapons.state.magazine=0;s.weapons.reload();s.step();expect(p.update(s,config,false).loops.map(q=>q.key)).not.toContain('held:flame');
    s.applyDamage(s.playerEntityId,10000);expect(s.outcome).toBe('game-over');expect(p.update(s,config,false).loops).toEqual([]);
  });
  it('plays pounce windup entry once and only within the authored warning distance',()=>{
    const {session:s,config,planner:p}=fixture();
    const slot=Array.from({length:s.table.capacity},(_,i)=>i).find(i=>s.table.isAlive(i) && s.table.defId[i]===1 && i!==s.playerEntityId)!;
    expect(slot).toBeDefined();const player=s.player()!;
    s.table.posX[slot]=player.x+2;s.table.posZ[slot]=player.z;s.table.behavior[slot]=2;
    expect(p.update(s,config,false).shots.filter(q=>q.binding.cue==='SFX-E02-POUNCE-WARN')).toHaveLength(1);
    expect(p.update(s,config,false).shots.filter(q=>q.binding.cue==='SFX-E02-POUNCE-WARN')).toHaveLength(0);
    s.table.behavior[slot]=1;p.update(s,config,false);s.table.behavior[slot]=2;s.table.posX[slot]=player.x+config.warningDistanceM+1;
    expect(p.update(s,config,false).shots.filter(q=>q.binding.cue==='SFX-E02-POUNCE-WARN')).toHaveLength(0);
  });
  it('keeps acid pools audible after shooter slot reuse, removes expired pools and ignores blocked shots',()=>{
    const {session:s,config,planner:p}=fixture();
    const effect:EnemyAttackEffect={kind:'acid',phase:'flight',source:1,generation:1,from:[4,1,0],to:[3,0,0],position:[4,1,0],startTick:0,duration:4,radius:1,damage:2,hit:false,blocked:false,finished:false,flightSeconds:1};
    s.enemyAttacks.effects.push(effect);
    expect(p.update(s,config,false).shots.filter(q=>q.binding.cue==='SFX-E03-ACID-LAUNCH')).toHaveLength(1);
    expect(p.update(s,config,false).shots).toHaveLength(0);
    effect.phase='pool';s.table.generation[1]=2;
    expect(p.update(s,config,false).loops.filter(q=>q.binding.cue==='SFX-E03-ACID-POOL')).toHaveLength(1);
    effect.blocked=true;expect(p.update(s,config,false).loops.filter(q=>q.binding.cue==='SFX-E03-ACID-POOL')).toHaveLength(0);
    s.enemyAttacks.effects.length=0;expect(p.update(s,config,false).loops.map(q=>q.key)).toEqual(['ambience']);
  });
  it('plays direct lethal flesh contacts but not unrelated player damage or burn ticks',()=>{
    const {session:s,config,planner:p}=fixture();const target=Array.from({length:s.table.capacity},(_,i)=>i).find(i=>s.table.isAlive(i) && s.table.defId[i]===1 && i!==s.playerEntityId)!;
    s.applyDamage(target,1,s.playerEntityId);expect(p.update(s,config,false).shots.filter(q=>q.binding.cue==='SFX-HIT-FLESH')).toHaveLength(0);
    const point:[number,number,number]=[s.table.posX[target]!,1,s.table.posZ[target]!];
    s.weaponCombat.effects.push({id:1,weaponId:'pistol',spreadDeg:0,kind:'shot',tick:s.tick,duration:.1,from:point,to:point,position:point,radius:0,hit:true,color:'#fff'});
    s.applyDamage(target,10000,s.playerEntityId);
    expect(s.combatEvents.some(e=>e.type==='kill' && e.slot===target)).toBe(true);
    expect(p.update(s,config,false).shots.filter(q=>q.binding.cue==='SFX-HIT-FLESH')).toHaveLength(1);
    s.reset();s.weaponCombat.effects.push({id:1,weaponId:'pistol',spreadDeg:0,kind:'shot',tick:s.tick,duration:.1,from:point,to:point,position:point,radius:0,hit:true,color:'#fff'});s.applyDamage(target,10000,s.playerEntityId);
    expect(p.update(s,config,false).shots.filter(q=>q.binding.cue==='SFX-HIT-FLESH')).toHaveLength(1);
  });
});
