/** Run in a headed browser. Exercises the actual shared WGSL on a real adapter. */
export async function probeComicToneMapping(commonWgsl) {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const samples = [0, 0.001, 0.01, 0.18, 1, 4, 16, 100].map(v => [v,v,v,1]);
  samples.push([1,0,0,1], [0,1,0,1], [0,0,1,1]);
  const data = new Float32Array(samples.flat());
  const input = device.createBuffer({size:data.byteLength, usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
  const output = device.createBuffer({size:data.byteLength, usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
  const read = device.createBuffer({size:data.byteLength, usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
  try {
    device.queue.writeBuffer(input,0,data);
    const module = device.createShaderModule({code:commonWgsl + `
      @group(0) @binding(0) var<storage,read> src:array<vec4f>;
      @group(0) @binding(1) var<storage,read_write> dst:array<vec4f>;
      @compute @workgroup_size(1) fn probe(@builtin(global_invocation_id) id:vec3u) {
        dst[id.x]=vec4f(linearToSrgb(tonemapAgx(src[id.x].rgb)),1);
      }`});
    const pipeline = await device.createComputePipelineAsync({layout:'auto', compute:{module,entryPoint:'probe'}});
    const bg = device.createBindGroup({layout:pipeline.getBindGroupLayout(0), entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}}]});
    const encoder = device.createCommandEncoder(); const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0,bg); pass.dispatchWorkgroups(samples.length); pass.end();
    encoder.copyBufferToBuffer(output,0,read,0,data.byteLength); device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const values = Array.from(new Float32Array(read.getMappedRange())); read.unmap();
    const colors = samples.map((_, i) => values.slice(i*4,i*4+3));
    const gray = colors.slice(0,8);
    const checks = {
      finite: values.every(Number.isFinite),
      black: Math.max(...gray[0]) < 0.002,
      monotonic: gray.every((c,i) => i === 0 || c.every((v,k) => v >= gray[i-1][k]-0.001)),
      neutral: gray.every(c => Math.max(...c)-Math.min(...c)<0.004),
      middleGray: gray[3].every(v=>v>0.40 && v<0.56),
      highlightRollOff: gray[5][0] > gray[4][0] && gray[6][0] > gray[5][0] && gray[5][0] < 0.99,
      primaries: [0,1,2].every(k => colors[8+k][k] > Math.max(...colors[8+k].filter((_,i)=>i!==k)) + 0.12),
    };
    return {gpu:{vendor:adapter.info.vendor,architecture:adapter.info.architecture}, checks, samples, colors, pass:Object.values(checks).every(Boolean)};
  } finally { input.destroy(); output.destroy(); read.destroy(); device.destroy(); }
}

/** Pixel regression of the production post shader and CPU uniform packer together. */
export async function probeComicPost(postWgsl, packPost, defaults) {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const owned = [];
  const texture = format => { const t = device.createTexture({size:[1,1],format,
    usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC}); owned.push(t); return t; };
  const hdr = texture('rgba16float'), aux = texture('rgba16float'), output = texture('rgba8unorm');
  const uniform = device.createBuffer({size:176,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const read = device.createBuffer({size:256,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}); owned.push(uniform,read);
  try {
    const module = device.createShaderModule({code:postWgsl});
    const pipeline = await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs_fullscreen'},
      fragment:{module,entryPoint:'fs_post',targets:[{format:'rgba8unorm'}]}});
    const bg = device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:uniform}}, {binding:1,resource:hdr.createView()},
      {binding:2,resource:aux.createView()}, {binding:3,resource:device.createSampler({minFilter:'linear',magFilter:'linear'})},
    ]});
    const sample = async (saturation, ink) => {
      const values = new Float32Array(44);
      packPost(values,{...defaults,tonemapMode:0,exposure:1,bloomEnabled:false,halftoneEnabled:false,vignette:0,
        gradeEnabled:true,gradeShadowRange:0,gradeMidRange:1,gradeEdge:0.01,gradeMidMult:1,gradeMidSat:saturation,
        outlinePostExempt:true,inkColor:'#14110f',debugMode:0},1,1);
      device.queue.writeBuffer(uniform,0,values);
      const e = device.createCommandEncoder();
      const clear = e.beginRenderPass({colorAttachments:[
        {view:hdr.createView(),loadOp:'clear',storeOp:'store',clearValue:[0.5,0.25,0.0625,1]},
        {view:aux.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,ink?1:0]},
      ]}); clear.end();
      const p = e.beginRenderPass({colorAttachments:[{view:output.createView(),loadOp:'clear',storeOp:'store'}]});
      p.setPipeline(pipeline);p.setBindGroup(0,bg);p.draw(3);p.end();
      e.copyTextureToBuffer({texture:output},{buffer:read,bytesPerRow:256},[1,1]);device.queue.submit([e.finish()]);
      await read.mapAsync(GPUMapMode.READ);const pixel=Array.from(new Uint8Array(read.getMappedRange()).slice(0,4));read.unmap();return pixel;
    };
    const gray=await sample(0,false),color=await sample(1,false),ink=await sample(1,true);
    const checks={midSaturationZero:Math.max(...gray.slice(0,3))-Math.min(...gray.slice(0,3))<=1,
      midSaturationOne:color[0]>color[1]+20&&color[1]>color[2]+20,
      inkExact:ink.slice(0,3).every((v,i)=>Math.abs(v-[20,17,15][i])<=1)};
    return {gpu:{vendor:adapter.info.vendor,architecture:adapter.info.architecture},gray,color,ink,checks,pass:Object.values(checks).every(Boolean)};
  } finally { for(const resource of owned)resource.destroy();device.destroy(); }
}
