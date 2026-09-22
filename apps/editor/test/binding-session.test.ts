import { describe, expect, it } from 'vitest';
import {
  HUMANIK_ORDER,
  tposeWorldPositions,
} from '../src/services/binding/humanik-template';
import { BindingSession } from '../src/services/binding/binding-session';

/**
 * BindingSession（headless 领域会话）的回归测试。
 *
 * 守的是 docs/17 §3.4 的那条不变量：**GUI 与未来的 Agent/MCP 入口调用同一套
 * 领域操作，谁都不能绕过校验、撤销与保存语义**。因此这里锁的是：
 *   - 每条编辑路径都进历史（撤销严格对称，PR #8 复审的全量快照不变量）；
 *   - 非法输入被拒且不留痕（不改状态、不打历史）；
 *   - hydrate 的形状校验（脏数据保持现值，不静默修数据）；
 *   - Bind bookkeeping（freezeBindPose / markExported / clearExportStamp 的指纹语义）。
 */

/** 最小合法网格：两个三角形拼一个四边形（15-float 顶点布局，只填 pos，其余置 0） */
function makeQuad(): { vertices: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  const VF = 15;
  const verts = new Float32Array(4 * VF) as Float32Array<ArrayBuffer>;
  const pos: Array<[number, number, number]> = [
    [0, 0, 0], [0.1, 0, 0], [0.1, 0.1, 0], [0, 0.1, 0],
  ];
  pos.forEach((p, i) => {
    verts[i * VF] = p[0];
    verts[i * VF + 1] = p[1];
    verts[i * VF + 2] = p[2];
  });
  return { vertices: verts, indices: new Uint32Array([0, 1, 2, 0, 2, 3]) as Uint32Array<ArrayBuffer> };
}

function readySession(): BindingSession {
  const s = new BindingSession();
  const q = makeQuad();
  s.setModel('quad', q.vertices, q.indices);
  return s;
}

describe('BindingSession 初始与生命周期', () => {
  it('初始 = 模板 27 关节 + 默认导出选项', () => {
    const s = new BindingSession();
    expect(Object.keys(s.positions)).toHaveLength(HUMANIK_ORDER.length);
    expect(s.positions).toEqual(tposeWorldPositions());
    expect(s.getWeightMode()).toBe('wrapper');
    expect(s.getSmoothWeights()).toBe(true);
    expect(s.getSmoothIters()).toBe(4);
    expect(s.getSmoothLambda()).toBe(0.5);
    expect(s.getMirrorWeights()).toBe(false);
    expect(s.getCylinders()).toBeNull();
    expect(s.editSig()).toBeNull(); // 未载模型无指纹
  });

  it('setModel 重置会话但**保留关节摆位**（历史行为：local 空间跨模型不丢摆位）', () => {
    const s = readySession();
    const moved: [number, number, number] = [0.5, 1.2, 0.1];
    expect(s.poseJoint('Head', moved)).toBe(true);
    const q = makeQuad();
    s.setModel('quad2', q.vertices, q.indices);
    expect(s.getModelName()).toBe('quad2');
    expect(s.positions.Head).toEqual(moved); // 摆位保留
    expect(s.getWeightMode()).toBe('wrapper'); // 导出选项重置
    expect(s.historyDepth().undo).toBe(0); // 历史清空
    expect(s.getCylinders()).not.toBeNull(); // 半径表载入即建
    expect(s.getBoundSig()).toBeNull();
  });

  it('clear 清空会话并回模板 T-pose', () => {
    const s = readySession();
    s.poseJoint('Head', [0.5, 1.2, 0.1]);
    s.clear();
    expect(s.getModelName()).toBeNull();
    expect(s.positions).toEqual(tposeWorldPositions());
    expect(s.getMesh()).toBeNull();
    expect(s.computeSkin()).toBeNull();
  });
});

describe('BindingSession 编辑与历史纪律', () => {
  it('setJointPosition 校验：未知骨 / 非法坐标拒绝且不留痕', () => {
    const s = new BindingSession();
    const before = s.historyDepth().undo;
    expect(s.setJointPosition('NoSuchBone', [0, 0, 0])).toBe(false);
    expect(s.setJointPosition('Head', [NaN, 0, 0])).toBe(false);
    expect(s.historyDepth().undo).toBe(before);
  });

  it('poseJoint 自带历史；undo 回滚坐标，redo 重做', () => {
    const s = new BindingSession();
    const orig = [...s.positions.Head!] as [number, number, number];
    s.poseJoint('Head', [0.1, 2.2, 0.05]);
    expect(s.positions.Head).toEqual([0.1, 2.2, 0.05]);
    expect(s.historyDepth().undo).toBe(1);
    expect(s.undo()).toBe(true);
    expect(s.positions.Head).toEqual(orig);
    expect(s.historyDepth().redo).toBe(1);
    expect(s.redo()).toBe(true);
    expect(s.positions.Head).toEqual([0.1, 2.2, 0.05]);
  });

  it('全量快照不变量（PR #8）：撤销几何改动必须一并回滚中途改过的设置', () => {
    const s = new BindingSession();
    s.setWeightMode('distance'); // 第一步历史
    s.poseJoint('Head', [0.1, 2.2, 0.05]); // 第二步历史
    expect(s.getWeightMode()).toBe('distance');
    expect(s.undo()).toBe(true); // 撤掉关节改动
    expect(s.positions.Head).toEqual(tposeWorldPositions().Head);
    expect(s.undo()).toBe(true); // 撤掉设置改动
    expect(s.getWeightMode()).toBe('wrapper');
  });

  it('同 kind 合并窗口内只记一步；sealHistory 后新起一步', () => {
    const s = new BindingSession();
    s.beginEdit('nudge', 800);
    s.setJointPosition('Head', [0.01, 2.2, 0]);
    s.beginEdit('nudge', 800); // 同 kind 窗口内 → 合并
    s.setJointPosition('Head', [0.02, 2.2, 0]);
    expect(s.historyDepth().undo).toBe(1);
    s.sealHistory(); // 手势封口
    s.beginEdit('nudge', 800);
    s.setJointPosition('Head', [0.03, 2.2, 0]);
    expect(s.historyDepth().undo).toBe(2);
  });

  it('空栈 undo/redo 返回 false', () => {
    const s = new BindingSession();
    expect(s.undo()).toBe(false);
    expect(s.redo()).toBe(false);
  });
});

describe('BindingSession 导出选项校验', () => {
  it('setWeightMode 只接受合法字面量；同值不打历史', () => {
    const s = new BindingSession();
    expect(s.setWeightMode('distance')).toBe(true);
    expect(s.historyDepth().undo).toBe(1);
    expect(s.setWeightMode('distance')).toBe(false); // 同值
    expect(s.setWeightMode('garbage')).toBe(false); // 非法
    expect(s.getWeightMode()).toBe('distance');
    expect(s.historyDepth().undo).toBe(1);
  });

  it('setSmoothIters 钳制 [1,12] 取整；NaN 保持现值', () => {
    const s = new BindingSession();
    expect(s.setSmoothIters(0)).toBe(1);
    expect(s.setSmoothIters(99)).toBe(12);
    expect(s.setSmoothIters(NaN)).toBe(12);
    expect(s.setSmoothIters(6.6)).toBe(7);
  });

  it('setSmoothLambda 钳制 [0,1]；NaN 保持现值', () => {
    const s = new BindingSession();
    expect(s.setSmoothLambda(-0.5)).toBe(0);
    expect(s.setSmoothLambda(2)).toBe(1);
    expect(s.setSmoothLambda(NaN)).toBe(1);
  });
});

describe('BindingSession Skin Wrapper', () => {
  it('setCylinderRadius 打手动标记并进历史；autoFit 不碰手动骨', () => {
    const s = readySession();
    expect(s.setCylinderRadius('LeftArm', 'top', 0.2)).toBe(true);
    expect(s.historyDepth().undo).toBe(1);
    expect(s.getCylinders()!.LeftArm!.manual).toBe(true);
    const before = s.getCylinders()!.LeftArm!.radii.top;
    s.autoFitCylinders();
    expect(s.getCylinders()!.LeftArm!.radii.top).toBe(before); // 手动骨不动
  });

  it('setCylinderRadius 非法骨 / 非法值拒绝且不留痕', () => {
    const s = readySession();
    const before = s.historyDepth().undo;
    expect(s.setCylinderRadius('NoBone', 'top', 0.2)).toBe(false);
    expect(s.setCylinderRadius('LeftArm', 'top', NaN)).toBe(false);
    expect(s.historyDepth().undo).toBe(before);
  });

  it('mirror(L2R) 同时镜像关节坐标与包裹器半径（x 取反）', () => {
    const s = readySession();
    s.poseJoint('LeftArm', [0.3, 1.4, 0.02]);
    s.setCylinderRadius('LeftArm', 'top', 0.123);
    s.mirror('L2R');
    expect(s.positions.RightArm).toEqual([-0.3, 1.4, 0.02]);
    expect(s.getCylinders()!.RightArm!.radii.top).toBeCloseTo(0.123, 6);
    expect(s.historyDepth().undo).toBeGreaterThanOrEqual(3);
  });

  it('setCylinderOffset 全零存 undefined（干净）；非零进指纹', () => {
    const s = readySession();
    const sig0 = s.editSig();
    expect(s.setCylinderOffset('LeftArm', [0.01, 0, 0])).toBe(true);
    expect(s.getCylinders()!.LeftArm!.offset).toEqual([0.01, 0, 0]);
    expect(s.editSig()).not.toBe(sig0);
    expect(s.setCylinderOffset('LeftArm', [0, 0, 0])).toBe(true);
    expect(s.getCylinders()!.LeftArm!.offset).toBeUndefined();
  });
});

describe('BindingSession 持久化（hydrate / getEditorData）', () => {
  it('hydrate → getEditorData 往返一致（设置 + 几何 + 半径）', () => {
    const s = readySession();
    s.poseJoint('Head', [0.05, 2.1, 0.03]);
    s.setWeightMode('distance');
    s.setSmoothIters(6);
    s.setSmoothLambda(0.8);
    s.setMirrorWeights(true);
    s.setCylinderRadius('LeftLeg', 'medium', 0.15);
    const data = s.getEditorData();

    const s2 = readySession();
    s2.hydrate(JSON.parse(JSON.stringify(data)));
    expect(s2.getWeightMode()).toBe('distance');
    expect(s2.getSmoothIters()).toBe(6);
    expect(s2.getSmoothLambda()).toBe(0.8);
    expect(s2.getMirrorWeights()).toBe(true);
    expect(s2.positions.Head).toEqual([0.05, 2.1, 0.03]);
    expect(s2.getCylinders()!.LeftLeg!.radii.medium).toBeCloseTo(0.15, 6);
    // savedAt 是写盘时间戳，不参与等价
    const { savedAt: _a, ...a } = s2.getEditorData();
    const { savedAt: _b, ...b } = data;
    expect(a).toEqual(b);
  });

  it('hydrate 脏数据：坏字段保持现值，好字段正常回填（不静默修数据）', () => {
    const s = readySession();
    s.setSmoothIters(8);
    const headBefore = [...s.positions.Head!];
    s.hydrate({
      weightMode: 'garbage', // 非法字面量 → 保持 wrapper
      smoothIters: 99, // 超域 → 保持 8
      smoothLambda: -1, // 超域 → 保持 0.5
      smoothWeights: 'yes', // 非布尔 → 保持 true
      positions: {
        Head: [0.5, 'bad', 0], // 非法三元组 → 跳过
        NoBone: [0, 0, 0], // 未知骨 → 跳过
        Neck: [0, 1.65, 0], // 合法 → 采纳
      },
      cylinders: { LeftArm: { radii: { top: 0.1 } } }, // 形状不全 → 整包拒收
    });
    expect(s.getWeightMode()).toBe('wrapper');
    expect(s.getSmoothIters()).toBe(8);
    expect(s.getSmoothLambda()).toBe(0.5);
    expect(s.getSmoothWeights()).toBe(true);
    expect(s.positions.Head).toEqual(headBefore);
    expect(s.positions.Neck).toEqual([0, 1.65, 0]);
    expect(s.getCylinders()!.LeftArm!.radii.medium).not.toBe(0); // 未被脏包覆盖
  });

  it('hydrate 进历史：撤销一步回到回填前', () => {
    const s = readySession();
    const before = s.getEditorData();
    s.hydrate({ positions: { Head: [0.9, 2.3, 0] } });
    expect(s.positions.Head).toEqual([0.9, 2.3, 0]);
    expect(s.undo()).toBe(true);
    expect(s.positions.Head).toEqual(before.positions.Head);
  });

  it('getEditorData 是深拷贝：改返回值不反向污染会话', () => {
    const s = readySession();
    const data = s.getEditorData();
    data.positions.Head = [9, 9, 9];
    data.cylinders!.Head!.radii.top = 9;
    expect(s.positions.Head).not.toEqual([9, 9, 9]);
    expect(s.getCylinders()!.Head!.radii.top).not.toBe(9);
  });

  it('hydrate 非对象输入直接忽略', () => {
    const s = readySession();
    const before = s.historyDepth().undo;
    s.hydrate(null);
    s.hydrate('junk');
    s.hydrate(42);
    expect(s.historyDepth().undo).toBe(before);
  });
});

describe('BindingSession Bind bookkeeping', () => {
  it('freezeBindPose + markExported 后指纹一致；再改动 → 过期；clearExportStamp → 从未绑定', () => {
    const s = readySession();
    expect(s.getBoundSig()).toBeNull();
    s.freezeBindPose();
    s.markExported();
    expect(s.getBoundSig()).toBe(s.editSig()); // ✓ 已绑定
    s.poseJoint('Head', [0.2, 2.2, 0]);
    expect(s.getBoundSig()).not.toBe(s.editSig()); // ● 未导出（已过期）
    s.clearExportStamp();
    expect(s.getBoundSig()).toBeNull();
  });

  it('restoreBindPose：未 Bind = false；Bind 后改动再 restore 回到绑定姿态', () => {
    const s = readySession();
    expect(s.restoreBindPose()).toBe(false);
    s.poseJoint('Head', [0.3, 2.0, 0]);
    s.freezeBindPose();
    s.poseJoint('Head', [0.9, 1.0, 0]);
    expect(s.restoreBindPose()).toBe(true);
    expect(s.positions.Head).toEqual([0.3, 2.0, 0]);
  });

  it('freezeBindPose 是深拷贝：继续编辑不污染冻结姿态', () => {
    const s = readySession();
    s.freezeBindPose();
    s.poseJoint('Head', [0.9, 9.9, 0]);
    expect(s.getBindPose()!.Head).not.toEqual([0.9, 9.9, 0]);
  });
});

describe('BindingSession 权重计算（computeSkin）', () => {
  it('wrapper 与 distance 两条算法路径都产出合法权重，且顺序 = 算法→镜像→平滑', () => {
    const s = readySession();
    const wrapperRes = s.computeSkin();
    expect(wrapperRes).not.toBeNull();
    expect(wrapperRes!.stats).not.toBeNull(); // wrapper 模式有未包裹统计
    expect(wrapperRes!.skin.joints.length).toBe(s.vertexCount() * 4);

    s.setWeightMode('distance');
    const distRes = s.computeSkin();
    expect(distRes).not.toBeNull();
    expect(distRes!.stats).toBeNull(); // distance 模式无 wrapper 统计
    expect(distRes!.skin.joints.length).toBe(s.vertexCount() * 4);
  });

  it('缓存键 = 编辑指纹：同指纹命中同一引用，改动后重算', () => {
    const s = readySession();
    const a = s.computeSkin();
    const b = s.computeSkin();
    expect(b).toBe(a); // 缓存命中（零成本复用）
    s.setSmoothLambda(0.9); // 平滑参数进指纹
    const c = s.computeSkin();
    expect(c).not.toBe(a);
  });
});

describe('BindingSession 批量导出选项（applyOptions，PR #10 评审收口）', () => {
  it('多字段合并为一步历史：undo 一次全部回退', () => {
    const s = readySession();
    const before = s.historyDepth().undo;
    s.applyOptions({ weightMode: 'distance', smoothWeights: false, smoothIters: 7 });
    expect(s.historyDepth().undo).toBe(before + 1); // 一步，不是三步
    expect(s.getWeightMode()).toBe('distance');
    expect(s.getSmoothWeights()).toBe(false);
    expect(s.getSmoothIters()).toBe(7);
    s.undo();
    expect(s.getWeightMode()).toBe('wrapper');
    expect(s.getSmoothWeights()).toBe(true);
    expect(s.getSmoothIters()).toBe(4);
  });

  it('值全没变化时不打历史（返回 false）；越界值按 setter 同款钳制', () => {
    const s = readySession();
    const before = s.historyDepth().undo;
    expect(s.applyOptions({ smoothIters: 4, smoothLambda: 0.5 })).toBe(false);
    expect(s.historyDepth().undo).toBe(before);
    expect(s.applyOptions({ smoothIters: 99, smoothLambda: 5 })).toBe(true);
    expect(s.getSmoothIters()).toBe(12);
    expect(s.getSmoothLambda()).toBe(1);
  });

  it('非法 weightMode 字面量保持现值（与 setWeightMode 同纪律）', () => {
    const s = readySession();
    s.applyOptions({ weightMode: 'junk' });
    expect(s.getWeightMode()).toBe('wrapper');
  });
});

describe('BindingSession hydrate 原型链防护（PR #10 评审收口）', () => {
  it('positions 白名单：constructor / __proto__ / 未知骨一律跳过，对象原型不被改写', () => {
    const s = readySession();
    // 模拟脏 sidecar：JSON.parse 会把 __proto__ 造成 own 属性（不走 setter）
    const dirty = JSON.parse(
      '{"positions":{"constructor":[1,2,3],"__proto__":[1,2,3],"NotABone":[1,2,3],"Head":[0,1.9,0]}}',
    ) as unknown;
    s.hydrate(dirty);
    expect(s.positions.Head).toEqual([0, 1.9, 0]); // 好字段正常回填
    expect(Object.hasOwn(s.positions, 'constructor')).toBe(false);
    expect(Object.hasOwn(s.positions, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(s.positions)).toBe(Object.prototype); // 原型未被污染
    // 导出产物也只含合法骨名（脏键不会经 getEditorData 回流到 sidecar）
    for (const k of Object.keys(s.getEditorData().positions)) {
      expect(HUMANIK_ORDER.includes(k)).toBe(true);
    }
  });

  it('cylinders 白名单：原型链键被滤掉，合法骨正常回填', () => {
    const s = readySession();
    const dirty = JSON.parse(
      '{"cylinders":{"LeftArm":{"radii":{"top":0.1,"medium":0.1,"bottom":0.1},"enabled":true},' +
      '"constructor":{"radii":{"top":9,"medium":9,"bottom":9},"enabled":true}}}',
    ) as unknown;
    s.hydrate(dirty);
    const cyls = s.getCylinders();
    expect(cyls).not.toBeNull();
    expect(cyls!.LeftArm?.radii.top).toBe(0.1);
    expect(Object.hasOwn(cyls!, 'constructor')).toBe(false);
  });
});
