/** Authored road assets. UVs cover the complete atlas; no dependence on ignored glTF wrap flags. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authoredGlb, pngRgb } from './authored-glb.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const dir=path.join(root,'assets/environment/models/road/synthetic');fs.mkdirSync(dir,{recursive:true});
const hash=(x,y)=>{let h=Math.imul(x+17,374761393)^Math.imul(y+31,668265263);h=Math.imul(h^(h>>>13),1274126177);return(h>>>0)/4294967295;};
for(const [w,d] of [[130,18],[86,18],[20,16],[14,14],[6,4],[22,18],[30,24]]){
  const density=Math.min(32,2048/Math.max(w,d));
  const width=Math.ceil(w*density),height=Math.ceil(d*density);
  const png=pngRgb(width,height,(x,y)=>{
    const mx=x/density,mz=y/density;
    const grain=(hash(x,y)-0.5)*4;
    const wear=Math.sin(mx*0.5)*Math.cos(mz*0.7)*3;
    const seam=Math.abs(mz-(d*0.44+0.32*Math.sin(mx*1.2)+0.09*Math.sin(mx*4.1)));
    const crack=seam<0.025?-18:0;
    const patch=(Math.floor(mx/5)%4===2 && mz>d*0.55 && mz<d*0.7)?-5:0;
    const base=96+grain+wear+crack+patch;
    return[base-7,base,base+3];
  });
  // minY=0 keeps importer grounding stable; the authored room parent sits at -.1 m.
  const p=[-w/2,.1,-d/2,-w/2,.1,d/2,w/2,.1,d/2,w/2,.1,-d/2,-w/2,0,-d/2,-w/2,0,d/2,w/2,0,d/2,w/2,0,-d/2];
  const n=[0,1,0,0,1,0,0,1,0,0,1,0,0,-1,0,0,-1,0,0,-1,0,0,-1,0];
  const uv=[0,0,0,1,1,1,1,0,0,0,0,1,1,1,1,0];
  fs.writeFileSync(path.join(dir,`asphalt-${w}x${d}.glb`),authoredGlb(`asphalt-${w}x${d}`,p,n,uv,[0,1,2,0,2,3,4,6,5,4,7,6],png));
}
console.log('Baked seven low-noise road atlases; run scene:gen, then gen-level.');
