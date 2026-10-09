# 分层与共享知识交付验收报告（2026-10-09）

## 代码范围

基线：集成主分支 `90d6427`，两个父提交为场景开发 `32e1689` 和 HumanIK `38d2d19`。
开发分支：`codex/architecture-boundaries-20261009`。
主分支集成另见[集成报告](../review/branch-integration-2026-10-09.md)。
未跟踪的 WorkBuddy 资产交付、需求草稿及已有修改的 10 月 5 日日志保持原样。

7 个僵尸游戏模拟模块、13 个游戏表现模块及 HUD CSS 迁入 `packages/zombie-game`；
21 个测试/夹具文件随实现迁移。公共 import 和 CLI bundle 明确区分游戏与 Framework。
Framework 不再保留反向引用游戏或编辑器源码的例外。

通过 Git 将小写 `agents.md` 改为 `AGENTS.md`，支持大小写敏感主机的自动发现。
入口明确三层契约、CodeGraph 优先导航及共享知识发现。文档目录包含版本化指南、源码
契约及历史 WorkBuddy/项目文档，以稳定 ID、职责、主题、权威和状态区分复用入口与证据。
`editor_workflow` 契约 v2 返回同一套知识、架构和 MCP 路径。
架构与知识检查已加入 CI；本地结果如下。

## 实际验证

- 相关编辑器/Framework/游戏 Vitest：77 个文件、1,017 项通过。移除旧反向导出后，
  修正 4 处测试 import，并重跑相关 37 项通过。真实 glob 音频回归新增 2 项通过，
  音频生命周期另有 3 项通过。
- 类型检查、编辑器构建、分离的 Framework/游戏 CJS bundle 通过。
- 同一 v15 场景、seed 7、固定 1/30 步长、tick 180：重构前后文档指纹、实体身份、
  位置、目标和状态一致；25 个实体，最大位置差为 0。
  [比较输入](../evidence/architecture-2026-10-09/parity.json)。这是 Node 上的重构一致性，
  没有新增 Node/浏览器跨宿主认证。
- 架构源码依赖门禁：257 个生产 TS/JS 文件，无禁止依赖。排除测试/生成缓存；Python
  和消息语义仍需源码评审。架构/知识/MCP Node 测试 29 项通过。
- 知识查询能找到当前动画指南；目录的路径、ID、分类、真源引用及已跟踪文档覆盖检查
  通过。未跟踪的音乐/语音草稿未登记或验收。
- 实际连接 CodeGraph MCP 0.167.0，在迁移前后查询项目图谱及 runtime/控制模块。
  增量索引返回更新 153 个、移除 42 个文件，嵌入计算完成。存在并发索引锁警告和 4 个
  Tree-sitter 解析标记，TypeScript 检查仍通过；深度 2 的同名调用推断未被直接视为
  源码依赖。详见[查询记录](../evidence/architecture-2026-10-09/codegraph.json)。
- NVIDIA Lovelace、有界面安全 Chrome：可见 Play、中英文 HUD、7 种武器；通过 HUD
  选择 Pistol→SMG，并以 16 次可见单步完成换装。22 个音频缓冲装载，环境和敌人预警
  事件播放，无音频错误。真实运行首次发现文件迁移时音频路径前缀漏斜杠，修复后用实际
  AssetRef 测试覆盖，而非只依赖 mock。
- Stop 恢复场景中配置的 Pistol，4 个登记资源全部释放，待释放 0；音频关闭，缓冲、
  字节数、声音和循环均为 0。浏览器错误日志为空。

证据：[Play 状态](../evidence/architecture-2026-10-09/play.json)、
[Stop 状态](../evidence/architecture-2026-10-09/stop.json)、
[有界面英文 HUD 截图](../evidence/architecture-2026-10-09/play-en.png)。

本次结构提交没有改变场景或资产数据；集成主分支此前已通过 `scene:check`。
没有新增实体手机性能或人工音质验收；已有大 chunk/CJS 警告仍存在。

场景契约扩展化及启动入口整理仍记录在[分层契约](layers.md)。当前保留旧内建
RunRules；import 门禁不等于证明所有算法在语义上都已通用化。
