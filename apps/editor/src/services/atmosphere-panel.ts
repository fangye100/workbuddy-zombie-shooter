import type { EnvironmentData } from '@aether/scene';
import type { EditResult } from '@aether/runtime';

const labels: Record<string, string> = {
  zenith: '天顶颜色', horizon: '地平线颜色', ground: '天空下半球', cloud: '云层颜色',
  cloudCoverage: '云量', cloudScale: '云层尺度', cloudSpeed: '云层速度', sunColor: '太阳颜色',
  sunSize: '太阳大小', sunDirection: '太阳方向', tonemapMode: '色调映射',
  contactShadowOpacity: '接地阴影浓度', outlineWidth: '墨线宽度', inkColor: '墨线颜色',
  shadowMult: '暗面亮度', shadowMix: '暗面染色', shadowTint: '暗面颜色', litSat: '亮面饱和度',
  halftoneStrength: '网点浓度', halftoneSize: '网点大小', vignette: '画面暗角',
  textureMix: '云图混合强度', textureYaw: '云图方位角（度）', path: '贴图路径', guid: '贴图 GUID',
};

/** Draft-only form. Store validation/history owns Apply, normal scene save owns persistence. */
export class AtmospherePanel {
  hasDraft = false;
  private stamp = '';
  resetDraft(): void { this.hasDraft = false; this.stamp = ''; }
  constructor(private readonly host: HTMLElement, private readonly port: {
    environment(): EnvironmentData | null; locked(): boolean; apply(env: EnvironmentData): EditResult;
    diagnostic?(): string;
  }) { host.className = 'atmosphere-panel'; }
  render(): void {
    const env = this.port.environment();
    const stamp = JSON.stringify([env, this.port.locked(), this.port.diagnostic?.()]);
    if (this.hasDraft || stamp === this.stamp) return;
    const wasOpen = this.host.querySelector('details')?.open ?? false;
    this.stamp = stamp; this.host.replaceChildren(); if (!env) return;
    const draft = structuredClone(env), source = JSON.stringify(env);
    const group = document.createElement('details');
    group.open = wasOpen || !!this.port.diagnostic?.();
    const title = document.createElement('summary'); title.textContent = '天空与漫画画风'; group.append(title);
    const form = document.createElement('fieldset'); form.disabled = this.port.locked(); group.append(form);
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    status.textContent = this.port.diagnostic?.() ?? '';
    const dirty = () => { this.hasDraft = true; status.textContent = '尚未应用；应用后可撤销并保存到场景'; };
    const fields = (data: Record<string, unknown>, prefix: string, target: HTMLElement = form) => {
      for (const [key, value] of Object.entries(data)) {
        if (key === 'texture') continue;
        if (Array.isArray(value)) { fields(value as unknown as Record<string, unknown>, `${prefix}.${key}`, target); continue; }
        const row = document.createElement('label'); row.textContent = labels[key] ?? `${labels[prefix.split('.').at(-1)!] ?? prefix} ${['X', 'Y', 'Z'][Number(key)] ?? key}`;
        if (key === 'tonemapMode') {
          const select = document.createElement('select'); select.setAttribute('aria-label', '色调映射');
          ['线性', 'Reinhard', 'ACES', 'AgX'].forEach((name, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = name; select.append(o); });
          select.value = String(value); select.onchange = () => { data[key] = Number(select.value); dirty(); };
          row.append(select); target.append(row); continue;
        }
        const input = document.createElement('input'); input.setAttribute('aria-label', `environment.${prefix}.${key}`);
        input.type = typeof value === 'number' ? 'number' : 'color'; input.step = 'any'; input.value = String(value);
        input.oninput = () => { data[key] = typeof value === 'number' ? (input.value.trim() ? Number(input.value) : NaN) : input.value; dirty(); };
        row.append(input); target.append(row);
      }
    };
    const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = !!draft.sky;
    enabled.setAttribute('aria-label', '启用天空穹顶');
    const toggle = document.createElement('label'); toggle.textContent = '启用天空穹顶'; toggle.append(enabled); form.append(toggle);
    const skyFields = document.createElement('div'); form.append(skyFields);
    let rememberedSky = draft.sky ?? { zenith: '#343c65', horizon: '#e5ab7e', ground: '#394750', cloud: '#d6c6b2', cloudCoverage: 0.52, cloudScale: 1.8, cloudSpeed: 0.002, sunColor: '#ffe3a0', sunDirection: [-0.7,0.4,-0.5] as [number,number,number], sunSize: 0.065 };
    const renderSky = () => {
      skyFields.replaceChildren(); if (!draft.sky) return;
      // Bind scalar edits to the draft itself, including optional defaults.
      draft.sky.textureMix ??= 0.85; draft.sky.textureYaw ??= 0;
      skyFields.replaceChildren(); fields(draft.sky as unknown as Record<string, unknown>, 'sky', skyFields);
      const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = !!draft.sky.texture;
      toggle.setAttribute('aria-label', '启用绘制云图');
      const label = document.createElement('label'); label.textContent = '启用绘制云图'; label.append(toggle); skyFields.append(label);
      toggle.onchange = () => { draft.sky!.texture = toggle.checked ? {path:'assets/',guid:''} : null; dirty(); renderSky(); };
      if (draft.sky.texture) for (const key of ['path','guid'] as const) {
        const row=document.createElement('label'); row.textContent=labels[key]!;
        const input=document.createElement('input'); input.type='text'; input.value=draft.sky.texture[key] ?? '';
        input.setAttribute('aria-label',`environment.sky.texture.${key}`);
        input.oninput=()=>{draft.sky!.texture![key]=input.value;dirty();}; row.append(input); skyFields.append(row);
      }
    };
    enabled.onchange = () => {
      if (draft.sky) rememberedSky = draft.sky;
      draft.sky = enabled.checked ? rememberedSky : null;
      renderSky(); dirty();
    };
    renderSky();
    const comicEnabled = document.createElement('input'); comicEnabled.type = 'checkbox'; comicEnabled.checked = !!draft.comic;
    comicEnabled.setAttribute('aria-label', '启用漫画画风');
    const comicToggle = document.createElement('label'); comicToggle.textContent = '启用漫画画风'; comicToggle.append(comicEnabled); form.append(comicToggle);
    const comicFields = document.createElement('div'); form.append(comicFields);
    let rememberedComic = draft.comic ?? {tonemapMode:2,contactShadowOpacity:0.45,outlineWidth:1.6,inkColor:'#14110f',shadowMult:0.72,shadowMix:0.2,shadowTint:'#30283e',litSat:1.08,halftoneStrength:0.18,halftoneSize:5,vignette:0.04};
    const renderComic = () => { comicFields.replaceChildren(); if(draft.comic) fields(draft.comic as unknown as Record<string,unknown>, 'comic', comicFields); };
    comicEnabled.onchange = () => {
      if(draft.comic) rememberedComic=draft.comic;
      draft.comic=comicEnabled.checked?rememberedComic:null; renderComic(); dirty();
    };
    renderComic();
    const apply = document.createElement('button'); apply.textContent = '应用天空与画风'; apply.type = 'button';
    apply.onclick = () => {
      if (this.port.locked()) { status.textContent = '请先停止 Play'; return; }
      if (JSON.stringify(this.port.environment()) !== source) { status.textContent = '环境已被其他编辑修改，请放弃草稿后重新编辑'; return; }
      const result = this.port.apply(draft);
      if (!result.ok) { status.textContent = result.error ?? '修改被拒绝'; return; }
      this.hasDraft = false; this.stamp = ''; this.render();
    };
    const discard = document.createElement('button'); discard.type = 'button'; discard.textContent = '放弃天空草稿';
    discard.onclick = () => { this.hasDraft = false; this.stamp = ''; this.render(); };
    form.append(apply, discard, status); this.host.append(group);
  }
}
