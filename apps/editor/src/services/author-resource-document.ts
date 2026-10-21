import { sceneFingerprint } from '@aether/runtime';
import { readProjectFile, writeProjectFile } from '../asset-util';

/** 可复用资产的唯一历史/CAS责任；场景命令继续由 SpawnEditStore 管理。 */
export class AuthorResourceDocument<T extends { id: string; version: number }> {
  private baseline: T;
  private clean: T;
  value: T;
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  private editRevision=0;
  busy = false;
  constructor(readonly path: string, asset: T, private readonly contract: {
    label: string; validate(value: unknown): string[]; migrate(value: unknown): T;
  }) {
    this.baseline = structuredClone(asset);
    this.value = contract.migrate(asset);
    this.clean = structuredClone(this.value);
  }
  get dirty(): boolean { return sceneFingerprint(this.value) !== sceneFingerprint(this.clean); }
  get sourceVersion(): number { return this.baseline.version; }
  get undoDepth(): number { return this.undoStack.length; }
  get redoDepth(): number { return this.redoStack.length; }
  get revision(): number { return this.editRevision; }
  apply(next: T): void {
    const errors = this.contract.validate(next);
    if (errors.length) throw new Error(errors.join('；'));
    if (next.id !== this.baseline.id) throw new Error('不能改变已加载资源 GUID');
    const value = this.contract.migrate(next);
    this.undoStack.push(structuredClone(this.value)); this.redoStack = []; this.value = value; this.editRevision++;
  }
  undo(): void { const previous = this.undoStack.pop(); if (previous) { this.redoStack.push(this.value); this.value = previous; this.editRevision++; } }
  redo(): void { const next = this.redoStack.pop(); if (next) { this.undoStack.push(this.value); this.value = next; this.editRevision++; } }
  async save(port = { write: writeProjectFile }): Promise<string> {
    if (this.busy) throw new Error(`${this.contract.label} 保存进行中`);
    this.busy = true;
    const snapshot = structuredClone(this.value);
    try {
      const errors = this.contract.validate(snapshot); if (errors.length) throw new Error(errors.join('；'));
      const r = await port.write(this.path, { content: JSON.stringify(snapshot, null, 2) + '\n', baseHash: sceneFingerprint(this.baseline) });
      if (!r.ok) throw new Error(r.conflict ? '磁盘已被外部修改，保留本地草稿；请重载或合并' : r.error ?? `${this.contract.label} 保存失败`);
      this.baseline = snapshot; this.clean = structuredClone(snapshot);
      return `${this.contract.label} 资产已保存（独立于场景绑定）`;
    } finally { this.busy = false; }
  }
  async reload(port = { read: readProjectFile }): Promise<void> {
    const revision=this.editRevision;
    const r = await port.read(this.path); if (!r.ok) throw new Error(r.error ?? '重载失败');
    const errors = this.contract.validate(r.json); if (errors.length) throw new Error(errors.join('；'));
    const asset = r.json as T;
    if (asset.id !== this.baseline.id) throw new Error(`磁盘 ${this.contract.label} GUID 已改变`);
    const value = this.contract.migrate(asset);
    if(revision!==this.editRevision)throw new Error('重载期间发生新的编辑，当前草稿与历史已保留，请重试');
    this.baseline = structuredClone(asset); this.value = value; this.clean = structuredClone(value);
    this.undoStack = []; this.redoStack = [];
    this.editRevision++;
  }
}
