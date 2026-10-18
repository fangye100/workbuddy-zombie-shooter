/** 同输入的新旧 CPU 对照；不含渲染/动画，不外推 FPS 或手机容量。 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'.workbuddy/tmp/crowd-navigation');
mkdirSync(out,{recursive:true});
await build({stdin:{contents:"export * from './packages/ai/src/index'; export * from './packages/runtime/src/disc-collision'; export {defaultNavigationSettings} from './packages/scene/src/document';",resolveDir:root},bundle:true,platform:'node',format:'esm',outfile:resolve(out,'kernel.mjs')});
const {FlowField,FlowFieldIntegrator,CrowdSolver,PredictiveCrowdSolver,createAvoidanceBuffers,DiscCollisionWorld,defaultNavigationSettings}=await import(pathToFileURL(resolve(out,'kernel.mjs')));
const settings=defaultNavigationSettings(),dt=1/30,bounds={minX:0,minZ:-20,maxX:80,maxZ:20};
const legacyParams={separationWeight:1.2,maxNeighbors:8,wallPush:.02,jitter:.05,acceleration:8,dt,stuckWindowSeconds:.5,stuckProgressRatio:.15};
const percentile=(a,p)=>[...a].sort((x,y)=>x-y)[Math.min(a.length-1,Math.ceil(a.length*p)-1)];
const results=[];
const firstInvalid=[];
const sourceHashes=Object.fromEntries(['packages/ai/src/navigation.ts','packages/ai/src/crowd-avoidance.ts','packages/runtime/src/disc-collision.ts','tools/verify/crowd-navigation-benchmark.mjs'].map(p=>[p,createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex')]));
const flowField=new FlowField({width:160,height:80,cellSize:.5,originX:0,originZ:-20}),flow=new FlowFieldIntegrator(flowField),flowTimes=[];
let published=0,maxWork=0;
for(let i=0;i<1000;i++) {
  flow.setGoal(2+(i%50),0);
  const start=performance.now();if(flow.step(settings.flowCellBudget))published++;
  if(i>=30)flowTimes.push(performance.now()-start);maxWork=Math.max(maxWork,flow.workLastStep);
}
const flowBudget={cellCount:flowField.cellCount,budget:settings.flowCellBudget,movingGoalSteps:1000,published,maxWork,p50Ms:percentile(flowTimes,.5),p95Ms:percentile(flowTimes,.95),maxMs:Math.max(...flowTimes)};
for(const scenario of ['open','door-4m','dense'])for(const n of [100,500,1000])for(const algorithm of ['legacy','predictive']) {
  const field=new FlowField({width:160,height:80,cellSize:.5,originX:0,originZ:-20}),solids=[];
  if(scenario==='door-4m') {
    for(const z of [-11,11])solids.push({x:40,z,halfX:.25,halfZ:9,radius:0,shape:'box',enabled:true});
    for(let z=0;z<80;z++)if(z<36 || z>=44)field.setBlocked(80,z,true);
  }
  field.bakeClearance();field.applyClearanceToCost();
  const integrator=new FlowFieldIntegrator(field);integrator.setGoal(5,0);
  while(integrator.isPending)integrator.step(settings.flowCellBudget);
  const world=new DiscCollisionWorld(bounds,solids),b=createAvoidanceBuffers(n);
  b.count=n;
  const old={count:n,dodgeBias:new Int8Array(n),stuckTicks:new Uint16Array(n),stuck:new Uint8Array(n)};
  for(const name of ['posX','posZ','velX','velZ','radius','maxSpeed','speedScale','outX','outZ','stuckRefX','stuckRefZ'])old[name]=new Float32Array(n);
  for(let i=0;i<n;i++) {
    const dense=scenario==='dense',cols=dense?25:40,spacing=dense?.32:.8;
    b.x[i]=(scenario==='open'?10:43)+i%cols*spacing;b.z[i]=(dense?-6:-12)+Math.floor(i/cols)*spacing;
    b.radius[i]=i%3?.34:.4;b.maxSpeed[i]=3.2;b.movable[i]=1;b.ids[i]=i;b.generation[i]=1;b.maxY[i]=2;
    old.posX[i]=b.x[i];old.posZ[i]=b.z[i];old.radius[i]=b.radius[i];old.maxSpeed[i]=3.2;old.speedScale[i]=1;old.dodgeBias[i]=i%2?1:-1;
    old.stuckRefX[i]=b.x[i];old.stuckRefZ[i]=b.z[i];
  }
  const solver=algorithm==='legacy'?new CrowdSolver(0,-20,80,20,1,n):new PredictiveCrowdSolver(0,-20,80,20,1,n),sample={x:0,z:0,confidence:0},times=[];
  let peakInvalidPositions=0,peakInfeasible=0,progressTotal=0;
  const startDistance=Array.from(b.x,(x,i)=>Math.hypot(x-5,b.z[i]));
  for(let tick=0;tick<330;tick++) {
    const start=performance.now();
    if(algorithm==='legacy') {
      solver.solve(old,field,legacyParams);
      for(let i=0;i<n;i++){old.velX[i]=old.outX[i];old.velZ[i]=old.outZ[i];old.posX[i]+=old.velX[i]*dt;old.posZ[i]+=old.velZ[i]*dt;}
    } else {
      for(let i=0;i<n;i++) {
        const distance=Math.hypot(b.x[i]-5,b.z[i]),speed=Math.min(3.2,Math.max(0,(distance-1.2)/dt));
        const available=field.sampleFlow(b.x[i],b.z[i],sample);
        b.preferredX[i]=available?sample.x*speed:0;b.preferredZ[i]=available?sample.z*speed:0;
      }
      solver.solve(b,settings,dt,world);
      for(let i=0;i<n;i++){b.x[i]=b.nextX[i];b.z[i]=b.nextZ[i];b.vx[i]=b.outX[i];b.vz[i]=b.outZ[i];}
    }
    if(tick>=30)times.push(performance.now()-start);
    let invalid=0;
    for(let i=0;i<n;i++)if(!world.canOccupy(algorithm==='legacy'?old.posX[i]:b.x[i],algorithm==='legacy'?old.posZ[i]:b.z[i],b.radius[i])){invalid++;if(algorithm==='predictive' && firstInvalid.length<3)firstInvalid.push({scenario,n,tick,i,x:b.x[i],z:b.z[i],radius:b.radius[i]});}
    peakInvalidPositions=Math.max(peakInvalidPositions,invalid);
    if(algorithm==='predictive')peakInfeasible=Math.max(peakInfeasible,solver.snapshot().infeasibleVelocities);
  }
  const x=algorithm==='legacy'?old.posX:b.x,z=algorithm==='legacy'?old.posZ:b.z;
  let overlappingPairs=0,maxPenetrationM=0,reachedDoor=0;
  for(let i=0;i<n;i++) {
    if(!Number.isFinite(x[i]+z[i]))throw new Error('nonfinite position');
    progressTotal+=startDistance[i]-Math.hypot(x[i]-5,z[i]);if(x[i]<39)reachedDoor++;
    for(let j=i+1;j<n;j++) {
      const penetration=b.radius[i]+b.radius[j]-Math.hypot(x[i]-x[j],z[i]-z[j]);
      if(penetration>.02){overlappingPairs++;maxPenetrationM=Math.max(maxPenetrationM,penetration);}
    }
  }
  results.push({scenario,n,algorithm,totalP50Ms:percentile(times,.5),totalP95Ms:percentile(times,.95),totalMaxMs:Math.max(...times),peakInvalidPositions,overlappingPairs,maxPenetrationM,meanProgressM:progressTotal/n,passedDoor:scenario==='door-4m'?reachedDoor:null,peakInfeasible});
  console.log(JSON.stringify(results.at(-1)));
}
const report={sourceHashes,flowBudget,firstInvalid,date:'2026-10-10',baseCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),node:process.version,cpu:cpus()[0]?.model,settings,legacyParams,bounds,grid:{width:160,height:80,cellSize:.5},warmupTicks:30,measuredTicks:300,limitations:['同一输入位置/半径/目标/步长；新系统计时包含期望速度采样、连续静态碰撞、接触修正；流场重建单独测量','旧算法指向目标中心；新算法在1.2m接近环减速，这项属于策略改进，不是纯求解器算法归因','dense 初始严重穿透；有限迭代允许残余穿透，报告实际值','仅 Node CPU，未计渲染/动画/浏览器/其他业务；不能换算FPS','单机单次，含 GC/系统调度异常值'],results};
writeFileSync(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');
