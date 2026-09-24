# tools/mcp-binding — 绑定领域 MCP server（WU-2 起）

把 `BindingSession`（绑定编辑的唯一领域状态 owner）暴露成 MCP 工具，
让 Agent 能**看见**自己的绑定操作结果（视觉反馈闭环），并把调好的绑定
**导出成干净 T-pose 的 rigged GLB**（WU-3 起，与编辑器 exportBound 同管线）。

> 🔴 **用本 server 摆骨骼 joint 前必读**：
> [骨骼节点视觉修正流程](#🔴-骨骼节点视觉修正流程强制纪律) ——
> 必须可视化（截图看图）修正，每轮核对必须过独立审核员子代理直到 PASS，
> joint 经用户确认后才许进 wrapper 阶段。禁止盲调坐标。
>
> 🔴 **手臂/腿近直（自然下垂）时不要硬算关节位置** —— 没有几何拐点，
> 各信号必然矛盾。走
> [近直肢体（手臂链）收敛方法](#近直肢体手臂链收敛方法--2026-09-24-e-01-复盘)：
> 出候选高度对照图 + 明确推荐值/副作用表 + `AskUserQuestion` 单选，一轮收敛。
>
> 🔴 **进行骨骼对齐时，先关掉圆柱体的 Skin Wrapper**（MCP 路径：`render` 传
> `showCylinders:false`；编辑器路径：`__editor.binding.wrappers.set(false)`），
> 等骨骼验证通过以后，再显示出这个 Skin Wrapper——半透明 proxy 圆柱会污染
> 截图，干扰 joint 与模型关节的对位判读。

```
Agent ──MCP(stdio)──▶ server.mjs ──▶ dist/domain.mjs ──▶ BindingSession
                        │                （同一套领域操作，GUI 与 Agent 共享）
                        └── node:fs / zlib（PNG 编码）
```

## 分层（改动前先读）

| 文件 | 职责 | 约束 |
|---|---|---|
| `src/render.ts` | 正交投影光栅器：点云/骨线/关节/wrapper 轮廓/热力 → RGBA | 纯 TS，**禁 import node:*** |
| `src/tools.ts` | 工具表 + 参数校验 + `BindingDomain`（持有 session，fs 走注入的 `FsPort`） | 纯 TS，**禁 import node:*** |
| `src/domain-entry.ts` | esbuild 打包入口 → `dist/domain.mjs` | 纯 TS |
| `server.mjs` | NDJSON stdio 帧 / node:fs / PNG 编码 / 版本协商 | 零依赖 .mjs，不进 typecheck |
| `probe.mjs` | 自检：构建 → spawn → 全链路断言 | 零依赖 .mjs |

纯 TS 层被 `tsconfig.check.json` 覆盖（include `tools/mcp-binding/src/**`）。
仓库未装 `@types/node`，所以**任何 node API 只能出现在 .mjs shell 里**——
这是分层存在的理由，不要把 node import 写进 src/。

两条工具层语义（与 GUI 对齐，独立审核收口）：

- **历史粒度 = 一次工具调用一步**：MCP 没有 GUI 的手势边界（pointerup），
  每次写工具成功后立即 `sealHistory()` 封口 800ms 合并窗——Agent 脚本化连调
  不会被并步，undo 粒度与工具调用一一对应。
- **错误通道**：参数非法 / 前置条件不满足 → JSON-RPC `-32602`（带中文原因）；
  实现 bug → `-32603`。骨名一律过 HUMANIK_ORDER 白名单（不用活引用键查，
  防原型链键污染）。

## 构建与自检

```bash
pnpm run mcp-binding:build   # esbuild 打包 src/ → dist/domain.mjs（dist 已 gitignore）
pnpm run mcp-binding:check   # = probe：构建 + 全链路断言（真实 GLB / PNG 解码 / save 闭环）
```

改了 `src/**` 必须重跑 `mcp-binding:check`（probe 每次自己先构建，dist 不会过期）。

## 工具表（16 个）

| 工具 | 语义 |
|---|---|
| `load_model` | 载入仓内 .glb（parseGlb 默认 2.05m 标尺 = 编辑器同尺）；sidecar 有 bindingEditor 自动回填 |
| `get_state` / `get_joints` | 会话总览 / 27 关节坐标 + 合法骨名表 |
| `set_joint` / `mirror` / `reset_pose` | 摆关节（自带历史）/ 左右镜像 / 回模板 T-pose |
| `undo` / `redo` | 撤销重做（与 GUI 同一历史栈纪律） |
| `cylinders` | wrapper 表操作：get / autoFit / setRadius / setOffset / clearOffset / mirror / mirrorAll / unpin。⚠️ `autoFit` **跳过 `manual:true` 的圆柱**且成功返回（`changed` 可为 0）——全手动表上等于空操作，要先 `unpin` |
| `set_options` | 权重导出选项（weightMode / smooth* / mirrorWeights；越界按面板同款钳制） |
| `compute_skin` | 算权重只回统计（未包裹顶点数等），不回权重数组（token 纪律） |
| `render` | **视觉反馈核心**：正/侧视 PNG 图像块，可选 heatBone 热力图、selectedJoint 高亮；`style:'toon'` = 实心填充 + 深度台阶/掠射法线翻转边的实体轮廓线（2D 卡通效果，重叠在躯干上的四肢清晰可见，无线框噪音）；`azimuthDeg`（±60°）= 视差观察角，投影前绕 Y 旋转，错开重叠肢体判读 |
| `get_editor_data` / `save` / `hydrate` | 编辑态读 / 写 sidecar（validateAssetMeta 守门）/ 从 sidecar 重灌 |
| `export_glb` | 导出干净 T-pose 的 rigged GLB（编辑器 exportBound 同管线 `rigToTPoseWithImage`）。只回统计不回字节；已有 sidecar 外科式刷新 sourceHash/updatedAt，没有则提示跑 `scene:gen`。目标已存在需显式 `overwrite:true`（覆盖源模型恒拒） |

两条导出边界（WU-3 定）：

- **动画烘焙不走 MCP**：`BindAnimationInput`（BVH 重定向轨道）是 retarget 的领域，
  编辑器面板独占；`export_glb` 产物只含静态 T-pose 绑定。
- **首版 sidecar 不代建**：新资产的 roster 字段（characterId / normalizeHeightM）
  是 `gen-asset-meta.mjs` 的职责；`export_glb` 只对**已存在**的 sidecar 刷新
  sourceHash/updatedAt（重导场景立刻满足 scene:check 哈希门禁）。

注：`export_glb` 不改会话的任何运行时标记——`get_state` 的 `bound/bindPoseFrozen`
是编辑器面板的徽标语义（不进持久化），MCP 导出后它们不变是预期行为。

## 注册到 ZCode

`.zcode/config.json` 的 `mcp.servers`（注意：同 scope 存在 `.zcode/` 时 `.agents/mcp.json` 被整体忽略）：

```json
{
  "mcp": {
    "servers": {
      "aether-binding": {
        "type": "stdio",
        "command": "node",
        "args": ["C:/Users/fangy/WorkBuddy/game-design-zombie/tools/mcp-binding/server.mjs"]
      }
    }
  }
}
```

首次使用前**先跑过一次** `pnpm run mcp-binding:build`（server 只读 dist/domain.mjs）。
注册后需重启 ZCode 会话；工具以 `mcp__aether-binding__<tool>` 出现。

## 典型闭环（Agent 视角，工具调用草图）

> ⚠️ 下面只是工具顺序。**摆 joint 不允许按这个草图盲调**——必须走
> [🔴 骨骼节点视觉修正流程](#🔴-骨骼节点视觉修正流程强制纪律)：
> 看图修正 + 每轮过独立审核员直到 PASS + 用户确认后才进 wrapper 阶段。

```
load_model → render(front+side)            # 看见模型与模板骨架的错位
  → set_joint × N → render                 # 看见摆位结果
  → cylinders autoFit → render             # 看见 wrapper 覆盖
  → render(heatBone=LeftArm)               # 看见权重热力
  → compute_skin（unwrappedVerts 是否归零）
  → save                                   # 落盘 sidecar（门禁 validateAssetMeta 守门）
  → export_glb                             # 产出干净 T-pose rigged GLB（统计：零权重/tip 权重/身高守恒）
  → pnpm run scene:gen && pnpm run scene:check   # 首版 sidecar + 门禁（metaRefreshed=false 时）
```

## 🔴 骨骼节点视觉修正流程（强制纪律，2026-09-23 E-01 事故沉淀）

### 铁律（违反任何一条 = 返工）

1. **必须可视化修正**：joint 摆放只能以「自己截的图」为依据，把 joint 点
   对到模型的**生物关节**上（肘点对肘弯、膝对膝盖、脊柱沿背部弧线、头链进颅腔）。
   **禁止**用点云/数值聚类等量化分析代替看图——不看图就不可能对准关节。
2. **截图必须自己拍**：自己控制的浏览器 + 编辑器截正/侧视图。
   **禁止**拿用户提供的标注图做坐标换算（不知道画布 rect 与裁剪比例，换算必错）；
   用户的标注图只用来理解「他指的问题是什么」。
3. **批处理，不逐点循环**：一次截图 → 把一侧身体 + 中轴的全部 joint 一次算好 →
   批量 `set_joint`（或 hook `pose`×N）→ `mirror` → 存盘 → 重截图复核。
   禁止「调一个 joint 截一次图」的逐点循环。
4. **每轮截图核对必须过独立审核员，直到 PASS 为止**：每完成一轮摆放，
   启动一个**全新上下文**的子代理 reviewer（独立模型 + 独立上下文，
   与调整者不同源），按**生物关节可视程度**逐关节审核截图；
   FAIL 就按审核员证据修正后重截重审，循环到 PASS。
   自己（调 joint 的那个 agent）审核自己 = 无效，不许自证。
   ⚠️ 审核员必须同时判**沿肢体方向的落点**（铁律 7），只核「在不在肢体上」
   会给出假 PASS——E-01 肘位偏高那次就是这么漏过去的。
5. **先 joint 后 wrapper，两阶段硬分离**：joint 阶段截图前**必须关掉 wrapper
   proxy 总开关**（半透明圆柱会迷惑对位判断）；joint 调整必须经**用户确认**后
   才允许进入 wrapper 调整阶段。
6. **破损衣物会污染轮廓判断**：布条/破袖口超出肢体真实轮廓（E-01 肘部教训：
   审核员曾按轮廓极值 PASS 了贴着肚子的肘）。判据以解剖位置为准，
   不以轮廓极值/剪影外包为准。
7. **「落在 run 内」只证明在肢体上，不证明在肢体的哪个高度**（2026-09-24 新增，
   最贵的一条）：joint 投影落在剪影 run 内是**必要非充分**判据。E-01 事故里
   肘位明显偏高，闭环却报「20/20 全绿、0 悬空」——因为它只问「在手臂上吗」，
   没问「在手臂的哪一段」。必须叠加**沿肢体方向的定位判据**：
   骨段长度比（上臂:前臂该落在 0.8–1.2）、横截面等效半径极小点（腕）、
   外缘斜率转折（肘），或直接交给用户判读。**只跑 run 归属就宣布 PASS = 自证空转。**
8. **近直肢体没有几何拐点 → 立即停止数值推断，出候选对照图让用户点**：
   手臂自然下垂（近直）时肘部不存在可测的几何拐点，各信号必然互相矛盾
   （见下节实测表）。此时任何「加权折中」都是在噪声里挑数，越算越自信。
   正确动作：把 4–5 条**候选高度横线**画在真实网格渲染图上，列清单让用户单选。
   一次收敛，且用户判读天然带创作意图（这些模型本来就是按概念图捏的）。
9. **改一个 joint 必须量化连带效应并主动上报**（不许只报「改好了」）：
   关节是链，挪肘会改上臂/前臂比，挪肩会改整条链。每次改动后**必须**输出
   骨段长度前后对比表；发现副作用（如「上臂 0.225m < 手 0.388m」）立刻点名，
   并给出候选修正点。用户对解剖比例有最终裁决权——但**他必须知道自己的选择
   破坏了什么**，否则问题会在他下次看图时才爆出来。

### 近直肢体（手臂链）收敛方法 —— 2026-09-24 E-01 复盘

> 背景：用户连续两轮驳回肘位（「那么明显的外形结构你视图看不出来么？」），
> 而我的几何测量每次都「通过」。下面是那次真正收敛的路径，**下次遇手臂/腿
> 近直姿态直接照抄**。

**第一步：先把矛盾摆出来（禁止先动手改）**

在**高模 4K 贴图渲染**上把所有可测信号各量一遍，列成对照表。E-01 实测：

| 信号 | 指向的肘高 y |
|---|---|
| 法线褶皱扫描（径向对齐度骤降 → 横向折痕） | 1.09–1.13 |
| 前视外缘斜率转折 | ~1.06 |
| 上臂/前臂等分（肩、腕两点较硬） | 1.14–1.17 |
| 概念设定图逐行量臂宽（最粗点） | ~1.15 |
| 当时 sidecar 现值 | 1.135 |

表一出来结论就明确了：**没有单一信号可信**，继续算就是自欺。到这一步必须停手。

**第二步：出候选对照图，让用户单选**

- 在**真实网格**渲染图上画 4–5 条候选横线（间距 ~0.04–0.06m），每条一个
  字母 + 该高度的骨段长度比，**不要只给一个推荐值**。
- 同时出「两条骨架链对比图」（旧 vs 候选），让用户直接看骨段怎么变。
- 用 `AskUserQuestion` 单选，并附一题多选「除了高度还有什么不对」
  （腕 / 左右不对称 / 前后 z）——E-01 那次用户就是在一题里额外勾了 z 和腕，
  一次性把三个问题都暴露了。

**第三步：用户判读 vs 解剖比例冲突时——照做 + 立刻量化副作用**

- E-01 用户选了 1.250，导致上臂只剩 0.225m、比手（0.388m）还短。
  **不要驳回、不要静默折中。** 执行 → 立刻输出骨段对比表说明「上臂比手短」→
  给出修正候选（肩该提到哪）→ 用户随即同意提肩（1.45 → 1.580）。
- 纪律：**用户对「像不像」有裁决权，你对「比例坏了」有报警义务。** 两者都要做。

**第四步：x / z 不许拍脑袋 —— 取该高度横截面的实测中点**

肘位的 y 由用户定，x/z 由几何定：

```
在目标高度 y ± 2~3cm 带内取该侧肢体的顶点
  → x = 该带 x 范围中点（或轮廓 run 中点）
  → z = 该带 (z.min+z.max)/2  ← 用 mid，不用 mean（mean 会被背面污染）
```

E-01 最终值（`bindingEditor.positions`，2026-09-24 定稿）：

| 关节 | 值 | 定法 |
|---|---|---|
| LeftArm | `[0.297, 1.580, −0.045]` | y 用户定；x 取肩外缘实测 `x[0.240..0.354]` 内偏 5–6cm；z 取该高度截面中点；与锁骨同高使锁骨水平 |
| RightArm | `[−0.265, 1.650, −0.042]` | 同上法，**左右分别量**（右肩实测包络与左不同） |
| LeftForeArm | `[0.380, 1.250, −0.125]` | y 用户指定；x/z 取该高度臂截面实测中点 |
| RightForeArm | `[−0.364, 1.250, −0.130]` | 同上 |
| LeftHand | `[0.450, 0.860, −0.044]` | y 取横截面等效半径 r_eq 极小点；z 归臂轴 |
| RightHand | `[−0.434, 0.845, −0.002]` | 同上（r_eq 极小在 0.820） |
| LeftHandTip | `[0.415, 0.478, −0.105]` | 最低 2.5cm 带顶点质心（**旧值悬空 18.7cm 落在躯干 run 上**） |
| RightHandTip | `[−0.407, 0.446, −0.085]` | 同上 |

最终骨段长度（闭环后实测）：

| | 锁骨→肩 | 肩→肘 | 肘→腕 | 腕→指尖 | 上臂:前臂 |
|---|---|---|---|---|---|
| Left | 0.214 | 0.350 | 0.404 | 0.388 | 0.86 |
| Right | 0.198 | 0.421 | 0.430 | 0.408 | 0.98 |

**第五步：左右不对称网格禁纯镜像**

E-01 网格本身左右不对称（手臂差 1.5–3.5cm、小腿差 8cm），**禁止用 `mirror`
对齐左右肢**。左肩终值 1.580、右肩 1.650，两边不同高且用户明确认可——
这是网格真实形状，不是错误。`mirror` 只用于**确定对称**的模板/道具。

**第六步：收尾门禁**（顺序固定）

```
① 闭环 run 归属 + z 区间复核（必要非充分，见铁律 7）
② 骨段长度比表（铁律 9）
③ 出纯正交正/侧视图 + 带骨段长度标注的结果图给用户
④ pnpm run scene:check（105 资产同步 / 12 tests）
⑤ commit + push
```

### 两条可视化路径

| 路径 | 适用 | 视觉来源 |
|---|---|---|
| A. 纯 MCP | 无头/无浏览器 | `render` 工具直接回正/侧视 PNG 图像块（可带 `heatBone`/`selectedJoint`）；投影为内容自适应 fit（`src/render.ts` margin=14），像素↔世界换算需按其 bbox 反推。⚠️ `width`/`height` 被 `64..1024` 钳制且**静默**——要 1400×1900 会拿到 1024×1024，不要以为出图失败；需要更细看就**裁切放大**而不是加分辨率 |
| B. 编辑器 + 浏览器 | 需要用户可见、面板级保真（**首选**） | 控制 Chrome + CDP 截绑定工作台面板（正/侧视 = 网格实体 + 骨架 + joint 圆点 + 标签） |

路径 B 的自动化钩子 `window.__editor.binding`（全部走函数，避免持有过期引用）：

| 钩子 | 语义 |
|---|---|
| `open(path)` | 打开绑定工作台；sidecar 有 `bindingEditor` 自动回填（续上次编辑） |
| `pose(bone,[x,y,z])` / `state().positions` / `distance(bone)` | 摆关节 / 读 27 关节坐标 / joint 到网格距离 |
| `wrappers.set(false)` | **关 wrapper proxy 总开关**（主 3D 视口与面板正/侧视同时生效；数据保留，`true` 恢复） |
| `wrappers.{get,stats,setRadius,setOffset,resetOffset,unpin}` | wrapper 表 / 几何指纹（改半径必须体现在 sum）/ 半径 / 偏移 / 解除手动钉扎 |
| `setMode('skeleton'\|'skin')` / `fit()` / `redraw()` | 切蒙皮模式（不切拿不到 cylinders）/ 重适配 / 强制重绘 |
| `save 不在钩子上` | sidecar 落盘走面板「保存绑定」按钮（CDP 点击）；MCP 路径用 `save` 工具 |
| `undo/redo/history` / `diag()` / `meshSum()` / `heat()` | 历史栈 / 诊断条 / 网格指纹 / 热力图状态 |

控制 Chrome 启动 flag（本沙箱已验证；**禁止** `--no-sandbox` /
`--disable-dev-shm-usage`——这俩在本机反而让 CDP 起不来）：

```
--remote-debugging-port=9346 --user-data-dir=.workbuddy/tmp/chrome-profile
--window-size=1680,1050 --no-first-run --enable-unsafe-webgpu --ignore-certificate-errors
```

**双路径并存的一个坑**：MCP server 进程持有**独立的** `BindingSession`，
与浏览器编辑器不共享内存态。两边同时改 = 互相覆盖 sidecar。纪律：
一个时间段只用一条路径**写**；切换路径时先 `save`（旧路径）再 `hydrate`
（MCP 重灌 sidecar）/ 重开工作台（浏览器回填）。

### 像素 ↔ 世界坐标标定（路径 B 读图用）

绑定面板正/侧视画布各 **370×760 CSS px**，正交投影、2.05m 标尺，画布内部坐标：

```
px = 185 + 305.4 · (前视 x | 侧视 z)        # 185 = w/2
py = 699.2 − 305.4 · y                      # 699.2 = 0.92·h
```

裁剪/缩放过的截图：先 `page = ix/clipScale + 裁剪原点` 还原页面坐标，
减去目标画布页面原点得到画布内部坐标，再套上式。**每换一种截图方式
（窗口尺寸、DPR、裁剪矩形、clip 比例）都必须重新推导并验证标定**——
E-01 会话曾因混用两种 clip 比例的映射把脚趾坐标读错。

验证标定的方法：对截图做 joint 圆点的 blob 检测（圆点是 2D 层画的、
位置精确），用检测像素位置反推世界坐标，与 `state().positions` 对表，
误差应 <1px。面板尺寸/fit 改过 → 常数 185/699.2/305.4 失效，必须重测。

### 标准循环（每轮必须走完审核员门）

```
── Joint 阶段（先）───────────────────────────────────────
open（sidecar 回填）→ wrappers.set(false)   # 关 proxy，干净的网格+骨架
→ 截正视 + 侧视（可疑部位另 clip 放大）
→ 一次读图：算出一侧 + 中轴全部 joint 的目标世界坐标（标定公式）
   ⚠️ 例外：肢体近直（自然下垂的手臂/腿）时肘·膝没有几何拐点，
     不要硬算——转「近直肢体收敛方法」出候选对照图让用户单选
→ pose × N → mirror → 面板「保存绑定」→ 重截
→ 出骨段长度前后对比表（改动的连带效应必须上报，铁律 9）
→ 启动独立审核员（全新子代理）：
    输入 = PNG 文件路径 + 当前 27 关节世界坐标表 + 像素↔世界标定公式
    判据 = 生物关节可视程度 + 沿肢体方向的落点（逐关节：是否落在解剖关节上；
           骨段长度比是否合理；布条不算轮廓）
    输出 = 逐关节证据（像素位置+偏差）+ PASS/FAIL 总裁定 + 修正坐标建议
→ FAIL：按证据修 → 回到「重截」；PASS：截图给用户 → 等用户确认
── Wrapper 阶段（用户确认 joint 后才允许）────────────────
⚠️ 第一步必须 unpin：圆柱只要被手动调过一次就带 manual 标记，
   autoFitCylinders() 会**跳过**它并返回 changed=0——**静默空操作，不报错**。
   E-01 实测：22 根全 manual 时 autoFit 一根不改，unwrappedVerts 仍
   2160/4209（51.3%）。以为「跑过 autoFit 了」是最容易踩的坑。
→ cylinders unpin（逐根）或直接手工给半径 → cylinders autoFit
   （半径公式 `r = clamp(0.35 × 骨长, 0.04, 0.22)`，`skin-proxy.ts`；
   细长的骨架段常算出比解剖半径小的值，所以「autoFit 常偏小」）
→ setRadius/setOffset 迭代
→ compute_skin 直到未包裹顶点数 = 0
→ save → export_glb → pnpm run scene:gen && pnpm run scene:check
```

### 审核员提示词要点（可直接套）

> 你是独立视觉审核员，与调整者无关。给定：正/侧视截图文件路径、当前 27 关节
> 世界坐标表、像素↔世界标定公式。逐关节核对截图：该 joint 圆点是否落在模型
> 对应的**生物关节**上（肘点对肘弯、膝对膝关节、脊柱沿背部弧线、头链在颅腔内、
> 足链在靴内贴地）。破损布条/衣物不算肢体轮廓。每关节给图像证据（像素位置 +
> 偏差方向与量级），坐标存疑时用标定公式反算。
>
> **额外必查（否则会假 PASS）**：该 joint 是否落在肢体的**正确段**上——
> 肘有没有压在腋窝/腕的高度、腕有没有插进肘里。判据用**骨段长度比**
> （上臂:前臂应 ≈0.8–1.2；上臂比手还短 = 错）+ **沿肢体的单调顺序**
> （肩→肘→腕→指尖的高度必须严格递减，不许倒挂）。只答「在手臂上」不算通过。
>
> 最后给 PASS/FAIL 总裁定；FAIL 必须附每个不合格关节的修正坐标建议。

### 注册路径即工作区（多 worktree 注意）

`server.mjs` 以**自身所在目录**为仓库锚点解析相对路径——注册哪个 worktree 的
`server.mjs`，`load_model`/`save` 就读写那个 worktree 的资产。跨 worktree
并行开发时按需注册对应路径，别混用。
