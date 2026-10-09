# ANI-20261008 动作批次接入记录

2026-10-09，基于 `9a5594bb15cd07643c2e2e1a38f1e539b4fcb814` 检出并接入。
这是源资产核验与候选接入记录，**没有完成游戏内姿态、时间轴及真实 GPU 验收**。
需求真源见 [动作需求](../38-GameplayActionAndVfxAssetBrief.md)，运行契约见
[`shared-motion.ts`](../../packages/scene/src/shared-motion.ts)。

## 接收结果与修正

19 个计划需求 ID 中，17 个 ID 有新交付，对应 **18 个 FBX**（受击轻反应有 A/B 两件）。
其余两个需求由既有动作覆盖。源文件都是 73 骨、59 条曲线；14 件无网格，射击、换弹、
扑咬和 Charge 四件各含一个蒙皮网格，原报告“全部 bone-only”不成立。导入器只输出
22 个 HumanIK 主骨的动作，不发布这些网格，也不保留源手指曲线。

受击 A 的交付记录和 source 副本曾被 B 覆盖。本次从本机原始归档恢复 A，保留两个
独立 hash、时长和路径；A 的来源动作名称引用下载反馈，丢失的 model-id 保留 `null`，
没有猜测。两件旧动作的去重仅有名称和时长依据，删除的原新件无法做逐帧比对，因此
标记为“未验证曲线一致”，不认证严格重复。

原始 FBX 在 `assets-src/mixamo/animations/` 和本批交付区的 `source/` 中本机归档，
均被 `.gitignore` 排除。提交派生 BVH、sidecar、交付 JSON 和检查记录；不将这项规则
扩大到其他批次的模型源件。交付目录见
[`batch.json`](../../assets/_delivery/ANI-20261008/batch.json) 和
[`intake.json`](../../assets/_delivery/ANI-20261008/intake.json)。

## 可重复导入与职责

```powershell
pnpm run motion:import -- --batch assets/_delivery/ANI-20261008/batch.json
node --test tools/motion/import-mixamo.test.mjs
pnpm run motion:check
pnpm run scene:check
```

重导入需要本机忽略的原始 FBX；新检出目录只能直接使用已发布 BVH，不能声称能在
没有原件时重建转换。导入前校验批次 ID、源文件名、交付 hash 和字节数；逐帧用真实
FBX FK 与项目 BVH 解析器核对，超过 2 mm 则拒绝发布。全部转换验证完成后再写文件；
磁盘写入失败仍可能留下部分输出，明确报错，同批重跑修复，不承诺文件系统事务。
保留既有 sidecar 的 GUID、绑定及扩展字段；共享库合并片段并保留正式 player/npc profile。

`tools/motion/import-mixamo.mjs` 负责离线提取与源数据；`SharedMotionRuntime` 负责现有
目标骨架求解；编辑器负责检视与选择。僵尸玩法、攻击命中、换弹生效和武器 hook 仍由
各自 owner 管理。本次没有修改伤害计时、生产场景、角色 rig/sidecar 或正式动作映射。

## 编辑器检视入口

项目已登记 `assets/scenes/sandbox/ani-20261008-intake.scene.json`，名称为
“ANI-20261008 · 动作候选检视（未验收）”。启动编辑器后打开此场景，进入 Play，展开
“共享动作 · Play”控件，分别点击各角色的 `ani_*` 按钮；已有动画观察视图使用方式见
[动画可视化调试](../45-AnimationVisualDebugging.md)。此入口尚未进行本次有界面实测。

专用 profile 是 `ani-20261008-preview`，含全部 18 个候选；全部先设为 one-shot，
不能因需求写了 loop 就宣称循环接缝合格。四个场景目标复用 H-01、E-01、E-04 的已有
rig。旧需求称 P-01/毁灭者，当前玩家数据使用 H-01/清道夫；需求名称不作为新增角色
或改写 rig 的授权。生产启动场景保持原选择。

## 实际验证及边界

- 18 件转换的最大 FK 误差约 `1.91e-7 m`；序列化 BVH 再解析后的最大误差约
  `3.12e-5 m`，均低于 2 mm 门槛。
- `motion:check`：28 个源动作、8 个场景目标、9 个 NPC palette，118 次求解、2 次缓存
  命中；逐帧矩阵有限、目标 rest pose 未改、palette 偏移正确。纹理解码使用 CPU stub，
  不证明贴图或 GPU 上传正确。
- 5 个相关 Vitest 文件共 46 项通过，覆盖共享动作、场景适配、源运动、烘焙和纹理限幅。
- 6 项导入失败路径测试通过：无效文档/批次、无新源、路径越界、重复文件和交付身份
  不符均拒绝，并核对共享库与源资产未被改写；不依赖忽略的 FBX。
- `scene:check` 通过：228 个资产元数据同步、14 个 v15 场景；LOD/P0 图集及音频门禁通过。
- 类型检查、编辑器构建、264 个文件的架构依赖门禁通过。CodeGraph MCP 用于定位导入器和共享动作
  适配器，再核对源码；增量刷新报告更新 44 个文件，同时存在其他索引进程持锁警告，
  不认证独占、无竞争快照，也不将同名方法的歧义边当作真实依赖。
- 本次没有 headed Play、Stop 释放及真实 GPU 验收：编辑器服务启动曾被自动审批策略
  拦截，等待用户手动启动 5100 服务。没有使用旧截图或 CPU 采样替代视觉验收。

## 进入正式玩法前仍需完成

以下为本次候选提交时的缺项。2026-10-10 的裁剪、实际玩法映射和 headed GPU 验证进展见
[动作进入实际玩法](ani-gameplay-integration.md)；本记录中的历史验收边界保持原样。

| 动作 | 当前限制与下一步 |
|---|---|
| 瞄准、四方向移动 | 验收首尾接缝、脚接触与滑步，再启用循环；备用瞄准属于步枪姿态 |
| 手枪射击 | 5.3 s 源片段需选取短后坐区间，实测 release/recovery；检查持握与武器 hook |
| 换弹 | 3.3 s 步枪替代动作，需要手枪握持修正和 magazine-out/in/ready 标记 |
| 扑咬、喷吐、引爆、Boss 砸地 | 当前是替代动作，分别验收可读性、口部发射点和命中时机；VFX 与模拟事件同步 |
| E-04 冲锋 | `Pointing Onward` 是手势，不能当作低头架肩冲撞；须补正确冲锋动作或独立程序化表现 |
| 受击与死亡 | 源片段超出目标短时长，需裁剪/映射并检查终帧、穿地与伤害生效独立性 |

当前交付还缺实际 `markers.json` 和多视角预览视频。不能填猜测时间标记，也不能仅压缩
整段动画来满足战斗时长；需在目标角色上验收实际动作段后再更新正式映射。
