# Game Editor 自主验证工具（CDP）

不需要人工点浏览器，一条命令完成「导入 GLB → 截图 → 像素级判定」。

## 为什么需要它

本项目铁律：**禁止用 headless / CPU 软渲染做视觉验证**。
但纯靠人肉观察又无法量化，于是走这条路：

- **带界面的 Chrome + CDP**（真实 GPU，非软渲染）✔ 符合铁律
- `DOM.setFileInputFiles` 把 GLB 塞进隐藏文件框 → 触发与用户点「导入 GLB…」完全相同的代码路径
- `Page.captureScreenshot` 截图
- Node 侧用内置 `zlib` 解码 PNG → 像素统计判定

## 用法

```bash
# 1) 先确保编辑器 dev server 在跑
npm run lab            # http://localhost:5178

# 2) 跑自主验证（会弹出 Chrome 窗口，属正常现象）
node tools/verify/cdp-verify.mjs

# 3) 棋盘格规整度分析（判定 UV 是否错乱）
node tools/verify/uv-regularity.mjs
```

产物写在 `.workbuddy/tmp/`：`import-default.png`、`import-uvchecker.png`、`analysis.json`。

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

- Chrome（脚本里写死了默认安装路径，改 `CHROME` 常量即可）
- Node ≥ 22（用全局 `WebSocket`，无需 puppeteer / playwright）
- 无第三方 npm 依赖

## 已验证结论（2026-09-01，E-04 原始高模）

```
56156 顶点 / 80000 面 / 2.05 m / 贴图已载入
角色区 301 色、局部方差 2.17；地面 1 色、方差 0.01 → 细节比 217×
棋盘格 暗163908 / 亮164487，同色游程 平均 27.36px（中位 9，P90 80），≤2px 占比 21.1%
→ UV 展开与贴图采样均正常，映射正确
```
