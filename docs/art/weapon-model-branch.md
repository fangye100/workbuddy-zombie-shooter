# 武器模型分支与独立快照

模型owner分支为`codex/weapon-models-20261012`，基线`48ac35fb748e0ee265c4e71eabb202be03439b7f`。
输入是动画分支固定快照`bd115a59c24bf7012d7ebabd51b7ff81e607ff90`，不改写已发布历史。
本分支独立保存两批10件原源、54个新增派生GLB、WPN01既有三档及LOD0附加数据、纹理与报告。
源GLB/front/preview/job/delivery不处理；所有迁移GLB与sidecar按输入字节保存，稳定GUID、sourceHash、物理socket及动作frame不删除或重标。

七个静态场景为`weapon-source-review`、`weapon-lod-review`、`weapon-source-fixed-views`、
`weapon-surface-transfer-review`、`weapon-body-source-review`、`weapon-body-lod-review`、`weapon-fit-review`，均在`assets/scenes/sandbox/`并登记项目。
它们仅含Camera/Light/MeshRenderer，唯一内容适配是schemaVersion 17→16，使用本基线实际schema；没有移植动画assembly或新迁移链。
合回动画分支时应保留动画schema v17并将这些静态场景版本恢复为17，保留场景节点、GUID、相机与材质。

`modelSockets`/`boneSockets`在meta v1仍是可选附加数据，校验与公共类型由`packages/scene/src/model-attachments.ts`提供。
命名动作frame仅保存数据；Game在动画分支拥有消费约定。本分支未移植Game投影、RuntimeWeapons、render IK/资源绘制、H01 boneSocket修改、trial、prototype或三个floor武器配置。
节点法线/绕序的同空间修复及Asset Browser预览/导入对sidecar米制与upAxisFlip的消费是模型兼容责任。

纯离线减面、纹理转移、局部分件、Launcher已发布0.90后处理和源/LOD检视工具随模型迁移。
`calibrate-weapon-models.mjs`、`check-weapon-fit.mjs`、`check-weapon-motion-fit.mjs`、Launcher肩链回归和动态Play probe留在动画分支。
fit检视场景为固定模型快照，其测试只检查静态端面与容量；此分支没有读取prototype的fit生成器，不能执行不存在的生成命令。
历史工具重建不是本次迁移方式；禁止为了迁移重做Shell底火或所有LOD。Python工具需要独立环境中的numpy/Pillow/pymeshlab，未在本分支安装全局依赖。

```powershell
pnpm exec vitest run packages/scene/test/gltf.test.ts packages/scene/test/model-sockets.test.ts
node --test tools/art/prepare-weapon-fit-review.test.mjs tools/art/prepare-weapon-body-review.test.mjs
pnpm run scene:check
pnpm run architecture:check
pnpm run typecheck
pnpm run knowledge:check
```

状态必须区分交付、处理候选与实际验收：Launcher普通前腔换弹在动画b489目标有可见证据，但同源round底火仍未批准；Shell旧源和派生round等待用户补交修复实源。
Fuel贴图接缝已有有界修复，实际装配及动作选择仍pending；未发布的缩放/侧倾/前下平移草案不在本分支。
部分SMG/Sniper/Pistol附件有有限实操像素，Shotgun仍遮挡；本分支静态快照不等于动画、全LOD或全资产批准。
旧Shell源SHA256仍为`92826b57858f4e99fe552d607972f7315a9183c020a49651e3320ae95a70b063`。

后续合回由Main编排，逐项合并project登记、catalog、最小导入改动及可选meta类型；不能覆盖动画分支的v17 schema、runtime或已有sidecar动作frame。

统一发现入口：底部资产库选`assets`，勾选「包含子目录」，类型选「模型」，搜索`WPN`。
项目根或任一`project.assetRoots`根勾选递归时列举全部资产根；根内子目录只递归该子目录。
重叠根去重，类型与搜索作用于真实文件路径，不新增资产数据库或项目字段。目录读取失败显示「列举不完整」，不能把部分结果当作完整资产集。
当前武器模型共68个GLB：10原源、54新增派生、WPN01既有三档及原源；完整/去重复变体、各档LOD与失败候选均保留可发现。
条目显示完整路径及sidecar已有variant/status；未标注状态不意味着验收通过。
单击显示Inspector属性、GUID与预览，双击、Inspector「载入场景」或拖到画布沿用同一真实路径。
Inspector/预览/导入均读取该路径sidecar，`normalizeHeightM:null`保留米制，`upAxisFlip`选择现有解析轴适配；缺失或坏meta显式拒绝该模型解析。

本次独立验收服务入口为`https://fangye-win11-office.tail6b29a2.ts.net:5199/?scene=assets/scenes/sandbox/weapon-source-review.scene.json`，仅本次隔离试验服务；仓库固定5100契约未改。
先选择统一列表，再检查10原源、WPN01、去重复body、三档LOD及Shell/Fuel候选的属性/预览/载入；真实GPU与可见UI尚待Audit，离线清单与测试不能代替批准。
只读快照`__editor.assets.getState()`新增paths/recursive/kind/errors；实际入口以main暴露的assets对象为准，操作应使用正常UI。

```powershell
pnpm exec vitest run apps/editor/test/asset-listing.test.ts apps/editor/test/asset-inspector.test.ts apps/editor/test/models.test.ts
pnpm run editor:build
```
