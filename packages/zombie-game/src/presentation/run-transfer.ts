import type { RunCarry } from '@aether/zombie-game';

interface Transfer { version: 1; token: string; path: string; runId: string; carry: RunCarry }
const KEY = 'aether.run-transfer.v1';
/** Tab-local transit, explicitly targeted. It cannot change scene author data or leak across tabs. */
export class RunTransfer {
  runId: string = crypto.randomUUID();
  private consumed = false;
  read(path: string): RunCarry | null {
    if (this.consumed) return null;
    const token = new URL(location.href).searchParams.get('run');
    if (!token) { this.consumed = true; return null; }
    const raw = sessionStorage.getItem(`${KEY}.${token}`) ?? sessionStorage.getItem(KEY);
    if (!raw) throw new Error('跨层存档缺失，请从起始场景重新开始');
    const t = JSON.parse(raw) as Transfer;
    if (t.version !== 1 || t.token !== token || t.path !== path.replace(/^\/+/, '') || typeof t.runId !== 'string') throw new Error('跨层存档与当前场景不匹配');
    this.runId = t.runId; this.consumed = true; return t.carry;
  }
  prepare(path: string, carry: RunCarry): string {
    const token = crypto.randomUUID();
    sessionStorage.setItem(`${KEY}.${token}`, JSON.stringify({ version: 1, token, path, runId: this.runId, carry } satisfies Transfer));
    return token;
  }
  /** Failed host validation must remain retryable and preserve the original transit record. */
  retryRead(): void { this.consumed = false; }
  restart(): void {
    this.runId = crypto.randomUUID(); this.consumed = true;
    const url = new URL(location.href), token = url.searchParams.get('run');
    if (token) sessionStorage.removeItem(`${KEY}.${token}`);
    url.searchParams.delete('run'); history.replaceState(null, '', url);
  }
}
