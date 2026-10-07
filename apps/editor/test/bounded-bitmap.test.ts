import { afterEach, expect, it, vi } from 'vitest';
import { decodeBoundedBitmap } from '../src/services/bounded-bitmap';
afterEach(() => vi.unstubAllGlobals());
it('bounds portrait textures without distorting aspect and closes the large decode', async () => {
  const raw = { width: 2048, height: 4096, close: vi.fn() }, result = { width: 512, height: 1024, close: vi.fn() };
  const decode = vi.fn().mockResolvedValueOnce(raw).mockResolvedValueOnce(result);
  vi.stubGlobal('createImageBitmap', decode);
  expect(await decodeBoundedBitmap(new Blob(), 1024)).toBe(result);
  expect(decode.mock.calls[1]).toEqual([raw, { colorSpaceConversion: 'none', resizeWidth: 512, resizeHeight: 1024, resizeQuality: 'high' }]);
  expect(raw.close).toHaveBeenCalledOnce(); expect(result.close).not.toHaveBeenCalled();
});
it('releases decoded memory when resizing fails or is unsupported', async () => {
  for (const unsupported of [false, true]) {
    const raw = { width: 4096, height: 4096, close: vi.fn() }, result = { width: 4096, height: 4096, close: vi.fn() };
    const decode = vi.fn().mockResolvedValueOnce(raw);
    if (unsupported) decode.mockResolvedValueOnce(result); else decode.mockRejectedValueOnce(new Error('Decode failed'));
    vi.stubGlobal('createImageBitmap', decode);
    await expect(decodeBoundedBitmap(new Blob(), 1024)).rejects.toThrow();
    expect(raw.close).toHaveBeenCalledOnce();
    if (unsupported) expect(result.close).toHaveBeenCalledOnce();
  }
});
it('returns small images without an extra decode or premature close', async () => {
  const raw = { width: 512, height: 256, close: vi.fn() }, decode = vi.fn().mockResolvedValue(raw);
  vi.stubGlobal('createImageBitmap', decode);
  expect(await decodeBoundedBitmap(new Blob(), 1024)).toBe(raw);
  expect(decode).toHaveBeenCalledOnce(); expect(raw.close).not.toHaveBeenCalled();
});
