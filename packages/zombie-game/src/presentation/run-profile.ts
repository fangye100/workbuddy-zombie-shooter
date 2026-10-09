import type { RunRulesComponent } from '@aether/scene';

interface Profile { version: 1; essence: number; unlocked: string[]; credited: Record<string, number> }
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
/** Player save data, separate from scene authoring. Credit cumulative run rewards once. */
export class RunProfile {
  constructor(private readonly storage: StoragePort) {}
  private key(campaign: string): string { return `aether.profile.v1.${campaign}`; }
  read(campaign: string): Profile {
    const raw = this.storage.getItem(this.key(campaign));
    if (raw === null) return { version: 1, essence: 0, unlocked: [], credited: {} };
    const p = JSON.parse(raw) as Profile;
    if (!p || p.version !== 1 || !Number.isSafeInteger(p.essence) || p.essence < 0
      || !Array.isArray(p.unlocked) || !p.unlocked.every(id => typeof id === 'string')
      || !p.credited || typeof p.credited !== 'object' || Array.isArray(p.credited)
      || !Object.values(p.credited).every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('尸髓存档损坏，未覆盖原存档');
    return p;
  }
  credit(campaign: string, runId: string, total: number): Profile {
    if (!runId || !Number.isSafeInteger(total) || total < 0) throw new Error('结算奖励无效');
    const p = this.read(campaign), previous = Object.hasOwn(p.credited, runId) ? p.credited[runId]! : 0;
    if (total <= previous) return p;
    p.essence += total - previous;
    Object.defineProperty(p.credited, runId, { value: total, enumerable: true, configurable: true, writable: true });
    this.storage.setItem(this.key(campaign), JSON.stringify(p));
    return p;
  }
  unlock(rules: RunRulesComponent, id: string): boolean {
    const t = rules.talents.find(t => t.id === id);
    if (!t?.unlockCost) return false;
    const p = this.read(rules.campaign);
    if (p.unlocked.includes(id) || p.essence < t.unlockCost) return false;
    p.essence -= t.unlockCost; p.unlocked.push(id);
    this.storage.setItem(this.key(rules.campaign), JSON.stringify(p)); return true;
  }
}
