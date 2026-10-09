import assert from 'node:assert/strict';
import test from 'node:test';
import {findKnowledge,validateCatalog} from './catalog.mjs';
const source={id:'source',path:'packages/scene/src/document.ts',title:'Scene schema',role:'framework',authority:'source',status:'current',topics:['scene'],read:'Contract',sourceRefs:[]};
const guide={id:'guide',path:'docs/README.md',title:'Knowledge',role:'navigation',authority:'guide',status:'current',topics:['knowledge'],read:'Task routes',sourceRefs:['source']};
const catalog=()=>({schemaVersion:1,entries:structuredClone([source,guide])});
test('portable sources and guide citations validate',()=>assert.deepEqual(validateCatalog(catalog(),()=>true,['docs/README.md']),[]));
test('duplicate IDs, missing paths and omitted published docs fail',()=>{
  const c=catalog();c.entries.push({...guide,path:'docs/new.md'});
  const errors=validateCatalog(c,p=>p!=='docs/new.md',['docs/missing.md']).join('\n');
  assert.match(errors,/duplicate id/);assert.match(errors,/Missing document/);assert.match(errors,/missing from catalog/);
});
test('historical memory cannot masquerade as current acceptance or source authority',()=>{
  const c=catalog();c.entries[0].authority='history';
  const errors=validateCatalog(c,()=>true).join('\n');assert.match(errors,/Historical material promoted/);assert.match(errors,/Invalid source reference/);
});
test('unsafe checkout paths and broken source references fail',()=>{
  const c=catalog();c.entries[1].path='../outside.md';c.entries[1].sourceRefs=['missing'];
  const errors=validateCatalog(c,()=>true).join('\n');assert.match(errors,/Invalid.*path/);assert.match(errors,/Invalid source reference/);
});
test('search routes by topic, role and status without copying history into a policy',()=>{
  const c=catalog();assert.equal(findKnowledge(c,{topic:'SCENE',role:'framework',status:'current'})[0].id,'source');
  assert.deepEqual(findKnowledge(c,{status:'historical'}),[]);
});
