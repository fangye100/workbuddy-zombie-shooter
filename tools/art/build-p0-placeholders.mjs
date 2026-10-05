/** Reproducible low-cost substitutes with the same logical IDs as the pending deliveries. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {authoredGlb,pngRgb} from '../level/authored-glb.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const recipe=JSON.parse(fs.readFileSync(path.join(root,'assets/art/p0-intake.json'),'utf8'));
for(const e of recipe.models.filter(e=>e.status==='placeholder')){
 const positions=[],normals=[],uvs=[],indices=[];
 const palette=e.id==='ENV-MID-03'?['#65736a','#af674b','#c7baa0','#343c44','#778e91']:['#657887','#839099','#596b7a','#374c60','#af7863'];
 const png=pngRgb(80,16,x=>[1,3,5].map(i=>parseInt(palette[Math.floor(x/16)].slice(i,i+2),16)));
 const face=(points,n,color)=>{const a=positions.length/3;for(const p of points){positions.push(...p);normals.push(...n);uvs.push((color+.5)/5,.5);}indices.push(a,a+1,a+2,a,a+2,a+3);};
 const triangle=(points,n,color)=>{const a=positions.length/3;for(const p of points){positions.push(...p);normals.push(...n);uvs.push((color+.5)/5,.5);}indices.push(a,a+1,a+2);};
 const box=(x,y,z,w,h,d,color)=>{
  const a=x-w/2,b=x+w/2,c=z-d/2,f=z+d/2,t=y+h;
  face([[a,y,f],[b,y,f],[b,t,f],[a,t,f]],[0,0,1],color);face([[b,y,c],[a,y,c],[a,t,c],[b,t,c]],[0,0,-1],color);
  face([[b,y,f],[b,y,c],[b,t,c],[b,t,f]],[1,0,0],color);face([[a,y,c],[a,y,f],[a,t,f],[a,t,c]],[-1,0,0],color);
  face([[a,t,f],[b,t,f],[b,t,c],[a,t,c]],[0,1,0],2);
 };
 const cylinder=(x,y,z,r,h,color)=>{
  for(let i=0;i<12;i++){const a=i*Math.PI/6,b=(i+1)*Math.PI/6;
   face([[x+r*Math.cos(b),y,z+r*Math.sin(b)],[x+r*Math.cos(a),y,z+r*Math.sin(a)],[x+r*Math.cos(a),y+h,z+r*Math.sin(a)],[x+r*Math.cos(b),y+h,z+r*Math.sin(b)]],[Math.cos((a+b)/2),0,Math.sin((a+b)/2)],color);
   triangle([[x,y+h,z],[x+r*Math.cos(b),y+h,z+r*Math.sin(b)],[x+r*Math.cos(a),y+h,z+r*Math.sin(a)]],[0,1,0],2);
   triangle([[x,y,z],[x+r*Math.cos(a),y,z+r*Math.sin(a)],[x+r*Math.cos(b),y,z+r*Math.sin(b)]],[0,-1,0],color);
  }
 };
 if(e.id==='ENV-MID-03'){
  box(-3,0,-.6,12,5.5,7.8,0);box(6,0,-.6,6,3.6,7.8,0);
  for(const x of [-6,0]){box(x,.1,3.35,4.7,3.9,.2,3);for(let y=.4;y<4;y+=.4)box(x,y,3.49,4.6,.05,.04,2);box(x,4.3,3.6,5.7,.2,1.8,1);}
  box(6,1,3.35,3.5,1.8,.15,3);box(-3,5.5,-.6,12.1,.5,7.9,1);box(6,3.6,-.6,6.1,.25,7.9,1);
  box(-3,4.8,3.38,3.4,.6,.1,2);box(6,3.9,-1.5,1.6,1.1,1.6,4);
 }else{
  for(let i=0;i<5;i++)box(-27+i*13,0,i%2?-3:1,12,7+i%3*2,16,0);
  cylinder(-20,0,-4,2,36,3);cylinder(-11,0,-4,2.4,29,3);
  cylinder(15,0,2,6,11,1);
  for(const x of [27,33])for(const z of [-3,3])box(x,0,z,.8,18,.8,3);
  cylinder(30,17,0,5.5,9,1);box(-20,29,-4,4.1,2,4.1,4);box(-11,22,-4,4.9,2,4.9,4);
 }
 const dir=path.join(root,'assets/art/models',e.id,'game_ready');fs.mkdirSync(dir,{recursive:true});
 for(let lod=0;lod<3;lod++)fs.writeFileSync(path.join(dir,e.id+'_lod'+lod+'.glb'),authoredGlb(e.id+' · procedural placeholder',positions,normals,uvs,indices,png));
 console.log(e.id,indices.length/3,'triangles; replacement pending, not final art');
}
