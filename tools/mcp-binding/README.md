# tools/mcp-binding — 绑定领域 MCP server（WU-2）

把 `BindingSession`（绑定编辑的唯一领域状态 owner）暴露成 MCP 工具，
让 Agent 能**看见**自己的绑定操作结果（视觉反馈闭环），而不再只是盲调参数。

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

## 构建与自检

```bash
pnpm run mcp-binding:build   # esbuild 打包 src/ → dist/domain.mjs（dist 已 gitignore）
pnpm run mcp-binding:check   # = probe：构建 + 全链路断言（真实 GLB / PNG 解码 / save 闭环）
```

改了 `src/**` 必须重跑 `mcp-binding:check`（probe 每次自己先构建，dist 不会过期）。

## 工具表（15 个）

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

明确边界：GLB **导出**不在本 server（导出管线在编辑器 `exportBound`，Agent 化留待后续 WU）。

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
```
