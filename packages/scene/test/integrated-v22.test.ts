import {SCHEMA_VERSION} from '../src/document';
import {describe,it,expect} from 'vitest';
import mainV18 from './fixtures/legacy-main-v18.json';
import decalV21 from './fixtures/legacy-decal-v21.json';
import {migrateToLatest,listMigrations,registerSceneMigrations} from '../src/migrate';
import {defaultNavigationSettings,validateSceneDocument} from '../src/document';
// 原始发布快照：a4f4ad68/floor-1(v18姿态/握点)与ae23100c/floor-1(v21导航/贴花)。
// v16/v17是同一字段族的旧版本输入，不冒充当时的完整发布快照。
const source=(value:unknown)=>structuredClone(value) as Record<string,any>;
const normalized=(input:Record<string,any>)=>{
 const result=source(input);result.schemaVersion=SCHEMA_VERSION;
 for(const n of result.nodes)for(const c of n.components){
  if(c.kind==='NavZone'&&c.crowd===undefined)c.crowd=defaultNavigationSettings();
  if(c.kind==='RunRules'&&c.arsenal)for(const w of c.arsenal.definitions)if(w.presentation&&w.presentation.assembly===undefined)w.presentation.assembly=null;
 }
 return result;
};
describe('重号历史分支统一迁移v22',()=>{
 for(const [name,raw] of [['main',mainV18],['decal',decalV21]] as const)for(const version of [16,17,18]){
  it(`${name}字段族v${version}完整保留节点、GUID、pose/hold/导航/贴花，并且不改输入`,()=>{
   const input=source(raw);input.schemaVersion=version;const before=source(input),r=migrateToLatest(input);
   expect(r.to).toBe(SCHEMA_VERSION);expect(r.doc).toEqual(normalized(before));expect(input).toEqual(before);
   expect(r.diagnostics.filter(d=>d.severity==='error')).toEqual([]);
  });
 }
 it('两个真实发布版本均可加载；v22重载幂等，迁移链唯一连续',()=>{
  for(const raw of [mainV18,decalV21]){const first=migrateToLatest(raw),again=migrateToLatest(first.doc);expect(again.applied).toEqual([]);expect(again.doc).toEqual(first.doc);}
  registerSceneMigrations();const versions=listMigrations().map(m=>m.from).sort((a,b)=>a-b);expect(versions).toEqual(Array.from({length:SCHEMA_VERSION-1},(_,i)=>i+1));
 });
 it('显式配置/null不被缺省覆盖，畸形配置保持并报告错误',()=>{
  const input=source(mainV18);input.schemaVersion=21;
  const nav=input.nodes.flatMap((n:any)=>n.components).find((c:any)=>c.kind==='NavZone');nav.crowd={...defaultNavigationSettings(),maxNeighbors:24};
  const rules=input.nodes.flatMap((n:any)=>n.components).find((c:any)=>c.kind==='RunRules');
  const assembly=rules.arsenal.definitions.find((w:any)=>w.presentation.assembly)?.presentation.assembly;
  expect(assembly).toBeDefined();const before=source(input),r=migrateToLatest(input);expect(r.doc).toEqual(normalized(before));
  rules.arsenal.definitions[0].presentation.assembly=null;expect((migrateToLatest(input).doc as any).nodes.flatMap((n:any)=>n.components).find((c:any)=>c.kind==='RunRules').arsenal.definitions[0].presentation.assembly).toBeNull();
  nav.crowd=null;const broken=migrateToLatest(input);expect((broken.doc as any).nodes.flatMap((n:any)=>n.components).find((c:any)=>c.kind==='NavZone').crowd).toBeNull();expect(broken.diagnostics.some(d=>d.code==='E_NAV_CROWD')).toBe(true);
  expect(validateSceneDocument(r.doc).filter(d=>d.severity==='error')).toEqual([]);
 });
});
