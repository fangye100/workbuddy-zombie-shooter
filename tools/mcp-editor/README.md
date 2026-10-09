# Game Editor MCP：显式启用的编辑与诊断

适配器 v0.2 提供结构化流程发现及武器/音频运行检查。[开发指南](../../docs/43-GameplayDevelopmentWorkflow.md)
说明契约、职责及验收。适配器需要显式启用，尚未登记到用户 MCP 配置中；本次更新不代表已实现完整 Agent 覆盖或
达到生产就绪。`editor_workflow` 契约 v2 返回知识目录、分层和 CodeGraph 指南路径；
[共享入口](../../docs/README.md)不依赖 WorkBuddy 记忆服务。游戏模拟及表现位于 `packages/zombie-game`，
通用编辑、武器和碰撞 API 保留在 Framework。

## 配置与职责

`server.mjs` 把 MCP stdio 适配为仅监听 loopback 的 Vite broker。请求须明确指定已连接的编辑器实例。
浏览器派发器委托已有编辑状态、验证、undo/redo、保存服务和 PlayController，不另建场景状态，
也不模拟 DOM 点击。

启动 Vite 前设置 `AETHER_EDITOR_MCP=1`，并在选定标签的 URL 中加入 `?agent=1` 或 `&agent=1`；两者都需启用。
使用固定端口 5100，遵守服务归属规则，不为开启适配器替换其他会话的服务。连接或探活前须读取浏览器验证规则。
启用后的 stdio 示例如下，TLS 验证保持开启：

```powershell
node tools/mcp-editor/server.mjs --url https://fangye-win11-office.tail6b29a2.ts.net:5100
```

`--ca` 接受实际签发 CA 的证书包，不能使用叶证书替代。适配器连接 loopback 时仍校验 URL 主机名，禁止关闭证书验证。
远程 web 客户端及带 Origin 请求头的请求会被拒绝。启用 broker 或标签不会登记客户端，本次更新没有修改用户 MCP 配置。

## 工具与顺序

精确 JSON schema 由 `tools/list`（`catalog.mjs`）提供，未知参数会被拒绝。`initialize` 返回工作流说明。
除两个发现工具外，所有工具均需准确的 `instanceId`。全部编辑/Play 写调用还须提供当前
`scene_get.state.revision`，作为 `expectedRevision`。

| 工具 | 用途/限制 |
|---|---|
| editor_workflow | 阶段、真源、指南、检查、恢复和覆盖限制；无需浏览器实例，需 broker |
| editor_instances | 连接 UUID 与编辑/ready/dirty/Play，明确选目标 |
| scene_list、scene_get | 登记路径、完整文档、稳定 NodeId/revision |
| scene_create、scene_open | 事务创建/登记和显式打开；创建不切场景，未保存编辑阻打开，除非明确放弃 |
| scene_edit_nodes | 按 NodeId 原子批 1–128 操作，add/replace 完整 SceneNode，remove 可级联，共 UI 验证/历史 |
| scene_set_environment | 完整验证、可撤销 environment 替换，保其他字段 |
| scene_validate、scene_history、scene_save | 只读诊断、共享 undo/redo、冲突感知保存；validate→save→reopen→compare |
| editor_play | 初始暂停；resume/pause/step（1–600）/stop 共 PlayController，Stop 恢复/释放 |
| editor_runtime | 真实 tick/player/NPC/诊断/账目及复制的武器/音频事实 |
| editor_capture | 下一 GPU canvas PNG，不含 DOM HUD；无帧明确超时 |

先依次调用 `editor_workflow` → `editor_instances` → `scene_list` → `scene_get`。
修改材质、武器库或音频时，复制选定节点，只改相关组件，然后替换完整节点。
目前没有专用武器/音频 setter 或资产搜索。后续写调用使用返回的新 revision；其他参与者修改场景后须重读。
保留无关组件、引用和 GUID。

MCP 客户端 `tools/call` 的参数示例：

```json
{"name":"editor_workflow","arguments":{}}
```

```json
{"name":"scene_get","arguments":{"instanceId":"<selected live UUID>"}}
```

根据响应构造 `scene_edit_nodes` 参数：`instanceId`、`expectedRevision`、可选的 `label` 和
`operations: [{op: 'replace', nodeId: node.id, node}]`。其中 `node` 是修改后的完整 SceneNode 对象，不是 JSON
字符串。场景 schema 校验是判断数据有效性的依据。

## 运行诊断

`editor_runtime.runtime.weapons` 在停止时为 null；Play 中包含装备 ID、复制的弹匣/储备/等级状态、
当前行为、容量、换弹剩余时间、换装状态、升级成本、动作/阶段、局部持握/枪口/弹匣/弹膛标记、后坐/
换弹意图、最近 16 个已接受事件、数量受限的 hook 错误及活跃效果数。检查不会装备、射击或换弹，
也不会推进时间或调用 hook。

`editor_runtime.runtime.audio` 通过已有音频快照提供 AudioContext 状态、run generation、待解码数、缓冲/bytes、
voices/loops/peak voices、played/skipped、mute/gain 和 errors。Play 控制不能绕过浏览器要求的可信 Ready/Resume 手势。
Stop 后应检查资源账目 pending=0，以及音频缓冲、bytes、voices 均为 0。计数不能证明主观音质。
只读运行检查不需要 revision 参数，暂停或运行时均可用；场景加载须先建立编辑状态。运行事实不会持久化进场景。

## 失败处理

`editor_workflow` 返回结构化的恢复指引：

- REVISION_CONFLICT：重读，只基于最新状态重做目标改动。
- UI_DRAFT/UNSAVED_CHANGES/PLAY_LOCKED：协调草稿/保存/放弃或 Stop，不静默清人的编辑。
- NOT_READY：等投影/资产完成并检查状态。
- 保存 CONFLICT：保留本地修改，检查磁盘内容后再重试。
- COMMAND_FAILED：投影失败时，编辑可能已应用；检查返回的 revision 和历史。
- TIMEOUT：写入可能已执行；检查状态和磁盘后再决定是否重试，不能盲目重复创建或写操作。
- EDITOR_DISCONNECTED：重新发现，不自动换标签。

## 历史证据与覆盖缺口

历史验收包含真实 stdio 初始化/发现及 UUID 隔离。[2026-10-07 街景报告](../../docs/36-StreetQualityAndArchitecturalLOD.md)
记录了通过 MCP 完成材质 Edit→Save→Reload、磁盘颜色/GUID 核对及恢复的实际过程，更新了原型“从未实时写入”的
旧结论，但不认证全部语义编辑、竞争或断连路径。
当时自动测试覆盖 loopback、参数/实例隔离、超时不确定、关闭清理、流程路径及受控
broker 上的真实 stdio 初始化、工具列举与发现，没有浏览器参与。编辑测试覆盖 revision/草稿/Play 门禁、原子编辑、
历史、磁盘冲突/投影失败；武器诊断验证复制、不执行 hook/推进时间及最近事件上限。
不是新的有界面验收。

```powershell
node --test tools/mcp-editor/*.test.mjs
pnpm exec vitest run apps/editor/test/editor-agent.test.ts apps/editor/test/weapon-diagnostics.test.ts --no-file-parallelism
```

仍缺语义资产/组件发现、专用编辑控件、rig/IK 接入、运行动作命令、客户端登记、断连恢复，以及完整的
异步人机编辑竞争处理。完整 MCP 覆盖属于后续独立任务；相关行为变化仍需有界面硬件 GPU、
可见输入/UI 和游戏内审听。
