/** Focused headed UI-input acceptance. Uses the repository Chrome/CDP and server helpers.
 * No runtime.setInput/setFire, crowd stress loop or author-data writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ensureServer, launchEditorSession, makeArgParser, waitFor, sleep } from './editor-smoke-lib.mjs';
const { arg, has } = makeArgParser(process.argv);
if (!has('headed')) throw new Error('This acceptance probe requires --headed and a real GPU');
const root = path.resolve(import.meta.dirname, '../..');
const port = Number(arg('port', 5198)), cdpPort = Number(arg('cdp', 9444));
const floor = Number(arg('floor', 2));
if (![1,2,3].includes(floor)) throw new Error('--floor must be 1, 2 or 3');
const out = path.resolve(arg('out', '.workbuddy/tmp/animation-layer-dev/headed'));
fs.mkdirSync(out, { recursive: true });
if(fs.existsSync(path.join(out,'results.json')))throw new Error('Evidence already exists; choose a new --out to preserve the original run');
const report = { method: 'headed real GPU; CDP Input -> existing visible toolbar and gameplay keyboard/pointer handlers; read-only CPU production pose observations; no GPU readback',
  root, head: execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  branch: execFileSync('git',['branch','--show-current'],{cwd:root,encoding:'utf8'}).trim(),
  floor, assertions: [], rows: [], actionObservations: [], screenshots: [], source: {}, errors: [], exceptions: [] };
let session, ownedServer, url;
function check(name, ok, detail) {
  report.assertions.push({ name, ok:!!ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`);
}
function readUrl(url) {
  return new Promise((resolve,reject)=>{
    const lib=url.startsWith('https:')?https:http;
    const local=['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname);
    const req=lib.get(url,{rejectUnauthorized:!local,timeout:8000},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>res.statusCode===200?resolve(Buffer.concat(chunks)):reject(new Error(`HTTP ${res.statusCode}: ${url}`)));
    });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Source identity request timeout')));
  });
}
async function identity() {
  const info=JSON.parse((await readUrl(`${url}__fs/info?path=aether.project.json`)).toString('utf8'));
  check('served checkout is this exact workspace',path.resolve(info.abs).toLowerCase()===path.join(root,'aether.project.json').toLowerCase(),info);
  for(const file of ['apps/editor/src/services/runtime-scene-motion.ts','packages/render/src/skin.ts','packages/zombie-game/src/presentation/player-motion.ts',`assets/scenes/act1/floor-${floor}.scene.json`]) {
    const remote=await readUrl(`${url}__fs/file?path=${encodeURIComponent(file)}`),local=fs.readFileSync(path.join(root,file));
    const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
    report.source[file]={local:hash(local),served:hash(remote)};check(`served source bytes ${file}`,hash(remote)===hash(local),report.source[file]);
  }
}
const reader=`(async()=>{
  const { sampleAnimationPose }=await import(${JSON.stringify('/@fs/'+root.replaceAll('\\','/')+'/packages/render/src/index.ts')});
  const e=window.__editor,r=e.renderer,doc=r.getDocument(),id=doc.playerStart,o=r.state.objects[r.findObjectIndexByNodeId(id)],s=o.skinState;
  const rt=e.playCtl.session.runtime,player=rt?.player(),layer=s?.poseLayer,clip=s?.clips[s.clip],upper=layer&&s.clips[layer.clip];
  const locals=s?sampleAnimationPose(s):[],base=s?sampleAnimationPose({...s,poseLayer:undefined}):[];
  const legs=o.skeleton.jointNames.map((n,i)=>({name:n,index:i,node:o.skeleton.joints[i]})).filter(x=>/Hips|UpLeg|Leg|Foot|Toe/i.test(x.name||''));
  const legError=Math.max(0,...legs.flatMap(x=>['t','r','s'].flatMap(k=>locals[x.node][k].map((v,j)=>Math.abs(v-base[x.node][k][j])))));
  const q=o.quat,visualYaw=Math.atan2(1-2*(q[0]*q[0]+q[1]*q[1]),2*(q[0]*q[2]+q[3]*q[1]));
  return {state:e.playCtl.state,tick:rt?.tick??0,runId:rt?.runId??null,player:player?{x:player.x,z:player.z,yaw:player.yaw,hp:player.hp}:null,
    outcome:rt?.outcome??null,choosing:rt?.progress?.choosing??null,weaponEvents:rt?.weapons.events.map(e=>({...e}))??[],equippedId:rt?.weapons.equippedId??null,definitions:rt?.weapons.definitions.map(d=>d.id)??[],switching:rt?.weapons.switching??false,visualYaw,base:clip?{name:clip.name,time:s.time,duration:clip.duration}:null,
    upper:upper?{name:upper.name,time:layer.time,duration:upper.duration}:null,mask:layer?[...layer.nodes]:null,weight:layer?.binding.weight??null,
    layerDiagnostics:layer?[...layer.diagnostics]:[],motion:e.motions.summary(),ik:e.bodyIk.summary(),weapon:rt?.weapons.animation??null,
    magazine:rt?.weapons.state.magazine??null,legError,legs:legs.map(x=>({name:x.name,node:x.node,local:locals[x.node],matrix:Array.from(o.skinScratch.slice(x.index*16,x.index*16+16))})),
    upperPose:o.skeleton.jointNames.map((n,i)=>({name:n,index:i,node:o.skeleton.joints[i]})).filter(x=>/Spine|Arm|Hand|Head/i.test(x.name||'')).map(x=>({name:x.name,local:locals[x.node],matrix:Array.from(o.skinScratch.slice(x.index*16,x.index*16+16))})),
    ikRuntime:s.bodyIk?{nodes:structuredClone(s.bodyIk.nodes),setupDiagnostics:[...s.bodyIk.setupDiagnostics],enabled:s.bodyIk.binding.enabled,targets:structuredClone(s.bodyIk.targets),controlWeights:{...s.bodyIk.controlWeights},bindingWeight:s.bodyIk.binding.weight}:null,
    debug:e.animationDebug.snapshot(),authorDirty:e.viewportEdit.state().dirty,ledger:e.playCtl.ledger,
    authorSkin:{clip:s.clip,time:s.time,playing:s.playing,loop:s.loop,speed:s.speed,clips:s.clips.map(c=>c.name),hasLayer:!!s.poseLayer,hasIk:!!s.bodyIk}}
})()`;
const read=()=>session.cdp.eval(reader);
const statusReader=`(()=>{const e=window.__editor,rt=e.playCtl.session.runtime,p=rt?.player();return{state:e.playCtl.state,tick:rt?.tick??0,runId:rt?.runId??null,outcome:rt?.outcome??null,choosing:rt?.progress?.choosing??null,hp:p?.hp??null,weapon:rt?.weapons.animation??null,definitions:rt?.weapons.definitions.map(d=>d.id)??[],equippedId:rt?.weapons.equippedId??null,switching:rt?.weapons.switching??false,events:rt?.weapons.events.map(e=>({...e}))??[],focus:document.activeElement?.tagName,visibility:document.visibilityState}})()`;
// Observation is installed before the real key event. Local RAF state is test evidence only;
// it never changes gameplay, sampling clocks, author config or the debug source.
function observeAction(action) {
  return session.cdp.eval(`(async()=>{const started=performance.now(),samples=[];while(performance.now()-started<3000){await new Promise(resolve=>requestAnimationFrame(resolve));const status=${statusReader};samples.push(status);if(status.weapon?.action===${JSON.stringify(action)})return{ok:true,samples,row:await ${reader}};if(status.outcome!=='running'||status.choosing)return{ok:false,samples,row:await ${reader}};}return{ok:false,samples,row:await ${reader}}})()`).then(observation=>{report.actionObservations.push({action,...observation});return observation;},error=>{const observation={ok:false,error:String(error),samples:[],row:null};report.actionObservations.push({action,...observation});return observation;});
}
async function finishAction(action,pending,name) {
  const observation=await pending;
  if(observation.row)report.rows.push({name,...observation.row});
  check('actual keyboard observes '+action+' production phase',observation.ok&&observation.row?.weapon?.action===action,observation);
  return observation.row;
}
async function newRound(name,rectangle) {
  await key('a','KeyA',false);await key('j','KeyJ',false);await click('#btn-stop');await record(name+'-stopped');
  await click('#btn-play');check('visible UI starts fresh '+name,await waitFor(()=>session.cdp.eval('window.__editor.playCtl.state==="playing"&&window.__editor.motions.summary().pending===0&&window.__editor.bodyIk.summary().pending===0'),{timeout:30000,interval:100}));
  await session.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...rectangle});await ticks(2);return record(name+'-started');
}
async function record(name) {
  const row=await read();report.rows.push({name,...row});return row;
}
async function key(key,code,down=true) {
  const virtual=({Home:36,End:35,ArrowDown:40,Enter:13}[key])??(key.length===1?key.toUpperCase().charCodeAt(0):0);
  await session.cdp.send('Input.dispatchKeyEvent',{type:down?'keyDown':'keyUp',key,code,windowsVirtualKeyCode:virtual,nativeVirtualKeyCode:virtual});
}
async function click(selector,text=null) {
  const p=await session.cdp.eval(`(()=>{const a=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>!e.hidden&&e.getBoundingClientRect().width>0&&(${JSON.stringify(text)}===null||e.textContent.trim()===${JSON.stringify(text)}));if(!a)return null;const r=a.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  if(!p)throw new Error(`Visible control missing: ${selector} ${text}`);
  await session.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});
  await session.cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});
  await session.cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});
}
async function ticks(count=5) {
  const start=await session.cdp.eval('window.__editor.playCtl.tick');
  const advanced=await waitFor(()=>session.cdp.eval(`window.__editor.playCtl.tick>=${start+count}`),{timeout:8000,interval:30,label:'fixed ticks'});
  check('simulation advanced under actual UI input',advanced,{start,count});
}
async function shot(name) {
  const before=await session.cdp.eval(statusReader);
  const image=await session.cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(image.data,'base64'));
  report.screenshots.push({name,before,after:await session.cdp.eval(statusReader),boundary:'headed frame; character visibility/occlusion requires independent visual inspection'});
}
function gait(row) {
  check('base gait retained',/^walk(_[fblr])?$|^run$/.test(row.base?.name??''),{base:row.base,weapon:row.weapon});
  check('hips and legs remain base local pose',row.legError<1e-6,row.legError);
  const error=Math.abs(Math.atan2(Math.sin(row.visualYaw-row.player.yaw),Math.cos(row.visualYaw-row.player.yaw)));
  check('four-way clip and mesh share player aim heading',error<1e-4,{error,yaw:row.player.yaw,visual:row.visualYaw});
}
try {
  process.chdir(root);
  const serverInfo=await ensureServer(port,'apps/editor/vite.config.ts');ownedServer=serverInfo.server;url=serverInfo.url;report.server={url,ownedPid:ownedServer?.pid??null,cwd:root,keep:has('keep-server')};
  await identity();
  session=await launchEditorSession({chromePath:arg('chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),cdpPort,headed:true,appUrl:url,windowSize:'1600,1000'});
  session.chrome.unref(); // Preserve shared profile browser without keeping this Node probe alive.
  report.browser={targetId:session.targetId,spawnedPid:session.chrome.pid,cdpPort,url};
  await session.cdp.send('Page.navigate',{url:`${url}?scene=assets/scenes/act1/floor-${floor}.scene.json`});
  const loaded=await waitFor(()=>session.cdp.eval(`!!window.__editor&&window.__editor.renderer.pendingAssetCount===0&&window.__editor.renderer.getDocument()?.id===${JSON.stringify(JSON.parse(fs.readFileSync(path.join(root,`assets/scenes/act1/floor-${floor}.scene.json`),'utf8')).id)}`),{timeout:45000,interval:250,label:'scene assets'});
  check('actual scene is fully loaded',loaded);
  report.gpu=await session.cdp.eval('(()=>{const i=window.__editor.renderer.device.adapterInfo;return{secure:isSecureContext,adapter:{vendor:i.vendor,architecture:i.architecture,device:i.device,description:i.description}}})()');
  check('real secure WebGPU adapter',report.gpu.secure&&!/swiftshader|llvmpipe|software/i.test(JSON.stringify(report.gpu.adapter))&&!!report.gpu.adapter?.vendor,report.gpu);
  const author=await record('author-before-play');
  await click('#btn-play');
  check('visible Play button starts gameplay',await waitFor(()=>session.cdp.eval('window.__editor.playCtl.state==="playing"&&window.__editor.motions.summary().pending===0&&window.__editor.bodyIk.summary().pending===0'),{timeout:30000,interval:100,label:'Play motion assembly'}));
  const rectangle=await session.cdp.eval('(()=>{const r=document.getElementById("gpu").getBoundingClientRect();return{x:r.x+r.width*.85,y:r.y+r.height*.35}})()');
  await session.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...rectangle});await ticks(2);
  const assembled=await record('assembled-player');
  check('actual player region and IK are configured and resolved',assembled.mask?.length>0&&assembled.weight===1&&assembled.layerDiagnostics.length===0&&assembled.ikRuntime?.enabled&&assembled.ikRuntime.bindingWeight>0&&assembled.ikRuntime.setupDiagnostics.length===0&&Object.keys(assembled.ikRuntime.nodes).length>=4,{mask:assembled.mask,diagnostics:assembled.layerDiagnostics,ik:assembled.ikRuntime});
  // Short weapon phases first, before sequential screenshots or enemy damage accumulate.
  await key('a','KeyA');await ticks(3);const beforeFire=await read();
  const firePending=observeAction('fire');await key('j','KeyJ');
  const fire=await finishAction('fire',firePending,'UI-side-move-fire');gait(fire);
  check('accepted shot consumes ammunition',fire.magazine<beforeFire.magazine,{before:beforeFire.magazine,after:fire.magazine});
  check('upper shoot layer plays separately',fire.upper?.name==='shoot',fire.upper);await key('j','KeyJ',false);
  const reloadPending=observeAction('reload');await key('r','KeyR');await key('r','KeyR',false);
  const reload=await finishAction('reload',reloadPending,'UI-side-move-reload');gait(reload);
  check('upper reload layer follows authoritative phase',reload.upper?.name==='reload'&&Math.abs(reload.upper.time-reload.weapon.phase*reload.upper.duration)<1e-5,reload);
  const beforeSwitch=await record('UI-before-Digit2');
  check('real switch preconditions are available',beforeSwitch.outcome==='running'&&!beforeSwitch.choosing&&beforeSwitch.definitions.length>=2&&beforeSwitch.definitions[1]!==beforeSwitch.equippedId,beforeSwitch);
  const unequipPending=observeAction('unequip'),equipPending=observeAction('equip');
  await key('2','Digit2');await key('2','Digit2',false);
  const unequip=await finishAction('unequip',unequipPending,'UI-side-move-unequip');gait(unequip);
  check('missing unequip is explicit while ready/base remain',unequip.motion.nodes.some(n=>n.layer?.diagnostics.some(d=>d.startsWith('WEAPON_CLIP_MISSING'))),unequip.motion);
  const switchShot=shot('side-move-switch');
  const equip=await finishAction('equip',equipPending,'UI-side-move-equip');gait(equip);
  check('missing equip is explicit while ready/base remain',equip.motion.nodes.some(n=>n.layer?.diagnostics.some(d=>d.startsWith('WEAPON_CLIP_MISSING'))),equip.motion);
  await switchShot;
  await newRound('directions-round',rectangle);
  const directions=[];
  for(const [letter,code] of [['w','KeyW'],['s','KeyS'],['a','KeyA'],['d','KeyD']]) {
    const before=await read();await key(letter,code);await ticks(6);const row=await record('UI-move-'+letter);await key(letter,code,false);gait(row);
    check('real movement changes position',Math.hypot(row.player.x-before.player.x,row.player.z-before.player.z)>.01,{before:before.player,after:row.player});
    directions.push(row.base.name);await ticks(2);
  }
  check('four relative gait directions reachable',new Set(directions).size===4,directions);
  await shot('four-direction-movement');
  await newRound('debug-round',rectangle);await key('a','KeyA');await ticks(3);await shot('fresh-player-moving');
  // Hold movement while opening/freezing the real read-only panel. Focused controls do not issue new gameplay commands.
  await click('.animation-debug-toggle');await click('.animation-debug-body button','姿态管线');await sleep(180);
  const debugBefore=await record('debug-live');check('real debug exposes production base and region',!!debugBefore.debug?.snapshot?.layer,debugBefore.debug);
  const targets=await session.cdp.eval(`[...document.querySelector('select[aria-label="观察角色"]').options].map(o=>o.value)`);
  if(targets.length>1) {
    await click('select[aria-label="观察角色"]');await key('End','End');await key('End','End',false);await key('Enter','Enter');await key('Enter','Enter',false);await sleep(160);
    const other=await record('debug-other-selected');
    check('visible target picker changes only observed actor',other.tick>debugBefore.tick&&other.debug?.target&&JSON.stringify(other.debug.target)!==JSON.stringify(debugBefore.debug.target),{before:debugBefore.debug.target,after:other.debug?.target});
    await click('select[aria-label="观察角色"]');await key('Home','Home');await key('Home','Home',false);
    const selectedIndex=targets.indexOf('scene:'+debugBefore.debug.target.nodeId);
    check('original player remains available in actual target picker',selectedIndex>=0,targets);
    for(let i=0;i<selectedIndex;i++){await key('ArrowDown','ArrowDown');await key('ArrowDown','ArrowDown',false);}
    await key('Enter','Enter');await key('Enter','Enter',false);await sleep(160);
  }
  await click('.animation-debug-body button','冻结观察画面');const frozen=await read();await ticks(6);const afterFreeze=await record('debug-frozen');
  check('freeze changes only observer, production ticks continue',afterFreeze.tick>frozen.tick&&afterFreeze.debug.snapshot.tick===frozen.debug.snapshot.tick,{before:frozen.tick,after:afterFreeze.tick,display:afterFreeze.debug.snapshot.tick});
  await shot('debug-frozen');await key('a','KeyA',false);
  await click('#btn-pause');const paused=await record('UI-paused');await sleep(220);const pausedAgain=await read();
  check('pause freezes both animation clocks',paused.tick===pausedAgain.tick&&paused.base.time===pausedAgain.base.time&&paused.upper?.time===pausedAgain.upper?.time,{paused:paused.tick,after:pausedAgain.tick});
  await click('#btn-stop');const stopped=await record('UI-stopped');
  check('Stop restores author sampler and clears Play resources',JSON.stringify(stopped.authorSkin)===JSON.stringify(author.authorSkin)&&stopped.ledger.pending===0&&stopped.motion.nodes.length===0&&stopped.ik.nodes.length===0,{author:author.authorSkin,restored:stopped.authorSkin,ledger:stopped.ledger});
  check('author scene remains unmodified',stopped.authorDirty===author.authorDirty,stopped.authorDirty);
  await click('#btn-play');check('restart assembles a fresh Play',await waitFor(()=>session.cdp.eval('window.__editor.playCtl.state==="playing"&&window.__editor.motions.summary().pending===0'),{timeout:30000,interval:100}));
  const restart=await record('UI-restart');check('restart has new run identity',restart.runId!==debugBefore.runId,{before:debugBefore.runId,after:restart.runId});await click('#btn-stop');await shot('stopped');
} catch(error) {
  report.failure=String(error.stack??error);console.error(report.failure);process.exitCode=1;
  if(session){try{report.terminalStatus=await session.cdp.eval(statusReader);await record('failure-terminal');await shot('failure-terminal');}catch(e){report.terminalObservationError=String(e);}}
} finally {
  if(session) {
    try{report.finalStatus=await session.cdp.eval(statusReader);}catch(e){report.finalObservationError=String(e);}
    report.errors=[...session.cdp.consoleErrors];report.exceptions=[...session.cdp.exceptions];
    if(report.errors.length||report.exceptions.length)process.exitCode=1;
    try { for(const [letter,code] of [['w','KeyW'],['s','KeyS'],['a','KeyA'],['d','KeyD'],['j','KeyJ']])await key(letter,code,false); } catch {}
    if(!has('keep-tab')) { try { await session.cdp.send('Target.closeTarget',{targetId:session.targetId}); } catch {} }
    session.ws.close();
    // Do not kill the shared fixed-profile browser; remove only our own target.
  }
  if(ownedServer&&!has('keep-server'))ownedServer.kill();
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));
  console.log(`Evidence: ${path.join(out,'results.json')}`);
}
