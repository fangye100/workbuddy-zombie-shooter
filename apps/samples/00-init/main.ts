/**
 * M0 验收：拿到 device、配置 canvas、稳定 60fps 清屏、能读出能力分级。
 * 这是整个引擎的最小可运行基座，后续所有 Pass 都挂在这个循环上。
 */

import { GfxDevice } from '../../../packages/gfx/src/device';
import type { Capabilities } from '../../../packages/gfx/src/device';

const canvas = document.querySelector<HTMLCanvasElement>('#gpu')!;
const hud = document.querySelector<HTMLPreElement>('#hud')!;

function fail(msg: string): never {
  document.querySelector('#app')!.innerHTML = `<pre id="err">${msg}</pre>`;
  throw new Error(msg);
}

if (!navigator.gpu) {
  fail('当前浏览器不支持 WebGPU。\n请使用 Chrome 113+ / Edge 113+ / Safari 18+。');
}

// ---------------------------------------------------------------- 画布尺寸

let renderWidth = 0;
let renderHeight = 0;

function resize(canvasEl: HTMLCanvasElement): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvasEl.getBoundingClientRect();
  renderWidth = Math.max(1, Math.floor(rect.width * dpr));
  renderHeight = Math.max(1, Math.floor(rect.height * dpr));
  // devicePixelClampedSize 防止超出 maxTextureDimension2D
  const max = 8192;
  renderWidth = Math.min(renderWidth, max);
  renderHeight = Math.min(renderHeight, max);
  canvasEl.width = renderWidth;
  canvasEl.height = renderHeight;
}

// ---------------------------------------------------------------- 主循环

let gfx: GfxDevice;
let frames = 0;
let fpsAccum = 0;
let fps = 0;
let last = performance.now();

async function main(): Promise<void> {
  gfx = await GfxDevice.create({
    canvas,
    tier: 't1',
    enableValidation: import.meta.env.DEV,
    statsBufferBytes: 4 << 20,
  });

  resize(canvas);
  new ResizeObserver(() => resize(canvas)).observe(canvas);

  requestAnimationFrame(tick);
}

function tick(now: number): void {
  const dt = (now - last) / 1000;
  last = now;

  // FPS 滑窗
  fpsAccum += dt;
  frames++;
  if (fpsAccum >= 0.5) {
    fps = Math.round(frames / fpsAccum);
    frames = 0;
    fpsAccum = 0;
  }

  gfx.beginFrame();

  const encoder = gfx.device.createCommandEncoder({ label: 'clear' });
  const view = gfx.swapchainTexture.createView();

  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view,
      loadOp: 'clear',
      storeOp: 'store',
      // 用帧序号做一个缓慢的色相呼吸，确认循环真的在跑
      clearValue: {
        r: 0.05 + 0.03 * Math.sin(gfx.frame * 0.01),
        g: 0.06,
        b: 0.09,
        a: 1,
      },
    }],
  });
  pass.end();

  gfx.device.queue.submit([encoder.finish()]);
  gfx.endFrame();

  if (gfx.frame % 10 === 0) hud.textContent = renderHud(gfx.capabilities, fps);
  requestAnimationFrame(tick);
}

function renderHud(caps: Capabilities, currentFps: number): string {
  const feats = [...caps.features].filter(f => !f.startsWith('texture-compression'));
  return [
    `aether  M0  device-init`,
    `fps ${currentFps}   ${renderWidth}×${renderHeight}`,
    `tier ${caps.tier}   format ${caps.preferredFormat}`,
    `bindGroups ${caps.maxBindGroups}   timestamp ${caps.supportsTimestamp}   subgroups ${caps.supportsSubgroups}`,
    `features: ${feats.join(', ') || '(baseline)'}`,
  ].join('\n');
}

void main().catch(e => fail(String(e?.message ?? e)));
