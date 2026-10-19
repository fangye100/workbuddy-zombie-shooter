/** 对指定整合基线做CPU差分；不认证GPU/FPS，也不把JS耗时当成业务频率。 */
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const index=process.argv.indexOf('--base'),base=process.argv[index+1];
if(index<0||!base||base.startsWith('-'))throw new Error('需要 --base <已验证的合并基线commit>');
const sha=execFileSync('git',['rev-parse','--verify',`${base}^{commit}`],{encoding:'utf8'}).trim();
const dir=path.resolve('.workbuddy/tmp/object-pool-regression');mkdirSync(dir,{recursive:true});
const modules={character:'packages/gameplay/src/character.ts',decal:'packages/render/src/decal-instances.ts',weapon:'packages/runtime/src/weapon-combat.ts'};
const apis={};
for(const variant of ['base','current']){
  const exports=[];
  for(const [name,file] of Object.entries(modules)){
    const source=variant==='base'?execFileSync('git',['show',`${sha}:${file}`],{encoding:'utf8',maxBuffer:8*1024*1024}):readFileSync(file,'utf8');
    const target=path.join(dir,`${variant}-${name}.ts`);writeFileSync(target,source);exports.push(`export * from ${JSON.stringify(target.replaceAll('\\','/'))};`);
  }
  const output=path.join(dir,variant+'.mjs');
  await build({stdin:{contents:exports.join('\n'),resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:output,tsconfig:'tsconfig.check.json',logLevel:'error'});
  apis[variant]=await import(pathToFileURL(output).href+'?'+Date.now());
}
const mark={id:'m',pattern:'splatter',position:[1,0,2],rotation:[0,0,0,1],size:[1,2],color:'#aa2233',opacity:.8,seed:7,normalOffset:.001,priority:0};
function decals(api){
  const pool=new api.DecalPool(16),frames=[];
  for(let i=0;i<250;i++){
    pool.advance(pool.time+.1);pool.emit({receiver:'floor',mark:{...mark,id:'m'+i,seed:i},ttlSec:2,fadeSec:.8},0,i%2?'blood':'acid');
    if(i%7===0)pool.removeOldest('blood');if(i%11===0)pool.remove('floor','m'+(i-1));
    const snapshot=pool.snapshot();frames.push(snapshot);
    const d=pool.diagnostics();assert.equal(d.active,snapshot.count);assert.equal(d.active+d.free,16);assert.equal(d.allocatedSlots,16);
    if(i%53===0)pool.clear();
  }
  return frames;
}
function characters(api){
  const table=new api.CharacterTable(12),pool=new api.CharacterPool(table),frames=[];
  pool.prewarm(1,4);pool.prewarm(2,4);
  for(let cycle=0;cycle<20;cycle++){
    const ids=[];for(let i=0;i<12;i++){const slot=pool.acquire(i%2+1);if(slot>=0){ids.push(slot);table.health[slot]=100;table.cooldownUntil[slot]=5;}}
    frames.push({ids:[...ids],generation:Array.from(table.generation),alive:table.aliveCount,stats:pool.stats()});
    for(const slot of ids)pool.release(slot);
    frames.push({health:Array.from(table.health),cooldown:Array.from(table.cooldownUntil),alive:table.aliveCount,stats:pool.stats()});
  }
  return frames;
}
const definitions=JSON.parse(readFileSync('assets/weapons/prototype.weapons.json','utf8')).definitions;
function weapons(api){
  const combat=new api.WeaponCombat(7),frames=[];
  const world={actors:()=>[],actor:()=>null,blocked:()=>false,damage:()=>0,displace:()=>{},trace:(from,distance,range)=>({actor:null,distance:range,point:from.map((v,i)=>v+distance[i]*range)})};
  for(let tick=0;tick<300;tick++){
    if(tick%5===0){const w=structuredClone(definitions[Math.floor(tick/5)%definitions.length]);if(combat.canFire(w))combat.fire(w,[2,1,3],[1,0,0],10,tick,world);}
    combat.step(tick,1/30,world);frames.push(structuredClone({projectiles:combat.pendingProjectiles,effects:combat.effects,burning:combat.burning}));
    if(tick===150)combat.clear();
  }
  return frames;
}
const results={base:sha,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,scope:'CPU deterministic behavior; same data and seed; not a GPU benchmark',checks:[]};
for(const [name,run] of Object.entries({decals,characters,weapons})){
  const before=run(apis.base),after=run(apis.current);assert.deepEqual(after,before,name);
  results.checks.push({name,frames:after.length,identical:true,sha256:createHash('sha256').update(JSON.stringify(after)).digest('hex')});
}
const cpu=(api)=>{const pool=new api.DecalPool(512),input={receiver:'floor',mark:{...mark},ttlSec:2,fadeSec:.8};const start=performance.now();for(let n=0;n<20000;n++){input.mark.id='m'+n;pool.emit(input);if(n%512===511)pool.clear();}return performance.now()-start;};
cpu(apis.base);cpu(apis.current);results.decalCpu20kMs={base:[],current:[]};
for(let n=0;n<6;n++)for(const variant of n%2?['current','base']:['base','current'])results.decalCpu20kMs[variant].push(cpu(apis[variant]));
writeFileSync(path.join(dir,'result.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results,null,2));
