# Act1 实战 VFX 与直接试玩

日期：2026-10-19。基线 `db170c558391b0563f1c42bde815d47689bf803b`。
本次把已有正式 VFX 接到原 Act1 三层，不新增验收专用游戏场景。
启动场景仍由 `aether.project.json` 的 `startIndex=1` 指向第一层。

## 试玩入口与操作

服务为本仓库已有的固定 HTTPS 5100。点击入口，等场景及 GLB 加载结束后按左上 **Play**。
若提示“场景或资产尚未加载完成”，等右上显示“已打开”后再播放。

| 实际场景 | 入口 | 可遇到的原有内容 |
|---|---|---|
| 第一层 · 火场公路 | [直接打开](https://fangye-win11-office.tail6b29a2.ts.net:5100/?scene=assets%2Fscenes%2Fact1%2Ffloor-1.scene.json) | 首战 E-01、E-02；扑击落点、近战弧线；后续事件房与第二战斗房 |
| 第二层 · 尸潮仓储区 | [直接打开](https://fangye-win11-office.tail6b29a2.ts.net:5100/?scene=assets%2Fscenes%2Fact1%2Ffloor-2.scene.json) | 首战 E-01/E-02，第二波 E-03 酸液、落地酸池；事件房后精英房 E-04 冲锋 |
| 第三层 · 暗巷撤离站 | [直接打开](https://fangye-win11-office.tail6b29a2.ts.net:5100/?scene=assets%2Fscenes%2Fact1%2Ffloor-3.scene.json) | 首房 E-04 冲锋及 E-02，第二波 E-03；后续 Boss 房 B-01、E-05 自爆与 E-03 |

WASD/方向键移动，鼠标瞄准，鼠标左键或 J 持续攻击；R 换弹，E 交互，空格暂停。
三层均以手枪开始，现有武器选择器和数字键 **1–7** 可直接换装：
1 手枪、2 霰弹枪、3 冲锋枪、4 狙击枪、5 电锯、6 火焰喷射器、7 榴弹发射器。
当前武器没有额外解锁/拾取要求；成长 `unlocked` 用于天赋资格。
换装需等待原换装动画结束，选择强化弹出时战斗会冻结，点击一项强化后继续。
不修改伤害、弹药、波次、奖励、天赋、地形、导航、相机、灯光或角色绑定。

## 已接入的表现及边界

- 四把射线枪共用正式枪口闪光、弹道与命中；真实接触点另有火花。只有对应 GPU 表现已就绪时才替换旧 Canvas 枪效。
- 火焰喷射器使用真实枪口/方向发射，真实燃烧 actor 按身份代次附着烟。实战组合保持 M3 原尺寸、发射率与生命周期，仅增加 0.25m 的 soft 深度柔化，避免直接套用 M4 大尺寸测试资源。
- E-02 扑击、E-03 飞行/落地/酸池/被挡、E-05 自爆和结束痕迹复用正式敌人资源。危险轮廓和前摇提示保留，缺资源/预算不足继续走原保底。
- E-04 的真实冲锋同时有尘尾与 M4 连续 Ribbon，读取逐 tick 移动事实，不增加高度偏移。电锯和敌人近战复用真实挥击弧线。
- GPU 命中已有同 run/tick/slot/generation 的可画实例时，去掉重复 Canvas 星花；伤害与击杀文字保留。缺图、旧代次、无匹配命中均继续保底。
- 榴弹发射器仍走现有 Canvas 弹丸/爆炸，未宣称其已 GPU 迁移。默认 sandbox 无玩家起点/RunRules，继续用于编辑；未改造成新玩法。
- 当前关卡没有合适的既有 graph/compute 作者节点或静态跨面涂印语义，本次不添加这类摆件。三项能力的作者入口与支持边界仍见 [M4 指南](../architecture/vfx-m4-20261019.md)，不把系统能力等同于已在实战触发。

绑定真源为三份 `assets/scenes/act1/floor-*.scene.json`：四把武器的 `presentation.vfx` 和 RunRules 所在节点的 `VfxBindings`。
`tools/level/gameplay-vfx.mjs` 由 `gen-level.mjs` 调用，显式重建正式关卡也会保留这些绑定；本次没有运行整关重生成。
资产使用稳定 GUID，并进入场景 dependencies；各枪/标签共享 **14/16** 张纹理，没有为每把枪复制纹理。
共享装饰池仍为 256，Ribbon 共享点预算沿原系统；满池时可能减少装饰，不改变模拟或危险范围。

## 实际验证与限制

开发原始记录在 `.workbuddy/tmp/vfx-gameplay-integration/`。
`development-09/result.json` 的 **31 项通过**：真实 headed、HTTPS、NVIDIA Lovelace 非 fallback；
三层直接从磁盘加载、四枪/13 标签和 14 纹理就绪；原生数字键/J/鼠标产生六武器实际事实；
原生击杀→强化选择→继续战斗；真实火焰/燃烧烟和三层自然盾卫冲锋。
手枪、成熟火焰、冲锋 Ribbon 分别做暂停同机位 GPU on/off 局部像素比较，原始 PNG 与阈值同目录保存。
所有 Stop 检查账目归零及真实纹理/缓冲销毁；场景 hash 验收前后相同。
这些像素比较关闭的是已有 Pass，属于受控测量；攻击/冲锋来源是原游戏输入/状态机。

本轮没有自然打到第二波酸液及 Boss 房爆尸，不把绑定检查写成已实战触发。
遮挡/透明混合/失败路径的通用能力继续复用 [M1](../architecture/vfx-m1-20261019.md)、[M2](../architecture/vfx-m2-20261019.md)、[M3](../architecture/vfx-m3-20261019.md)、[M4](../architecture/vfx-m4-20261019.md) 对应精确版本的既有独立验收；本次没有新增关卡遮挡几何或重新认证所有设备/繁忙波次帧率。
生产最小检查为 scene:check、typecheck、editor:build、architecture:check 与相关 owner 测试。
CPU 控制器/角色测试使用无 GPU 替身隔离 VFX 装配，其通过不作为 GPU 证明。
player-presentation 的旧 v7 迁移精确列表缺 v15→19 四项，是基线 `db170c5` 已存在的失败，未在本次修复。
knowledge 全工作区仍包含两份未跟踪架构草稿的三条既有诊断；本任务目录按单独 staged 版本检查。
开发通过仍需队列独立 Audit/Final Reviewer，本文不预授最终批准。

复跑：

```powershell
node tools/verify/vfx-gameplay-probe.mjs --headed --out .workbuddy/tmp/vfx-gameplay-integration/recheck
node --test tools/level/gameplay-vfx.test.mjs
```

探针使用本任务专属 Chrome profile/CDP，保留用户原窗口与 5100 服务，不写回正式场景。
旧 development-01–07 的过早 Play/输入、成长模态与未成熟粒子采样失败保留；不覆盖成通过记录。
