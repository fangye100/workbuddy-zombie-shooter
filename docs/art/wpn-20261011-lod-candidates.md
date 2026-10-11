# WPN-20261011 归一化与 LOD 候选检视

五件交付已生成独立三档预算内候选，状态为 `visual-review-candidate`，尚未批准玩法使用。
原 GLB/front/preview/job/delivery 保留，WPN-01 不重生成。用户已确认 WPN-02～06 本体
明天提供；SMG、霰弹枪、喷射器附件的精确装配及角色握点仍需对应本体。

## 持久化检视入口

- `assets/scenes/sandbox/weapon-lod-review.scene.json`：60 个 mesh，5 行 × 4 组 × 3 朝向。
  每行依次为 Launcher、Mag01、SMG Mag、Shell、Fuel；每组依次 Reference、LOD0、LOD1、LOD2。
  Shell Reference 为局部修复参考，其他 Reference 是原源按明确配方规范化的展示副本。
- `assets/scenes/sandbox/weapon-source-fixed-views.scene.json`：15 个原源副本，固定三向，
  用于源黑纹、原底火和派生修复的对照。原 `weapon-source-review.scene.json` 保留。
- 两个新场景均登记在 `aether.project.json`。编辑器 File → Open 选择对应中文名称，
  或 URL 使用 `?scene=assets/scenes/sandbox/weapon-lod-review.scene.json`。

节点 ID：候选 `nd_wpn_lod_<0..4>_<0..3>_<0..2>`，原源固定视角
`nd_wpn_raw_fixed_<0..4>_<0..2>`。第二下标 0 为 Reference，1..3 为 LOD0..2；
最后下标 0 为侧 +Z、1 为端 +X、2 为俯 +Y，Shell 第 2 槽改为底火 -Y。
双击层级节点或选中后 F 聚焦。初始相机 yaw/elevation 为 0，副本旋转已写入场景，
不用拖动 gizmo 猜视角。Mag 的 +Y 插入端位于第三槽；Launcher +X 炮口位于第二槽。

同一件各档使用相同展示比例、材质及 canonical 原点。没有按每档 extents 单独缩放，
没有额外地面/文字 mesh。场景显示 BaseColor，不能据此认证源 normal/MR 完整 PBR。
Audit 必须使用 headed 真实 GPU，并记录实际 URL、精确 HEAD、加载/console/GPU 错误和
可辨认的三向画面。截图前不能 Save 被误拖动的作者场景。

## 管线与空间

`tools/art/build-weapon-lods.py` 复用 `assets/characters/_tools/decimate_uvkeep.py` 的
GLB/node-world/OBJ/wedge 打包机制和 `assets/environment/_tools/build_environment_lods.py`
的无损 render-vertex compaction。未调用建筑专用质量职责。每档重新加载同一源或同一
局部修复参考，未从上档继续减面。

1. source accessor → GLB node world（所有原源约 90° X 节点旋转）→ 明确 recipe 旋转。
2. 统一正比例缩放，XZ 居中、Y 贴底；不声称同时命中规格各轴。
3. 写入米制/Y-up GLB，再经运行时 `parseGlb(buffer,null,'y')` 仍会自动 XZ 居中、Y 贴底。
   report 每档 `parserRecenterMeters` 记录额外偏移，sidecar
   `canonicalToImportTranslation` 记录 canonical → 真正渲染的 final import-space。
   对照场景用位置补偿抵消该 importer 偏移，不隐藏轮廓/尺寸差异。

未来 socket 必须在真正的 final import-space 标定；当前仅准备坐标变换和来源数据，
没有把候选 mount 称为已匹配角色握点。场景 override 应优先于后续 sidecar 默认。
资产库预览、双击导入与场景装载现在均消费 sidecar 轴向，避免 Launcher Z 长轴被再自动翻转。

Launcher 节点变换后有孔炮口 +Z、实心黄后盖 -Z，Y+90° 后炮口 +X；需 GPU 复核。
Mag01 黄底板 -Y/开口 +Y。SMG 长轴 X，较窄突出颈 -X 作为候选插入端，Z-90° 后为 +Y；
没有本体证明精确 fit。Shell 红壳 -X/铜座 +X，Z-90° 后底火 -Y。
Fuel 罐体 X 长轴转到 Y；按非黑色罐体表面测得的 X 长度缩为 .25m，软管保留，
整体含管范围没有机械缩成罐体 .25m。颜色辅助测量、罐体范围与整体范围分别落 report。

## 实测候选与未通过项

| ID | LOD0 / LOD1 / LOD2 tris | 实际规范化 X/Y/Z m（源范围，保持比例） |
|---|---:|---|
| Launcher | 3000 / 1500 / 494 | .750 / .406 / .203 |
| Mag01 | 400 / 200 / 80 | .0456 / .110 / .0210 |
| SMG Mag | 400 / 187 / 77 | .0250 / .110 / .0258 |
| Shell | 400 / 200 / 78 | .0387 / .070 / .0384 |
| Fuel | 796 / 391 / 145 | .186 / .272 / .119（整体含管） |

每件 BaseColor PNG 和 GLB 内嵌图均为 1024²，材质仍引用原图降采样结果。
Launcher LOD0/1、两个 Mag 的 LOD0 使用 texture-QEM；其余档为普通 geometry-QEM
保留逐角 wedge UV 的候选，随后删除退化/重复/非流形面。普通 QEM 未认证 atlas
接缝、贴图拉伸或细槽可读性；不得把“仍有 UV”当成美术通过。

硬门禁为目标面数上限、有效 hash 和有限位置/法线/UV。原 `.9..1.1` surface ratio、
`.05` bounds drift 指标继续保留为逐档 diagnostic，没有伪造通过；远档内槽面积减少
不单独证明外轮廓失败。report 同时记录三正交几何 silhouette IoU、signed volume 比和
实际 bounds，用于指出审计重点，不替代 GPU 视觉。SMG/Shell LOD2 的部分投影 IoU
约 .824/.785，Mag01 LOD1 的 bounds 漂移约 8.31%，这些候选尤需审计，可能必须修订。

Shell 原位置焊接后 41638 面、582 boundary、22 nonmanifold；派生去浮片/退化及非流形
面共 3406 面，再填局部洞 448 面，修复参考 38680 面、14 boundary、0 nonmanifold。
增补面沿用最近源面角 UV；新增面质心范围和各步骤面积/拓扑写入 report。保留外壳与铜座
主体，不是整体新造程序化弹壳；剩余边界和底火外观仍未批准。

## 可复现验证与发布

```powershell
.workbuddy/tmp/art-python/Scripts/python.exe tools/art/build-weapon-lods.test.py
.workbuddy/tmp/art-python/Scripts/python.exe tools/art/build-weapon-lods.py
.workbuddy/tmp/art-python/Scripts/python.exe tools/art/build-weapon-lods.py --publish --only WPN-07-LAUNCHER WPN-MAG-01 WPN-MAG-02-SMG WPN-SHELL-01 WPN-FUEL-01
node tools/art/prepare-weapon-lod-review.mjs
node tools/art/prepare-weapon-lod-review.mjs --check
node tools/art/prepare-weapon-source-review.mjs --check
pnpm run scene:check
pnpm run knowledge:check
```

独立 venv 使用 Python3.13.3/numpy2.5.4/Pillow12.3.0/pymeshlab2025.7.post1；不安装全局。
构建在 ignored `.workbuddy/tmp/wpn-integration/lods`，publish 检查 source/recipe/pipeline/LOD
hash，拒绝过期或硬预算失败。已发布目录为 `assets/art/models/<ID>/game_ready`，report 在
其父目录。sidecar GUID 按初次路径哈希稳定生成；已有 sidecar hash 漂移报错，不静默覆写。
`prepare` 会重建专用场景，冻结审计期禁止运行；`--check` 只校验已发布数据。

当前没有挂正式 floor、没有新增附件装配/动画时钟，也没有完成角色握点、切枪/换弹或 Stop
资源释放验收。Main 以固定提交派 Audit；视觉结论解除后才继续相应接入。
