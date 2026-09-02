/**
 * 共享 WGSL 函数库。被 scene / post 两个 shader 拼接引用。
 *
 * 与 docs/07-灯光与材质系统.md 的代码一一对应，改文档要同步改这里。
 */
export const COMMON_WGSL = /* wgsl */ `

const LUMA_W = vec3f(0.2126, 0.7152, 0.0722);

fn luma(c: vec3f) -> f32 {
  return dot(c, LUMA_W);
}

// 注意：WGSL 内置 saturate() 是 clamp(0,1)，这是调饱和度，别混用
fn adjustSaturation(c: vec3f, amount: f32) -> vec3f {
  let l = luma(c);
  return max(vec3f(0.0), mix(vec3f(l), c, amount));
}

fn srgbToLinear(c: vec3f) -> vec3f {
  let lo = c / 12.92;
  let hi = pow((c + 0.055) / 1.055, vec3f(2.4));
  return select(hi, lo, c <= vec3f(0.04045));
}

fn linearToSrgb(c: vec3f) -> vec3f {
  let x = max(vec3f(0.0), c);
  let lo = x * 12.92;
  let hi = 1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, x <= vec3f(0.0031308));
}

// 分阶阶跃：软边宽度随 NdotL 的屏幕空间变化率自适应。
// 没有 fwidth 会在远处产生摩尔纹、近处产生硬锯齿。
fn toonStep(threshold: f32, softness: f32, x: f32) -> f32 {
  let w = fwidth(x) * 0.5 + softness;
  return smoothstep(threshold - w, threshold + w, x);
}

fn hemisphereAmbient(n: vec3f, skyColor: vec3f, groundColor: vec3f) -> vec3f {
  let t = n.y * 0.5 + 0.5;
  return mix(groundColor, skyColor, t);
}

// rim：视空间 Fresnel 感。topBias 把 rim 往头顶轮廓偏，补偿 god view 俯视角
fn rimTerm(n: vec3f, v: vec3f, power: f32, topBias: f32) -> f32 {
  let ndv = clamp(dot(n, v), 0.0, 1.0);
  let fresnel = pow(1.0 - ndv, power);
  let bias = mix(1.0, n.y * 0.5 + 0.5, topBias);
  return fresnel * bias;
}

// AgX（Troy Sobotka）标准移植。WGSL mat3x3f 与 GLSL mat3 同为列主序，常量直接照搬
const AGX_INSET = mat3x3f(
  0.856627153315983, 0.137318972929847, 0.11189821299995,
  0.0951212405381588, 0.761241990602591, 0.0767994186031903,
  0.0482516061458583, 0.101439036467562, 0.811302368396859
);

const AGX_OUTSET = mat3x3f(
  1.1271005818144368, -0.1413297634984383, -0.14132976349843826,
  -0.11060664309660323, 1.157823702216272, -0.11060664309660294,
  -0.016493938717834573, -0.016493938717834257, 1.2519364065950405
);

fn agxContrastApprox(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2
       - 40.14 * x4 * x
       + 31.96 * x4
       - 6.868 * x2 * x
       + 0.4298 * x2
       + 0.1191 * x
       - 0.00232;
}

fn tonemapAgx(c: vec3f) -> vec3f {
  let v = AGX_INSET * c;
  return clamp(AGX_OUTSET * agxContrastApprox(v), vec3f(0.0), vec3f(1.0));
}

fn tonemapAces(c: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let cc = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((c * (a * c + b)) / (c * (cc * c + d) + e), vec3f(0.0), vec3f(1.0));
}

fn tonemapReinhard(c: vec3f) -> vec3f {
  return c / (c + vec3f(1.0));
}

fn tonemapApply(c: vec3f, mode: f32) -> vec3f {
  if (mode < 0.5) {
    return clamp(c, vec3f(0.0), vec3f(1.0));
  } else if (mode < 1.5) {
    return tonemapReinhard(c);
  } else if (mode < 2.5) {
    return tonemapAces(c);
  }
  return tonemapAgx(c);
}
`;
