import { expect, it, vi } from 'vitest';
import type { SceneDocument } from '@aether/scene';
import { ActorPreloader, sceneActorIds } from '../src/services/actor-preloader';
const doc = (...ids: string[]) => ({ nodes: ids.map(id => ({ components: [{ kind: 'SpawnPoint', enabled: true, count: 2, characterId: id }] })) }) as SceneDocument;
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
it('includes later waves, deduplicates actors and excludes disabled/empty spawns', () => {
  const scene = doc('E-01', 'E-02', 'E-01', 'E-03', 'E-04');
  Object.assign(scene.nodes[1]!.components[0]!, { wave: 5 });
  Object.assign(scene.nodes[3]!.components[0]!, { enabled: false });
  Object.assign(scene.nodes[4]!.components[0]!, { count: 0 });
  expect(sceneActorIds(scene)).toEqual(['E-01', 'E-02']);
});
it('waits for the catalog, loads scene demand serially and accepts additional script/debug demand', async () => {
  let ready!: () => void;
  const library = { preload: vi.fn(async (_id: string) => true), resetFailure: vi.fn() }, changed = vi.fn(), failed = vi.fn();
  const queue = new ActorPreloader(library, new Promise<void>(r => { ready = r; }), changed, failed);
  queue.start(doc('E-01', 'E-02')); queue.request('E-01');
  await settle(); expect(library.preload).not.toHaveBeenCalled();
  ready(); await settle(); queue.request('B-01'); queue.request('B-01'); await settle();
  expect(library.preload.mock.calls.map(c => c[0])).toEqual(['E-01', 'E-02', 'B-01']);
  expect(changed).toHaveBeenCalledTimes(3); expect(failed).not.toHaveBeenCalled();
});
it('does not upload stale completions or consume the restarted session queue', async () => {
  let finishOld!: (changed: boolean) => void;
  const library = { preload: vi.fn((_id: string) => new Promise<boolean>(r => { finishOld = r; })), resetFailure: vi.fn() }, changed = vi.fn();
  const queue = new ActorPreloader(library, Promise.resolve(), changed, vi.fn());
  queue.start(doc('E-01', 'E-02')); await settle();
  const finish = finishOld; queue.stop(); library.preload.mockImplementation(async () => true);
  queue.start(doc('E-03')); await settle(); finish(true); await settle();
  expect(library.preload.mock.calls.map(c => c[0])).toEqual(['E-01', 'E-03']);
  expect(changed).toHaveBeenCalledOnce(); expect(library.resetFailure).toHaveBeenCalledWith('E-01');
});
it('reports failures instead of creating an unhandled preload rejection', async () => {
  const failed = vi.fn(), library = { preload: vi.fn(async () => { throw new Error('Upload failed'); }), resetFailure: vi.fn() };
  const queue = new ActorPreloader(library, Promise.resolve(), vi.fn(), failed);
  queue.start(doc('E-01')); await settle(); expect(failed).toHaveBeenCalledOnce();
});
