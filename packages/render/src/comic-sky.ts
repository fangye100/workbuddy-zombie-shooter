import { hexToRgb } from '@aether/core';
import type { ComicSkyData } from '@aether/scene';

/** A directional sky dome rendered at infinity. All art parameters come from the scene. */
export const COMIC_SKY_WGSL = /* wgsl */ `
struct Sky {
  inverseVP: mat4x4f,
  eye: vec4f,
  zenith: vec4f,
  horizon: vec4f,
  ground: vec4f,
  cloud: vec4f,
  sun: vec4f,
  direction: vec4f,
  weather: vec4f,
};
@group(0) @binding(0) var<uniform> sky: Sky;
struct VOut { @builtin(position) position: vec4f, @location(0) ndc: vec2f };
struct FOut { @location(0) color: vec4f, @location(1) aux: vec4f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: VOut; o.position = vec4f(p, 1.0, 1.0); o.ndc = p; return o;
}
fn noise(p: vec2f) -> f32 {
  let cell = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  let n = sin(vec4f(dot(cell, vec2f(127.1,311.7)), dot(cell + vec2f(1,0), vec2f(127.1,311.7)),
    dot(cell + vec2f(0,1), vec2f(127.1,311.7)), dot(cell + vec2f(1,1), vec2f(127.1,311.7)))) * 43758.5453;
  let h = fract(n); return mix(mix(h.x,h.y,u.x), mix(h.z,h.w,u.x), u.y);
}
fn linear(c: vec3f) -> vec3f { return pow(max(c, vec3f(0)), vec3f(2.2)); }
@fragment fn fs(v: VOut) -> FOut {
  let far = sky.inverseVP * vec4f(v.ndc, 1.0, 1.0);
  let ray = normalize(far.xyz / far.w - sky.eye.xyz);
  let height = clamp(ray.y, 0.0, 1.0);
  var color = mix(linear(sky.horizon.rgb), linear(sky.zenith.rgb), smoothstep(0.0, 0.72, height));
  // Cloud coordinates are world-direction anchored; orbiting cannot drag the sky with the camera.
  let p = ray.xz / (0.22 + max(ray.y, 0.0)) * sky.weather.y + vec2f(sky.eye.w * sky.weather.z, 0.0);
  let n = noise(p) * 0.65 + noise(p * 2.07) * 0.25 + noise(p * 4.13) * 0.1;
  let threshold = 1.0 - sky.weather.x;
  let aa = max(0.008, fwidth(n));
  let mask = smoothstep(threshold - aa, threshold + aa, n) * smoothstep(-0.02, 0.12, ray.y);
  // Two painted cloud values and a restrained dark contour, not photorealistic volumetrics.
  let lightBand = smoothstep(threshold + 0.13 - aa, threshold + 0.13 + aa, n);
  let cloud = mix(linear(sky.cloud.rgb) * 0.60, linear(sky.cloud.rgb), lightBand);
  color = mix(color, cloud, mask * 0.82);
  let sunAngle = dot(ray, normalize(sky.direction.xyz));
  let disc = smoothstep(cos(sky.direction.w), cos(sky.direction.w * 0.82), sunAngle);
  color = mix(color, linear(sky.sun.rgb) * 1.4, disc * (1.0 - mask * 0.75));
  color = mix(linear(sky.ground.rgb), color, smoothstep(-0.18, 0.01, ray.y));
  var o: FOut; o.color = vec4f(color, 1); o.aux = vec4f(0.15,0,0,0); return o;
}`;

export class ComicSkyPass {
  private readonly buffer: GPUBuffer;
  private readonly pipeline: GPURenderPipeline;
  private readonly group: GPUBindGroup;
  private readonly data = new Float32Array(48);
  constructor(private readonly device: GPUDevice, hdrFormat: GPUTextureFormat, depthFormat: GPUTextureFormat) {
    this.buffer = device.createBuffer({ label: 'comic-sky', size: 192, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ label: 'comic-sky', code: COMIC_SKY_WGSL });
    void module.getCompilationInfo().then(info => { for (const m of info.messages) if (m.type === 'error') console.error(`[comic-sky] ${m.lineNum}: ${m.message}`); });
    this.pipeline = device.createRenderPipeline({ label: 'comic-sky', layout: 'auto',
      vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{format: hdrFormat}, {format: hdrFormat}] },
      primitive: { topology: 'triangle-list' }, depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less-equal' },
    });
    this.group = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: this.buffer}}] });
  }
  draw(pass: GPURenderPassEncoder, sky: ComicSkyData, inverseVP: Float32Array, eye: readonly number[], time: number): void {
    const d = this.data; d.set(inverseVP, 0); d.set([eye[0]!, eye[1]!, eye[2]!, time], 16);
    for (const [index, color] of [sky.zenith, sky.horizon, sky.ground, sky.cloud, sky.sunColor].entries()) d.set([...hexToRgb(color), 1], 20 + index * 4);
    d.set([...sky.sunDirection, sky.sunSize], 40); d.set([sky.cloudCoverage, sky.cloudScale, sky.cloudSpeed, 0], 44);
    this.device.queue.writeBuffer(this.buffer, 0, d);
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.group); pass.draw(3);
  }
  destroy(): void { this.buffer.destroy(); }
}
