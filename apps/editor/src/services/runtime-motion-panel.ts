import type { RuntimeSceneMotion } from './runtime-scene-motion';

/** Visible Play controls and diagnostic output; authoring remains in SceneAuthorPanel. */
export class RuntimeMotionPanel {
  private key = '';
  constructor(private readonly host: HTMLElement, private readonly motions: RuntimeSceneMotion,
    private readonly actorErrors: () => string[] = () => []) {}
  render(active: boolean): void {
    const summary = this.motions.summary();
    const actorErrors = this.actorErrors();
    const key = JSON.stringify([active, summary.pending, summary.errors, actorErrors, summary.nodes.map(n => [n.nodeId, n.state, n.key])]);
    if (key === this.key) return;
    const expanded = this.host.querySelector('details')?.open ?? false;
    this.key = key; this.host.replaceChildren(); this.host.hidden = !active;
    if (!active) return;
    const details = document.createElement('details'); details.open = expanded;
    const title = document.createElement('summary'); title.textContent = `共享动作 · Play · ${summary.nodes.length} 角色 · 加载 ${summary.pending}`; details.append(title);
    const status = document.createElement('p'); status.textContent = `加载中 ${summary.pending} · 已接入 ${summary.nodes.length}`; details.append(status);
    for (const error of summary.errors) {
      const p = document.createElement('p'); p.className = 'warn'; p.textContent = `${error.nodeId}: ${error.message}`; details.append(p);
    }
    for (const message of actorErrors) {
      const p = document.createElement('p'); p.className = 'warn'; p.textContent = `NPC 动作：${message}`; details.append(p);
    }
    for (const node of summary.nodes) {
      const group = document.createElement('fieldset'), legend = document.createElement('legend');
      legend.textContent = node.name.includes('bones') ? node.name : `${node.name} · ${node.joints} bones`; group.append(legend);
      for (const state of node.clips) {
        const button = document.createElement('button'); button.textContent = state; button.type = 'button';
        button.setAttribute('aria-label', `${node.name}: ${state}`); button.classList.toggle('active', node.state === state);
        button.onclick = () => { this.motions.setState(node.nodeId, state); this.render(true); }; group.append(button);
      }
      const warnings = [...new Set(node.reports.flatMap(r => r.warnings))];
      if (warnings.length) {
        const note = document.createElement('p'); note.className = 'hint';
        note.textContent = '已按骨架比例适配；足底尚未精确标定，接触与滑步修正受限。';
        note.title = warnings.join(', '); group.append(note);
      }
      details.append(group);
    }
    this.host.append(details);
  }
}
