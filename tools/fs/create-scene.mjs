/** Register a new scene under the shared project lock. Never overwrite an existing file. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withProjectWriteLock, atomicWriteText } from './project-write.mjs';

export async function createProjectScene(root, rel, document, validateProject) {
  if (!/^assets\/scenes\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.scene\.json$/.test(rel)) {
    throw new Error('场景路径须位于 assets/scenes，文件名仅用字母、数字、短横线或下划线');
  }
  return withProjectWriteLock(root, async () => {
    const target = path.resolve(root, rel);
    const projectPath = path.join(root, 'aether.project.json');
    const project = JSON.parse(await fs.readFile(projectPath, 'utf8'));
    if (validateProject(project).some(d => d.severity === 'error')) throw new Error('项目文件校验失败');
    if (project.scenes.some(s => s.id === document.id || s.path.toLowerCase() === rel.toLowerCase())) throw new Error('场景路径或 ID 已登记');
    // Reject symlink/junction parents: lexical containment alone is insufficient.
    let parent = path.dirname(target);
    for (;;) {
      try {
        const real = await fs.realpath(parent);
        const rootReal = await fs.realpath(root);
        const relative = path.relative(rootReal, real);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('场景目录越出项目根');
        break;
      } catch (e) { if (e.code !== 'ENOENT') throw e; parent = path.dirname(parent); }
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
    try {
      project.scenes.push({ path: rel, id: document.id, name: document.name, enabled: true });
      await atomicWriteText(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    } catch (error) {
      await fs.unlink(target);
      throw error;
    }
    return { ok: true, path: rel, id: document.id };
  });
}
