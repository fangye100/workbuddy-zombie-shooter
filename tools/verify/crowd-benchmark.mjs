/** 当前 CrowdSolver 的有界 CPU 基准；不认证浏览器帧率或实体手机容量。 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';

const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'.workbuddy/tmp/crowd-benchmark');
mkdirSync(out,{recursive:true});
await build({entryPoints:[resolve(root,'packages/ai/src/index.ts')],bundle:true,platform:'node',format:'esm',outfile:resolve(out,'ai.mjs')});
const {FlowField,FlowFieldIntegrator,CrowdSolver}=await import(pathToFileURL(resolve(out,'ai.mjs')));
const params={separationWeight:1.2,maxNeighbors:8,wallPush:.02,jitter:.05,acceleration:8,dt:1/30,stuckWindowSeconds:.5,stuckProgressRatio:.15};
const percentile=(a,p)=>[...a].sort((x,y)=>x-y)[Math.min(a.length-1,Math.ceil(a.length*p)-1)];
const results=[];
for(const scenario of ['open','door','dense'])for(const n of [100,500,1000]) {
  const field=new FlowField({width:132,height:32,cellSize:.5,originX:0,originZ:-8});
  if(scenario==='door')for(let z=0;z<32;z++)if(z<12||z>19)field.setBlocked(66,z,true);
  field.bakeClearance(8);field.applyClearanceToCost(2,3);
  const integrator=new FlowFieldIntegrator(field),flowTimes=[];
  // 交替目标确保每次确实重建，不测缓存命中。
  for(let i=0;i<31;i++){integrator.setGoal(3+i%2,0);const t=performance.now();while(!integrator.step(field.cellCount)){}if(i)flowTimes.push(performance.now()-t);}
  const b={count:n,dodgeBias:new Int8Array(n),stuckTicks:new Uint16Array(n),stuck:new Uint8Array(n)};
  for(const name of ['posX','posZ','velX','velZ','radius','maxSpeed','speedScale','outX','outZ','stuckRefX','stuckRefZ'])b[name]=new Float32Array(n);
  for(let i=0;i<n;i++){
    b.radius[i]=i%3?.34:.4;b.maxSpeed[i]=3.2;b.speedScale[i]=1;b.dodgeBias[i]=i%2?1:-1;
    const cols=scenario==='dense'?25:60,spacing=scenario==='dense'?.32:.75;
    b.posX[i]=scenario==='dense'?35+i%cols*spacing:10+i%cols*spacing;
    b.posZ[i]=scenario==='dense'?-6+Math.floor(i/cols)*spacing:-6.5+Math.floor(i/cols)*spacing;
    b.stuckRefX[i]=b.posX[i];b.stuckRefZ[i]=b.posZ[i];
  }
  // door 从墙的右侧出发，避免初始样本就在墙格内。
  if(scenario==='door')for(let i=0;i<n;i++)b.posX[i]=35+i%35*.75;
  const solver=new CrowdSolver(0,-8,66,8,1,n),times=[];
  let peakBlockedCenters=0,peakOutOfBounds=0;
  for(let tick=0;tick<330;tick++){
    const t=performance.now();solver.solve(b,field,params);const elapsed=performance.now()-t;if(tick>=30)times.push(elapsed);
    let blocked=0,oob=0;
    for(let i=0;i<n;i++){
      b.velX[i]=b.outX[i];b.velZ[i]=b.outZ[i];b.posX[i]+=b.outX[i]*params.dt;b.posZ[i]+=b.outZ[i]*params.dt;
      if(!Number.isFinite(b.posX[i]+b.posZ[i]))throw Error('Nonfinite crowd position');
      const cell=field.cellIndexAtWorld(b.posX[i],b.posZ[i]);if(cell<0)oob++;else if(field.isBlocked(cell))blocked++;
    }
    peakBlockedCenters=Math.max(peakBlockedCenters,blocked);peakOutOfBounds=Math.max(peakOutOfBounds,oob);
  }
  // 质量计数独立于计时，O(n²) 仅在末帧执行一次，不污染 solve 指标。
  let overlappingPairs=0,maxPenetrationM=0,overlappingPairsOutsideGoal=0,maxPenetrationOutsideGoalM=0;
  const overlappingOutside=new Set();
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
    const penetration=b.radius[i]+b.radius[j]-Math.hypot(b.posX[i]-b.posX[j],b.posZ[i]-b.posZ[j]);
    if(penetration>.02){
      overlappingPairs++;maxPenetrationM=Math.max(maxPenetrationM,penetration);
      if(Math.hypot(b.posX[i]-3,b.posZ[i])>1.5&&Math.hypot(b.posX[j]-3,b.posZ[j])>1.5){
        overlappingPairsOutsideGoal++;maxPenetrationOutsideGoalM=Math.max(maxPenetrationOutsideGoalM,penetration);overlappingOutside.add(i);overlappingOutside.add(j);
      }
    }
  }
  results.push({scenario,n,flowP95Ms:percentile(flowTimes,.95),solveP50Ms:percentile(times,.5),solveP95Ms:percentile(times,.95),solveMaxMs:Math.max(...times),peakBlockedCenters,peakOutOfBounds,overlappingPairs,maxPenetrationM,overlappingPairsOutsideGoal,overlappingActorsOutsideGoal:overlappingOutside.size,maxPenetrationOutsideGoalM,stuckAtEnd:[...b.stuck].filter(Boolean).length});
}
const report={date:'2026-10-10',commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),node:process.version,cpu:cpus()[0]?.model,params,grid:{width:132,height:32,cellSize:.5},warmupTicks:30,measuredTicks:300,limitations:['仅 CPU AI 内核，不含完整游戏、渲染、动画或 Worker 传输','dense 是超密度压力条件；重叠不是不可达证明','当前 solver 无逐步硬碰撞修正；质量指标不等于整体游戏验收','单机单次测量；不能直接外推浏览器或手机'],results};
writeFileSync(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
