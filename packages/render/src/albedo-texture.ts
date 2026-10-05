/** Texture-local mip chain. No global GPU resources; texture destruction releases all levels. */
export function createAlbedoTexture(device: GPUDevice, bitmap: ImageBitmap): GPUTexture {
  const mipLevelCount = 1 + Math.floor(Math.log2(Math.max(bitmap.width, bitmap.height)));
  const texture = device.createTexture({ label: 'mipmapped-albedo', size: [bitmap.width, bitmap.height],
    format: 'rgba8unorm', mipLevelCount,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
  device.queue.copyExternalImageToTexture({ source: bitmap, flipY: false }, { texture }, [bitmap.width, bitmap.height]);
  if (mipLevelCount === 1) return texture;
  const module = device.createShaderModule({ code: `
    @group(0) @binding(0) var tex: texture_2d<f32>;
    @group(0) @binding(1) var samp: sampler;
    struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
    @vertex fn vs(@builtin(vertex_index) i:u32)->Out {
      let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];
      var o:Out; o.pos=vec4f(p,0,1); o.uv=vec2f(p.x*.5+.5,.5-p.y*.5); return o;
    }
    @fragment fn fs(i:Out)->@location(0) vec4f { return textureSample(tex,samp,i.uv); }
  ` });
  const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] } });
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const encoder = device.createCommandEncoder({ label: 'albedo-mip-chain' });
  for (let level = 1; level < mipLevelCount; level++) {
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
      { binding: 1, resource: sampler },
    ] });
    const pass = encoder.beginRenderPass({ colorAttachments: [{
      view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }), loadOp: 'clear', storeOp: 'store',
    }] });
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
  }
  device.queue.submit([encoder.finish()]);
  return texture;
}
