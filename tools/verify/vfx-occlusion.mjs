/** Verification-only inputs to the existing pass; no author data or gameplay mutation. */
import fs from 'node:fs';
import path from 'node:path';
export async function verifyVfxOcclusion(cdp,out){
 const setup=await cdp.eval(`(()=>{
  const core=window.__editor.renderer.core,pass=core.vfx,original=core.drawFrame,wall=window.__editor.renderer.getDocument().nodes.find(n=>n.id==='nd_vfx_wall'),center=[...wall.transform.position],eye=[...core.eyeVec];
  const length=Math.hypot(...center.map((v,i)=>v-eye[i])),direction=center.map((v,i)=>(v-eye[i])/length),front=center.map((v,i)=>v-direction[i]*.7),behind=center.map((v,i)=>v+direction[i]*.7);
  const source=pass.instances.find(p=>p.effect.kind==='muzzle');if(!source)throw new Error('Occlusion requires the loaded muzzle texture');
  const instance={...structuredClone(source),key:'verification-occlusion',seed:0,age:0,effect:{...structuredClone(source.effect),duration:1,size:[.65,.65]}};
  const state={mode:'off',original,pass,front,behind};window.__vfxOcclusion=state;
  core.drawFrame=function(input){const old=this.vfx,items=pass.instances;this.vfx=pass;pass.instances=state.mode==='off'?[]:[{...instance,position:state.mode==='front'?front:behind}];try{return original.call(this,input);}finally{this.vfx=old;pass.instances=items;}};
  const screen=window.__editor.renderer.worldToScreen(center),canvas=document.getElementById('gpu').getBoundingClientRect();
  const clip={x:Math.round(screen.x)-40,y:Math.round(screen.y)-40,width:80,height:80,scale:1};
  if(screen.behind || clip.x<canvas.left || clip.y<canvas.top || clip.x+80>canvas.right || clip.y+80>canvas.bottom)throw new Error('Occlusion ROI outside the rendered viewport');
  return {camera:{eye,viewProjection:[...core.viewProj]},receiver:{id:wall.id,center,transform:wall.transform,collider:wall.components.find(c=>c.kind==='Collider')},front,behind,screen,clip,effect:instance.effect};
 })()`);
 const screenshots={};
 try{
  for(const mode of ['off','front','behind']){
   await cdp.eval(`(async()=>{window.__vfxOcclusion.mode=${JSON.stringify(mode)};await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await window.__editor.renderer.core.device.queue.onSubmittedWorkDone();})()`);
   const result=await cdp.send('Page.captureScreenshot',{format:'png',clip:setup.clip});screenshots[mode]=result.data;
   fs.writeFileSync(path.join(out,`occlusion-${mode}.png`),Buffer.from(result.data,'base64'));
   if(mode==='front'){const context=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'occlusion-front-context.png'),Buffer.from(context.data,'base64'));}
  }
  const metrics=await cdp.eval(`(async()=>{
   const images=${JSON.stringify(screenshots)},decoded={};
   for(const [name,base64] of Object.entries(images)){const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'})),canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');context.drawImage(bitmap,0,0);decoded[name]=context.getImageData(0,0,bitmap.width,bitmap.height).data;bitmap.close();}
   const diff=other=>{const a=decoded.off,b=decoded[other];let changedPixels=0,maxDelta=0,totalDelta=0;for(let i=0;i<a.length;i+=4){const delta=Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]));if(delta>8)changedPixels++;maxDelta=Math.max(maxDelta,delta);totalDelta+=delta;}return {changedPixels,maxDelta,meanDelta:totalDelta/(a.length/4)};};
   return {front:diff('front'),behind:diff('behind')};
  })()`);
  const threshold={rgbDelta:8,minFrontChangedPixels:15,maxBehindChangedPixels:Math.max(2,Math.floor(metrics.front.changedPixels*.02))};
  return {...setup,metrics,threshold,passed:metrics.front.changedPixels>=threshold.minFrontChangedPixels && metrics.behind.changedPixels<=threshold.maxBehindChangedPixels,method:'Same paused camera, muzzle texture/size/seed; wall-center camera ray ±0.7m; 80x80 screenshot ROI; RGB absolute difference against VFX-off.'};
 }finally{await cdp.eval(`(()=>{const state=window.__vfxOcclusion;if(state){window.__editor.renderer.core.drawFrame=state.original;window.__editor.renderer.core.vfx=state.pass;delete window.__vfxOcclusion;}})()`);}
}
