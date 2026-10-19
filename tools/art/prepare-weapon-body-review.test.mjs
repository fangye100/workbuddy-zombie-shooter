import {test} from 'node:test';import assert from 'node:assert/strict';
import {geometryFacts,sourceViews} from './prepare-weapon-body-review.mjs';
test('UV seam duplicate vertices do not become disconnected named parts',()=>{
 const positions=new Float32Array([0,0,0,1,0,0,0,1,0,0,0,0,0,1,0,-1,0,0,5,0,0,6,0,0,5,1,0]);
 const facts=geometryFacts(positions,new Uint32Array([0,1,2,3,4,5,6,7,8]),3);
 assert.equal(facts.topology.components,2);assert.equal(facts.topology.weldedVertices,7);assert.equal(facts.topology.boundaryEdges,7);assert.equal(facts.topology.nonManifoldEdges,0);
 assert.deepEqual(facts.topology.largestComponents.map(g=>g.triangles),[2,1]);assert.match(facts.topology.semanticParts,/pending/);
 assert.throws(()=>geometryFacts(new Float32Array([NaN,0,0]),new Uint32Array([0,0,0]),3),/非有限/);
});
test('fixed positive/negative long-axis views face camera +Z, without guessing muzzle sign',()=>{
 const rotate=(q,v)=>{const [x,y,z,w]=q,[X,Y,Z]=v,t=[2*(y*Z-z*Y),2*(z*X-x*Z),2*(x*Y-y*X)];return [X+w*t[0]+y*t[2]-z*t[1],Y+w*t[1]+z*t[0]-x*t[2],Z+w*t[2]+x*t[1]-y*t[0]];};
 for(const axis of [0,2])for(const j of [1,3]){const v=[0,0,0];v[axis]=j===1?1:-1;const result=rotate(sourceViews(axis)[j].rotation,v);assert.ok(Math.abs(result[0])<1e-12&&Math.abs(result[1])<1e-12&&Math.abs(result[2]-1)<1e-12);}
});
