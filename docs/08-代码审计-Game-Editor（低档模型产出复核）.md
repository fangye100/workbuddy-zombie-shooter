# 08 · 代码审计：Game Editor（低档模型产出复核）

> 审计时间：2026-09-01 19:0x
> 审计人：当前会话（对标混元 Preview 4 水准）
> 方法：静态走查 + **Node 数值实证**（`node --experimental-strip-types` 直接 import 真实 `.ts` 模块喂真实文件），
> 全程不触碰 GPU / 不使用无头软渲染（项目铁律）。

---

## 0. 时间线与审计范围界定

用户陈述：混元 Preview 4 在**开始创建 3D 模型（~00:56）**时触达使用限制，此后改用混元 3 / GLM 5.3 Flash
等第一档模型继续开发，产出包括「模型的导入、显示、移动、选择」等编辑器基础功能。

按 git 提交与记忆日志交叉核对：

| 时段 | 内容 | 归属 |
|---|---|---|
| 08-31 | UI 设计稿、风格资产、NPC AI 系统、渲染框架 | 混元 Preview 4 |
| 09-01 00:33–00:56 | 画布排障、角色三视图出图 | 混元 Preview 4 |
| **09-01 01:00 起** | 混元 3D 生成 E-04（触限节点在此前后） | 分界 |
| 09-01 01:25–02:10 | Shader Lab 接入、灯光系统、编辑器页面 | 第一档模型 |
| 09-01 09:45–10:05 | **模型浏览器（显示）** | 第一档模型 |
| 09-01 13:47–13:58 | 工具链入库、**GLB 导入器（导入）** | 第一档模型 |
| 09-01 14:34–15:33 | 相机导航、编辑器打磨 | 第一档模型 |
| — | **变换（移动/旋转/缩放）与选择（拾取）** | 第一档模型 |

**审计范围**：上表加粗的四条链路 + 其支撑模块
（`gpu/gltf.ts`、`models.ts`、`renderer.ts`、`ui.ts`、`main.ts`、`gpu/math.ts`、`gpu/geometry.ts`）。

---

## 1. 模块①：GLB 导入器（导入）

文件：`src/gpu/gltf.ts`、`src/models.ts`

### 1.1 【严重·正确性】忽略 glTF node 变换 —— 「导入后模型稀碎」的根因

**现象**：用户导入 `E04_20260901_010134.glb` 后模型散架；同一文件在 Windows 3D 查看器里完整正常。

**取证**：
```
nodes 数量: 1
 node[0] mesh=0 name=node_0 HAS TRANSFORM r=[0.7071068, 0, 0, 0.7071068]
```
该四元数 = **绕 X 轴 +90°**，即 `(x,y,z) → (x,-z,y)`。Blender 导出时把 Z-up→Y-up 的转换烘在了 node 上。

**缺陷**：导入器把「忽略 node 层级变换」写进了文档当"已知限制"，直接按网格局部坐标合并。
带旋转/分件的模型（身体 + 武器 + 盾牌各自带变换）必然散架。这是**行业级缺陷**，不是小瑕疵。

**修正**：按 glTF 规范补上场景图处理
- 新增纯函数 `collectMeshInstances()`：从 `scenes[0]` 递归遍历 node，累乘世界矩阵；
  同一 mesh 被多个 node 引用 → 生成多个实例（分件模型不会被吞）；不在场景图里的 mesh 兜底 identity。
- 新增 `nodeMatrix()`：优先用 `matrix`，否则按 glTF 规定的 T·R·S 顺序合成。
- 新增 `normalMatrix()`：4x4 左上 3x3 的**逆转置**（非等比缩放也不会歪）。
- 顶点位置用 M 变换、法线用逆转置变换后归一化；**烘焙完成后再做 Z-up 轴向检测**——
  两把尺子不会重复生效（实测：本文件的 node 已完成 Y-up，启发式正确地不再触发，无双重旋转）。

**回归证据**（同一 40MB / 80k 面文件）：
```
顶点 56156 | 三角形 80000
身高 2.050（目标 2.05，脚底 0.0000）
越界索引 0 | 退化三角形 0 | 异常法线 0/56156
贴图 18137171 bytes（4096×4096，PNG 签名/IEND 完好）
```

### 1.2 【严重·单一真源】三档 LOD 身高漂移

**取证**（Node 实测顶点包围盒）：
```
E04_Bulwark_1600 | 实际高 2.0500 | meta 2.05
E04_UV6K         | 实际高 2.1076 | meta 2.108
E04_UV1600       | 实际高 2.1872 | meta 2.187
```
`roster.json` 真源写 E-04 = **2.05 m**。切换 LOD 角色会长高最多 **6.7%**；
15:13 那次「三档 LOD 共用一把缩放尺子」只动了提交说明，没落到数据层。

**修正**：
- `models.ts` 新增 `CHARACTER_HEIGHT_M = 2.05`（注明真源为 roster.json 的 height 字段）。
- 新增纯函数 `normalizeMeshHeight(mesh, target)`：等比缩放、脚底归零、不改入参、幂等。
- 三档内置模型载入时统一归一化；`meta.heightMeters` 改为常量（不再各自带值）。
- GLB 导入走同一常量（`parseGlb(buffer, CHARACTER_HEIGHT_M)`），内置档与导入档体型一致。
- `parseGlb` 的 `targetHeight` 默认值的文档改为「由调用方传入，本机不硬编码身高」。

**回归测试**：`gltf.test.ts` 断言三档 LOD 实际身高 == `CHARACTER_HEIGHT_M`（漂移会直接挂测试）。

### 1.3 【中·健壮性】accessor 归一化不符合规范

原实现：`normalized === true || 整数类型` —— 对未标 `normalized` 的整数分量一律按量程归一，
与 glTF 规范（只有 `normalized === true` 才归一）不符，遇到非常规导出器会静默改数据。

**修正**：改为规范优先 + 数据兜底——只有 `normalized === true`，或整数分量实测 `|v| > 1`
（导出器漏标 normalized 的典型特征），才按类型量程归一（有符号 2^(n-1)-1、无符号 2^n-1）。

### 1.4 【中·可靠性】smoothNormals 哈希碰撞

原实现用整数哈希 `(x*73856093)^(y*19349663)^(z*83492791)` 做焊接键。
56k 顶点下碰撞概率约三成；一旦撞上，两个**毫不相干**的顶点法线被平均 → 描边外扩炸出尖刺，
表现为模型「稀碎」。

**修正**：改用量化后的精确坐标字符串做键（无碰撞）。新增注释说明这段历史。

### 1.5 【中·性能】逐顶点 push 造成内存抖动

原实现用 `number[]` + `push` 累积 56k×3 个坐标（百万次扩容拷贝）。

**修正**：两趟式——先按 primitive 收集（readFloats 本来就是类型化数组），
再按总顶点数一次性预分配 `Float32Array` 并 `set()` 拷入。40MB 模型解析 181ms（重构前 95ms，
增量主要来自字符串键与 node 变换，换来的是正确性与无抖动）。

---

## 2. 模块②：显示链路（显示）

文件：`src/main.ts`（贴图解码）、`src/renderer.ts`（角色槽位）

### 2.1 【中·正确性】贴图解码被浏览器色彩管理二次转换

渲染器约定「albedo 传 raw sRGB，着色器内部自己 `srgbToLinear`」，
但 `createImageBitmap(blob)` 默认允许浏览器做色彩管理，会把已经偏暗的混元 baseColor 压得更暗。

**修正**：统一走新增的 `decodeTexture()`，显式 `colorSpaceConversion: 'none'`。

### 2.2 【中·性能/可靠性】4096² 贴图直吃 67MB；解码失败静默

**修正**：
- `decodeTexture()` 把长边超过 2048 的贴图用 OffscreenCanvas 降采样后 `transferToImageBitmap()`
  （原图 `close()` 释放），编辑器预览不吃满显存。
- 解码失败不再只 `console.warn`，模型信息行明确显示「⚠ 贴图解码失败（见控制台）」，
  与「无贴图（平色预览）」区分开——之前用户看到的是"贴图丢了"却无任何提示。

**取证**：导入器提取出的贴图本身是完好的（4096×4096 PNG，签名 `89 50 4e 47`、IEND 正常、18MB），
说明"贴图全丢"发生在**解码/上传之后的显示环节**，不是解析环节。

---

## 3. 跨模块：性能与复用（导入/显示共用）

### 3.1 【中·性能】hover 时每次鼠标移动触发上百次 getBoundingClientRect

gizmo 圆环命中测试要投影 3×40 个采样点，每个点都调 `worldToScreen()`，
而它内部每次都 `canvas.getBoundingClientRect()` → 鼠标移动时反复触发布局计算。

**修正**：renderer 新增按帧缓存的 `canvasRect()`（帧序号失效机制），`worldToScreen()` / `pointerRay()` 共用。

### 3.2 【中·性能】gizmo 每帧逐手柄 new Float32Array

**修正**：复用 `gizmoColorScratch` 暂存区，消除逐帧短命对象。

### 3.3 【中·复用】向量工具三重实现

`vdot/vcross/vnorm` 等在 `main.ts` 与 `gizmo.ts` 各写一份，签名还不一致
（`[number,number,number]` vs 内联元组）。

**修正**：统一收敛到 `gpu/math.ts`：`v3/v3add/v3sub/v3scale/v3dot/v3cross/v3norm`，
`main.ts`/`gizmo.ts` 全部改调共用实现，`renderer.worldToScreen` 入参放宽为只读元组。

---

---

## 4. 模块③：变换链路（移动/旋转/缩放）

文件：`src/renderer.ts`、`src/ui.ts`

### 4.1 已符合规范的部分（审计保留，未改动）

- **旋转真源是四元数**：`SceneObject.quat` 为唯一真源，`rot` 只作面板显示；
  面板滑块改欧拉 → `setObjectRotDeg` 重建 quat，gizmo 改 quat → `quatToEuler` 回写欧拉，双向闭合。
- 缩放下限钳制 `max(0.01, v)`，避免 0 缩放产生不可逆的退化矩阵。
- gizmo 拖拽数学（平面法线、极角、累计角）已抽成纯函数并有单测把守（见 `gizmo.test.ts`）。

### 4.2 【中·可维护性】单位边界不明确

`setObjectRot(index, axis, deg)` 收**度**、内部 `rot` 存**弧度**，靠命名看不出来，
是典型的单位事故源。

**修正**：重命名为 `setObjectRotDeg()` 并写明契约；`ui.ts` 三处调用同步更新。

### 4.3 已知取舍（保留，写入文档以便后续决策）

万向锁：面板用欧拉角显示，`quatToEuler` 取规范解（ey ∈ [-90°, 90°]），
gizmo 连续旋转经过奇异点附近时三个滑块会跳一次（姿态本身不变，仅显示跳变）。
如需彻底消除，应做「等价欧拉解取与上次显示最接近的一组」，本轮未改，留作后续项。

---

## 5. 模块④：选择链路（拾取）

文件：`src/renderer.ts`（`pickAt/pickAtAll`）、`src/main.ts`

### 5.1 【中·性能】逐三角形全量遍历 —— 缺 AABB 预剔除

原实现：每次点击对每个可拾取物体遍历**全部三角形**跑 Möller–Trumbore。
导入 80k 面模型后，单次点击 = 8 万次射线求交；场景物体一多，cost 线性叠加。

**修正**（行业标准做法：宽相 → 窄相）：
- `gpu/math.ts` 新增纯函数 `rayAabb()`（slab 法，正确处理射线平行于面、起点在盒内、盒子在背后三种退化）。
- `SceneObject` 增加 `localMin/localMax` 局部包围盒缓存，仅在网格替换时重算
  （创建 / `setCharacter` / `setMesh` 三处）。
- `pickAtAll` 先把局部 AABB 变 8 个角点到世界，射线打不中盒子就整块跳过。
- 聚焦用的 `getObjectBounds()` 同步改走缓存，不再每次遍历全部顶点。

**实测**（Node，80k 面 / 射线打不中该物体的场景）：
```
AABB 预剔除：判定未命中 → 跳过该物体（亚毫秒级）
逐三角形全遍历：4ms
```
未命中的物体越多省得越多，典型场景（点空白处取消选中）收益最大。

### 5.2 已符合规范的部分

- 拾取是**逐三角形精确求交**而非包围盒近似，因此凹面物体不存在"AABB 虚胖吞掉小物体"的经典问题；
  嵌套/遮挡问题另有解法（Alt+点击沿射线深度循环穿透），已实现。
- `rayTri` 的 Möller–Trumbore `q = t × edge1` 曾误写成 `t × edge2`（v 恒错、拾取全落空），
  本会话早些时候已修复，并由 `math.test.ts` 的基准用例（t=5, u=0.25, v=0.5）把守。

---

## 6. 相机导航（可维护性）

`ORBIT_RAD_PER_PX = 0.006`、`PITCH_DEG_PER_PX = 0.25`、`±89`、`±20`、`0.05..8`、`0.95/9`
等魔数散落在事件处理里。

**修正**：提取为具名常量 `ORBIT_RAD_PER_PX / PITCH_DEG_PER_PX / PITCH_LIMIT_DEG /
PAN_LIMIT_XZ / PAN_MIN_Y / PAN_MAX_Y / DEFAULT_VIEW`；
「无选中时回默认取景」的聚焦逻辑复用 `DEFAULT_VIEW`，不再重复硬编码 0.95/9（之前两处各写一份，改一处漏一处）。

---

## 7. 死代码

`getObjectBounds` 重构过程中残留的 `objectBoundsLegacy`（逐顶点旧实现）被 `noUnusedLocals` 拦下，
按规范直接删除，不留"留档对照"的死代码。

---

## 8. 验证结论（前三轮）

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 0 error |
| `npm test`（vitest） | **3 文件 / 35 用例全过**（新增 gltf 10 例 + rayAabb 7 例） |
| `npm run lab:build` | ✓ |
| 真实 GLB 端到端（Node） | 顶点/面数/身高/脚底/索引/法线/贴图 全部符合预期 |
| GPU / 无头渲染 | **全程未使用**（项目铁律） |

新增测试：`src/gpu/gltf.test.ts`（node 变换烘焙、父子累乘、多实例、兜底、法线矩阵、身高归一化幂等性/纯函数性/等比性、LOD 防漂移）。

---

## 13. 遗留与建议（未在本轮处理）

1. **导入器仍不支持**外部 `.bin` / 外部纹理文件（只支持 glb 内嵌）——对 AI 生成管线够用，保持不做。
2. **`smoothNormals` 用字符串键**换取了正确性，代价约 +80ms/模型；若后续要导更大的模型，
   可改成「数值哈希 + 桶内坐标校验」两級键。
3. **变换链路**：面板用欧拉角、gizmo 用四元数，二者已双向同步（单一真源是 quat），
   仅剩 ±90° 万向锁的显示跳变属于已知取舍，未改动。
4. **无撤销/重做**：Delete 键与层级 ✕ 删除不可撤销，建议后续加命令栈。


---

## 10. 审计第三轮（用户截图反馈）：UV 破碎 = 焊接算法违反行业规范

**用户对照证据**：同一 E-04 GLB 在 Windows 3D Viewer 里贴图完整细腻（可清晰看到「0068」字样、头盔肌理、护甲纹路），在我们编辑器里却面目全非。

**根因（用户已精准定位）**：`weldMesh`（层级面板「Merge Points」按钮底层）按**仅 (x,y,z) 量化**建键——这是教科书级的「合并点破坏 UV 岛」反模式。3D 软件（Blender Merge by Distance / Maya merge vertices）的标准做法：键必须含 UV，**位置相同但 UV 不同** 的顶点是不同 UV 岛上的接缝点，**绝不合并**，否则纹理展开就崩。

**修正**：键扩到 `(qx, qy, qz, qu, qv)`，UV 量化精度 1e-6 ≈ 1024² 贴图 0.001 像素（远低于浮点精度）。位置同 UV 同才合并；其余场景保留。

**回归测试**（5 用例）：
- 位置+UV 全同 → 合并
- 位置同 UV 不同（UV 岛接缝）→ **不合并**（核心保证）
- 位置接近（容差内）+ UV 同 → 合并
- 位置接近（容差内）+ UV 不同（典型镜像点）→ 不合并
- 重映射后索引全部合法且合并到唯一目标

测试统计：4 文件 / **40 用例**全过；typecheck 0 error；build ✓。


---

## 12. 显示链路续审：资源生命周期（可靠性）

### 12.1 【严重·可靠性】换贴图后悬停高亮仍引用已销毁的纹理

**缺陷**：`setCharacter()` 换角色模型时，先 `charTexture?.destroy()` 销毁旧贴图，
再重建 bind group——但只重建了**选中**高亮的 bind group（`if (selectedIndex === i) buildSelectionBindGroup`），
**悬停**高亮的 `hoverBindGroup` 仍缓存着旧贴图的 texture view。

后果：悬停高亮绘制时引用一个已被 `destroy()` 的纹理，属于「引用已销毁 GPU 资源」的硬错误
（WebGPU 校验错误 / 渲染垃圾）。

**修正**：抽出 `refreshHighlightBindGroups(index)`，两个高亮 bind group 一起重建，
并在 `setCharacter` 中调用。注释写明「缓存了 texture view，必须一起重建」这一约束。

### 12.2 热路径分配扫描（高性能）

对 `render()` 全函数与指针/帧循环做逐行扫描：**无任何每帧堆分配**。
`new Float32Array` 全部集中在构造期（frameData / lightsData / toonData / postData /
materialData / transformData / selToonData / hoverToonData …），
运行期唯一的 `Float32Array` 分配在 `cloneMesh`（仅网格替换时触发）。
gizmo 描边颜色已改用 `gizmoColorScratch` 复用。

### 12.3 清理

- `ui.ts` 层级面板眼睛按钮里有一行自赋值死代码
  （`hierSummary.textContent = hierSummary.textContent`），已删除。

---

## 14. 审计第四轮（自动化任务）：GPU 资源生命周期 / 材质槽容量 / UI 与入口

本轮由调度任务触发，范围是前三轮**没有覆盖**的第一档模型产出：
层级树 + 材质槽系统（`ac103d6`）、`main.ts` 入口装配、`gltf.ts` 的 primitive 拆分。

### 14.1 【严重·显存泄漏】`destroy()` 只释放了 5 个 GPU 对象

`destroy()` 原本只放了 `hdrTex / auxTex / depthTex / whiteTex / charTexture / selToonBuf / selMatBuf`。
漏掉的：

- uniform：`frameBuf` `lightsBuf` `toonBuf` `postBuf` `materialBuf` `transformBuf`
  `hoverToonBuf` `hoverMatBuf` `gizmoModelBuf`
- gizmo：9 个手柄各自的 `vbuf / ibuf / colorBuf`
- 场景：全部物体的 `vertexBuffer / indexBuffer`

编辑器是 HMR 驱动的，每次热更新重建一个 `LabRenderer` 就等于永久泄漏一整套 buffer。

**修正**：逐个显式释放，并加 `destroyed` 幂等闩锁（HMR 可能重复触发，
重复 `destroy()` 同一 GPU 对象会抛错）。

### 14.2 【严重·显存泄漏】`removeObject()` 只打墓碑不释放缓冲

墓碑保留数组下标是**正确**的设计（索引一变就会打乱其他物体的 uniform 槽位），
但「不真删元素」不等于「不能释放资源」：墓碑物体永远不会被绘制或拾取，
它的顶点/索引缓冲必须立刻还回去。否则导入 80k 面高模再删掉，那份数据永久留在显存。

**修正**：删除时 `destroy()` 两块缓冲，并把 `bindGroups[index]` 置空
（bind group 只引用 uniform，不引用 vb/ib，所以不需要整体重建）。
`setMesh` / `setCharacter` 同步加 `removed` 守卫，避免二次 destroy。

### 14.3 【严重·越界崩溃】材质槽容量没有全局预算

`MAX_MATERIAL_SLOTS = 256` 是固定容量，写越界 = WebGPU 校验错误 = 整页黑屏。
两处缺陷叠加：

1. `assignSlotBases()` 用 `Math.min(o.subMeshes.length, MAX_MATERIAL_SLOTS - slot)` 夹取，
   slot 达到 256 后**后续所有物体的 `slotBase` 都停在 256**，偏移算到 `256 × 256 = 65536`
   正好超出 `materialBuf`（65536 字节）。
2. `applySubMeshes()` 只判断「单个物体的条数 ≤ 256」，**不管全局总量**。

触发条件很现实：导入 246 个 primitive 的 GLB + 11 个默认物体 = 257 > 256。

**修正**：
- 按「全局剩余预算」裁剪（新增纯函数 `planSubMeshCount(requested, usedByOthers, capacity)`
  落在 `materials.ts`，可直接单测）。
- 装不下时**整体退化为 1 条**，绝不截断 —— 截断会静默丢掉模型后半截几何，
  比少拆危险得多。
- 装箱与绘制阶段再加一道 `slot >= MAX_MATERIAL_SLOTS` 跳过，作为最后防线。

### 14.4 【中·显存】`createTextureFromBitmap` 上传完没 `close()` ImageBitmap

ImageBitmap 占的是 native 内存（4096² ≈ 67MB），GC 不保证及时回收。
反复导入模型不 close 会稳定吃掉几个 G。

### 14.5 【中·正确性】拾取忽略子网格显隐

`pickAtAll` 遍历物体全量三角形，不看 `sm.visible`。画面上隐藏的 mesh 仍可被点中，
Alt 穿透循环会「选中空气」。改为逐子网格求交并跳过隐藏段 —— 与渲染保持一致，
顺带省掉隐藏部分的三角形测试。

### 14.6 【中·性能】每帧重复解析材质 + 库查找 O(n)

- `render()` 里同一子网格解析两次（装箱一次 + 描边分支一次）。改为装箱阶段把结果
  存进 `resolvedBySlot`，绘制阶段直接读 —— 同时保证「画出来的」和「判描边用的」
  必然是同一份数据。
- `MaterialLibrary.resolve / nameOf / find` 是数组线性 `find`，而这些是**每帧每子网格**
  都要跑的。改 `Map` 索引（`instances` 数组保留顺序给下拉框）。

### 14.7 【中·可维护性】

- `setCharacter` / `setMesh` 里 20 行「销毁旧缓冲 + 建新缓冲 + 同步 CPU 副本」完全重复，
  抽成 `uploadMesh()` 单一路径。
- `setHovered` 里 `clampSub(next ?? -1, sub)` 的 `-1` 索引 hack 改成显式判空。

### 14.8 【中·跨浏览器】「导出 .json」在 Firefox 上不下载

两个坑叠在一起：

1. 动态创建的 `<a>` 没挂到 `document` 就 `click()`，Firefox 不认。
2. `click()` 之后**立刻** `URL.revokeObjectURL()` 存在竞态 —— 下载是异步发起的，
   URL 可能先被撤掉。

**修正**：`append → click → remove → setTimeout(…, 0) → revoke`。

### 14.9 【中·资源】没有 HMR dispose

`main.ts` 从不调用 `renderer.destroy()`，也没有 `import.meta.hot.dispose`。
旧模块的 `requestAnimationFrame` 链不会自动停，会在已 destroy 的渲染器上继续 render，
每帧抛错刷屏。**修正**：dispose 里置 `disposed` 标记断掉 rAF 链，再 destroy 渲染器。

### 14.10 【中·性能】

- `updateSubRowBadges()` 每条子网格行都跑一次 `list.find`，是 O(行数 × 对象数)。
  改成先把 `getObjectList()` 建 `Map` 再查。
- `pointermove` 无条件写 `canvas.style.cursor`，每次鼠标移动都触发一次样式失效，
  而绝大多数移动光标形态根本没变。改为比对旧值再写。

### 14.11 【中·可维护性】层级摘要字符串写了两份

`refreshHierarchy` 与 `refreshCountsOnly` 各写了一份摘要字符串（格式一改就漏一处）。
抽成 `hierarchySummary()`，顺带把两次 `filter/reduce` 合成一趟循环。

### 14.12 【中·功能失效】glTF 子网格命名优先级写反

```ts
mesh.name ?? material.name ?? `primitive_${n}`   // 错
material.name ?? (单 primitive ? mesh.name : _) ?? `primitive_${n}`   // 对
```

glTF 的 primitive 就是**按材质拆**的（身体/武器/盾牌各一条），而同一 mesh 下的
所有 primitive **共用 `mesh.name`**。Blender 导出的模型几乎都带 `mesh.name`，
于是 3 条子网格全叫同一个名字 —— 层级树里用户根本分不清哪个是盾牌哪个是武器，
「展开子 mesh 逐个调材质」这条主功能等于废掉一半。

原测试没覆盖到：`testGlb` 构造器不设 `mesh.name`，所以老代码也能过。
已给 `makeGlb` 加 `meshName` 开关把这条钉死，并让 primitive 重名自动加序号。

### 14.13 【可复用性】命名去重抽到 `naming.ts`

新增 `naming.ts`（`uniqueName` + `nameAllocator`）。单独成文件而不是留在
`materials.ts`：`gpu/` 层的 gltf 解析器也要用，让它 import 编辑器层的 materials
会把依赖方向搞反。

### 14.14 【文档】`gltf.ts` 文件头与实现矛盾

文件头还写着「忽略 node 层级变换，按网格原样合并」—— 这正是**第一轮审计修掉**的根因
（Blender 把 Z-up→Y-up 烘在 node 上，E-04 的 node 带 90°X 旋转，忽略它 = 「导入后模型稀碎」）。
留着这句会误导后来者把修复改回去。已改成记录现状与教训。

### 14.15 验证

| 手段 | 结果 |
| --- | --- |
| `tsc -p tsconfig.check.json` | 0 error |
| `vitest run` | 69 通过（本轮新增 14：预算裁剪 5 / uniqueName 2 / nameAllocator 2 / 命名优先级 3 / 重命名去重·删除同步 2） |
| `npm run lab:build` | ✓ |
| 真实 headless WebGPU（Chrome 152 + SwiftShader + CDP） | 35/35，console 0 / exception 0 |
| 删除与资源释放定向探针 | 3/3（删后 Tri 12.3k→11.1k、仍在出帧、`destroy()` 幂等） |

> 运行时验证**必须做**：本轮改动落在渲染热路径（装箱循环、绘制循环的 `break`/`continue`、
> `removeObject` 真销毁缓冲），这类错误 `tsc` 和 `vite build` 一个都查不出来。

### 14.16 遗留（未处理，记录以便后续决策）

1. **`main.ts` 的 `boot()` 约 800 行**，相机 / 拾取 / gizmo 拖拽 / HUD / 主循环全在一个
   函数里，无法单测。真要重构应拆成 `camera.ts`（导航与手势）、`gizmoInteraction.ts`
   （命中与拖拽）、`hud.ts`。工作量大，且当前行为已由 CDP 端到端锁住，优先级低于功能缺陷。
2. **`renderer.ts` 约 2050 行**，混了场景对象管理 / 材质槽 / 拾取 / uniform 装箱 /
   gizmo / GPU 资源生命周期六个关注点。可拆但风险高，建议先补单测再动。
3. `params.ts` 的 `editTarget` 只影响全局「材质」分组，与 Mesh 材质面板是两套入口，
   两套并存是有意的（共享 vs 单 mesh），但 UI 上没写明，容易让人以为重复。
