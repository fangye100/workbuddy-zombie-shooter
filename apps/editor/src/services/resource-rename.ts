import { validateSceneDocument } from '@aether/scene';
import type { SceneDocument } from '@aether/scene';
import type { SpawnEditStore } from '@aether/runtime';
import type { RenameProjectResult, ProjectFileResult } from '../asset-util';

/** Scene boot exposes /assets/... URLs; devfs reports project-relative POSIX paths.
 * Match their project identity at this adapter boundary, as the file APIs do. */
function projectRelativePath(path: string): string { return path.replace(/^\/+/, ''); }

export function renamedResourcePath(path: string, rename: RenameProjectResult): string {
  path = projectRelativePath(path);
  const old = rename.oldPath ? projectRelativePath(rename.oldPath) : null;
  const target = projectRelativePath(rename.path);
  if (!old) return path;
  if (path === old || (rename.directory && path.startsWith(`${old}/`))) return target + path.slice(old.length);
  if (!rename.directory && path === `${old}.meta.json`) return `${target}.meta.json`;
  return path;
}

/** Accept changed paths only when the author's local document remains clean throughout I/O. */
export async function refreshAuthorResources(
  store: SpawnEditStore, source: string, rename: RenameProjectResult,
  read: (path: string) => Promise<ProjectFileResult>,
  canAccept: () => boolean = () => true,
): Promise<{ status: 'unaffected' | 'refreshed' | 'conflict' | 'failed'; source: string; message: string }> {
  const current = projectRelativePath(source);
  const next = renamedResourcePath(current, rename);
  const updated = rename.updatedFiles?.some((path) => projectRelativePath(path) === next);
  if (next === current && !updated) return { status: 'unaffected', source: next, message: '' };
  const conflict = () => ({ status: 'conflict' as const, source: next, message: '资源改名已落盘；本地作者修改已保留，磁盘引用版本已变化，请先处理保存冲突再重新打开场景' });
  if (store.dirty || !canAccept()) return conflict();
  const result = await read(next);
  if (store.dirty || !canAccept()) return conflict();
  if (!result.ok) return { status: 'failed', source: next, message: `重读改名后的场景失败：${result.error ?? result.status}` };
  const errors = validateSceneDocument(result.json).filter((d) => d.severity === 'error');
  if (errors.length) return { status: 'failed', source: next, message: `改名后的场景校验失败：${errors[0]!.message}` };
  store.reload(result.json as SceneDocument);
  return { status: 'refreshed', source: next, message: '作者文档已接受改名后的引用与版本' };
}
