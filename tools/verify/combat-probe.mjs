/** 战斗完整浏览器探针：正式关卡编成 + 可控白盒真实输入、波次及死亡/Stop生命周期。 */
import fs from 'node:fs';
import path from 'node:path';
import {sleep,waitFor,createRecorder,makeArgParser,readStartSceneExpectation} from './editor-smoke-lib.mjs';
import {runGameProbe,navigateProbeScene,playPaused,stopProbe} from './game-probe-lib.mjs';
import {GAME_PROBE_SCENE,readProbeScene,roomWaves,sameCounts} from './game-probe-oracles.mjs';

const {arg,has}=makeArgParser(process.argv);
const OUT_DIR=path.resolve(arg('out','.workbuddy/tmp'));
const {results,check,summary}=createRecorder();
const census=`(()=>{const s=window.__editor.playCtl.session.runtime;
  const npcs=s.view().filter(e=>e.kind==='npc'),counts={};for(const e of npcs)counts[e.characterId]=(counts[e.characterId]??0)+1;
  return {npc:s.countNpc(),counts,tick:s.tick,outcome:s.outcome,events:s.sessionEvents,player:s.player()};})()`;
async function screenshot(cdp,name){const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT_DIR,name+'.png'),Buffer.from(shot.data,'base64'));}

async function verifyFirstWave(cdp,scene,details,label){
  await playPaused(cdp);
  const actual=await cdp.eval(census),first=actual.events.find(e=>e.type==='wave-start');
  if(!first)throw new Error('首房没有wave-start事件');
  const waves=roomWaves(readProbeScene(scene),first.roomNodeId);
  check(label+'首波编成与场景/房间对应',waves.length>0&&first.wave===waves[0].wave&&actual.npc===waves[0].total&&sameCounts(actual.counts,waves[0].counts),JSON.stringify({room:first.roomNodeId,actual,expected:waves[0]}));
  details[label]={scene,room:first.roomNodeId,actual,waves};
  return {actual,room:first.roomNodeId,waves};
}

async function main(){
  const scene=arg('scene',readStartSceneExpectation().path);
  return runGameProbe({name:'combat',outDir:OUT_DIR,port:Number(arg('port',5100)),cdpPort:Number(arg('cdp',9343)),
    chromePath:arg('chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),headed:has('headed'),windowSize:arg('window-size','1600,1000'),url:arg('url',null),scene,results,check,summary},async({cdp,details,url})=>{
    // 先检验当前真实开发关卡，不能让白盒通过掩盖正式关卡根本打不开/刷错数量。
    await verifyFirstWave(cdp,scene,details,'正式场景');
    details.productionStop=await stopProbe(cdp,check);
    await navigateProbeScene(cdp,url,GAME_PROBE_SCENE);
    const first=await verifyFirstWave(cdp,GAME_PROBE_SCENE,details,'白盒');
    if(first.waves.length<2)throw new Error('战斗夹具必须有至少两波');

    // 目标来自白盒刷怪点。真实鼠标确定瞄准，J键负责开火，不用applyDamage代替击杀。
    const setup=await cdp.eval(`(()=>{const e=window.__editor,s=e.playCtl.session.runtime,p=s.player();
      const target=s.view().filter(n=>n.kind==='npc'&&n.characterId==='E-01').sort((a,b)=>Math.hypot(a.x-p.x,a.z-p.z)-Math.hypot(b.x-p.x,b.z-p.z))[0];if(!target)throw new Error('缺少E-01目标');

      return {target:{id:target.id,generation:target.generation,runId:target.runId},player:p.id,
        npc:s.countNpc(),events:s.combatEvents.length,ammo:s.weapons.state.magazine,tick:s.tick};})()`);
    await cdp.eval(`document.querySelector('#btn-pause').click()`);
    await cdp.eval(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const aim=await cdp.eval(`(()=>{const e=window.__editor,s=e.playCtl.session.runtime,t=s.view().find(n=>n.id===${setup.target.id}&&n.generation===${setup.target.generation}),point=e.renderer.worldToScreen([t.x,.9,t.z]);
      const ray=e.renderer.pointerRay(point.x,point.y),a=(.9-ray.o[1])/ray.d[1],error=Math.hypot(ray.o[0]+ray.d[0]*a-t.x,ray.o[2]+ray.d[2]*a-t.z);
      return {...point,error,canvas:document.elementFromPoint(point.x,point.y)?.id==='gpu'};})()`);
    check('真实指针瞄准点位于游戏画布',aim.canvas&&!aim.behind,JSON.stringify(aim));
    check('投影与实际瞄准射线往返一致',Number.isFinite(aim.error)&&aim.error<.001,JSON.stringify(aim));
    if(!aim.canvas||aim.behind||!Number.isFinite(aim.error)||aim.error>=.001)throw new Error('目标投影未落在可操作画布或射线失配');
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:aim.x,y:aim.y});
    await sleep(80);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'j',code:'KeyJ',windowsVirtualKeyCode:74});
    let kill;
    try {
      kill=await waitFor(async()=>{
        const sample=await cdp.eval(`(()=>{const e=window.__editor,s=e.playCtl.session.runtime,t=${JSON.stringify(setup.target)};
          const hit=s.combatEvents.slice(${setup.events}).find(ev=>ev.type==='kill'&&ev.slot===t.id&&ev.generation===t.generation&&ev.runId===t.runId&&ev.sourceSlot===${setup.player});
          if(hit){e.playCtl.pause();return {hit,npc:s.countNpc(),ammo:s.weapons.state.magazine,lastShot:s.lastShot,tick:s.tick,outcome:s.outcome};}
          const target=s.view().find(n=>n.id===t.id&&n.generation===t.generation&&n.runId===t.runId);
          if(!target)return null;const point=e.renderer.worldToScreen([target.x,.9,target.z]);
          return {aim:{...point,canvas:document.elementFromPoint(point.x,point.y)?.id==='gpu'}};})()`);
        if(sample?.hit)return sample;
        if(sample?.aim?.canvas&&!sample.aim.behind)await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:sample.aim.x,y:sample.aim.y});
        return null;
      },{timeout:10000,interval:60,label:'真实J键击杀指定身份目标'});
    } finally {await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'j',code:'KeyJ',windowsVirtualKeyCode:74});}
    check('J键造成指定NPC击杀、玩家来源与模拟减员',!!kill&&kill.hit.sourceSlot===setup.player&&kill.npc===setup.npc-1&&kill.outcome==='running',JSON.stringify(kill));
    check('开火实际消耗弹药并生成命中弹道',!!kill&&kill.ammo<setup.ammo&&kill.lastShot?.tick>setup.tick&&kill.lastShot.hit,JSON.stringify({setup,kill}));
    details.keyboard={setup,aim,kill,diagnostic:await cdp.eval(`(()=>{const c=window.__editor.playCtl,s=c.session.runtime;return {state:c.state,tick:s.tick,firing:s.firing,ammo:s.weapons.state.magazine,outcome:s.outcome,events:s.combatEvents,lastShot:s.lastShot,view:s.view()};})()`)};

    if(!kill)throw new Error('真实键盘未完成击杀，不能用注入清场掩盖');

    // API清场只验证后续波次；记录边界前后，60tick等待必须真实成立。
    const cleared=await cdp.eval(`(()=>{const e=window.__editor,s=e.playCtl.session.runtime;
      for(const n of s.view())if(n.kind==='npc')s.applyDamage(n.id,n.hp);
      return {npc:s.countNpc(),tick:s.tick};})()`);
    check('通过公开伤害入口清场后模拟存活确实为0',cleared.npc===0,JSON.stringify(cleared));
    const boundary=await cdp.eval(`(()=>{const c=window.__editor.playCtl,s=c.session.runtime,delay=Math.max(1,Math.round(2/s.fixedStep));
      const scheduledAt=s.tick;c.step();for(let i=0;i<delay-1;i++)c.step();
      const before={tick:s.tick,npc:s.countNpc(),events:s.sessionEvents.filter(e=>e.type==='wave-start'&&e.roomNodeId===${JSON.stringify(first.room)})};
      c.step();const counts={};for(const n of s.view())if(n.kind==='npc')counts[n.characterId]=(counts[n.characterId]??0)+1;
      return {scheduledAt,delay,before,after:{tick:s.tick,npc:s.countNpc(),counts,events:s.sessionEvents.filter(e=>e.type==='wave-start'&&e.roomNodeId===${JSON.stringify(first.room)})}};})()`);
    check('波次间隔边界前不提前投放',boundary.before.npc===0&&boundary.before.events.length===1&&boundary.before.tick===boundary.scheduledAt+boundary.delay,JSON.stringify(boundary));
    const second=boundary.after.events.find(e=>e.wave===first.waves[1].wave);
    check('边界到达投放同房下一波，数量与角色组成精确对应场景',!!second&&second.tick===boundary.scheduledAt+boundary.delay&&boundary.after.npc===first.waves[1].total&&sameCounts(boundary.after.counts,first.waves[1].counts),JSON.stringify(boundary));
    details.waveBoundary={cleared,...boundary};
    await screenshot(cdp,'combat-wave2');

    const frozen=await cdp.eval(`(()=>{const c=window.__editor.playCtl,s=c.session.runtime;
      s.applyDamage(s.playerEntityId,99999);const tick=s.tick;for(let i=0;i<30;i++)c.step();
      return {tick,after:s.tick,outcome:s.outcome,stillPlaying:c.isPlaying,gameOver:s.sessionEvents.filter(e=>e.type==='game-over')};})()`);
    check('玩家死亡产生唯一game-over且30次手动推进不再增tick',frozen.outcome==='game-over'&&frozen.after===frozen.tick&&frozen.gameOver.length===1,JSON.stringify(frozen));
    await cdp.eval(`window.__editor.playCtl.resume()`);await sleep(500);
    const afterFrames=await cdp.eval(`({tick:window.__editor.playCtl.tick,playing:window.__editor.playCtl.isPlaying,outcome:window.__editor.playCtl.session.runtime.outcome})`);
    check('正常帧同样冻结，失败后保持Play供玩家查看',frozen.stillPlaying&&afterFrames.playing&&afterFrames.tick===frozen.tick&&afterFrames.outcome==='game-over',JSON.stringify(afterFrames));
    details.death={frozen,afterFrames};await screenshot(cdp,'combat-game-over');
    details.stop=await stopProbe(cdp,check);
    check('无console error',cdp.consoleErrors.length===0,JSON.stringify(cdp.consoleErrors));
    check('无未捕获异常',cdp.exceptions.length===0,JSON.stringify(cdp.exceptions));
  });
}
main().then(code=>process.exit(code)).catch(error=>{console.error('战斗探针异常终止：',error.message);process.exit(1);});
