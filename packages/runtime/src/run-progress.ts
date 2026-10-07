import type { RunRulesComponent, RunTalent } from '@aether/scene';
import { WeaponSystem, type WeaponCarry } from './weapon-system';

export interface RunCarry {
  campaign: string;
  kills: number;
  scrap: number;
  essence: number;
  hp: number;
  stacks: Record<string, number>;
  magazine: number;
  reserve: number;
  weapons?: WeaponCarry;
}

/** Owns run rewards and decisions. No DOM, clock, storage or author-document mutation. */
export class RunProgress {
  kills = 0;
  scrap = 0;
  essence = 0;
  readonly stacks = new Map<string, number>();
  private offers: RunTalent[] = [];
  private offerPrice = 0;
  private choicesDue = 0;
  private rewardedFloor = false;
  notice = '';
  get magazine():number { return this.weapons.state.magazine; }
  set magazine(n:number) { this.weapons.state.magazine=n; }
  get reserve():number { return this.weapons.state.reserve; }
  set reserve(n:number) { this.weapons.state.reserve=n; }
  get reloadRemaining():number { return this.weapons.reloadRemaining; }
  private unlocked = new Set<string>();
  constructor(readonly rules: RunRulesComponent, private readonly seed: number, readonly weapons=new WeaponSystem(rules.arsenal)) {}
  reload(): boolean {
    return !this.choosing && this.weapons.reload();
  }
  advanceReload(dt: number): void {
    this.weapons.advance(dt);
  }
  takeRound(): boolean {
    return !this.choosing && this.weapons.consumeRound();
  }
  buyAmmo(): boolean {
    if (this.choosing || this.weapons.active.ammo.reloadMode==='none' || this.scrap < this.rules.weapon.ammoCost) return false;
    this.scrap -= this.rules.weapon.ammoCost; this.reserve += this.rules.weapon.ammoSupply;
    this.notice = `补充 ${this.rules.weapon.ammoSupply} 发备用弹药`; return true;
  }
  setUnlocked(ids: readonly string[]): void { this.unlocked = new Set(ids); }
  get availableTalents(): RunTalent[] { return this.rules.talents.filter(t => t.unlockCost === undefined || this.unlocked.has(t.id)); }

  get choices(): readonly RunTalent[] { return this.offers; }
  get choosing(): boolean { return this.offers.length > 0; }
  strength(effect: RunTalent['effect']): number {
    return this.rules.talents.reduce((total, t) => total + (t.effect === effect ? t.value * (this.stacks.get(t.id) ?? 0) : 0), 0);
  }
  recordKill(): void {
    this.kills++;
    this.scrap += this.rules.scrapPerKill;
    if(this.weapons.active.ammo.reloadMode!=='none')this.reserve += this.rules.weapon.ammoPerKill;
    this.notice = `击杀 +${this.rules.scrapPerKill} 废料`;
    if (this.kills >= this.rules.firstChoiceKills && (this.kills - this.rules.firstChoiceKills) % this.rules.choiceEveryKills === 0) this.choicesDue++;
    this.offerNext();
  }
  private offerNext(): void {
    if (!this.choosing && this.choicesDue > 0) {
      this.choicesDue--;
      this.offer(0);
      if (!this.choosing) this.choicesDue = 0; // all authored upgrades exhausted
    }
  }
  private offer(price: number): void {
    const pool = this.availableTalents.filter(t => (this.stacks.get(t.id) ?? 0) < t.maxStacks);
    const start = ((this.seed >>> 0) + this.kills + [...this.stacks.values()].reduce((a, b) => a + b, 0)) % Math.max(1, pool.length);
    this.offers = [...pool.slice(start), ...pool.slice(0, start)].slice(0, 3);
    this.offerPrice = price;
  }
  choose(id: string): boolean {
    const talent = this.offers.find(t => t.id === id);
    if (!talent || this.scrap < this.offerPrice) return false;
    this.scrap -= this.offerPrice;
    const stacks = (this.stacks.get(id) ?? 0) + 1;
    this.stacks.set(id, stacks);
    this.notice = stacks === talent.maxStacks ? `${talent.name} · 流派成型！` : `${talent.name} ×${stacks}`;
    this.offers = [];
    this.offerNext();
    return true;
  }
  shopTalent(): boolean {
    if (this.choosing || this.scrap < this.rules.talentCost) return false;
    this.offer(this.rules.talentCost);
    return this.choosing;
  }
  cancelShop(): boolean {
    if (!this.choosing || this.offerPrice === 0) return false;
    this.offers = []; this.offerNext(); return true;
  }
  get shopping(): boolean { return this.choosing && this.offerPrice > 0; }
  payHeal(hp: number, maxHp: number): number {
    if (this.choosing || hp <= 0 || hp >= maxHp || this.scrap < this.rules.healCost) return 0;
    this.scrap -= this.rules.healCost;
    this.notice = `补给恢复 ${Math.min(maxHp - hp, this.rules.healAmount).toFixed(1)} 生命`;
    return Math.min(maxHp - hp, this.rules.healAmount);
  }
  rewardEvent(): void { this.scrap += this.rules.eventScrap; this.notice = `补给箱 +${this.rules.eventScrap} 废料`; }
  finishFloor(): void {
    if (this.rewardedFloor) return;
    this.rewardedFloor = true; this.essence += this.rules.floorEssence;
    this.notice = `楼层完成 +${this.rules.floorEssence} 尸髓`;
  }
  snapshot(hp: number): RunCarry {
    return { campaign: this.rules.campaign, kills: this.kills, scrap: this.scrap, essence: this.essence, hp, stacks: Object.fromEntries(this.stacks), magazine: this.magazine, reserve: this.reserve, weapons:this.weapons.snapshot() };
  }
  restore(value: unknown, maxHp: number): boolean {
    if (!value || typeof value !== 'object') return false;
    const s = value as RunCarry;
    if (s.campaign !== this.rules.campaign || ![s.kills, s.scrap, s.essence].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 10000000)
      || !Number.isSafeInteger(s.magazine) || s.magazine < 0 || (!s.weapons && s.magazine > this.rules.weapon.magazineSize)
      || !Number.isSafeInteger(s.reserve) || s.reserve < 0 || s.reserve > 10000000
      || !Number.isFinite(s.hp) || s.hp <= 0 || s.hp > maxHp || !s.stacks || typeof s.stacks !== 'object' || Array.isArray(s.stacks)) return false;
    for (const [id, n] of Object.entries(s.stacks)) {
      const t = this.rules.talents.find(t => t.id === id);
      if (!t || !Number.isInteger(n) || n < 1 || n > t.maxStacks) return false;
    }
    if(s.weapons && (!this.weapons.validCarry(s.weapons) || s.weapons.states.find(w=>w.id===s.weapons!.equipped)?.magazine!==s.magazine || s.weapons.states.find(w=>w.id===s.weapons!.equipped)?.reserve!==s.reserve)) return false;
    if(!s.weapons && this.weapons.definitions.length!==1)return false;
    const carry=s.weapons ?? this.weapons.snapshot();
    if(!s.weapons){carry.states[0]!.magazine=s.magazine;carry.states[0]!.reserve=s.reserve;}
    if(!this.weapons.restore(carry))return false;
    this.kills = s.kills; this.scrap = s.scrap; this.essence = s.essence;
    this.stacks.clear(); for (const [id, n] of Object.entries(s.stacks)) this.stacks.set(id, n);
    this.offers = []; this.choicesDue = 0; this.rewardedFloor = false;
    return true;
  }
}
