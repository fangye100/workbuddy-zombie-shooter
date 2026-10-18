import {it,expect} from 'vitest';
import {maxAssetDockHeight,MIN_EDITOR_VIEWPORT_HEIGHT} from '../src/services/dock-layout';
import {clamp} from '../src/splitter';
it('以实际主行剩余高度预算dock，顶部额外工具栏和小窗口不会吞掉视口',()=>{
  expect(maxAssetDockHeight(820)).toBe(620);
  expect(maxAssetDockHeight(720)).toBe(520);
  expect(820-maxAssetDockHeight(820)).toBe(MIN_EDITOR_VIEWPORT_HEIGHT);
  expect(maxAssetDockHeight(280)).toBe(80);expect(clamp(1000,140,maxAssetDockHeight(280))).toBe(80);
  for(const height of [0,150,-10,NaN,Infinity])expect(maxAssetDockHeight(height)).toBe(0);
});
