/** Reproducible environment mesh from assets/environment/images/S-02.png.
 * Six named primitives keep color/roughness authorable in SceneDocument bindings.
 * Y-up, metres, origin at feet. No character assets or external dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const groups = ['masonry', 'trim', 'interior', 'glass', 'sign', 'accent'].map(name => ({ name, positions: [], normals: [] }));
function triangle(g, a, b, c) {
  const u = b.map((v, i) => v - a[i]), v = c.map((v, i) => v - a[i]);
  const n = [u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]], length = Math.hypot(...n);
  if (length < 1e-8) throw new Error('degenerate triangle');
  groups[g].positions.push(...a, ...b, ...c);
  for (let i=0;i<3;i++) groups[g].normals.push(...n.map(x=>x/length));
}
function quad(g,a,b,c,d) { triangle(g,a,b,c); triangle(g,a,c,d); }
function box(g,x,y,z,w,h,d) {
  const a=[x-w/2,y-h/2,z-d/2], b=[x+w/2,y+h/2,z+d/2];
  quad(g,[a[0],a[1],a[2]],[a[0],b[1],a[2]],[b[0],b[1],a[2]],[b[0],a[1],a[2]]);
  quad(g,[a[0],a[1],b[2]],[b[0],a[1],b[2]],[b[0],b[1],b[2]],[a[0],b[1],b[2]]);
  quad(g,[a[0],a[1],a[2]],[a[0],a[1],b[2]],[a[0],b[1],b[2]],[a[0],b[1],a[2]]);
  quad(g,[b[0],a[1],a[2]],[b[0],b[1],a[2]],[b[0],b[1],b[2]],[b[0],a[1],b[2]]);
  quad(g,[a[0],b[1],a[2]],[a[0],b[1],b[2]],[b[0],b[1],b[2]],[b[0],b[1],a[2]]);
  quad(g,[a[0],a[1],a[2]],[b[0],a[1],a[2]],[b[0],a[1],b[2]],[a[0],a[1],b[2]]);
}
// Cream concrete shell, raised foundation and charcoal roof/eaves.
box(0,0,1.9,0,12,3.8,8); box(1,0,0.15,0,12.35,.3,8.3);
box(1,0,3.85,0,12.8,.25,8.8); box(0,0,4.13,0,12,.4,8);
box(1,0,4.37,0,12.35,.12,8.35);
// Shopfront: deep dark openings, cream frames and visibly broken cyan panes.
for (let i=0;i<6;i++) {
  const x=-4.9+i*1.95;
  box(1,x,1.95,-4.055,1.82,2.6,.13); box(2,x,1.95,-4.13,1.62,2.4,.05);
  const l=x-.79,r=x+.79,z=-4.17;
  triangle(3,[l,.77,z],[l,1.48,z],[l+.55,.77,z]);
  triangle(3,[r,3.13,z],[r-.72,3.13,z],[r,2.46,z]);
  triangle(3,[l,3.13,z],[l,2.5,z],[l+.44,3.13,z]);
  box(0,x,.7,-4.14,1.9,.1,.1);
  // Shelves and surviving goods glimpsed through openings.
  for (let row=0;row<2;row++) {
    box(1,x,1.1+row*.65,-4.16,1.45,.06,.04);
    for(let item=0;item<3;item++) box((i+item)%2?4:5,x-.46+item*.45,1.29+row*.65,-4.18,.2,.32,.04);
  }
}
// Door and low steps; no lettering invented from the reference.
box(1,.95,1.65,-4.22,1.85,3,.12); box(2,.95,1.65,-4.3,1.58,2.8,.04);
box(3,.95,2.4,-4.34,1.36,.8,.04); box(0,.95,.17,-4.62,2.25,.34,.95);
box(0,.95,.08,-5.12,2.65,.16,.45);
// Split red sign, yellow stripe, broken dark gap and pale graphic fragments.
box(1,0,4.96,-3.2,8.8,1.3,.35);
box(4,-1.5,4.96,-3.4,5.55,1.05,.09); box(4,3.1,4.96,-3.4,2.05,1.05,.09);
box(5,-.4,5.38,-3.46,7.85,.13,.04);
quad(0,[-3.85,5.35,-3.46],[-3.2,4.58,-3.46],[-2.8,4.58,-3.46],[-3.4,5.35,-3.46]);
triangle(5,[1.35,5.35,-3.48],[1.62,4.8,-3.48],[1.92,5.12,-3.48]);
triangle(3,[1.72,4.53,-3.48],[2.05,4.8,-3.48],[2.32,4.53,-3.48]);
// Rooftop units and vents create readable silhouettes from the game camera.
for(const x of [-4.3,4.2]) {
  box(0,x,4.7,1.7,1.6,.65,1.3);
  box(1,x,4.72,1.02,1.3,.43,.04);
  for(let i=0;i<4;i++) box(0,x,4.57+i*.1,.98,1.22,.035,.035);
}
box(1,-5.85,1.95,-4.24,.1,3.6,.1);
// Export one mesh with six stable primitive/material names.
const chunks=[], bufferViews=[], accessors=[], primitives=[]; let offset=0;
function accessor(array) {
  const typed=new Float32Array(array), bytes=Buffer.from(typed.buffer);
  const view=bufferViews.push({buffer:0,byteOffset:offset,byteLength:bytes.length})-1;
  chunks.push(bytes); offset+=bytes.length;
  return accessors.push({bufferView:view,componentType:5126,count:array.length/3,type:'VEC3'})-1;
}
for(const [material,g] of groups.entries()) primitives.push({attributes:{POSITION:accessor(g.positions),NORMAL:accessor(g.normals)},material});
const json={asset:{version:'2.0',generator:'Aether authored storefront'},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'S02_Storefront',mesh:0}],meshes:[{primitives}],materials:groups.map(g=>({name:g.name})),buffers:[{byteLength:offset}],bufferViews,accessors};
const raw=Buffer.from(JSON.stringify(json)), padded=Buffer.alloc(Math.ceil(raw.length/4)*4,32); raw.copy(padded);
const bin=Buffer.concat(chunks), header=Buffer.alloc(12), jh=Buffer.alloc(8), bh=Buffer.alloc(8);
header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(12+8+padded.length+8+bin.length,8);
jh.writeUInt32LE(padded.length,0);jh.writeUInt32LE(0x4e4f534a,4);bh.writeUInt32LE(bin.length,0);bh.writeUInt32LE(0x004e4942,4);
const target=path.join(root,'assets/environment/models/S-02/synthetic/storefront.glb'); fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,Buffer.concat([header,jh,padded,bh,bin]));
console.log(`Storefront: ${offset/72} triangles, 6 primitives; ${target}`);
