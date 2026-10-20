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

- 网格：`parseGlb(buffer, null, 'auto', { normalize: false })` 取原始 POSITION，逐顶点
  减去 `profile.pivot`，使 body 原点 = pivot；再由基向量与位置组合一次。
- 子网格：按 `subMeshes` 拆批次。带 `baseColorTexture` 的（外表面）用贴图 + 白色
  tint；纯色材质（切口，`baseColorFactor`）用共享白色材质 + 该颜色 tint。同一
  `meshId` 的几何只上传一次，多个批次用 `indexStart/indexCount` 画各自区间。
- 片元着色保留原漫画光照/深度/描边通道；`albedo = texture × instance.color`。

## 生命周期与资源归属

- Play 期新增的 GPU 资源（动态实例 buffer、刚体基向量 buffer、网格/皮肤 buffer、
  贴图）全部由 `renderer-core` 持有，并在 `releaseDynamicResources()` 中销毁；
  `PlayController` 把一个 `fracture-renderer` 账目项登记进 PlaySession，Stop 时先
  dispose 渲染装配（关闭 ImageBitmap、清 CPU 缓存），再随 `dynamic-instances` 账目
  释放 GPU 资源。Editor 既有的共享资产不受影响。
- TTL/淘汰：`sync` 每帧按 `runtime.active` 重建批次，到期的块自然从批次里消失；
  已加载的网格 GPU 缓存保留到 Stop（本单元不做逐网格引用计数，属后续优化）。
- 失败：网格读取/解析失败 → 该块不画且不重试轰炸（缓存 null）；Stop 期间的迟到
  加载不会产生新批次（`disposed` 检查 + 单次 dispose）。

## 验证（headed 真实 GPU，2026-10-21）

`node tools/verify/wu05-fracture-gpu-probe.mjs`（现有 5100 HTTPS 服务，未重启）：

- adapter：`nvidia / lovelace`，`isFallbackAdapter=false`，`isSecureContext=true`。
- `PlayController.start()` → 受控 `spawnFracture`（正式 P-01 profile，事件 scale=3，
  渲染验收注入而非真实武器破坏）→ `accepted=true`。
- 统计：12 块 → 24 批次（每块外表面 + 切口各一批）、12 个网格、37,260 三角形；
  整帧 drawCall 从 118 增至 142（+24），三角形增加约 4.4 万。
- 材质：浏览器侧逐批读取 `{tex:true,tint:[1,1,1]}` 与
  `{tex:false,tint:[0.09,0.062,0.055]}`，与 GLB 的 outer/inner 材质一致。
- 资源量：12 个碎片网格共上传 5,741,472 字节（顶点 + 索引 + 全零 skin slot），
  由 fractureRenderStats.uploadBytes 记录；GPU 缓存按 meshId 只上传一次。
- 截图：`.workbuddy/tmp/wu05-gpu/fracture-air.png`（空中翻滚）、
  `fracture-play.png`（落地）。
- Stop：`batches=0 / dynamicInstSlots=0 / dynamicMeshes=0 / ledger.pending=0`，
  动态 GPU 资源确实销毁，无实例残影。

## 边界与遗留

- 真实武器/物体破坏（WU-06）、NPC 致死与当前姿态烘焙（WU-07）、作者 UI 与
  Preview owner（WU-08）不在本单元。
- 淡出只按 TTL 移除实例，尚未做逐实例 alpha 淡出（需要在动态 shader 增加透明度通道）。
- 原角色蒙皮/调色板：本场景 NPC 走胶囊代理批次（探针记录 charBatches=2、本帧未上传
  调色板），因此「原角色 palette/transition/hit/burn」的 headed 对照仍待含蒙皮
  NPC 的场景验证；shader 的 bit0 分支未被刚体模式改动，pose-palette /
  pose-transition / skin 的 owner 测试通过。
- 逐网格 GPU 缓存在 Stop 统一释放；按 TTL 逐网格回收属后续优化。
- GPU 压力/跨模式成本认证属 WU-09，本指南不宣称性能上限。
