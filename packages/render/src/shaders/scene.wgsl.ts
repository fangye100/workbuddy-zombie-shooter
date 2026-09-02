import { COMMON_WGSL } from './common.wgsl';

/**
 * 场景着色：toon 三层光 + inverted hull 描边，MRT 输出。
 *
 * 单一 bind group（每个物体一份，frame/lights/toon 三个 buffer 共享）：
 *   0 Frame   1 Lights   2 Toon   3 Material   4 Transform   5/6 albedo 贴图   7 关节矩阵调色板
 *
 * 顶点布局（与 gpu/geometry.ts 的 VERTEX_LAYOUT / SKIN_LAYOUT 对应）：
 *   主缓冲（slot 0）：0 position 1 normal 2 smoothNormal 3 uv 4 color
 *   蒙皮缓冲（slot 1）：5 joints(uint16×4) 6 weights(float32×4)
 *
 * 所有 uniform 成员一律 vec4f / mat4x4f，规避 WGSL 把 vec3 pad 成 16 字节的对齐陷阱。
 */
export const SCENE_WGSL = /* wgsl */ `
${COMMON_WGSL}

struct Frame {
  viewProj : mat4x4f,
  cameraPos : vec4f,
  screen : vec4f,
};

struct Lights {
  keyDir : vec4f,
  keyColor : vec4f,
  fillSky : vec4f,
  fillGround : vec4f,
  rim : vec4f,
  ambient : vec4f,
  rimParams : vec4f,
  fog : vec4f,
  pointLight : vec4f,
  pointColor : vec4f,
};

struct Toon {
  params0 : vec4f,
  params1 : vec4f,
  shadowTint : vec4f,
  specTint : vec4f,
  outline : vec4f,
  inkColor : vec4f,
  flags : vec4f,
};

struct Material {
  albedo : vec4f,
  surface : vec4f,
  emissive : vec4f,
  matToon : vec4f,
  flags : vec4f,
};

struct Transform {
  model : mat4x4f,
};

@group(0) @binding(0) var<uniform> frame : Frame;
@group(0) @binding(1) var<uniform> lights : Lights;
@group(0) @binding(2) var<uniform> toon : Toon;
@group(0) @binding(3) var<uniform> mat : Material;
@group(0) @binding(4) var<uniform> transform : Transform;
// 5/6：albedo 贴图（可选）。mat.flags.z = 1 时启用，否则用 mat.albedo 平色。
// 贴图按 rgba8unorm 上传（raw sRGB 字节），着色器里同样走 srgbToLinear，颜色空间约定不变
@group(0) @binding(5) var albedoTex : texture_2d<f32>;
@group(0) @binding(6) var albedoSampler : sampler;
// 7：关节矩阵调色板（storage 只读）。蒙皮端按 JOINTS_0 索引取 mat4x4f；
// 末尾恒等关节 = I，未蒙皮顶点绑到它 → 蒙皮结果 = 顶点原样。
@group(0) @binding(7) var<storage, read> jointMat : array<mat4x4f>;

struct VSOut {
  @builtin(position) clip : vec4f,
  @location(0) worldPos : vec3f,
  @location(1) normal : vec3f,
  @location(2) uv : vec2f,
  @location(3) vcolor : vec4f,
  // 蒙皮调试用：权重 + 主影响关节 index（debugMode 9 取色）
  @location(4) skin : vec4f,
  @location(5) skinIdx : vec4f,
};

struct FragOut {
  @location(0) hdr : vec4f,
  @location(1) aux : vec4f,
};

// 一像素在参考距离处的世界尺寸。不做距离补偿时用它，保证行为可预期
const OUTLINE_REF_DIST : f32 = 6.0;

// Linear Blend Skinning：Σ wᵢ · jointMat[i]
fn skinMatrix(j : vec4u, w : vec4f) -> mat4x4f {
  var m : mat4x4f = jointMat[j.x] * w.x;
  m = m + jointMat[j.y] * w.y;
  m = m + jointMat[j.z] * w.z;
  m = m + jointMat[j.w] * w.w;
  return m;
}

// 色相 → 饱和 RGB（蒙皮权重可视化用），h ∈ [0,1)
fn hueRgb(h : f32) -> vec3f {
  let r = abs(h * 6.0 - 3.0) - 1.0;
  let g = 2.0 - abs(h * 6.0 - 2.0);
  let b = 2.0 - abs(h * 6.0 - 4.0);
  return clamp(vec3f(r, g, b), vec3f(0.0), vec3f(1.0));
}

@vertex
fn vs_main(
  @location(0) position : vec3f,
  @location(1) normal : vec3f,
  @location(2) smoothNormal : vec3f,
  @location(3) uv : vec2f,
  @location(4) color : vec4f,
  @location(5) joints : vec4u,
  @location(6) weights : vec4f,
) -> VSOut {
  var out : VSOut;
  let sm = skinMatrix(joints, weights);
  let localPos = sm * vec4f(position, 1.0);
  let worldPos = (transform.model * localPos).xyz;
  out.worldPos = worldPos;
  out.normal = normalize((transform.model * sm * vec4f(normal, 0.0)).xyz);
  out.uv = uv;
  out.vcolor = color;
  out.skin = weights;
  out.skinIdx = vec4f(f32(joints.x), f32(joints.y), f32(joints.z), f32(joints.w));
  out.clip = frame.viewProj * vec4f(worldPos, 1.0);
  return out;
}

@vertex
fn vs_outline(
  @location(0) position : vec3f,
  @location(1) normal : vec3f,
  @location(2) smoothNormal : vec3f,
  @location(3) uv : vec2f,
  @location(4) color : vec4f,
  @location(5) joints : vec4u,
  @location(6) weights : vec4f,
) -> VSOut {
  var out : VSOut;
  let sm = skinMatrix(joints, weights);
  let localPos = sm * vec4f(position, 1.0);
  let worldPos = (transform.model * localPos).xyz;

  // 外扩用 smoothNormal，不用着色法线：硬边几何的顶点法线在棱角处不连续，
  // 直接拿去外扩会让描边裂开（见文档 §4.3）
  let n = normalize((transform.model * sm * vec4f(smoothNormal, 0.0)).xyz);

  let dist = length(frame.cameraPos.xyz - worldPos);
  // 一像素在当前距离处的世界尺寸 = 2*d / (projScaleY * viewportHeight)
  let pxHere = 2.0 * dist / max(1.0, frame.screen.y * frame.screen.z);
  let pxRef = 2.0 * OUTLINE_REF_DIST / max(1.0, frame.screen.y * frame.screen.z);
  let unit = select(pxRef, pxHere, toon.outline.y > 0.5);

  let widthMeters = toon.outline.x * unit * color.r * mat.flags.y;
  let expanded = worldPos + n * widthMeters;

  out.worldPos = expanded;
  out.normal = n;
  out.uv = uv;
  out.vcolor = color;
  out.skin = weights;
  out.skinIdx = vec4f(f32(joints.x), f32(joints.y), f32(joints.z), f32(joints.w));
  out.clip = frame.viewProj * vec4f(expanded, 1.0);
  return out;
}

fn applyFog(color : vec3f, worldPos : vec3f) -> vec3f {
  let d = length(frame.cameraPos.xyz - worldPos) * lights.fog.a;
  let f = 1.0 - exp(-d * d);
  return mix(color, lights.fog.rgb, clamp(f, 0.0, 1.0));
}

@fragment
fn fs_main(in : VSOut) -> FragOut {
  var out : FragOut;
  let N = normalize(in.normal);
  let V = normalize(frame.cameraPos.xyz - in.worldPos);
  let L = normalize(lights.keyDir.xyz);

  var albedoSrgb = mat.albedo.rgb;
  if (mat.flags.z > 0.5) {
    albedoSrgb = textureSample(albedoTex, albedoSampler, in.uv).rgb;
  }
  let albedo = srgbToLinear(albedoSrgb);
  let emissive = srgbToLinear(mat.emissive.rgb) * mat.surface.z;
  let debugMode = toon.flags.x;
  let unlit = mat.flags.x > 0.5;

  // 材质级覆盖：< 0 表示跟随全局
  let shadowEnd = select(toon.params0.x, mat.matToon.x, mat.matToon.x >= 0.0);
  let specMix = select(toon.params1.w, mat.matToon.y, mat.matToon.y >= 0.0);
  let softness = toon.params0.z * max(0.01, mat.matToon.z);

  let ndotl = clamp(dot(N, L), 0.0, 1.0);

  var keyContribution : vec3f;
  var bandId : f32 = 1.0;

  if (unlit) {
    keyContribution = albedo;
    bandId = 3.0;
  } else {
    let litMask = toonStep(shadowEnd, softness, ndotl);

    let shadowCol = adjustSaturation(
      mix(albedo * toon.params0.w, srgbToLinear(toon.shadowTint.rgb), toon.params1.x),
      toon.params1.y
    );
    let litCol = adjustSaturation(albedo, toon.params1.z);

    var c = mix(shadowCol, litCol, litMask);

    let specMask = toonStep(toon.params0.y, softness, ndotl) * step(0.001, specMix);
    c = mix(c, mix(c, srgbToLinear(toon.specTint.rgb), specMix), specMask);

    bandId = select(0.0, 1.0, litMask > 0.5) + select(0.0, 1.0, specMask > 0.5);
    keyContribution = c;
  }

  // 只有 key 参与分阶，fill / rim / ambient / point 全部直接加色
  let keyTerm = keyContribution * lights.keyColor.rgb * lights.keyDir.w;

  let fillTerm = hemisphereAmbient(
    N,
    lights.fillSky.rgb * lights.fillSky.a,
    lights.fillGround.rgb * lights.fillGround.a
  ) * albedo;

  let rimAmount = rimTerm(N, V, lights.rimParams.x, lights.rimParams.y) * lights.rim.a;
  let rimTermColor = lights.rim.rgb * rimAmount;

  let ambTerm = lights.ambient.rgb * lights.ambient.a * albedo;

  var pointTerm = vec3f(0.0);
  if (lights.pointColor.a > 0.001) {
    let toLight = lights.pointLight.xyz - in.worldPos;
    let dist = length(toLight);
    let range = max(0.001, lights.pointLight.w);
    let atten = clamp(1.0 - dist / range, 0.0, 1.0);
    let nl = clamp(dot(N, toLight / max(0.001, dist)), 0.0, 1.0);
    pointTerm = lights.pointColor.rgb * lights.pointColor.a * atten * atten * nl * albedo;
  }

  // 顶点色 G 通道当作烘焙 AO
  let ao = mix(1.0, clamp(in.vcolor.g, 0.0, 1.0), 0.85);

  var color = (keyTerm + fillTerm + ambTerm + pointTerm) * ao + rimTermColor + emissive;
  color = applyFog(color, in.worldPos);

  if (debugMode < 0.5) {
    // 默认模式：aux.r 把材质的半调倍率带给后处理
    out.aux = vec4f(mat.matToon.w, 0.0, 0.0, 0.0);
  } else if (debugMode < 1.5) {
    out.aux = vec4f(albedoSrgb, 0.0);
  } else if (debugMode < 2.5) {
    out.aux = vec4f(N * 0.5 + 0.5, 0.0);
  } else if (debugMode < 3.5) {
    out.aux = vec4f(vec3f(ndotl), 0.0);
  } else if (debugMode < 4.5) {
    var bandCol = vec3f(0.85, 0.20, 0.10);
    if (bandId > 2.5) {
      bandCol = vec3f(0.55, 0.85, 0.95);
    } else if (bandId > 1.5) {
      bandCol = vec3f(1.00, 0.85, 0.20);
    } else if (bandId > 0.5) {
      bandCol = vec3f(0.20, 0.80, 0.40);
    }
    out.aux = vec4f(bandCol, 0.0);
  } else if (debugMode < 5.5) {
    let k = luma(keyTerm);
    let f = luma(fillTerm + ambTerm);
    let r = luma(rimTermColor);
    let m = max(0.0001, max(k, max(f, r)));
    out.aux = vec4f(k / m, f / m, r / m, 0.0);
  } else if (debugMode > 6.5 && debugMode < 7.5) {
    // UV 坐标可视化（模式 7）：R=U, G=V。正常展开应看到连续的 UV 岛与平滑渐变；
    // 如果是一片噪点/条带，说明 UV 数据本身坏了 —— 与贴图无关。
    let uvc = fract(in.uv);
    out.aux = vec4f(uvc.x, uvc.y, 0.0, 0.0);
  } else if (debugMode > 7.5 && debugMode < 8.5) {
    // UV 棋盘格（模式 8）：直接检验「UV ↔ 贴图采样」的对应关系。
    let tiles = in.uv * 24.0;
    let checker = f32((i32(floor(tiles.x)) + i32(floor(tiles.y))) % 2);
    out.aux = vec4f(vec3f(mix(0.15, 0.85, checker)), 0.0);
  } else if (debugMode > 8.5 && debugMode < 9.5) {
    // 蒙皮权重可视化（模式 9）：主影响关节 index → 色相，主权重 → 亮度。
    // 未蒙皮顶点权重=1、关节=0 → 纯红；蒙皮顶点按主关节分色，可肉眼核查权重分布是否合理。
    let idx = i32(in.skinIdx.x + 0.5);
    let hue = fract(f32(idx) * 0.137);
    let col = hueRgb(hue) * clamp(in.skin.x, 0.0, 1.0);
    out.aux = vec4f(col, 0.0);
  } else {
    out.aux = vec4f(0.0, 0.0, 0.0, 0.0);
  }

  out.hdr = vec4f(max(vec3f(0.0), color), 1.0);
  return out;
}

@fragment
fn fs_outline(in : VSOut) -> FragOut {
  var out : FragOut;
  // 描边不接光照，纯 ink 色，但要吃雾，否则远景黑边会浮在雾上面
  let ink = srgbToLinear(toon.inkColor.rgb);
  out.hdr = vec4f(applyFog(ink, in.worldPos), 1.0);
  // aux.a = 描边 mask：后处理据此跳过 grading / 半调 / 暗角
  out.aux = vec4f(mat.matToon.w, 0.0, 0.0, 1.0);
  return out;
}
`;
