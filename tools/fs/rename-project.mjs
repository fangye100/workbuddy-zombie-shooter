/** Recoverable multi-file rename transaction, coordinated with GUI and offline MCP saves. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withProjectWriteLock, atomicWriteText } from './project-write.mjs';
import { pathRewriter, rewriteResourcePaths } from './resource-paths.mjs';

const posix = (p) => p.split(path.sep).join('/');
const exists = async (p) => { try { await fs.lstat(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const same = async (a, b) => { const [x, y] = await Promise.all([fs.stat(a), fs.stat(b)]); return x.dev === y.dev && x.ino === y.ino; };
export async function renameProject(root, abs, target, insensitive, maxSceneVersion) {
  return withProjectWriteLock(root, async () => {
    const realRoot = await fs.realpath(root);
    const inside = (p) => p === realRoot || p.startsWith(realRoot + path.sep);
    const assertInside = async (p) => { if (!inside(await fs.realpath(p))) throw new Error(`引用或源路径经链接越出项目根：${p}`); };
    await assertInside(abs); await assertInside(path.dirname(target));
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink()) throw new Error('不支持对链接条目改名');
    const directory = st.isDirectory();
    const oldPath = posix(path.relative(root, abs)); const newPath = posix(path.relative(root, target));
    if (oldPath === '.workbuddy' || oldPath.startsWith('.workbuddy/')) throw new Error('协调与恢复目录不允许改名');
    if (await exists(target) && !await same(abs, target)) return { status: 409, ok: false, error: `目标名字已存在：${newPath}` };
    const meta = `${abs}.meta.json`; const targetMeta = `${target}.meta.json`;
    const hasMeta = !directory && await exists(meta);
    if (hasMeta) {
      await assertInside(meta);
      if (await exists(targetMeta) && !await same(meta, targetMeta)) return { status: 409, ok: false, error: '目标 sidecar 已存在' };
    }
    const rewrite = pathRewriter(oldPath, newPath, directory, insensitive);
    if (rewrite('assets/_data/asset-manifest.json') !== 'assets/_data/asset-manifest.json') throw new Error('asset-manifest.json 当前消费端使用固定路径，不支持改名该清单或其父目录');
    const docs = new Map();
    const add = async (p, kind, required = false) => {
      if (docs.has(p)) return;
      if (!await exists(p)) { if (required) throw new Error(`登记引用不存在：${p}`); return; }
      await assertInside(p);
      const text = await fs.readFile(p, 'utf8'); let json;
      try { json = JSON.parse(text); } catch { throw new Error(`引用文件 JSON 不合法：${p}`); }
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`引用文件根结构不合法：${p}`);
      docs.set(p, { kind, text, json });
    };
    const projectPath = path.join(root, 'aether.project.json');
    await add(projectPath, 'project'); const project = docs.get(projectPath)?.json;
    const resolveRef = (rel) => {
      if (typeof rel !== 'string' || path.win32.isAbsolute(rel) || path.posix.isAbsolute(rel)) throw new Error(`非法项目引用：${rel}`);
      const p = path.resolve(root, rel); if (!inside(p)) throw new Error(`项目引用越界：${rel}`); return p;
    };
    for (const entry of project?.scenes ?? []) {
      const p = resolveRef(entry.path);
      // Legacy generic JSON registration is a project path slot, not a SceneDocument contract.
      if (p.endsWith('.scene.json') || p.endsWith('.prefab.json')) await add(p, 'scene', true);
    }
    const walk = async (dir) => {
      if (!await exists(dir)) return;
      await assertInside(dir);
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`资产扫描含链接，无法完整确认引用：${p}`);
        if (entry.isDirectory()) await walk(p);
        else if (entry.name.endsWith('.scene.json') || entry.name.endsWith('.prefab.json')) await add(p, 'scene');
        else if (entry.name.endsWith('.meta.json')) await add(p, 'meta');
      }
    };
    for (const rel of project?.assetRoots ?? ['assets']) await walk(resolveRef(rel));
    await add(path.join(root, 'assets/_data/asset-manifest.json'), 'manifest');
    const updates = [];
    for (const [p, doc] of docs) {
      try {
        const relative = posix(path.relative(root, p));
        const identity = (s) => insensitive ? s.toLowerCase() : s;
        const destination = hasMeta && identity(relative) === identity(`${oldPath}.meta.json`) ? `${newPath}.meta.json` : rewrite(relative);
        if (rewriteResourcePaths(doc.json, doc.kind, rewrite, maxSceneVersion)) updates.push({ before: p, after: resolveRef(destination), ...doc, out: `${JSON.stringify(doc.json, null, 2)}\n` });
      } catch (e) { throw new Error(`${posix(path.relative(root, p))}: ${e.message}`); }
    }
    // A durable journal precedes every mutation. Interrupted transactions block future writers
    // via the retained project lock; these byte copies are sufficient for explicit recovery.
    const journalDir = path.join(realRoot, '.workbuddy/cache/rename-recovery', randomUUID());
    await fs.mkdir(journalDir, { recursive: true });
    const journal = { state: 'prepared', oldPath, newPath, directory, hasMeta,
      updates: updates.map((u, i) => ({ before: posix(path.relative(root, u.before)), after: posix(path.relative(root, u.after)), backup: `${i}.json` })) };
    for (let i = 0; i < updates.length; i++) await fs.writeFile(path.join(journalDir, `${i}.json`), updates[i].text, { flag: 'wx' });
    await atomicWriteText(path.join(journalDir, 'transaction.json'), JSON.stringify(journal, null, 2));
    let moved = false; let metaMoved = false; const written = [];
    try {
      await fs.rename(abs, target); moved = true;
      if (hasMeta) { await fs.rename(meta, targetMeta); metaMoved = true; }
      for (const u of updates) { await atomicWriteText(u.after, u.out); written.push(u); }
      journal.state = 'committed'; await atomicWriteText(path.join(journalDir, 'transaction.json'), JSON.stringify(journal, null, 2));
    } catch (error) {
      const rollbackErrors = [];
      for (const u of written.reverse()) try { await atomicWriteText(u.after, u.text); } catch (e) { rollbackErrors.push(`${u.after}: ${e}`); }
      if (metaMoved) try { await fs.rename(targetMeta, meta); } catch (e) { rollbackErrors.push(`sidecar: ${e}`); }
      if (moved) try { await fs.rename(target, abs); } catch (e) { rollbackErrors.push(`source: ${e}`); }
      journal.state = rollbackErrors.length ? 'recovery-required' : 'rolled-back'; journal.error = String(error); journal.rollbackErrors = rollbackErrors;
      await atomicWriteText(path.join(journalDir, 'transaction.json'), JSON.stringify(journal, null, 2)).catch(() => {});
      if (rollbackErrors.length) {
        // Prevent subsequent coordinated writes from compounding an incomplete rollback.
        await fs.writeFile(path.join(realRoot, '.workbuddy/cache/fs-coordination.lock', 'recovery-required.json'), JSON.stringify({ journalDir, rollbackErrors }));
      }
      return { status: 500, ok: false, error: `改名事务失败${rollbackErrors.length ? '，需要恢复' : '，已完整回滚'}：${error}`, recoveryPath: journalDir, rollbackErrors };
    }
    return { status: 200, ok: true, oldPath, directory, path: newPath, metaRenamed: hasMeta,
      projectUpdated: updates.some((u) => u.kind === 'project'), projectError: null,
      updatedFiles: updates.map((u) => posix(path.relative(root, u.after))), recoveryPath: journalDir };
  });
}
