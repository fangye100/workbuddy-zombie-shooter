# 战斗程序贴花独立视觉 / VFX 验收

日期：2026-10-13；独立子代理验收。检出 `C:/Users/fangy/Documents/Projects/visual-quality-20261007/game-design-zombie`，分支 `codex/procedural-decals-20261013`，源码基线提交 `b0e972c47cdff08ebd5bfdbf142a572195b3074c`，本次验收对象是该提交之后尚未提交的 schema21 战斗贴花实现。本文不把主代理历史截图、构建或静态图案验收冒充本次动态事件证据。

## 方法与环境

已读当前AGENTS、浏览器验证入口、浏览器/GPU规则和Chrome连接规则；复用受支持Cua Chrome3 / hi.Fang，另建自有唯一probe tab1461636557，未碰主代理1461636554或用户标签。真实 headed WebGPU：nvidia / lovelace / fallback=false / secure=true，详见 `review-hardware.json`。

Editor MCP stdio已实际initialize/tools/list，并先读editor_workflow，再exact URL选自有实例、scene_get读取revision。**没有使用editor_decal emit**，没有手工append战斗事实，没有设置伤害/位置模拟假事件。真实输入为J和鼠标墙面点击，辅助瞄准在可见UI关闭后定向打墙。只读CDP用于关联事实、GPU、资源与作者JSON；步进通过正式editor_play。截图均实际保存后逐张view；不是仅凭Canvas存在验收。

主代理两次范围明确的小修复触发HMR，已停止该轮观察并重新打开最终冻结版本，不将旧run或reload前后状态拼接成同run证据。

## 原配置真实事件

场景：`assets/scenes/sandbox/combat-decal-whitebox.scene.json`。原配置容量256，每类128/96/32；TTL35/22/7s，fade5/5/2s。

自有run1真实J射击后：tick74产生acid-land，slot4/generation1，落点[0,0,0]、radius2、activeSec4；tick125产生npc-damage，slot3/generation1，点[1.6136,0,-0.8531]。分别生成同run的4×4m酸液痕迹和0.85×0.7m脚下血迹。真实关闭辅助瞄准、鼠标向墙定向/J发射后，tick267产生weapon-solid-impact（pistol，receiver=nd_combat_wall），命中点[-1.5816,0.9,-5.75]、法线+Z，对应0.22×0.22m弹孔。详见 `review-ground-events.json`、`review-wall-hit-second.json`。

暂停tick272时，4实例（旧酸池fade+血迹+新酸池+弹孔）/1draw/4096B。`review-paused-a.json` 与 `review-paused-b.json` 跨多轮观察的tick及marks完全相同，暂停没有按墙钟淡出。`review-combat-ground.png` / `review-combat-wall.png`记录原游戏视角。

原白盒105°默认相机位于命中墙面的侧后方；背面看不见+Z正面的弹孔是正确深度遮挡，不能因此判弹孔没绘制。为完成局部目检，后续在**自有页内存**通过scene_edit_nodes设Camera yaw0、distance16，未save盘；末尾恢复。默认机位的验收可读性被列P2，主代理将默认机位改为正面后补验，见下文。

## 可见效果、寿命和上限实验

临时内存规则：blood/bullet ttl3s、fade1s，bullet.maxAlive1；酸液仍原配置。仅用于加快有界观察，不把短TTL参数当正式配置。临时完整节点变化详见 `review-short-parameters.json`；通过Play前快照和Stop回滚与作者隔离，不修改源JSON。

run2中真实npc-damage tick0生成脚下血迹，NPC移开后红色飞溅留在原地，见 `review-short-visible.png`。真实pistol墙面事件tick26生成弹孔，同画面墙正面与 `review-wall-detail.png` 局部可见小黑点，未浮空或画在背后。0.22m孔在俯视画面只有数像素，本轮认证可见黑墨中心与事件位置关系，不宣称该距离可辨别所有短裂缝。

| 检查 | 实际结果 |
|---|---|
| 血迹淡出 | tick75 / time2.5s：opacity0.43，remaining0.5s；画面较初始飞溅明显变淡。tick101已回收。 |
| 弹孔淡出 | tick101：opacity0.475，remaining0.5s；tick117已回收，GPU只剩酸池。 |
| 酸液有效期保护 | tick74落地，active4s；tick194（有效期终点）仍opacity0.84、remaining3s，未在伤害期提前fade。 |
| 酸液残迹fade | tick239：已超过active4s，opacity0.63、remaining1.5s；实际画面没有有效酸池危险圈，留淡色腐蚀痕迹，见 `review-acid-fade.png`。 |
| 酸液回收 | tick285原combat_acid_3已不存在；tick254新的acid-land生成combat_acid_4，不能把新液池误当旧实例未清。 |
| 每类上限 | 自有run3临时bullet.maxAlive1；真实墙面两次命中后，旧bullet_2被bullet_3替换，只保留1弹孔，planner.ruleEvicted=1；不是人工emit。详见 `review-limit-mcp.json`。 |

低上限实验验证实际接入的淘汰路径；正式256容量及128/96/32各上限定义已核对，但**本独立视觉验收没有灌满256真实战斗实例**，不把主代理CPU门禁或旧512emit压力证据当本次真实战斗压力测试。

三类痕迹均落实际接收面、透明边缘无矩形底或方块描边、没有穿墙、不会改变NPC/玩家行为或伤害。酸液色与血迹明显区别。脚下血迹暂被NPC/酸液覆盖是正常深度/优先级，NPC离开后留痕；整体未盖住角色主轮廓。

## Stop、隔离与异常

- 原run Stop：ledger5/5/0，池0、GPU0instance/0draw/0B；作者JSON与Play前完全相等，见 `review-stop-original.json`。
- 短TTL/低上限实验结束Stop：ledger10/10/0（累计两次Play），池0、runId=null、GPU0/0/0；作者回到临时实验快照。
- 随后scene_edit_nodes恢复原Camera与Emitter，原作者JSON完全相等、revision1c7ffc8f。没有调用scene_save，磁盘没有被验收改写。工具仍标dirty=true属于此页编辑历史标记，不表示作者内容未恢复；自有标签已关闭，见 `review-final.json`、`review-isolation.json`、`review-stop-mcp.json`。
- 日志5条warn：4条白盒P-01没有“+动画”LOD档而回退胶囊；1条尝试Play自由相机被明确拒绝（随后改用正式临时Camera实验）。没有GPU编译/验证错误或业务异常。曾使用错误只读诊断表达式把runtime对象当函数，工具返回TypeError；未影响游戏状态，未用于证明实现故障。

## 结论与限制

独立真实输入已完成三类事件→痕迹、局部可见、模拟寿命/fade、暂停、低上限淘汰、Stop与作者隔离闭环。当前范围无P0/P1视觉故障。

P2：0.22m真实弹孔在俯视中仅数像素，勿为截图无界放大；明亮白盒地面上的血迹偏淡，正式道路需按具体明度/镜头调色。全关卡镜头/远墙可读性仍需后续美术调参。

能力限制：贴花是单平面，不认证跨墙角/曲面贴合或任意几何投影；没有认证移动端、256满池实战或500NPC性能。本报告不把贴花认作伤害真源，酸液伤害期来自实际acid-land事实与游戏模拟；视觉只消费它。正式三关启用与Collider补齐由主代理门禁/实际Play补充，本独立动态输入覆盖白盒，不宣称逐关全流程已玩通。

### 默认正面机位补验

主代理将白盒Camera及生成器持久化为yaw0 / distance16后，另建自有唯一probe tab1461636564直接开默认场景；未执行任何临时场景编辑。读取实际Camera确认上述值，关闭辅助瞄准后真实鼠标墙面点击/J射击，tick83产生pistol weapon-solid-impact（point[-1.7195,0.9,-5.75]、normal+Z），暂停tick94，GPU2实例/1draw/4096B（酸液+弹孔）。默认正面墙上可见小黑弹孔，`review-default-visible.png`和`review-default-wall-detail.png`已实际view；因此默认机位P2已修复复验。

该次Stop ledger5/5/0、GPU0/0/0、池0、作者JSON恢复，见`review-default-stop.json`；自有1461636564已关闭，未触碰其他标签。**本次动态战斗贴花独立验收通过，无待修P0/P1，保留远距弹孔尺寸和白地血迹偏淡两项非阻断P2/能力限制。**
