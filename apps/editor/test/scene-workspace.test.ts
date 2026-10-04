import { describe, expect, it } from 'vitest';
import { sceneChoices, sceneUrl } from '../src/services/scene-workspace';
import { createEmptySceneDocument, migrateToLatest } from '@aether/scene';
import { findSceneBinding, resolveSceneMaterial } from '../src/services/scene-material';
import { lightAngles } from '../src/services/scene-light';
import { defaultParams } from '../src/params';
import { MaterialLibrary, slotState } from '../src/materials';

const files = import.meta.glob('/aether.project.json', { eager: true, import: 'default' });
describe('scene workspace', () => {
  it('discovers project scenes and identifies the project start without hiding editor-only entries', () => {
    const list = sceneChoices(files['/aether.project.json']);
    expect(list).toHaveLength(8);
    expect(list.find(s => s.start)?.path).toBe('assets/scenes/act1/floor-1.scene.json');
    expect(() => sceneChoices({ scenes: [] })).toThrow();
  });
  it('opening a scene exits auto-play while preserving unrelated URL state', () => {
    const url = new URL(sceneUrl('https://local.test/?debug=1&play=1', '/assets/scenes/a.scene.json'));
    expect(url.searchParams.get('scene')).toBe('assets/scenes/a.scene.json');
    expect(url.searchParams.has('play')).toBe(false);
    expect(url.searchParams.get('debug')).toBe('1');
  });
  it('v5 migration never guesses an elite target', () => {
    const doc = createEmptySceneDocument('migration'); doc.schemaVersion = 5;
    doc.nodes[0]!.components = [{ kind: 'RoomVolume', enabled: true, roomType: 'elite', theme: 'none',
      bounds: { center: [0, 0, 0], size: [10, 4, 10] }, clearRule: 'elite-dead', depth: 1 }];
    const migrated = migrateToLatest(doc);
    const room = migrated.doc.nodes[0]!.components[0]!;
    expect(room.kind === 'RoomVolume' && room.clearTarget).toBeNull();
    expect(migrated.applied).toContain('add-room-clear-target');
  });
});
describe('serialized material bindings', () => {
  it('applies inner-to-outer patches without changing the shared material', () => {
    const base = defaultParams().materials[1]!; const old = structuredClone(base);
    const result = resolveSceneMaterial({ type: 'override', patch: { albedo: '#123456' }, base: {
      type: 'override', patch: { albedo: '#ffffff', roughness: 0.99 }, base: { type: 'shared', id: 's1' },
    } }, () => base);
    expect(result.state.albedo).toBe('#123456'); expect(result.state.roughness).toBe(0.99);
    expect(base).toEqual(old);
  });
  it('stable primitive binding wins over positional binding', () => {
    const ref = findSceneBinding([
      { match: { by: 'index', value: 0 }, material: { type: 'shared', id: 's0' } },
      { match: { by: 'primitiveKey', value: 'wheel' }, material: { type: 'shared', id: 's3' } },
    ], { primitiveKey: 'wheel', nodePath: [], nodeName: '' }, 0);
    expect(ref).toEqual({ type: 'shared', id: 's3' });
  });
});

it('directional light rotation supplies the shader direction including parent world rotation', () => {
  expect(lightAngles([0, 0, 0, 1]).elevation).toBeCloseTo(90);
  const angles = lightAngles([Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  expect(angles.elevation).toBeCloseTo(0); expect(angles.azimuth).toBeCloseTo(0);
});


it('restores missing serialized instances from their declared base, including outer overrides', () => {
  const params = defaultParams(); const lib = new MaterialLibrary();
  const ref = { type: 'instance' as const, id: 'i42', base: 's3' };
  const resolve = (binding: Parameters<typeof resolveSceneMaterial>[0]) => resolveSceneMaterial(
    binding, id => lib.resolve(params, id), id => lib.find(id)?.state ?? null);
  const direct = resolve(ref);
  expect(direct.id).toBe('s3'); expect(direct.state).toEqual(params.materials[3]);
  expect(direct.warnings.join(' ')).toContain('i42');
  expect(direct.warnings.join(' ')).toContain('s3');
  expect(slotState({ materialId: direct.id, override: null }, lib, params)).toBe(params.materials[3]);
  const patched = resolve({ type: 'override', base: ref, patch: { roughness: 0.27 } });
  expect(patched.state).toEqual({ ...params.materials[3], roughness: 0.27 });
  expect(patched.warnings).toEqual(direct.warnings);
  expect(params.materials[3]!.roughness).not.toBe(0.27);

  const id = lib.createInstance({ ...params.materials[3]!, albedo: '#123456' }, 's3', 'test');
  const loaded = resolve({ type: 'instance', id, base: 's3' });
  expect(loaded.id).toBe(id); expect(loaded.state.albedo).toBe('#123456');
  expect(loaded.warnings).toEqual([]);
});
