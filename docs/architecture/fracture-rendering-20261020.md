# 碎片动态渲染（WU-05）

日期：2026-10-21。WU-base：WU-04 APPROVED `aba6fbf9e8a9991316a11cbf99844665b7443b89`。
权威计划：`docs/architecture/fracture-system-development-plan-20261020.md`（§7.1、§10 WU-05、§11）。

## 职责与边界

把 WU-04 的 `ActiveChunk` 接到**原动态实例机制**上：复用 `CoreDynamicBatch`、
`renderer-core` 的动态管线与 `dynamic.wgsl`，不复制渲染器、材质或动画系统，不占用
静态 `transformBuf` 的 64 个场景槽位。

| 模块 | 职责 | 边界 |
|---|---|---|
| packages/render/src/renderer-core.ts | 动态批次；新增刚体模式基向量槽与子网格索引区间 | 不认碎片语义，只接已打包实例 |
| packages/render/src/shaders/dynamic.wgsl.ts | 顶点/法线三轴变换（bit1 刚体模式） | 旧 yaw/蒙皮分支原样保留 |
| apps/editor/src/services/fracture-renderer.ts | ActiveChunk → 批次；网格/贴图缓存；材质路由 | 不做物理、不写场景文档 |
| apps/editor/src/services/play-controller.ts | 装配/同步/Stop 释放；账目登记 | 碎片事件策略属 WU-06/07 |

## 实例布局：在旧 20-float 行之外追加刚体基向量

20-float 行的 palette、transition、impactPulse、burnClock 语义**不变**。刚体模式由
`anim.z` 的 bit1 标记，基向量走新增的 `@group(0) @binding(6)` storage buffer：
每实例 12 float（3×vec4，列为「本地 X/Y/Z 轴经 rotation×worldScale 变换后的向量」）。
实例位置仍用 `posYaw.xyz`，行内 `scale.xyz` 保持 1（尺度已折进基向量），
`color.rgb` 作为材质 tint 与贴图相乘。

渲染侧：`worldPos = M·p + pos`，法线 `normalize(M·n)`；描边壳用 smoothNormal 走同一
基。没有刚体批次的帧也绑 64 B 哑 buffer，避免 binding 6 缺失的 validation 错误。

## 坐标与材质

- 网格：`parseGlb(buffer, null, 'auto', { normalize: false })` 取原始 POSITION 并**保持
  资产原始坐标**（不在缓存里减 pivot）。每个实例用 `position - R·(worldScale·pivot)`
  作为平移，再由刚体基向量组合一次：`world = R·raw + (position - R·pivot)`，与
  `position + R·(raw - pivot)` 等价。这样同一 GLB 的不同合法 pivot 共享一份几何与
  一个 GPU mesh，不会串用已重基准的顶点，也仍能同几何同材质合批。
- 子网格：按 `subMeshes` 拆批次。带 `baseColorTexture` 的（外表面）用贴图 + 白色
  tint；纯色材质（切口，`baseColorFactor`）用共享白色材质 + 该颜色 tint。同一
  `meshId` 的几何只上传一次，多个批次用 `indexStart/indexCount` 画各自区间。
- 片元着色保留原漫画光照/深度/描边通道；`albedo = texture × instance.color`。

## 生命周期与资源归属

- Play 期新增的 GPU 资源（动态实例 buffer、姿态快照 buffer、刚体基向量 buffer、
  网格/皮肤 buffer、贴图、共享白色材质纹理）全部由 renderer-core 持有；
  releaseDynamicResources() 与 destroy() 两条路径都会 destroy 实例/姿态/刚体
  buffer、白色纹理与按 textureKey 共享的贴图（dynamicMaterials 逐项 destroy 后清空），
  clearDynamicMeshes() 负责网格/皮肤顶点索引 buffer。Editor 既有的共享资产不受影响。
- 账目顺序：dynamic-instances 先登记、fracture-renderer 后登记，Stop 时按登记
  顺序释放——先销毁 GPU 资源，再 dispose 渲染装配（关闭 ImageBitmap、清 CPU 缓存、
  递增代次）。
- TTL/淘汰：`sync` 每帧按 `runtime.active` 重建批次，到期的块自然从批次里消失；
  TTL 淘汰不逐网格释放；Reset/换绑释放 `fracture:` 前缀的 GPU 网格，Stop 再统一
  释放其余动态资源（本单元不做逐网格引用计数，属后续优化）。
- 失败：网格读取/解析失败 → 该块不画，原因记录在 fractureRenderError
  （路径 + 具体错误），2 秒后允许重试（不做永久负缓存）；成功加载会清空该诊断。
- 迟到：loadMesh 捕获装配代次，await 之后若已 dispose 或换代会关闭迟到的
  ImageBitmap，不写缓存/统计、不产生批次；dispose 也会关闭已缓存的位图。


- 贴图共享：同一张 baseColor 图（按字节 SHA-256 内容身份）只建一份 GPUTexture/材质，
  12 个 P-01 碎块共用 1 份 4096 贴图；fractureRenderStats.textures 记录唯一纹理数。
  字节口径分开记录，不再把 JPEG 文件长度当 GPU 量：
  `textureFileBytes`（源文件 IO）、`textureUploadBytes`（本次装配代新提交的解码
  基础级 RGBA8；Reset 后复用同一 GPUTexture 不再计）、
  `textureResidentBytes`（当前活动内容的基础级 + mip 链驻留）、
  `geometryBytes`（顶点+索引+全零 skin slot）、
  `uploadBytes = geometryBytes + textureUploadBytes`（本次装配代新提交）、
  `residentBytes = geometryBytes + textureResidentBytes`（当前活动内容驻留）、
  `instanceBytes`（本帧 20+12 float 实例行写入量）。P-01 实测：
  geometry 5,741,472 / file 2,355,534 / upload 72,850,336 / resident 95,219,956 /
  instance 3,072。
- Reset/换绑：PlayController.rebuildFractureBinding 调 beginGeneration()，让换绑前
  挂起的读取按代次失效，并释放 `fracture:` 前缀 GPU 网格；core 的材质贴图按内容
  身份复用，不重复上传（Stop 与 Reset 两条路径都不回填旧几何缓存）。实测 Reset 后
  第二次装配 `uploadBytes=5,741,472`（仅几何），`textureUploadBytes=0`、
  `textureResidentBytes=89,478,484` 仍为当前驻留。
- 纹理失败：新增/解析 baseColor 图失败会进入统一失败处理（fractureRenderError +
  重试），不再静默退化为白色材质。

## 验证（headed 真实 GPU，2026-10-21）

`node tools/verify/wu05-fracture-gpu-probe.mjs`（现有 5100 HTTPS 服务，未重启）：

- adapter：`nvidia / lovelace`，`isFallbackAdapter=false`，`isSecureContext=true`。
- `PlayController.start()` → 受控 `spawnFracture`（正式 P-01 profile，事件 scale=3，
  渲染验收注入而非真实武器破坏）→ `accepted=true`。
- 统计：12 块 → 24 批次（每块外表面 + 切口各一批）、12 个网格、37,260 三角形；
  24 个批次 = 24 次主表面 + 24 次描边 = 48 次 drawIndexed；同机位控制测试 94→142
  （+48）。整帧绝对值仍随相机可见静态集变化（历史聚焦样本 118→142），不作为固定成本结论。
- 材质：浏览器侧逐批读取 `{tex:true,tint:[1,1,1]}` 与
  `{tex:false,tint:[0.09,0.062,0.055]}`，与 GLB 的 outer/inner 材质一致。
- 资源量：12 个碎片网格的几何提交为 5,741,472 字节（顶点 + 索引 + 全零 skin slot）；
  4096² rgba8unorm 贴图基础级提交 67,108,864 字节、含 13 级 mip 驻留 89,478,484
  字节。fractureRenderStats 记录 geometryBytes / textureFileBytes /
  textureUploadBytes / textureResidentBytes / uploadBytes / residentBytes /
  instanceBytes；GPU 缓存按 meshId 只上传一次，同图按内容身份只计一次。
- 截图：`.workbuddy/tmp/wu05-gpu/fracture-air.png`（空中翻滚）、
  `fracture-play.png`（落地）。
- Pause/Step：暂停后碎片 tick 不变，单步 +1（官方命令本次样本 19→19、20；历史聚焦样本 162→162、163），与游戏时钟一致。
- 近景：探针把碎片放在相机与玩家之间 20% 处、事件 scale=3，可清楚看到外表面
  贴图（油桶锈红木条）与深色切口平面，三轴旋转与描边正常。
- Stop：batches=0 / dynamicInstSlots=0 / dynamicMeshes=0 / ledger.pending=0，
  实例/姿态/刚体 buffer 与白色材质纹理都在销毁列表里，无实例残影。


## 真实角色回归（headed，2026-10-21）

\`node tools/verify/wu05-hit-burn-probe.mjs --headed --scene assets/scenes/act1/floor-1.scene.json\`
用原生鼠标瞄准 + \`J\` 开火、数字键 \`6\` 切火焰，在正式 Act1 场景验证碎片模式没有污染
角色实例行：

- 目标角色行 \`flags\` = 1（bit0 蒙皮、bit1 刚体均符合预期）；
- 手枪真实命中：\`impactPulse(blend.z)\` 0.63 → 0，\`hitFlash\` 非零；
- 数字键切到 \`flame\` 后持续开火：\`burning=true\`、\`burnClock(blend.w)\` 非零（历史样本 3.17、本轮复核 2.90/3.03，随开火时长变化）；
- 全程无 console error；本场景 \`fractureBatches=0\`，24 个角色行不受碎片影响。

终态/Reset（同一 GPU 探针）：

- 玩家死亡后 \`outcome=game-over\`，碎片 tick 与实例位置在后续 10 帧保持不变；
- \`reset()\` 后旧 24 个批次清零、渲染统计归零，新代重新激活可再出批次。

## 动态分配事务验收（headed 真实 GPU，2026-10-21）

`node tools/verify/wu05-dynamic-fault-probe.mjs`（DISPLAY1 1920,80，严格 TLS，
nvidia/lovelace、fallback=false）：

- 依次在 pose / instances / rigid / 实例绑定组 / 材质贴图 / 材质绑定组六个阶段，
  通过真实 `createBuffer` / `createTexture` / `createBindGroup` 注入一次失败；
  纯色切口材质的绑定组用同一产品方法直接补测。
- 每个阶段失败瞬间：未登记孤儿 0；`fractureRenderFailures` 递增、
  `fractureRenderError` 可见；其余批次继续存在，恢复后继续绘制（142–143 draws）。
- 同一实例槽连续两次失败不累积孤儿；Stop 后跟踪的 buffer/贴图全部销毁，
  ledger `registered=792 / disposed=792 / pending=0`。
- 原始结果：`.workbuddy/tmp/wu05-faults/result.json`；正常路径统计见
  `.workbuddy/tmp/wu05-gpu/`。

`node tools/verify/wu05-pivot-gpu-probe.mjs`（同一 headed/GPU 条件）：

- 同一真实 GLB（chunk-0001）用 pivot 0 与 0.162673 两个实例、body x=0 / 0.5 同时激活；
  2 个批次各 2 实例，实例平移为 0 / 0.337327，未退化成 0 / 0.5。
- 拦截 `queue.writeBuffer` 确认 GPU 的 dynamic-instances buffer 实际收到 0.337327；
  同一路径只新增 1 个 GPU mesh，几何仍合批。
- 结果：`.workbuddy/tmp/wu05-pivot-gpu/result.json`。

`node tools/verify/wu05-reset-geometry-probe.mjs`（同一 headed/GPU 条件）：

- Reset 后同一路径返回不同 GLB 字节：CPU 顶点 10→20，meshId 的内容身份从
  `#81f5153a…` 变为 `#0f8a7835…`；`queue.writeBuffer` 观测到新顶点 20 的真实上传，
  旧 `fracture:` GPU mesh 在 Reset 时释放，网格数不累积。
- 结论：CPU 与 core 的缓存身份都覆盖“同路径新几何”，不会再画旧 vbuf。
- 结果：`.workbuddy/tmp/wu05-reset-geometry/result.json`。

## 边界与遗留

- 真实武器/物体破坏（WU-06）、NPC 致死与当前姿态烘焙（WU-07）、作者 UI 与
  Preview owner（WU-08）不在本单元。
- 逐实例淡出：运行时 chunk.fade(0..1) 写入刚体基向量 m0.w，主表面与描边都使用该
  alpha；描边在 alpha<1 时放弃后处理的「不透明 ink 豁免」（aux.a=0），否则描边会以
  全强度 ink 盖住已透明的主表面。alpha=1 的旧角色输出与不透明一致。
- GPU 构建事务：网格的 vbuf/ibuf/skinVb、实例槽的 pose/instances/rigid buffer 与
  绑定组、材质的 GPUTexture 与绑定组都走“先建后提交”。任一步失败只销毁本次新建
  对象；已有有效 slot 和共享材质不被失败尝试误毁。成功构建会清除对应诊断项。
- 失败降级：任一批次的资源构建或 draw 抛错只跳过该批并记录
  `core.dynamicError`（计数累计到 fractureRenderFailures，开始新 Play 时清零），
  异常不再冲进 main.frame；其余批次继续绘制，恢复后诊断回到
  “曾发生 N 次 GPU 动态资源构建/绘制失败（当前已恢复）”。
- 原角色蒙皮/调色板：本场景 NPC 走胶囊代理批次；shader 的 bit0 分支未被刚体模式
  改动，pose-palette / pose-transition / skin 的 owner 测试通过，dynamic-skin headed
  套件 35/35（palette uploads=2），floor-1 的真实 J 命中与火焰燃烧见上。仍不宣称
  所有含蒙皮 NPC 的关卡与姿态组合都已覆盖。
- 贴图缺失：声明 `baseColorTexture` 但 GLB 没有可用内嵌图像（或环境不能解码）时，
  记录路径诊断并进入 2 秒重试，不静默退化为白色材质；owner 测试覆盖该失败路径。
- 逐网格 GPU 缓存在 Stop 统一释放；按 TTL 逐网格回收属后续优化。
- GPU 压力/跨模式成本认证属 WU-09，本指南不宣称性能上限。
