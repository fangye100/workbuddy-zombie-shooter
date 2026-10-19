import {it,expect} from 'vitest';
import type {SceneDocument} from '@aether/scene';
import {PLAYER_STATS} from '@aether/content';
import {RuntimeSession,loadLevelRuntime} from '../src/index';
const docs=import.meta.glob('../../../assets/scenes/sandbox/vfx-m2-*.scene.json',{eager:true,import:'default'});
it('authored M2 fixtures trigger real enemy simulation without strike hooks',()=>{
 for(const [path,value] of Object.entries(docs)){
  const doc=structuredClone(value) as SceneDocument,loaded=loadLevelRuntime(doc);expect(loaded.desc,path).toBeTruthy();
  const runtime=new RuntimeSession({desc:loaded.desc!,seed:1}),events=[];
  for(let i=0;i<300;i++){runtime.step();events.push(...runtime.enemyAttacks.drainEvents());}
  const impacts=events.filter(e=>e.type==='impact');expect(impacts.length,path).toBeGreaterThan(0);
  if(path.includes('acid-blocked')){expect(impacts.some(e=>e.effect.blocked),path).toBe(true);expect(events.some(e=>e.type==='phase'),path).toBe(false);}
  else if(path.includes('acid')){expect(events.some(e=>e.type==='phase' && e.effect.phase==='pool'),path).toBe(true);expect(events.some(e=>e.type==='end' && e.effect.phase==='pool'),path).toBe(true);}
  else if(path.includes('pounce')){const e=impacts.find(e=>e.effect.kind==='pounce')!.effect;const distance=Math.hypot(e.position[0]-e.to[0],e.position[2]-e.to[2]);expect(distance).toBeGreaterThan(PLAYER_STATS.capsuleRadius);expect(distance).toBeLessThan(e.radius+PLAYER_STATS.capsuleRadius);expect(e.finishTick).not.toBeNull();expect(e.surface?.normal).toEqual([0,1,0]);}
  else expect(impacts.some(e=>e.effect.kind===(path.includes('pounce')?'pounce':'explode')),path).toBe(true);
 }
});
