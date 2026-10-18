import {measureVfxCost} from './vfx-cost.mjs';
import {verifyM2Pixels,verifyImpactVisibility} from './vfx-m2-pixels.mjs';
export async function verifyM3Pixels(cdp,out){
 const position=await cdp.eval(`window.__editor.vfx.snapshot().play.continuous.sourceFrames.filter(f=>f.emitting).at(-1).muzzle`);
 const visible=await verifyImpactVisibility(cdp,out,position,'flame-visible'),composition=await verifyM2Pixels(cdp,out,{sourceIncludes:':flame:'});return {visible,composition,passed:visible.passed && composition.passed};
}
/** Verification inputs only: paused shared pool near its budget. Gameplay facts are unchanged. */
export async function measureM3Pressure(cdp){
 const pressure=await cdp.eval(`(()=>{
  const host=window.__editor.playCtl.vfx,pool=host.planner.pool,manager=new host.continuous.emitters.constructor(pool,32),effect={...host.continuous.bindings.get('weapon.flame'),duration:2,emission:{rate:120,maxParticles:128,speed:0,spreadDeg:0}},p=window.__editor.playCtl.session.runtime.player(),advance=[],emit=[],planner=[];pool.clear();
  for(let tick=0;tick<120;tick++){
   let start=performance.now();pool.advance(1/30);advance.push(performance.now()-start);start=performance.now();
   for(let i=0;i<4;i++)manager.update('verification-pressure:'+i,effect,{position:[p.x+(i%2)*1.2,1,p.z+Math.floor(i/2)*1.2],direction:[1,0,0]},tick,1/30,7+i,30);emit.push(performance.now()-start);
   start=performance.now();host.update(window.__editor.playCtl.session);planner.push(performance.now()-start);
  }
  const summarize=a=>({samples:a.length,mean:a.reduce((s,x)=>s+x,0)/a.length,p95:[...a].sort((a,b)=>a-b)[Math.floor(a.length*.95)]});
  return {active:pool.active.length,pool:{...pool.stats},emitter:{...manager.stats},cpu:{poolAdvanceMs:summarize(advance),emitterUpdateMs:summarize(emit),pausedPlannerMs:summarize(planner)},method:'120 fixed tick verification steps; 4 emitters x120/s, max128 each, lifetime2s, shared pool256; CPU wall-time intervals; real simulation paused'};
 })()`);
 const gpu=await measureVfxCost(cdp);return {...pressure,gpu};
}
