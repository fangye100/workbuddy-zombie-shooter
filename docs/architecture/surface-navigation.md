# 三维地表导航与白盒验收

2026-10-10，分支 `codex/crowd-navigation-20261010`，基线 `505bf52`。
场景 schema v17；当前源码是真源，以下测量只对应本次源码、夹具与设备。

## 职责与数据流

| Owner | 实现 | 责任 |
|---|---|---|
| Framework / Scene | `packages/scene/src/document.ts`、`migrate.ts` | NavSurface、NavZone.surface、稳定支撑引用、v16→v17 迁移与校验 |
| Framework / AI | `packages/ai/src/surface-navigation.ts`、`crowd-avoidance.ts` | 世界矩形面采样图、反向分帧 Dijkstra、连续地表投影、按垂直区间筛选圆盘避让 |
| Game | `packages/zombie-game/src/loader.ts`、`surface-crowd-navigation.ts`、`session.ts` | 从场景派生世界坐标和障碍、追击/到达/攻击策略、出生校验；写回唯一 CharacterTable |
| Editor | `apps/editor/src/services/runtime-bridge.ts`、`player-presentation.ts`、`play-camera.ts` | 读取实际 Y 呈现角色、拾取和游戏相机；作者场景不因 Play 改写 |

CodeGraph 0.167.0 在当前检出目录增量刷新并查询新旧导航、loader、攻击及表现模块。
图谱仍有旧文件解析警告及动态派发盲区，关系由源码和 owner 测试复核；索引不入库，
不以图谱覆盖或中心性证明性能。

## 场景契约与失败行为

NavZone 保留 `bounds/cellSize/crowd`，增加可选 `surface`：`maxSlopeDeg`、`maxStepM`、
`agentRadius`、`agentHeight`。显式启用后，NavSurface 在节点局部 XZ 平面定义矩形
`size:[宽,深]`；节点和父级变换决定世界高度及坡度。`supportCollider` 可引用同场景
非 Trigger Collider 的稳定 NodeId；碰撞体仍用于射击和其他楼层净空，不从全局碰撞表删除。
场景作者须保证支撑引用与真实接触面吻合；当前障碍净空按世界 AABB 保守处理。

v16→v17 深复制升级版本，不自动给旧平面关卡制造坡道。未启用 surface 时保持旧场景
的脚底 Y=0 语义，避免把编辑标记的高度当出生高度。14 个旧场景已迁移版本。
有 NavSurface 却没有启用三维配置、配置缺面、出生点无支撑/净空不足均显式失败。玩家和 NPC 的真实胶囊高度/半径必须不超过导航配置。调试刷怪整批预检，房间投放整波所有刷怪点预检后才分配；失败产生 W_SPAWN_NAVIGATION 且不留下半波或幽灵槽位。
超坡面进入 rejectedSurfaces；图采样超过 262144 格拒绝。禁止在编辑器启动代码硬编码地形。

作者闭环：`editor_workflow` → 精确实例 `editor_instances` → `scene_get` → 带 revision
的 `scene_edit_nodes`（完整节点）→ `scene_validate` → `scene_save` → `scene_open` → 比较。
白盒实测最大坡度 40→39 保存重开，再还原 40 保存重开；尺寸、节点 ID 和支撑引用保留。
当前使用通用 MCP 节点编辑，没有专用 NavSurface Inspector 控件。

## 算法与边界

多个地表可在相同 XZ 上保持不同 Y，只有连续可步行、坡度/步高/净空合格的邻格形成
连接。跨面连接逐段验证；高度差超过一步限制不连接。圆盘的中心及八个圆周采样点
检查地表并集支撑；这是有限采样，不能认证任意细缝和复杂曲线轮廓的精确胶囊碰撞。
连续投影以短步检查移动段，撞悬崖、超高台阶或顶棚停在最后合法点，不吸附到另一层。
反向 Dijkstra 遍历 incoming 边，防止单向可走边被错误反转。

共享目标图按 heap 弹出/边松弛计入 flowCellBudget，目标持续移动合并请求而非反复
取消。初始化建图和首次烘焙同步执行；数组初始化、结果发布及邻域碰撞不受搜索工作项
预算限制，因此预算不是毫秒硬上限。地形/障碍按 Play 起始快照构建，当前不支持运行中
动态重烘焙。地表期望速度按坡面弧长折算，紧急接触修正可能超过期望速度。

上下层不互相避让；攻击距离、角色渲染、武器挂点、伤害/VFX 和房间交互使用实际高度。
三维适配器目前有阻塞诊断但没有旧平面适配器的短时侧让策略。有限接触修正不保证
密集出生零重叠。射击仍沿现有水平瞄准接口，未新增垂直瞄准操作。
本版本覆盖可步行三维地表，不包含飞行体积寻路、跳跃/攀爬链接或任意 GLB 自动 NavMesh 烘焙。

## 白盒与验证

入口：`assets/scenes/sandbox/navigation-3d-whitebox.scene.json`，已登记项目 scenes。
47 个节点、38 个静态 mesh；包含 Y=0 下平台、26.565° 蓝色坡道、16 级 0.25m 楼梯、
Y=4 上平台、正下方 Y=0 隔离层、Y=8 孤岛。坡道和楼梯各 4 NPC，隔离层和孤岛各 2 NPC。
玩家从 Y=4 出生。生成器：`node tools/level/gen-navigation-whitebox.mjs`。
楼梯实体目前为视觉几何，导航由显式踏面驱动；上平台有真实 Collider 与稳定支撑引用。

有头 Chrome、HTTPS secure context、NVIDIA Lovelace、非 fallback WebGPU：

- 实际 Play 按钮启动后暂停，MCP 单步到 tick 155；坡道组满足 Y=X/2，楼梯组按踏面取高。
- tick 534，两组共 8 NPC 全部到达 Y=4 高台；隔离层/孤岛 4 NPC 保持原层且不可达。
- 重跑后通过 runtime 输入钩子向左并 MCP 单步 120，玩家从高台下坡到低台 Y=0。
  这是确定性 QA 输入，未作为真实键盘操作验收。
- Stop 后场景逐字序列化相同；运行会话清空，资源账本 registered=3/disposed=3/pending=0，
  动态实例为 0、navigation=null；页面 error 日志为空。
- GPU 白盒使用现有 E-01 静态实例和胶囊玩家，没有认证完整蒙皮动画或 500 角色 GPU 帧率。

证据：`docs/evidence/surface-navigation-20261010/` 的 roundtrip、midway、arrival、reverse、
runtime-stop JSON 与 PNG。相关测试覆盖上下坡、楼梯、超高台阶、低净空、陡坡、断层、
移动目标预算、叠层不误伤以及旧平面关卡兼容。

CPU 压力工具：`node tools/verify/surface-navigation-benchmark.mjs`，初始化和模拟稳态分开。
Node 22.23.2，本次 100 NPC P95 1.80ms、500 NPC P95 15.09ms；初始化约 82/58ms。
角色集中在半径 1m 入口，最高残余重叠对 1327/32672，不能据此宣称零穿透或全部通行。
包含游戏模拟、未计渲染动画；含 GC/系统调度的单机单次数据不换算 FPS，报告保存源码 SHA256。

变更门禁：相关 owner Vitest、`typecheck`、`editor:build`、`scene:check`、
`architecture:check`、`knowledge:check`，Node 场景契约测试独立运行。

独立子代理复审发现并关闭玩家尺寸漏检和出生失败原子性问题；首波及后续波次重复尝试复现均不产生部分实体。最终独立 3 文件 21 测试通过，无未关闭 P1/P2。主代理最终相关 34 文件 381 测试通过，全部上述门禁通过。
