/**
 * 生成 A-pose 的合成 BVH 样例（Mixamo 风格：22 关节 / cm / 30fps / Y-up）。
 *
 * 为什么要把「生成器」也入库：ADR-008 要求验证资产与结论同入库，而一个手工改出来的
 * .bvh 无法回答「这份文件到底是怎么来的」。改了这里必须重跑并覆盖产物：
 *
 *   node assets/characters/_tools/make_apose_sample.mjs
 *
 * 产物 `sample_apose_arm45.bvh` 的两个消费方：
 *   · apps/editor/test/retarget.test.ts  —— 锁数学（maxAlign 必须 = 45°）
 *   · tools/verify/editor-smoke.mjs L 段 —— 锁浏览器端链路（载入 → 重定向 → 烘焙/挂载）
 *
 * 与测试里那个 buildBvh 是各自独立构造的同构夹具，两边独立才构成交叉验证。
 */

/**
 * @param armDeg 手臂下垂角度：0 = T-pose（水平），45 = A-pose（斜向下）
 */
export function buildBvhText(armDeg, frames = 5, fps = 30) {
  const rad = (armDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = -Math.sin(rad);
  const n = (v) => (Object.is(v, -0) ? '0.00000' : v.toFixed(5));
  const arm = (len) => ` ${n(len * dx)} ${n(len * dy)} 0.00000`;
  const mirrorArm = (len) => ` ${n(-len * dx)} ${n(len * dy)} 0.00000`;
  const R3 = 'CHANNELS 3 Zrotation Yrotation Xrotation';

  const out = [];
  let depth = 0;
  const ind = () => '  '.repeat(depth);
  const close = () => {
    depth--;
    out.push(ind() + '}');
  };
  const openJoint = (name, offset) => {
    out.push(ind() + `JOINT ${name}`);
    out.push(ind() + '{');
    depth++;
    out.push(ind() + `OFFSET${offset}`);
    out.push(ind() + R3);
  };
  const endSite = (offset) => {
    out.push(ind() + 'End Site');
    out.push(ind() + '{');
    depth++;
    out.push(ind() + `OFFSET${offset}`);
    close();
  };

  out.push('HIERARCHY');
  out.push('ROOT Hips');
  out.push('{');
  depth = 1;
  out.push(ind() + 'OFFSET 0.00000 100.00000 0.00000');
  out.push(ind() + 'CHANNELS 6 Xposition Yposition Zposition Zrotation Yrotation Xrotation');

  // ── 脊柱链：Spine → Spine1 → Spine2 → Neck → Head(End Site) ──
  openJoint('Spine', ' 0.00000 10.00000 0.00000');
  openJoint('Spine1', ' 0.00000 10.00000 0.00000');
  openJoint('Spine2', ' 0.00000 10.00000 0.00000');
  openJoint('Neck', ' 0.00000 12.00000 0.00000');
  openJoint('Head', ' 0.00000 8.00000 0.00000');
  endSite(' 0.00000 12.00000 0.00000');
  close(); // Head
  close(); // Neck  ← Spine2 仍开着，下面接着挂肩

  // ── 左臂链（A-pose：整条链沿 (cos,−sin,0) 方向）──
  openJoint('LeftShoulder', ' 3.00000 8.00000 0.00000');
  openJoint('LeftArm', arm(17));
  openJoint('LeftForeArm', arm(25));
  openJoint('LeftHand', arm(8));
  endSite(arm(6));
  close(); // LeftHand
  close(); // LeftForeArm
  close(); // LeftArm
  close(); // LeftShoulder ← 回到 Spine2

  // ── 右臂链（x 取反）──
  openJoint('RightShoulder', ' -3.00000 8.00000 0.00000');
  openJoint('RightArm', mirrorArm(17));
  openJoint('RightForeArm', mirrorArm(25));
  openJoint('RightHand', mirrorArm(8));
  endSite(mirrorArm(6));
  close(); // RightHand
  close(); // RightForeArm
  close(); // RightArm
  close(); // RightShoulder ← 回到 Spine2

  close(); // Spine2
  close(); // Spine1
  close(); // Spine  ← 回到 Hips

  // ── 双腿链 ──
  for (const [side, sx] of [
    ['Left', 1],
    ['Right', -1],
  ]) {
    openJoint(`${side}UpLeg`, ` ${n(8 * sx)} 0.00000 0.00000`);
    openJoint(`${side}Leg`, ' 0.00000 -42.00000 0.00000');
    openJoint(`${side}Foot`, ' 0.00000 -42.00000 0.00000');
    // ToeBase 必须**平着朝前**：HumanIK 模板的 LeftToeBase offset 是 (0,0,0.14)，
    // 写成下倾（比如 (0,−6,12)）会让 Foot 的骨向差 atan(6/12)=26.57°，
    // 于是「T-pose 源」也报出对齐角 —— 那是夹具写错，不是重定向有问题。
    openJoint(`${side}ToeBase`, ' 0.00000 0.00000 12.00000');
    endSite(' 0.00000 0.00000 8.00000');
    close(); // ToeBase
    close(); // Foot
    close(); // Leg
    close(); // UpLeg
  }

  close(); // Hips

  out.push('MOTION');
  out.push(`Frames: ${frames}`);
  out.push(`Frame Time: ${(1 / fps).toFixed(6)}`);
  // 6（根 6DOF）+ 21 × 3 = 69 列；全 0 帧 = 源 rest pose（Yposition 保住 Hips 高度）
  const dof = 6 + 21 * 3;
  for (let f = 0; f < frames; f++) {
    const row = new Array(dof).fill(0);
    row[1] = 100;
    out.push(row.map((v) => v.toFixed(5)).join(' '));
  }
  return out.join('\n') + '\n';
}

// 直接执行时写出产物（node assets/characters/_tools/make_apose_sample.mjs）
const isMain =
  process.argv[1] !== undefined &&
  process.argv[1].replace(/\\/g, '/').endsWith('make_apose_sample.mjs');
if (isMain) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  for (const deg of [0, 45]) {
    const file = path.join(here, deg === 0 ? 'sample_tpose_arm0.bvh' : 'sample_apose_arm45.bvh');
    // newline 无关：纯文本资产统一 LF，避免跨平台 diff（Windows Python open() 的坑）
    fs.writeFileSync(file, buildBvhText(deg).replace(/\r\n/g, '\n'), 'utf8');
    console.log(`${file}  (${fs.statSync(file).size} bytes, armDeg=${deg})`);
  }
}
