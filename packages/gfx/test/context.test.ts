import { afterEach, describe, expect, it, vi } from 'vitest';
import { initGpu } from '../src/context';

afterEach(() => vi.unstubAllGlobals());
describe('editor GPU optional timestamp capability', () => {
  for (const supported of [true, false]) it(`boots when timestamp-query support is ${supported}`, async () => {
    const configure = vi.fn(), device = {}, features = new Set(supported ? ['timestamp-query'] : []);
    const requestDevice = vi.fn().mockResolvedValue(device);
    const adapter = { features, requestDevice, info: { vendor: 'test-hardware' } };
    vi.stubGlobal('navigator', { gpu: { requestAdapter: vi.fn().mockResolvedValue(adapter), getPreferredCanvasFormat: () => 'bgra8unorm' } });
    const canvas = { getContext: () => ({ configure }) } as unknown as HTMLCanvasElement;
    const result = await initGpu(canvas);
    expect(requestDevice).toHaveBeenCalledWith({ label: 'aether-game-editor', requiredFeatures: supported ? ['timestamp-query'] : [], requiredLimits: { maxBindGroups: 4 } });
    expect(result.device).toBe(device);
    expect(configure).toHaveBeenCalledWith({ device, format: 'bgra8unorm', alphaMode: 'opaque' });
  });
});
