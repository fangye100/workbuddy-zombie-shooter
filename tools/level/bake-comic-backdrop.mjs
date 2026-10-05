import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { authoredGlb, pngRgb } from './authored-glb.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const spec=JSON.parse(fs.readFileSync(path.join(root,'assets/environment/backdrops/industrial-quarter.json'),'utf8'));
const palette=spec.palette.map(hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)));
const png=pngRgb(palette.length*8,8,x=>palette[Math.floor(x/8)]);
const positions=[],normals=[],uvs=[],indices=[];
function face(points,normal,color){const base=positions.length/3;for(const p of points){positions.push(...p);normals.push(...normal);uvs.push((color+0.5)/palette.length,0.5);}indices.push(base,base+1,base+2,base,base+2,base+3);}
function box(x,y,z,w,h,d,color){
 const a=x-w/2,b=x+w/2,c=z-d/2,e=z+d/2,t=y+h;
 face([[a,y,e],[b,y,e],[b,t,e],[a,t,e]],[0,0,1],color);
 face([[b,y,c],[a,y,c],[a,t,c],[b,t,c]],[0,0,-1],color);
 face([[b,y,e],[b,y,c],[b,t,c],[b,t,e]],[1,0,0],4);
 face([[a,y,c],[a,y,e],[a,t,e],[a,t,c]],[-1,0,0],4);
 face([[a,t,e],[b,t,e],[b,t,c],[a,t,c]],[0,1,0],Math.min(3,color+1));
}
spec.rows.forEach((row,layer)=>row.heights.forEach((h,i)=>{
 const x=(i-(row.heights.length-1)/2)*row.width,z=row.z,w=row.width-0.9;
 box(x,0,z,w,h,row.depth,(i+layer)%4);
 box(x,h,z,w+0.3,0.4,row.depth+0.3,4);
 if(i%3===0)box(x+2,h+0.4,z,2.5,2.2,2.8,2);
 if(i%4===1)box(x-2,h+0.4,z,0.18,3,0.18,4);
 for(let floor=1;floor<h/3-1;floor++)for(let col=-1;col<=1;col++){
   const left=x+col*3-0.6,bottom=floor*3,front=z+row.depth/2+0.01;
   face([[left,bottom,front],[left+1.25,bottom,front],[left+1.25,bottom+1.6,front],[left,bottom+1.6,front]],[0,0,1],(i+floor+col)%7===0?5:4);
 }
}));
const dir=path.join(root,'assets/environment/models/backdrop/synthetic');fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'industrial-quarter.glb'),authoredGlb(spec.name,positions,normals,uvs,indices,png));
console.log(`Authored skyline: ${indices.length/3} triangles, one scene placement.`);
