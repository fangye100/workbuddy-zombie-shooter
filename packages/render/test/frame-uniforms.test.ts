import { describe, expect, it } from 'vitest';
import {
  LIGHTS_FLOATS,
  POST_FLOATS,
  SLOT_FLOATS,
  TOON_FLOATS,
  packFrameUniforms,
  packLights,
  packMaterial,
  packPost,
  packToon,
  type FrameUniformInput,
} from '@aether/render';
import type { MaterialState } from '@aether/render';
import { hexToLinear, hexToRgb, sphericalToDir } from '@aether/core';

/**
 * 这里刻意**不** import 编辑器侧的 LabParams / defaultParams（ADR-009：测试不许反向依赖上层）。
 * 参数夹具自己给，只覆盖装箱真正读到的字段 —— 顺带也验证了参数契约确实收窄到位：
 * 哪天 LabParams 少了个字段而装箱还在读，是编辑器那边编译不过，不是这里。
 */
const LIGHTS = {
  keyAzimuth: -38,
  keyElevation: 42,
  keyIntensity: 2.1,
  keyColor: '#FFE3BC',
  fillSkyColor: '#7E92C4',
  fillSkyIntensity: 0.62,
  fillGroundColor: '#C49A72',
  fillGroundIntensity: 0.34,
  rimColor: '#FFE0B0',
  rimIntensity: 0.5,
  rimPower: 3.2,
  rimTopBias: 0.5,
  ambientColor: '#4E5370',
  ambientIntensity: 0.42,
  pointEnabled: false,
  pointColor: '#FF6A3D',
  pointIntensity: 2.2,
  pointRange: 5,
  pointOrbit: true,
  fogColor: '#6E7A9A',
  fogDensity: 0.016,
};

const TOON = {
  shadowEnd: 0.5,
  specStart: 0.88,
  edgeSoftness: 0.045,
  shadowMult: 0.75,
  shadowMix: 0.3,
  shadowSat: 1.05,
  litSat: 1.18,
  specMix: 0.35,
  shadowTint: '#241E33',
  specTint: '#FFF6E2',
  outlineWidth: 4,
  outlineDistanceComp: true,
  inkColor: '#14110F',
  debugMode: 0,
};

const POST = {
  gradeEnabled: true,
  gradeShadowRange: 0.28,
  gradeMidRange: 0.7,
  gradeEdge: 0.06,
  gradeShadowMult: 0.95,
  gradeShadowMix: 0.12,
  gradeShadowSat: 1.15,
  gradeMidSat: 1.14,
  gradeMidMult: 0.98,
  gradeLightMult: 1.04,
  gradeLightMix: 0.12,
  gradeLightSat: 1.06,
  gradeShadowColor: '#0E0C16',
  gradeLightColor: '#FFF6E2',
  halftoneEnabled: true,
  halftoneSize: 5,
  halftoneStrength: 0.1,
  halftoneThreshold: 0.4,
  tonemapMode: 3,
  exposure: 1.5,
  bloomEnabled: true,
  bloomThreshold: 1.3,
  bloomIntensity: 0.3,
  vignette: 0.06,
  outlinePostExempt: true,
  inkColor: '#14110F',
  debugMode: 0,
};

function material(over: Partial<MaterialState> = {}): MaterialState {
  return {
    albedo: '#8FD14F',
    roughness: 0.62,
    metallic: 0,
    emissiveColor: '#000000',
    emissiveStrength: 0,
    shadowEnd: -1,
    specMix: -1,
    softnessScale: 1,
    halftoneScale: 1,
    outlineScale: 1,
    unlit: false,
    ...over,
  };
}

function frameInput(over: Partial<FrameUniformInput> = {}): FrameUniformInput {
  return {
    lights: new Float32Array(LIGHTS_FLOATS),
    toon: new Float32Array(TOON_FLOATS),
    post: new Float32Array(POST_FLOATS),
    params: { ...LIGHTS, ...TOON, ...POST },
    time: 0,
    width: 1280,
    height: 720,
    ...over,
  };
}

describe('frame-uniforms · 布局常量', () => {
  it('三个 block 的 float 数与 renderer-core 建 buffer 时用的尺寸一致', () => {
    // 改 WGSL 加字段就必须同步改这里；单测兜住「改了一边忘另一边」
    expect(LIGHTS_FLOATS).toBe(40);
    expect(TOON_FLOATS).toBe(28);
    expect(POST_FLOATS).toBe(44);
    expect(SLOT_FLOATS).toBe(64);
  });

  it('装箱后 block 内不留 NaN / 未初始化槽位（0 也是显式写入的 0）', () => {
    const { lights, toon, post } = frameInput();
    packFrameUniforms(frameInput({ lights, toon, post }));
    for (const [name, arr] of [
      ['lights', lights],
      ['toon', toon],
      ['post', post],
    ] as const) {
      for (let i = 0; i < arr.length; i++) {
        expect(Number.isFinite(arr[i]!), `${name}[${i}] 非有限值`).toBe(true);
      }
    }
  });
});

describe('packLights', () => {
  it('主光方向由球坐标换算，强度落在 [3]', () => {
    const d = new Float32Array(LIGHTS_FLOATS);
    packLights(d, LIGHTS, 0);
    const dir = sphericalToDir(LIGHTS.keyAzimuth, LIGHTS.keyElevation);
    expect(d[0]).toBeCloseTo(dir[0], 6);
    expect(d[1]).toBeCloseTo(dir[1], 6);
    expect(d[2]).toBeCloseTo(dir[2], 6);
    expect(d[3]).toBeCloseTo(LIGHTS.keyIntensity, 6);
  });

  it('灯光颜色走 sRGB→linear，不是 raw hex', () => {
    const d = new Float32Array(LIGHTS_FLOATS);
    packLights(d, LIGHTS, 0);
    const lin = hexToLinear(LIGHTS.keyColor);
    const raw = hexToRgb(LIGHTS.keyColor);
    expect(d[4]).toBeCloseTo(lin[0], 6);
    expect(d[5]).toBeCloseTo(lin[1], 6);
    expect(d[6]).toBeCloseTo(lin[2], 6);
    // 非灰阶色上 linear 与 raw 必然不同，否则说明转换被漏掉了
    expect(lin[2]).not.toBeCloseTo(raw[2], 3);
  });

  it('点光关闭时强度写 0，但颜色/半径照常装箱', () => {
    const d = new Float32Array(LIGHTS_FLOATS);
    packLights(d, { ...LIGHTS, pointEnabled: false }, 0);
    expect(d[35]).toBeCloseTo(LIGHTS.pointRange, 6);
    expect(d[39]).toBe(0);
  });

  it('点光开启 + 环绕：位置随时间走圆（半径 2.6）', () => {
    const a = new Float32Array(LIGHTS_FLOATS);
    const b = new Float32Array(LIGHTS_FLOATS);
    packLights(a, { ...LIGHTS, pointEnabled: true }, 0);
    packLights(b, { ...LIGHTS, pointEnabled: true }, 1.5);
    expect(a[39]).toBeCloseTo(LIGHTS.pointIntensity, 6);
    expect(Math.hypot(a[32]!, a[34]!)).toBeCloseTo(2.6, 5);
    expect(Math.hypot(b[32]!, b[34]!)).toBeCloseTo(2.6, 5);
    // time 变了位置必须变；关闭环绕则 time 无效
    expect(a[32]).not.toBeCloseTo(b[32]!, 3);

    const c = new Float32Array(LIGHTS_FLOATS);
    const e = new Float32Array(LIGHTS_FLOATS);
    packLights(c, { ...LIGHTS, pointOrbit: false }, 0);
    packLights(e, { ...LIGHTS, pointOrbit: false }, 1.5);
    expect(c[32]).toBeCloseTo(e[32]!, 6);
  });
});

describe('packToon', () => {
  it('线宽按 1080p 定义，换算到画布物理像素高度', () => {
    const d = new Float32Array(TOON_FLOATS);
    packToon(d, TOON, 1080);
    expect(d[16]).toBeCloseTo(TOON.outlineWidth, 6);
    packToon(d, TOON, 2160);
    expect(d[16]).toBeCloseTo(TOON.outlineWidth * 2, 6);
  });

  it('描边色送 raw sRGB（与灯光 block 相反，toon 的墨色不转 linear）', () => {
    const d = new Float32Array(TOON_FLOATS);
    packToon(d, TOON, 1080);
    const raw = hexToRgb(TOON.inkColor);
    expect(d[20]).toBeCloseTo(raw[0], 6);
    expect(d[21]).toBeCloseTo(raw[1], 6);
    expect(d[22]).toBeCloseTo(raw[2], 6);
  });

  it('布尔开关落成 0/1，不是 true/false 隐式转换', () => {
    const on = new Float32Array(TOON_FLOATS);
    const off = new Float32Array(TOON_FLOATS);
    packToon(on, { ...TOON, outlineDistanceComp: true }, 1080);
    packToon(off, { ...TOON, outlineDistanceComp: false }, 1080);
    expect(on[17]).toBe(1);
    expect(off[17]).toBe(0);
  });
});

describe('packPost', () => {
  it('画布尺寸落在 [38]/[39]（shader 算半调网点与暗角要用）', () => {
    const d = new Float32Array(POST_FLOATS);
    packPost(d, POST, 1280, 720);
    expect(d[38]).toBe(1280);
    expect(d[39]).toBe(720);
  });

  it('grading 关闭时只置位开关，倍率照旧装箱（shader 自己分支）', () => {
    const d = new Float32Array(POST_FLOATS);
    packPost(d, { ...POST, gradeEnabled: false }, 1280, 720);
    expect(d[3]).toBe(0);
    expect(d[4]).toBeCloseTo(POST.gradeShadowMult, 6);
  });

  it('bloom 关闭时强度归零，避免 shader 里再判一次', () => {
    const on = new Float32Array(POST_FLOATS);
    const off = new Float32Array(POST_FLOATS);
    packPost(on, { ...POST, bloomEnabled: true }, 1280, 720);
    packPost(off, { ...POST, bloomEnabled: false }, 1280, 720);
    expect(on[35]).toBeCloseTo(POST.bloomIntensity, 6);
    expect(off[35]).toBe(0);
  });

  it('grading 三色是 display-referred，不转 linear', () => {
    const d = new Float32Array(POST_FLOATS);
    packPost(d, POST, 1280, 720);
    // light 混向色 = #FFF6E2（tokens.json → core.bone），写死在 [20..22]
    const bone = hexToRgb('#FFF6E2');
    expect(d[20]).toBeCloseTo(bone[0], 6);
    expect(d[22]).toBeCloseTo(bone[2], 6);
  });

  // L-7：这三处原先在 packPost 里写死（0.98 / #0E0C16 / #FFF6E2），
  // 引擎是 L3 不能反向依赖 content(L4)，所以改成参数注入（ADR-007）。
  // 断言它们真的跟着参数走 —— 否则哪天有人改回硬编码，值一样，测试照样绿。
  it('中间调倍率来自参数，不是写死 0.98', () => {
    const d = new Float32Array(POST_FLOATS);
    packPost(d, { ...POST, gradeMidMult: 0.5 }, 1280, 720);
    expect(d[8]).toBeCloseTo(0.5, 6);
  });

  it('暗部/亮部混向色来自参数，不是写死 #0E0C16 / #FFF6E2', () => {
    const d = new Float32Array(POST_FLOATS);
    packPost(d, { ...POST, gradeShadowColor: '#112233', gradeLightColor: '#445566' }, 1280, 720);
    const shadow = hexToRgb('#112233');
    const light = hexToRgb('#445566');
    expect(d[16]).toBeCloseTo(shadow[0], 6);
    expect(d[17]).toBeCloseTo(shadow[1], 6);
    expect(d[18]).toBeCloseTo(shadow[2], 6);
    expect(d[20]).toBeCloseTo(light[0], 6);
    expect(d[21]).toBeCloseTo(light[1], 6);
    expect(d[22]).toBeCloseTo(light[2], 6);
  });
});

describe('packMaterial', () => {
  it('每槽 20 floats，base 偏移正确且不越界写', () => {
    const dst = new Float32Array(SLOT_FLOATS * 3);
    packMaterial(dst, SLOT_FLOATS, material());
    expect(dst[SLOT_FLOATS]).toBeCloseTo(hexToRgb('#8FD14F')[0], 6);
    // 只写 [base, base+20)，前后槽位必须保持 untouched
    expect(dst[SLOT_FLOATS - 1]).toBe(0);
    expect(dst[SLOT_FLOATS + 19]).toBe(0);
    expect(dst[SLOT_FLOATS + 20]).toBe(0);
  });

  it('albedo 走 raw sRGB，alpha 恒为 1', () => {
    const dst = new Float32Array(SLOT_FLOATS);
    const m = material({ albedo: '#8FD14F' });
    packMaterial(dst, 0, m);
    const a = hexToRgb(m.albedo);
    expect(dst[0]).toBeCloseTo(a[0], 6);
    expect(dst[1]).toBeCloseTo(a[1], 6);
    expect(dst[2]).toBeCloseTo(a[2], 6);
    expect(dst[3]).toBe(1);
  });

  it('unlit 落 0/1，outlineScale 落在 [17]', () => {
    const lit = new Float32Array(SLOT_FLOATS);
    const unlit = new Float32Array(SLOT_FLOATS);
    packMaterial(lit, 0, material({ unlit: false, outlineScale: 1.5 }));
    packMaterial(unlit, 0, material({ unlit: true, outlineScale: 1.5 }));
    expect(lit[16]).toBe(0);
    expect(unlit[16]).toBe(1);
    expect(lit[17]).toBeCloseTo(1.5, 6);
  });

  it('「有贴图」标志位 [18] 由调用方置位，装箱只负责清零', () => {
    const dst = new Float32Array(SLOT_FLOATS);
    packMaterial(dst, 0, material());
    expect(dst[18]).toBe(0);
    dst[18] = 1; // 编辑器：o.useTex 时切到纹理采样
    expect(dst[18]).toBe(1);
  });
});
