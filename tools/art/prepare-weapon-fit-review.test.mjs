import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const doc=JSON.parse(fs.readFileSync(new URL('../../assets/scenes/sandbox/weapon-fit-review.scene.json',import.meta.url),'utf8'));
const rotate=(q,p)=>{const[x,y,z,w]=q,t=[2*(y*p[2]-z*p[1]),2*(z*p[0]-x*p[2]),2*(x*p[1]-y*p[0])];return[p[0]+w*t[0]+y*t[2]-z*t[1],p[1]+w*t[1]+z*t[0]-x*t[2],p[2]+w*t[2]+x*t[1]-y*t[0]];};
test('底火原源+X和派生-Y都真正面向编辑相机+Z，源对照仍引用不可改原GLB',()=>{
 const raw=doc.nodes.find(n=>n.id==='nd_fit_prop_0_source');assert.ok(raw);
 assert.ok(rotate(raw.transform.rotation,[1,0,0])[2]>.999999);
 assert.equal(raw.components[0].source.ref.path,'assets/_delivery/WPN-20261011/WPN-SHELL-01/WPN-SHELL-01.glb');
 for(let lod=0;lod<3;lod++){const n=doc.nodes.find(n=>n.id==='nd_fit_prop_0_'+lod);assert.ok(n);assert.ok(rotate(n.transform.rotation,[0,-1,0])[2]>.999999);}
 assert.ok(doc.nodes.filter(n=>n.components.some(c=>c.kind==='MeshRenderer')).length<=64);
});
