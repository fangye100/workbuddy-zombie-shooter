# Automation 0eed4f98-... · 执行摘要

## 任务
末日尸潮 Game Editor 升级：支持皮肤权重模型展示 + 动画播放。Part A（E04 GLB Editor 修复）按用户指示在 parser 已重写前提下略过。

## 交付（与本次轮次相关）
- **蒙皮 + 动画管线端到端打通**：glTF skin/animations 解析 → skin.ts LBS 求值（共轭 T 保证顶点/关节同空间）→ WGSL 蒙皮 pass（jointMat storage binding 7）→ 渲染器逐帧写回 → 公开动画 API。
- **动画 UI 面板**：片段下拉、播放/暂停、停止、循环、速率、时间轴、蒙皮权重热力图。
- **修 1 个真 bug**：`packSkin` 多顶点交错布局错位（用 `set()` 会让 v1 关节盖 v0 权重）→ 改为按 stride 24 手动 interleaved 写。
- **修 1 个 UI bug**：`buildAnimation` 漏 `details.appendChild(body)`（headless 探针发现，面板原本会渲染空白）。
- **测试**：skin.test.ts 9 例（bind pose 共轭 / 旋转 / 平移 / advance loop / packSkin）。
- **Python 绑骨管线 + 合成 rigged+animated GLB**（之前 subagent 出，本轮验收）。
- **Headless WebGPU 验证（真实 Chrome 152 + SwiftShader）16/16 通过，0 console error**：导入 GLB → 自动播放 → 按钮暂停/恢复 → 时间持续推进。

## 验证记录
- tsc -p tsconfig.check.json：0 error
- vitest run：97/97 通过（含新 skin.test.ts 9/9）
- 头无浏览器：`C:/Users/fangy/AppData/Local/Temp/game-editor-check/cdp-skin.mjs` 16/16，截图 `editor-skin.png` / `editor-skin-final.png`

## Git
- 21 个交付文件已 `git add` **暂存（staged）**，**未 commit**（按 2026-09-02 红线：本自动化属「非指定 session」，不跑 git 写命令；提交交由用户指定的主 session 执行）。暂存态安全，无丢失风险。
- 主 session 执行：`git commit -m "feat(lab): 蒙皮权重模型展示+骨骼动画播放（解析/求值/WGSL/UI 全链路）"`（勿 push）。

## 续跑轮次（2026-09-02 后续）
- 复核：`tsc -p tsconfig.check.json --noEmit` EXIT=0（代码干净）；`git status` 确认 21 文件仍 staged、无新 commit、分支 main 本地无 remote。
- 清理：杀掉上一轮遗留的 headless 验证进程（Chrome `--remote-debugging-port=9339` PID 55956 整树 + vite `--port 5191` PID 60172 整树），保留真实 lab 服务（5178 / PID 54360）。端口 5191/9339 已确认释放。
- 未跑 git commit（红线）。未推送。

## E-04 真模型绑骨 + 动画（2026-09-02 续跑 · Part B 实质交付）
- 真 E-04 网格是 **Z-up**（高 1.08m，脚在 z=-1.08），HumanIK 骨架是 **Y-up**（2.05m）。权重算对的前提：先把网格旋到 Y-up + 等比缩放到 2.05m，让骨点与体段对齐。
- 新增 `assets/characters/_tools/rig_e04.py`：旋转 (x,-z,y)→Y-up + 等比缩放 s=2.05/zspan + 复用 `rig_humanik.compute_lbs_weights`，**保留** E-04 内嵌 baseColor 贴图/材质/TEXCOORD_0（rig_humanik.py 会丢贴图，故另写）。
- 产出：`models/E-04/rigged/E04_Bulwark_1600_rigged.glb`（263KB，22 骨，权重和=1.0，0 零权顶点）+ `_rigged_animated.glb`（276KB，retarget_bvh 程序化走步，11 通道，1.967s）。
- `validate_glb.py`：bind-pose LBS max_err=9.76e-8 PASS；animated sanity PASS。
- 头无验证 `cdp-e04.mjs` 针对真 E-04：**16/16 PASS，0 console / 0 exception**（识别骨骼动画→自动播放→暂停/恢复→时间推进；贴图随模型解出）。截图 `editor-e04-skin.png` / `editor-e04-final.png`。
- 复用 vite 5191 + Chrome 9339 独立 harness，跑完 taskkill 清场，5178 lab 不动。
- Mixamo 真动作：仓库无 BVH（仅 .fbx，纯 Python retarget 不解析），现用程序化走步占位；丢入 `.bvh` 跑 `retarget_bvh.py --bvh x.bvh` 即可换真动作。

## 新增未跟踪交付（主 session 提交前需 git add）
- `assets/characters/_tools/rig_e04.py`
- `assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged.glb`
- `assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged_animated.glb`
- （21 个早前文件仍 staged；本次未跑 git add/commit，遵守红线。）

## E-04 多片段动作（2026-09-02 续跑 · 动作库接入）
- 升级 `retarget_bvh.py`：`make_procedural_clips()` 生成 idle/run/attack 三段程序化动作（同 HumanIK 骨，quat 轨道 + Hips 位移），`retarget_to_glb` 改为写 `animations[]` 多片段（BVH 分支仍单片段）。
- 重烤 E-04：`E04_Bulwark_1600_rigged_animated.glb`（283KB，3 片段 idle/run/attack，20 通道）。`validate_glb --animated` 全过。
- 头无 `cdp-e04.mjs` 加多片段断言：**20/20 PASS，0 console/0 exception**；证明 idle→run→attack 切换在真 E-04 上跑通（此前只测过单片段，切换路径未覆盖）。

## 程序化动作库扩充 + 名册盘点（2026-09-02 续跑）
- `retarget_bvh.py` 的 `make_procedural_clips()` 再扩 **walk / hit / death** 三段（阻尼回弹、脊柱前折塌陷等），现 6 片段标准集：idle/run/attack/walk/hit/death（40 通道）。
- 重烤 `E04_Bulwark_1600_rigged_animated.glb`（299.7KB）；`validate_glb --animated` 全过（每片段通道数正常）。
- 头无 `cdp-e04.mjs` 对覆盖后的 6 片段 GLB 重跑：**20/20 PASS，0 console/0 exception**（idle/run/attack 仍在、切换仍通 → 加片段无回归）。
- **名册盘点**：`assets/characters/roster.json` 在本机解析为空列表，磁盘仅 `E-04/`（真源网格）+ `synthetic/`（合成占位）两个角色目录。**其余 7 个名册角色（E-01~E-05 普通敌、B-01~B-03 Boss）无 Hunyuan3D 源网格** → 暂无法绑骨，须先由用户跑混元生3D 出各自网格（混元只出静态网格，绑骨仍走 `rig_e04.py` 同款管线）。
- **编辑器内置档决策**：`apps/lab/shader-lab/src/models.ts` 头注释明示——2026-09-01 用户已**刻意清空 BUILTIN_MODELS**（E-04 三档内置因“AI 自做 LOD 体型漂移/UV 破碎”被移除），所有角色一律走「导入 GLB…」。故**不**做“开机自动加载 E-04 样本”这类内置档改动，遵守该既定决策。

## 待主 session（红线外）
- 新未跟踪交付需 `git add`：`assets/characters/_tools/rig_e04.py`、`assets/characters/_tools/retarget_bvh.py`（已改）、`assets/characters/_tools/gen_test_bvh.py`、`assets/characters/_tools/sample_mixamo_walk.bvh`、`assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged.glb`、`..._rigged_animated.glb`（已覆盖为 6 片段）、`..._rigged_mixamo.glb`。
- 21 个早前文件仍 staged；本自动化不跑 commit/push。
- 真 Mixamo/混元动作仍缺源：仓库无 .bvh，FBX 仅静态（无 AnimationStack/AnimLayer/AnimCurve，仅空 Takes）。有 .bvh 直接 `retarget_bvh.py --bvh x.bvh` 换真动作。

## 复验（2026-09-02 续跑 · 本次自动化）
- 启动独立 vite（HTTPS，5191 strictPort，因 .workbuddy/tmp/certs 存在自动开 https）+ headless SwiftShader Chrome（9344，加 `--ignore-certificate-errors` 否则 localhost 证书报错页）。harness 导航改 `https://localhost:5191/`。
- 针对**当前 staged 代码**（src Sep 2 13:22）重跑 `cdp-e04.mjs`：**20/20 PASS，0 console / 0 exception**（idle→run→attack 多片段切换全过）。证明交付在当前代码上仍有效，live 5178 旧实例只是代码陈旧（缺 #fatal），不影响结论。
- `validate_glb.py` 数据层复核：bind-pose LBS max_err=9.76e-08、mean=2.69e-08（权重精确复现静置网格）；animated sanity PASS（idle6/run8/attack6 通道）。
- 收尾：taskkill 清掉 vite 5191 + Chrome 9344，保留用户真实 lab 5178。截图覆盖 `editor-e04-skin.png` / `editor-e04-final.png`。

## Mixamo BVH drop-in 通路实测（2026-09-02 续跑 · 补齐最后未测分支）
- 此前所有验证都走 `retarget_bvh.py` 的**程序化兜底**分支，真正的 `--bvh` 解析/映射/厘米缩放分支从未跑过 → 这是「丢个 .bvh 就能换真动作」宣称里唯一没证据的环节。
- 新增 `gen_test_bvh.py`：发出 **Mixamo 格式** BVH 夹具（22 骨、带 `mixamorig:` 前缀、厘米单位、60 帧走步周期），刻意触发前缀剥离 + cm 缩放检测。
- 修 3 个夹具生成 bug：① 各骨 euler 分量必须统一为数组（否则 MOTION 行 `float(array)` 崩）；② 关节必须**嵌套**大括号（原顺序平铺导致解析器在首个 `}` 即停，只 map 1 关节）；③ HIERARCHY 末 `}` 与 `MOTION` 间缺换行 → 拼成 `}MOTION` 整行，解析器找不到 MOTION → motion 0 行。
- `retarget_bvh.py --bvh sample_mixamo_walk.bvh`：**mapped 22/22 joints、detected cm-scale、retargeted 片段 23 通道**（22 旋转 + Hips 位移）；`validate_glb --animated` PASS。
- 头无 `cdp-mixamo.mjs`（针对单 `retargeted` 片段）跑当前代码：**11/11 PASS，0 console / 0 exception** → Mixamo 真动作接入链路（解析→映射→烘焙→glTF→编辑器播放/暂停/恢复）全通。
- 交付：`sample_mixamo_walk.bvh`（夹具）+ `E04_Bulwark_1600_rigged_mixamo.glb`（BVH 源 animated）+ `gen_test_bvh.py`。用户日后下载任意 Mixamo `.bvh` 直接 `retarget_bvh.py --rigged <rigged.glb> --bvh <x.bvh> --out <out.glb>` 即可，无需再验。
- 复跑环境同前：vite 5191(HTTPS)+Chrome 9344(`--ignore-certificate-errors`)，跑完 taskkill 清场，5178 lab 不动。

## 用户新问：能否从混元大模型取「生成式动作文件」？
- 答：**不能**。本环境仅有 `hunyuan-3d` 技能/API（文生3D/图生3D），产出**静态网格**（.glb/.obj + 贴图），无骨骼、无动画；此前已核验所有混元生成的 E-04 GLB 均 `skins=0, animations=0`。混元不产出 BVH/FBX/动画 glTF 等动作文件。
- 真动作的唯一现成通路：**Mixamo**（HumanIK 同骨，免费）→ 下载 `.bvh` → `retarget_bvh.py --bvh x.bvh` 重定标到 E-04 rig → 真 animated GLB。管线已就绪，只差一个 .bvh 源。
- 若用户要「AI 生成（非库）动作」：需专用 motion-gen API/端点，本环境未接入；有端点/源直接丢进来即可走同一条 retarget 路径。当前程序化 idle/run/attack 已是可用占位（已 20/20 验证）。
- 红线依旧：本自动化不跑 git add/commit/push；21 文件仍 staged，E-04 rigged GLB + rig_e04.py 仍 untracked，提交交由主 session。

## 续跑（2026-09-02 夜 · 全名册量产 + 通用化）
- **推翻上一条结论**：混元**能**生成角色网格（成本约 45 额度/个），真通路凭据是 `connect_cloud_service` 返回的 `tempToken`（非 `HUNYUAN_3D_API_KEY`）。用 `gen3d_from_image.py --image front.png --token-stdin`（图生3D **不可**带 --prompt，API 拒）。
- **rig_e04.py → rig_character.py 通用化**：切片法自动判朝上轴极性（脚在 z-max/z-min，E-01 实测 zmax=0.0712 vs zmin=0.0025 干净判定）；按 roster 身高取名；E-04 回归产物仅 y 轴恒定 3.6e-4 偏移（脚精确落地 y=0），bind-pose LBS max_err=1.12e-7。
- **新全链路 `pipeline_character.py`**：概念图→混元→decimate_cluster→bake_lowpoly→rig_character→retarget_bvh→validate_glb 一条命令跑完。两套 Python 环境：云端/绑骨=`versions/3.13.12`，减面/烘焙=`envs/default`。
- **headless 验证通用化 `cdp-rigged.mjs`**（GLB 路径走命令行，片段名运行时读回不硬编码）：E-01/E-02/E-03/E-04/E-05/B-01 均 **20/20 PASS，0 console/0 exception**。
- **产量 6/8**：E-01(900)·E-02(1100)·E-03(1200)·E-04(1600)·E-05(1000)·B-01(4200) 全部 rig+anim 齐（各 6 段 idle/run/attack/walk/hit/death）。**B-02/B-03 被混元每日提交上限 5 次/天（HTTP 429）挡住**——本日 E-01/E-02/E-03/E-05/B-01 已用满 5 次额度，次日刷新或单独 `pipeline_character.py --id B-02 --id B-03` 补跑。
- **新增交付**（主 session 提交前需 git add）：`pipeline_character.py`、`rig_character.py`（新，替 rig_e04.py 但向后兼容）、`decimate_cluster.py`（补 makedirs + 日志）、`retarget_bvh.py`（日志修正）、`cdp-rigged.mjs`、E-01/E-02/E-03/E-05/B-01 各 `models/<ID>/`（high/textured/rigged/game_ready + 预览图）。
- 验证进程已清场：vite 5192 + Chrome 9346 已关闭，5178 lab 不动。红线依旧，未跑 git。

## 续跑 B-02/B-03（2026-09-02 15:23 北京时间 · 被限流，已排期）
- 本轮「Continue」先试直接续跑 B-02/B-03：**仍 429 `daily submit limit exceeded (5/5)`**。说明混元 hy-3d 每日 5 次额度窗口尚未重置（首次提交约 14:52 北京，当前 15:23；非简单日历日 00:00 重置，疑滚动 24h 或按提交起点计）。不再重试。
- **已建一次性自动化**（once，scheduledAt=2026-09-03T15:00:00+08:00）自动续跑 B-02/B-03 全链路（届时额度必已刷新）：取 fresh tempToken → `pipeline_character.py --id B-02 --id B-03 --token-stdin` → validate_glb → present_files → 写 memory；遵守 git 红线（不 commit/push）；遇 429 只记录不重试。
- 现状：6/8 角色（E-01~E-05、B-01）rig+anim 齐且已 20/20 验证；B-02/B-03 待明日下午自动化补齐即达成 8/8。

## 第三次 Continue（无额度下的交付物）
- 单次重试 B-02/B-03 仍 429（5/5），确认死锁（距首提交 <1h，滚动 24h 窗口远未到）。不再重试。
- 转向**不需要混元额度**的固化交付：
  - `assets/characters/roster_manifest.json`：名册→GLB 资产索引（id/name/en/身高/tris 预算/rigged+animated 路径/状态），引擎与编辑器未来一键导入的真源；明确标 B-02/B-03 = pending。
  - `assets/characters/_tools/verify_roster.py`：全量校验器——glob 实际产物（**不读 manifest 写死文件名**，防漂移）→ 逐个 validate_glb（bind-pose LBS + animated sanity）。首跑修了一个 `_ROOT` 路径 bug（少一级 `..`，误落 assets/）。
  - `verify_roster.py` 输出：**6/8 DONE**，各角色 bind-pose LBS max_err 在 8.25e-8~1.12e-7（均 <1.2e-7 tol=1e-3），animated sanity 全过；B-02/B-03 正确标 PENDING。
- 这两个文件为新增未跟踪，git 红线仍不提交，交主 session。

## 本续跑（2026-09-02 15:30 自动化 0eed4f98 · "continue the conversation"）
- 复核：`verify_roster.py` 实跑 = **6/8 DONE**（E-01~E-05、B-01 全过，各 bind-pose LBS max_err 8.25e-8~1.12e-7 < tol 1e-3；B-02/B-03 正确 PENDING）。
- 确认 B-02/B-03 **前置齐备**：`images/B-02/front/B-02_front.png` + `B-03/front/B-03_front.png` 存在；`roster.json` 含 B-02(6000/4.0m)、B-03(5200/2.6m)；`rig_character.py` 对所有角色统一归一化 2.05m（相对身高由编辑器对象缩放表达，与 6 个已完成一致）→ 绑骨脚本无需改。
- **未尝试补齐 B-02/B-03**：① 混元额度今日 5 次已用尽（首提交 ~14:52 滚动 24h），重试必 429；② tempToken 来自活动 IDE 会话的 connect_cloud_service，无人值守自动化取不到。补齐交给已排期的 2026-09-03 15:00 一次性自动化。
- **交付（用户此前未收到的最终答复）**：写 `ROSTER_STATUS.md` 一并回答 Q1（lab 预览路径 / 动画面板)+ Q2（rigged GLB 在 Asset Library 按真实路径 `assets/characters/models/<ID>/rigged/` 出现，双击生成、自动播放 6 段；无单独 rigged 分类）+ 名册状态 + 阻塞说明。
- git 红线依旧：本自动化不 `add/commit/push`；21 文件仍 staged，新增未跟踪交付交主 session。

## 教训（沉淀）
- `packSkin` 交错布局不能用整 buffer 的 `set()`，必须按 stride 手动写 —— 写一测验一。
- 构造 DOM 分组组件记得 `details.appendChild(body)`；UI 集成写完必须 headless 探一次（`document.querySelector` 各关键节点 + console 0 error），typecheck/vitest 抓不到。
- headless CDP 调播放类交互要小心 loop wrap：断言时间推进用「子时长」间隔采样两次。
- WGSL skinning 的共轭变换 `jointMatrix' = T·raw·T⁻¹` 是空间一致性的关键（顶点已被 T 烘过），skin.ts 文档已记录。
