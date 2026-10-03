import { describe, expect, it } from 'vitest';
import { sceneFingerprint } from '@aether/runtime';
import { BindingSession } from '../src/services/binding/binding-session';
import { BindingPersistence } from '../src/services/binding/binding-persistence';
const modules = import.meta.glob('../../../assets/characters/models/E-04/game_ready/E04_20260901_010134_1600tris.glb.meta.json', { eager: true });
const fixture = () => JSON.parse(JSON.stringify((Object.values(modules)[0] as { default: unknown }).default)) as Record<string, unknown>;

describe('binding accepted version contract', () => {
  it('uses the accepted load baseline and preserves local session/history on conflict', async () => {
    const p = new BindingPersistence(); const meta = fixture(); const session = new BindingSession();
    expect(p.accept('model.glb.meta.json', meta)).toBeNull();
    session.poseJoint('Head', [0, 2, 0]); const edited = session.getEditorData(); const history = session.historyDepth();
    const currentHash = sceneFingerprint({ ...meta, userData: { otherWriter: true } });
    const result = await p.save(edited, async (r) => {
      expect(r.baseHash).toBe(sceneFingerprint(meta));
      expect(r.candidate.userData).toEqual(meta.userData);
      return { ok: false, status: 409, conflict: true, currentHash, error: 'conflict' };
    });
    expect(result.currentHash).toBe(currentHash); expect(session.getEditorData()).toMatchObject({ ...edited, savedAt: expect.any(String) });
    expect(session.historyDepth()).toEqual(history); expect(p.prepare(edited).baseHash).toBe(sceneFingerprint(meta));
  });
  it('captures immutable data before I/O, accepts successful version and leaves edits during save in the session', async () => {
    const p = new BindingPersistence(); const meta = fixture(); p.accept('m.meta.json', meta);
    const s = new BindingSession(); s.poseJoint('Head', [0, 2, 0]); const before = s.getEditorData();
    let finish!: () => void; const gate = new Promise<void>((r) => { finish = r; });
    const pending = p.save(before, async (r) => { await gate; expect(r.patch.bindingEditor).toEqual(before); return { ok: true, status: 200, error: null, hash: sceneFingerprint(r.candidate) }; });
    expect(() => p.prepare(before)).toThrow('尚未完成'); s.poseJoint('Head', [0, 3, 0]); finish(); await pending;
    expect(s.positions.Head).toEqual([0, 3, 0]);
    expect(p.prepare(s.getEditorData()).baseHash).toBe(sceneFingerprint({ ...meta, bindingEditor: before }));
  });
  it('rejects invalid metadata and releases saving after I/O failure for retry', async () => {
    const p = new BindingPersistence(); expect(p.accept('bad.meta.json', {})).toContain('校验失败');
    expect(() => p.prepare({})).toThrow('基准版本'); const meta = fixture(); p.accept('m.meta.json', meta);
    const data = new BindingSession().getEditorData();
    await expect(p.save(data, async () => { throw new Error('disk failed'); })).rejects.toThrow('disk failed');
    expect(p.prepare(data).baseHash).toBe(sceneFingerprint(meta));
    expect((await p.save(data, async () => ({ ok: true, status: 200, error: null }))).ok).toBe(true);
  });
  it('does not accept a completed save into a different asset loaded while I/O is pending', async () => {
    const p = new BindingPersistence(); const old = fixture(); p.accept('old.meta.json', old);
    const data = new BindingSession().getEditorData();
    await p.save(data, async () => { p.accept('new.meta.json', { ...old, userData: { newer: true } }); return { ok: true, status: 200, error: null, hash: 'old-result' }; });
    const next = p.prepare(data); expect(next.path).toBe('new.meta.json'); expect(next.baseHash).not.toBe('old-result');
  });
});
