import { describe, it, expect, vi, afterEach } from 'vitest';
import { DecalPreviewRenderer } from '../src/decal-preview';

describe('贴花独立预览资源', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('复用批缓冲，resize 释放旧 target，关闭释放全部自有缓冲和 target 并解绑画布', () => {
    // 仅验证资源责任；Shader 编译和真实图像由 headed GPU 验收覆盖。
    vi.stubGlobal('GPUBufferUsage', { UNIFORM: 64, COPY_DST: 8, STORAGE: 128 });
    vi.stubGlobal('GPUTextureUsage', { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 });
    const buffers: { destroy: ReturnType<typeof vi.fn> }[] = [], textures: { destroy: ReturnType<typeof vi.fn>; createView: () => object }[] = [];
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() };
    const device = {
      createBuffer: () => { const b = { destroy: vi.fn() }; buffers.push(b); return b; },
      createTexture: () => { const t = { destroy: vi.fn(), createView: () => ({}) }; textures.push(t); return t; },
      createShaderModule: () => ({}), createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }), createBindGroup: () => ({}),
      createCommandEncoder: () => ({ beginRenderPass: () => pass, finish: () => ({}) }), queue: { writeBuffer: vi.fn(), submit: vi.fn() },
    } as unknown as GPUDevice;
    const context = { configure: vi.fn(), unconfigure: vi.fn(), getCurrentTexture: () => ({ createView: () => ({}) }) };
    const preview = new DecalPreviewRenderer(device, context as unknown as GPUCanvasContext, 'bgra8unorm');
    const data = new Float32Array(16), vp = new Float32Array(16);
    preview.draw(data, vp, 512, 512); preview.draw(data, vp, 512, 512);
    expect(buffers).toHaveLength(2); expect(textures).toHaveLength(3); expect(preview.snapshot().instances).toBe(1);
    preview.draw(data, vp, 800, 600); expect(textures.slice(0, 3).every(t => t.destroy.mock.calls.length === 1)).toBe(true);
    expect(buffers).toHaveLength(2); preview.destroy();
    expect(buffers.every(b => b.destroy.mock.calls.length === 1)).toBe(true);
    expect(textures.every(t => t.destroy.mock.calls.length === 1)).toBe(true); expect(context.unconfigure).toHaveBeenCalledOnce();
  });
});
