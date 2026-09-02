# L1/L2 — WebGPU 设备、资源层与 FrameGraph

WebGPU 是显式 API：所有同步、生命周期、内存别名都要开发者负责。这一层的目标是用
**缓存 + 句柄 + 帧图** 把复杂度收敛，同时保留 escape hatch。

---

## 1. 设备初始化与能力分级

### 1.1 初始化流程

```ts
const adapter = await navigator.gpu.requestAdapter({
  powerPreference: 'high-performance',   // 笔记本双显卡时选独显
  // featureLevel: 'core'（默认），不再有 compatibility mode 的 fallback 需求
});
const device = await adapter.requestDevice({
  requiredFeatures: pickFeatures(adapter.features, TIER1),
  requiredLimits: {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize:               adapter.limits.maxBufferSize,
    maxTextureArrayLayers:       Math.min(256, adapter.limits.maxTextureArrayLayers),
    maxBindGroups:               Math.min(6, adapter.limits.maxBindGroups), // 注意 baseline 是 4
  },
  defaultQueue: {}, label: 'aether-device',
});
```

> ⚠️ `maxBindGroups` 的 WebGPU **baseline 下限只有 4**。下面第 3 节的 5 组绑定模型在
> 低端设备上必须能降级（把 PerView 塞进 PerFrame，用 dynamic offset 切相机）。

### 1.2 Feature Tier（能力门控，非二进制开关）

| Tier | Features | 用途 | 缺失时降级 |
|---|---|---|---|
| **T0 基线** | — | 所有核心功能可用 | — |
| **T1** | `timestamp-query` | GPU 时间线剖析 | 用 CPU 侧 `onSubmittedWorkDone` 粗测 |
| | `texture-compression-bc / etc2 / astc` | 显存与带宽 | 运行时转码为 RGBA8（体积 ×4） |
| | `depth-clip-control` | 反向 Z 需要 `depthCompare='greater'` + 关闭裁剪 | 用常规 depth + `unclippedDepth` 关闭 |
| | `indirect-first-instance` | GPU-driven 多实例绘制 | draw 循环拆分 |
| **T2** | `subgroups` | 快速归约（剔除、clustered、排序） | 走 shared memory 归约 |
| | `shader-f16` | 半精度材质数据，带宽减半 | 全 f32 |
| | `float32-filterable` | 线性过滤 HDR 缓冲（Bloom） | 手动双线性采样 |
| | `clip-distances` | GPU 裁剪平面（反射/剖切） | discard 模拟 |
| **T3 实验** | `texture binding array`（Chrome flag） | 真 bindless | 回退到 `texture_2d_array` 图集方案 |

**`Capabilities` 对象**在启动时生成，参与 **shader permutation key** 与 **pipeline key**，
保证同一套 WGSL 源码在不同设备上走不同变体，不需要运行时分支。

### 1.3 设备丢失与错误

```ts
device.lost.then(info => {
  if (info.reason === 'destroyed') return;      // 主动销毁，正常
  deviceLostHandler(info);                       // → 走 ResourceRegistry 全量重建
});
device.addEventListener('uncapturederror', e => reportOnce(e.error));  // 去重上报
```

- **Dev 模式**：所有创建调用包 `pushErrorScope('validation')`，异步检查后打出调用栈。
- **ResourceRegistry** 记录每个资源的**重建闭包**（buffer 记数据回传函数、texture 记
  上传源），`device.lost` 后统一重放。这是唯一可靠的恢复路径。

### 1.4 Canvas 配置

```ts
context.configure({
  device,
  format: navigator.gpu.getPreferredCanvasFormat(),  // 通常 bgra8unorm
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  alphaMode: 'opaque',        // UI 合成在引擎内完成；需要透传时用 'premultiplied'
  // toneMapping / colorSpace：HDR 走 { mode:'hdr', colorSpace:'display-p3' }（渐进增强）
});
```

- **sRGB**：所有 RT 用 `-srgb` 格式（`bgra8unorm-srgb` / `rgba16float` 用于 HDR），
  让硬件免费做 gamma 转换。
- **DPR**：`min(devicePixelRatio, 2)`，配合动态分辨率（0.5×–1.0× 由 Adaptive Quality 控制）。

---

## 2. 资源层

### 2.1 句柄系统

业务层永远不持有 `GPUBuffer`，只持有 `BufferHandle { index:u32, generation:u16 }`。
`GfxDevice.resolve(h)` 命中 `ResourceSlot[]`，generation 不匹配即判为 use-after-free。

```ts
interface ResourceSlot {
  generation: u16;
  buffer?: GPUBuffer; texture?: GPUTexture; view?: GPUTextureView;
  name: string; sizeBytes: number; debugLabel: string;
}
```

### 2.2 缓冲区分配策略

| 分配器 | 用途 | 策略 |
|---|---|---|
| `UniformRing` | PerFrame / PerView / PerDraw 小 uniform | 单大 buffer，`minUniformBufferOffsetAlignment`(256B) 对齐，每帧 reset，**用 dynamic offset 零 bindgroup 切换** |
| `StorageSoA` | ObjectData / LightData / BoneMatrix | 大容量 `STORAGE`，CPU 端一次性 `writeBuffer` 批量上传；GPU-driven 时由 compute 写 |
| `StagingRing` | 纹理/网格上传 | `MAP_WRITE` 持久化映射，`mapAsync` 只在**上上帧**才复用（3 帧 ring） |
| `TransientArena` | FrameGraph 内部中间 RT | 帧内分配，GPU 完成后整块归还，见 §4.4 |
| `ScratchUpload` | 一次性静态数据 | `writeBuffer` 直传（< 64KB 时比 staging 更快） |

**统计账本**：每类分配器上报 `used / peak / wasted`，Profiler 面板展示显存水位。

### 2.3 纹理

- 压缩格式：**KTX2 容器 + Basis Universal**，运行时按设备支持的压缩族转码（WASM）。
- 图集 / 数组纹理：材质纹理统一走 `texture_2d_array`（`maxTextureArrayLayers ≥ 256`），
  `MaterialData.texLayer[i]` 存 layer index。这是当前 WebGPU 下 bindless 的**实用替代**。
- Mip：烘焙期生成 + `generateMipmaps` 运行时兜底；采样用 `anisotropic` 需要
  `maxAnisotropy`（非 feature，属 limit）。
- **虚拟纹理**：地形与大世界用 Page Table（`rgba8unorm` indirection + tile atlas），
  反馈缓冲由 compute 读回（异步 `mapAsync`，延迟 2 帧容忍）。

### 2.4 缓存三件套（性能命门）

```ts
BindGroupCache   // key = layoutId + 资源 id 数组哈希 + dynamicOffsets；LRU 上限 4096
PipelineCache    // key = shaderModuleId + permutationHash + colorFormats + depthFormat
                 //      + sampleCount + blend/depthState + vertexLayoutHash
SamplerCache     // key = (magFilter, minFilter, mipmapFilter, addressU/V/W, maxAniso, compare)
```

- 全部用 **结构哈希 + 字符串 key** 双缓存（快路径 int 哈希，慢路径用于调试可视化）。
- Pipeline 一律用 **`createRenderPipelineAsync`**，未就绪时该 material 走"延迟出画"
  （先画默认材质，下帧替换），绝不阻塞主线程。
- **ShaderModuleCache**：WGSL 源码 → module，源码做内容 hash；热重载时按 hash 替换。

### 2.5 着色器系统（ShaderLab）

```
assets/shaders/
  ├─ lib/            # 可 include 的 WGSL chunk（brdf.wgsl, cluster.wgsl, noise.wgsl…）
  ├─ pbr.wgsl
  └─ pbr.material    # YAML: 定义 variant 维度、绑定布局、默认 uniform 值
```

```yaml
# pbr.material
name: pbr
vertex:   pbr.wgsl#vs_main
fragment: pbr.wgsl#fs_main
includes: [lib/brdf.wgsl, lib/cluster.wgsl]
variants:
  - ALBEDO_MAP: [0, 1]
  - NORMAL_MAP: [0, 1]
  - SKINNED:    [0, 1]
  - SHADOW_CASCADES: [1, 2, 4]
bindings: { group0: per-frame, group1: per-view, group3: per-material }
```

- 预处理：自研 `#include` 展开 + `#define` 注入 → 生成 `(permutationKey, wgslSource)`。
- **变体爆炸控制**：把不常用维度改成 uniform 分支（如 `SHADOW_CASCADES` 用循环 + uniform
  上限），只保留 `SKINNED / ALPHA_TEST / ALBEDO_MAP` 这类真影响寄存器分配的维度。
- 构建期用 **naga / tint** 校验所有变体，CI 拦截语法错误；运行时只查缓存。

---

## 3. 绑定模型（Binding Model）

这是决定 draw call 开销的核心。采用**频率分层**，与更新频率严格对应：

| Group | 名称 | 内容 | 更新频率 | 数量级 |
|---|---|---|---|---|
| `@group(0)` | **PerFrame** | FrameUniform（time, dt, sun, fog, screen size, frame id）、ClusterLightGrid、ShadowAtlas、EnvMap、BlueNoise、全局 Sampler | 1 次/帧 | 1 |
| `@group(1)` | **PerView** | ViewUniform（view, proj, viewProj, invProj, jitter, cameraPos, far/near, exposure） | 每相机 | 1–8 |
| `@group(2)` | **PerPass** | HiZ、AO/SSR history、DepthPyramid、TileLists | 每 Pass | ~10 |
| `@group(3)` | **PerMaterial** | MaterialUniform（baseColor, metallic, roughness, uv 变换…）+ `texture_2d_array` + sampler | 每材质 | 数百（缓存） |
| `@group(4)` | **PerDraw** | dynamic offset → ObjectStorage（model matrix、prevModel、objectId、materialFlags） | 每对象 | **dynamic offset** |

**核心收益**：排序后，同一材质的连续 draw call **只切 group(4) 的 dynamic offset**，
bindgroup 切换次数从 O(draws) 降到 O(materials)。

**降级路径**（`maxBindGroups == 4`）：PerView 并入 PerFrame 的尾部，用 dynamic offset
按 view 索引切换（阴影 cascade / 多相机场景仍正确）。

**WGSL 侧约定**：所有 chunk 只声明自己用到的 group，ShaderLab 在链接时校验 layout 一致性，
避免"声明了但没绑"导致的 pipeline 创建失败。

---

## 4. FrameGraph

### 4.1 为什么必须要有

WebGPU 里 RT 的 `LOAD_OP / STORE_OP`、MSAA resolve、纹理别名、pass 合并全靠手工，
一处写错就是黑屏或大幅性能损失。FrameGraph 把这些变成**声明一次，编译期推导**。

### 4.2 API 形态

```ts
const g = graph.begin('main-frame');

// 声明资源（虚拟，未真正分配）
const depth   = g.createTexture('depth',   { format:'depth32float', size:'view', samples:4 });
const color   = g.createTexture('hdrColor',{ format:'rgba16float',  size:'view', samples:4 });
const ldr     = g.createTexture('ldrColor',{ format:'bgra8unorm-srgb', size:'view' });
const hizIn   = g.importTexture('hizPrev', prevHiZHandle);   // 导入外部持久资源

g.addPass('depth-prepass', {
  type: 'render',
  writes: [depth.write()],
  execute: (p) => { /* 用 GPU-driven indirect 画深度 */ },
});

g.addPass('hiz', {
  type: 'compute',
  reads:  [depth.read({ as: 'sampled' })],
  writes: [g.createTexture('hiz', {...}).write()],
  execute: (p) => { /* 下采样金字塔 */ },
});

g.addPass('opaque', {
  type: 'render',
  reads:  [depth.read({ as:'attachment' }), hizRef.read()],
  writes: [color.write({ load:'clear', clearValue:[0,0,0,1] })],
  execute: (p) => { /* Forward+ 主光栅 */ },
});

g.present(color);   // 声明为最终输出 → 触发 MSAA resolve + blit 到 swapchain
graph.compile();    // 推导生命周期 / 内存别名 / pass 合并
graph.execute();    // 真正创建 GPU 对象并录制命令
```

### 4.3 编译期做的四件事

1. **生命周期推导**：拓扑排序后计算每个资源的 `[firstPass, lastPass]`，
   在 lastPass 设置 `storeOp='discard'`，firstPass 按声明决定 `loadOp`（`clear`/`load`/`don't care`）。
   → 移动端/集显上省下大量带宽。
2. **Pass 合并**：相邻、读写 RT 完全相同的 render pass 合并为一个 `GPURenderPassEncoder`
   （仅切换 pipeline）。减少 pass 边界的 tile flush。
3. **内存别名**：生命周期不重叠且格式/尺寸兼容的 RT 复用同一 `GPUTexture`
   （不同 `GPUTextureView` + mip/slice）。显存占用通常可降 30–50%。
4. **MSAA 自动 resolve**：`samples>1` 且被 `present()` 或被 `read({as:'sampled'})` 时，
   自动插入 resolve 子资源与 `resolveTarget`。

### 4.4 Transient 资源分配器

- 编译期算出所有 transient RT 的尺寸/格式 → 按 **2D 装箱（guillotine / shelf）** 分配到大
  `GPUTexture` 的 mip 或 array layer 上；内存不足时降级为独立纹理。
- 分配器带 **帧内 arena**：`onSubmittedWorkDone` 后（滞后 2 帧）批量回收，避免每帧新建。
- **Escape hatch**：`g.createTexture(..., { transient:false })` 强制独立分配，用于需要
  跨帧读写的资源（TAA history、SSR history）。

### 4.5 同步语义

WebGPU **没有显式 barrier**，同步由 pass 边界隐式保证：

- 同一 `GPURenderPassEncoder` 内不能同时读写同一 subresource（会 validation error）。
- Storage buffer 的跨 pass 读写：把 pass 拆开即可；FrameGraph 在编译期检测
  "同一 pass 内 read+write 同一 storage" 并**报错而非静默**。
- **异步计算**：WebGPU 只有一个 queue，无法真并行。做法是把"上一帧的 HiZ 剔除"放到
  **本帧最前面**执行，或者用 `onSubmittedWorkDone` 之外的方式重叠 —— 实践中靠
  **跨帧流水**（本帧剔除结果供下一帧用，延迟 1 帧，视觉无感）来隐藏延迟。

---

## 5. GPU-Driven 渲染路径

这是 WebGPU 相对 WebGL2 的最大红利，必须吃满。

### 5.1 数据流

```
[持久 Storage] MeshletData / InstanceData / MaterialData
        │
        ├─ Pass A (compute) : 视锥剔除 → 可见 instance 列表
        ├─ Pass B (compute) : HiZ 遮挡剔除（用上一帧深度金字塔，屏幕空间 AABB 测试）
        ├─ Pass C (compute) : meshlet 级剔除（cone culling + 亚像素剔除）
        ├─ Pass D (compute) : 按材质/深度排序（bitonic sort，subgroups 加速）
        └─ Pass E (compute) : 生成 DrawIndexedIndirect args
                                   │
                                   ▼
                    主光栅：drawIndexedIndirect(argsBuffer, offset)
```

- **Indirect args buffer** 布局：`[indexCount, instanceCount, firstIndex, baseVertex, firstInstance]` × N。
- 需要 `indirect-first-instance` feature 才能在一次 indirect 内跨 instance。
- **CPU 侧几乎零工作**：整帧只有 1 次 `dispatchWorkgroups` + 1 次
  `drawIndexedIndirect`（multi-draw 缺失时用 `indirect` + 循环，循环次数 = 材质批次数）。

### 5.2 深度与剔除细节

- **Reverse-Z**：`depth32float`，`clearValue = 0.0`，`depthCompare = 'greater'`，
  投影矩阵第 3 行改为 `far/(near-far)` 形式。远端精度提升一个数量级，是 CSM 与大世界的必备。
- **HiZ**：深度金字塔（mip 链，compute 或 render 下采样），遮挡测试取物体屏幕 AABB 对应的
  最小 mip 层级，与场景最大深度比较。允许 1 帧延迟 + 保守扩张 1 像素。
- **双阶段遮挡剔除**（可选 T3）：先剔除上一帧可见集合，再对剔除后结果重跑一次，
  解决相机快速移动时的"突然弹出"。

---

## 6. 命令录制与提交

- **RenderBundle**：静态几何（地形、建筑）录制成 `GPURenderBundle`，每帧 `executeBundles`
  重放，省掉上千次 JS 绑定调用。**限制**：bundle 内不能改 dynamic offset 之外的绑定，
  静态对象的 model matrix 必须常驻 storage（用 objectId 索引，不用 dynamic offset）。
- **Encoder 复用**：每帧一个 `GPUCommandEncoder`；dev 模式下用 `label` 标注每个 pass，
  便于在 Chrome DevTools / Dawn 里定位。
- **提交节奏**：一帧**一次** `queue.submit()`。多 submit 会引入额外同步开销；
  若确需（如异步回读），拆到帧首/帧尾两个 submit。

---

## 7. 性能与诊断

### 7.1 Timestamp Query

```ts
// 每个 pass 前后写 timestamp（需要 'timestamp-query' feature）
const qset = device.createQuerySet({ type:'timestamp', count: passes*2 });
// resolveQuerySet → 拷贝到 MAP_READ buffer → mapAsync（2 帧后读，避免 stall）
```
- **严禁当帧读回**（会强制同步，掉帧）。统一延迟 2–3 帧读取到环形缓冲。
- 降级（无 feature）：用 `queue.onSubmittedWorkDone()` 粗测帧 GPU 时间。

### 7.2 内置调试视图

| 视图 | 内容 |
|---|---|
| `wireframe` | 用 `topology:'line-list'` 重建索引（barycentric 线框更省，推荐后者） |
| `overdraw` | additive blend 计数着色 |
| `lightCount` | 每 cluster 光源数热力图 |
| `hiz` | 深度金字塔可视化 |
| `albedo / normal / roughness / metallic / ao` | GBuffer-style 分项 |
| `cullStats` | 剔除前后 instance 数、剔除耗时 |

### 7.3 Adaptive Quality

维护帧时间滑窗（30 帧），超预算时按**代价从低到高**依次降级：
动态分辨率 → 阴影 cascade 数 → AO 半分辨率→四分 → SSR 关闭 → 粒子预算 → 剔除保守度。
升档需连续 90 帧富余，配 2s 冷却，防止振荡。
