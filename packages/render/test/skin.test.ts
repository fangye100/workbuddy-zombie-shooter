import { describe, expect, it } from 'vitest';
import {
  advance,
  createSkinState,
  evalJointMatrices,
  seek,
  selectClip,
} from '@aether/render';
import { packSkin } from '@aether/scene';
import type { AnimClip, AnimTrack, NodeLocal, SkeletonData } from '@aether/scene';

/** 列主序平移矩阵 */
function translate(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/** 列主序均匀缩放矩阵 */
function scaleUniform(s: number): Float32Array {
  const m = new Float32Array(16);
  m[0] = s;
  m[5] = s;
  m[10] = s;
  m[15] = 1;
  return m;
}

/** 用列主序 mat4 变换点 (x,y,z)，返回 [x',y',z'] */
function applyMat4(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

function identityLocal(): NodeLocal {
  return { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] };
}

/** 单关节骨架，bind 本地变换 = local，inverseBind 由调用方给定 */
function singleJointSkeleton(local: NodeLocal, inverseBind: Float32Array, normalization?: Float32Array): SkeletonData {
  return {
    joints: [0],
    jointNames: ['Bone0'],
    inverseBind,
    parent: [-1],
    locals: [local],
    roots: [0],
    normalization: normalization ?? scaleUniform(1),
  };
}

/** 绕 Z 轴转 θ（弧度）的四元数 xyzw */
function quatZ(theta: number): [number, number, number, number] {
  const h = theta / 2;
  return [0, 0, Math.sin(h), Math.cos(h)];
}

describe('evalJointMatrices · bind pose 守恒', () => {
  it('bind pose（无动画）→ 所有关节矩阵为单位阵', () => {
    const sk = singleJointSkeleton(identityLocal(), scaleUniform(1));
    const st = createSkinState(sk, []);
    const out = new Float32Array((sk.joints.length + 1) * 16);
    evalJointMatrices(st, out);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[5]).toBeCloseTo(1, 6);
    expect(out[10]).toBeCloseTo(1, 6);
    expect(out[15]).toBeCloseTo(1, 6);
    for (const i of [1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13, 14]) {
      expect(out[i]).toBeCloseTo(0, 6);
    }
  });

  it('非平凡 normalization T 下 bind pose 仍为 I（共轭保证蒙皮与顶点同空间）', () => {
    // 关节在场景根空间沿 X 平移 1，inverseBind = 其逆；normalization 为均匀缩放 2（非单位）
    const sk = singleJointSkeleton(
      { t: [1, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] },
      translate(-1, 0, 0),
      scaleUniform(2),
    );
    const st = createSkinState(sk, []);
    const out = new Float32Array((sk.joints.length + 1) * 16);
    evalJointMatrices(st, out);
    // raw = world·inverseBind = I，共轭 T·I·T⁻¹ 仍 = I
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[5]).toBeCloseTo(1, 6);
    expect(out[10]).toBeCloseTo(1, 6);
    expect(out[15]).toBeCloseTo(1, 6);
    for (const i of [1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13, 14]) {
      expect(out[i]).toBeCloseTo(0, 6);
    }
  });
});

describe('evalJointMatrices · 单骨骼旋转动画', () => {
  it('绕 Z 转 90°，顶点 (0,1,0) 加权为 (-1,0,0)', () => {
    const sk = singleJointSkeleton(identityLocal(), scaleUniform(1));
    const track: AnimTrack = {
      node: 0,
      path: 'rotation',
      times: new Float32Array([0, 1]),
      values: new Float32Array([...quatZ(0), ...quatZ(Math.PI / 2)]),
      stride: 4,
      interpolation: 'LINEAR',
    };
    const clip: AnimClip = { name: 'wave', duration: 1, tracks: [track] };
    const st = createSkinState(sk, [clip]);
    st.time = 1; // 直接跳到 90° 处
    const out = new Float32Array((sk.joints.length + 1) * 16);
    evalJointMatrices(st, out);

    const jm = out.subarray(0, 16);
    const p = applyMat4(jm, 0, 1, 0);
    expect(p[0]).toBeCloseTo(-1, 5);
    expect(p[1]).toBeCloseTo(0, 5);
    expect(p[2]).toBeCloseTo(0, 5);
  });

  it('Z 轴位移动画：顶点随关节平移', () => {
    const sk = singleJointSkeleton(identityLocal(), scaleUniform(1));
    const track: AnimTrack = {
      node: 0,
      path: 'translation',
      times: new Float32Array([0, 1]),
      values: new Float32Array([0, 0, 0, 0, 3, 0]),
      stride: 3,
      interpolation: 'LINEAR',
    };
    const clip: AnimClip = { name: 'lift', duration: 1, tracks: [track] };
    const st = createSkinState(sk, [clip]);
    st.time = 1;
    const out = new Float32Array((sk.joints.length + 1) * 16);
    evalJointMatrices(st, out);
    const jm = out.subarray(0, 16);
    const p = applyMat4(jm, 0, 1, 0);
    expect(p[0]).toBeCloseTo(0, 5);
    expect(p[1]).toBeCloseTo(4, 5); // 1 + 3 平移
    expect(p[2]).toBeCloseTo(0, 5);
  });
});

describe('advance · 时间推进与循环', () => {
  function clip1s(): AnimClip {
    const track: AnimTrack = {
      node: 0,
      path: 'translation',
      times: new Float32Array([0, 1]),
      values: new Float32Array([0, 0, 0, 0, 0, 0]),
      stride: 3,
      interpolation: 'LINEAR',
    };
    return { name: 'c', duration: 1, tracks: [track] };
  }

  it('循环：0.9 + 0.2 → 回到 0.1', () => {
    const st = createSkinState(singleJointSkeleton(identityLocal(), scaleUniform(1)), [clip1s()]);
    seek(st, 0.9);
    advance(st, 0.2);
    expect(st.time).toBeCloseTo(0.1, 6);
    expect(st.playing).toBe(true);
  });

  it('非循环：越过结尾停在 duration 且停止播放', () => {
    const st = createSkinState(singleJointSkeleton(identityLocal(), scaleUniform(1)), [clip1s()]);
    st.loop = false;
    seek(st, 0.9);
    advance(st, 0.2);
    expect(st.time).toBeCloseTo(1, 6);
    expect(st.playing).toBe(false);
  });

  it('selectClip(-1) 停止：clip=-1, playing=false, time=0', () => {
    const st = createSkinState(singleJointSkeleton(identityLocal(), scaleUniform(1)), [clip1s()]);
    selectClip(st, -1);
    expect(st.clip).toBe(-1);
    expect(st.playing).toBe(false);
    expect(st.time).toBe(0);
  });
});

describe('packSkin · 顶点缓冲交织', () => {
  it('有蒙皮：u16 关节 + f32 权重按 24 字节 stride 交织', () => {
    const joints = new Uint16Array([0, 1, 2, 3]);
    const weights = new Float32Array([1, 0, 0, 0]);
    const buf = packSkin(joints, weights, 1);
    expect(buf.byteLength).toBe(24);
    const jv = new Uint16Array(buf, 0, 4);
    const wv = new Float32Array(buf, 8, 4);
    expect(Array.from(jv)).toEqual([0, 1, 2, 3]);
    expect(Array.from(wv)).toEqual([1, 0, 0, 0]);
  });

  it('无蒙皮：退化为关节 0 + 权重 1（顶点静止不随骨骼动）', () => {
    const buf = packSkin(null, null, 2);
    expect(buf.byteLength).toBe(48);
    // 交错布局：顶点 i 的关节在 u16 元素 [12i..12i+3]，权重在 f32 元素 [6i+2..6i+5]
    const jv = new Uint16Array(buf);
    const wv = new Float32Array(buf);
    for (let i = 0; i < 2; i++) {
      for (let k = 0; k < 4; k++) {
        expect(jv[12 * i + k]).toBe(0);
        expect(wv[6 * i + 2 + k]).toBe(k === 0 ? 1 : 0);
      }
    }
  });
});
