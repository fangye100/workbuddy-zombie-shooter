# 七武器、NPC 受击与流动燃烧当前契约

日期：2026-10-20；实施基线 `5fe4d6fef23ab3e291ad748595047cb3c2ee33f8`，场景 v23。本文说明实现与待验收边界，实际试玩见[Act1 指南](../animation/vfx-gameplay-integration.md)。M4 compute、Ribbon、soft、投影与图编辑的既有能力/UI均保留，未另建简化播放管线。

## 事实与责任

`packages/runtime/src/weapon-combat.ts` 在原攻击流程追加只读 VFX 事实：开火、射线、实际接触、逐 tick 投射物段及终止。伤害、射速、弹药、范围、AI、命中计算不变。`WeaponDamageFacts` 携带 weaponId/vfxSequence，`packages/zombie-game/src/session.ts` 的既有 applyDamage 在同一 combatEvents 中保留该来源。命中先记录接触快照再实施原伤害，所以致死与槽位复用仍可按身份消费；持续燃烧保留武器来源但不冒用初次命中的序号。

`presentation/vfx-planner.ts` 按 run/tick/weapon/slot/generation 与序号匹配射线/接触，不合并散弹的不同事实。所有 NPC 伤害复用既有事件游标：已有武器 GPU 命中则不重复星花，其他非燃烧伤害由 combat.damage 共用效果覆盖；真实burn tick携带只读 damageKind:burn，主要由原表面shader/烟反馈，不逐tick重建冲击星花。完整 combatEvents/伤害数字不减少。失败实例不抑制 Canvas，伤害数字/击杀文字保留。

`presentation/continuous-vfx-planner.ts` 在原职责内消费电锯/火焰/榴弹事实，逐 tick 更新头部和短轨迹、消费 projectile-end，并在真实爆炸事实处产生爆发。终止与多 tick 追赶不得复活过期头部。PlayVfx 统一装配七武器与标签，只有该次实际 drawable 后才抑制旧 Canvas；坏资源/缺图/预算不足仍走原保底。共享装饰池256不变；纹理由14增加至15/16，唯一新增纹理为 comic-grenade.svg，其余共享原图。

`NpcMotionPresentation` 从既有非burn伤害/死亡时间戳派生短受击脉冲，不改变原 hit/death 选片与优先级。RuntimeBridge 将脉冲与真实 burn 状态送入既有动态蒙皮实例；同 run 内必须匹配 id/generation 且 alive，死亡/过期/槽位复用不继承燃烧。

## 持久化与作者能力

`packages/scene/src/vfx.ts` 的独立效果资源版本 **9** 新增可选 `flow:{strength,speed}`，只支持 sprite；strength ∈[0,0.6]、speed ∈[0.1,8]，非法/旧版本携带新字段显式诊断。v1–8 经原 migrateVfxAsset 升至9，不凭空添加 flow，不改磁盘直到保存。场景版本仍23，没有新增场景语义。

原 VFX 面板增加“流动卷曲强度”“流动速度”，0关闭；Apply→Undo/Redo→Save/CAS→Reload 沿原 VfxDocument。typed DAG 源图仍为资产8/图2，在 sprite.params 增加可选 flow 白名单，旧图不变；原图节点属性面板、撤重/CAS和 runtime compileVfxGraph 保留并编译该字段至派生 v9 effects，派生 effects 仍禁止存回源图。原 compute/Ribbon/decal/soft 参数与交互不替换。

正式 comic-gameplay-soft.vfx.json 升9，原GUID/三帧图集与绑定保留。火焰60/s、上限48；烟8/s、上限16。火舌改为细长连续形状、薄墨线/亮芯，沿真实速度投影排布，卷动位移与帧内 UV 扭曲随模拟时间，带上升加速度与消散。装饰行程约4.75m加半图高度0.95m，不以装饰延伸真实6m伤害射程。soft 0.2m、原深度遮挡/透明排序保留。flow 发射目前显式 CPU 模拟兼容，GPU负责材质/绘制；不静默送入尚不支持flow的compute模拟。

## GPU 字节与生命周期

VfxPass 实例仍 **96B/24 floats**：20/21 保持 softDistance/bias，22/23 使用 flowStrength/flowPhase；无flow值为0，旧路径保持原样。相机 billboard 的flow效果按速度投影排列；其他效果仍用原随机旋转。UV扭曲限制在当前帧半像素边界内，避免采到相邻图集帧；保留预乘alpha、深度及aux描边mask衰减。

动态蒙皮实例仍 **80B/20 floats**：16/17继续 pose transitionWeight/snapshotMatrixBase；18为impactPulse；19为burnClock（0关闭，1+simulationSeconds开启）。原材质纹理/光照是底色，在原 dynamic.wgsl 的雾化之前叠加受击与燃烧；不覆盖原轮廓/HDR。燃烧在原模型局部坐标形成随皮肤三角面变形的炭化斑块、上移流动热丝与视角边缘发光，不是脚底sprite或整身红色tint。

时间只来自runtime tick/fixedStep和粒子age，不用墙钟。暂停重复帧保持时钟，原生单步推进一tick；真实 burning 消失/死亡/换代后19清0。Stop沿原 PlaySession ledger 销毁VFX与动态资源，重开重新装配，无持久shader状态或额外材质复制。

## 验证与边界

相关 owner 覆盖不可变投射物/终止、多 tick 追赶、精确来源去重、drawable失败回退、非武器受击、状态代次/暂停/单步/熄灭/Stop、flow边界/迁移、图编译与资源CAS。M4原图/compute/soft/Ribbon/decal相关回归仍运行；CPU替身通过不代替真实GPU。

开发有界 headed 已确认真实 NVIDIA、15纹理、实际flame喷流与销毁；首轮WGSL保留词失败保留，修复后8/8。当前还需独立七武器、真实NPC受击和燃烧表面、正常镜头/局部/连续帧与生命周期验收，未认定完成。基线七轮实际均手枪不能充当七武器对照；仅 flame/launcher 有实际ID确认的基线图。没有物理CFD、任意设备或高负载帧率承诺。


## R4-F01 持续燃烧反馈分离

首次独立 Audit 在 fb0bbed 的 `audit-fb0bbed/flame-live-burn-1.png` 观察到：真实burn状态及动态19时钟有效，但每tick DOT反复刷新强白脉冲并密集创建星花，遮住表面细节；该视觉缺口保留，不把仅通道数值非零当作表面可辨。

最小修正沿原 WeaponDamageFacts→CombatEvent 追加可选 damageKind:burn，只标记原持续燃烧扣血及其既有派生伤害，不改伤害公式/扣血tick/状态持续时间。未标记来源保留直接/环境受击；直接命中燃烧中的NPC仍触发一次原强反馈。NpcMotion原hit/death动画继续消费全部事件，单独的短冲击时钟不被burn tick重置；Bridge的NPC旧颜色闪烁也由该时钟门控，玩家路径不变。GPU与Canvas均不为burn tick画装饰星花，Canvas数字/击杀文字完整保留；这项样式规则不依赖粒子资源是否可画，非burn缺资源仍保底。原burning身份/生命周期继续控制表面Shader与烟，熄灭/死亡/换代不继承状态。

精准owner覆盖真实burn来源标记、原扣血总量不变、直接命中/未标记/坏粒子fallback、原动画保留、强脉冲自然衰减与burn kill不再触发强闪。正常镜头的真实burn表面可辨性仍需对新精确提交独立补验。
