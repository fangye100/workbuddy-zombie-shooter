import { it, expect } from 'vitest';
import { SpawnEditStore } from '../src/spawn-edit';
import type { SceneDocument } from '@aether/scene';
const scene = Object.values(import.meta.glob('/assets/scenes/act1/floor-1.scene.json', {eager:true,import:'default'}))[0] as SceneDocument;
it('rejects invalid atmosphere before mutation and restores valid edits through undo/redo', () => {
  const store = new SpawnEditStore(scene), original = structuredClone(store.document.environment);
  const bad = structuredClone(original); bad.sky!.cloudCoverage = 1.2;
  expect(store.setEnvironment(bad).ok).toBe(false); expect(store.document.environment).toEqual(original);
  expect(store.undo()).toBeNull();
  const good = structuredClone(original); good.sky!.cloudCoverage = 0.6; good.comic!.inkColor = '#302030';
  expect(store.setEnvironment(good).ok).toBe(true); expect(store.document.environment).toEqual(good);
  store.undo(); expect(store.document.environment).toEqual(original);
  store.redo(); expect(store.document.environment).toEqual(good);
});
