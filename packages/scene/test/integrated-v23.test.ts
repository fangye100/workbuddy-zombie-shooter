import {describe,it,expect} from 'vitest';
import legacyVfx from './fixtures/legacy-vfx-v19.json';
import {SCHEMA_VERSION,defaultNavigationSettings,validateSceneDocument} from '../src/document';
import {migrateToLatest} from '../src/migrate';

describe('主线与已发布 VFX v19 统一迁移',()=>{
 it('保留真实 VFX 场景全部作者字段，仅补主线兼容缺省，原输入不变',()=>{
  const before=structuredClone(legacyVfx),result=migrateToLatest(legacyVfx);
  const expected=structuredClone(before) as Record<string,any>;
  expected.schemaVersion=SCHEMA_VERSION;
  for(const node of expected.nodes)for(const c of node.components){
   if(c.kind==='NavZone'&&c.crowd===undefined)c.crowd=defaultNavigationSettings();
   if(c.kind==='RunRules'&&c.arsenal)for(const w of c.arsenal.definitions)
    if(w.presentation&&w.presentation.assembly===undefined)w.presentation.assembly=null;
  }
  expect(result.doc).toEqual(expected);expect(legacyVfx).toEqual(before);
  expect(result.applied).toContain('integrated-navigation-and-vfx');
  expect(result.diagnostics.filter(d=>d.severity==='error')).toEqual([]);
  expect(migrateToLatest(result.doc).applied).toEqual([]);
 });
 it('v22→v23不生成特效/贴花/武器或改写作者配置，非法资源仍显式诊断',()=>{
  const current=migrateToLatest(legacyVfx).doc;
  const old={...structuredClone(current),schemaVersion:22};
  const result=migrateToLatest(old);
  expect(result.applied).toEqual(['integrated-navigation-and-vfx','destructible-fracture-components','npc-death-fracture-reference']);
  expect(result.doc).toEqual({...old,schemaVersion:SCHEMA_VERSION});
  const binding=result.doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='VfxBindings');
  expect(binding).toBeDefined();
  if(binding?.kind!=='VfxBindings')throw Error('fixture lacks VfxBindings');
  Object.values(binding.bindings)[0]!.resource.guid='';
  expect(validateSceneDocument(result.doc).some(d=>d.code==='E_VFX_BINDINGS')).toBe(true);
 });
});
