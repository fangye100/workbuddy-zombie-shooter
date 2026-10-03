/** Accepted load versions for GUI and MCP. Local binding edits remain owned by BindingSession. */
import { validateAssetMeta } from '@aether/scene';
import { sceneFingerprint } from '@aether/runtime';
import type { WriteResult } from '../../asset-util';

export interface BindingSaveRequest {
  path: string;
  baseHash: string;
  patch: Record<string, unknown>;
  candidate: Record<string, unknown>;
  generation: number;
}

export class BindingPersistence {
  private accepted: { path: string; meta: Record<string, unknown>; hash: string } | null = null;
  private generation = 0;
  private saving = false;

  clear(): void { this.accepted = null; this.generation++; }

  accept(path: string, meta: unknown): string | null {
    this.clear();
    const errors = validateAssetMeta(meta).filter((diag) => diag.severity === 'error');
    if (errors.length > 0) return `sidecar 校验失败：${errors.map((diag) => `${diag.code} ${diag.message}`).join('；')}`;
    const copy = JSON.parse(JSON.stringify(meta)) as Record<string, unknown>;
    this.accepted = { path, meta: copy, hash: sceneFingerprint(copy) };
    return null;
  }

  prepare(data: unknown): BindingSaveRequest {
    if (this.saving) throw new Error('上一次绑定保存尚未完成');
    if (this.accepted === null) throw new Error('没有已接受的 sidecar 基准版本，请重新载入/回填合法 sidecar');
    const bindingEditor: unknown = JSON.parse(JSON.stringify(data));
    const candidate = { ...this.accepted.meta, bindingEditor };
    const errors = validateAssetMeta(candidate).filter((diag) => diag.severity === 'error');
    if (errors.length > 0) throw new Error(`写前校验失败：${errors.map((diag) => `${diag.code} ${diag.message}`).join('；')}`);
    return { path: this.accepted.path, baseHash: this.accepted.hash, patch: { bindingEditor }, candidate, generation: this.generation };
  }

  async save(data: unknown, write: (request: BindingSaveRequest) => Promise<WriteResult>): Promise<WriteResult> {
    const request = this.prepare(data);
    this.saving = true;
    try {
      const result = await write(request);
      if (result.ok && request.generation === this.generation) {
        this.accepted = { path: request.path, meta: request.candidate, hash: result.hash ?? sceneFingerprint(request.candidate) };
      }
      return result;
    } finally { this.saving = false; }
  }
}
