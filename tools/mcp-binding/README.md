# tools/mcp-binding — 绑定领域 MCP server（WU-2 起）

把 `BindingSession`（绑定编辑的唯一领域状态 owner）暴露成 MCP 工具，
让 Agent 能**看见**自己的绑定操作结果（视觉反馈闭环），并把调好的绑定
**导出成干净 T-pose 的 rigged GLB**（WU-3 起，与编辑器 exportBound 同管线）。

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
| `cylinders` | wrapper 表操作：get / autoFit / setRadius / setOffset / clearOffset / mirror / mirrorAll / unpin |
| `set_options` | 权重导出选项（weightMode / smooth* / mirrorWeights；越界按面板同款钳制） |
| `compute_skin` | 算权重只回统计（未包裹顶点数等），不回权重数组（token 纪律） |
| `render` | **视觉反馈核心**：正/侧视 PNG 图像块，可选 heatBone 热力图、selectedJoint 高亮 |
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

## 典型闭环（Agent 视角）

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
