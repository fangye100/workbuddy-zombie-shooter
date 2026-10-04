# 场景工作区与关卡体验改进（待可见验收）

## 基线与范围

基于远端 `origin/main` 的 `5aade8f`，在独立分支 `codex/scene-game-refine` 开发。原工作区及角色资产处理均未改动。设计依据为 `docs/13-玩法与关卡设计GDD.md`、本地环境概念图 S-01/P-11 和 `assets/environment/props.json`。

基线确实通过项目 `startIndex` 自动加载第一层，顶部仅有 Skeleton 菜单，缺少项目场景选择入口。运行时已有移动、射击、波次和胜负状态，但事件房的 interact 与精英房的 elite-dead 未实现，三层关卡无法按作者设定完成。材质 override 已有存储契约，却未完整应用到编辑器渲染槽。

腾讯设计页尚未读取：浏览器控制未发现用户 Chrome，打开请求超时。不能据此宣称与在线设计一致。

## 本次实现与责任

| 责任 | 实现 |
| --- | --- |
| EditorMenu / scene-workspace | 文件、编辑、场景、渲染、资产、运行、视图菜单；项目场景搜索、打开、新建、另存为、重载、保存与脏状态提示；URL 显式选场景，默认仍服从项目 startIndex |
| devfs / create-scene | 校验新文档，限制场景路径，拒绝覆盖和重复 ID，持项目写锁登记 scenes；不改变 startIndex |
| SpawnEditStore / AuthorSceneSaver | 复用原作者状态、撤销重做、CAS 保存；增加环境光、半球光、雾、轮廓光和曝光的持久化，保留未暴露字段 |
| scene schema / migration | v6 增加房间 clearTarget 稳定 NodeId 与可选 MeshRenderer.editorOnly；v5 迁移明确补 null，不猜精英目标；目标须指向本房间刷怪点 |
| RuntimeSession / PlaySession | 空间范围内显式事件交互；指定精英死亡清场；重复交互拒绝、重开复位；三层作者关卡可达到 floor-clear |
| GameHud | 生命、时间、敌人数、房间进度、目标、交互、失败重试和下一层；HUD 仅读取 runtime，动作返回 PlaySession |
| Renderer / scene-material / scene-light | 消费嵌套材质 override，稳定 primitive 匹配优先于下标；不修改共享材质；主光方向来自场景世界旋转 |
| 场景生成器 / 作者场景 | 灰蓝道路、暖色事件区域、路缘与道路标线、材质粗糙度和描边、侧向主光；显式资产 guid；编辑标柱在 Play 隐藏，Stop 恢复 |

新增场景使用已有合法空场景模板；空场景没有玩家出生点时，Play 明确拒绝。新建时文件先以 `wx` 写入，再更新项目清单；普通更新失败会回滚新文件，但这不是跨进程崩溃的多文件原子事务。崩溃后仍可能留下未登记文件，应显式检查、恢复登记，不能静默覆盖。

## 已执行验证

- TypeScript 类型检查通过。
- 相关场景、运行时和编辑器测试：31 个测试文件、602 项通过；随后新增的精英目标归属与编辑标记回滚验证所在两文件共 51 项通过。
- `node tools/verify/scene-create.mjs`：创建登记、禁止覆盖、路径越界拒绝、并发重复 ID 冲突通过；测试仅写隔离临时目录。
- `pnpm run scene:check`：105 个资产元数据同步，8 个场景已为 v6，12 项场景文件检查通过。
- `pnpm run editor:build` 通过；保留 Vite 现有大 chunk 提示。
- 原工作区可见基线已通过 HTTPS 打开，HUD 显示 NVIDIA Lovelace。该证据仅证明原版使用真实 GPU，**不属于本次新版视觉验收**。

运行时三层通关测试直接施加伤害来验证清场状态机，不能替代玩家操作与难度平衡测试。

## 尚待完成的验收与设计工作

新版服务需要占用项目固定 5100 端口，目前该端口属于原工作区。已询问是否允许临时切换并在验收后恢复，尚未获答复，因此未重启服务、未另开端口。

获准后应在 headed、真实 GPU 下逐项验证：菜单开合和窄屏布局；场景搜索切换；未保存离开与取消；新建及另存为登记；编辑/保存/刷新一致性；环境撤销重做；Play 编辑标记隐藏与 Stop 恢复；真实移动射击、事件交互、精英击杀、失败重试、三层跳转；记录 GPU、截图和控制台错误。

连接用户已登录的 Chrome 后，继续阅读腾讯在线概念设计，对照场景构图、角色尺度、光照与材质。当前没有宣称完成视觉对齐或 Shader 质量验收。

GDD 的完整掉落与货币循环、天赋和商店选择、可交互事件内容、专属 Boss/危险区机制及 5–8 分钟节奏平衡尚未实现。本次事件动作只完成房间通关语义；下一层通过场景重载进入，不携带跨层成长状态。原有结构编辑与任意材质面板参数也未全部纳入保存白名单；本次新增可保存范围仅为已列明环境字段。这些限制必须随交付公开，不能把本分支视为“全面提升已完成”。


## Copilot review follow-up (2026-10-04)

All four findings from review 5403675361 were confirmed against the reviewed commit and addressed:

- 4175606600: `RuntimeSession.interactionTarget()` is the read-only eligibility source for both the interaction command and HUD prompts/buttons. The regression covers an untriggered room, live combat enemies, successful interaction, repeat rejection, reset and player death.
- 4175606628: material resolution checks loaded instance definitions explicitly. Missing instances fall back to their serialized base with a diagnostic, including bindings wrapped in overrides. Tests also preserve loaded instance state and shared material isolation.
- 4175606644: elite checks read the entity table and source slots directly. The regression forbids `view()` while an active elite room runs and clears with surviving escorts.
- 4175606660: dynamic menu/dialog labels, placeholders, accessible names and local status messages use the established translation path and English dictionary entries. Authored scene names and paths remain unchanged.

Validation: 74 tests across the six affected runtime/editor suites passed, TypeScript passed, editor production build passed, and all 77 literal menu/dialog translation calls resolved without Chinese fallback in English mode. Existing Vite chunk-size warning remains. No assets or scene documents changed in this follow-up. Headed UI/GPU acceptance and the previously documented design work remain outstanding. These are implementation fixes, not a claim of Copilot approval; review threads have not been marked resolved.
