# Editor、Framework 与游戏代码分层契约

## 必须遵守的职责边界

| 层 | 位置与公共入口 | 职责 |
|---|---|---|
| Framework | `packages/core`、`gfx`、`framegraph`、`scene`、`render`、`ai`、`gameplay`、`runtime`；`@aether/<package>` | 可复用数据契约、资源、渲染、数学、导航、武器机制、碰撞及编辑命令 |
| 僵尸游戏无界面内核 | `packages/zombie-game/src/index.ts`；`@aether/zombie-game` | 角色数据消费、场景到关卡装载、房间/波次、NPC 攻击、奖励、游戏 Play 组合和音频事件投影 |
| 僵尸游戏表现层 | `packages/zombie-game/src/presentation`；指定 `@aether/zombie-game/presentation/<module>` | HUD、语言、控制、叠加反馈、存档与 Web Audio；读取游戏事实、调用游戏命令 |
| 游戏内容 | `packages/content`、`assets/scenes`、`assets/behaviors`、资产 sidecar | 场景文件持有场景实例/配置；角色 roster/stat JSON、项目清单和通用 sidecar 各有真源；生成 API 是派生产物 |
| Editor | `apps/editor/src` | 编辑 UX、绑定、Inspector、历史/保存及编辑器专用渲染/Play 适配 |
| 宿主与工具 | 示例入口、编辑器 Vite/devfs、`tools` | 组合、进程/文件/网络适配、MCP 传输、离线生成和验证 |

Framework 禁止依赖游戏内容、游戏逻辑、表现层或编辑器。无界面游戏可依赖 Framework
和内容，不得依赖表现层/编辑器。表现层可依赖游戏内核/Framework，不能依赖编辑器。
编辑器/宿主通过明确的接口组合服务。仅类型引用同样属于架构依赖；不能因为功能是纯 CPU
或使用抽象类，就把某个游戏的专有逻辑移入 Framework。

跨包通过公共 `@aether` 入口引用。表现层公共子路径在 `tools/architecture/layers.json`
中明确列出，任意深层引用会被拒绝。无界面入口不得重新导出 DOM 模块。
第二款游戏应有独立游戏包，向 Framework 注入数据/策略，不应修改僵尸奖励、角色 ID 或
HUD 才能使用引擎。

## 数据与失败行为归属

- 场景/schema/项目/sidecar 真源仍在 `packages/scene`；本次迁移未引入第二份场景缓存
  或内联资产。稳定 NodeId、带 GUID 的 AssetRef、迁移诊断和场景登记规则继续有效。
- “场景是唯一内容载体”禁止硬编码场景实例，不要求把角色定义或可复用资产元数据复制进
  每个场景。`aether.project.json` 持有场景登记/启动选择，roster/stat JSON 持有角色
  定义，同名 sidecar 持有可复用资产设置。
- 通用编辑命令、行为端口、线段/实体碰撞、弹药、装备计时和武器策略保留在
  `@aether/runtime`。
- `RuntimeSession`、僵尸关卡装载、`RunProgress`、敌人攻击、`AudioFramePlanner`、
  刷怪 A/B 和游戏 `PlaySession` 归 `@aether/zombie-game`；全部宿主使用同一实现。
- 输入、视口投影、存储和可信音频交互由宿主提供；渲染/DOM 不计算伤害或奖励。
  Stop 恢复编辑状态并释放完整 Play 资源账目。
- 动作阶段与击杀快照属于游戏内核；NPC 受击/死亡显示尾部属于公共表现子路径
  `npc-motion`，不复活模拟实体。四向速度转换属于 Framework；源动作裁剪点和 profile
  属于资产内容，Editor 仅装配/打包/观察。实现及验证边界见
  [动作接入指南](../animation/ani-gameplay-integration.md)。
- `game:build` 生成分离的 Framework/游戏 bundle；`runtime:build` 只构建 Framework。
  一致性检查/模拟使用游戏 bundle。旧消费者必须改引用，不能用反向导出兼容层规避分层。

## 强制门禁与评审责任

`pnpm run architecture:check` 解析配置根目录下的生产 TS/JS，检查职责、静态 import/
重新导出、类型引用、字面量动态 import/require、`import.meta.glob` 及
`new URL(..., import.meta.url)` 资源引用（含 Worker）。Framework/无界面内核的
非字面量模块派发必须通过宿主接口。缺失别名、未知包职责、禁止依赖及跨包相对引用均失败。
仅服务端的 Vite/devfs 明确属于宿主，因此浏览器编辑器模块不能 import 工具代码。
当前版本不需要保留反向依赖白名单。

Node 测试覆盖绕过门禁及失败路径；CI 运行架构和知识门禁。清单不能证明语义复用：即使
import 没暴露问题，也不能把僵尸 ID、奖励公式、关卡状态或宿主 UI 加进 Framework。
Python 依赖、文本生成代码和消息载荷语义需要源码评审，不属于此检查器的认证范围。

测试随实现职责归属：僵尸模拟/表现测试位于 `packages/zombie-game/test`；通用编辑/
武器/碰撞测试位于 runtime；编辑器适配/Play 集成测试留在 editor。工具使用独立
Node/Python 运行器。迁移文件不等于验收，仍需验证引用解析、相同输入的模拟一致性和
可达的有界面 Play 路径。

## 后续整理

v15 共享场景契约保留旧内建、游戏特有的 `RunRules`、天赋/主题/武器定义和兼容工厂。
抽成版本化扩展系统需要专门的 schema/迁移任务；本次重构保留已有数据，没有宣称完成
该迁移。`apps/editor/src/main.ts` 仍同时组合游戏端口与编辑器启动，拆分启动适配器是
后续结构工作，不能以此为由增加玩法公式。绑定/Retarget 编辑归 Editor，通用 IK/姿态
混合归 render。以当前源码职责为准，不沿用历史报告的旧文件位置。
