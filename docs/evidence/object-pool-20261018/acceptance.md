# 通用对象池验收记录

2026-10-18，开发基线 `ec1c8422`，分支 `codex/object-pool-framework-20261018`。
对应工作区源码摘要见 [source-hashes.json](source-hashes.json)，不是仅由HEAD推断未提交代码。

## 已交付与实际检查

- Core IObjectPool/ObjectPool、容量/闲置缓存、预热、同步hooks、归还/退休、clear/dispose、
  身份校验与统计；角色池、装配请求、贴花Entry、私有Projectile wrapper四处适配。
- 完整 Vitest：150文件，1843项通过（基线1819项，新增24项）。
- typecheck、architecture:check（333文件无越界）、knowledge:check、Editor/Game构建通过；
  构建保留已有chunk大小提示，不将它写为运行错误。
- [CPU差分](cpu-differential.json)：250贴花、40角色、300武器状态与指定基线模块完全一致。
  两边共享当前依赖/资产，不是完整历史checkout；空world武器差分不认证碰撞/伤害。
  这些业务仍由既有weapons、solid-ray、combat、导航和Editor owner测试覆盖。
- 20,000次emit/周期clear的CPU微基准6批交替：中位数基线 7.032ms、通用池
  8.110ms。仅隔离CPU复用额外成本，不是单帧成本、GPU时间或FPS提升；构造不在计时内。
- CodeGraph0.167.0结构刷新18文件/184节点/600边，使用已支持的 --no-embed；
  结构可查，解析恢复/未解析动态调用和向量覆盖4204/7995限制仍在。不用入边次数推导成本。

## 有界面硬件验收

[headed.json](headed.json)：严格HTTPS secure context、NVIDIA Lovelace、1600×1000可见
Chrome，GPU canvas942×560。真实工具栏鼠标点击进入Play/暂停/单步/重跑/停止，
加载57静态物件，24 NPC进入战斗；未捕获console error或exception。

实际 Game Editor MCP 使用 editor_workflow→editor_instances→scene_get，按准确实例、
revision及runId生成运行贴花；count=1，池active=1/free=255、capacity=256（来自场景
DecalEmitter）。切换direct/indirect时tick相同，输入均33项（不是称33项全是运行贴花）；
B稳定帧GPU读回14个视锥候选，非像素可见数。截图见 [direct](direct.png)、
[indirect](indirect.png)。此检查未重跑完整旧A/B时间戳基准，shader与GPU算法没有变更。

重跑后实际两次launcher发射，第一发created=1/acquired=1，第二发created=1/acquired=2/
reused=1，确认实际游戏路径复用私有wrapper。武器输入通过既有runtime hook注入，不将其
称为真人鼠标瞄准验收。Stop后场景仍57物件，ledger registered=96/disposed=96/pending=0；
作者33项贴花仍可渲染，不要求Stop后整场GPU贴花数为0。见 [Stop](stop.png)。

## 独立代码审核

- core/gameplay审阅发现并修复5项P2：失效外部槽归还占用、旧stats语义、请求异常租约、
  NaN identity不一致、同bucket退休重入。新增回归覆盖，最终无P0/P1/P2阻断。
  审阅方实际运行24项、typecheck及10,000次混合压力；正常热借用只固定次数检查，
  table retirementVersion变化才扫描失效ownership。
- render/runtime审阅发现并修复1项P2：definition复制失败导致投射物租约泄漏。
  复制前置并补原子失败回归；9个owner文件61项通过，最后新增CPU工具/指南静态审核通过。
- 审核均为独立子代理只读，未由开发者自我review代替；未运行Copilot PR bot，当前未创建PR。

## 保留边界

ObjectPool不提供裸引用ABA租约保护；异步资源/线程安全/GPU内存池不在该契约内。
CharacterPool/AssemblyQueue适配通用底层，但游戏NPC当前仍使用CharacterTable数值分配器，
不声称已改用按原型休眠预热。公开effect/历史向量、ECS槽位、攻击配额和GPU工作集保留各自
责任。旧launcher f5 fixture与旧整机smoke限制见[主线整合记录](../../architecture/main-integration-20261018.md)，
未将它们报为通过，也没有为对象池改动降低历史断言。未认证移动端/全部GPU或全游戏性能。
