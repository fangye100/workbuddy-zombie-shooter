# 程序贴花独立视觉 / VFX 修复复验

2026-10-13；独立子代理，检出/分支同基线报告。基线提交 `d18cfb7`，本轮为主代理未提交的 v20 改动；源码快照由主代理交付记录关联，本文不冒充该提交已含新实现。

## 实际环境与权限范围

Chrome 3 / hi.Fang；上轮1461636546已在turn结束自动关闭，本轮新自有tab1461636550。实际 headed WebGPU：vendor=nvidia / architecture=lovelace / fallback=false / isSecureContext=true。白盒schema20、18作者实例、40mesh；GPU18instance/1draw/4096B。第一层实际Play暂停tick74，GPU33instance/1draw/4096B。

仅UI调工作区草稿、切换图案/参数/视角、Play/Pause/Stop，受支持CDP只读诊断。未Apply、Save、作者场景写入。四参数与透明度操作前后作者文档JSON完全相同（`refined-author-isolation.json`）。最后已放弃草稿并Stop。

中途工作区被磁盘场景写入导致的Vite reload关闭，主代理确认来自其另一tab进行MCP持久化验收；非GPU错误。重新开工作区补齐截图，未把重载旧帧作验收。实际read logs warn/error为空。

## 九图案可见结论

每张 `refined-*.jpg` 均保存后用view_image实际目检；不是仅凭源码或旧截图判断。

| 图案 | 复验结论 |
|---|---|
| splatter | 基础通过；墨边/网点较基线减轻，主体与独立滴点成立，透明区干净。 |
| scorch | 原P1修复通过；可见透明内孔与边缘缺口，不再全封闭圆章。形状仍偏瓣状，属可进一步美术调参的P2。 |
| crack | 原P1修复通过；端点渐细，多段折线与弯折分支取代圆头直棍。 |
| hazard | 原P1修复通过；无完整黑框，有破损边缘；seed10→11使缺口位置确实变化。 |
| bullet-hole | 原P1修复通过；黑墨中心、米灰崩口及短放射裂缝已可区分，墙面局部前视成立。 |
| acid | 新增基础通过；黄绿不规则液斑、暗绿边及2–3个浅色气泡环，未中心白曝，明显区别油污。静态装饰不证明伤害地面。 |
| oil | 新增基础通过；蓝黑两个相连块面，无照片镜面；油污与焦痕/酸液可区分。 |
| paper | 新增基础通过；6片离散米色纸片/粗短代字线，无烘焙投影，无矩形底。规则矩形/平面散布还可更破旧，P2。 |
| rubble | 新增基础通过；5大+3小离散暖锈色多边形碎屑，块面与墨边成立；不是3D可碰撞瓦砾，规则多边形可继续精修，P2。 |

白盒坡道酸液随接收面倾斜，墙面油污/弹孔贴合指定局部朝向；遮挡柱仍遮住下方绿色斑块，无穿透。没有认证复杂曲面自动贴合或墙角裁切。

第一层33作者痕迹中新增油污/纸片/碎屑填补街景小面，游戏Play下不遮NPC主轮廓、不盖通行路线。作者第一层没有静态绿色酸液危险色，避免把装饰误认正在生效的伤害区域。道路既有共面灰黑条纹仍是范围外问题，不由新增贴花造成。

## 参数与UI

- 真实UI测试acid的coverage合法最小0.2与最大1、edgeWidth0与0.1、irregularity0与1、detail0与1。最小图案缩到安全小圆、最大产生夸张不规则瓣边与3泡，仍有透明安全边、不填满矩形。
- opacity0实际完全消失，仅剩棋盘；放弃恢复原图案。
- hazard seed10→11真实磨损变化；同一渲染机制不要求所有图案相同语义。
- 图案切换保用户颜色，显式「使用图案推荐色与形态」按acid设置#91bc38及相应推荐参数，UI可达。
- 首轮发现的oil.detail、rubble.irregularity、bullet-hole.detail、crack.edgeWidth原实现为无效或作用不足旋钮，已向主代理确认P1参数化缺陷。随后修复并完成真实GPU成对定向复验：oil.detail0→1从平蓝黑变成两档蓝色条块层次；rubble.irregularity0→1从相同大块尺寸变成不同半径/散布；hole.detail0→1实际4→6条放射裂缝；crack.edgeWidth0→0.1从细线变成粗裂线，端点仍渐细。全部能明确看到变化。
- hazard图案不再显示不适用的墨边spinbutton/slider，实际locator计数0，截图`refined-hazard-ui.jpg`确认。保留其coverage/irregularity/detail调参。
- 最终定向操作后作者JSON再次相等（`refined-final-isolation.json`）；warn/error日志为空（`refined-final-errors.json`）。已放弃草稿、关闭工作区，Stop按钮disabled确认不在Play。自有tab1461636550保留handoff便于主代理最后证据检查，未操作其他tab。

## 类型充分性与能力边界

九类型已经覆盖docs/31静态贴花48–55八项及额外血迹，补齐本次最小游戏/街景需求。不需要继续增加轮胎、苔藓等未声明类型来满足此次验收。

本次仅认证静态图案与工作区调参的可见表现，不认证：战斗事件自动血迹/弹孔/酸液落点绑定、酸液伤害地面、寿命联动、动态图集、飞行酸液、爆炸/枪口粒子、攻击范围预警、任意曲面投影、移动端或持续500NPC性能。主代理另有持久化、迁移、运行池与资源账目测试，本独立报告不替代这些门禁。

## 截图索引

- `refined-whitebox.jpg`：18实例平地/坡道/墙面/遮挡整体。
- `refined-{splatter,scorch,crack,hazard,hole,acid,oil,paper,rubble}.jpg`：九类型实际GPU独立预览。
- `refined-hazard-seed11.jpg`：对比seed10磨损位置。
- `refined-style-min.jpg` / `refined-style-max.jpg` / `refined-opacity-zero.jpg`：形态合法边界与全透明。
- `refined-wall-front.jpg` / `refined-recommended-acid.jpg`：朝向与推荐参数。
- `refined-floor1-edit.jpg` / `refined-floor1-play.jpg`：游戏构图和NPC读图；状态另见 `refined-gpu-play.json`。

最后定向截图（均实际逐张view）：`refined-crack-edge0.jpg` / `refined-crack-edge01.jpg`、`refined-hole-detail0.jpg` / `refined-hole-detail1.jpg`、`refined-oil-detail0.jpg` / `refined-oil-detail1.jpg`、`refined-rubble-irregular0.jpg` / `refined-rubble-irregular1.jpg`、`refined-hazard-ui.jpg`。

**最终结论：本次静态贴花种类、基础美漫图案表现、指定参数真实作用、工作区草稿隔离和第一层实际Play可读性独立复验通过；无剩余P0/P1视觉问题。** 保留scorch瓣状大轮廓、paper轮廓过于整齐、rubble偏规则多边形等P2精修空间。没有逐像素匹配在线Ardot，也不宣称整个游戏美术匹配完成；事件驱动动态痕迹、伤害与复杂表面投影仍是上文明确未认证/未实现范围。
