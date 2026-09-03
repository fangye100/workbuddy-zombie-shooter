# 验证工具（CDP）

不需要人工点浏览器，一条命令完成验证。目录下四个脚本，**职责不重叠**：

| 脚本 | 验证什么 | 浏览器形态 | 命令 |
|---|---|---|---|
| `editor-smoke.mjs` | **结构冒烟**：驱动 services 公开 API，断言状态机与渲染管线不炸 | headless（SwiftShader 软件 WebGPU） | `npm run editor:smoke` |
| `cdp-verify.mjs` | **视觉验证**：导入真实 GLB → 截图 → 像素统计（UV / 贴图是否错乱） | 带界面（真实 GPU） | `npm run verify:glb` |
| `uv-regularity.mjs` | 棋盘格规整度分析（判定 UV 是否错乱） | 读上一步的截图 | `npm run verify:uv` |
| `facade-metric.py` | **架构度量**：`LabRenderer` 的门面化程度（方法数 / 委托占比 / 实质逻辑行数） | 不需要浏览器 | `npm run verify:facade` |

`facade-metric.py` 存在的理由（2026-09-03）：`docs/12` 初版那个「68% 实质逻辑」的结论
来自一个**从未入库的临时脚本**，第二轮想把数字复算一遍时发现根本对不上 —— 度量工具丢了，
结论就跟着失真。它现在和它要支撑的结论一起躺在版本控制里（ADR-008）。

## 关于「禁止 headless」这条老铁律（2026-09-03 修订）

本文件此前写着「禁止用 headless / CPU 软渲染做视觉验证」，这句话**只对了一半，
且与 `docs/10` D4 已确立的标准冲突**，现予澄清：

- **视觉/像素判定**确实不能用软渲染 —— SwiftShader 的光栅化结果与真实 GPU 有差异，
  拿它比对颜色/纹理细节是伪精度。这部分继续走 `cdp-verify.mjs`（带界面、真实 GPU）。
- **结构冒烟**（代码路径会不会抛错、bind group 对不对、WGSL 能不能编译、
  服务状态机能不能往返）**恰恰应该走 headless**：它断言的是「不炸」，不是「好不好看」，
  而且 headless 才能进 CI。`docs/10` §5 D4 与 `docs/09` §7 定的标准正是这条。

一句话：**软渲染不验像素，但可以验结构。**

## 用法

```bash
# 1) 结构冒烟（推荐默认跑这个；会自起 dev server，跑完自动收尾）
npm run editor:smoke
npm run editor:smoke -- --glb assets/characters/models/E-01/rigged/E01_Shambler_900_rigged_animated.glb

# 2) 视觉验证（需先手动起 dev server；会弹出 Chrome 窗口，属正常现象）
npm run editor            # dev server
npm run verify:glb
npm run verify:uv
```

dev server 默认 **https**：本机 `apps/editor/vite.config.ts` 检测到 Tailscale 证书
（`.workbuddy/tmp/certs/`）会自动开 https，`http://localhost:5178` 直接连会返回 000。
`editor-smoke.mjs` 会自动探测协议并在 https 时给 Chrome 加 `--ignore-certificate-errors`。

产物写在 `.workbuddy/tmp/`：`editor-smoke.png`（冒烟截图）、
`import-default.png`、`import-uvchecker.png`、`analysis.json`（视觉验证）。

## 判定口径

| 指标 | 正常 | 异常 |
|---|---|---|
| 模型信息行 | 显示「贴图已载入」 | 「⚠ 贴图解码失败」= 解码环节出错 |
| 角色区颜色数 | > 300 | < 50 = 平色（贴图没生效） |
| 角色/地面 局部方差比 | > 3 | ≈ 1 = 没有纹理细节 |
| 棋盘格同色游程 平均长度 | > 3 px | ≈ 1~2 px = 噪点化 |
| 棋盘格 长度≤2 游程占比 | < 50% | > 60% = UV 错乱 |

棋盘格的两个灰度值固定为 **38 / 217**（着色器里 `mix(0.15, 0.85)` 的 sRGB 值），
可直接用来校准截图链路本身是否可信。

## 依赖

- Chrome（`editor-smoke.mjs` / `cdp-verify.mjs` 里写死了默认安装路径，改 `CHROME` 常量即可）
- Node ≥ 22（用全局 `WebSocket`，无需 puppeteer / playwright）
- Python ≥ 3.9（仅 `facade-metric.py` 需要，PATH 上要有 `python`）
- 无第三方 npm / pip 依赖

## 已验证结论（2026-09-01，E-04 原始高模）

```
56156 顶点 / 80000 面 / 2.05 m / 贴图已载入
角色区 301 色、局部方差 2.17；地面 1 色、方差 0.01 → 细节比 217×
棋盘格 暗163908 / 亮164487，同色游程 平均 27.36px（中位 9，P90 80），≤2px 占比 21.1%
→ UV 展开与贴图采样均正常，映射正确
```

## 已验证结论（2026-09-03，结构冒烟 `editor-smoke.mjs`）

```
默认胶囊场景：              30 PASS / 0 FAIL / 3 SKIP，CONSOLE(0)，EXCEPTIONS(0)
+ E-01 rigged+animated GLB：35 PASS / 0 FAIL / 0 SKIP，CONSOLE(0)，EXCEPTIONS(0)
GPU: google swiftshader（headless）· drawCalls 25 · triangles 15332 · FPS 17
```

覆盖 9 组：启动与 WebGPU 上下文 / 帧循环统计 / SelectionService / HierarchyService /
MaterialPanelService / PickingService / GizmoService / AnimationService / 出帧稳定性。

## 已验证结论（2026-09-03，L-3 装箱下沉后）

```
npm run verify:facade
  文件行数        1748   （HEAD 39675b8 时 1946）
  方法总数          86   （原 90，−4 即装箱四件套）
  ≤2 行委托         58   （原 58，占 67%）
  >10 行实质逻辑    15   （原 19）
  方法体实质行     744   （原 891）；其中 >10 行方法占 626（原 773）

四道门禁：typecheck 0 error · vitest 117/117 · vite build → dist/editor · 冒烟 35 PASS/0 FAIL
```

> **判据陷阱（写新断言时必读）**：`setCharacter()` 是「替换角色槽」而不是新增物体，
> 所以 `getObjectList().length` **不变**，拿它判定「GLB 是否导入成功」必然假失败。
> 要读 `#model-info` 的统计行。此外 `#fatal` 是**常驻 DOM**，靠 `style.display` 显形，
> 判据必须用 `getComputedStyle(...).display !== 'none'` —— 直接读 `innerText`
> 即使卡片没显示也会返回标题文字「无法启动」，同样假失败。
