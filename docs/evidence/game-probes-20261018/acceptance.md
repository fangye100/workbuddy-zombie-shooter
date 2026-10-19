# 战斗与动态蒙皮完整聚合验收（2026-10-18）

基线 `0231dda1516fb99bef2f867d3bc6241ba2339480`，当前分支
`codex/object-pool-framework-20261018`；本记录对应同笔修复提交。
检出 `C:/Users/fangy/Documents/Projects/visual-quality-20261007/game-design-zombie`。

## 修复与边界

战斗旧脚本的固定8/4编成已过期，正式第一层当前首房15个E-01、9个E-02；
新oracle直接从文件按房间和波次推导。旧脚本在长等待中可能被NPC击败或进入奖励选择，
不能用固定sleep认定世界仍在推进。现保留正式场景起始编成检查，再以已登记的schema v22
白盒验证可控输入、波次和终态。白盒近距目标由SpawnPoint摆放，不直接写table坐标或血量；
真实鼠标只负责瞄准，J键导致击杀，来源/身份三代/弹药/命中弹道/模拟减员均须成立。
公开applyDamage仅用于其后的清场与玩家死亡测试，不能冒充真实输入击杀。

动态装配按当前场景需求执行；正式玩家已有H-01作者模型，B-02已有rig-only，
旧“玩家永远胶囊/B-02本来缺档/全清单都应装配”均不再成立。故障注入仅限自建target同session、
GET、/__fs/file和精确B-02源GLB路径，其他请求继续；只生成503，不改资产、meta或manifest。
必须验证明确诊断、B-02从真模型退代理，finally撤销后下一局恢复真模型和palette重传。
动画以同runId/id/generation、移动、循环片和实际打包pose/phase为证据，
不把不同batch行当同一实体，也不误判死亡冻结为动画停摆。

四套件聚合入口现在逐套转发headed等参数，串行使用固定profile并隔离输出。
CDP命令超时/断连/发送失败会明确拒绝并释放pending，进程仍按各自finally清理；
Stop比对的是Play前作者基线。独立审核提出的负flags误放行已改为严格flags=1并补回归。

## 实际验证

完整命令：

```powershell
pnpm run editor:smoke:all -- --headed --out .workbuddy/tmp/aggregate-repair/all-2
```

2026-10-18 22:37:57–22:40:09（UTC+8），四套件串行实际运行，退出码0、
aggregate.ok=true、四个子进程status均0、notRun=[]。未把先前失败轮次当作通过结果。

| 套件 | PASS | FAIL | SKIP | console.error / 未捕获异常 |
|---|---:|---:|---:|---|
| 核心 editor-smoke | 122 | 0 | 1 | 0 / 0 |
| 绑定 editor-binding-smoke | 111 | 0 | 0 | 0 / 0 |
| 战斗 combat-probe | 18 | 0 | 0 | 0 / 0 |
| 动态蒙皮 dynamic-skin-probe | 35 | 0 | 0 | 0 / 0 |
| 合计 | **286** | **0** | **1** | 0 / 0 |

跳过仅为旧核心剪贴板内容读回：返回空值，HUD确切路径回显已通过。
另做了前置聚焦/真实鼠标菜单点击的定向实验，依旧读空；该实验失败不计入通过结果，
未将实验性的严格剪贴板改动带入本次交付，原因尚未定位。**没有认证剪贴板端到端内容**。
本次用户要求补跑的战斗和动态蒙皮共53项全部通过、无跳过。

[聚合结果](aggregate-results.json)、[完整输出](aggregate-console.txt)、
[核心结果](core-results.json)、[绑定结果](binding-results.json)、
[战斗结果](combat-results.json)、[蒙皮结果](skin-results.json)、[最终源码指纹](source-snapshot.json)。

## 关键实际证据

严格HTTPS MagicDNS、固定1600×1000 headed Chrome、项目专用profile。
实际编辑器GPUDevice.adapterInfo：secure=true、fallback=false、vendor=nvidia、
architecture=lovelace。核心/战斗/蒙皮均记录硬件；绑定使用同一受控headed启动路径。

战斗正式第一层tick0为E-01×15、E-02×9；Stop恢复57个作者物件。
白盒的6个NPC来自场景（E-01×3、E-02×2、B-02×1），开火目标从近距SpawnPoint产生，
鼠标持续投影跟踪同一身份，投影→瞄准平面射线往返误差约7e-5m、有限且小于0.001m。
目标由J键实际击杀、来源为玩家，NPC减为5、弹药减少且生成命中弹道。
清场后0存活，处理完等待边界前一个tick仍未投放，边界事件投放第二波E-01×3/E-02×1。
玩家死亡后30次手动单步及正常帧均冻结，游戏保持Play直至显式Stop，账目归零。

动态正式场景装配E-01/E-02，玩家由H-01作者模型呈现；逐行flags/base/stride/pose边界有效。
白盒B-02精确GLB响应503一次，meta等请求未改，明确诊断`B-02: Error: HTTP 503`；
其在场实体经实际capsule批次提交，flags=0，其他两类仍flags=1。
同一runId/id/generation的E-01在20→37 tick间保持walk并产生位移，实际pose及phase变化。
Stop后取消故障，新runId的下一次Play成功装配B-02真模型、恢复flags=1、清除失败诊断，
paletteUploadCount增长；最终Stop恢复作者基线并释放全部登记资源。

截图已实际查看：[第二波现场](combat-wave2.png)、[死亡终态](combat-game-over.png)、
[蒙皮与代理现场](dynamic-skin.png)。第二波截图可能仍有前一波死亡表现尾帧及正在装配的
代理，模拟存活数量取session.countNpc，不从截图或表现行数猜测。
这是白盒运行/装配证据，不把它称为正式关卡美术、全部动画或全部武器验收。

## 自动检查与独立审核

- `node --test tools/verify/editor-smoke-lib.test.mjs tools/verify/game-probe-oracles.test.mjs`：
  14/14；覆盖CDP断连/超时/发送失败、房间波次/未来装配需求、精确实例边界、故障请求白名单、
  聚合参数/输出隔离/失败后未运行列表。独立审核方也实际重跑14项通过。
- `pnpm run scene:check`：最终Camera/SpawnPoint改动后通过，28个schema v22场景；
  15项场景文件测试及资产/LOD/音效门禁通过，22个音效文件0失败。
- `pnpm run typecheck`、`pnpm run architecture:check`：通过；337文件、无分层错误。
- `pnpm run knowledge:check` 与 `git diff --check`：通过。
- 独立代码子代理终审无P0/P1/P2；已修负flags误放行、Stop基线口径，并审阅持续指针跟踪/
  Camera字段增量。浏览器运行由主代理负责，未拿子代理Node结果代替headed验收。

CodeGraph 0.167.0先查项目/指定模块，随后核对源码与实际接收者；改动后结构增量更新
15文件、0个本轮解析错误。project_map及工具/PlayController定向概览可返回。
embedding仅4007/8057覆盖，宽查询有未核对文件/动态派发限制，不能据此认定全图完整。
package脚本→Node子进程、CDP事件→页面输入两端以源码及本次实际运行确认。

## 保留范围

只交付本任务工具、测试白盒、项目登记与中文知识/证据；正式游戏规则、源模型和sidecar
没有本任务变更。仍保留上述剪贴板读回未认证项；本记录不推导帧预算、全部GPU/移动端性能、
完整关卡平衡性或全部武器/IK资源质量。其他检出与会话的在途资源保持原位。


后续闭环：上述剪贴板未认证项已在下一任务定位修复，见
[2026-10-19剪贴板完整验收](../clipboard-20261019/acceptance.md)。本页保留原轮次计数和限制，
不以新结果改写历史测量。
