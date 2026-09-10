# Motion Match —— 重定向后的动画匹配设计

> 范围：在 `apps/editor/src/services/binding/retarget.ts`（下称 **L0**）之上新增的**位置守恒**层。
> 视角：技美 —— 解决「同一套 mocap 套到不同比例角色上时的滑步（foot sliding）与动作幅度失真」。
> 日期：2026-09-10　状态：**设计已定，未实现**
> 关联：`docs/06`（资产生成管线）、`docs/15`（绑定与蒙皮评审）、`apps/editor/test/retarget.test.ts`

---

## 0. 结论先行

现有 L0 是**纯 FK 旋转重定向**，它守住的只有一条不变量：

```
Q_tgt_i(f) · d_tgt_i  =  Q_src_i(f) · d_src_i        （世界骨向守恒）
```

**它完全没守住末端效应器的世界位置。** 而 HumanIK / MotionBuilder 的 "Match" 本质是后者。

由此产生两个必然症状：

| 症状 | 机理 |
|---|---|
| **动作幅度失真** | 旋转相同 + 骨长不同 ⟹ 末端位移 = ΣL·sinθ 必然不同。源臂 0.70 摸到头顶，目标臂 0.55 就停在胸口 |
| **滑步** | 根位移按**单一全局腿长比**缩放，而脚的落点由 FK 用**目标骨长 × 源旋转**算出。两条路径只在「目标是源的等比缩放」时才相等 —— 现实中比例分布不同，必然对不上 |

**修复思路不是调参数，是加一层**：把动画的**语义层**（末端效应器的世界轨迹）抽出来按链比映射，再用 IK 反解回旋转。旋转从此不再是守恒量，而是被位置约束求解出来的结果。

### 三条新的不变量（新增层必须守住）

| # | 不变量 | 判据 |
|---|---|---|
| **I2** | 末端位置守恒：目标 tip 相对链根的偏移 = 源 tip 相对链根的偏移 × **该链长度比** | §6-T4 |
| **I3** | 接触期脚世界静止：接触帧内目标脚的水平位移 < ε | §6-T3 |
| **I4** | 根位移与接触约束自洽：腿永不过伸，夹紧量必须为 0 或已回退根 | §6-T8 |

**I1（旋转守恒，L0 已有）在新链路里不再全局成立** —— 四肢的旋转会被 IK 覆盖。这是有意为之，也是本设计的全部意义。退化检验见 §6-T1/T2：等比情形下新层必须是恒等变换，不破坏 L0。

---

## 1. 现状审计：L0 精确做了什么

`retarget.ts:266` 的核心一行：

```ts
const q = quatMul(quatMul(aP, qSrc), aI);   // R'_i = A_parent · R_i · A_i⁻¹
```

- `A_i = quatFromUnitVectors(d_src_i, d_tgt_i)` —— 把源 rest 骨向旋到目标 rest 骨向
- 根位移（`retarget.ts:287`）：`tgtHips + (w − rest) * skeletonScale`
- `skeletonScale`（`computeSkeletonScale`, `retarget.ts:602`）= **目标腿长 / 源腿长**，其中
  `腿长 = Hips.y − min(所有关节.y)`

### 1.1 这个缩放量的精确语义

对 T-pose 模板，`min(y)` 落在 `LeftToeBase` / `LeftFoot`（两者 y 相同，脚掌沿 Z 外伸），
所以：

```
腿长 = Hips.y − Foot.y = 1.00 − 0.03 = 0.97
```

⚠️ **这个 0.97 不是腿骨长度**，它是「髋到踝的**高度差**」，混进了 `LeftUpLeg` 的横向髋偏移
（tposeOffset `[0.10, −0.10, 0]` 里的 −0.10）。真正的**腿骨链长**是：

```
legLen = |UpLeg → Leg| + |Leg → Foot| = 0.42 + 0.45 = 0.87
```

两者差 11%，**必须分开用**，不能混：

| 量 | 定义 | 用途 |
|---|---|---|
| `hipToAnkleY` | `Hips.y − Foot.y` | 根位移缩放（**沿用 L0 现值**，不改，否则破坏 40+ 条既有断言） |
| `legLen` | 大腿 + 小腿 | IK 链的**长度比**与可达半径（新层专用） |

### 1.2 缺失清单

| 缺口 | 后果 |
|---|---|
| 只有**一个**全局 scale，没有分链 | 腿躯干比例不同时，顾此失彼 |
| 没有 IK | 末端位置完全由 FK 决定，无法被约束 |
| 没有接触检测 / 脚锁定 | mocap 自身的微小滑动被忠实传递并放大 |
| 没有地面约束 | 脚穿地或悬空 |
| Hips 高度没做整体对齐 | 系统性偏高/偏低，看起来「飘」 |

---

## 2. 分层设计

| 层 | 职责 | 输出 | MVP |
|---|---|---|---|
| **L0** | FK 骨向对齐（已有） | 旋转 + 根位移 | ✅ 已有 |
| **L1** | 骨架比例归一化 | 目标末端世界位置 | ✅ |
| **L2** | 末端 IK 反解 | 四肢旋转 | ✅ |
| **L3** | 接触帧脚锁定 + 根回退 | 修正的根位移 | ✅ |
| **L4** | 地面 clamp + Hips 高度对齐 | 最终动画 | ⏸ 下一轮 |

### 2.1 IK / FK 的划分（关键设计决策）

```
FK 区（不被 IK 触碰）:  Hips · Spine · Spine1 · Spine2 · Neck · Head
IK 区（MVP）:           LeftUpLeg → LeftLeg → LeftFoot
                        RightUpLeg → RightLeg → RightFoot
预留（默认关闭）:        LeftArm → LeftForeArm → LeftHand （右同）
```

**中轴走 FK 的理由**：重心起伏、躯干扭转、头部朝向是 mocap 的节奏信息，
用 IK 反解会把它平滑掉，角色会「飘」。HumanIK 也是这么切的。

**手臂默认不走 IK 的理由**（已与用户确认）：

1. 本项目是第三人称射击游戏，角色大量时间处于持枪 / 瞄准姿态 —— 手臂 IK 与瞄准姿势
   直接打架，且持枪没有世界空间约束可依；
2. 手部没有地面接触，锁定的收益远小于腿部；
3. 幅度匹配（L1）对手臂的出口是 IK，没有 IK 就没有消费方 —— 所以 **MVP 里臂链完全不进
   motion match**，保持 L0 的 FK 结果。

> 实现上 L2 是**链无关**的（`IkChainDef` 配置驱动），日后要开手臂 IK 只需加两条链配置，
> 不用改算法。

---

## 3. L1 · 骨架比例归一化

### 3.1 骨长与链比

从源 / 目标的 rest 世界坐标各算一次骨长（`骨 i 的长 = |p_i − p_parent(i)|`）：

```
r_c = L_tgt_c / L_src_c          c ∈ { leg_L, leg_R, (arm_L, arm_R, spine) }
```

其中 `L_leg = |UpLeg→Leg| + |Leg→Foot|`（纯腿骨，不含髋偏移）。

**为什么按链而不是按全身**：mocap 演员腿 0.90 / 躯干 0.50，僵尸腿 0.70 / 躯干 0.70，
总高相同 → 全局 scale = 1.0，但腿链比 = 0.78、脊柱链比 = 1.40。一个数字表达不了两个比值。

### 3.2 末端目标位置

对每帧 f、每条 IK 链 c：

```
offset_src(f) = P_src_tip(f) − P_src_root(f)              // 源：tip 相对链根
offset_tgt(f) = offset_src(f) · r_c                        // 各向同性缩放
P_tgt_tip(f)  = P_tgt_root(f) + offset_tgt(f)              // 贴到目标链根上
```

`P_tgt_root(f)` = 目标 Hips 世界位置 + 链根相对 Hips 的 **rest 固定偏移**（目标骨架常量）。

### 3.3 为什么用各向同性缩放

- **简单可预测**，且与「目标 = 源等比 k 倍」的退化情形**完全一致**：
  此时 `r_c = k`，`offset_tgt = offset_src · k`，而 FK 出来的也是 k 倍 → 两条路径吻合 →
  新层退化为恒等（§6-T2 守住这条）。
- 分轴缩放（垂直按腿长、水平按步幅）会破坏这个退化性质，且引入难以直观预测的结果。
  **不做。**

---

## 4. L2 · 两骨 IK 反解（解析解，非迭代）

### 4.1 解析解

链 `root(A) → mid(B) → tip(C)`，骨长 `L1 = |AB|`、`L2 = |BC|`（rest 值，恒定），
目标位置 `T`，极向量 `pole`（世界方向）：

```
d  = T − A
D  = clamp(|d|,  |L1 − L2| + ε,  L1 + L2 − ε)      // 夹紧，防过伸/NaN
u  = normalize(d)

cos θ₁ = (L1² + D² − L2²) / (2 · L1 · D)            // 大腿与 root→tip 连线的夹角
cos θ₂ = (L1² + L2² − D²) / (2 · L1 · L2)           // 膝内角

pole_perp = normalize(pole − u · dot(pole, u))      // 极向量投影到垂直于 u 的平面

B = A + L1 · (u · cos θ₁ + pole_perp · sin θ₁)      // 膝的世界位置
```

夹紧后 `T` 若不可达，实际落点是 `A + u · D`，残差进 `report.maxStretch`。

### 4.2 极向量必须来自源姿态

`pole = P_src_mid − (P_src_root + u_src · dot(P_src_mid − P_src_root, u_src))`

膝盖 / 手肘朝哪边弯是 mocap 的语义信息。用固定方向（如世界 +Z）会在角色转身时出现
**膝盖反折或内外翻**。方向是单位向量，与尺度无关，可直接跨骨架复用。

### 4.3 swing–twist 分解：保留 mocap 的扭转

直接对骨做 `quatFromUnitVectors(u_cur → u_target)` 是**最小旋转**，它会把绕骨自身轴的
扭转（twist）一起改掉 —— 脚掌的外八 / 内八会被掰正。

正确做法是只应用 **swing** 分量：

```
q_delta  = quatFromUnitVectors(u_cur, u_target)
q_swing, q_twist = swingTwist(q_delta, u_cur)      // 沿 u_cur 轴分解
Q_i'     = q_swing · Q_i                            // 只叠加 swing
R_i'     = Q_parent'⁻¹ · Q_i'                       // 转回 local
```

`swingTwist` 分解（沿轴 `a`）：

```
p = a · dot([q.x, q.y, q.z], a)          // 轴上的投影 = twist 部分
q_twist = normalize([p.x, p.y, p.z, q.w])
q_swing = q · q_twist⁻¹
```

⚠️ `dot(v, a) < 0` 时要对 `q_twist` 取反再归一化（四元数双覆盖），否则会出现 180° 翻转。

### 4.4 落地位置

`binding-math.ts` 已有 `matMul` / `matInvertRigid` / `matPoint` / `quatFromUnitVectors`，
缺 `quatFromMat` / `slerp` / `swingTwist` / `forwardKinematics`，需补。

---

## 5. L3 · 接触帧脚锁定 + 根回退

### 5.1 为什么 L1+L2 之后仍然需要 L3

L1+L2 已经消除了**由比例差异引起的**滑步。残余来源有三：

1. mocap 自身在接触期也不是严格静止（真人脚有微滑），IK 会**忠实放大**这部分；
2. 接触起止帧的检测误差；
3. IK 夹紧（够不到）导致的漂移。

L3 是**加固层**，不是核心层。

### 5.2 检测点 vs effector

| 用途 | 关节 | 理由 |
|---|---|---|
| **接触检测点** | `LeftToeBase` / `RightToeBase` | 脚趾先着地、后离地，对接触最敏感；用踝（Foot）会在「脚跟离地、脚趾仍触地」阶段漏检 |
| **IK effector** | `LeftFoot` / `RightFoot` | 踝是两骨 IK 链的天然末端 |

两者不一致，需要一次转换（锁定期间）：

```
P_foot_target = P_lock_toe − R_foot_world · off_toe
```

其中 `off_toe` = `ToeBase` 相对 `Foot` 的 **rest 局部偏移**（目标骨架常量），
`R_foot_world` = 当前帧 FK 得到的 Foot 世界旋转。
这样脚掌的 heel-to-toe 翻转被完整保留，不会被钉成平板。

### 5.3 接触判定（全部相对化，避开 cm/m 单位陷阱）

```
高度： |C.y − groundY|                 < heightEps · srcLegLen     (默认 0.05)
速度： |C(f+1) − C(f)| / dt            < speedEps  · srcLegLen/s   (默认 0.20)
持续： 连续满足 ≥ minContactFrames 帧才算一段                        (默认 3)
```

阈值乘以 `srcLegLen` 而非写死米数 —— 源 BVH 可能是 cm 单位（`unitScale = 0.01`），
写死会全盘失效。

### 5.4 根回退（防过伸，这是 L3 真正的作用）

⚠️ **常见误解**：脚锁定不是把 Hips 冻住。单脚支撑时身体**必须**继续前进，
否则角色会原地踏步。

正确的因果是：

```
源 mocap:  Hips 前进 D_src，被锁脚世界不动，源腿从「前伸」变「后展」
目标:      Hips 前进 D_src · r_leg，被锁脚世界不动
           ⟹ 所有长度同比缩放，腿在整个接触期内始终在可达范围内  ✓
```

所以**只要根位移用了链比、脚锁定位置也按链比映射，就是自洽的，不需要额外修正**。

L3 要处理的只是**自洽被破坏**的情形（残差累积、检测误差、源动画本身脚在动）：
当 IK 夹紧量 > 0 时，**把根拉回来**而不是让腿过伸：

```
若夹紧:   H(f) += u · (dist − D_max)      // 沿 root→tip 方向回退根
          用新的 H(f) 重跑一次 IK          // 单次迭代，残差进 report
```

只对**接触期**做根回退 —— 非接触期脚在空中，夹紧无害且回退会破坏步幅。

### 5.5 落地顺序（每帧）

```
1. L1:  算 H(f) 候选 + 各 tip 目标位置
2. L3:  tip 目标 = 接触期 ? P_lock : L1 映射
3. L2:  IK 解算 → 腿部旋转
4. L3:  夹紧 ? 根回退 + 重跑 IK（一次）
5. L4:  地面 clamp + Hips 整体高度对齐
```

---

## 6. 测试判据（可证伪）

> 原则同 `retarget.test.ts`：判据必须**独立于被测实现**，禁止自证。
> 新文件 `apps/editor/test/motion-match.test.ts`。

| # | 判据 | 断言 |
|---|---|---|
| **T1** | **等比退化恒等**：目标骨架 = 源骨架 ⟹ 输出与输入逐帧相同 | 旋转差 < 1e-5，根位移差 < 1e-6 |
| **T2** | **缩放退化**：目标 = 源 × k ⟹ 旋转**不变**、根位移 × k | 旋转差 < 1e-5；`scale(k)/scale(1) ≈ k` |
| **T3** | **零滑步**：接触帧内目标脚的**水平**位移 < 1e-4 m | 遍历所有接触段 |
| **T4** | **末端位置守恒**（I2）：非接触帧，`offset_tgt ≈ offset_src · r_c` | 相对误差 < 1e-4 |
| **T5** | **twist 保持**：`preserveTwist=true` 时，脚绕小腿轴的扭转与 FK 结果一致 | 夹角 < 0.5° |
| **T6** | **不破坏 L0**：`retarget.test.ts` 全部仍通过 | 全套绿 |
| **T7** | **接触检测**：合成「走路」夹具（脚周期性静止/移动），断言段数与锁定位置正确 | 段数 == 设计值 |
| **T8** | **过伸保护**：目标超出可达半径时腿伸直、无 NaN、且 `report.maxStretch > 0` | 无 NaN + 有告警 |
| **T9** | **单位无关**：同一动作分别用 m / cm 的源 BVH，输出的末端世界轨迹一致 | 差 < 1e-5 |

**T1/T2 是最重要的两条** —— 它们保证新层不会把「本来就对」的等比情形搞坏。
任何一条挂了，说明新层引入了非物理的偏差。

**滑步度量**（供 T3 与 report）：

```
slide(f) = |P_foot(f+1) − P_foot(f)| 的水平分量     （仅接触帧）
maxSlide = max slide(f)
```

---

## 7. 数据契约

新增文件 `apps/editor/src/services/binding/motion-match.ts`：

```ts
/** 参与匹配的骨架描述（源 / 目标各一份） */
export interface MatchRig {
  /** rest 世界关节位置（HumanIK 骨名索引） */
  positions: JointPositions;
  /** 每根骨的 rest 长度（骨 i = parent(i) → i） */
  lengths: Record<string, number>;
}

export interface IkChainDef {
  /** IK 链的末端（effector） */
  effector: string;
  /** 链根（旋转被 IK 修改的第一根骨） */
  root: string;
  /** 中间关节（膝 / 肘） */
  mid: string;
  /** 接触检测点（通常比 effector 更末端） */
  contact: string;
}

export interface MatchOptions {
  /** 地面高度（世界 Y），默认 0 */
  groundY?: number;
  /** IK 链定义；默认双腿 */
  chains?: IkChainDef[];
  /** 接触高度阈值 = heightEps × 源腿长，默认 0.05 */
  contactHeightEps?: number;
  /** 接触速度阈值 = speedEps × 源腿长/秒，默认 0.20 */
  contactSpeedEps?: number;
  /** 一段接触至少持续多少帧，默认 3 */
  minContactFrames?: number;
  /** 接触结束后多少帧内平滑释放，默认 4 */
  lockBlendFrames?: number;
  /** 是否做 swing–twist 分解保留扭转，默认 true */
  preserveTwist?: boolean;
  /** 是否允许根回退（防过伸），默认 true */
  rootCorrection?: boolean;
}

export interface MatchReport {
  /** 每条链的长度比 */
  chainScales: Record<string, number>;
  /** 检测出的接触段 */
  contacts: Array<{ chain: string; start: number; end: number; world: [number, number, number] }>;
  /** 接触期内脚的最大水平滑移（米） */
  maxFootSlide: number;
  /** IK 夹紧的最大不可达量（米）；> 0 说明腿被拉直过 */
  maxStretch: number;
  /** 根回退的总位移（米） */
  rootCorrectionTotal: number;
  warnings: string[];
}

/** 主入口：L0 的输出 → 位置守恒的动画。不修改入参。 */
export function matchMotion(
  clip: RetargetClip,
  srcRig: MatchRig,
  tgtRig: MatchRig,
  options?: MatchOptions,
): { clip: RetargetClip; report: MatchReport };
```

**设计约束**：

- `matchMotion` 是**可选后处理**，L0 的契约与全部既有断言不受影响（T6）。
- 入参不可变 —— 返回新的 `RetargetClip`，便于 A/B 对比与回滚。
- 纯 CPU、无 GPU、无 DOM，可在 vitest 里直跑。

---

## 8. 性能

**motion match 是离线烘焙，运行时零成本。**

- 输入是 `RetargetClip`（BVH 级数据），输出仍是 `RetargetClip`，最终经
  `clipToAnimClip` → `rigToTPose` 烘进 GLB 的 `animations[]`。
- 500 僵尸在运行时只是播放同一个 `AnimClip` + GPU instancing，
  **与是否跑过 motion match 无关**。
- 烘焙成本：O(帧数 × 链数 × 链长)，60 帧 × 2 链 × 3 骨 ≈ 千次浮点运算，毫秒级。

> 别把它放进每帧运行时 —— 那是把离线工具当 runtime IK 用的典型错误。

---

## 9. 风险与未决项

| # | 风险 | 处置 |
|---|---|---|
| R1 | 源 BVH **无根位移**（in-place 动画）：脚锁定无意义 | 检测 `clip.translation === null` → 自动跳过 L3，只做 L1+L2，进 `warnings` |
| R2 | 根回退 ↔ IK 的循环依赖 | 单次迭代；残差进 `report.rootCorrectionTotal`，不追求收敛 |
| R3 | 脚 twist 与 IK 冲突（外八被掰正） | `preserveTwist` 默认开（§4.3），T5 守住 |
| R4 | 源骨架缺 `ToeBase`（部分 Mixamo 导出没有） | 回退用 `Foot` 兼作检测点，进 `warnings` |
| R5 | 极端比例差（僵尸 vs 儿童）导致 IK 大面积夹紧 | `report.maxStretch` 报出来，编辑器面板标黄，不静默 |
| R6 | **未决**：L4 的 Hips 整体高度对齐用「最低点贴地」还是「平均高度对齐」 | 待 MVP 跑通后看画面再定，MVP 先只做地面 clamp |

---

## 10. 落地计划

| 步骤 | 文件 | 说明 |
|---|---|---|
| 1 | `binding-math.ts` | 补 `quatFromMat` / `slerp` / `swingTwist` / `forwardKinematics` |
| 2 | `retarget.ts` | 导出 `buildMatchRig(bvh | SkeletonData): MatchRig`，产 source / target 两份 rig |
| 3 | **`motion-match.ts`（新）** | L1 + L2 + L3，约 600 行 |
| 4 | **`motion-match.test.ts`（新）** | T1–T9 |
| 5 | `binding-export.ts` | 导出链路串上 `matchMotion`（开关控制） |
| 6 | 门禁 | `typecheck` · `npm test` · `editor:build` |

**不在本轮范围**：L4（地面 clamp + Hips 对齐）、编辑器面板控件、手臂 IK。

---

## 附：与 HumanIK / MotionBuilder 的术语对照

| 本项目 | MotionBuilder / HumanIK | 说明 |
|---|---|---|
| L0 FK 骨向对齐 | Characterization + Retarget | 消除 rest 姿态差（A-pose vs T-pose） |
| L1 比例归一化 | Actor Scale / Body Part Size | 逐段比例，非全局缩放 |
| L2 两骨 IK | IK Solver (2-bone) | 解析解，非迭代 |
| L3 脚锁定 | Foot Contact / Floor Contact | 冻结 effector 世界位置 |
| 根回退 | Hips Translation Mode | 身体跟着脚走，而不是脚跟着身体滑 |
| FK 区 / IK 区 | IK/FK Blend | 中轴 FK 保节奏，四肢 IK 保接触 |
