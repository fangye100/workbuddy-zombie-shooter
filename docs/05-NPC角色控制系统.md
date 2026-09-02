# NPC / 角色控制系统（AI · 动画 · 寻路 · 战斗）

> 本文是 L5 层的核心 gameplay 设计。它是 `04-子系统.md` 中 `animation / physics / script` 的**上层消费者**，
> 本身也是一个 Plugin：`AetherCharacterPlugin`。
>
> 设计标尺取自当前项目语境——**末日尸潮**：第三人称顶视角、肉鸽、手机横屏、**同屏数百个近战敌人**。
> 这个量级决定了下面很多取舍和"标准单机 RPG"完全不同。

---

## 0. 约束先写在前头

| 约束 | 数值 | 后果 |
|---|---|---|
| 同屏 NPC 峰值 | 300–800（目标 500 @ 60fps 中端机） | 每个 NPC 每帧预算 **< 3.5 µs**；禁止 per-NPC 对象分配 |
| 敌人类型 | 8–12 种原型 × 3–5 个视觉变体 | 强池化；同类共享骨骼拓扑、动画集、材质 |
| 战斗形态 | 近战冲脸 + 远程少量 | 寻路目标高度收敛（几乎都是玩家）→ **流场是必然选择** |
| 平台 | 手机横屏 | AI 跑在 Worker 也不现实（线程少），必须主线程分帧摊平 |
| 肉鸽 | 词条可组合修改行为 | 行为参数必须**数据驱动 + 运行时可叠加**，不能硬编码 |

**一句话结论**：这套系统真正的难点不在"让一个 NPC 聪明"，而在**让 800 个 NPC 不聪明但看起来像活的，且不卡**。

---

## 1. 四层解耦：Avatar / Agent / Locomotion / Combat

这是整个设计的地基。**最关键的一条：决策层永远不直接碰动画和 Transform。**

```
┌─────────────────────────────────────────────────────────────┐
│  Blackboard（每 NPC 的 SoA 状态 + 共享世界知识）              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Agent（决策）        ── 产出 Intent（意图）                   │
│   "我想冲向玩家 / 我想攻击 / 我想后退"                          │
│                    │                                          │
│                    ▼                                          │
│  Locomotion（执行）  ── Intent → 速度与朝向（唯一写 Transform 的地方）│
│   流场取向量 → 避让混合 → 转向限速 → 输出 desiredVelocity       │
│                    │                                          │
│                    ▼                                          │
│  Avatar（表现）      ── 只读 Locomotion 状态 → 决定播什么动画     │
│   速度/朝向/加速度 → AnimGraph → Pose → compute skinning       │
│                                                              │
│  Combat（战斗）      ── 与上面三者并行，通过 AnimNotify 与 Avatar 对齐│
│   帧数据 → 命中窗口 → SweepShape → DamageEvent                │
└─────────────────────────────────────────────────────────────┘
```

### 为什么必须这么切

- **可替换**：Avatar 层从"骨骼动画"换成 "VAT 顶点动画纹理" 时，Agent/Combat 一行不用改。这是做 LOD 的前提。
- **可降频**：决策 5Hz、寻路 10Hz、避让 30Hz、动画 60Hz、命中判定 60Hz（跟随固定步长）。不同频率天然分层。
- **可回放**：Intent 是纯数据，录下来就能复现整场战斗，调试僵尸"卡墙角"时价值极高。
- **网络友好**：同步 Intent 而非 Transform，带宽差一个数量级。

### Intent 结构（纯数据，零分配）

```ts
/** 每 NPC 一帧的决策输出。全部为标量，便于 SoA 存储 */
struct Intent {
  moveDirX: f32; moveDirZ: f32;   // 期望移动方向（已含寻路结果，归一化）
  speedScale: f32;                // 0..1.5，疾跑/迟缓词条直接乘这里
  faceTargetX: f32; faceTargetZ: f32;
  stance: u8;                     // Stand / Crouch / Crawl / Lunging
  action: u16;                    // 要播放的动作 id（0 = 无）
  actionSlot: u8;                 // FullBody / UpperBody / Additive
  priority: u8;                   // 打断优先级
  flags: u8;                      // 位标记：可转向 / 可被打断 / 无敌 ...
}
```

---

## 2. 角色加载与装配

### 2.1 CharacterDef：数据驱动的原型

一个"角色"不是资源，是**一份装配清单**。源文件用 YAML（可读、可 diff、策划可改），
运行时烘焙成二进制 `.char`。

```yaml
# data/characters/zombie_walker.char.yaml
id: zombie_walker
skeleton: skel/humanoid_basic.skel          # 所有 humanoid 僵尸共用一副骨骼
bodyParts:                                   # 部位化换装（含断肢）
  - slot: head    mesh: mesh/zombie_head_a   mat: mat/flesh_a
  - slot: torso   mesh: mesh/zombie_torso_a  mat: mat/cloth_raided
  - slot: arm_l   mesh: mesh/zombie_arm_a
  - slot: arm_r   mesh: mesh/zombie_arm_a
  - slot: legs    mesh: mesh/zombie_legs_a
animSet: anim/zombie_walker.animset          # 走/跑/待机/攻击/受击/死亡
animGraph: graph/zombie_basic.animgraph
physics:
  shape: capsule(r=0.35, h=1.8)
  mass: 70
  navAgentRadius: 0.4
ai:
  archetype: horde_melee
  params: { aggression: 0.8, attackRange: 1.9, speed: 3.2, turnRate: 6.0 }
  senses: { sightRange: 24, fovDeg: 200, hearingRange: 12 }
combat:
  attacks: [atk_zombie_swipe, atk_zombie_lunge]
  hurtboxes: [ { bone: spine, r: 0.4 }, { bone: head, r: 0.22, mult: 2.5 } ]
pooling: { prewarm: 96, max: 320 }           # 预热数量，避免开局卡顿
```

### 2.2 装配流水线（分帧、有预算、有优先级）

```
request(defId, count)
   │
   ├─ ① 骨架去重：同 skeleton 只加载一次（引用计数）      ← 500 只僵尸 = 1 份骨骼
   ├─ ② 部位网格合并：同一 skeleton + 同一材质 → 合批为一个 mesh
   │     （烘焙期离线完成，运行期只剩 1 个 meshlet 集合）
   ├─ ③ 动画集共享：animSet 按 defId 共享，实例只持有采样游标
   ├─ ④ 材质变体：走 PerDraw dynamic offset（见 02 文档 @group(4)）
   │     换色/换贴图不产生新 pipeline，只改 uniform 槽位
   ├─ ⑤ 池化：命中 Pool 直接复用实体，跳过 ①–④
   └─ ⑥ 分帧预算：每帧最多装配 N=8 个，超出的排队
```

**每帧预算（FrameBudget）**：所有异步加载资源（角色、VFX、音效）共用一个预算池，
按 `优先级 = 距相机距离倒数 × 类型权重` 排序。尸潮涌来时，远处的僵尸**先给池子里的空壳**
（一个占位胶囊 + 简化材质），近了才装配真身——玩家永远看不到装配过程。

### 2.3 三级表现 LOD（这是尸潮能跑 500 只的关键）

| LOD | 距离 | 表现 | 成本 |
|---|---|---|---|
| **L0 Full** | < 15m | 骨骼动画 + compute skinning + IK（脚部吸附）+ 面部 morph | ~80 只上限 |
| **L1 VAT** | 15–45m | **顶点动画纹理**：动画烘焙进纹理，instanced 渲染，一次 draw call 画 200 只 | 极低 |
| **L2 Proxy** | > 45m / 屏外 | 公告板 or 不上屏（只保留逻辑） | 近乎为 0 |

**VAT（Vertex Animation Texture）是我强烈建议优先做的一块。**
做法：烘焙期把 `骨骼矩阵序列` 或 `顶点位移序列` 写进 RGBA32Float 纹理（宽 = 骨骼数×4，高 = 帧数），
运行时顶点着色器按 `frameIndex` 采样两行并插值。

> **LOD 切换要有 cross-fade dither**，且**动画时间必须连续**——从 L1 切回 L0 时，
> 用当前 VAT 的 `frameIndex` 反算 AnimGraph 的时间轴，否则会看到"抽搐一下"。这个细节
> 大多数引擎都会漏。

### 2.4 相位随机化

**同批僵尸绝对不能同步。** 每个实例持有 `animPhaseOffset ∈ [0,1)`，在 AnimGraph 采样时
加到归一化时间上。同时对步频、转身速度、待机微动作加 ±8% 的确定性抖动（由 entity index 做 seed）。
这一条对"看起来像活的"贡献，比任何复杂 AI 都大。

---

## 3. 动画层：与逻辑解耦

### 3.1 规则

1. **Agent 只说"我要做什么"，不说"播哪个动画"。** 由 AnimGraph 把 Intent 翻译成状态。
2. **动画不驱动位移，位移驱动动画。** 尸潮场景禁用 root motion——因为 root motion 会和
   群体避让、流场速度打架，产生"动画往前走、人被挤回来"的滑步。用 **In-Place 动画 + 程序化推进**。
   （Boss 的突进、处决演出这类**单次演出**才允许 root motion，走 `Montage`。）
3. **位移与步频绑定**：`playbackRate = actualSpeed / clipReferenceSpeed`，
   被挤慢时动画自动变慢，杜绝滑步。再做 **distance matching**（起停时对齐脚步落点）会更进一步。

### 3.2 AnimGraph 结构

```
Layer 0 (Base, full body)
   LocomotionStateMachine
     Idle ⇄ Move ⇄ Turn / Start / Stop
   ↕ 过渡条件直接读 Locomotion 的 speed / accel / turnRate
Layer 1 (Override, upper body)   —— 攻击、投掷、格挡
Layer 2 (Additive)               —— 呼吸、受击抖动、疲惫
Layer 3 (IK)                     —— 脚步吸附（L0 专有）、LookAt（限幅 60°）
```

**Montage（一次性动作）**：攻击、受击、死亡。带 `slot`、`blendIn/Out`、` AnimNotify 时间轴`。
打断规则写在 Montage 上（`interruptibleAfter: 0.35`），而不是写在代码里。

### 3.3 AnimNotify：动画与战斗的唯一契约

```ts
// 动画时间轴上的事件点（烘焙进 .anim，运行时二分查找，零分配）
type AnimNotify =
  | { t: number; kind: 'HitWindowOpen';  hitboxId: number }
  | { t: number; kind: 'HitWindowClose'; hitboxId: number }
  | { t: number; kind: 'CancelWindow';   into: number[] }   // 可取消进入的下一招
  | { t: number; kind: 'Vfx';   id: AssetId; socket: number }
  | { t: number; kind: 'Sfx';   id: AssetId }
  | { t: number; kind: 'FootStep'; foot: 0 | 1 }
  | { t: number; kind: 'MeleeTrail';  mesh: AssetId }        // 拖尾
```

**命中窗口由动画时间轴定义，而不是由代码计时器定义。** 策划调整动画长度时判定自动跟随，
不会出现"动画改了判定没改"的经典错位。

> ⚠️ 用**固定步长**推进 Montage 时间，一帧内可能跨过多个 Notify（低帧率时）。
> Notify 消费必须按时间排序逐个触发，不能只取最后一个。

---

## 4. 感知与决策

### 4.1 Perception（感知）

感知不是每个 NPC 各自算一遍——**500 次视锥测试就是 500 次浪费**。

```
PerceptionSystem（10Hz，分帧）
   │
   ├─ 空间哈希：按格子登记所有"可被感知"的实体（玩家/尸体/噪声源）
   ├─ 只让玩家与噪声源做主动广播：
   │    对每个 NPC 只需查自己所在格子 + 邻格 → O(N) 而非 O(N×M)
   ├─ 视锥：dot 测试 + 距离，最贵的一步放最后（early-out 顺序：距离 → 角度 → 射线）
   ├─ 射线（遮挡）：走物理 Raycast 的批量 Job，且**共享**——
   │    同一目标的多条射线合并，按距离排序后只保留最近 8 条
   └─ 结果写入 Blackboard：targetId / lastKnownPos / alertLevel / lastSeenTime
```

| 感官 | 实现 | 备注 |
|---|---|---|
| 视觉 | 距离 + FOV + 遮挡射线 | FOV 200°（僵尸靠 peripheral 察觉），射线下采样到 10Hz |
| 听觉 | 噪声事件（枪声/尖叫/玻璃）→ 半径传播 → 写入"可疑位置" | 枪声半径 25m，且**触发群体唤醒** |
| 伤害 | `DamageEvent` 直接写入感知，无条件获得攻击者位置 | 被打了必须知道谁打的 |
| **传染（关键）** | 处于 Aggro 状态的 NPC，每隔 0.5s 向半径 6m 内同伴广播一次 | 尸潮涌来的"连锁反应"全靠它，成本极低 |

`alertLevel ∈ [0,1]`：0 = 游荡，0.5 = 怀疑（走向可疑位置），1 = 锁定。
**衰减而非布尔切换**——玩家躲进箱子后僵尸应该在原地徘徊一会儿再散开，而不是瞬间失忆。

### 4.2 决策：不要上 GOAP

| 方案 | 评价 |
|---|---|
| FSM | 够用但状态爆炸，加词条时难维护 |
| 行为树（BT） | **执行结构清晰**，但选择"做什么"不擅长，且 500 个实例 tick BT 的开销不低 |
| GOAP / HTN | ❌ 成本高、调试难。尸潮不需要"规划"，只需要"冲上去" |
| Utility AI | **擅长"在当前情境选最合适的事"**，词条组合天然适配（每个 Consideration 就是一个词条可乘的权重） |

**采用：Utility 选意图 + HFSM 执行。**

```
UtilitySelector（5Hz，分帧）
  对每个"候选行为"算 score = Σ(consideration_i 的归一化响应) × weight_i
    候选：Chase / Attack / Reposition(绕后) / Flee / Stagger / Idle / Investigate
  考虑项（consideration）：
    距离目标 / 自身 HP / 是否在攻击冷却 / 同伴数量 / 是否在玩家视线内 / 疲劳度
  取最高分 → 写入 Intent.action，交给 HFSM 展开成具体步骤
  + 迟滞（hysteresis）：新行为需超过当前行为 score × 1.15 才切换，防抖
  + 提交冷却：每个 NPC 有 minDwellTime（0.3–0.8s），防止每帧反复横跳
```

**分帧摊平**：把 NPC 按 entity index 分桶（如 8 桶），每帧只 tick 一桶 → 决策实际频率
降到 60/8 = 7.5Hz，但 CPU 曲线是平的，不会有"某一帧全算"的尖峰。
**距离越近 tick 越频繁**（近处 15Hz，远处 2.5Hz），因为近处的表现才重要。

### 4.3 Blackboard

双层的：
- **个体黑板**（SoA 列存）：`target / alertLevel / lastKnownPos / pathIdx / attackToken / nextThinkTick`
- **群体黑板**（全局单例，所有 NPC 共享只读）：`playerPos / threatMap / flowFieldHandle / 
  globalAggroCount / attackTokenPool`

**群体知识共享是这个量级下最重要的优化。** 500 只僵尸各自找玩家 = 浪费；
一次算好流场，全体查表即可。

---

## 5. 寻路

### 5.1 三层架构

```
① 全局层：Flow Field（流场）      —— 目标收敛时（大家都要去玩家那）
② 中距层：NavMesh + A* / Theta*   —— 单个目标不共享时（绕后、逃跑、巡逻）
③ 局部层：Steering + 群体避让     —— 每帧，解决"撞在一起"
```

### 5.2 尸潮的主路径：流场（Flow Field）

**理由**：500 个敌人目标同一个点，用 A* 就是 500 次搜索。流场**一次计算，全体共享**，
摊薄后单个 NPC 的寻路成本 ≈ 一次双线性纹理采样。

```
FlowField（分辨率 0.5m/格，覆盖 128×128 = 16384 格）
  costField      : u8    静态代价（墙=255，泥地=3，平地=1）
  integrationField: u16  到目标的距离势（BFS/Dijkstra 波前扩散）
  flowField      : i8×2  每格的归一化方向（对势场取梯度）
  + 可选：多目标流场（玩家 / 次要目标 / 撤退点），按 NPC 类型选层
```

**生成策略**：
- **分块 + 时间切片**：把格子切成 16×16 的 chunk，每帧重算 K=4 个 chunk。
  玩家周围与"脏块"（障碍变动处）优先，其他块按上次更新时间老化。
- **算法**：`Dijkstra with bucket queue`（代价是小整数，桶排序 O(1)），比堆快 3–5 倍。
- **目标移动时**：不必整场重算。玩家移动 1 格内不动；超过阈值只把"势变区域"标记脏
  （用上一帧势场做增量 Dijkstra，实测能省 70%+）。
- **线程**：放 Worker（`SharedArrayBuffer` 读写场数据），主线程零阻塞。
  无 SAB 时降级为主线程切片（每帧 2ms 预算硬上限）。

**遇到凹形陷阱怎么办**——先纠正一个常见误解：
Dijkstra 生成的是**真实距离场**，除目标外不存在局部极小，所以"势场局部极小导致卡死"
这个说法本身是错的（早期草稿也写错过，被实测打脸）。U 形凹槽里挤成一团的真实原因有两个：

1. **路径贴墙**。最短路径会紧贴墙角，一群 NPC 沿同一条贴墙路径挤过去必然互相卡住。
   解法是 **clearance-aware cost**：烘焙期算一次 chamfer 距离变换得到每格的"离墙距离"，
   把离墙 2 格以内的格子代价抬高，最短路自然改走走廊中线。这比任何运行时绕障都便宜。
2. **拥堵僵持**。入口太窄，分离力把 NPC 往墙上推。
   解法是 stuck 检测（见 §5.4）：实际速度持续低于期望速度 30% 超过 0.4s → 转 Stagger。

### 5.3 中距层：NavMesh（给需要独立路径的 NPC）

- 格式：凸多边形（poly soup）+ 邻接边 + `A* on poly`，路径再 `string pulling`（拉绳）平滑。
- 请求走 **路径请求队列**，每帧限额（如 16 条），带 LIFO 优先（最新请求优先，旧的通常已过时）。
- 结果缓存：同一 `goalCell + 起点区域` 命中缓存直接复用。
- **异步**：Worker 中算，返回时 NPC 可能已死 → 句柄 + generation 校验，失效就丢弃。

### 5.4 局部层：群体避让（最影响"观感"的一层）

完整 ORCA/RVO 在 500 实体下太贵。用**分层混合**：

```
desiredVel = flowDir × speed × speedScale
           + separationForce        // 邻居排斥，只取最近 6 个邻居
           + wallPush               // cost 场 4 抽样梯度，推离高代价（近墙）格
           + dodgeBias × jitter     // 固定的微小侧向偏置，破对称
                │
                ▼
steering → 转向限速（turnRate）→ 加速度限速 → desiredVelocity
                │
                ▼
CharacterController.move()  ← 唯一写物理的地方
```

- **邻居查询**：空间哈希（cell = 2×agentRadius），每帧增量更新。500 个实体的邻居查询 < 0.3ms。
- **破对称（critical）**：两只僵尸正面相遇会互相僵住。给每个 NPC 一个固定的
  `dodgeBias ∈ {-1, +1}`（由 index 奇偶决定），让它们**总是往同一侧错身**。
- **堆积**：判定标准是 **0.4s 窗口内的净位移 < 期望位移的 30%**，触发 `Stagger` 分支——
  播放推挤动画并短暂降低碰撞半径，避免"人墙"僵死。
  ⚠️ **不要用"当前速度大小"来判僵持** —— 被墙推力推得来回震荡的 NPC 瞬时速度可以接近满速，
  但位移几乎为零。实测过，速度判据会完全漏掉这种情况。
- **不追求不重叠**：轻度穿插在尸潮里是可以接受的，甚至更有压迫感。**用分离力而非硬碰撞**，
  让它们像流体一样挤过来，比"完美避让"更像尸潮。
- **墙避用代价场梯度，不用射线**：正前/左前/右前 3 条射线在 500 实体下是 1500 次物理查询；
  改成对 `cost` 场做 4 次采样求梯度，零物理开销，配合 clearance-aware cost 效果反而更稳。

### 5.5 动画与寻路的闭环

- 拐角处要减速：读流场方向的**角速度**（`dot(dir_t, dir_{t-1})`），大角度变化时降 `speedScale`
  并触发 `Turn` 动画（转向 > 90° 走 turn-in-place，否则走倾斜弧线步）。
- 上下台阶：NavMesh/流场采样地形高度，高度差 > 0.3m 触发 `StepUp` 或 `Climb` 分支。

---

## 6. 攻击设计

### 6.1 AttackDef：帧数据驱动

```yaml
id: atk_zombie_swipe
anim: anim/zombie/swipe
slot: UpperBody
interruptibleAfter: 0.35        # 归一化时间：之后可被更高优先级动作打断
cancelWindow: { from: 0.55, into: [atk_zombie_swipe_b, atk_zombie_lunge] }
rootMotion: false               # 尸潮一律 false
phases:
  telegraph: { from: 0.00, to: 0.22 }   # 预警：抬手，玩家可读
  active:    { from: 0.22, to: 0.42 }   # 判定窗口（由 AnimNotify 开合，此处仅可视化用）
  recovery:  { from: 0.42, to: 1.00 }   # 硬直：玩家的惩罚窗口
hitboxes:
  - { bone: hand_r, shape: sphere(r=0.28), maxTargets: 1, hitOnce: true }
  - { bone: forearm_r, shape: capsule(r=0.18, h=0.4), maxTargets: 2 }
damage: { base: 12, type: physical, poise: 20 }
onHit: { vfx: vfx/blood_burst, sfx: sfx/flesh_hit, hitstopMs: 45 }
cooldown: 1.1
```

**三段式是硬要求**：`Telegraph → Active → Recovery`。没有 Telegraph 的攻击在顶视角游戏里
就是"不讲理的伤害"；没有 Recovery 的攻击玩家无法惩罚，战斗失去节奏。
僵尸的 telegraph 要**夸张**（0.2–0.35s 的明显抬手），这是可读性的来源。

### 6.2 命中判定：扫掠，不是单帧重叠

单帧 overlap 在 60fps 下会漏判快速挥击（手在两帧之间扫过玩家，两帧都没碰到）。

```
HitWindowOpen (t=0.22)
   │
   └─ 每个固定步长：
        1. 取 hitbox 骨骼的 prevWorldPos 与 currWorldPos
        2. 构造扫掠形状：sphere 沿线段扫 → capsule；capsule 扫 → 用 shapecast
        3. 物理 ShapeCast，收集命中
        4. hitOnce 的去重集合（Set<EntityId>，窗口关闭时清空）
        5. 命中 → 发 DamageEvent
HitWindowClose (t=0.42) → 清空去重集合
```

- **判定频率跟随固定步长（60Hz）**，不跟随渲染帧——否则高刷屏和低帧设备的判定密度不同。
- hitbox 数量极少（1–2 个/招式），窗口很短（~0.2s），所以每个固定步长内的活跃判定量
  大约是 `同屏攻击中 NPC 数 × 2`。这个数字必须被**攻击名额**控制住（见 6.4）。
- 优化：先用**粗筛**（以扫掠段的 AABB 查询空间哈希），再精确 shapecast。

### 6.3 伤害管线

```
DamageEvent { instigator, target, amount, type, direction, hitBone, poise }
   │
   ├─ Modifier 链（肉鸽词条在这里叠加）
   │    易伤 ×1.5 / 护甲 -N / 暴击 ×2 / 部位倍率（头部 ×2.5）/ 元素克制
   │    → 有序、可追溯，调试面板能打印完整链路
   │
   ├─ Poise / 韧性：累积 ≥ 阈值 → 进入 Stagger（打断当前动作）
   │
   ├─ 应用 → Health → 死亡 → DeathEvent
   │
   └─ 反馈（Feedback）
        · HitStop：全局或局部 30–80ms 的时间缩放（别全局停，只停双方）
        · HitReact：按 (direction, hitBone, damage) 选 Additive 动画 Layer
        · VFX / SFX / 屏幕震动（按伤害量衰减，避免 500 次命中震屏）
        · 伤害数字（世界空间 UI，对象池 + 合并相近数字）
```

**HitStop 不要全局。** 尸潮里每帧都有几十次命中，全局 hitstop 会让游戏变成 PPT。
只对攻击者 + 被攻击者做**局部时间缩放**（各自的 `timeScale`），或者干脆只在高伤害/
处决时用全局。

### 6.4 攻击名额（Attack Token）——群战手感的核心

**没有这个，玩家会被瞬间秒杀，而且完全无法理解发生了什么。**

```
AttackTokenPool（群体黑板中的全局单例）
  · 同时允许攻击的 NPC 数 = clamp(2 + floor(playerSkill), 2, 6)
  · NPC 进入攻击范围 → 请求 token
     有名额：立即开始 telegraph
     无名额：进入 "Circle" 状态——在玩家周围 2.5–4m 环形游走、伺机、咆哮
  · token 在 recovery 结束时归还（不是命中时）
  · 精英/Boss 有 reserved token，永远能打
```

**同时引入"包围圈配额"**：玩家周围按角度分 12 个扇区，每扇区最多站 3 个敌人。
超出的去相邻扇区排队。这样玩家永远有"缺口"可以冲出去——
**这是让尸潮"有压迫感但不憋屈"的关键设计**。

### 6.5 连招与取消

连招不是硬编码序列，是**有向图**：

```
           ┌──────── cancelWindow ────────┐
           ▼                              │
  swipe_A ──cancelWindow──▶ swipe_B ──▶ lunge
     │                          │
     └──── recovery 结束 ───────┴──▶ Idle
```

取消窗口由 AnimNotify 定义（见 3.3）。玩家侧同理：攻击后摇可被闪避取消，
闪避后摇可被攻击取消——**取消是动作游戏手感的全部**，必须在 AnimNotify 层就有表达。

---

## 7. 主循环挂载点

| 系统 | Stage | 频率 | 说明 |
|---|---|---|---|
| `PerceptionSystem` | FixedUpdate | 10Hz 分帧 | 空间哈希 + 视锥 + 射线批处理 |
| `AggroPropagationSystem` | FixedUpdate | 2Hz | 群体传染广播 |
| `UtilityDecisionSystem` | FixedUpdate | 5–15Hz 分帧 | 选 Intent.action，写入黑板 |
| `FlowFieldUpdateSystem` | Update | 切片（2ms/帧） | Worker 中算，主线程同步结果 |
| `PathRequestSystem` | Update | 限额 16/帧 | NavMesh A* 请求与回填 |
| `SteeringSystem` | FixedUpdate | 60Hz | 流场采样 + 避让 → desiredVelocity |
| `CharacterMoveSystem` | FixedUpdate | 60Hz | 唯一调用 CharacterController |
| `AnimGraphSystem` | FixedUpdate | 60Hz（L0）/ 30Hz（L1） | Intent → Pose |
| `MontageSystem` | FixedUpdate | 60Hz | 推进时间轴、触发 AnimNotify |
| `HitboxSystem` | FixedUpdate | 60Hz | 扫掠判定 |
| `DamageSystem` | FixedUpdate | 60Hz | Modifier 链 + 反馈 |
| `AttackTokenSystem` | FixedUpdate | 30Hz | 名额分配与回收 |
| `CharacterSpawnSystem` | Update | 预算 8/帧 | 池化复用 + 分帧装配 |
| `ExtractCharacter` | Extract | 60Hz | Pose → RenderWorld（零拷贝视图） |

**顺序约束**：`Steering → CharacterMove → Hitbox`（先定位置再判命中，
否则 hitbox 用的是上一帧的骨骼位置，快速挥击会偏）。

---

## 8. SoA 数据布局

所有 per-NPC 状态用列式 `TypedArray`，按 archetype 分表：

```ts
// 单个 archetype 内 500 个实例 → 连续内存，cache 友好，可整段拷贝做快照
class CharacterTable {
  capacity: number;
  // --- Locomotion ---
  posX!: Float32Array; posY!: Float32Array; posZ!: Float32Array;
  velX!: Float32Array; velZ!: Float32Array;
  yaw!: Float32Array;
  desiredVelX!: Float32Array; desiredVelZ!: Float32Array;
  // --- Agent ---
  targetEntity!: Uint32Array;
  alertLevel!: Float32Array;
  nextThinkTick!: Uint32Array;
  behaviorId!: Uint16Array;
  attackToken!: Uint8Array;      // 0 = 无
  // --- Avatar ---
  animState!: Uint16Array;
  animTime!: Float32Array;
  animPhaseOffset!: Float32Array;
  montageId!: Uint16Array;
  montageTime!: Float32Array;
  lodTier!: Uint8Array;
  // --- Combat ---
  health!: Float32Array;
  poise!: Float32Array;
  cooldownUntil!: Float32Array;
  hitOnceSet!: Set<number>[];    // 不在热路径，窗口关闭时清空
}
```

> `hitOnceSet` 是唯一的引用类型列。若 500 个 NPC 全都建 Set 会有 GC 压力，
> 实际用**全局去重池**：一个 `Uint32Array` 环形缓冲存 (attacker, victim) 对，
> 按窗口 id 分区，窗口关闭时只推进写指针。

---

## 9. 性能预算（中端手机，16.6ms/帧）

| 项 | 预算 | 备注 |
|---|---|---|
| 感知（10Hz 分帧） | 0.6 ms | 射线只保留最近 8 条 |
| 决策（分桶） | 0.5 ms | 500 × ~1µs |
| 流场（Worker） | ~0（主线程） | 主线程只做同步 |
| 群体避让 | 1.2 ms | 空间哈希 + 6 邻居 |
| 角色移动（物理） | 1.5 ms | CharacterController，500 个动态体 |
| AnimGraph + 采样 | 1.2 ms | 仅 L0（~80 只）走完整图 |
| Montage + Notify | 0.3 ms | |
| 命中判定 | 0.4 ms | 攻击名额限制下活跃判定 < 12 |
| 表现（VAT/instancing） | GPU 侧 | 200+ 只一次 draw call |
| **合计 CPU** | **~5.7 ms** | 留给渲染 ~8ms |

> 已实测的部分（`packages/ai/test/navigation.smoke.ts`，Node 单线程、48×48 流场、300 agent）：
> 群体避让 **0.42 ms/帧**（预算 1.2ms），速度钳制正确、无 NaN；
> 流场整场重算在 4096 格/帧预算下 1–2 帧收敛；
> 开启 clearance-aware cost 后，同一条路径的**贴墙格数从 114 降到 5，步数不变**。

---

## 10. 与其它系统的接口

| 依赖 | 用法 |
|---|---|
| `physics` | `CharacterController.move()`、`ShapeCast`（命中）、`Raycast`（视线/墙避） |
| `animation` | Pose 采样、Montage、IK；引擎只提供能力，**播什么由 Avatar 层决定** |
| `assets` | `CharacterDef` / `animSet` / VAT 纹理；`Handle<T>` + 引用计数 |
| `scene` | Transform 层级、socket 挂点（武器/特效）、SubScene 流式加载 |
| `vfx` / `audio` | AnimNotify 触发；受全局预算与屏外剔除约束 |
| `net` | 同步的是 **Intent + 关键事件**，不是 Transform（状态同步或回滚均可） |
| `profiler` | `stats()` 暴露：活跃 NPC、LOD 分布、流场重算块数、决策 tick 数、命中判定数 |

---

## 11. 落地顺序（对应主路线图）

| 阶段 | 内容 |
|---|---|
| **C1** | CharacterDef + 装配 + 池化 + 单个 NPC 的 Steering/CharacterController |
| **C2** | AnimGraph + Locomotion 状态机 + In-Place + 位移驱动动画 + 相位随机 |
| **C3** | Perception + Utility 决策 + HFSM 执行 + 分帧分桶 |
| **C4** | Flow Field（Worker + 分块增量） + 群体避让 + 破对称 |
| **C5** | Montage + AnimNotify + 扫掠命中 + 伤害管线 + HitStop/HitReact |
| **C6** | Attack Token + 包围圈配额（**手感调优的主要战场**） |
| **C7** | VAT LOD + instancing + cross-fade → 冲到 500 只 |
| **C8** | 编辑器：AnimGraph 可视化、Utility 曲线调试、流场可视化 overlay |

---

## 12. 几个容易踩的坑（清单）

1. **动画同步** → 相位随机化（§2.4）
2. **两只 NPC 正面僵住** → 破对称 `dodgeBias`（§5.4）
3. **root motion 与避让打架** → 群体单位一律禁用 root motion（§3.1）
4. **高刷屏判定密度不同** → 判定跟随固定步长（§6.2）
5. **LOD 切换抽搐** → 动画时间轴连续 + dither（§2.3）
6. **玩家被瞬秒且无法理解** → Attack Token + 包围圈配额（§6.4）
7. **全局 hitstop 变 PPT** → 局部时间缩放（§6.3）
8. **尸潮在 U 形凹槽挤成一团** → clearance-aware cost（不是"死区标记"）+ stuck 检测（§5.2 / §5.4）
9. **Notify 在低帧率下漏触发** → 按时间排序逐个消费（§3.3）
10. **500 个 Set 的 GC** → 全局去重环形缓冲（§8）
