/** Structured author form. Draft input is local; only Apply enters the shared document/history. */
import type { SceneDocument, SceneNode, RunRulesComponent } from '@aether/scene';
import { BODY_IK_PARTS, DEFAULT_MOTION_TRANSITION_SEC, newBodyIkControl } from '@aether/scene';
import { newAuthorNode, newRunRules, removeNodeTree, type EditResult } from '@aether/runtime';
import { t } from '../i18n';
import './scene-author.css';

const labels: Record<string, string> = {
  audio: '游戏音效', cues: '音效资源', masterGain: '主音量', maxVoices: '最大同时发声数', maxImpactVoices: '最大命中声数', decodedBudgetMiB: '音频内存预算 MiB', distanceM: '声音衰减距离', warningDistanceM: '预警距离', variants: '声音变体', gain: '音量', rate: '播放速率', bus: '声音分组', ambience: '环境音', warnings: '敌人预警', fleshHit: '肉体命中', acidLaunch: '酸液发射', acidPool: '酸池循环',
  arsenal: '武器系统', equipped: '初始装备', definitions: '武器定义', switchSec: '换装秒数', presentation: '武器表现', markers: '持握与附件标记', primaryGrip: '主握点', supportGrip: '辅助握点', muzzle: '枪口', magazine: '弹匣标记', chamber: '拉栓标记', procedural: '程序化动作', animations: '动作 hook', effects: '伤害效果', upgrades: '武器升级', ammo: '弹药配置',
  weight: 'IK 混合权重 (0–1)', locomotionWhileAiming: '瞄准时保留下半身移动', pole: '弯曲参考方向', forward: '瞄准轴 (骨骼局部)', maxAngleDeg: '最大瞄准角 (度)', height: '目标世界高度 (米)', offset: '目标世界偏移 (米)', nodeId: '目标节点',
  name: '名称', parent: '父节点', visible: '可见', pickable: '可拾取', category: '分类', transform: '局部变换',
  position: '位置', rotation: '旋转四元数', scale: '缩放', enabled: '启用', campaign: '战役标识',
  npcTiming: 'NPC 节奏', decisionMinSec: '最短决策间隔', decisionMaxSec: '最长决策间隔', recoveryMinSec: '最短恢复时间', recoveryMaxSec: '最长恢复时间', windupJitterFrac: '前摇随机比例', cooldownJitterFrac: '冷却随机比例',
  attackTokenCount: '普通敌人并发攻击数', scrapPerKill: '击杀废料', firstChoiceKills: '首次强化击杀数', choiceEveryKills: '强化间隔击杀数',
  eventScrap: '事件废料', healCost: '治疗费用', healAmount: '治疗量', talentCost: '强化费用', floorEssence: '通关精华',
  aimAssist: '辅助瞄准', weapon: '武器与弹药', magazineSize: '弹匣容量', reserveRounds: '备用弹药', reloadSec: '换弹秒数',
  ammoPerKill: '击杀弹药', ammoCost: '弹药费用', ammoSupply: '补给弹药', bossAttack: 'Boss 攻击',
  source: '来源节点', radius: '半径', windupSec: '预警秒数', cooldownSec: '冷却秒数', damage: '伤害',
  talents: '强化选项', id: '标识', description: '说明', effect: '效果', value: '数值', maxStacks: '叠加上限', unlockCost: '解锁费用',
  color: '灯光颜色', intensity: '灯光强度', range: '照明范围', castShadow: '投射阴影', priority: '灯光优先级', spotAngle: '聚光角度',
};
const enums: Record<string, string[]> = { bus:['weapon','impact','enemy','ambience'], behavior: ['hitscan','pellets','piercing','projectile','melee','flame'], reloadMode:['magazine','shell','none'], effector:['right-hand','left-hand','none'], placeholder:['pistol','shotgun','smg','sniper','chainsaw','flame','launcher'], effect: ['damage', 'haste', 'leech', 'blast', 'speed'] };

export class SceneAuthorPanel {
  get hasDraft(): boolean { return this.draftDirty; }
  resetDraft(): void { this.draftDirty = false; this.key = ''; this.draft = null; }
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
          if(prefix==='RunRules.weapon' && ['magazineSize','reserveRounds','reloadSec'].includes(key))continue; // v12 compatibility fields; arsenal owns these in v13.
          if (typeof value === 'object') {
            const group = document.createElement('details'); group.open = !['transform','talents','definitions','audio','cues'].includes(key);
            const summary = document.createElement('summary'); summary.textContent = t(labels[key] ?? key); group.append(summary);
            fields(group, value as Record<string, unknown>, Object.keys(value), path); parent.append(group); continue;
          }
          const label = document.createElement('label'); label.textContent = t(labels[key] ?? key);
          const choices = enums[key] ?? (key === 'nodeId' ? doc.nodes.map(n => n.id) : key === 'source' && prefix.endsWith('bossAttack') ? doc.nodes.filter(n => n.components.some(c => c.kind === 'SpawnPoint')).map(n => n.id) : null);
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
      if (draft.id === doc.playerStart) {
        const mesh = draft.components.find(c => c.kind === 'MeshRenderer');
        if (mesh?.kind === 'MeshRenderer' && mesh.source.type === 'asset') {
          const label = document.createElement('label'); label.textContent = t('作为 Play 玩家外观（保留模型姿态）');
          const input = document.createElement('input'); input.type = 'checkbox';
          input.setAttribute('aria-label', 'MeshRenderer.playBinding'); input.checked = mesh.playBinding === 'player';
          input.onchange = () => { if (input.checked) { mesh.playBinding = 'player'; mesh.editorOnly = false; } else delete mesh.playBinding; dirty(); };
          label.append(input); form.append(label);
          fields(form, mesh.source.ref as unknown as Record<string, unknown>, ['path', 'guid'], 'MeshRenderer.asset');
        }
      }
      for (const component of draft.components) if (component.kind === 'Light') fields(form, component as unknown as Record<string, unknown>, Object.keys(component).filter(k => k !== 'type'), 'Light');
      for (const mesh of draft.components) if (mesh.kind === 'MeshRenderer' && mesh.source.type === 'asset') {
        const ikSection = document.createElement('fieldset'), ikLegend = document.createElement('legend');
        ikLegend.textContent = 'HumanIK · 分部位程序化混合'; ikSection.append(ikLegend); form.append(ikSection);
        const ikHint = document.createElement('p'); ikHint.textContent = '先播放原动作，再按权重叠加 IK。固定位置与弯曲方向使用角色局部米；节点偏移使用世界米。'; ikSection.append(ikHint);
        if (mesh.bodyIk) {
          const ik = mesh.bodyIk;
          fields(ikSection, ik as unknown as Record<string, unknown>, ['enabled', 'weight', 'locomotionWhileAiming'], 'MeshRenderer.bodyIk');
          for (const c of ik.controls) {
            const group = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = c.part; group.append(legend); ikSection.append(group);
            const prefix = `MeshRenderer.bodyIk.${c.id}`;
            fields(group, c as unknown as Record<string, unknown>, ['enabled', 'weight', 'pole', 'forward', 'maxAngleDeg'], prefix);
            const targetLabel = document.createElement('label'); targetLabel.textContent = '目标来源';
            const target = document.createElement('select'); target.setAttribute('aria-label', `${prefix}.target.kind`);
            for (const [value, text] of [['position', '固定局部位置'], ['mouse', '鼠标 / 瞄准摇杆'], ['node', '场景节点'], ['enemy', '最近存活敌人']]) target.add(new Option(text, value));
            target.value = c.target.kind;
            target.onchange = () => {
              c.target = target.value === 'position' ? { kind: 'position', position: [0, 1.5, 1] } :
                target.value === 'node' ? { kind: 'node', nodeId: doc.nodes.find(n => n.id !== draft.id)?.id ?? '', offset: [0, 1.5, 0] } :
                { kind: target.value === 'enemy' ? 'enemy' : 'mouse', height: 1.5 };
              redrawDraft();
            };
            targetLabel.append(target); group.append(targetLabel);
            fields(group, c.target as unknown as Record<string, unknown>, Object.keys(c.target), `${prefix}.target`);
            button(`移除 ${c.part}`, () => { ik.controls = ik.controls.filter(x => x.id !== c.id); redrawDraft(); }, group);
          }
          for (const part of BODY_IK_PARTS) if (!ik.controls.some(c => c.part === part)) button(`添加 IK ${part}`, () => { ik.controls.push(newBodyIkControl(part)); redrawDraft(); }, ikSection);
        }
        button('设置分部位 IK', () => { mesh.bodyIk = { enabled: true, weight: 1, locomotionWhileAiming: true, controls: [newBodyIkControl('upperBody')] }; redrawDraft(); }, ikSection);
        button('继承资产 IK 装配', () => { delete mesh.bodyIk; redrawDraft(); }, ikSection);
        button('禁用程序化 IK', () => { mesh.bodyIk = null; redrawDraft(); }, ikSection);
        const section = document.createElement('fieldset'), legend = document.createElement('legend');
        legend.textContent = t('共享动作库 · Runtime 重定向'); section.append(legend); form.append(section);
        if (mesh.sharedMotion) {
          fields(section, mesh.sharedMotion as unknown as Record<string, unknown>, ['library', 'profile', 'defaultState', 'speed'], 'MeshRenderer.sharedMotion');
          const label = document.createElement('label'); label.textContent = '姿态过渡时长 (秒，0 = 直接切换)';
          const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = '5'; input.step = '.01';
          input.value = String(mesh.sharedMotion.transitionSec ?? DEFAULT_MOTION_TRANSITION_SEC);
          input.setAttribute('aria-label', 'MeshRenderer.sharedMotion.transitionSec');
          input.oninput = () => { mesh.sharedMotion!.transitionSec = input.value.trim() ? Number(input.value) : NaN; dirty(); };
          label.append(input); section.append(label);
        }
        button('绑定共享动作库', () => {
          mesh.sharedMotion = { library: { path: '', guid: '' }, profile: '', defaultState: 'idle', speed: 1 }; redrawDraft();
        }, section);
        button('继承资产动作配置', () => { delete mesh.sharedMotion; redrawDraft(); }, section);
        button('禁用共享动作', () => { mesh.sharedMotion = null; redrawDraft(); }, section);
      }
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
