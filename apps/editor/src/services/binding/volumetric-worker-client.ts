import type { BindingSession } from './binding-session';
import type { VolumetricResult } from './volumetric-skin';
type Input = Parameters<Parameters<BindingSession['computeSkinAsync']>[0]>[0];
export function solveVolumeInWorker(input: Input, signal: AbortSignal): Promise<VolumetricResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('体积蒙皮已取消')); return; }
    const worker = new Worker(new URL('./volumetric-worker.ts', import.meta.url), { type: 'module' });
    const cleanup = (): void => { signal.removeEventListener('abort', abort); worker.terminate(); };
    const abort = (): void => { cleanup(); reject(new Error('体积蒙皮已取消')); };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<{ result?: VolumetricResult; error?: string }>) => {
      cleanup(); if (data.result) resolve(data.result); else reject(new Error(data.error ?? '体积蒙皮 Worker 未返回结果'));
    };
    worker.onerror = (event) => { cleanup(); reject(new Error(event.message)); };
    // Structured clone, never transfer the session's live mesh buffers.
    try { worker.postMessage(input); } catch (error) { cleanup(); reject(error); }
  });
}
