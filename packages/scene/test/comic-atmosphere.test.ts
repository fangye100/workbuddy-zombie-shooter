import { describe, it, expect } from 'vitest';
import { createEmptySceneDocument, validateSceneDocument, type SceneDocument } from '../src/document';
import { migrateToLatest } from '../src/migrate';
const level = Object.values(import.meta.glob('/assets/scenes/act1/floor-1.scene.json', { eager: true, import: 'default' }))[0] as SceneDocument;

describe('authored comic atmosphere', () => {
  it('round-trips sky and style through the scene contract', () => {
    const doc = JSON.parse(JSON.stringify(level)) as SceneDocument;
    expect(validateSceneDocument(doc).filter(d => d.severity === 'error')).toEqual([]);
    expect(doc.environment.sky?.sunDirection).toEqual(level.environment.sky!.sunDirection);
    expect(doc.environment.comic?.contactShadowOpacity).toBe(0.45);
  });
  it('migrates legacy scenes without inventing a sky or changing their palette', () => {
    const doc = createEmptySceneDocument('legacy');
    const result = migrateToLatest({ ...doc, schemaVersion: 8 });
    expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    expect(result.doc.environment).toEqual(doc.environment);
  });
  it.each([
    ['sunDirection', [0, 0, 0]], ['cloudCoverage', 1.2], ['sunSize', 0], ['zenith', 'red'],
    ['textureMix', 2], ['textureYaw', -1], ['texture', {path:'assets/../private.png',guid:'as_1234'}],
    ['texture', {path:'assets/sky.png'}],
  ])('rejects invalid sky %s', (key, value) => {
    const doc = structuredClone(level); Object.assign(doc.environment.sky!, { [key]: value });
    expect(validateSceneDocument(doc).some(d => d.severity === 'error' && d.path === `/environment/sky/${key}`)).toBe(true);
  });
  it('v9 to v10 preserves prior presentation and round-trips an authored texture reference', () => {
    const old=structuredClone(level); old.schemaVersion=9; delete old.environment.sky!.texture;
    const migrated=migrateToLatest(old);
    expect(migrated.doc.schemaVersion).toBe(10);
    expect(migrated.doc.environment.sky!.texture).toBeUndefined();
    const doc=structuredClone(level);
    doc.environment.sky!.texture={path:'assets/sky.png',guid:'as_1234'};
    doc.environment.sky!.textureMix=.75;doc.environment.sky!.textureYaw=120;
    expect(validateSceneDocument(JSON.parse(JSON.stringify(doc))).filter(d=>d.severity==='error')).toEqual([]);
  });
  it.each([['tonemapMode', 1.5], ['contactShadowOpacity', -1], ['halftoneStrength', 0.8]])('rejects invalid style %s', (key, value) => {
    const doc = structuredClone(level); Object.assign(doc.environment.comic!, { [key]: value });
    expect(validateSceneDocument(doc).some(d => d.severity === 'error' && d.path === `/environment/comic/${key}`)).toBe(true);
  });
});
