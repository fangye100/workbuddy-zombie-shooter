# 程序贴花独立视觉 / VFX 基线验收

2026-10-13；独立只读子代理；基线 `d18cfb7941163dc4ceb968186dd963bf488b4744`。
检出：`C:/Users/fangy/Documents/Projects/visual-quality-20261007/game-design-zombie`。
Chrome 3 / hi.Fang，自有 tab 1461636546；首次 getBrowser 60s 超时、kernel reset，后续 getState 成功（约1s）且独立 tab 创建成功。未重启浏览器、未触碰他人 tab。受支持 Cua CDP 仅读取 GPU 与渲染状态；UI 仅开工作区、选现有 mark、Play/Pause/Stop，未 Apply/Save。

## 实际范围与依据

- 真实 headed Chrome；安全上下文 true；adapter vendor=nvidia，architecture=lovelace，fallback=false。
- 白盒作者12实例、1 draw；第一层玩法24实例、1 draw，暂停于 tick57。
- 实际逐张保存并 view 了 `baseline-whitebox.jpg`、五个 `baseline-{splatter,scorch,hole,hazard,crack}.jpg`、`baseline-floor1-edit.jpg` 与 `baseline-floor1-play.jpg`。首次 hole/crack 立即截屏有更新时序问题，已重新观察正确图案并重写截图，不使用空白旧帧作缺陷证据。
- 依据 `docs/31-美漫画风资产需求与生成提示词.md` §4 第6行48–55，`docs/38-GameplayActionAndVfxAssetBrief.md` VFX-COMBAT-ATLAS-02，`docs/art/visual-quality-playbook.md` §1/6/8/10，GDD §2割草密度/随机可读和§4腐液压力。
- CodeGraph 0.167.0 stdio initialize/tools/list/project_map/module_overview 实际成功；map有38个未核磁盘文件，图谱只用于定位，未根据调用计数推断GPU成本；图案事实核对 `packages/render/src/procedural-decals.ts` 与当前截图。
- 未实时打开在线 Ardot，不能宣称逐像素匹配在线图稿；使用本地版本化brief和实际游戏构图完成本次判断。

## 现有图案结论

| 图案 | 结论 | 优先级与实际问题 |
|---|---|---|
| splatter | 基础可用，限制通过 | 暗红飞溅轮廓与独立滴点可读；透明区无矩形底。P2：黑边与内网点偏重，俯视缩小时会成为黑斑，建议墨边/细节可调；非写实组织，符合克制血迹。 |
| scorch | 渲染成立，美术待修 | P1：不规则轮廓避免完美圆盘，但内部封闭整块、同心明暗像圆章；缺brief要求的透明破口与断裂外笔触。 |
| crack | 美术不通过 | P1：呈三条笔直圆头棍状支线，虽然透明/朝向成立，但缺不均匀宽窄、曲折分叉和暖灰断面；第一层重复规则交叉形非常显眼。 |
| hazard | 美术不通过 | P1：完整黑矩形框和完美直边，明确违背无边框/边缘破损警戒漆；seed源码不进入hazard形状。 |
| bullet-hole | 美术不通过 | P1：米灰花形饼配中心黑圆可作弹孔基础，但缺4–6条短放射裂缝；中心与崩口外圈关系像图标，不像粗墨破损。 |

白盒斜坡血迹/裂纹随表面倾斜；墙面弹孔/裂纹朝向正确；遮挡柱遮住底下血迹未穿透。透明没有黑方块边缘。第一层血迹/焦痕不会遮住角色主轮廓、清楚区别路漆；游戏视角已有共面灰黑条纹属于既有道路问题，不归因于本次程序贴花。没有认证任意曲面贴合、墙角裁切、持续500NPC性能或手机。

## 类型够不够

现有五类足够做技术白盒与最基础街道路面，不足以支撑已声明游戏/环境美术。最小新增4类即可满足已发布静态brief，不建议先新增无brief的轮胎、拖血、苔藓等类型。

1. **acid / P0**：黄绿液池，暗绿厚边，2–3个淡色气泡环，中心不白曝。对应 E-03 酸液落地与腐液主题；装饰贴花与真实伤害/到期逻辑必须分开。
2. **oil / P1**：低饱和蓝黑，两个相连不规则块、断墨边，无写实镜面。与车/工业道具周边街景相符，不能只给scorch染蓝冒充。
3. **paper / P1**：5–7片米白旧纸，粗短墨线替代文字、无烘焙阴影，增强空街细节但不成为拾取物。
4. **rubble / P1**：4–6大块+少量小块的暖灰/锈红地面碎屑，无真实高度/阴影，不替代3D阻挡物。

acid-flight/splash、muzzle/impact、瞬时flash、爆炸和攻击预警不属于此次静态贴花新增。贴花只消费事件事实；不能通过颜色/半径编造伤害，不能用静态液斑代替酸投射物。

## 最小参数建议

现有pattern/color/opacity/seed/size/rotation保留。增加四个共享可序列化参数已足够：`coverage`（覆盖/主体大小）、`edgeWidth`（墨边/裂线粗细）、`irregularity`（边缘破损与形状变化）、`detail`（气泡/碎屑/网点/放射裂缝量）。每种图案必须有明确视觉映射，不要求四参数在所有图案都完全相同意义。hazard seed应产生真实磨损变化；paper/rubble不能在提高detail时填满矩形边界。默认值要保持旧场景可读；各类按brief默认颜色，不把acid默认生成成暗红。

## 修复后复验门槛

- 五旧+四新增图案实际GPU独立预览，边缘有安全透明区，明暗背景都无矩形底/伪阴影；opacity0真正消失。
- seed两值真实改变不规则构型且同值可复现；四参数极低/默认/极高均可用、无NaN/全屏遮挡，hazard去完整黑框，hole明确中心+短裂缝，crack分叉宽窄成立，scorch有破口。
- acid与oil一眼区别，paper可数到离散纸片，rubble有大块小块关系；半透明气泡不看成真实攻击预警。
- 平地、斜坡、墙面、遮挡与重叠深度检查；第一层真实Play构图可读，不让装饰盖住NPC/可通行路径。
- 修改草稿不改变作者文档，放弃/关闭恢复；主代理另负责Apply/Undo/Save/Reload、schema迁移和资源释放门禁，本独立视觉结论不替代这些行为证据。

基线结论：未发现阻断渲染的P0技术故障，但美术验收有4个P1旧图案问题，游戏已声明贴花种类不全（acid是P0能力缺口），因此当前不能宣称完整游戏贴花美术通过。
