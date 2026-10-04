import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunTransfer } from '../src/services/run-transfer';
const carry = { campaign: 'act1', kills: 24, scrap: 31, essence: 5, hp: 62, stacks: { heavy: 1 }, magazine: 12, reserve: 60 };
let href: { href: string };
beforeEach(() => {
  const items = new Map<string, string>(); href = { href: 'https://game.test/?scene=assets/scenes/act1/floor-1.scene.json' };
  vi.stubGlobal('location', href);
  vi.stubGlobal('history', { replaceState: (_s: unknown, _t: string, url: URL) => { href.href = url.href; } });
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => items.set(k, v), removeItem: (k: string) => items.delete(k) });
});
afterEach(() => vi.unstubAllGlobals());
describe('targeted cross-floor transit', () => {
  it('preserves the entry checkpoint after failed host validation and cancelled onward navigation', () => {
    const source = new RunTransfer(), path = 'assets/scenes/act1/floor-2.scene.json';
    const token = source.prepare(path, carry);
    href.href = `https://game.test/?scene=${path}&run=${token}`;
    const current = new RunTransfer(); expect(current.read(path)).toEqual(carry);
    current.retryRead(); expect(current.read(path)).toEqual(carry);
    current.prepare('assets/scenes/act1/floor-3.scene.json', { ...carry, scrap: 99 });
    expect(new RunTransfer().read(path)).toEqual(carry);
  });
  it('restores the same run identity only on the intended scene and at most once per session', () => {
    const source = new RunTransfer(), path = 'assets/scenes/act1/floor-2.scene.json';
    const token = source.prepare(path, carry);
    href.href = `https://game.test/?scene=${path}&play=1&run=${token}`;
    const target = new RunTransfer(); expect(target.read('/' + path)).toEqual(carry);
    expect(target.runId).toBe(source.runId); expect(target.read(path)).toBeNull();
    expect(new RunTransfer().read(path)).toEqual(carry); // page reload resumes same transfer
  });
  it('rejects wrong destinations and missing data; explicit restart clears the carry', () => {
    const source = new RunTransfer(); const token = source.prepare('assets/scenes/next.scene.json', carry);
    href.href = `https://game.test/?run=${token}`;
    expect(() => new RunTransfer().read('assets/scenes/wrong.scene.json')).toThrow('不匹配');
    const restarted = new RunTransfer(), old = restarted.runId; restarted.restart();
    expect(restarted.runId).not.toBe(old); expect(new URL(href.href).searchParams.has('run')).toBe(false);
    expect(new RunTransfer().read('assets/scenes/next.scene.json')).toBeNull();
    href.href = `https://game.test/?run=${token}`;
    expect(() => new RunTransfer().read('assets/scenes/next.scene.json')).toThrow('缺失');
  });
});
