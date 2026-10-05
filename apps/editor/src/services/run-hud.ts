import type { RuntimeSession } from '@aether/runtime';

/** Presentation only. Every purchase/choice is validated by the simulation owner. */
export class RunHud {
  private readonly root = document.createElement('section');
  private readonly info = document.createElement('div');
  private readonly choices = document.createElement('div');
  private readonly supply = document.createElement('div');
  private readonly heal = document.createElement('button');
  private readonly buy = document.createElement('button');
  private readonly cancel = document.createElement('button');
  private readonly assist = document.createElement('button');
  private readonly reload = document.createElement('button');
  private readonly ammo = document.createElement('button');
  private current: RuntimeSession | null = null;
  private offerStamp = '';
  constructor() {
    this.root.className = 'run-hud'; this.root.hidden = true; this.root.setAttribute('aria-label', '本局成长与补给');
    this.info.className = 'run-build-info'; this.assist.className = 'run-assist'; this.reload.className = 'run-ammo';
    this.choices.className = 'talent-choices'; this.choices.setAttribute('aria-label', '选择一项强化');
    this.heal.onclick = () => this.current?.buyHeal();
    this.buy.onclick = () => this.current?.buyTalent();
    this.ammo.onclick = () => this.current?.buyAmmo();
    this.reload.onclick = () => this.current?.reload();
    this.cancel.textContent = '取消购买'; this.cancel.onclick = () => this.current?.progress?.cancelShop();
    this.assist.onclick = () => { if (this.current) this.current.aimAssist = !this.current.aimAssist; };
    this.supply.className = 'run-supply'; this.supply.append(this.heal, this.buy, this.ammo);
    this.root.append(this.info, this.assist, this.reload, this.choices, this.cancel, this.supply);
    document.getElementById('center')!.append(this.root);
  }
  update(runtime: RuntimeSession | null): void {
    this.current = runtime;
    const p = runtime?.progress;
    this.root.hidden = !p;
    if (!runtime || !p) { this.offerStamp = ''; return; }
    const build = p.rules.talents.filter(t => p.stacks.has(t.id)).map(t => `${t.name} ×${p.stacks.get(t.id)}`).join(' · ');
    this.info.textContent = `废料 ${p.scrap}  ·  尸髓 ${p.essence}  ·  击杀 ${p.kills}\n${build || '击杀敌人，解锁首个流派'}\n${p.notice}`;
    this.assist.textContent = `辅助瞄准：${runtime.aimAssist ? '开' : '关'} · 按住 J 开火`;
    this.assist.disabled = runtime.outcome !== 'running';
    this.reload.textContent = p.reloadRemaining > 0 ? `换弹中 ${p.reloadRemaining.toFixed(1)}s` : `弹药 ${p.magazine} / ${p.reserve} · 换弹 R`;
    this.reload.disabled = runtime.outcome !== 'running' || p.choosing || p.reloadRemaining > 0 || p.magazine >= p.rules.weapon.magazineSize || p.reserve <= 0;
    const stamp = `${runtime.runId}:${p.choices.map(t => `${t.id}:${p.stacks.get(t.id) ?? 0}`).join(',')}:${p.shopping}:${runtime.outcome}`;
    this.root.classList.toggle('choosing', p.choosing && runtime.outcome !== 'game-over');
    if (stamp !== this.offerStamp) {
      this.offerStamp = stamp; this.choices.replaceChildren();
      if (p.choosing && runtime.outcome !== 'game-over') {
        const heading = document.createElement('strong'); heading.textContent = p.shopping ? '补给站 · 选择购买的强化' : '选择强化 · 战斗已暂停'; this.choices.append(heading);
        for (const t of p.choices) {
          const b = document.createElement('button');
          const title = document.createElement('strong'); title.textContent = `${t.name} (${(p.stacks.get(t.id) ?? 0) + 1}/${t.maxStacks})`;
          const desc = document.createElement('span'); desc.textContent = t.description;
          b.append(title, desc); b.onclick = () => runtime.chooseTalent(t.id); this.choices.append(b);
        }
      }
    }
    this.cancel.hidden = !p.shopping || runtime.outcome === 'game-over';
    this.supply.hidden = !runtime.atSupply;
    this.heal.textContent = `急救 +${p.rules.healAmount} HP · ${p.rules.healCost} 废料`;
    this.buy.textContent = `购买强化 · ${p.rules.talentCost} 废料`;
    this.ammo.textContent = `弹药 +${p.rules.weapon.ammoSupply} · ${p.rules.weapon.ammoCost} 废料`;
    this.ammo.disabled = p.scrap < p.rules.weapon.ammoCost;
    const player = runtime.player();
    this.heal.disabled = !player || player.hp >= player.maxHp || p.scrap < p.rules.healCost;
    this.buy.disabled = p.scrap < p.rules.talentCost || p.availableTalents.every(t => (p.stacks.get(t.id) ?? 0) >= t.maxStacks);
  }
}
