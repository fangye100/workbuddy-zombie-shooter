import {it,expect} from 'vitest';
import type {SceneDocument} from '@aether/scene';
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
  else if(path.includes('pounce')){const e=impacts.find(e=>e.effect.kind==='pounce')!.effect;expect(e.position[0]).toBeCloseTo(0);expect(e.position[2]).toBeCloseTo(0);}
  else expect(impacts.some(e=>e.effect.kind===(path.includes('pounce')?'pounce':'explode')),path).toBe(true);
 }
});
