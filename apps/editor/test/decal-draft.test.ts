import { describe, it, expect } from 'vitest';
import raw from '../../../assets/scenes/sandbox/procedural-decal-whitebox.scene.json';
import { type SceneDocument, MAX_AUTHORED_DECALS } from '@aether/scene';
import { SpawnEditStore } from '@aether/runtime';
import { DecalDraft, newDecalMark, decalReceivers } from '../src/services/decal-draft';

const fixture = () => new SpawnEditStore(structuredClone(raw) as unknown as SceneDocument);
describe('程序贴花工作区草稿', () => {
  it('预览参数隔离，Apply 是单条作者命令，Undo/Redo 保留实例身份', () => {
    const store = fixture(), draft = new DecalDraft(), before = JSON.stringify(store.document);
    draft.select(store.document, 'nd_nav3d_low'); draft.component!.marks[0]!.seed = 42;
    expect(draft.dirty).toBe(true); expect(JSON.stringify(store.document)).toBe(before); expect(store.undoDepth).toBe(0);
    const apply = () => draft.apply(store.document, mutate => store.editNodes('贴花', mutate));
    expect(apply().ok).toBe(true); expect(draft.dirty).toBe(false); expect(store.undoDepth).toBe(1);
    const after = JSON.stringify(store.document); store.undo(); expect(JSON.stringify(store.document)).toBe(before);
    store.redo(); expect(JSON.stringify(store.document)).toBe(after);
  });
  it('拒绝无效参数、并发接收节点变更及全场超容量；不制造历史', () => {
    const store = fixture(), draft = new DecalDraft(); draft.select(store.document, 'nd_nav3d_low');
    const apply = () => draft.apply(store.document, mutate => store.editNodes('贴花', mutate));
    draft.component!.marks[0]!.rotation = [0, 0, 0, 0]; expect(apply().ok).toBe(false); expect(store.undoDepth).toBe(0);
    draft.select(store.document, draft.receiver); draft.component!.marks.push(...Array.from({ length: MAX_AUTHORED_DECALS }, (_, i) => newDecalMark(`test_${i}`)));
    expect(apply().ok).toBe(false); expect(store.undoDepth).toBe(0);
    draft.select(store.document, draft.receiver); draft.component!.marks[0]!.seed++;
    store.editNodes('外部修改', nodes => { nodes.find(n => n.id === draft.receiver)!.name = '并发修改'; });
    expect(apply().error).toContain('已变更'); expect(store.undoDepth).toBe(1);
  });
  it('删除全部贴花移除组件，放弃草稿不改变场景；不允许非静态接收者', () => {
    const store = fixture(), draft = new DecalDraft(); draft.select(store.document, 'nd_nav3d_low');
    draft.component!.marks = []; expect(draft.apply(store.document, mutate => store.editNodes('删除贴花', mutate)).ok).toBe(true);
    expect(store.document.nodes.find(n => n.id === draft.receiver)!.components.some(c => c.kind === 'Decal')).toBe(false);
    draft.component!.marks.push(newDecalMark('new')); draft.select(store.document, draft.receiver); expect(draft.dirty).toBe(false);
    expect(() => draft.select(store.document, 'missing')).toThrow('静态网格');
    expect(decalReceivers(store.document).some(n => n.id === store.document.playerStart)).toBe(false);
  });
});
