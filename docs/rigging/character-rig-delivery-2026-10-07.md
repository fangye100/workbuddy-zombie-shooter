# 角色 Rig 接入记录 · 2026-10-07

清道夫 LOD0 与 8 个 NPC 均已接入正式资产清单。NPC 从已保存的源姿态关节生成
27 节 HumanIK rig，使用体积扩散与 6 次、λ=0.5 的表面平滑；原有手调关节和
Skin Wrapper 参数不变。清道夫保留原有已确认的 LOD0 权重。

每个 GLB 包含网格、原纹理、骨架、inverse bind matrices 和 top-4 权重，嵌入动画数为 0。
同目录 `.meta.json.sharedMotion` 指向现有共享动作库；运行时按目标 rest pose 求解并
缓存动画，再采样成 NPC GPU 调色板。没有为每个角色复制 Mixamo 原始动作文件。

## 正式资产

下列路径均相对于 `assets/characters/models/`。实际身高来自 `roster.generated.ts`，
网格坐标、骨骼偏移和 inverse bind translations 同步缩放，编辑器与 runtime 尺度一致。

| 角色 | GLB | 身高 | 三角形 |
|---|---|---:|---:|
| H-01 清道夫 | H-01/rigged/H01_SCAVENGER_LOD0_animation_ready.glb | 1.80m | 79,980 |
| E-01 游荡者 | E-01/rigged/E01_Shambler_900_animation_ready.glb | 1.75m | 3,000 |
| E-02 扑跃者 | E-02/rigged/E02_Lunger_1100_animation_ready.glb | 1.25m | 3,300 |
| E-03 呕吐者 | E-03/rigged/E03_Spitter_1200_animation_ready.glb | 1.70m | 3,600 |
| E-04 盾卫 | E-04/rigged/E04_Bulwark_1600_animation_ready.glb | 2.05m | 4,800 |
| E-05 爆尸 | E-05/rigged/E05_Bloater_1000_animation_ready.glb | 1.60m | 3,000 |
| B-01 屠夫 | B-01/rigged/B01_THE BUTCHER_4200_animation_ready.glb | 3.20m | 12,600 |
| B-02 母体 | B-02/rigged/B02_THE BROODMOTHER_6000_animation_ready.glb | 4.00m | 18,000 |
| B-03 零号 | B-03/rigged/B03_PATIENT ZERO_5200_animation_ready.glb | 2.60m | 15,600 |

NPC 的源 `.meta.json.bindingEditor` 是再次编辑、计算和导出的真源。输出 sidecar 的
`userData.bindingSession` 指回该会话。新 rig 替换清单的 `+骨骼` 档；旧 rig/嵌入动画档
仍保留。ActorLibrary 优先装配带共享动作配置的新 rig。

Act1 floor-1/2/3 的 player MeshRenderer 均改为清道夫 LOD0 的 path+guid，并配置
player 共享动作；NPC 继续通过 SpawnPoint.characterId 与资产清单装配，战斗数值不变。

## 零号输液部件

按用户指定，输液杆、吊袋与管线的完整源 UV 岛选择（3,060 顶点）刚性跟随
`LeftHand`，权重 1.0；此约束在体积求解、镜像、平滑之后应用，避免重新扩散到脚部。
未切开源网格、未更改 UV，也未移动关节。精确选择带源顶点指纹，换网格时明确拒绝
旧选择。胶囊框选会切中这个生成模型的脚/道具边界，因此最终使用完整岛选择。

Skin Process 的「刚性部件约束」与 MCP `set_options.rigidRegions` 使用同一份
保存/回填/Undo/Redo 数据。B-03 LeftLeg 的体积种子投影距离为 2.92cm；B-02 两手也
使用受限投影。关节位置仍取用户保存值。

## 实际验证

- 122 项相关单元测试通过，覆盖绑定、持久化、体积算法、刚性约束、共享动作和角色调色板。
- MCP stdio 真实工具链 82 PASS / 0 FAIL；类型检查、编辑器构建通过。
- `scene:gen` 无需额外写入；`scene:check` 验证 182 个成品元数据、12 个 v11 场景与项目登记。
- `motion:check` 验证 10 个共享源、4 个目标场景节点、全部 9 个 ActorLibrary 角色，
  包含逐帧有限矩阵、目标 rest offsets 不被覆盖和 GPU 调色板偏移约束。
- 9 个正式 GLB 都通过 27 骨、非零归一化权重、纹理存在、身高与 rest palette 恒等矩阵检查。
- Headed Chrome / HTTPS / NVIDIA Lovelace：8 个 NPC 的 idle/walk/attack/death/scream
  共 40 个姿态，加上 8 个死亡末段姿态逐一截图、视觉检查。
- 持久化 `character-rig-validation.scene.json`：Play 装配全部 9 角色，8 类 NPC 各有
  1 个真实 `actor:*` 动态实例，装配诊断为空；动画帧有推进。Stop 后动态实例/批次清零。
  第二次 Play 调色板上传计数从 9 增至 18，未使用胶囊替代新 rig。
- 正式 floor-1 场景 Headed Play：清道夫实际网格 79,980 三角形 / 27 骨，6 个共享
  动作状态加载，求解失败数为 0；E-01/E-02 共 8 个真实动态实例，装配诊断为空。
- Skin Process 实际回填 B-03 的 3,060 顶点 LeftHand 约束并重新求解：39.72 秒收敛，
  未覆盖关节，零权重 / outsideBones / 最近骨兜底均为 0；手部热图覆盖完整输液部件。

本机原始日志、48 张动作图与汇总图位于 `.workbuddy/tmp/npc-rig-20261007/`（gitignore）。

## 已知视觉边界

这些是可驱动、已接入场景的 rig；共享动作仍是通用 Mixamo 动作。盾卫护具和部分
生成式衣物在大幅抬臂时仍有拉伸，爆尸在死亡末段腹部出现压扁，尚未做美术精修。
原网格粘连和 LBS 体积损失不等于骨架/权重数据无效，也不能用构建成功代替视觉质量判断。
足底接触、源足标记和能力差异仍保留 runtime 的派生/未校准诊断，未宣称通过滑步、
专属 Boss 招式或人群性能验收。

体积求解中 E-02/B-01/B-02 分别有 47/24/294 个顶点使用显式最近骨兜底；这是薄片/
不封闭生成表面的采样诊断，权重仍非零且归一化。相关姿态已纳入上述人工检查。

## 入口与再生成

- Game Editor → Skeleton → 角色绑定数据 → 选择角色：回读源 sidecar，手动调整关节，保存。
- 验收场景已登记在项目场景列表：`assets/scenes/sandbox/character-rig-validation.scene.json`。
  Edit 显示 rig；Play 隐藏静态 NPC 预览并生成 8 类 runtime NPC；Stop 恢复。
- 修改源绑定后重新生成（会保存体积参数并重写本记录清单对应输出）：

```powershell
node tools/rigging/export-character-rigs.mjs
node tools/rigging/integrate-character-rigs.mjs
pnpm run scene:gen
pnpm run scene:check
pnpm run motion:check
```

再生成后仍需在 headed 编辑器检查动作；脚本的结构验证不自动授予视觉验收。
