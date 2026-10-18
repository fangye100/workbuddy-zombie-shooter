import {it,expect} from 'vitest';
import {validateAuthorNodes} from '@aether/runtime';
import type {SceneDocument} from '@aether/scene';
import {loadLevelRuntime,RuntimeSession} from '../src/index';
const docs=import.meta.glob('../../../assets/scenes/sandbox/vfx-m3-*.scene.json',{eager:true,import:'default'});
it('M3 fixtures are truly authorable and enter their existing simulation paths',()=>{
 for(const [path,data] of Object.entries(docs)){
  const doc=structuredClone(data) as SceneDocument;expect(validateAuthorNodes(doc),path).toBe(null);const load=loadLevelRuntime(doc);expect(load.desc,path).toBeTruthy();const r=new RuntimeSession({desc:load.desc!,seed:1});if(path.includes('flame') || path.includes('melee')){r.setAim(5,0);r.setFire(true);}
  const facts=[],enemy=[];for(let i=0;i<100;i++){r.step();facts.push(...r.weaponCombat.drainPresentationEvents());enemy.push(...r.enemyAttacks.drainEvents());}
  if(path.includes('flame'))expect(facts.some(f=>f.kind==='flame')).toBe(true);if(path.includes('melee'))expect(facts.some(f=>f.kind==='slash')).toBe(true);if(path.includes('charge'))expect(enemy.some(f=>f.type==='move' && f.effect.kind==='charge')).toBe(true);
 }
});
