/**
 * fixture.ts —— motion-retarget 测试的共享输入构造器（MR-02 起复用）。
 *
 * 只提供**输入**与独立 oracle 的素材，不用被测实现生成预期值（docs/16 §6）。
 * 骨架 = HumanIK 22 骨干（Mixamo 命名去掉前缀），与 retarget.test.ts 的
 * buildBvh 同构但独立维护——两个文件锁的是不同契约，不共享私有夹具。
 */

export interface BvhSpec {
  /** 手臂下垂角（度）：0 = T-pose，45 = A-pose */
  armDeg?: number;
  /** up 轴；'Z' 输出 Z-up 坐标（y/z 互换、z 取负保持右手系） */
  up?: 'Y' | 'Z';
  /** 偏移单位：'cm'（默认，骨架高 ~170）| 'm'（×0.01） */
  unit?: 'cm' | 'm';
  frames?: number;
  frameTime?: number;
  /** 每帧根位置（源单位、Y-up 语义；builder 负责轴转换）。默认原地站立 */
  rootPos?: (f: number) => [number, number, number];
  /** 每帧各关节欧拉角（度，[x,y,z] 按通道名写入）。默认全零 */
  rot?: (f: number, joint: string) => [number, number, number];
  /** 根通道：'6'（默认，带位置）| '3'（无位置通道 → in-place-with-phase） */
  rootChannels?: '6' | '3';
}

interface Node {
  name: string;
  off: [number, number, number];
  ch?: Node[];
}

/** HumanIK 22 骨干 rest 偏移（cm；与 humanik-template 的米值 ×100 同源） */
export function standardTree(armDeg: number, P: (x: number, y: number, z: number) => [number, number, number]): Node {
  const a = (armDeg * Math.PI) / 180;
  // 手臂偏移也必须过 P（单位/up 轴换算），否则 m 制素材手臂骨长差 100 倍
  const arm = (len: number, side: 1 | -1): [number, number, number] =>
    P(side * len * Math.cos(a), -len * Math.sin(a), 0);
  const leaf = (name: string, off: [number, number, number]): Node => ({ name, off });
  return {
    name: 'Hips',
    off: P(0, 100, 0),
    ch: [
      {
        name: 'Spine',
        off: P(0, 15, 0),
        ch: [
          { name: 'Spine1', off: P(0, 15, 0), ch: [
            { name: 'Spine2', off: P(0, 15, 0), ch: [
              { name: 'Neck', off: P(0, 15, 0), ch: [leaf('Head', P(0, 20, 0))] },
              { name: 'LeftShoulder', off: P(7, 10, 0), ch: [
                { name: 'LeftArm', off: arm(10, 1), ch: [
                  { name: 'LeftForeArm', off: arm(26, 1), ch: [leaf('LeftHand', arm(25, 1))] },
                ] },
              ] },
              { name: 'RightShoulder', off: P(-7, 10, 0), ch: [
                { name: 'RightArm', off: arm(10, -1), ch: [
                  { name: 'RightForeArm', off: arm(26, -1), ch: [leaf('RightHand', arm(25, -1))] },
                ] },
              ] },
            ] },
          ] },
        ],
      },
      { name: 'LeftUpLeg', off: P(10, -10, 0), ch: [
        { name: 'LeftLeg', off: P(0, -42, 0), ch: [
          { name: 'LeftFoot', off: P(0, -45, 0), ch: [leaf('LeftToeBase', P(0, 0, 14))] },
        ] },
      ] },
      { name: 'RightUpLeg', off: P(-10, -10, 0), ch: [
        { name: 'RightLeg', off: P(0, -42, 0), ch: [
          { name: 'RightFoot', off: P(0, -45, 0), ch: [leaf('RightToeBase', P(0, 0, 14))] },
        ] },
      ] },
    ],
  };
}

function ser(n: Node, ind: number, isRoot: boolean, rootChannels: '6' | '3', rot: (f: number, j: string) => [number, number, number], frames: number, unitScale: number, rootPos: (f: number) => [number, number, number], up: 'Y' | 'Z'): string {
  const pad = '  '.repeat(ind);
  const kw = isRoot ? 'ROOT' : 'JOINT';
  const chans = isRoot
    ? rootChannels === '6'
      ? 'CHANNELS 6 Xposition Yposition Zposition Zrotation Yrotation Xrotation'
      : 'CHANNELS 3 Zrotation Yrotation Xrotation'
    : 'CHANNELS 3 Zrotation Yrotation Xrotation';
  let s =
    `${pad}${kw} ${n.name}\n${pad}{\n` +
    `${pad}  OFFSET ${n.off[0]} ${n.off[1]} ${n.off[2]}\n` +
    `${pad}  ${chans}\n`;
  for (const c of n.ch ?? []) s += ser(c, ind + 1, false, rootChannels, rot, frames, unitScale, rootPos, up);
  return s + `${pad}}\n`;
}

/** 生成完整 BVH 文本 */
export function buildBvhText(spec: BvhSpec = {}): string {
  const armDeg = spec.armDeg ?? 0;
  const up = spec.up ?? 'Y';
  const unitScale = spec.unit === 'm' ? 0.01 : 1;
  const frames = spec.frames ?? 5;
  const frameTime = spec.frameTime ?? 1 / 30;
  const rootChannels = spec.rootChannels ?? '6';
  const rot = spec.rot ?? (() => [0, 0, 0] as [number, number, number]);
  const rootPos = spec.rootPos ?? (() => [0, 100, 0] as [number, number, number]);

  const P = (x: number, y: number, z: number): [number, number, number] => {
    const sx = x * unitScale;
    const sy = y * unitScale;
    const sz = z * unitScale;
    return up === 'Y' ? [sx, sy, sz] : [sx, -sz, sy];
  };
  const tree = standardTree(armDeg, P);

  let motion = `MOTION\nFrames: ${frames}\nFrame Time: ${frameTime}\n`;
  for (let f = 0; f < frames; f++) {
    const row: number[] = [];
    if (rootChannels === '6') {
      const [rx, ry, rz] = rootPos(f);
      const scaled: [number, number, number] = [rx * unitScale, ry * unitScale, rz * unitScale];
      const [px, py, pz] = up === 'Y' ? scaled : [scaled[0], -scaled[2], scaled[1]];
      row.push(px, py, pz);
    }
    // 关节按 HIERARCHY 声明序（深度优先）写 ZYX 欧拉；根先、子后
    const emit = (n: Node, isRoot: boolean): void => {
      const [x, y, z] = rot(f, n.name);
      if (isRoot && rootChannels === '6') row.push(z, y, x);
      else row.push(z, y, x);
      for (const c of n.ch ?? []) emit(c, false);
    };
    emit(tree, true);
    motion += row.map((v) => (Number.isInteger(v) ? v : v.toFixed(6))).join(' ') + '\n';
  }
  return `HIERARCHY\n${ser(tree, 0, true, rootChannels, rot, frames, unitScale, rootPos, up)}${motion}`;
}

/** 深度优先的 22 关节名序（与 HIERARCHY 声明序一致；测试对通道序断言用） */
export function jointOrderOf(): string[] {
  const out: string[] = [];
  const walk = (n: Node): void => {
    out.push(n.name);
    for (const c of n.ch ?? []) walk(c);
  };
  walk(standardTree(0, (x, y, z) => [x, y, z]));
  return out;
}
