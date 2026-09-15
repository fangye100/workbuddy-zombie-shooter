import { COMMON_WGSL } from './common.wgsl';

/**
 * 动态实例着色：一次 drawIndexed 画 N 个**运行时实体**（僵尸 / 子弹 / 拾取物），
 * 走 instancing + storage 实例数组，**完全不碰** `transformBuf` 的 64 静态槽位。
 *
 * 存在意义（ADR-010 / docs/17 §8 第 8 条）：场景静态物件的上限 MAX_OBJECTS = 64 来自
 * `transformBuf` 的 buffer 大小，是**静态**世界的上限；运行时热实体（设计目标是 500 只）
 * 一旦挤进同一批槽位就会把关卡本身挤掉。所以动态实体必须走独立路径：
 *
 *   - 变换不来自 `transformBuf`（uniform，单槽），而是来自 `inst[]`（storage，无上限约束）；
 *   - 顶点缓冲是**共享的一份**代理网格（默认胶囊），每帧只上传变化的实例数组；
 *   - 仍然画在 pass 1 的同一 MRT + 同一 depth 上 —— 于是自动参与 toon 分阶、
 *     雾、bloom / tonemap / 半调等全部后处理，与静态关卡视觉一致。
 *
 * 单一 bind group：0 Frame  1 Lights  2 Toon  3 Instances。
 * 顶点布局复用 `@aether/scene` 的 VERTEX_LAYOUT（slot 0：position/normal/smoothNormal/
 * uv/color），**不接蒙皮 slot** —— 动态实体在 MVP 阶段是胶囊代理，没有骨骼。
 *
 * 实例数组由 CPU 端按 `DYNAMIC_INSTANCE_FLOATS` 打包（见 renderer-core.ts）。
 */
export const DYNAMIC_WGSL = /* wgsl */ `
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

/** 一个动态实例：位置 + 朝向 + 缩放 + 颜色，共 48 B（12 float） */
struct DInst {
  posYaw : vec4f,
  scale : vec4f,
  color : vec4f,
};

@group(0) @binding(0) var<uniform> frame : Frame;
@group(0) @binding(1) var<uniform> lights : Lights;
@group(0) @binding(2) var<uniform> toon : Toon;
@group(0) @binding(3) var<storage, read> inst : array<DInst>;

struct VSOut {
  @builtin(position) clip : vec4f,
  @location(0) worldPos : vec3f,
  @location(1) normal : vec3f,
  @location(2) albedo : vec3f,
};

struct FragOut {
  @location(0) hdr : vec4f,
  @location(1) aux : vec4f,
};

const OUTLINE_REF_DIST : f32 = 6.0;

/** 绕 Y 轴旋转（yaw），再平移到实例位置。动态实体不俯仰不翻滚 */
fn place(i : DInst, p : vec3f) -> vec3f {
  let c = cos(i.posYaw.w);
  let s = sin(i.posYaw.w);
  let scaled = p * i.scale.xyz;
  let rotated = vec3f(scaled.x * c + scaled.z * s, scaled.y, -scaled.x * s + scaled.z * c);
  return i.posYaw.xyz + rotated;
}

@vertex
fn vs_main(
  @location(0) position : vec3f,
  @location(1) normal : vec3f,
  @builtin(instance_index) ii : u32,
) -> VSOut {
  let i = inst[ii];
  var out : VSOut;
  let worldPos = place(i, position);
  out.worldPos = worldPos;
  // 非均匀缩放下的正确法线要乘逆转置；这里缩放只来自「胶囊半径 / 身高」两个标量，
  // 直接除以缩放再归一化就够（且能自动处理负值退化）
  let n = normalize(normal / max(vec3f(1e-4), abs(i.scale.xyz)));
  let c = cos(i.posYaw.w);
  let s = sin(i.posYaw.w);
  out.normal = normalize(vec3f(n.x * c + n.z * s, n.y, -n.x * s + n.z * c));
  out.albedo = i.color.rgb;
  out.clip = frame.viewProj * vec4f(worldPos, 1.0);
  return out;
}

@vertex
fn vs_outline(
  @location(0) position : vec3f,
  @location(1) normal : vec3f,
  @location(2) smoothNormal : vec3f,
  @builtin(instance_index) ii : u32,
) -> VSOut {
  let i = inst[ii];
  var out : VSOut;
  let worldPos = place(i, position);

  // 与 scene.wgsl 的 vs_outline 同理由：外扩必须用 smoothNormal，
  // 硬边几何的着色法线在棱角处不连续，拿去外扩会让描边裂开
  let n0 = normalize(smoothNormal / max(vec3f(1e-4), abs(i.scale.xyz)));
  let c = cos(i.posYaw.w);
  let s = sin(i.posYaw.w);
  let n = normalize(vec3f(n0.x * c + n0.z * s, n0.y, -n0.x * s + n0.z * c));

  let dist = length(frame.cameraPos.xyz - worldPos);
  let pxHere = 2.0 * dist / max(1.0, frame.screen.y * frame.screen.z);
  let pxRef = 2.0 * OUTLINE_REF_DIST / max(1.0, frame.screen.y * frame.screen.z);
  let unit = select(pxRef, pxHere, toon.outline.y > 0.5);

  let expanded = worldPos + n * (toon.outline.x * unit);
  out.worldPos = expanded;
  out.normal = n;
  out.albedo = i.color.rgb;
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

  let albedo = srgbToLinear(in.albedo);

  // 与 scene.wgsl 同一套分阶参数，保证动态实体和静态关卡看起来是同一束光打的
  let shadowEnd = toon.params0.x;
  let softness = toon.params0.z;
  let ndotl = clamp(dot(N, L), 0.0, 1.0);

  let litMask = toonStep(shadowEnd, softness, ndotl);
  let shadowCol = adjustSaturation(
    mix(albedo * toon.params0.w, srgbToLinear(toon.shadowTint.rgb), toon.params1.x),
    toon.params1.y
  );
  let litCol = adjustSaturation(albedo, toon.params1.z);
  var c = mix(shadowCol, litCol, litMask);

  let specMask = toonStep(toon.params0.y, softness, ndotl) * step(0.001, toon.params1.w);
  c = mix(c, mix(c, srgbToLinear(toon.specTint.rgb), toon.params1.w), specMask);

  let keyTerm = c * lights.keyColor.rgb * lights.keyDir.w;
  let fillTerm = hemisphereAmbient(
    N,
    lights.fillSky.rgb * lights.fillSky.a,
    lights.fillGround.rgb * lights.fillGround.a
  ) * albedo;
  let rimTermColor = lights.rim.rgb * (rimTerm(N, V, lights.rimParams.x, lights.rimParams.y) * lights.rim.a);
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

  var color = keyTerm + fillTerm + ambTerm + pointTerm + rimTermColor;
  color = applyFog(color, in.worldPos);

  // 动态实体不参与半调（aux.r = 0）也不写描边 mask（aux.a = 0）。
  // debug 视图同理保持 0：动态实体是运行时产物，不该污染静态场景的诊断视图。
  out.aux = vec4f(0.0, 0.0, 0.0, 0.0);
  out.hdr = vec4f(max(vec3f(0.0), color), 1.0);
  return out;
}

@fragment
fn fs_outline(in : VSOut) -> FragOut {
  var out : FragOut;
  let ink = srgbToLinear(toon.inkColor.rgb);
  out.hdr = vec4f(applyFog(ink, in.worldPos), 1.0);
  // aux.a = 描边 mask：后处理据此跳过 grading / 半调 / 暗角，与静态场景一致
  out.aux = vec4f(0.0, 0.0, 0.0, 1.0);
  return out;
}
`;
