/** Project scene discovery and navigation. Author data remains in SpawnEditStore. */
import { validateProject, migrateToLatest, type AetherProject } from '@aether/scene';
import { readProjectFile } from '../asset-util';

export interface SceneChoice { path: string; id: string; name: string; enabled: boolean; start: boolean }
export function sceneChoices(raw: unknown): SceneChoice[] {
  const errors = validateProject(raw).filter(d => d.severity === 'error');
  if (errors.length) throw new Error(`项目校验失败：${errors[0]!.code}`);
  const p = raw as AetherProject;
  return p.scenes.map((s, i) => ({ path: s.path.replace(/^\/+/, ''), id: s.id,
    name: (s as typeof s & { name?: string }).name || s.path.split('/').pop()!, enabled: s.enabled, start: i === (p.startIndex ?? 0) }));
}
export async function readSceneChoices(): Promise<SceneChoice[]> {
  const p = await readProjectFile('aether.project.json');
  if (!p.ok) throw new Error(p.error ?? '项目读取失败');
  return sceneChoices(p.json);
}
export function sceneUrl(current: string, path: string): string {
  const url = new URL(current);
  url.searchParams.set('scene', path.replace(/^\/+/, ''));
  url.searchParams.delete('play');
  return url.href;
}
/** Preflight before navigation: unreadable/invalid documents must not evict the current work. */
export async function checkScene(path: string): Promise<void> {
  const r = await readProjectFile(path);
  if (!r.ok) throw new Error(r.error ?? '场景读取失败');
  const m = migrateToLatest(r.json);
  const error = m.diagnostics.find(d => d.severity === 'error');
  if (error) throw new Error(`场景校验失败：${error.path} ${error.code}`);
}
/** Play progression uses enabled scenes in the same act, never derived simulation snapshots. */
export async function nextPlayableScene(currentPath: string, act: string | null): Promise<SceneChoice | null> {
  if (act === null) return null;
  const choices = await readSceneChoices();
  const index = choices.findIndex(c => c.path === currentPath.replace(/^\/+/, ''));
  if (index < 0) return null;
  for (const c of choices.slice(index + 1)) {
    if (!c.enabled || c.path.startsWith('assets/scenes/sim/')) continue;
    const r = await readProjectFile(c.path);
    if (!r.ok) throw new Error(`${c.path}：${r.error}`);
    const m = migrateToLatest(r.json);
    if (m.diagnostics.some(d => d.severity === 'error')) throw new Error(`${c.path}：场景校验失败`);
    if (m.doc.act === act) return c;
  }
  return null;
}
