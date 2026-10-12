# 程序贴花独立可视化工作区验收

2026-10-13；开发基线 `bccb365`；分支 `codex/procedural-decals-20261013`。
检出目录：`C:\Users\fangy\Documents\Projects\visual-quality-20261007\game-design-zombie`。
场景：`assets/scenes/sandbox/procedural-decal-whitebox.scene.json`。

## 实际交付与责任

- 编辑器菜单「渲染 → 程序贴花工作区…」打开独立工作区，提供接收节点、稳定实例列表、
  新增/复制/删除、五种程序图案及全部已有参数的实时调节。默认图案正视，也可检查局部朝向。
- Editor 的 `decal-draft.ts` 隔离参数草稿并检查接收节点并发修改；应用使用 Framework
  `SpawnEditStore.editNodes`，经过完整场景校验，进入现有撤销和保存链路。
- Framework 的 `decal-preview.ts` 复用 `ProceduralDecalPass`；独立画布、帧缓冲、实例缓冲
  和三个 target 由预览拥有，关闭/HMR 释放，resize 释放旧 target。
- 不改变 scene v19、现有图案公式和游戏逻辑；没有新增另一份资产/场景持久化状态。

## 实际可见验证

使用既有专用 Chrome 标签 `1461636511`，HTTPS/Tailscale 固定 5100，服务来自上述检出。
`hardware.json` 实测 secure=true、NVIDIA Lovelace、fallback=false，Windows Chrome 154。
浏览器控制用于菜单/控件验证；CDP 只读 `__editor` 诊断，不用私有方法修改业务。

| 行为 | 实际结果与证据 |
|---|---|
| 菜单打开独立模块 | `workbench.jpg`：实时 GPU 图案、棋盘透明背景和全部参数 |
| blood seed 31→42、opacity .9→.55 | `draft.json`：dirty=true，作者组件与 initial.json 完全相同；`draft.jpg` 为实时预览 |
| 未应用时关闭 | 界面提示「请先应用或放弃草稿，再关闭工作区」，草稿保留 |
| 应用 | `applied.json`：作者 blood 保持同一 id，seed=42/opacity=.55，草稿 dirty=false |
| 撤销 / 重做 | 通过编辑菜单操作，`undo-close.json` 作者组件恢复 initial；重做恢复参数 |
| 关闭预览 | `undo-close.json`：open=false、preview=null；资源释放另有 owner 测试 |
| 保存 / 重新载入当前场景 | 实际写入后重载；`reloaded.json` 作者 seed=42/opacity=.55 |
| 恢复验收用参数 | 工作区把 seed/opacity 恢复 31/.9，再应用并保存；最终场景无 Git 差异 |
| 新增 / 复制 / 删除 / 放弃 | 通过实际控件创建唯一 id、删除临时副本、增加新 mark 后放弃；没有写入最终场景 |
| 非单位四元数 | `invalid.json`：应用被拒绝，界面明确「贴花局部位置/单位四元数非法」 |
| MCP 草稿保护 | `mcp-draft-lock.json`：scene_get.hasDraft=true；scene_save 返回 UI_DRAFT，没有落盘 |
| 组件显示开关 | `disabled.json`：实例=0、drawCalls=0，作者组件仍启用；放弃后恢复 |
| 墙面与其他图案 | `wall.jpg`：局部前视正确显示墙面弹孔；`hazard.jpg`：警戒斜纹 |

上述阶段读取的 GPU 诊断可能滞后一帧；启用开关在实际截图之后再次读取，确认零实例。
验收结束界面打开原始 blood 参数，无草稿。当前未观察到浏览器/GPU error 或 warning。

## 自动检查

- 6 个相关 owner 测试文件，18 项通过：Scene 图案契约、实例打包/池、Editor 草稿/MCP/
  Play 生命周期、预览复用/resize/关闭资源责任。
- `pnpm run typecheck`、`editor:build`、`architecture:check` 通过；分层门禁 291 个文件无错误。
  Vite 仍有既有的大 chunk 警告，不属于图案渲染故障。
- `scene:check` 通过：228 元数据、17 个 v19 场景、14 项场景门禁、38 件 LOD 记录及 22 件音效。
- CodeGraph 0.167.0 在实际检出查询 project_map/module_overview，health healthy=true；
  修改后增量索引 19 个文件、182 个节点、1414 条边。main.ts 有 tree-sitter recovery，
  向量覆盖不完整；关键依赖通过源码及 TypeScript 编译核对，没有以图谱认证 GPU 行为。
- 文档目录和知识门禁结果随本任务提交；历史程序贴花验收记录保持原样。

## 能力边界

这是独立**图案和局部朝向预览**，自动居中/适配尺寸；位置、法线偏移和接收节点世界变换
在应用后的场景查看。预览棋盘、直显色彩不是游戏材质或完整 HDR 后处理的匹配验收。
参数覆盖现有 v19 契约，没有新增每种图案的独立 SDF 形态参数，没有曲面贴合、墙角裁切、
自动鼠标投射摆放或材质 DBuffer。未认证手机性能或移动布局；本任务不接管角色绑定和资产处理。
