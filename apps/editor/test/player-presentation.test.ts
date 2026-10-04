import { describe, expect, it, vi } from 'vitest';
import { migrateToLatest, validateSceneDocument, type SceneDocument } from '@aether/scene';
import { PlayerPresentation } from '../src/services/player-presentation';
import { PlayController } from '../src/services/play-controller';
import { RuntimeBridge } from '../src/services/runtime-bridge';
import { snapshotObjects, restoreObjects } from '../src/services/author-snapshot';
import type { LabRenderer } from '../src/renderer';

const files = import.meta.glob('../../../assets/scenes/act1/floor-*.scene.json', { eager: true });
const scenes = Object.values(files).map(m => (m as { default: SceneDocument }).default);
function setup(doc = structuredClone(scenes[0]!)) {
  const node = doc.nodes.find(n => n.id === doc.playerStart)!;
  const mesh = node.components.find(c => c.kind === 'MeshRenderer')!;
  const object = { pos: [...node.transform.position] as [number, number, number], quat: [...node.transform.rotation] as [number, number, number, number],
    rot: [0, 0, 0] as [number, number, number], visible: true, pickable: true, bob: 0, removed: false,
    ...(mesh.source.type === 'asset' ? { loadedAssetPath: mesh.source.ref.path } : {}),
    name: node.name, category: node.category ?? '', subMeshes: [{ visible: true }], scale: 1 };
  const visual = new PlayerPresentation(id => id === node.id ? object : null);
  const release = vi.fn();
  const renderer = {
    getDocument: () => doc,
    snapshotAuthorState: () => snapshotObjects([object], 0),
    restoreAuthorState: (snap: ReturnType<typeof snapshotObjects>) => restoreObjects([object], snap),
    findObjectIndexByNodeId: (id: string) => id === node.id ? 0 : null,
    setObjectVisible: (_index: number, visible: boolean) => { object.visible = visible; },
    core: { releaseDynamicResources: release },
  };
  const bridge = new RuntimeBridge();
  const ctl = new PlayController(renderer as unknown as LabRenderer, bridge, { playerPresentation: visual });
  return { doc, node, mesh, object, visual, ctl, bridge, release };
}

describe('scene-authored player presentation', () => {
  it('all campaign floors persist the same asset identity and explicit binding', () => {
    for (const doc of scenes) {
      const { mesh } = setup(structuredClone(doc));
      expect(validateSceneDocument(doc).filter(d => d.severity === 'error')).toEqual([]);
      expect(mesh.playBinding).toBe('player');
      expect(mesh.source).toMatchObject({ type: 'asset', ref: { guid: 'as_yrsn456i' } });
      if (mesh.source.type === 'asset') expect(doc.dependencies).toContain(mesh.source.ref.path);
    }
  });

  it('v7 migration is opt-in and does not invent a player mesh binding', () => {
    const { doc, mesh } = setup();
    delete mesh.playBinding; doc.schemaVersion = 7;
    const result = migrateToLatest(doc);
    expect(result.to).toBe(8);
    expect(result.applied).toEqual(['support-player-mesh-binding']);
    expect(result.doc.nodes).toEqual(doc.nodes);
    expect(doc.schemaVersion).toBe(7);
  });

  it('rejects a binding on a non-player node or editor-only marker', () => {
    const { doc, node, mesh } = setup();
    mesh.editorOnly = true;
    expect(validateSceneDocument(doc).some(d => d.code === 'E_PLAY_BINDING_SOURCE')).toBe(true);
    mesh.editorOnly = false; doc.playerStart = doc.nodes.find(n => n.id !== node.id)!.id;
    expect(validateSceneDocument(doc).some(d => d.code === 'E_PLAY_BINDING')).toBe(true);
  });

  it('failed/pending asset loading leaves author state intact and refuses Play', () => {
    const { object, ctl, bridge } = setup(); delete object.loadedAssetPath;
    const before = structuredClone(object);
    expect(ctl.start()).toBe(false);
    expect(ctl.error).toContain('玩家外观资产尚未成功加载');
    expect(object).toEqual(before); expect(bridge.active).toBe(false);
    expect(ctl.ledger.pending).toBe(0);
  });

  it('movement/turn/reset/Stop use the real runtime without duplicate player instances or document writes', () => {
    const { object, ctl, bridge, doc, release } = setup();
    const authored = JSON.stringify(doc);
    const before = structuredClone(object);
    for (let run = 0; run < 3; run++) {
      expect(ctl.start()).toBe(true);
      const rt = ctl.session.runtime!;
      const count = () => bridge.batches()!.reduce((sum, b) => sum + b.count, 0);
      expect(count()).toBe(bridge.entities.filter(e => e.kind === 'npc').length);
      rt.setInput(1, 0);
      for (let tick = 0; tick < 8; tick++) ctl.update(1 / 30);
      const p = rt.player()!;
      expect(p.x).toBeGreaterThan(before.pos[0]);
      expect(object.pos).toEqual([p.x, before.pos[1], p.z]);
      const yaw = [0, Math.sin(p.yaw / 2), 0, Math.cos(p.yaw / 2)];
      object.quat.forEach((v, i) => expect(v).toBeCloseTo(yaw[i]!, 5));
      ctl.pause(); rt.setInput(0, 1); ctl.step();
      expect(object.pos[2]).toBeCloseTo(rt.player()!.z);
      ctl.reset(); expect(object.pos).toEqual(before.pos);
      expect(JSON.stringify(doc)).toBe(authored);
      ctl.stop(); expect(object).toEqual(before); expect(ctl.ledger.pending).toBe(0);
      expect(bridge.batches()).toBeNull();
    }
    expect(release).toHaveBeenCalledTimes(3);
  });

  it('hides a dead player and restores visibility on reset', () => {
    const { visual, ctl, object } = setup(); expect(ctl.start()).toBe(true);
    const p = ctl.session.runtime!.player()!;
    visual.sync({ ...p, hp: 0 }); expect(object.visible).toBe(false);
    ctl.reset(); expect(object.visible).toBe(true);
    ctl.stop(); expect(object.visible).toBe(true);
  });

  it('unbound scenes use one capsule and hide the authored marker only until Stop', () => {
    const { mesh, ctl, object, bridge } = setup(); delete mesh.playBinding;
    expect(ctl.start()).toBe(true); expect(object.visible).toBe(false);
    expect(bridge.batches()!.reduce((sum, b) => sum + b.count, 0)).toBe(bridge.entities.length);
    ctl.stop(); expect(object.visible).toBe(true);
  });
});
