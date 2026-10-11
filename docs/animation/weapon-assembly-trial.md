# 真实武器装配试验入口

本阶段接入实际存在的 WPN-01、WPN-07-LAUNCHER 与 WPN-MAG-01 LOD0。状态是待 headed Play 握姿复验；源码、离线测量、单元测试和构建均不替代 GPU 验收。WPN-02～06 本体尚待外部交付，SMG 弹匣、Shell、Fuel 不挂缺失本体，整个五件接入请求仍未完成。

## 持久入口与测量

独立场景 `assets/scenes/sandbox/weapon-assembly-trial.scene.json` 已登记在项目 scenes。本次独立试验服务的已验证证书域名入口为 `https://fangye-win11-office.tail6b29a2.ts.net:5198/?scene=assets/scenes/sandbox/weapon-assembly-trial.scene.json`。仓库固定5100服务契约未改；不将localhost视为本次TLS可达入口。场景持久化 H01 rig、SharedMotion Spine 层、双手 BodyIK、近景游戏 Camera、Light 与试验武器库；三层作者场景同样绑定 Pistol/Launcher。没有运行生成器覆盖三层。

编辑态的 `nd_pistol_inspect_0/1/2` 是同尺度侧面、+Z 端面与顶面副本，选择节点后按 F 聚焦；它们在 Play 隐藏。Pistol 的 final parseGlb 长轴实际为 Z，CPU 顶点分布支持 +Z 枪口候选，但正端仍需该场景 GPU 确认。Launcher 已有 LOD0 +X 炮口观察；不用原交付的轴向声明代替实际渲染坐标。

`assets/art/calibration/weapon-assembly-trial.json` 记录原资产 GUID、sha256、最终 import bounds、socket、H01 手掌 contact 候选和 CPU 结果。GLB 未改写。H01 contact 来自规整化腕到手尖的 0.163659m 量程，仍需可见掌心/手指贴合检验。Pistol 原本体握把为整网格，新增 Mag01 在槽内可能重叠；卸出附件不会自动删除原 mesh 的固有轮廓，不声称已经精确匹配。

## 表现与资源责任

`packages/zombie-game/src/presentation/weapon-model.ts` 只消费已有 WeaponSystem 的相位、recoil、player.yaw；先在瞄准空间 pitch，再适配 Pistol +Z / Launcher +X 模型轴。换弹附件阈值来自既有 procedural 配置。编辑器 `services/runtime-weapons.ts` 负责 GUID/sidecar 解析、异步加载、renderer 中性端口适配和逐 GPU 资源登记。

Renderer 一次 base/Spine 采样、一次 IK 后输出最终骨矩阵；右手实际结果决定武器，再决定左手。有效同帧骨口、实际 IK 和 visible draw 全部具备时才隐藏 Canvas 武器占位。缺配置、缺骨、GUID 错误、失败/取消仍有诊断并保留兼容表现。Stop 先失效 generation 和 AbortSignal，迟到 bitmap 关闭；已创建 buffer/texture 全部立即进入同一 PlaySession ledger，disposer 幂等。

正式模型 socket 用最终模型 local 坐标。模拟 `presentation.markers.muzzle` 仍由确定性 fireStep 消费，使用 capsule centre 相对 yaw-local 坐标，不能直接复制 model-local socket。P-01 capsuleHeight 的真源是 `packages/content/src/generated/stats.generated.ts`，半高 0.90m；Pistol 理想零 recoil 枪口 `[.480,1.347,.080]`、Launcher `[.715,1.360,.030]` 是相对 actor 原点的 yaw-space 世界偏移，marker Y 另加场景 actorY 后减 0.90m。独立场景 actorY=0，三层 actorY=.02，分别校准。生成器版本17和纯默认适配同样按实际作者高度计算；保留已有 MeshRenderer 全部配置，仅新玩家使用真实 rig 与双手默认控制。

真实 RuntimeSession 的 setAim/setFire/step 四向测试验证模拟 from；实际 H01 bind-pose 一次 IK/FK 探针与同 tick from 的最大误差约 2.9e-7m。该探针没有采样 SharedMotion、未提供 torso/head pointer，保留 IK_TARGET 诊断。运行时 reach clamp、动画、移动、后坐力及 GPU 掌心接触必须复验；模拟不读取 renderer 反馈。VFX 从同帧实际模型 muzzle 捕获视觉起点，弹道和伤害仍由原模拟决定。

## 只读观察与验收

`window.__editor.weaponModels.snapshot()` 是隔离数据副本，包含 `pending/loaded/generation/simulationTick/pose/visible/visibleDrawCount/frameStamp/muzzle/ikDiagnostics/measurements`。右手/左手位置残差以未 clamp 理想目标和同帧实际依赖目标计算，方向误差用弧度；`muzzleYawErrorRad` 使用 muzzle socket 的 +X 世界向量。`lastShotOriginTick/sameTickShotOriginResidualM` 仅在效果 tick 等于当前模拟 tick-1 时提供，历史射击不与移动后枪口比较。`modelMuzzleToSimulationMountM` 只是不同语义点的距离，不能当成弹道错误或验收通过。

已有 `__editor.bodyIk.summary()`、`__editor.motions.summary()` 与 Animation Debug 面板可交叉检查；Play 面板/EditorAgent runtime 提供 ledger、模拟 tick、cycle 和诊断。1/7 切 Pistol/Launcher，R 换弹，移动同时按住鼠标开火/换弹；必须通过真实键盘 keyDown/keyUp 和 mouse 事件保持并发输入，单次点击或快照不证明持续操作。检查腿部 locomotion 持续、Spine 动作和 IK、弹匣实际装卸、四向枪口、Pause 双时钟、Stop ledger0、重启身份和迟到取消。保存固定 HEAD/场景 hash/HTTPS secure context/NVIDIA GPU 与有效视角截图后，才能写实机结论。

美术证据边界：之前只观察 Launcher LOD0 三面、Mag01 LOD0 两面及 Shell 原件/旧新 LOD0 底火。Mag01 黑斑减轻仍有暗纹；Shell 底火未确认修复；SMG/Fuel 和其余 LOD 未实际覆盖。可在同次审计追加 SMG/Fuel 原件与 LOD0 固定关键视图、五件 LOD1/2 一览，失败 Shell 不伪报通过。

相关验证：`pnpm exec vitest run apps/editor/test/runtime-weapons.test.ts packages/zombie-game/test/presentation/weapon-model.test.ts packages/zombie-game/test/presentation/weapon-muzzle-calibration.test.ts packages/scene/test/level-scenes.test.ts`；`node --test tools/level/weapon-assembly-defaults.test.mjs`；`pnpm run scene:check`、`architecture:check`、`knowledge:check`、`typecheck`、`editor:build`。

本阶段离线验证：90 项首次定向测试、旧HUD1项和模型占位/同tickVFX1项通过；scene:check 为246资产/19个v17场景、15项场景测试及既有质量/音频门禁通过，architecture为278文件，knowledge为137条，typecheck、editor:build与示例build通过。三层语义核对只允许Pistol/Launcher表现与玩家BodyIK变化，4件sidecar GUID/sourceHash保持。CodeGraph在本检出 apps/assets/packages/tools 有界刷新96+2文件；当前health为1050files/6889nodes/17320edges、5个解析恢复文件、7341未解析调用，healthy=true，但锁竞争警告和embedding6251/6851(91%)仍是限制，不将图谱完整性或测试数量当成可见验收。

## 本任务 headed 输入探针

`tools/verify/weapon-assembly.mjs` 是本任务受控入口，复用 editor-smoke-lib 的 Cdp/等待与可见 Chrome，显式 `ignoreCertificateErrors:false`；不使用 ensureServer、normalizeEditorState、localStorage 修改、Security bypass 或手写 DOM dispatchEvent。旧冒烟调用的 HTTPS 默认仍保留，不能拿旧默认声明正常 TLS 通过。本入口不启动/重启 dev server。

运行前将参数里的 SHA 替换为 Main 提供的完整冻结 target，并在本检出根执行：

```powershell
node tools/verify/weapon-assembly.mjs --root C:/Users/fangy/WorkBuddy/game-design-zombie-worktree-01 --expected-head '填入冻结的40位SHA' --cdp 9348 --url 'https://fangye-win11-office.tail6b29a2.ts.net:5198/?scene=assets/scenes/sandbox/weapon-assembly-trial.scene.json' --out .workbuddy/tmp/wpn-integration/weapon-assembly-headed
```

工具先核对 root/cwd/HEAD、证据范围、保留 profile 的实际 Chrome 命令行与 CDP 端口空闲；冲突或归属不可读立即退出，不删除 profile、改随机 profile 或 kill 他人浏览器。启动后再比较 SystemInfo browser PID 和本次 spawn PID，防止 Chrome 复用其他进程。正常 TLS 导航失败时退出；不忽略证书、不降级 HTTP。headed 窗口记录 secure context、NVIDIA/Lovelace、控制台与异常。

通过真实可见 Play/Pause/Stop 按钮、实际 Canvas 点击及 Input.dispatchKeyEvent(key/code/Windows VK)/dispatchMouseEvent 持续操作。W 与鼠标开火同时保持，移动键保持期间按7/1/R；射击后真实W→S切换，换弹中再W→S折返，避免小场景边界持续阻挡，采样角色位置、实际发射、武器 phase、下半身上传矩阵/clip/time、同帧模型与残差，再 Pause/Stop/重启。首屏与两次Stop读取作者renderer玩家pos/quat/scale/visible/nodeId及内存document序列化SHA256，逐项比较回滚；Stop后从持久playerStart定位玩家，不依赖已经为null的runtime.player。Chrome/CDP连接30秒上限，PID核对和Play CDP命令10秒上限，连接后的操作预算120秒；释放已按住的键/鼠标，关闭本次target/进程，不处理其他标签。

换弹截图阈值直接读持久Pistol procedural phase，每张记录相应sample索引和时间，不把末尾完成画面当成Mag01离枪证明。证据 `observations.json` 与8张可见上下文截图、最多3张换弹离枪/中间/回位截图留在 out；失败的输入/模型/资源检查和未覆盖事实原样保存，退出1。`passed` 只代表该次输入与生命周期检查，CPU skinScratch不是GPU readback，手指贴合/细节质量仍由 Audit 看有效画面。迟到 decode 未被此实操人为制造，静态LOD补充也未覆盖，不能因测试或脚本退出0改写原未完成项。工具3项参数/归属/异常释放测试命令：`node --test tools/verify/weapon-assembly.test.mjs`。a76阶段的CUA仅证明场景可见/Resume，未证明W持续移动或7切换，不能据此判断产品bug。
