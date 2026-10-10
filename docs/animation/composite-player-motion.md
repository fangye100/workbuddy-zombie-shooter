# 玩家持续步态与身体区域动作组合

## 设计范围与证据

基线 `484b129d61262bc4eda50332d5b3567f19f5e9b5`，当前 worktree 的 CodeGraph MCP 0.167.0 查询记录在本机忽略目录 `.workbuddy/tmp/animation-layer-dev/codegraph-design.json`。查询覆盖 project_map、8 个 module_overview、3 个 call graph；未报告预算遗漏，33 个文件 freshness 未逐个核验，同名 set/find/forEach 边可能歧义。下述责任以实际 import 和源码核对为准，图谱不能认证运行或视觉行为。

实现后 Main 使用同一检出的受支持 CLI 0.167.0 增量刷新：49 files/344 nodes，本机 health 为988 files、6684 nodes、16521 edges，embedding 6624/6624 完整。4项历史 parser marker、7018 unresolved 仍存在；player-motion 同名 find/set receiver 误边不作为跨层依赖证据，真实 import 与 architecture:check 决定边界。该健康记录补充初始设计查询，不改写历史计数。

## 责任与数据流

`packages/scene/src/shared-motion.ts` 持有可复用的可选 `poseLayer` 配置；角色 sidecar 定义资产默认，MeshRenderer.sharedMotion 定义实例覆盖。配置只含通用 roots/exclude 后代区域、0–1 权重与过渡时间，不含僵尸或武器策略。无配置保持既有全身动画路径，场景版本升为 v16，v15→v16 正式迁移仅保留原数据并升级版本，不为旧场景自动添加或启用区域；资产 sidecar 仍使用其独立 schema。

游戏表现策略 `packages/zombie-game/src/presentation/player-motion.ts` 消费固定 tick 的移动速度、方向和已接受的武器 action，输出基础 locomotion 与区域动作请求；活动武器 phase 只控制区域片段，不覆盖基础时钟。Editor 的 RuntimeSceneMotion 负责装配解析后的片段和固定 tick；RuntimeBodyIk 将输入目标和武器 poseIntent 投影到已有 HumanIK 控件。Editor 不计算武器动作时间或伤害。

render 的 SkinState 区域状态具有独立 clip/time/loop/weight 与过渡。采样顺序为基础片段 → 基础过渡 → 区域采样/过渡/权重 → 一次 applyBodyIk → FK/关节矩阵。基础切片的过渡快照排除区域与 IK，区域切换的快照也排除 IK，避免累积和二次应用。进入、切换、退出的区域快照仅影响 mask；基础步态持续前进。

## 区域和失败契约

通用 mask 由 HumanIK 或 mixamorig 名称的 roots 后代减去 exclude 后代构成，可用于任意身体区域。本游戏三层玩家实例和 H-01 sidecar 配置 roots=[Spine]，因此 root/Hips/腿部链留给基础步态；render 不写死这组游戏骨骼。骨骼必须唯一解析，缺失、歧义或错误层级禁用区域并显式诊断，保留基础采样，不退为全身覆盖。上层只覆盖片段实际包含的轨道，缺轨道保留基础。

缺 shoot/reload/equip/unequip 时保留 locomotion 并报告请求缺片。切枪和后坐力的程序化姿态可使用现有 poseIntent → 手部 IK；它不是替代缺失动作片段的资产验收。reload 有片时衰减手部 IK，避免争夺换弹手轨道；总权重与部位持久配置不修改。目标不可用跳过该部位；0 权重保留前面的动画组合与腿部步态。

同 tick 不推进任何时钟；暂停冻结生产输出；重启清空运行期区域/动作 stamp；异步结果用 generation 拒绝跨 Stop 完成。Stop 恢复原 author SkinState/animations，不把运行期区域、IK 目标或调试状态写回场景。

## 观察与验收边界

配置区域的四向玩家保持 mesh 面向 player.yaw（瞄准方向），方向选片也使用 player.yaw；不因启用 bodyIk 而把 mesh 再旋转到移动 heading。未配置区域的旧路径保持原行为。

只读 debug 展示生产状态的 base、区域 clip/time/mask/weight/过渡/缺片与 IK 有效权重。观察、选择、freeze 不执行采样、动作选择、推进时钟或配置写入。NPC 的现有 GPU palette/proxy 路径保持原有只读观察，本次区域组合仅作用于玩家场景骨架。

开发验证覆盖 mask 对腿矩阵不变、独立时钟、权重/过渡、缺骨/缺片、无累积、资产配置往返、游戏策略及 Play 装配/恢复。CPU 测试和 build 不构成视觉验收；真实 GPU headed Play 审核由队列 Audit 提供，结果另记。

## 当前装配与使用

三层 `assets/scenes/act1/floor-{1,2,3}.scene.json` 的 playerStart MeshRenderer 使用 `poseLayer`。H-01 的 `.glb.meta.json` 同时保存可复用区域和 HumanIK 配置：上身/头读取现有 mouse 目标，左右手由实际 WeaponPoseIntent 的主握把、辅握把、弹匣/枪机目标投影到角色空间。scene instance 没有另造一份 IK 或武器状态。

`assets/animations/mixamo/shared.motion.json` 的 player profile 添加 ready：复用已入库 aim-idle 的静态姿态配方。shoot/reload 使用原片段；equip/unequip 仍缺独立素材，显示 `WEAPON_CLIP_MISSING`，上身保持 ready 并通过手 IK 做放低/抬起武器目标，下身继续步态。这个能力不等于新增完整换枪动画资产。

reload 上身片段生效时，运行期手 IK multiplier 根据区域权重和 transitionSec 衰减，避免双重控制；持久 bodyIk 权重保持原值。区域 weight=0 保留基础步态，手 IK 仍可按其独立配置工作。只读 debug 展示实际 multiplier 后的有效权重，不写回配置。

## 复现入口与证据

先读 `docs/browser-verification.md` 及其主机/Chrome/GPU 入口，由 Audit 确认固定 Chrome profile/CDP 的归属。聚焦入口只复用 `tools/verify/editor-smoke-lib.mjs` 的服务/Chrome/CDP 能力，不替代交互工具连接恢复。临时 --port 不修改固定端口、host、strictPort 或 Tailscale 配置；发现服务来自其他 checkout 即失败，不接管它。

```powershell
node tools/verify/player-motion-blending-probe.mjs --headed --port 5198 --cdp 9444 --floor 2 --out .workbuddy/tmp/animation-layer-dev/headed-floor2-recheck 2>&1 | Tee-Object -FilePath .workbuddy/tmp/animation-layer-dev/headed-floor2-recheck.log
```

`--floor 1/2/3` 选择实际楼层，`--keep-tab --keep-server` 仅供 Audit 继续查看该探针创建的 target/服务。默认关闭自身专用 target 和自身临时服务，保留共享固定 profile 浏览器与他人标签；自有 Chrome 子进程 unref 使 Node 可退出，不关闭共享 profile 浏览器。长驻保留时由发起者记录 server PID/cwd，并负责停止自己的服务。CDP 已被其他 profile 占用时停止这条路径并报告归属冲突，不 kill 或删 profile。

每次必须指定未使用的 --out；发现既有 results.json 即拒绝覆盖，以保留原始失败。helper 不修改进程全局 TLS 校验，仅 localhost 原生 HTTPS 请求使用本地证书选项。

入口经 CDP Input.dispatchKeyEvent / Input.dispatchMouseEvent 点击可见 Play、暂停、Stop、debug 控件，发送 WASD、J、R、数字2以及鼠标瞄准。生产输入处理器接收这些键鼠事件；脚本不使用 runtime.setInput/setFire。短 fire/reload/unequip/equip 阶段先执行；真实按键发送前注册只读 RAF 观测，抓取生产动作首帧，两个换枪阶段之间不串行等待截图。方向和 debug 检查通过可见 Stop/Play 开始独立新回合；不修改 runtime 生命、时间、输入或场景相机来绕过敌人。验收覆盖四向移动及瞄准/mesh 方向一致，横向移动同时 fire/reload/unequip/equip，观察目标切换、冻结画面不冻结 gameplay，暂停双时钟，Stop/重启及资源恢复。

`results.json` 保存 exact HEAD/branch、服务绝对 checkout 与四个关键源文件 SHA256、真实 GPU adapter、输入阶段、基础/区域时钟与权重/诊断、生产 IK 目标/权重、CPU 腿/上身 locals 和 renderer 已生成的 skinScratch 关节矩阵、只读 debug、资源账目、每个观测帧的 weapon/events/outcome/choosing/HP、失败和收尾终态、截图前后状态及浏览器/GPU 异常；PNG 截图来自 headed 页面。CPU locals 是纯采样观察，skinScratch 是上传 GPU 的生产 CPU 矩阵，均不是 GPU readback；它们不能代替截图与独立可见操作验收。实际视觉效果和源/目标 rig 重定向质量由 Audit 判断，不根据 CPU/build 宣称通过。

开发验证日志位于忽略目录 `.workbuddy/tmp/animation-layer-dev`。WU2 的 `wu2-tests.log` 保留修复前失败，后续 fixture/断言修复由最终聚焦集覆盖；`final-focused-tests-before-tool-schema.log` 的 488 项中 486 通过、两项关卡工具版本常量失败。仅将两个工具同步为16后，`final-level-scenes.log` 的31项全部通过，避免无新变更重跑其余通过项。scene:check 与 motion:check 的通过原始记录为 `wu2-scene.log` / `wu2-motion.log`；后者覆盖49 sources、8 targets、164 solves，不能认证视觉质量。最终 typecheck/editor:build、architecture:check、knowledge:check 保存各自 final 日志。构建存在既有 Vite CJS/chunk size 提示。

独立 Audit 已在 e1a8a0257c7fd764542c2adcc1ae17d5223b96f5 使用 NVIDIA Lovelace headed floor2，served SHA 匹配，49 PASS；唯一失败为真实 Digit2 后未观测到 unequip。原始 audit-floor2.log / headed-floor2/results.json 保留：按键前 tick159、HP28、pistol reload phase .1667；未保存按键后状态，不能由此认定生产缺陷。当前修复只涉及观测/顺序/收尾和本地 TLS 范围，未改玩法；复验与 Final Reviewer 待完成。原截图存在 NPC 遮挡，无法单凭其认证上身/下身实际视觉姿态；短新回合截图保存真实时刻，仍须 Audit 检查玩家可见性，若遮挡持续就保留视觉未证实。CPU locals 断言不替代这个结论。
