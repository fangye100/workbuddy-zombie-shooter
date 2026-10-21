/** WU-05 headed 取证：真实武器受击 impactPulse / 燃烧 burnClock 与角色动态行未被碎片模式污染。 */
import fs from 'node:fs';
import path from 'node:path';
import {sleep,waitFor,createRecorder,makeArgParser} from './editor-smoke-lib.mjs';
import {runGameProbe,navigateProbeScene,playPaused} from './game-probe-lib.mjs';
import {GAME_PROBE_SCENE} from './game-probe-oracles.mjs';

const {arg,has}=makeArgParser(process.argv);
const OUT_DIR=path.resolve(arg('out','.workbuddy/tmp/wu05-hitburn'));
fs.mkdirSync(OUT_DIR,{recursive:true});
const {results,check,summary}=createRecorder();
async function shot(cdp,name){const s=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT_DIR,name+'.png'),Buffer.from(s.data,'base64'));}

/** 找到与目标 NPC 最近的动态实例行（角色行 bit0=1），返回关键字段。 */
const ROW_HELPER = `window.__wu05Row=(s,t)=>{
  let best=null;
  for(const b of window.__editor.renderer.dynamicBatches??[]){
    const n=Math.min(b.count,Math.floor(b.instances.length/20));
    for(let i=0;i<n;i++){
      const o=i*20,flags=b.instances[o+14];
      if((flags&1)===0)continue;
      const dx=b.instances[o]-t.x,dz=b.instances[o+2]-t.z;
      const d=Math.hypot(dx,dz);
      if(best===null||d<best.d)best={d,flags,blendZ:b.instances[o+18],blendW:b.instances[o+19],x:b.instances[o],z:b.instances[o+2]};
    }
  }
  return best;
};`;

async function main(){
  return runGameProbe({name:'wu05-hitburn',outDir:OUT_DIR,port:Number(arg('port',5100)),cdpPort:Number(arg('cdp',9345)),
    chromePath:arg('chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),headed:has('headed'),
    windowSize:arg('window-size','1600,1000'),url:arg('url',null),scene:arg('scene',GAME_PROBE_SCENE),results,check,summary},
  async({cdp,details,url})=>{
    const scenePath=arg('scene',GAME_PROBE_SCENE);
    await navigateProbeScene(cdp,url,scenePath);
    await playPaused(cdp);
    await cdp.eval(ROW_HELPER);
    // 先推进一帧，让角色动态批次真正写出实例行
    await cdp.eval('window.__editor.playCtl.step()');

    // 选 E-01 最近目标并暂停逐帧控制
    const setup=await cdp.eval(`(()=>{const e=window.__editor,s=e.playCtl.session.runtime,p=s.player();
      const t=s.view().filter(n=>n.kind==='npc'&&n.characterId==='E-01'&&n.alive).sort((a,b)=>Math.hypot(a.x-p.x,a.z-p.z)-Math.hypot(b.x-p.x,b.z-p.z))[0];
      if(!t)throw new Error('缺少 E-01 目标');
      const row=window.__wu05Row(s,t);
      return {target:{id:t.id,generation:t.generation,runId:t.runId,x:t.x,z:t.z},player:p.id,row};})()`);
    let initialRow=setup.row;
    for(let i=0;i<40&&initialRow===null;i++){
      await cdp.eval('window.__editor.playCtl.step()');
      initialRow=await cdp.eval(`(()=>{const s=window.__editor.playCtl.session.runtime;const t=s.view().find(n=>n.id===${setup.target.id}&&n.generation===${setup.target.generation});return t?window.__wu05Row(s,t):null;})()`);
      if(initialRow===null) await sleep(30);
    }
    check('目标有角色动态行且 bit0=1/bit1=0',!!initialRow&&(initialRow.flags&1)===1&&(initialRow.flags&2)===0,JSON.stringify({initialRow}));

    // 选 pistol，暂停后逐帧瞄准射击（原生鼠标+J）
    await cdp.eval(`(()=>{const sel=document.querySelector('#center .weapon-select');sel.value='pistol';sel.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await cdp.eval(`document.querySelector('#btn-pause').click()`);
    await sleep(120);
    const aim=await cdp.eval(`(()=>{const e=window.__editor,s=e.playCtl.session.runtime,t=s.view().find(n=>n.id===${setup.target.id}&&n.generation===${setup.target.generation});
      const pt=e.renderer.worldToScreen([t.x,0.9,t.z]);return {...pt,canvas:document.elementFromPoint(pt.x,pt.y)?.id==='gpu'};})()`);
    check('瞄准点落在游戏画布',aim.canvas&&!aim.behind,JSON.stringify(aim));
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:aim.x,y:aim.y});
    await sleep(60);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'j',code:'KeyJ',windowsVirtualKeyCode:74});
    // 逐帧推进直到手枪命中（hitFlash 或 impactPulse 非零）
    let hitRow=null;
    try{
      hitRow=await waitFor(async()=>{
        const r=await cdp.eval(`(()=>{const c=window.__editor.playCtl,s=c.session.runtime;
          for(let i=0;i<3;i++)c.step();
          const t=s.view().find(n=>n.id===${setup.target.id}&&n.generation===${setup.target.generation});
          const row=t?window.__wu05Row(s,t):null;
          return {row,hitFlash:t?.hitFlash??0,alive:t?.alive,ammo:s.weapons.state.magazine};})()`);
        return (r.row&&r.row.blendZ>0)?r:null;
      },{timeout:6000,interval:60,label:'真实J键命中并出现受击脉冲'});
    } finally {await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'j',code:'KeyJ',windowsVirtualKeyCode:74});}
    check('真实命中使 impactPulse(blend.z) 非零',!!hitRow&&hitRow.row&&hitRow.row.blendZ>0,JSON.stringify(hitRow));
    await shot(cdp,'hit-frame');
    // 衰减：继续逐帧直到脉冲归零
    const decay=await waitFor(async()=>{
      const r=await cdp.eval(`(()=>{const c=window.__editor.playCtl,s=c.session.runtime;
        for(let i=0;i<4;i++)c.step();
        const t=s.view().find(n=>n.id===${setup.target.id}&&n.generation===${setup.target.generation});
        return t?window.__wu05Row(s,t):null;})()`);
      return r&&r.blendZ===0?r:null;
    },{timeout:6000,interval:60,label:'受击脉冲衰减归零'});
    check('impactPulse 在若干 tick 后归零',!!decay&&decay.blendZ===0,JSON.stringify(decay));
    details.hit={setup,aim,hitRow,decay};
    await shot(cdp,'hit-decayed');

    // 燃烧：切 flame，持续开火直到目标进入 burning
    // 原生数字键 6 = flame（HUD 标注 1–7 切换），再用运行时状态确认真的换上了
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'6',code:'Digit6',windowsVirtualKeyCode:54});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'6',code:'Digit6',windowsVirtualKeyCode:54});
    // 切枪有 switchSec（0.4s）：暂停下必须推进时间，等切换真正完成
    let equipped=null;
    for(let i=0;i<40;i++){
      await cdp.eval('window.__editor.playCtl.step()');
      equipped=await cdp.eval(`(()=>{const s=window.__editor.playCtl.session.runtime;return {id:s.weapons.equippedId,all:s.weapons.definitions.map(d=>d.id)};})()`);
      if(equipped.id==='flame')break;
      await sleep(30);
    }
    const equippedOld=await cdp.eval(`(()=>{const s=window.__editor.playCtl.session.runtime;return {id:s.weapons.equippedId,all:s.weapons.definitions.map(d=>d.id)};})()`);
    check('数字键 6 真实切到 flame',equipped.id==='flame',JSON.stringify(equipped));
    await sleep(120);
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:aim.x,y:aim.y});
    await sleep(60);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'j',code:'KeyJ',windowsVirtualKeyCode:74});
    const burn=await waitFor(async()=>{
      const r=await cdp.eval(`(()=>{const c=window.__editor.playCtl,s=c.session.runtime;
        for(let i=0;i<3;i++)c.step();
        const t=s.view().find(n=>n.id===${setup.target.id}&&n.generation===${setup.target.generation});
        const burning=(s.weaponCombat?.burning??[]).some(b=>b.id===${setup.target.id}&&b.generation===${setup.target.generation});
        const row=t?window.__wu05Row(s,t):null;
        return {burning,row,alive:t?.alive};})()`);
      return r.burning&&r.row&&r.row.blendW>0?r:null;
    },{timeout:8000,interval:60,label:'真实火焰点燃并出现 burnClock'});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'j',code:'KeyJ',windowsVirtualKeyCode:74});
    check('真实燃烧使 burnClock(blend.w) 非零',!!burn&&burn.row.blendW>0,JSON.stringify(burn));
    await shot(cdp,'burn-frame');
    details.burn=burn;
    await cdp.eval(`window.__editor.playCtl.resume()`);
    await sleep(300);
    const stillFractureFree=await cdp.eval(`(()=>({fragBatches:window.__editor.playCtl.fractureBatches.length,charRows:(window.__editor.renderer.dynamicBatches??[]).reduce((a,b)=>a+b.count,0)}))()`);
    check('本场景没有碎片批次混入角色行',stillFractureFree.fragBatches===0,JSON.stringify(stillFractureFree));
    check('无console error',cdp.consoleErrors.length===0,JSON.stringify(cdp.consoleErrors));
  });
}
main().then(()=>{summary([],[]);}).catch((e)=>{console.error('FATAL',e);process.exit(1);});
