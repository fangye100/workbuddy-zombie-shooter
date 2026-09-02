export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  info: {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
    features: string[];
  };
}

export class GpuUnavailableError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = 'GpuUnavailableError';
  }
}

export async function initGpu(canvas: HTMLCanvasElement): Promise<GpuContext> {
  if (!('gpu' in navigator) || navigator.gpu === undefined) {
    throw new GpuUnavailableError(
      '当前浏览器不支持 WebGPU',
      '需要 Chrome 113+ / Edge 113+ / Safari 18+。' +
        '在 Chrome 地址栏访问 <code>chrome://gpu</code> 可以确认 WebGPU 的启用状态。',
    );
  }

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  });

  if (adapter === null) {
    throw new GpuUnavailableError(
      '找不到可用的 GPU 适配器',
      '通常是显卡驱动过旧或浏览器把 WebGPU 列入了黑名单。' +
        '先更新显卡驱动，再在 <code>chrome://gpu</code> 里确认 WebGPU 未被禁用。',
    );
  }

  const device = await adapter.requestDevice({
    label: 'aether-game-editor',
    requiredLimits: {
      maxBindGroups: 4,
    },
  });

  const context = canvas.getContext('webgpu');
  if (context === null) {
    throw new GpuUnavailableError('无法获取 WebGPU canvas 上下文', 'canvas.getContext("webgpu") 返回 null。');
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: 'opaque',
  });

  // adapter.info 在部分浏览器上仍是 requestAdapterInfo()，两者都试
  let vendor = '';
  let architecture = '';
  let deviceName = '';
  let description = '';
  const infoAny = adapter as unknown as {
    info?: { vendor?: string; architecture?: string; device?: string; description?: string };
    requestAdapterInfo?: () => Promise<Record<string, string>>;
  };

  if (infoAny.info !== undefined) {
    vendor = infoAny.info.vendor ?? '';
    architecture = infoAny.info.architecture ?? '';
    deviceName = infoAny.info.device ?? '';
    description = infoAny.info.description ?? '';
  } else if (typeof infoAny.requestAdapterInfo === 'function') {
    try {
      const legacy = await infoAny.requestAdapterInfo();
      vendor = legacy['vendor'] ?? '';
      architecture = legacy['architecture'] ?? '';
      deviceName = legacy['device'] ?? '';
      description = legacy['description'] ?? '';
    } catch {
      // 拿不到适配器信息不影响调试功能，留空即可
    }
  }

  return {
    adapter,
    device,
    context,
    format,
    info: {
      vendor,
      architecture,
      device: deviceName,
      description,
      features: [...adapter.features].sort(),
    },
  };
}
