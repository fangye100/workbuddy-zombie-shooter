# WPN-20261011 五件源模型检视

本入口只准备源模型目检，尚未认证美术、米制尺寸、LOD、角色握点或玩法装配。
原 GLB、front、preview、job 和 delivery 文件保留；新增 sidecar 使用稳定 GUID。

## 实际入口

场景 `assets/scenes/sandbox/weapon-source-review.scene.json` 已登记在
`aether.project.json`。在目标检出目录的编辑器 File → Open 中选择
**WPN-20261011 · 五件源模型检视（未验收）**，或给该实例 URL 增加
`?scene=assets/scenes/sandbox/weapon-source-review.scene.json`。
主服务固定为 `https://localhost:5100`；受控独立 Audit 服务的地址由 Main 记录，
不得把其他进程的 5100/5197 服务当作当前检出。

每件模型独占一个可选节点。场景没有玩家、RunRules 或碰撞，属于编辑源检视。
双击层级节点聚焦，再环绕取得侧面、端面与俯视。Audit 使用 headed Chrome 和真实
GPU，记录 URL、检出目录、精确 HEAD、加载失败/浏览器错误及各件三角度截图。
画面里的展示缩放使每件最大跨度约 1.6；它不改源 GLB，不代表米制规范化。

资产库目录为 `assets/_delivery/WPN-20261011/<ID>/`。选择对应 GLB 后沿用现有
Inspector/资源预览路径。场景装载显式消费 sidecar 的 `normalizeHeightM: null`
和 `upAxisFlip: false`，应用 GLB 节点变换、居中贴底，保留尺寸与方向比例。
WU2 已统一资产库预览/双击生成与场景的 sidecar 轴向参数；Launcher 的 Z 长轴
不会再因自动轴推断被额外旋转。归一化与固定三向入口见
[LOD 候选指南](wpn-20261011-lod-candidates.md)。
当前编辑器装载显示 BaseColor；不以此认证源 GLB 的 normal/metallic/roughness 效果。

## 结构实测（2026-10-11）

下表范围来自现有 `parseGlb(buffer, null, 'y')`，包含 GLB 节点旋转，尚未米制标定。
五件均为单 primitive、无 skin/animation，内嵌 BaseColor 均为 4096×4096 PNG。

| ID | 三角形 | X / Y / Z 范围（生成单位） | SHA-256 前缀 |
|---|---:|---|---|
| WPN-07-LAUNCHER | 99846 | 0.299256 / 0.598686 / 1.105621 | 5031329c33b9e1d7 |
| WPN-MAG-01 | 30000 | 0.460541 / 1.111502 / 0.212223 | eeb32ff776a3c2b6 |
| WPN-MAG-02-SMG | 30000 | 1.159183 / 0.263349 / 0.271637 | 0d3c8c1804527680 |
| WPN-SHELL-01 | 41638 | 1.059384 / 0.585432 / 0.580538 | 92826b57858f4e99 |
| WPN-FUEL-01 | 30000 | 1.012908 / 0.693492 / 0.443274 | db4bb2b638b9f2f |

完整 source hash 存于每件 `.glb.meta.json` 的 `sourceHash`。
`tools/art/prepare-weapon-source-review.mjs` 提供可重复的结构检查：

```powershell
node tools/art/prepare-weapon-source-review.mjs --check
pnpm run scene:check
pnpm run knowledge:check
```

首次 prepare 的完整原始统计位于忽略目录
`.workbuddy/tmp/wpn-integration/source-inspection.json`，其中保留顶点数、原节点旋转、
文件字节数、源 hash、BaseColor 尺寸和展示比例。`--check` 不改 sidecar/场景/项目，
缺失或失配会报错，不静默修复。prepare 仅新增不存在的 sidecar；重建本专用场景会
覆盖该检视场景的修改，审计冻结期不得执行。

## Audit 尚需检查

- 五件各自取得三角度，确认贴图、轮廓、遮挡和轴向；不以预览 PNG 代替实际 mesh。
- WPN-SHELL-01 正对底火端近景检查：交付预览可见黑碎片/不规则开口，需要区分
  网格、法线或贴图缺陷。任何修复生成派生产物，原源保留。
- WPN-FUEL-01 记录罐体直径/长度与含软管整体范围，确认管线连接；后续缩放以罐体
  实测为依据，不能把软管跨度缩成罐体长度。当前单 mesh 不证明管线可独立动画。
- WPN-MAG-02-SMG 实际长轴在 X，后续配方须显式转到弹匣 Y 长轴。
- WPN-07-LAUNCHER 节点变换后的长轴在 Z；后续按目检确认炮口正向后转到 +X，
  不沿用交付文本中的未标定轴向声明。

源目检解除前不减面、不发布 game_ready。WPN-01 现有三档已到位并保留；
用户已确认 WPN-02～06 本体明天交付，SMG/霰弹枪/喷射器精确装配和握点验收因此待定。
附件、握点和动画接入遵循 `packages/scene/src/weapons.ts`、`asset-meta.ts`、
现有 WeaponSystem phase、RuntimeSceneMotion 分层采样及采样后的 Body IK，
本阶段没有新增这些实现。

## WU2 导入绕序诊断（数值验证，视觉复核待定）

原源场景 GPU 目检发现多件模型密集黑条纹。源码核对定位到 `packages/scene/src/gltf.ts`：
POSITION 已应用 node 变换，`fixWinding` 却仍用 mesh-local NORMAL 判断，误翻部分三角形；
缺 NORMAL 时，又对已在世界空间生成的法线重复套 node 逆转置。修复统一顺序为
mesh-local 法线 → node 逆转置 → 同空间绕序修正，未修改 source、贴图或描边 shader。

五件都含约 90° X 节点旋转。下表使用原始 accessor、node matrix 和法线逐面计算，
记录旧/新判断会翻转的面数；并非删除这些面，亦不证明源法线全部正确。

| 源模型 | 旧空间判断翻面 | 同空间判断翻面 | 旧导入结束后法线/绕序不一致 |
|---|---:|---:|---:|
| Launcher | 9563 | 11 | 9558 |
| Fuel | 6089 | 122 | 6045 |
| Mag01 | 4406 | 7 | 4403 |
| SMG Mag | 9073 | 5 | 9072 |
| Shell | 9391 | 3459 | 7896 |

旋转、非均匀缩放、镜像和缺 NORMAL 回归以及已有 skin 测试共 37 项通过。
Shell 仍有 3459 面的源法线/绕序不一致，底火几何疑点保留；不能仅凭导入修正认证合格。
后续 Audit 须同时复看保留源模型和各派生 LOD，确认黑纹实际表现。
