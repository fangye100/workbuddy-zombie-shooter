import { gameText as g, gameLanguage } from './game-language';
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
  private readonly arsenal = document.createElement('select');
  private readonly weaponInfo = document.createElement('small');
  private readonly upgrade = document.createElement('button');
  private weaponStamp = '';
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
    this.arsenal.className='weapon-select';
    this.arsenal.onchange=()=>this.current?.equipWeapon(this.arsenal.value);
    this.upgrade.className='weapon-upgrade';this.upgrade.onclick=()=>this.current?.upgradeWeapon();
    this.weaponInfo.className='weapon-info';
    this.cancel.textContent = g('取消购买'); this.cancel.onclick = () => this.current?.progress?.cancelShop();
    this.assist.onclick = () => { if (this.current) this.current.aimAssist = !this.current.aimAssist; };
    this.supply.className = 'run-supply'; this.supply.append(this.heal, this.buy, this.ammo);
    this.root.append(this.info, this.assist, this.arsenal, this.weaponInfo,this.upgrade,this.reload, this.choices, this.cancel, this.supply);
    document.getElementById('center')!.append(this.root);
  }
  update(runtime: RuntimeSession | null, paused = false): void {
    this.current = runtime;this.cancel.textContent=g('取消购买');this.root.setAttribute('aria-label',g('本局成长与补给'));this.choices.setAttribute('aria-label',g('选择一项强化'));
    const p = runtime?.progress;
    this.root.hidden = !p;
    if (!runtime || !p) { this.offerStamp = ''; return; }
    const w=runtime.weapons,enabled=!paused && runtime.outcome==='running' && !p.choosing;
    const weaponStamp=JSON.stringify([runtime.runId,gameLanguage(),w.definitions.map(d=>[d.id,d.name,d.nameEn])]);
    if(weaponStamp!==this.weaponStamp){this.weaponStamp=weaponStamp;this.arsenal.replaceChildren(...w.definitions.map((d,i)=>{const o=document.createElement('option');o.value=d.id;o.textContent=`${i+1} · ${gameLanguage()==='zh'?d.name:d.nameEn}`;return o;}));}
    this.arsenal.value=w.animation.weaponId;this.arsenal.disabled=!enabled || w.switching;
    this.arsenal.setAttribute('aria-label',gameLanguage()==='zh'?'切换武器（1–7）':'Switch weapon (1–7)');
    const damage=(w.active.damage*w.damageMultiplier).toFixed(0),rate=(w.hasteMultiplier/w.active.cooldownSec).toFixed(1);
    this.weaponInfo.textContent=gameLanguage()==='zh'?`Lv.${w.state.level} · 伤害 ${damage} · ${rate}次/秒 · 射程 ${w.active.rangeM}m`:`Lv.${w.state.level} · DMG ${damage} · ${rate}/s · Range ${w.active.rangeM}m`;
    this.upgrade.textContent=gameLanguage()==='zh'?(w.upgradeCost===null?'武器已满级':`升级武器 · ${w.upgradeCost} 废料`):(w.upgradeCost===null?'Weapon max level':`Upgrade · ${w.upgradeCost} scrap`);
    this.upgrade.disabled=!enabled || w.switching || w.reloadRemaining>0 || w.upgradeCost===null || p.scrap<(w.upgradeCost??Infinity);
    const build = p.rules.talents.filter(t => p.stacks.has(t.id)).map(t => `${g(t.name)} ×${p.stacks.get(t.id)}`).join(' · ');
    this.info.textContent = g(`废料 ${p.scrap}  ·  尸髓 ${p.essence}  ·  击杀 ${p.kills}\n${build || '击杀敌人，解锁首个流派'}\n${p.notice}`);
    this.assist.textContent = g(`辅助瞄准：${runtime.aimAssist ? '开' : '关'} · 鼠标 / J 开火`);
    this.assist.disabled = runtime.outcome !== 'running';
    this.reload.textContent = w.switching?(gameLanguage()==='zh'?'换装中…':'Equipping…'):w.active.ammo.reloadMode==='none'?(gameLanguage()==='zh'?'近战 · 无需弹药':'Melee · No ammo'):g(p.reloadRemaining > 0 ? `换弹中 ${p.reloadRemaining.toFixed(1)}s` : `弹药 ${p.magazine} / ${p.reserve} · 换弹 R`);
    this.reload.disabled = !enabled || w.switching || w.active.ammo.reloadMode==='none' || p.reloadRemaining > 0 || p.magazine >= w.capacity || p.reserve <= 0;
    const stamp = `${gameLanguage()}:${runtime.runId}:${p.choices.map(t => `${t.id}:${p.stacks.get(t.id) ?? 0}`).join(',')}:${p.shopping}:${runtime.outcome}`;
    this.root.classList.toggle('choosing', p.choosing && runtime.outcome !== 'game-over');
    if (stamp !== this.offerStamp) {
      this.offerStamp = stamp; this.choices.replaceChildren();
      if (p.choosing && runtime.outcome !== 'game-over') {
        const heading = document.createElement('strong'); heading.textContent = g(p.shopping ? '补给站 · 选择购买的强化' : '选择强化 · 战斗已暂停'); this.choices.append(heading);
        for (const t of p.choices) {
          const b = document.createElement('button');
          const title = document.createElement('strong'); title.textContent = g(`${t.name} (${(p.stacks.get(t.id) ?? 0) + 1}/${t.maxStacks})`);
          const desc = document.createElement('span'); desc.textContent = g(t.description);
          b.append(title, desc); b.onclick = () => runtime.chooseTalent(t.id); this.choices.append(b);
        }
      }
    }
    this.cancel.hidden = !p.shopping || runtime.outcome === 'game-over';
    this.supply.hidden = !runtime.atSupply;
    this.heal.textContent = g(`急救 +${p.rules.healAmount} HP · ${p.rules.healCost} 废料`);
    this.buy.textContent = g(`购买强化 · ${p.rules.talentCost} 废料`);
    this.ammo.textContent = g(`弹药 +${p.rules.weapon.ammoSupply} · ${p.rules.weapon.ammoCost} 废料`);
    this.ammo.disabled = p.scrap < p.rules.weapon.ammoCost || w.active.ammo.reloadMode==='none';
    const player = runtime.player();
    this.heal.disabled = !player || player.hp >= player.maxHp || p.scrap < p.rules.healCost;
    this.buy.disabled = p.scrap < p.rules.talentCost || p.availableTalents.every(t => (p.stacks.get(t.id) ?? 0) >= t.maxStacks);
  }
}
