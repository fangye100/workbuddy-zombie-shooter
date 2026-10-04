/** Editor display preference, not authored scene content. CSS/UI stays at native resolution. */
export function renderPixelRatio(width: number, height: number, deviceScale: number, native = false): number {
  const scale = Math.min(2, Math.max(1, deviceScale || 1));
  if (native || width <= 0 || height <= 0) return scale;
  return Math.min(scale, Math.sqrt(1280 * 800 / (width * height)));
}
