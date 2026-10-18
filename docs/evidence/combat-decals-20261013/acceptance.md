# 真实战斗贴花接入验收

2026-10-13；基线 `b0e972c`，分支 `codex/procedural-decals-20261013`，schema v21。
实际检出：`C:/Users/fangy/Documents/Projects/visual-quality-20261007/game-design-zombie`。
当前源码散列见 `source-hashes.json`；先前战斗三类采样后，只增加武器类型过滤和规则ID
计数修复（手枪/默认规则画面不变）。最终生命周期样本见 `live-final.json` / `stop-final.json`。

## 实际交付

- 三关场景均启用事件配置；第一层8段街景墙添加由源GLB包围范围派生的保守Collider。
- 实弹命中有限实体记录稳定NodeId，随后求交其可见网格，弹孔使用实际表面法线。
- NPC实际正伤害与致死伤害记录脚底位置及代次，投到附近向上表面生成血迹；零伤害不生成。
- E-03未受遮挡的酸液落地时只记录一次，生成与实际酸池半径相符的残留。
- 全局256、弹孔128/血迹96/酸液32；每帧32次规则表面查询，寿命35/22/7秒，尾部淡出5/5/2秒。
- Scene持久化契约/迁移、游戏事实/表现策略、编辑器几何适配与GPU池明确分层。
- 512事实日志、处理预算、冷却、每类淘汰和全局淘汰有诊断。clear不重复回放。
- 新登记9节点真实战斗白盒；场景编辑表单可调事件参数，MCP继续复用scene_edit_nodes。

## 实际验证

主代理在有界面Chrome自有标签1461636554操作实际键盘J和鼠标左键，未用人工贴花emit：

| 采样 | 结果 |
|---|---|
| tick76 / run2 | NPC受击血迹 + E-03落地酸液；GPU 2实例/1draw/4096B |
| tick91 / run2 | 增加墙面弹孔，局部z=0.25、+Z法线；GPU 3实例/1draw/4096B |
| 最终源码 tick100 / run1 | 自动酸液；GPU 1实例/1draw/4096B |
| 最终Stop | 运行痕迹0、runId=null、GPU0实例/0draw/0B；Play资源账本registered5/disposed5/pending0，作者revision保持1c7ffc8f |

正式第一层100tick Play/Stop确认场景可打开、配置可装载、33作者痕迹仍为一个批次，
资源账本同样5/5/0；该采样未输入射击，不作为三类战斗事件证据，见`floor1-runtime.json`、
`floor1-stop.json`、`floor1.png`。

之后在正式第一层用真实J输入射击：tick132/run2生成`combat_blood_1`，接收节点
`nd_f1_street`、局部y约0.12（世界路面y=0），无noSurface，GPU34实例/1draw，
包括33个作者痕迹及1个真实战斗血迹；见`floor1-real-shot.json/png`。

以上分别见 `battle-acid-blood.json/png`、`battle-all-three.json/png`、`live-final.json`、
`stop-final.json`。暂停采样不会推进tick。`hardware.json`确认secureContext=true、NVIDIA
Lovelace、fallback=false。该页控制台error为空；这不是移动端或任意NPC规模性能认证。

相关33个Vitest文件494项通过（Scene迁移/文件、武器、敌人攻击、Session、几何求交、
Render池、Editor宿主/Play生命周期）。后增加规则ID前缀冲突回归1项，最终7项游戏贴花
测试通过；武器类型过滤后受影响22项通过。测试覆盖短TTL淡出/到期/暂停、每类上限、
超预算/日志溢出、缺表面、隐藏子网格、代次回收、酸液遮挡与真实死亡前受击事实。
Node MCP/场景契约共7项通过（旧schema期望20已修为21）；typecheck、editor:build、
game:build、architecture:check、scene:check通过，构建保留既有大chunk提示。knowledge:check在文档目录与独立复审完成后通过（148条目录、无错误）。

CodeGraph MCP0.167.0先查当前checkout的project_map/module_overview再核源码；增量
索引no-embed可用，部分main/weapon-combat/game-audio解析恢复及embedding覆盖不足，
图谱只用来定位责任，不能替代源码/测试或GPU验收。

## 独立复审与限制

独立视觉VFX子代理使用自有标签，不控制主代理页；其实际输入、短TTL、真实GPU、
数量与Stop结论见 [独立报告](review.md)。独立验收通过，无P0/P1缺陷；真实双射击低上限、三类淡出/到期、暂停、Stop均通过。
白盒默认机位已按独立报告修为yaw0/distance16并复验，未临时改相机也可见弹孔。
远距弹孔数像素、白地血迹偏淡保留为非阻断P2；没有满256真实实战或移动端认证。

当前是显式平面贴花；不裁切接收网格边缘、跨墙角或弯曲表面，不是蒙皮体表血迹。
第一层墙Collider是原点对齐包围box，不能代表凹面或孔洞物理；接收面无法在0.45m
范围内匹配时跳过并计noSurface。大量高面数接收面仍用AABB+三角形求交，每帧有
次数预算，未做BVH或移动端专项性能测试。活动酸池伤害与危险圈不由贴花决定。
