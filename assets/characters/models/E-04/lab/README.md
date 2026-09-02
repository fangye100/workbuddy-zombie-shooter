# Shader Lab 集成说明

把 E-04 模型接入另一个 session 的 `apps/lab/shader-lab/` 需要的三件东西都在这：

| 文件 | 用途 | 大小 |
| --- | --- | --- |
| `E04_Bulwark_1600.labmesh` | 紧凑二进制：16 B 头 + 顶点(f32×15×N) + 索引(u32×3M) | 115 KB |
| `E04_Bulwark_1600.mesh.ts` | base64 内联的 TS 模块，导出 `createE04(): MeshData` | 165 KB |
| `E04_Bulwark_1600.json` | 元数据（bbox、AO 范围、朝向约定） | <1 KB |

`.labmesh` 与 `.mesh.ts` 互斥：选一个就行。

---

## 选 A：二进制版（需要把 LabRenderer 改异步）

文件 16 B 头定义：

```
字节 0-3   magic      b"LABM"
字节 4-7   version    uint32 LE = 1
字节 8-11  vertexCount uint32 LE
字节 12-15 indexCount  uint32 LE
字节 16..  vertices   Float32 LE × vertexCount × 15
            indices    Uint32 LE  × indexCount
```

`gpu/geometry.ts` 的 `VERTEX_LAYOUT` 是 60B stride / 15 floats，**直接复用**：
- 0-2 position, 3-5 normal, 6-8 smoothNormal, 9-10 uv
- 11 color.r 描边倍率（默认 1.0）
- 12 color.g 烘焙 AO（pymeshlab `compute_scalar_ambient_occlusion` rays=128）
- 13-14 未用

最小集成：

```ts
// 新增 src/gpu/labmesh.ts
import type { MeshData } from './geometry';

const HDR = 16;

export async function loadLabMesh(url: string): Promise<MeshData> {
  const buf = await fetch(url).then(r => r.arrayBuffer());
  const view = new DataView(buf);
  if (view.getUint32(0, true) !== 0x4D42414C /* 'LABM' */) {
    throw new Error(`Not a labmesh: ${url}`);
  }
  const vertBytes = view.getUint32(8, true) * 60;
  const idxBytes  = view.getUint32(12, true) * 4;
  return {
    vertices: new Float32Array(buf, HDR, view.getUint32(8, true) * 15),
    indices:  new Uint32Array (buf, HDR + vertBytes, view.getUint32(12, true)),
  };
}
```

```ts
// renderer.ts 构造里把 specs 的初始化挪到 async init() 方法
async init(): Promise<void> {
  const e04 = await loadLabMesh('/assets/E04_Bulwark_1600.labmesh');
  this.specs.push({ mesh: e04, material: 0, pos: [0, 0.84, -1.2], bob: 0 });
  // …… 现有的 GPU buffer 创建放到这里 ……
}
```

`apps/lab/shader-lab/public/assets/E04_Bulwark_1600.labmesh` 拷贝一份进去即可。

---

## 选 B：TS 模块版（不需改 LabRenderer 异步）

直接把 `E04_Bulwark_1600.mesh.ts` 拷到 `apps/lab/shader-lab/src/`，加一行：

```ts
// renderer.ts 顶部
import { createE04 } from './E04_Bulwark_1600.mesh';

// specs 数组里加一项
specs.push({ mesh: createE04(), material: 0, pos: [0, 0.84, -1.2], bob: 0 });
```

代价：`+165 KB` 进 Vite 入口 chunk（base64 解码比 Float32Array view 慢几毫秒，只在启动时一次）。

---

## 朝向与放置

- Y-up，脚底 y=0，X/Z 居中，身高统一 2.05 m（roster 规格）
- 角色面朝 **-Z** 方向（按 glTF 约定，不是从模型里推断的；调相机或旋转模型都很便宜）
- 包围盒（米）：`x∈[-0.73, 0.73]` `y∈[0, 2.05]` `z∈[-0.29, 0.29]`
- AO：均值 0.94，min 0.00 —— 模型偏开放，腋下/裆部等真有压暗

`pos` 选 `[0, 0.84, -1.2]` 与 lab 默认相机（`distance:9, target:[0,0.85,-1.2]`）配合，god view 55° 下角色刚好落在画面中。

---

## 这台 lab 不支持的特性（先告知，别误判为 bug）

着色器只有 `mat.albedo` 一种颜色输入，**没有纹理采样**。E-04 自带的 baseColor 贴图不会显示。

要看到贴图，得改 `scene.wgsl.ts` 加 `@group(0) @binding(N) var baseColorTex: texture_2d<f32>` + `@group(0) @binding(N+1) var baseColorSampler: sampler`。这一步是另一个 session 的设计选择，不在这次范围内。

也就是说，当前这一轮**最该验证的是**：toon 分阶 / rim / 描边 / AO 在真实网格上是不是肉眼合理。albedo 选僵尸绿或盾板色都行，先看结构对不对，贴图后面再补。