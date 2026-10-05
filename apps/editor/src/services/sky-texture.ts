import type { AssetRef } from '@aether/scene';
import { fileUrl } from '../asset-util';

/** Owns async decode lifetimes. Scene references remain the authoring source. */
export class SkyTextureLoader {
  pending = false;
  diagnostic = '';
  private key = '';
  private generation = 0;
  private task: Promise<void> = Promise.resolve();
  constructor(private readonly upload: (bitmap: ImageBitmap | null) => void,
    private readonly decode: (ref: AssetRef) => Promise<ImageBitmap> = async ref => {
      const [image, meta] = await Promise.all([fetch(fileUrl(ref.path)), fetch(fileUrl(`${ref.path}.meta.json`))]);
      if (!image.ok || !meta.ok) throw new Error(`读取失败 HTTP ${image.status}/${meta.status}`);
      const sidecar = await meta.json() as {guid?: string};
      if (sidecar.guid !== ref.guid) throw new Error('资产 GUID 与 sidecar 不一致');
      return createImageBitmap(await image.blob());
    }, private readonly changed: () => void = () => {}) {}
  sync(ref: AssetRef | null | undefined): void {
    const key = JSON.stringify(ref ?? null);
    if (key === this.key) return;
    this.key = key;
    const generation = ++this.generation;
    this.upload(null); this.diagnostic = ''; this.pending = !!ref;
    if (!ref) { this.task = Promise.resolve(); this.changed(); return; }
    this.task = this.decode(ref).then(bitmap => {
      try { if (generation === this.generation) this.upload(bitmap); }
      finally { bitmap.close(); }
    }).catch(error => {
      if (generation === this.generation) {
        this.diagnostic = `天空贴图 ${ref.path}：${String(error)}；当前显示程序天空`;
        console.warn(this.diagnostic);
      }
    }).finally(() => { if (generation === this.generation) { this.pending = false; this.changed(); } });
  }
  async ready(): Promise<void> { await this.task; }
  destroy(): void { ++this.generation; this.pending = false; }
}
