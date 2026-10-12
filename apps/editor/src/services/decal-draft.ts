import { type SceneDocument, type SceneNode, type DecalComponent, type DecalMark, validateDecalMark } from '@aether/scene';
import type { EditResult } from '@aether/runtime';

export function decalReceivers(doc: SceneDocument): SceneNode[] {
  return doc.nodes.filter(n => n.id !== doc.playerStart && n.components.some(c => c.kind === 'MeshRenderer' && c.enabled && !c.playBinding && !c.sharedMotion && !c.bodyIk));
}
export function newDecalMark(id: string): DecalMark {
  return { id, pattern: 'splatter', position: [0, 0, 0], rotation: [0, 0, 0, 1], size: [1, 1], color: '#932F32', opacity: .85, seed: 31, normalOffset: .008, priority: 0 };
}
/** 临时参数不是第二份作者状态；只通过统一作者命令应用，并检测接收节点并发修改。 */
export class DecalDraft {
  receiver = ''; component: DecalComponent | null = null;
  private source = ''; private original = '';
  get dirty(): boolean { return this.component !== null && JSON.stringify(this.component) !== this.original; }
  select(doc: SceneDocument, id: string): void {
    const node = decalReceivers(doc).find(n => n.id === id);
    if (!node) throw new Error('接收节点必须是静态网格');
    this.receiver = id; this.source = JSON.stringify(node);
    this.component = structuredClone(node.components.find(c => c.kind === 'Decal') ?? { kind: 'Decal', enabled: true, marks: [] });
    this.original = JSON.stringify(this.component);
  }
  apply(doc: SceneDocument, edit: (mutate: (nodes: SceneNode[]) => void) => EditResult): EditResult {
    const fail = (error: string): EditResult => ({ ok: false, edit: null, error });
    if (!this.component || !this.dirty) return fail('值没有变化');
    const current = doc.nodes.find(n => n.id === this.receiver);
    if (!current || JSON.stringify(current) !== this.source) return fail('接收节点已变更，请放弃草稿并重新选择');
    const errors = this.component.marks.flatMap(validateDecalMark);
    if (errors.length) return fail(errors.join('；'));
    const next = structuredClone(this.component);
    const result = edit(nodes => {
      const node = nodes.find(n => n.id === this.receiver);
      if (!node || JSON.stringify(node) !== this.source) throw new Error('接收节点已变更');
      node.components = node.components.filter(c => c.kind !== 'Decal');
      if (next.marks.length) node.components.push(next);
    });
    if (result.ok) this.select(doc, this.receiver);
    return result;
  }
  clear(): void { this.receiver = ''; this.component = null; this.source = ''; this.original = ''; }
}
