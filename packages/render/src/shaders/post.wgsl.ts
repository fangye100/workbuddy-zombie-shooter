import { COMMON_WGSL } from './common.wgsl';

/**
 * 后处理：Tonemap → sRGB 编码 → 半调网点 → Grading 三段 → Bloom → 暗角。
 *
 * 顺序严格遵循 tokens.json：半调与 LUT 在 Tonemap 之后、Grading 之前，
 * 且 grading 的工作空间是 sRGB display-referred（不是 linear）。
 *
 * 描边像素（aux.a = 1）在开启豁免后只走 tonemap + sRGB，跳过半调 / grading / 暗角，
 * 否则纯 ink 色会被提亮染色，描边会发灰（文档 §4.4）。
 */
export const POST_WGSL = /* wgsl */ `
${COMMON_WGSL}

struct Post {
  band : vec4f,
  shadowG : vec4f,
  midG : vec4f,
  lightG : vec4f,
  nightDeep : vec4f,
  bone : vec4f,
  ink : vec4f,
  halftone : vec4f,
  post : vec4f,
  misc : vec4f,
  debug : vec4f,
};

@group(0) @binding(0) var<uniform> post : Post;
@group(0) @binding(1) var hdrTex : texture_2d<f32>;
@group(0) @binding(2) var auxTex : texture_2d<f32>;
@group(0) @binding(3) var samp : sampler;

struct VSOut {
  @builtin(position) clip : vec4f,
  @location(0) uv : vec2f,
};

@vertex
fn vs_fullscreen(@builtin(vertex_index) vi : u32) -> VSOut {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  let p = pos[vi];
  var out : VSOut;
  out.clip = vec4f(p, 0.0, 1.0);
  out.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return out;
}

fn cheapBloom(uv : vec2f, texel : vec2f, threshold : f32) -> vec3f {
  var acc = vec3f(0.0);
  let radius = 7.0;
  for (var i = 0u; i < 8u; i = i + 1u) {
    let a = f32(i) * 0.78539816;
    let o = vec2f(cos(a), sin(a)) * texel * radius;
    let s = textureSampleLevel(hdrTex, samp, uv + o, 0.0).rgb;
    let l = luma(s);
    let k = max(0.0, l - threshold);
    acc += s * (k / max(l, 1e-4));
  }
  return acc / 8.0;
}

// 半调网点：只叠暗部，旋转 45° 避开像素网格，fwidth 驱动 LOD 淡出。
//
// 注意 fwidth 的调用顺序：WGSL 要求导数内建函数只能出现在 uniform control flow 中，
// 所以必须把 fwidth 放在函数最前面、任何提前 return 之前。
// 同理调用点也不能放在 if (!exempt) 里 —— exempt 由纹理内容决定，是非 uniform 分支。
fn halftoneAmount(fragCoord : vec2f, lum : f32, scale : f32) -> f32 {
  let c = 0.70710678;
  let rot = vec2f(c * (fragCoord.x - fragCoord.y), c * (fragCoord.x + fragCoord.y));
  let uv = rot / max(1.0, post.halftone.y);

  // 网点周期接近像素大小时会产生严重摩尔纹，必须淡出
  let lod = fwidth(uv.x) * 2.0;
  let fade = 1.0 - smoothstep(0.35, 0.9, lod);

  if (post.halftone.x < 0.5) { return 0.0; }
  let amount = (1.0 - smoothstep(post.halftone.w - 0.12, post.halftone.w, lum))
             * post.halftone.z * scale;
  if (amount <= 0.001) { return 0.0; }

  let f = abs(fract(uv) - 0.5);
  var d = length(f) * 2.0;
  d = mix(d, 1.0, 1.0 - fade);

  return (1.0 - smoothstep(amount - 0.15, amount + 0.15, d)) * fade;
}

fn gradeBand(c : vec3f, mask : f32, mult : f32, tint : vec3f, mixAmt : f32, sat : f32) -> vec3f {
  let g = adjustSaturation(mix(c * mult, tint, mixAmt), sat);
  return mix(c, g, mask);
}

fn gradeThreeBand(c : vec3f) -> vec3f {
  let lum = luma(c);
  let e = max(0.001, post.band.z);
  let sR = post.band.x;
  let mR = post.band.y;

  let mShadow = 1.0 - smoothstep(sR - e, sR + e, lum);
  let mLight = smoothstep(mR - e, mR + e, lum);
  let mMid = clamp(1.0 - mShadow - mLight, 0.0, 1.0);

  var r = c;
  r = gradeBand(r, mShadow, post.shadowG.x, post.nightDeep.rgb, post.shadowG.y, post.shadowG.z);
  r = gradeBand(r, mMid, post.midG.x, c, 0.0, post.midG.y);
  r = gradeBand(r, mLight, post.lightG.x, post.bone.rgb, post.lightG.y, post.lightG.z);
  return r;
}

@fragment
fn fs_post(in : VSOut) -> @location(0) vec4f {
  let hdr = textureSampleLevel(hdrTex, samp, in.uv, 0.0);
  let aux = textureSampleLevel(auxTex, samp, in.uv, 0.0);

  let debugMode = post.debug.x;

  // 调试视图显示区间：1..8（含新增的 UV 坐标 / UV 棋盘格）
  if (debugMode > 0.5 && debugMode < 8.5) {
    if (debugMode > 5.5 && debugMode < 6.5) {
      // 模式 6：描边 mask（取 aux.a）
      return vec4f(vec3f(aux.a), 1.0);
    }
    return vec4f(clamp(aux.rgb, vec3f(0.0), vec3f(1.0)), 1.0);
  }

  let isOutline = aux.a > 0.5;
  let exempt = isOutline && post.misc.y > 0.5;

  var hdrColor = hdr.rgb;

  if (!isOutline && post.post.w > 0.0) {
    let texel = 1.0 / max(vec2f(1.0), vec2f(post.misc.z, post.misc.w));
    hdrColor += cheapBloom(in.uv, texel, post.post.z) * post.post.w;
  }

  hdrColor *= post.post.y;

  var display = linearToSrgb(tonemapApply(hdrColor, post.post.x));

  // 无条件求值（导数要求 uniform control flow），再用 exempt 决定是否采用
  let ht = halftoneAmount(in.clip.xy, luma(display), aux.r) * select(1.0, 0.0, exempt);

  if (!exempt) {
    if (ht > 0.0) {
      display = mix(display, post.ink.rgb, clamp(ht, 0.0, 1.0));
    }

    if (post.band.w > 0.5) {
      display = gradeThreeBand(display);
    }

    let d = in.uv - vec2f(0.5);
    let vig = 1.0 - dot(d, d) * 2.4 * post.misc.x;
    display *= clamp(vig, 0.0, 1.0);
  }

  return vec4f(clamp(display, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
