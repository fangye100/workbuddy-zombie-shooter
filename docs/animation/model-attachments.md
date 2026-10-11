# 模型与骨骼握点契约（v17）

本指南定义持久数据和中性机制。真实游戏装配由下一层表现适配器消费；机制测试通过不等于模型美术或实际 Play 验收。

## 数据归属与优先级

`packages/scene/src/model-attachments.ts` 是刚性 socket 真源。位置使用模型最终 `parseGlb` import-space 的米制坐标，旋转使用 xyzw 单位四元数；不得用烘焙前 pivot 或原始 GLB 节点坐标测握点。

资产 `.meta.json.modelSockets` 保存通用模型默认值。武器 `presentation.assembly.sockets` 按 key 覆盖默认值，未列出的 key 继承。附件 `attachments[]` 使用稳定 GUIDAssetRef、父 socket、子 socket、刚性 offset 和子资产 socket 覆盖。

角色 sidecar `boneSockets` 使用持久骨骼名称及 contact；`MeshRenderer.boneSockets` 为场景覆盖。undefined 继承，null 显式禁用，按 key 合并而不修改资产默认。骨骼 contact 的位置为规整化 actor 米制偏移，随骨方向旋转，不重复乘原骨架厘米尺度。仅接受正均匀尺度与刚性方向；反射、非均匀尺度和 shear 有诊断。

`presentation.assembly` 配置真实模型关系；`holdPose` 是 actor-local 理想模型位置及世界瞄准朝向的附加旋转。旧 `presentation.markers` 仅供无 assembly 的显式 legacy 表现与诊断，不与 modelSockets 同时作为同一握点的真源。缺配置不会猜测骨骼、创建假模型或静默宣称装配成功。

## 一次采样和同帧依赖

`packages/render/src/body-ik.ts` 接受中性瞬态请求，先处理 torso/head，再处理 primary 的位置与腕部方向。由该次实际手姿态 H、骨 contact C 和模型握点 G 求 `W = H * C * inverse(G)`。dependent 的目标由这个 W 求出，因此 reach clamp 与 partial weight 不使用理想 mount 或上一帧武器。保留旧配置的顺序与行为；残差同时报告米制距离和旋转弧度。

`skin.ts` 一次采样已有 base/Spine 动作、一次 IK，再最终 FK，输出带 frameStamp 的实际骨矩阵。父节点无需在 GLB 数组中排在子节点前。新增输出是骨世界矩阵，不能拿蒙皮的 inverseBind 共轭矩阵当 socket。

`attachment-transform.ts` 只做刚性变换；`model-draw.ts` 为单模型提供独立 mat4 的 CoreObjectDraw。它不占作者 64 个静态槽、不改变群体 ABI。每次 buffer/texture 创建后立即调用宿主资源登记端口，创建中失败释放已分配资源，disposer 幂等。宿主负责异步 generation/Stop 取消，资源登记拒绝之后不继续上传。

## 迁移与验证

v16→v17 的 `explicit-model-socket-assemblies` 仅为旧武器补 `assembly:null`，不推断握点、不改玩法。磁盘迁移：`node tools/level/migrate-scenes.mjs`；只读门禁：`node tools/level/migrate-scenes.mjs --check`。本次 18 场景移除版本、迁移更新时间和新增 legacy null 后，语义与迁移前一致，createdAt 保留；历史检视 hash 只对应当时版本。

定向测试：`pnpm exec vitest run packages/scene/test/model-attachments.test.ts packages/scene/test/migrate.test.ts packages/render/test/body-ik.test.ts packages/render/test/model-draw.test.ts`。涉及资产/场景还需 scene:check；跨层源码需 architecture:check；发布指南需 knowledge:check。
