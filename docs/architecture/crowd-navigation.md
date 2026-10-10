# 高性能群体寻路与避让

本指南记录 `505bf52` 的 v16 平面导航交付；下述测量保留历史口径。
当前 v17 三维地表配置、坡道/楼梯与白盒验收见[三维地表导航](surface-navigation.md)。

日期：2026-10-10。开发分支：`codex/crowd-navigation-20261010`，起点
`6b486f040da2e1496e851496d2e3706a379a8e31`。当前源码/schema 是真源；本文的性能和
画面证据只对应本次版本及设备。[原选型报告](crowd-and-decals-20261010.md)保留历史结果。

## 1. 职责与数据流

| Owner | 实现 | 职责 |
|---|---|---|
| Framework / AI | `packages/ai/src/navigation.ts`、`crowd-avoidance.ts` | 分帧流场、空间哈希、最近邻、圆盘速度约束、有界接触修正、稳定身份的阻塞检测 |
| Framework / Runtime | `packages/runtime/src/disc-collision.ts` | 圆盘对静态障碍连续碰撞/滑动、动态圆盘接触比例；不认识玩家或攻击 |
| Framework / Scene | `packages/scene/src/document.ts`、`migrate.ts` | v16 NavZone.crowd 配置、校验和 v15→v16 迁移 |
| Game | `packages/zombie-game/src/crowd-navigation.ts`、`session.ts` | 追击资格、速度/减速、攻击距离附近到达、短时侧让；玩家、突扑、冲锋、击退接入碰撞 |
| Editor | `apps/editor/src/main.ts`、`tools/mcp-editor` | 读写完整场景节点，投影真实导航诊断；不拥有第二份模拟 |

场景 NavZone/Collider → 游戏 loader → 导航适配器 → 流场期望方向 → Framework 避让/
连续碰撞 → 写回唯一权威 `CharacterTable`。速度、位置和稳定槽位/generation 从权威表
读取；输出位置直接应用，不能再对输出速度积分一次。游戏内核不依赖 DOM 或 Editor。
旧 `CrowdSolver` 仅保留兼容与 A/B 基准，生产会话已换为 `PredictiveCrowdSolver`。

跨模块查询先用当前检出的 CodeGraph MCP 0.167.0：根目录 apps/assets/packages/tools，
先 project_map，再 session/navigation 和新模块的 module_overview，关键接收者与写回路径
读源码核实。最终增量结构索引更新 25 文件/291 节点，当前增量解析错误为 0；随后查询
上述五个模块。project_map 仍提示 34 文件未逐一核对，旧全库还有解析警告，未重新统计
全库 unresolved calls。它用于导航，不用于证明动态派发完整或推算每帧成本。索引缓存
不入库，测试和 GPU 证据独立于图谱。

## 2. 配置、迁移与编辑闭环

v16 的 NavZone 必须保存 `crowd`，而非编辑器或运行时私有默认值：

| 字段 | 默认 | 有效范围/含义 |
|---|---:|---|
| maxNeighbors | 12 | 整数 1–32，速度约束的最近邻数；接触修正不使用此截断 |
| timeHorizonSec | 0.8 | 0.05–3 秒，预测时域 |
| skinM | 0.02 | 0–0.2 米，圆盘间保护间距 |
| acceleration | 8 | 大于 0 且不超过 100，期望速度平滑；紧急约束不受后置加速度裁剪 |
| collisionIterations | 4 | 整数 1–12，每步接触修正次数 |
| stuckWindowSec | 0.5 | 0.1–10 秒，进展检查窗口 |
| stuckProgressRatio | 0.15 | 0–1，实际进展与期望进展的阈值 |
| flowCellBudget | 2048 | 整数 64–65536，每步流场工作项预算 |

NavZone bounds/cellSize 必须有限、为正；网格最多 262144 格。v15→v16 深复制补充缺失
配置，保留已有自定义值；坏配置由校验拒绝，不能静默覆盖。全部 14 个场景已迁移。
Node 关卡工具通过 `tools/scene/load-contract.mjs` 读取公共 schema/default 工厂，
不再另存版本或导航默认值。旧版直接构造 NavDesc API 暂可省略 crowd；场景 loader
对 v16 缺失/非法配置返回 `E_NAV_CROWD`。

Agent 操作：editor_workflow → editor_instances 明确 UUID → scene_get → 只改选定完整
NavZone 节点的 crowd → scene_edit_nodes（带当前 revision）→ scene_validate → scene_save
→ scene_open → scene_get 比较字段。当前使用通用节点编辑，没有专用导航设置面板。
本次第一层将预算 2048 改为 1024，保存重开确认，再恢复 2048 保存重开；稳定节点、其他
组件及引用保留。证据见本次 evidence 目录。Play 中禁止作者编辑，临时压力夹具不保存。

## 3. 算法与失败行为

共享流场通过增量 Dijkstra 计算。队列弹出（包括过期项）和流向生成都计入预算；完整
暂存结果计算完成后发布版本，角色不会读取半张新图。持续移动的目标合并成最新请求，
不反复取消正在计算的任务。建立 Play 时完成初次烘焙；运行时每步按预算推进。
初始化数组填充和完成时数组复制仍为 O(格数)，工作项预算不是毫秒硬上限。

空间哈希按环扩展，以覆盖距离下界提前停止，精确选择最近且层/高度区间兼容的邻居。
速度求解使用 [ORCA 研究](https://gamma.cs.unc.edu/ORCA/) 的圆盘互反约束和本项目独立
实现的法线形式二维半平面投影。移动双方分担责任，外部控制角色被观察但不由普通追击
求解器移动。不可行速度通过有限次松弛最小化违约并计数；不声称等同完整 RVO2 或获得
论文理想条件下的全局无碰撞保证。

静态 box 使用半径扩展矩形，sphere/capsule 使用圆形水平投影。连续 sweep 阻止高速
穿薄墙，沿墙有限滑动；起点无法修正到合法位置则等待并报告。接触修正每轮从完整邻域
积累互反修正，有界迭代并记录剩余穿透；极端完全重合的邻居查询仍可能 O(N²)。
玩家、突扑/冲锋和击退另外对当前权威角色圆盘做连续截停，不能绕过群体碰撞进入玩家
中心；它们按顺序更新，不属于共同 ORCA 积分，也没有动态侧滑或推开站定角色的机制。

游戏策略在攻击许可范围附近减速并保持玩家圆盘间距，站定前摇/收势仍进入邻居观察。
当前是径向到达环，未实现角度攻击槽位预约。不可达区域等待并计数，不改成穿墙直追。
玩家落在保守阻挡格时，在四格邻域选择开放目标并计数；不移动玩家到该格。持续卡住
时按稳定身份短暂侧让，不用每帧随机抖动，不接管攻击时钟。槽位复用和 Reset 清历史。

`editor_runtime.runtime.navigation` 是只读副本，Stop 后为 null。flow 包含 version、
pending、publishedGoal、requestedX/Z、workLastStep、cellCount、rejectedGoals。
crowd 包含 agents/moving、candidateChecks、velocityConstraints、infeasibleVelocities、
contactPairs、blockedMoves、residualOverlapPairs、maxPenetrationM、stuckAgents、
unreachableAgents、yieldingAgents。`externalBlockedMoves` 是本次运行独立位移被动态
圆盘截停的累计次数，其余 crowd 数值属于最近一步。读取不会推进模拟/烘焙或写场景。

## 4. 验证与性能证据

CPU 基准：Intel i9-14900HX，Node v22.23.2，1/30 秒步长，30 步预热 + 300 步测量。
`tools/verify/crowd-navigation-benchmark.mjs` 对 100/500/1000、开放地形/4 米门口/初始
密集穿透比较旧/新共 18 组。位置、半径和目标一致；新系统采用到达环，旧系统直指中心，
因此是完整机制/策略比较，不能只归因速度约束算法。计时含期望采样、静态 sweep 和接触
修正，不含完整游戏、动画和 GPU，不能换算 FPS。质量统计在计时之外检查；CPU 基准
只统计实际圆盘穿透大于 2 厘米的对数及其最深值，0 不证明微穿透也不存在。

详细数据、源码 SHA256 和限制见
[`cpu-benchmark.json`](../evidence/crowd-navigation-20261010/cpu-benchmark.json)。
最终单次结果：500 新系统 P95 为 3.08–3.38 毫秒；新系统所有案例静态非法位置为 0，
但 500 门口/1000 开放案例各有一对约 2 厘米残余重叠。有限迭代不是严格硬体无穿透。
门口遵守碰撞后的通过数低于允许重叠的旧系统，不能宣称通行吞吐必然提升。
移动目标流场 12800 格、预算 2048、1000 次请求发布 76 次；最大工作项 2048，
P95 0.23 毫秒，最慢约 0.53 毫秒，包含填充和发布数组复制。

| 500 个移动体 | 旧系统 P95（ms） | 新系统 P95（ms） | 新系统最终 >2cm 穿透对数 |
|---|---:|---:|---:|
| 开放地形 | 0.36 | 3.08 | 0 |
| 4 米门口 | 0.33 | 3.21 | 1 |
| 初始密集穿透 | 0.40 | 3.38 | 0 |

相关 46 文件/639 项 Vitest 通过，含最近邻与暴力结果比较、互反/锚点/身份复用、
薄墙及 Float32 沿墙微穿透、不可达等待、预算合并/原子发布、v16 迁移、MCP 编辑门禁，
以及第一层连续 600 tick 突扑不进入玩家圆盘的回归。Node 工具与 MCP 使用独立测试。
有界面 Chrome HTTPS WebGPU 使用 NVIDIA Lovelace，isFallbackAdapter=false。
第一层正常 24 NPC 在 90 tick 检查了追击/攻击；随后新代码压力验收由真实 RuntimeSession
debugSpawn 临时增加 476 个 E-01，合计 500 NPC + 玩家，模型和远距离胶囊 LOD 共
500 动态实例。71 tick 时 247 个可移动体、静态非法位置 0、实际圆盘重叠 0；191 对
残余接触只侵入 2 厘米 skin 保护带（最深 1.42 厘米），不能把它们解释成实际圆盘穿透。
玩家原地 x=3,z=0；通过运行时输入 QA 与 MCP 单步 30 步移动至 z=-4.377，流场从
version=1 更新到 7，再静止 30 步完成 version=8、pending=false。部分注入点位于保守
烘焙的阻挡格，实际等待并报告不可达，未声称 500 NPC 同时追击或通过全部关卡。

停止并撤销临时相机后：registered/disposed=4/4、pending=0、instances=0、navigation=null，
音频缓冲/bytes/voices 为 0；完整作者文档与压力验收前相等，revision=2bde3a1b、dirty=false。
最终浏览器 error 日志为空。键盘自动化没有得到玩家移动证据，因此移动目标只认证上述
运行时 QA 路径。详细字段见 [`runtime-acceptance.json`](../evidence/crowd-navigation-20261010/runtime-acceptance.json)
及 `500-npc.png` / `500-npc-moving-goal.png`。QA 单步与临时增加 NPC 不等同于完整
战役通关、500 个完整动画角色的成本或所有设备的帧率承诺。

本次开发服务在项目相邻检出 `C:\Users\fangy\Documents\Projects\visual-quality-20261007\game-design-zombie`
以 detached 隐藏进程运行，固定 HTTPS 5100，启用 AETHER_EDITOR_MCP；PID 69188，
日志 `.workbuddy/tmp/crowd-navigation/editor.out.log` / `editor.err.log`，PID 文件同目录。
停止前核对 PID 的 Vite 命令与工作目录归属，再执行 `Stop-Process -Id 69188`；PID 只是
本次运行记录，不可当成之后会话的固定服务标识。

定向复现命令：

```powershell
pnpm exec vitest run packages/ai/test packages/runtime/test/disc-collision.test.ts packages/zombie-game/test packages/scene/test apps/editor/test/editor-agent.test.ts
node --test tools/scene/load-contract.test.mjs
node --test tools/mcp-editor/*.test.mjs
node tools/verify/crowd-navigation-benchmark.mjs
pnpm run typecheck
pnpm run editor:build
pnpm run architecture:check
pnpm run knowledge:check
pnpm run scene:check
```

## 5. 范围及后续边界

当前为地面 2.5D 系统，Framework 可过滤层/高度区间，僵尸适配器使用当前单一地面。
不包含真正三维 NavMesh、楼梯/跳跃/飞行、动态地形重烘焙、跨层门连接、角度攻击预约、
WASM/Worker 求解或手机硬件性能认证。需要这些机制时先扩场景契约与 owner 验收，
不能把僵尸状态写进 Framework，也不能用图谱覆盖数代替性能测量。
