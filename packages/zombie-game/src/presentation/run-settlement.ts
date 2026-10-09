import { gameText as g, gameLanguage } from './game-language';
import type { RuntimeSession } from '@aether/zombie-game';
import { RunProfile } from './run-profile';

export class RunSettlement {
  private readonly root = document.createElement('div');
  private stamp = '';
  constructor(private readonly profile: RunProfile, private readonly runId: () => string) {
    this.root.className = 'run-settlement'; this.root.hidden = true;
    document.getElementById('center')!.append(this.root);
  }
  update(runtime: RuntimeSession | null): void {
    const p = runtime?.progress;
    this.root.hidden = !p || runtime?.outcome === 'running' || (p.choosing && runtime?.outcome !== 'game-over');
    if (this.root.hidden || !runtime || !p) { this.stamp = ''; return; }
    const stamp = `${gameLanguage()}:${runtime.runId}:${runtime.outcome}:${p.essence}`;
    if (stamp === this.stamp) return;
    this.stamp = stamp; this.root.replaceChildren();
    try {
      const save = this.profile.credit(p.rules.campaign, this.runId(), p.essence);
      const heading = document.createElement('strong');
      heading.textContent = g(runtime.outcome === 'game-over' ? '本局结算 · 流派归零，尸髓保留' : '楼层结算 · 成长带入下一层');
      const summary = document.createElement('p');
      summary.textContent = g(`击杀 ${p.kills} · 本局累计尸髓 ${p.essence} · 永久尸髓余额 ${save.essence}`);
      this.root.append(heading, summary);
      for (const t of p.rules.talents.filter(t => t.unlockCost !== undefined)) {
        const b = document.createElement('button'), owned = save.unlocked.includes(t.id);
        b.textContent = g(owned ? `${t.name} · 已解锁` : `解锁 ${t.name} · ${t.unlockCost} 尸髓`);
        b.title = g(`${t.description}（加入后续强化选项，不直接增加属性）`);
        b.disabled = owned || save.essence < t.unlockCost!;
        b.onclick = () => {
          try { if (this.profile.unlock(p.rules, t.id)) { p.setUnlocked(this.profile.read(p.rules.campaign).unlocked); this.stamp = ''; } }
          catch (e) { summary.textContent = g(`存档失败：${String(e)}`); }
        };
        this.root.append(b);
      }
    } catch (e) {
      this.root.textContent = g(`结算保存失败：${String(e)}。奖励仍保留在本局。`);
      const retry = document.createElement('button'); retry.textContent = g('重试结算'); retry.onclick = () => { this.stamp = ''; };
      this.root.append(retry);
    }
  }
}
