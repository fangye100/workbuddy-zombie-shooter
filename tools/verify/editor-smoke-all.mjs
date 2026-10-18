/** 串行运行全部四个浏览器套件；参数逐套传递，profile绝不并发使用。 */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

export function smokePlan(argv,platform=process.platform) {
  const args=argv.filter(arg=>arg!=='--');
  if(platform==='win32'&&!args.includes('--headed'))throw new Error('本机GPU验收必须传 --headed');
  const out=args.indexOf('--out');
  if(out>=0&&(!args[out+1]||args[out+1].startsWith('--')))throw new Error('--out 缺少目录');
  const root=path.resolve(out>=0?args[out+1]:'.workbuddy/tmp/editor-smoke-all');
  if(out>=0)args.splice(out,2);
  const suites=['editor-smoke','editor-binding-smoke','combat-probe','dynamic-skin-probe'];
  return {root,suites:suites.map(name=>({name,script:`tools/verify/${name}.mjs`,args:[...args,'--out',path.join(root,name)]}))};
}

export function runSmokePlan(plan,execute) {
  const results=[];
  for(const suite of plan.suites){
    const result=execute(suite);
    results.push({name:suite.name,status:result.status??1,signal:result.signal??null,error:result.error?.message??null});
    if(result.status!==0||result.error)break;
  }
  return {ok:results.length===plan.suites.length&&results.every(r=>r.status===0&&!r.error),results,
    notRun:plan.suites.slice(results.length).map(s=>s.name)};
}

function main(){
  const plan=smokePlan(process.argv.slice(2));
  fs.mkdirSync(plan.root,{recursive:true});
  const startedAt=new Date().toISOString();
  const result=runSmokePlan(plan,suite=>{
    console.log(`\n=== 完整浏览器验收：${suite.name} ===`);
    return spawnSync(process.execPath,[suite.script,...suite.args],{stdio:'inherit',shell:false});
  });
  fs.writeFileSync(path.join(plan.root,'aggregate-results.json'),JSON.stringify({startedAt,finishedAt:new Date().toISOString(),...result},null,2)+'\n');
  console.log(`\n聚合验收：${result.ok?'PASS':'FAIL'}，完成${result.results.length}/${plan.suites.length}套件`);
  return result.ok?0:1;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{process.exitCode=main();}catch(error){console.error(error.message);process.exitCode=1;}
}
