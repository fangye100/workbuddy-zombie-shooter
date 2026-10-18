# 2026-10-18 开发主线整合记录

## 范围与数据责任

整合起点为 origin/main `89f5a806`。动画分支 `a4f4ad68` 可快进；
贴花分支 `ae23100c` 含三维群体导航 `384b381e`，与动画线执行保留双方数据的合并。
其余已提交开发分支已被原主线包含；提交后再次检查全部本地及 origin 分支的祖先关系。
其他检出目录的日志、草稿和未入库资产交付保留原位，不代表已经发布或验收。

## schema v22：统一两条已发布历史

动画线 v16/v17/v18 分别加入可选姿态层、武器模型装配、骨相对持握槽；导航线同版本号
用于群体导航、三维地表和动态门，随后 v19–21 加入贴花。不能用同一数字猜测数据来源。
保留导航/贴花 v15→21 迁移链，新增 v21→22 桥接，仅对 undefined 补齐
`NavZone.crowd` 和武器 `presentation.assembly=null`。作者值、显式 null、非法值、未知
可选字段均保留，由 validator 诊断；不覆盖 poseLayer、boneSockets、BodyIK、holdSlot。
26 个场景统一 v22；生成工具通过公共 schema 加载器读取版本及导航默认值。

迁移测试保留两份真实发布快照（main v18、decal v21）；v16/v17 为两种字段族的版本
兼容测试，不能称为该版本的真实发布快照。独立审核按稳定 NodeId/weapon.id 比对
135 处字段/组件，包含 75 个导航/贴花组件，未发现两侧数据丢失或改写。

## 实际回归与限制

- 全量 Vitest：147 文件，1819 项通过；类型检查、Editor/Game 构建通过。
- architecture:check、knowledge:check、motion:check、scene:check 通过。
- MCP adapter、场景公共契约、武器生成/持握继承 Node 测试：10 项通过。
- 独立审核：迁移 owner 66 项、额外20项畸形值检查；Editor/Render owner 43 项通过。
- 旧 editor:smoke --headed 未完成：起始场景已无其所需的可渲染父子拖拽夹具，且其启动
  判据早于资产及完整事件绑定就绪。它不能作为本次整合通过证据。
- 旧 launcher-assembly-calibration 的 f5 肩链/模型投影夹具未记录当前 Hip 持握基准，
  两项检查失配；相关生产代码、武器资产和该历史测试相对动画分支无变化，保留问题，
  不改历史样本或降低断言来制造通过。新四向模拟枪口56项与作者持握点闭环已通过。
- CodeGraph 0.167.0 当前检出的结构增量索引更新283文件；embedding阶段遇另一writer锁
  中止。project_map及指定core/gameplay/render/runtime/ai模块概览实际返回，解析恢复/
  动态调用及embedding不完整限制仍在，以源码核对责任与接收者，不声称全图无遗漏。

有界面定向验收通过：严格 HTTPS、NVIDIA Lovelace，第一层 57 个静态物件，Play 后
24 NPC，暂停、单步开火、重跑 tick=0、Stop 恢复57物件；Play ledger 96/96释放、
pending=0，console error/exception均空。脚本等待资产完成且真实帧循环启动，实际鼠标
点击工具栏；setFire是确定性输入注入，不替代鼠标瞄准验收。证据见
[结果](../evidence/main-integration-20261018/result.json)、
[战斗截图](../evidence/main-integration-20261018/play.png)、
[Stop截图](../evidence/main-integration-20261018/stop.png)。
本次确认整合行为；画面美术与武器肩链的全面重新验收不属于该结论。
