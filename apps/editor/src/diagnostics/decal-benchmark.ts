import {DecalPool,DecalFrameBuilder,DecalPackScratch,packDecalMark,ProceduralDecalPass,DecalPreviewRenderer,DECAL_INSTANCE_FLOATS,type DecalBackend} from '@aether/render';
import {mat4} from '@aether/core';
import {DECAL_PATTERNS,type DecalMark} from '@aether/scene';

const status=document.querySelector('#status')!,results=document.querySelector('#results')!,raw=document.querySelector('#raw')!;
const run=document.querySelector<HTMLButtonElement>('#run')!,download=document.querySelector<HTMLButtonElement>('#download')!;
const vp=new Float32Array([1,0,0,0,0,0,0,0,0,1,0,0,0,0,.5,1]);
const camera=[0,5,10],world=mat4(),resolve=()=>world;
const base:DecalMark={id:'fixture',pattern:'splatter',position:[0,0,0],rotation:[0,0,0,1],size:[.13,.13],color:'#932f32',opacity:.6,seed:1,normalOffset:.002,priority:0};
const summary=(values:number[])=>{const sorted=values.slice().sort((a,b)=>a-b);return {median:sorted[Math.floor(sorted.length*.5)]??0,p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]??0};};
let cleanupCurrent:(()=>void)|null=null;
addEventListener('pagehide',()=>{cleanupCurrent?.();cleanupCurrent=null;});
const yieldUi=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
function fixture(count:number,offscreen:number,overlap=false):Float32Array<ArrayBuffer>{
 const data=new Float32Array(count*DECAL_INSTANCE_FLOATS),scratch=new DecalPackScratch();
 for(let i=0;i<count;i++){
  const m={...base,id:`bench_${i}`,pattern:DECAL_PATTERNS[i%9]!,color:['#932f32','#bba579','#91bc38'][i%3]!,seed:i,position:[i<offscreen?4:-.88+(i%14)*.13,0,-.88+(Math.floor(i/14)%14)*.13] as [number,number,number],size:overlap?[.9,.9] as [number,number]:base.size};
  packDecalMark(data,i*DECAL_INSTANCE_FLOATS,m,world,scratch);
 }
 return data;
}
async function cpuBenchmark(){
 const rows=[];
 for(const count of [32,128,256,512]){
  status.textContent=`CPU借用/复制对比：${count}项`;await yieldUi();
  const pool=new DecalPool(count),builder=new DecalFrameBuilder();for(let i=0;i<count;i++)pool.emit({...baseInput(),mark:{...base,id:`cpu_${i}`,position:[(i%16)*.1,0,Math.floor(i/16)*.1]}});
  const a=builder.build(null,resolve,pool.frame(),camera).slice(),b=builder.build(null,resolve,pool.snapshot(),camera).slice();
  if(a.some((v,i)=>v!==b[i]))throw Error('CPU借用与复制输入不等价');
  const times={borrowed:[] as number[],snapshotCopy:[] as number[]};
  for(let block=0;block<14;block++){await yieldUi();for(const mode of block%2?['snapshotCopy','borrowed'] as const:['borrowed','snapshotCopy'] as const){
   const start=performance.now();for(let i=0;i<100;i++)builder.build(null,resolve,mode==='borrowed'?pool.frame():pool.snapshot(),camera);
   if(block>=4)times[mode].push((performance.now()-start)/100);
  }
  }
  const first=pool.frame().marks[0]!;pool.remove(first.receiver,first.mark.id);pool.emit({...baseInput(),mark:{...base,id:'recycled'}});
  rows.push({count,borrowedMs:summary(times.borrowed),snapshotCopyMs:summary(times.snapshotCopy),pool:pool.diagnostics(),packedBytes:count*80});
 }
 return rows;
}
function baseInput(){return {receiver:'bench',mark:base,ttlSec:120,fadeSec:5};}
function attachments(textures:GPUTexture[]):GPURenderPassDescriptor {
 return {colorAttachments:textures.slice(0,2).map(t=>({view:t.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]})),depthStencilAttachment:{view:textures[2]!.createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:1}};
}
async function pixels(device:GPUDevice,texture:GPUTexture):Promise<Uint16Array>{
 const read=device.createBuffer({size:512*512*8,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
 try{const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer:read,bytesPerRow:4096},{width:512,height:512});device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);return new Uint16Array(read.getMappedRange().slice(0));}finally{read.destroy();}
}
async function sample(device:GPUDevice,pass:ProceduralDecalPass,textures:GPUTexture[],data:Float32Array<ArrayBuffer>,mode:DecalBackend,timed:boolean){
 const frames=32,per=mode==='direct'?2:4,query=timed?device.createQuerySet({type:'timestamp',count:frames*per}):null;
 const bytes=frames*per*8,resolve=query?device.createBuffer({size:bytes,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC}):null,read=query?device.createBuffer({size:bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}):null;
 const cpu=[] as number[];let gpu:number[]=[],compute:number[]=[];
 try{
  const encoder=device.createCommandEncoder();
  const cpuStart=performance.now();
  for(let i=0;i<frames;i++){
   const q=i*per;pass.prepare(encoder,data,query&&mode==='indirect'?{querySet:query,beginningOfPassWriteIndex:q,endOfPassWriteIndex:q+1}:undefined);
   const render=encoder.beginRenderPass({...attachments(textures),...(query?{timestampWrites:{querySet:query,beginningOfPassWriteIndex:q+per-2,endOfPassWriteIndex:q+per-1}}:{})});
   pass.drawPrepared(render);render.end();
  }
  cpu.push((performance.now()-cpuStart)/frames);
  if(query){encoder.resolveQuerySet(query,0,frames*per,resolve!,0);encoder.copyBufferToBuffer(resolve!,0,read!,0,bytes);}
  device.queue.submit([encoder.finish()]);
  if(read){await read.mapAsync(GPUMapMode.READ);const stamps=new BigUint64Array(read.getMappedRange());for(let i=0;i<frames;i++){const q=i*per,renderMs=Number(stamps[q+per-1]!-stamps[q+per-2]!)/1e6,computeMs=per===4?Number(stamps[q+1]!-stamps[q]!)/1e6:0;compute.push(computeMs);void renderMs;}gpu.push(Number(stamps[frames*per-1]!-stamps[0]!)/1e6/frames);}
  else await device.queue.onSubmittedWorkDone();
  return {cpu,gpu,compute};
 }finally{query?.destroy();resolve?.destroy();read?.destroy();}
}
async function benchmark(){
 cleanupCurrent?.();cleanupCurrent=null;
 if(!isSecureContext||!navigator.gpu)throw Error('需要HTTPS secure context与WebGPU');
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter||adapter.info.isFallbackAdapter||/swiftshader|software/i.test(adapter.info.description))throw Error('禁止以软件GPU验收');
 const timed=adapter.features.has('timestamp-query'),device=await adapter.requestDevice({requiredFeatures:timed?['timestamp-query']:[]});
 cleanupCurrent=()=>device.destroy();
 const errors:string[]=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
 const info={secureContext:isSecureContext,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description,isFallbackAdapter:adapter.info.isFallbackAdapter},timestampQuery:timed,userAgent:navigator.userAgent,width:512,height:512,date:new Date().toISOString()};
 document.querySelector('#environment')!.textContent=JSON.stringify(info,null,2);
 const frame=device.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(frame,0,vp);
 const textures=['rgba16float','rgba16float','depth32float'].map((format,i)=>device.createTexture({size:[512,512],format:format as GPUTextureFormat,usage:GPUTextureUsage.RENDER_ATTACHMENT|(i===0?GPUTextureUsage.COPY_SRC:0)}));
 const a=new ProceduralDecalPass(device,frame,'rgba16float','depth32float'),b=new ProceduralDecalPass(device,frame,'rgba16float','depth32float');b.setBackend('indirect');
 let previews:DecalPreviewRenderer[]=[];let completed=false;
 try{
  for(const module of [a.module,a.computeModule,b.module,b.computeModule]){const compilation=await module.getCompilationInfo();const bad=compilation.messages.filter(m=>m.type==='error');if(bad.length)throw Error(bad.map(m=>m.message).join(';'));}
  const cpu=await cpuBenchmark(),rows=[];
  const cases=[...([32,128,256,512,1024].flatMap(count=>[0,.5,.9].map(ratio=>({count,offscreen:Math.floor(count*ratio),overlap:false})))),{count:256,offscreen:0,overlap:true},{count:1024,offscreen:1024,overlap:false}];
  for(const c of cases){
   status.textContent=`测量 ${c.count} 项，离屏 ${c.offscreen}，重叠 ${c.overlap}…`;await yieldUi();
   const data=fixture(c.count,c.offscreen,c.overlap),stats={direct:{cpu:[] as number[],gpu:[] as number[],compute:[] as number[]},indirect:{cpu:[] as number[],gpu:[] as number[],compute:[] as number[]}};
   // 配对交替，前三轮预热。输入相同才批量编码，跨case单独submit。
   for(let round=0;round<13;round++)for(const mode of round%2?['indirect','direct'] as const:['direct','indirect'] as const){
    const r=await sample(device,mode==='direct'?a:b,textures,data,mode,timed);if(round>=3){stats[mode].cpu.push(...r.cpu);stats[mode].gpu.push(...r.gpu);stats[mode].compute.push(...r.compute);}
   }
   const encode=(pass:ProceduralDecalPass)=>{const e=device.createCommandEncoder();pass.prepare(e,data);const p=e.beginRenderPass(attachments(textures));pass.drawPrepared(p);p.end();device.queue.submit([e.finish()]);};
   encode(a);const pa=await pixels(device,textures[0]!);encode(b);const count=await b.readVisibleCount(),pb=await pixels(device,textures[0]!);let changed=0,maxHalfDelta=0,nonzero=0;
   for(let i=0;i<pa.length;i++){if(pa[i]!==pb[i])changed++;maxHalfDelta=Math.max(maxHalfDelta,Math.abs(pa[i]!-pb[i]!));if(pa[i])nonzero++;}
   if(changed||count?.visibleInstances!==c.count-c.offscreen||(!nonzero&&c.count!==c.offscreen))throw Error(`等价/剔除失败 ${JSON.stringify({c,count,changed,nonzero})}`);
   rows.push({...c,expectedVisible:c.count-c.offscreen,pixels:{changedChannels:changed,maxHalfDelta,nonzeroChannels:nonzero},direct:{cpuEncodingMs:summary(stats.direct.cpu),gpuTotalMs:timed?summary(stats.direct.gpu):null,snapshot:a.snapshot()},indirect:{cpuEncodingMs:summary(stats.indirect.cpu),gpuTotalMs:timed?summary(stats.indirect.gpu):null,gpuComputeMsQuantized:timed?summary(stats.indirect.compute):null,snapshot:b.snapshot(),readback:count}});
  }
  // 空输入、切换、清理、映射期间销毁；GPU结果只属于采样帧，未伪装成当前帧。
  const empty=device.createCommandEncoder();b.prepare(empty,new Float32Array(0));device.queue.submit([empty.finish()]);if((await b.readVisibleCount())?.visibleInstances!==0)throw Error('空帧失败');
  const life=device.createCommandEncoder();b.prepare(life,fixture(1,0));const rp=life.beginRenderPass(attachments(textures));b.drawPrepared(rp);rp.end();device.queue.submit([life.finish()]);const pending=b.readVisibleCount();b.clear();if(await pending!==null)throw Error('销毁后的读回应失效');
  a.clear();b.clear();const cleared={direct:a.snapshot(),indirect:b.snapshot()};if(cleared.direct.bufferBytes||cleared.indirect.bufferBytes)throw Error('GPU未清空');

  const previewData=fixture(120,0,true),format=navigator.gpu.getPreferredCanvasFormat();
  for(const [id,mode] of [['a','direct'],['b','indirect']] as const){const canvas=document.querySelector<HTMLCanvasElement>(`#${id}`)!,preview=new DecalPreviewRenderer(device,canvas.getContext('webgpu')!,format);previews.push(preview);preview.setBackend(mode);preview.draw(previewData,vp,512,512);}
  await device.queue.onSubmittedWorkDone();const validation=await device.popErrorScope();if(validation)errors.push(validation.message);if(errors.length)throw Error(errors.join(';'));
  const report={info,protocol:{samplesPerCasePerBackend:10,framesPerSample:32,warmupFrames:96,order:'paired AB/BA',gpu:'整批首pass开始到末render结束的timestamp差/32；B包含compute+render及pass间隙，减小65536ns量化误差；GPU上传在窗口外，字节成本另列',cpu:'整批prepare+render encoder elapsed/32；submit、GPU wait/readback excluded',snapshotBaseline:'同一新packer，复制snapshot vs借用frame；不是旧版本全部CPU成本',transparency:'RGBA16F逐通道按位一致',scope:'单贴花pass合成输入；不是整游戏FPS、移动端或500NPC验收'},cpu,rows,cleared,errors};
  raw.textContent=JSON.stringify(report,null,2);results.innerHTML='<table><tr><th>数量/离屏</th><th>A GPU中位 ms</th><th>B GPU总中位 ms</th><th>A/B CPU编码中位 ms</th><th>HDR差异通道</th></tr>'+rows.map(r=>`<tr><td>${r.count}/${r.offscreen}${r.overlap?' 重叠':''}</td><td>${r.direct.gpuTotalMs?.median.toFixed(4)??'无timestamp'}</td><td>${r.indirect.gpuTotalMs?.median.toFixed(4)??'无timestamp'}</td><td>${r.direct.cpuEncodingMs.median.toFixed(4)} / ${r.indirect.cpuEncodingMs.median.toFixed(4)}</td><td>${r.pixels.changedChannels}</td></tr>`).join('')+'</table>';
  status.textContent='完成：CPU隔离、17组GPU像素/计数、清理生命周期均通过；原始JSON可下载';download.disabled=false;
  download.onclick=()=>{const blob=new Blob([raw.textContent!],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='decal-ab-results.json';link.click();URL.revokeObjectURL(url);};
  cleanupCurrent=()=>{previews.forEach(p=>p.destroy());device.destroy();};completed=true;
 }finally{a.clear();b.clear();frame.destroy();textures.forEach(t=>t.destroy());if(!completed){previews.forEach(p=>p.destroy());device.destroy();cleanupCurrent=null;}}
}
run.onclick=()=>{run.disabled=true;download.disabled=true;benchmark().catch(e=>{cleanupCurrent?.();cleanupCurrent=null;status.textContent=`失败：${String(e)}`;console.error(e);}).finally(()=>{run.disabled=false;});};
