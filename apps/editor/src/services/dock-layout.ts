/** 主行包含视口和资产库；预算不包含顶栏，避免旧窗口高度挤掉视口。 */
export const MIN_EDITOR_VIEWPORT_HEIGHT=200;
export function maxAssetDockHeight(mainRowHeight:number):number {
  if(!Number.isFinite(mainRowHeight))return 0;
  return Math.max(0,Math.floor(mainRowHeight)-MIN_EDITOR_VIEWPORT_HEIGHT);
}
