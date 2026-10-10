/** 三维静态导航的 Node CPU 基准；初始化与稳态分开，不含渲染/动画。 */
import {build} from 'esbuild';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {cpus} from 'node:os';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'.workbuddy/tmp/surface-navigation');
mkdirSync(out,{recursive:true});
await build({entryPoints:[resolve(root,'packages/zombie-game/src/index.ts')],bundle:true,platform:'node',format:'esm',outfile:resolve(out,'game.mjs'),tsconfig:resolve(root,'tsconfig.check.json')});
const {loadLevelRuntime,RuntimeSession}=await import(pathToFileURL(resolve(out,'game.mjs')));
const source=JSON.parse(readFileSync(resolve(root,'assets/scenes/sandbox/navigation-3d-whitebox.scene.json'),'utf8'));
const results=[];
for(const count of [100,500]){
  const doc=structuredClone(source);
  // 有意密集的坡道入口压力夹具：保留真实场景地表，不声称全体可同时通过入口。
  for(const n of doc.nodes)for(const c of n.components){if(c.kind==='SpawnPoint')c.count=0;if(c.kind==='RoomVolume')c.clearRule='interact';}
  const loaded=loadLevelRuntime(doc);if(!loaded.desc)throw Error(JSON.stringify(loaded.diagnostics));
  const start=performance.now(),s=new RuntimeSession({desc:loaded.desc,capacity:count+1,seed:7});
  const initializeMs=performance.now()-start;
  s.table.health[s.playerEntityId]=s.table.maxHp[s.playerEntityId]=1e9;
  const spawned=s.debugSpawn('E-01',-3,2,count,1,0);if(spawned!==count)throw Error('spawn count');
  const times=[];let maxWork=0,maxOverlap=0;
  for(let k=0;k<330;k++){
    const before=performance.now();s.step();const elapsed=performance.now()-before;
    if(s.tick!==k+1)throw Error('压力夹具提前停止，禁止记录空步耗时');
    if(k>=30)times.push(elapsed);
    const snap=s.navigationSnapshot();maxWork=Math.max(maxWork,snap.flow.workLastStep);maxOverlap=Math.max(maxOverlap,snap.crowd.residualOverlapPairs);
    for(const e of s.view())if(!Number.isFinite(e.x+(e.y??0)+e.z))throw Error('nonfinite actor');
  }
  times.sort((a,b)=>a-b);results.push({count,initializeMs,p50Ms:times[Math.ceil(times.length*.5)-1],p95Ms:times[Math.ceil(times.length*.95)-1],maxMs:times.at(-1),maxWork,maxOverlap,final:s.navigationSnapshot()});
}
const paths=['packages/ai/src/surface-navigation.ts','packages/ai/src/crowd-avoidance.ts','packages/zombie-game/src/surface-crowd-navigation.ts','packages/zombie-game/src/session.ts','assets/scenes/sandbox/navigation-3d-whitebox.scene.json','tools/verify/surface-navigation-benchmark.mjs'];
const report={date:'2026-10-10',node:process.version,cpu:cpus()[0]?.model,warmup:30,measured:300,sourceHashes:Object.fromEntries(paths.map(p=>[p,createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex')])),limitations:['仅 Node CPU，包含游戏模拟；不含 GPU、动画、浏览器，不能换算 FPS','密集初始重叠和有限接触迭代会残留穿透；不认证全体通过或零碰撞','初始化含同步建图和首目标烘焙；运行预算仅限制图搜索工作项，不限制毫秒','单机单次，包含 GC 和系统调度异常值'],results};
writeFileSync(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(results.map(({final,...r})=>r),null,2));
