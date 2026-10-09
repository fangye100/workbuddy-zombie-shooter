import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function validateCatalog(catalog, exists, published = []) {
  const errors = [], ids = new Set(), paths = new Set();
  const roles = new Set(['navigation','framework','editor','game','animation','art','validation','history']);
  const authorities = new Set(['rule','source','guide','design','evidence','history']);
  if(catalog.schemaVersion !== 1 || !Array.isArray(catalog.entries)) return ['Unsupported catalog schema'];
  for(const e of catalog.entries) {
    if(typeof e.id !== 'string' || !/^[a-z0-9-]+$/.test(e.id) || ids.has(e.id)) errors.push(`Invalid/duplicate id: ${e.id}`);
    ids.add(e.id);
    if(typeof e.path !== 'string' || e.path.includes('\\') || path.posix.isAbsolute(e.path) || e.path.split('/').includes('..') || e.path.includes(':') || paths.has(e.path)) errors.push(`Invalid/duplicate path: ${e.path}`);
    else if(!exists(e.path)) errors.push(`Missing document/source: ${e.path}`);
    paths.add(e.path);
    if(!roles.has(e.role) || !authorities.has(e.authority) || !['current','historical'].includes(e.status)) errors.push(`Invalid classification: ${e.id}`);
    if(['history','evidence','design'].includes(e.authority) && e.status !== 'historical') errors.push(`Historical material promoted without a current guide: ${e.id}`);
    if(!e.title || !e.read || !Array.isArray(e.topics) || !e.topics.length || !Array.isArray(e.sourceRefs)) errors.push(`Missing discovery/authority fields: ${e.id}`);
    if(e.authority === 'guide' && !e.sourceRefs?.length) errors.push(`Guide lacks source contracts: ${e.id}`);
  }
  for(const e of catalog.entries) for(const ref of e.sourceRefs || []) {
    const source = catalog.entries.find(s => s.id === ref);
    if(!source || !['source','rule'].includes(source.authority) || source.status !== 'current') errors.push(`Invalid source reference: ${e.id} -> ${ref}`);
  }
  for(const p of published) if(!paths.has(p)) errors.push(`Published document missing from catalog: ${p}`);
  return errors;
}

export function findKnowledge(catalog, filter = {}) {
  return catalog.entries.filter(e => (!filter.role || e.role === filter.role) && (!filter.status || e.status === filter.status)
    && (!filter.topic || [e.id,e.path,e.title,...e.topics].join(' ').toLowerCase().includes(filter.topic.toLowerCase())))
    .map(e => ({id:e.id,path:e.path,title:e.title,role:e.role,status:e.status,authority:e.authority,read:e.read,sourceRefs:e.sourceRefs}));
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'docs/knowledge/catalog.json'),'utf8'));
  if(process.argv.includes('--check')) {
    const tracked=execFileSync('git',['ls-files','-z','--','docs','.workbuddy/memory'],{cwd:root,encoding:'utf8'}).split('\0').filter(p=>p.endsWith('.md'));
    // Include newly authored docs before staging, but never adopt unrelated drafts.
    const errors=validateCatalog(catalog,p=>fs.existsSync(path.join(root,p)),tracked);
    console.log(JSON.stringify({entries:catalog.entries.length,trackedDocuments:tracked.length,errors},null,2));
    if(errors.length)process.exitCode=1;
  } else {
    const filter={};
    for(const key of ['role','status','topic']) { const index=process.argv.indexOf('--'+key);if(index>=0)filter[key]=process.argv[index+1]; }
    console.log(JSON.stringify(findKnowledge(catalog,filter),null,2));
  }
}
