import { ProceduralDecalPass } from './procedural-decals';

const DISPLAY = /* wgsl */`
@group(0) @binding(0) var image:texture_2d<f32>;
struct V {@builtin(position) p:vec4f};
@vertex fn vs(@builtin(vertex_index) i:u32)->V {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var v:V;v.p=vec4f(p[i],0,1);return v;
}
@fragment fn fs(v:V)->@location(0) vec4f {
 let pixel=vec2u(v.p.xy);let ink=textureLoad(image,vec2i(pixel),0);
 let check=f32((pixel.x/24+pixel.y/24)%2u);let bg=vec3f(mix(.20,.30,check));
 let rgb=ink.rgb+bg*(1.-ink.a);return vec4f(pow(max(rgb,vec3f(0)),vec3f(1./2.2)),1);
}`;
/** 通用离屏图案预览：与场景共享完整 SDF 管线，不复制图案公式。调用者持有生命周期。 */
export class DecalPreviewRenderer {
  private frame: GPUBuffer;
  private pass: ProceduralDecalPass;
  private pipeline: GPURenderPipeline;
  private textures: GPUTexture[] = []; private group: GPUBindGroup | null = null;
  private width = 0; private height = 0;
  constructor(private device: GPUDevice, private context: GPUCanvasContext, format: GPUTextureFormat) {
    context.configure({ device, format, alphaMode: 'opaque' });
    this.frame = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'decal-preview-frame' });
    this.pass = new ProceduralDecalPass(device, this.frame, 'rgba16float', 'depth32float');
    const module = device.createShaderModule({ code: DISPLAY, label: 'decal-preview-display' });
    this.pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } });
  }
  draw(data: Float32Array<ArrayBuffer>, matrix: Float32Array<ArrayBuffer>, width: number, height: number): void {
    if (width !== this.width || height !== this.height) {
      this.textures.forEach(t => t.destroy()); this.width = width; this.height = height;
      this.textures = ['rgba16float', 'rgba16float', 'depth32float'].map((format, i) => this.device.createTexture({ size: [width, height], format: format as GPUTextureFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT | (i === 0 ? GPUTextureUsage.TEXTURE_BINDING : 0), label: 'decal-preview-target' }));
      this.group = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: this.textures[0]!.createView() }] });
    }
    this.device.queue.writeBuffer(this.frame, 0, matrix);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: this.textures.slice(0, 2).map(t => ({ view: t.createView(), loadOp: 'clear' as const, storeOp: 'store' as const, clearValue: [0, 0, 0, 0] })), depthStencilAttachment: { view: this.textures[2]!.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 } });
    this.pass.draw(pass, data); pass.end();
    const display = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
    display.setPipeline(this.pipeline); display.setBindGroup(0, this.group!); display.draw(3); display.end();
    this.device.queue.submit([encoder.finish()]);
  }
  snapshot() { return { ...this.pass.snapshot(), targets: this.textures.length, width: this.width, height: this.height }; }
  destroy(): void { this.pass.clear(); this.frame.destroy(); this.textures.forEach(t => t.destroy()); this.textures = []; this.group = null; this.context.unconfigure(); }
}
