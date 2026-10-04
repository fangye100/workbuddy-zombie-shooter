/** Supported author mutations and snapshot-based scene persistence. No UI or renderer state. */
import { validateSceneDocument, type SceneDocument, type SceneNode } from '@aether/scene';
import { changedJsonPaths, cloneDocument, sceneFingerprint, validateQuat, validateSpawnValue } from '@aether/runtime';
import type { JsonDiffEntry, SpawnEditStore } from '@aether/runtime';
import { ENVIRONMENT_EDIT_PATHS, validEnvironmentValues } from '@aether/runtime';
import { readProjectFile, writeProjectFile } from '../asset-util';
import type { ProjectFileResult, WriteResult } from '../asset-util';

/** Field authority follows node/component identity, not just a permissive path regexp. */
export function authorSaveViolations(base: SceneDocument, saved: SceneDocument, inserted: SceneNode[] = []): JsonDiffEntry[] {
  if (inserted.length > 0) {
    const ids = new Set(inserted.map((node) => node.id));
    const violations: JsonDiffEntry[] = [];
    for (const original of inserted) {
      const next = saved.nodes.find((node) => node.id === original.id);
      if (next) violations.push(...authorSaveViolations({ ...base, nodes: [original] }, { ...base, nodes: [next] }));
    }
    for (const diagnostic of validateSceneDocument(saved).filter((d) => d.severity === 'error')) {
      violations.push({ path: diagnostic.message, before: null, after: 'invalid scene' });
    }
    return [...violations, ...authorSaveViolations(
      { ...base, nodes: base.nodes.filter((node) => !ids.has(node.id)) },
      { ...saved, nodes: saved.nodes.filter((node) => !ids.has(node.id)) },
    )];
  }
  const allowed = new Set<string>();
  if (validEnvironmentValues(saved.environment)) {
    for (const path of ENVIRONMENT_EDIT_PATHS) allowed.add(`environment.${path}`);
  }
  for (let index = 0; index < base.nodes.length; index++) {
    const node = base.nodes[index]!;
    const next = saved.nodes[index];
    if (next?.id !== node.id) continue;
    for (const [field, length] of [['position', 3], ['rotation', 4], ['scale', 3]] as const) {
      const before = node.transform[field]; const after = next.transform?.[field];
      if (!Array.isArray(after) || after.length !== length || before.length !== length) continue;
      if (!after.every((value) => typeof value === 'number' && Number.isFinite(value))) continue;
      if (field === 'rotation' && validateQuat(after) !== null) continue;
      for (let axis = 0; axis < length; axis++) allowed.add(`nodes[${index}].transform.${field}[${axis}]`);
    }
    for (let component = 0; component < node.components.length; component++) {
      const before = node.components[component]!; const after = next.components[component];
      if (before.kind !== 'SpawnPoint' || after?.kind !== 'SpawnPoint') continue;
      for (const field of ['radius', 'count'] as const) {
        if (validateSpawnValue(field, after[field]) === null) allowed.add(`nodes[${index}].components[${component}].${field}`);
      }
    }
  }
  return changedJsonPaths(base, saved).filter((change) => !allowed.has(change.path));
}

export interface AuthorSceneSavePort {
  read(path: string): Promise<ProjectFileResult>;
  write(path: string, body: { content: string; baseHash: string }): Promise<WriteResult>;
}
export interface AuthorSaveResult {
  ok: boolean;
  status: 'saved' | 'noop' | 'busy' | 'rejected' | 'conflict' | 'failed';
  message: string;
  diffCount: number;
}

export class AuthorSceneSaver {
  private inFlight = false;
  constructor(private readonly port: AuthorSceneSavePort = { read: readProjectFile, write: writeProjectFile }) {}

  async save(store: SpawnEditStore, path: string): Promise<AuthorSaveResult> {
    const result = (status: AuthorSaveResult['status'], message: string, diffCount = 0): AuthorSaveResult => ({
      ok: status === 'saved', status, message, diffCount,
    });
    if (this.inFlight) return result('busy', '上一次保存尚未完成，稍候再试');
    this.inFlight = true;
    try {
      // Capture and validate exactly the payload sent, before the first asynchronous boundary.
      const snapshot = store.beginSave();
      const base = cloneDocument(store.committedDocument);
      const diffs = changedJsonPaths(base, snapshot.doc);
      if (diffs.length === 0) return result('noop', '没有改动需要保存');
      const violations = authorSaveViolations(base, snapshot.doc, store.insertedAssetNodes);
      if (violations.length > 0) return result('rejected',
        `拒绝保存：检测到 ${violations.length} 处不受支持的作者字段改动（如 ${violations[0]!.path}）`, diffs.length);
      const baseHash = sceneFingerprint(base);
      const disk = await this.port.read(path);
      if (!disk.ok) return result('failed', `保存失败：读不到磁盘基准版本（${disk.error ?? `HTTP ${disk.status}`}）`, diffs.length);
      const diskHash = sceneFingerprint(disk.json);
      if (diskHash !== baseHash) return result('conflict',
        `拒绝保存：磁盘上的场景已被外部修改（基准 ${baseHash} → 磁盘 ${diskHash}）。本地编辑已保留，请重新装载或人工合并。`, diffs.length);
      const content = `${JSON.stringify(snapshot.doc, null, 2)}\n`;
      const written = await this.port.write(path, { content, baseHash });
      if (!written.ok) return result(written.conflict ? 'conflict' : 'failed', written.conflict
        ? `拒绝保存：服务端确认磁盘已被外部修改（当前 ${written.currentHash ?? '?'}）。本地编辑已保留，请重新装载或人工合并。`
        : `保存失败：${written.error ?? `HTTP ${written.status}`}。本地编辑已保留。`, diffs.length);
      store.confirmSave(snapshot.doc, snapshot.lastEditId);
      return result('saved', `已保存 ${written.bytes ?? content.length} 字节 · ${diffs.length} 处改动 · 无关字段原样保留`
        + (store.dirty ? '（保存期间的新修改仍为未保存）' : ''), diffs.length);
    } catch (error) {
      return result('failed', `保存失败：${String(error)}。本地编辑已保留。`);
    } finally {
      this.inFlight = false;
    }
  }
}
