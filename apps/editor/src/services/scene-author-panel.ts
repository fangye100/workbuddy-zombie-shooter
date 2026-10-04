/** Structured author form. Draft input is local; only Apply enters the shared document/history. */
import type { SceneDocument, SceneNode, RunRulesComponent } from '@aether/scene';
import { newAuthorNode, newRunRules, removeNodeTree, type EditResult } from '@aether/runtime';
import { t } from '../i18n';
import './scene-author.css';

const labels: Record<string, string> = {
  name: '名称', parent: '父节点', visible: '可见', pickable: '可拾取', category: '分类', transform: '局部变换',
  position: '位置', rotation: '旋转四元数', scale: '缩放', enabled: '启用', campaign: '战役标识',
  scrapPerKill: '击杀废料', firstChoiceKills: '首次强化击杀数', choiceEveryKills: '强化间隔击杀数',
  eventScrap: '事件废料', healCost: '治疗费用', healAmount: '治疗量', talentCost: '强化费用', floorEssence: '通关精华',
  aimAssist: '辅助瞄准', weapon: '武器与弹药', magazineSize: '弹匣容量', reserveRounds: '备用弹药', reloadSec: '换弹秒数',
  ammoPerKill: '击杀弹药', ammoCost: '弹药费用', ammoSupply: '补给弹药', bossAttack: 'Boss 攻击',
  source: '来源节点', radius: '半径', windupSec: '预警秒数', cooldownSec: '冷却秒数', damage: '伤害',
  talents: '强化选项', id: '标识', description: '说明', effect: '效果', value: '数值', maxStacks: '叠加上限', unlockCost: '解锁费用',
  color: '灯光颜色', intensity: '灯光强度', range: '照明范围', castShadow: '投射阴影', priority: '灯光优先级', spotAngle: '聚光角度',
};
const enums: Record<string, string[]> = { effect: ['damage', 'haste', 'leech', 'blast', 'speed'] };

export class SceneAuthorPanel {
  get hasDraft(): boolean { return this.draftDirty; }
  private selected = '';
  private key = '';
  private draft: SceneNode | null = null;
  private draftDirty = false;
  private lastExternal: string | null = null;
  private sourceVersion = '';
  constructor(private host: HTMLElement, private port: {
    document(): SceneDocument | null; locked(): boolean;
    edit(label: string, mutate: (nodes: SceneNode[]) => void, rebuild: boolean): EditResult;
  }) { host.id = 'scene-author-panel'; }

  render(selected?: string | null, draftOverride?: SceneNode): void {
    const doc = this.port.document(); if (!doc) { this.host.replaceChildren(); return; }
    if (selected && selected !== this.lastExternal && doc.nodes.some(n => n.id === selected) && !this.draftDirty) this.selected = selected;
    this.lastExternal = selected ?? null;
    if (!doc.nodes.some(n => n.id === this.selected)) this.selected = doc.nodes[0]?.id ?? '';
    const node = draftOverride ?? doc.nodes.find(n => n.id === this.selected);
    const key = JSON.stringify([doc.id, node, this.port.locked()]);
    if (key === this.key) return;
    if (this.draftDirty) return;
    this.key = key; this.draft = node ? structuredClone(node) : null; this.draftDirty = false;
    this.sourceVersion = JSON.stringify(node);
    const details = document.createElement('details'); details.open = true;
    const title = document.createElement('summary'); title.textContent = t('场景节点与玩法规则'); details.append(title);
    const fieldset = document.createElement('fieldset'); fieldset.disabled = this.port.locked(); details.append(fieldset);
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const report = (r: EditResult): void => { status.textContent = r.ok ? t('已应用到场景，请保存') : r.error ?? ''; if (r.ok) { this.key = ''; this.draftDirty = false; this.render(); } };
    const button = (label: string, fn: () => void, parent: HTMLElement = fieldset): void => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = t(label); b.onclick = fn; parent.append(b);
    };
    const selector = document.createElement('select'); selector.setAttribute('aria-label', t('场景节点'));
    for (const n of doc.nodes) selector.add(new Option(`${n.name} · ${n.id}`, n.id));
    selector.value = this.selected;
    selector.onchange = () => { if (this.draftDirty) { selector.value = this.selected; status.textContent = t('请先应用或放弃表单修改'); return; } this.selected = selector.value; this.key = ''; this.render(); };
    fieldset.append(selector);
    button('定位玩法规则', () => { if (this.draftDirty) { status.textContent = t('请先应用或放弃表单修改'); return; } this.selected = doc.nodes.find(n => n.components.some(c => c.kind === 'RunRules'))?.id ?? this.selected; this.key = ''; this.render(); });
    for (const box of [false, true]) button(box ? '新建方块' : '新建空节点', () => {
      if (this.draftDirty) { status.textContent = t('请先应用或放弃表单修改'); return; }
      const id = `nd_${crypto.randomUUID()}`;
      const result = this.port.edit(box ? '新建方块' : '新建空节点', nodes => nodes.push(newAuthorNode(id, box ? t('方块') : t('空节点'), box)), true);
      if (result.ok) this.selected = id;
      report(result);
    });
    if (this.draft) {
      const draft = this.draft;
      const form = document.createElement('div'); fieldset.append(form);
      const dirty = (): void => { this.draftDirty = true; status.textContent = t('表单尚未应用；应用后可撤销并保存'); };
      const fields = (parent: HTMLElement, object: Record<string, unknown>, keys: string[], prefix: string): void => {
        for (const key of keys) {
          const value = object[key], path = `${prefix}.${key}`;
          if (key === 'kind' || value === undefined || value === null) continue;
          if (typeof value === 'object') {
            const group = document.createElement('details'); group.open = key !== 'transform' && key !== 'talents';
            const summary = document.createElement('summary'); summary.textContent = t(labels[key] ?? key); group.append(summary);
            fields(group, value as Record<string, unknown>, Object.keys(value), path); parent.append(group); continue;
          }
          const label = document.createElement('label'); label.textContent = t(labels[key] ?? key);
          const choices = enums[key] ?? (key === 'source' && prefix.endsWith('bossAttack') ? doc.nodes.filter(n => n.components.some(c => c.kind === 'SpawnPoint')).map(n => n.id) : null);
          const input = choices ? document.createElement('select') : document.createElement('input');
          input.setAttribute('aria-label', path); input.dataset.authorField = path;
          if (input instanceof HTMLSelectElement) { for (const v of choices!) input.add(new Option(v, v)); input.value = String(value); }
          else { input.type = typeof value === 'boolean' ? 'checkbox' : typeof value === 'number' ? 'number' : 'text'; input.step = 'any'; input.value = String(value); input.checked = value === true; }
          const update = (): void => { object[key] = typeof value === 'boolean' ? (input as HTMLInputElement).checked : typeof value === 'number' ? (input.value.trim() ? Number(input.value) : NaN) : input.value; dirty(); };
          input.onchange = update;
          if (input instanceof HTMLInputElement && input.type !== 'checkbox') input.oninput = update;
          label.append(input); parent.append(label);
        }
      };
      fields(form, draft as unknown as Record<string, unknown>, ['name', 'visible', 'pickable', 'category', 'transform'], 'node');
      for (const component of draft.components) if (component.kind === 'Light') fields(form, component as unknown as Record<string, unknown>, Object.keys(component).filter(k => k !== 'type'), 'Light');
      const parentLabel = document.createElement('label'); parentLabel.textContent = t('父节点');
      const parents = document.createElement('select'); parents.setAttribute('aria-label', 'node.parent'); parents.add(new Option(t('根节点'), ''));
      for (const n of doc.nodes) if (n.id !== draft.id) parents.add(new Option(n.name, n.id)); parents.value = draft.parent ?? '';
      parents.onchange = () => { draft.parent = parents.value || null; dirty(); }; parentLabel.append(parents); form.append(parentLabel);
      const rules = draft.components.find(c => c.kind === 'RunRules') as RunRulesComponent | undefined;
      if (rules) {
        fields(form, rules as unknown as Record<string, unknown>, Object.keys(rules), 'RunRules');
        button('添加强化选项', () => { rules.talents.push({ id: `talent-${rules.talents.length + 1}`, name: t('新强化'), description: '', effect: 'damage', value: 0.2, maxStacks: 5 }); redrawDraft(); }, form);
        button('删除最后强化选项', () => { rules.talents.pop(); redrawDraft(); }, form);
        for (const [i, talent] of rules.talents.entries()) if (talent.unlockCost === undefined) button(`${t('设置解锁费用')} ${talent.id}`, () => { talent.unlockCost = 10; redrawDraft(); }, form);
        else button(`${t('设为初始解锁')} ${talent.id}`, () => { delete rules.talents[i]!.unlockCost; redrawDraft(); }, form);
        if (!rules.bossAttack) button('添加 Boss 攻击', () => { rules.bossAttack = { source: doc.nodes.find(n => n.components.some(c => c.kind === 'SpawnPoint'))?.id ?? '', radius: 4, windupSec: 1, cooldownSec: 5, damage: 20 }; redrawDraft(); }, form);
        else button('移除 Boss 攻击', () => { delete rules.bossAttack; redrawDraft(); }, form);
      } else button('添加玩法规则', () => { draft.components.push(newRunRules()); redrawDraft(); }, form);
      // Rebuild draft controls without committing or dropping other in-progress values.
      const redrawDraft = (): void => { const version = this.sourceVersion; this.key = ''; this.draftDirty = false; this.render(undefined, draft); this.sourceVersion = version; this.draftDirty = true; };
      button('应用节点修改', () => {
        const current = this.port.document()?.nodes.find(n => n.id === draft.id);
        if (!current || JSON.stringify(current) !== this.sourceVersion) { status.textContent = t('节点已被其他编辑修改，请放弃表单后重新编辑'); return; }
        const onlyRules = JSON.stringify({ ...draft, components: draft.components.filter(c => c.kind !== 'RunRules') }) === JSON.stringify({ ...current, components: current.components.filter(c => c.kind !== 'RunRules') });
        report(this.port.edit('编辑场景节点', nodes => { const at = nodes.findIndex(n => n.id === draft.id); if (at < 0) throw new Error('节点已不存在'); nodes[at] = structuredClone(draft); }, !onlyRules));
      });
      button('放弃表单修改', () => { this.key = ''; this.draftDirty = false; this.render(); });
      button('删除节点及子节点', () => {
        if (this.draftDirty) { status.textContent = t('请先应用或放弃表单修改'); return; }
        report(this.port.edit('删除节点及子节点', nodes => removeNodeTree(nodes, draft.id), true));
      });
    }
    fieldset.append(status); this.host.replaceChildren(details);
  }
}
