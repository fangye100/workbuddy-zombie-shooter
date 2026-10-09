/** Caller owns the returned bitmap. Close the full-resolution decode on success
 * and failure so runtime caches never retain an oversized source texture.
 */
export async function decodeBoundedBitmap(blob: Blob, maxDimension: number): Promise<ImageBitmap> {
  const raw = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
  if (Math.max(raw.width, raw.height) <= maxDimension) return raw;
  const scale = maxDimension / Math.max(raw.width, raw.height);
  const width = Math.max(1, Math.round(raw.width * scale)), height = Math.max(1, Math.round(raw.height * scale));
  try {
    const resized = await createImageBitmap(raw, { colorSpaceConversion: 'none', resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
    if (resized.width !== width || resized.height !== height) { resized.close(); throw new Error('Browser did not honor actor texture size limit'); }
    return resized;
  } finally { raw.close(); }
}
