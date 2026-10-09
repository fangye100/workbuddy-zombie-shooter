import type { RuntimeBodyIk } from './runtime-body-ik';
/** Live weights are Play-only; persistent settings use the scene author form. */
export class BodyIkPanel {
  private key = '';
  constructor(private readonly host: HTMLElement, private readonly ik: RuntimeBodyIk) {}
  render(active: boolean): void {
    const summary = this.ik.summary();
    const key = JSON.stringify([active, summary.pending, summary.errors, summary.nodes.map(n => [n.nodeId, n.binding, n.diagnostics.map(d => [d.controlId, d.code])])]);
    if (key === this.key || this.host.contains(document.activeElement)) return;
    this.key = key;
    const expanded = this.host.querySelector('details')?.open ?? true;
    this.host.replaceChildren(); this.host.hidden = !active;
    if (!active) return;
    const details = document.createElement('details'); details.open = expanded;
    const title = document.createElement('summary'); title.textContent = `HumanIK 混合 · ${summary.nodes.length} 角色 · 加载 ${summary.pending}`; details.append(title);
    const note = document.createElement('p'); note.textContent = '实时权重仅影响本次 Play；永久设置请在场景节点中应用并保存。'; details.append(note);
    for (const error of summary.errors) { const p = document.createElement('p'); p.className = 'warn'; p.textContent = `${error.nodeId}: ${error.message}`; details.append(p); }
    for (const node of summary.nodes) {
      const group = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = node.name; group.append(legend);
      const slider = (id: string | null, text: string, weight: number): void => {
        const label = document.createElement('label'); label.textContent = text;
        const input = document.createElement('input'); input.type = 'range'; input.min = '0'; input.max = '1'; input.step = '.01'; input.value = String(weight);
        input.setAttribute('aria-label', `${node.name}: IK ${id ?? '总权重'}`);
        const value = document.createElement('output'); value.textContent = weight.toFixed(2);
        input.oninput = () => { this.ik.setWeight(node.nodeId, id, Number(input.value)); value.textContent = Number(input.value).toFixed(2); };
        label.append(input, value); group.append(label);
      };
      slider(null, '总权重', node.binding.weight);
      for (const c of node.binding.controls) slider(c.id, `${c.part} · ${c.target.kind}${c.enabled ? '' : ' · 已禁用'}`, c.weight);
      for (const d of node.diagnostics) { const p = document.createElement('p'); p.className = 'warn'; p.textContent = `${d.controlId} ${d.code}: ${d.message}${d.residualM === undefined ? '' : ` (${d.residualM.toFixed(3)}m)`}`; group.append(p); }
      details.append(group);
    }
    this.host.append(details);
  }
}
