import {SCHEMA_VERSION} from '../src/document';
import {it,expect} from 'vitest';
import {createEmptySceneDocument,validateSceneDocument} from '../src/document';
import {migrateToLatest,registerSceneMigrations} from '../src/migrate';
import {VFX_VERSION,migrateVfxAsset,validateVfxAsset} from '../src/vfx';
it('v15→16 preserves old content without inventing bindings and validates opaque refs',()=>{
 registerSceneMigrations();const d=createEmptySceneDocument('old');d.schemaVersion=15;const old=structuredClone(d.nodes);const r=migrateToLatest(d);expect(r.doc.schemaVersion).toBe(SCHEMA_VERSION);expect(r.doc.nodes).toEqual(old);expect(r.applied).toEqual(['predictive-crowd-navigation','authored-3d-navigation-surfaces','runtime-navigation-gates','procedural-surface-decals','expanded-procedural-decal-styles','authored-combat-decal-emitter','integrated-navigation-pose-sockets','integrated-navigation-and-vfx','destructible-fracture-components']);
 r.doc.nodes[0]!.components.push({kind:'VfxBindings',enabled:true,bindings:{'opaque.phase':{resource:{path:'assets/vfx/a.vfx.json',guid:'a'},effectKey:'sprite'}}});expect(validateSceneDocument(r.doc).filter(d=>d.severity==='error')).toEqual([]);
 const c=r.doc.nodes[0]!.components.find(c=>c.kind==='VfxBindings')!;c.bindings['opaque.phase']!.resource.guid='';expect(validateSceneDocument(r.doc).some(d=>d.code==='E_VFX_BINDINGS')).toBe(true);
});
it('migrates v1 to generic v2 without modifying raw disk input and rejects future versions',()=>{
 const raw={version:1,id:'a',name:'old',status:'accepted',effects:{flash:{kind:'muzzle',texture:{path:'assets/vfx/a.svg',guid:'a'},frames:1,duration:.1,size:[1,1],color:'#ffffff',blend:'alpha'}}};const next=migrateVfxAsset(raw);expect(raw.version).toBe(1);expect(next.version).toBe(VFX_VERSION);expect(next.effects.flash!.orientation).toBe('camera');expect(validateVfxAsset({...next,version:99}).length).toBeGreaterThan(0);
});
