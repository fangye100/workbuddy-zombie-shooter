# HANDOFF：P4 M2~M4（角色真模型）+ P5 C1~C5（战斗实现）

> 交接时间：2026-10-02 13:50 · 分支 `feat/ui-refine-layout-20260923` · HEAD `26edd92` · 未推送 = 0
> 前序：ADR-018（docs/22）P1/P2/P3/P6/P4b 已完成并过独立审核；P5 设计（docs/23，ADR-019）三轮审核 PASS；P4 M1 已提交。
> 基线：**typecheck 0 · pnpm test 1106 passed（57 文件）**

---

## 0. 开工前必读（按顺序）

1. **`AGENTS.md`**（项目铁律：pnpm-only、场景唯一数据载体、git 纪律、端口）
2. **`docs/20`**（M2~M4 的完整设计：数据布局 §3 / WGSL §4 / 装配 §5）
3. **skill `webgpu-coding-pitfalls`**（WGSL 编码期陷阱：tsc+vite 全绿照样线上炸）
4. **skill `webgpu-headless-validate`**（运行时验证方法）
5. 本文件

## 0.5 环境坑（前一会话实证，照做省 2 小时）

- **vitest 全量必须**：`pnpm exec vitest run --no-file-parallelism` + **脱沙箱**（工具的 dangerouslyDisableSandbox）。多 worker 抢写 ssr 缓存会偶发 EPERM 并**静默掉整个测试文件**——判绿只认 `Test Files 57` 这个计数。
- **Git Bash 常损坏**（dirname/head 找不到）→ 用 PowerShell + 输出重定向到 `.workbuddy/tmp/*.log` 再 Read。
- **PowerShell 捕获中文会不可逆乱码** → 子进程输出让 Python 包装器直接写文件。
- 验证脚本写用户资产：**还原放 finally**。
- 编辑器探针时序：HUD 0.4s 刷新，采样间隔 >700ms。

---

## 0.8 蒙皮能力现状地图（先看这个，别重复建设）

项目里有**四层蒙皮能力，三层已通、一层没通**。M2~M4 做的只是补第四层——
**已有的 rig/动画资产一个都不用重做**：

| 层 | 现状 | 用在哪 |
|---|---|---|
| ① 资产数据层 | ✅ 完整。8 角色 rigged GLB（22 关节 + IBM + 顶点权重 + 6 动画），09-18 验收过 | `assets/characters/models/*/rigged/` |
| ② CPU 求值层 | ✅ 完整。`skin.ts` 的 `evalJointMatrices` | 编辑器单角色预览 |
| ③ 静态通道 GPU 蒙皮 | ✅ 已通。`uploadMesh` 建 skinBuffer/skinVb，`scene.wgsl` binding 7 消费 | **编辑器导入的角色**（能看到动画就是它） |
| ④ 动态通道 GPU 蒙皮 | ❌ **没通——这就是 M2~M4** | gameplay 的 500 只僵尸（instancing 路径） |

**为什么③不能直接拿来跑游戏（不是忘了用，是结构性装不下）**：

1. 静态通道上限 `MAX_OBJECTS=64`（transform uniform 槽位硬限）——500 只进去会把
   关卡本身挤掉（AGENTS.md §2.3「500 僵尸属运行时热实体，不得走静态路径」的由来）
2. 静态通道每帧每物体 CPU 求值——500 只 × ~27 次矩阵乘/帧，mobile 必掉帧

所以 docs/20 的方案是**烘焙姿态调色板**（M1 已完成烘焙侧）：加载时逐帧烘进
storage buffer，运行期 CPU 零重算，每实例只带"播到第几帧"，shader 查表蒙皮。
M2 的本质 = **把只会画胶囊的 instancing 管线（`dynamic.wgsl` + 12 float 实例）
升级成会查调色板蒙皮的管线（16 float + joints/weights + binding 4）**，
然后接上现成的 rigged GLB。

动态通道现状证据：`runtime-bridge.ts:267` `meshId = capsule:r…:h…`，
`renderer-core.ts:191` `DYNAMIC_INSTANCE_FLOATS = 12`。

---

## 1. P4 M2：GPU 蒙皮实例化（一个角色、关动画）

### 🔴 先搞清楚：项目里"已有蒙皮"和"缺蒙皮"是两条不同通道（最易误解点）

| 通道 | 现状 | 用途 |
|---|---|---|
| ① 资产数据层 | ✅ 完整（8 角色 rigged GLB：22 关节 + IBM + 权重 + 6 动画） | `assets/characters/models/*/rigged/` |
| ② CPU 求值层 | ✅ 完整（`skin.ts` 的 `evalJointMatrices`） | 被③④共用 |
| ③ **静态通道** GPU 蒙皮 | ✅ 已通（`uploadMesh` 建 skinBuffer/skinVb，`scene.wgsl` binding 7） | 编辑器导入的单角色预览 |
| ④ **动态通道** GPU 蒙皮 | ❌ **没有 —— M2~M4 就是建这个** | gameplay 的 500 只僵尸（instancing） |

**为什么③不能拿来跑游戏（不是"忘了用"，是结构性装不下）**：
1. 静态通道上限 `MAX_OBJECTS=64`（transform uniform 槽位硬限）——500 只进去会把关卡本身挤掉（AGENTS.md §2.3：500 僵尸属运行时热实体，不得走静态物件路径）
2. 静态通道每帧每物体 CPU 求值——500 只 × ~27 次矩阵乘/帧，mobile 必掉帧

所以 docs/20 用**烘焙姿态调色板**：加载时逐帧烘进 storage buffer（M1 已完成），
运行期 CPU 零重算，每实例只带"播到第几帧"，shader 查表蒙皮。
**既有 rig/动画资产一个都不用重做**——缺的只是动态批量通道的消费端。

### 目标
浏览器 Play 里看到 **1 个真模型**（非胶囊）站在固定 bind pose。

### 改动点（文件都已定位）

| 文件 | 改什么 |
|---|---|
| `packages/render/src/dynamic.wgsl.ts` | 加 `@group(0) @binding(4) var<storage, read> palette`；加 `skinPos()`（docs/20 §4 有现成 WGSL 代码可直接抄）；`vs_main`/`vs_outline` 先 skin 再 place；**smoothNormal 也要过蒙皮** |
| `packages/render/src/renderer-core.ts:191` | `DYNAMIC_INSTANCE_FLOATS = 12 → 16`（布局见 docs/20 §3.1：paletteBase/poseIndex/flags 等 4 float） |
| `renderer-core.ts` 动态批次 | 角色批次额外绑 joints/weights 两个顶点缓冲（location 3/4）；`dynamicMesh` 缓存扩 `{jbuf, wbuf}`，随 `clearDynamicMeshes()` 释放 |
| bind group layout | 加 binding 4（storage read）；**注意 WGSL 陷阱：binding 可见性顺序** |
| 调色板上传 | `device.createBuffer(STORAGE|COPY_DST)` + `writeBuffer(palette.data)`；M1 的 `BakedPalette.data` 直接喂 |
| 装配 | 新建 `apps/editor/src/services/runtime-actors.ts`（docs/20 §5 指定位置，**编辑器侧不进 runtime**）：加载 rigged GLB → `parseGlb` → `bakePosePalette`（M1 已有）→ 注册 mesh+palette 到 core → RuntimeBridge 的 slot 换 meshId/flags |

### M1 已交付（直接用，勿重写）
`packages/render/src/pose-palette.ts`：`bakePosePalette(skeleton, clips, {fps, clipNames})` / `poseIndexAt(palette, clip, phase)` / `bindPoseIndex(palette)`。末尾自带一帧 bind pose。14 条测试在 `packages/render/test/pose-palette.test.ts`。

### 角色 GLB 路径
manifest（`assets/_data/asset-manifest.json`）`characters[].lods[]` 的 **`file` 字段**（不是 path）：
`characters/models/E-01/rigged/E01_Shambler_900_rigged.glb`（LOD2 · +骨骼 · 3000 tris）。
⚠️ **B-02 无 rigged 档**（从未绑骨，只有 textured）——M2 选 **E-01** 当首发角色。

### 验收（M2 = docs/20 分期表）
- 浏览器（`pnpm run editor` → https://localhost:5100，**headed + 真实 GPU，禁 headless SwiftShader，必须 --ignore-certificate-errors**）里看到 E-01 真模型非胶囊
- 其余角色仍是胶囊（flags bit0=0 回退路径）
- `pnpm test` 全绿不回归
- 建议顺手写 `tools/verify/` 探针或扩展 editor-smoke 断言「动态批次蒙皮已激活」

## 2. P4 M3：开动画 + 全 8 角色

- 每 tick 推 phase（`poseIndexAt`）；7 个角色接入（B-02 除外，胶囊回退是设计行为）
- **硬验收：`pnpm run verify:parity-host` 不回归**（37+ PASS）
- draw call = characterId 数（8），与实体数无关

## 3. P4 M4：规模与降级

- 200 只压测（帧率记录）· 远处/未加载退胶囊 · mobile 档（fps=16、1~2 clip——M1 的 `BakeOptions.fps` 已预留）
- 产出：帧率与显存数字记录进 docs/20 或新报告

## 4. P5 C1~C5：战斗实现（设计已 PASS，照 docs/23 执行）

| WU | 内容 | docs/23 依据 |
|---|---|---|
| **C1** | stats.json **结构改造**（扁平→嵌套 attack + player.weapon；E-03 "6 DPS"/E-04 "12+击退+眩晕 0.6s" 复合串逐条定规则；交叉校验分叉） | §2.6 + 评审修正 |
| **C2** | CharacterTable：**复用**既有 `health`（勿新增 hp 列=双 owner）`cooldownUntil`；新增 maxHp/hitFlash/windup；`applyDamage` 单入口 + kill 回收 | §2.1 + §2.1a |
| **C3** | NPC 四态（idle/chase/windup/strike）+ 玩家手枪射线（`rayCapsuleY` 从 runtime-bridge.ts:47 上提 packages/gameplay） | §2.2/§2.3 |
| **C4** | **先重制场景 wave 数据**（floor-1/2/3 全部 wave=0，进 gen-level.mjs 生成器）→ WaveScheduler → 房间 cleared | §2.4 |
| **C5** | 胜负事件（applyDamage 内判定）+ 编辑器装配（动作键 setFire / 失败冻结不自动 Stop） | §2.5 |

**C2 是地基**：applyDamage 单入口红线（禁止直写 health 列）——派生反应全靠它。
验收 5 条在 docs/23 §4（确定性逐位一致 / 波次时序 / 浏览器打死第一只僵尸 / 死亡冻结 / aliveCount 有减有增）。

### P5 实现的既有裁决（照做，别重新发明）
- combat.ts（packages/ai，541 行）**不用删不用改**：四态机是它的「无动画版先行切片」；windup 列 P4 接线后退役为 Montage 采样源；DamagePipeline 等 Build 系统落地时由 applyDamage 内部调用（§2.1a 表）
- poise 列保留（硬直挂载点）；武器数值进 stats.json（weapons.ts 只放类型）

## 5. 收尾杂项（低优先级，可穿插）

- P2 脚本参数编辑放开：spawn-edit 通用组件编辑（**必须带组件下标**，Script 可重复挂载会串值）+ 保存白名单扩展（main.ts `saveSpawnEditsInner` 的 expected 集合）≈ 0.5–1 人日
- P2-3：`syncPlayCamera` 每帧 `rt.view().find` 全表扫 → 改用 `rt.playerEntityId`（挂 P11）
- P2-4：Play 相机静默不接管时补 console.warn（≈5 行）
- P2-7：Play 期间面板俯仰滑条与实际脱节（置灰或 stop 后 refreshParams）
- P2-8：stopPlay 的 focusNode 动画覆盖相机还原（验收时注明此例外）
- P-12 货车 GLB 站立姿态（资产侧修 GLB 或场景加 yaw）

## 6. 每步的流程纪律（沿用本阶段被验证有效的模式）

1. 实现 → typecheck 归零 → vitest（相关文件）→ 全量（串行+脱沙箱）
2. **独立子代理审核**（prompt 要含：门禁清单、红线、变异验证要求、环境坑提醒）
3. FAIL → 逐条整改 → 复审 → PASS 才进下一个
4. 每笔 commit 中文 message（`git commit -F` UTF-8 文件）+ **当场 push**
5. 只 add 本会话改的文件（禁 `git add -A`）
6. 完成后写 `.workbuddy/memory/YYYY-MM-DD.md`

## 7. 已知假象清单（审核反复抓的，自查用）

- 「看起来接线了」但选中/刷新路径实际不走（P2 的 7 条漏路径教训）
- 「声称注册进账目」但零断言（P6 的 M7/M8 教训）
- 手抄数据表 = 第二真源（P4b footprint 抄错 10 倍教训）
- 生成器重生成会冲掉手工场景编辑（演示脚本被冲过一次）
- 「能力有」≠「已接通」（编辑器有 GLB 加载链路但场景装载路径原本跳过）
