# 编辑器冒烟修复与浏览器验收（2026-10-18）

基线 `f7ae29a76ea1970d162ebce970fbd54b415d871e`，分支
`codex/object-pool-framework-20261018`；本记录对应同笔修复提交。
实际检出：`C:/Users/fangy/Documents/Projects/visual-quality-20261007/game-design-zombie`。
未改动其他检出目录或会话在途资源。

## 实际修复

- 起始场景仍按项目配置验真，分类/pickable 按 NodeId 比对，避免同名美术物件互相覆盖。
  交互另用注册在项目清单的 schema v22 白盒场景，保留父子拖拽、旋转、Undo 原判据。
- 就绪以目标场景、资产装载完成、服务挂接、首帧和有效画布为准；reload 要求新页面代次。
  hook 提前出现不算启动成功；CDP 卡死有界失败，截图失败不能阻塞清理。
- 修复真实布局问题：恢复过大资产坞高度及拖拽时，按实际 mainrow 高度保留200px画布。
  原来的 window.innerHeight-160 忽略顶栏，曾把画布挤到75px。
- LOD 使用有 sidecar 的已发布 H-01 档位，实测10500→79980→10500三角形；
  未把缺少元数据的原始源模误当成运行时资产。导入后用 Undo 恢复作者状态。
- 改名探针从受保护 `.workbuddy` 移到每轮独占 `.smoke` 夹具；真实验证新路径200/
  旧路径404与Esc不落盘。补资产筛选框英文漏译，真实按钮往返中英文并等待页面刷新。
- headed 验证读取实际 renderer GPUDevice.adapterInfo，拒绝未知/fallback/软件信息。
  核心及绑定入口使用证书匹配的HTTPS，不忽略证书；报告写入失败仍清理自建进程。

## 实际验证

命令均在上述检出执行：

| 验证 | 实际结果 |
|---|---|
| `pnpm run editor:smoke -- --headed --out .workbuddy/tmp/smoke-repair/run-5` | **123 PASS / 0 FAIL / 0 SKIP**；console errors=0、exceptions=0 |
| `pnpm run editor:smoke:binding -- --headed --out .workbuddy/tmp/smoke-repair/binding-2` | **111 PASS / 0 FAIL / 0 SKIP**；console errors=0、exceptions=0 |
| `node --test tools/verify/editor-smoke-lib.test.mjs` | 7/7，含 eval 永不完成也必须超时、硬件未知值拒绝 |
| `pnpm exec vitest run apps/editor/test/dock-layout.test.ts` | 1/1，含小窗口预算低于 splitter 最小值 |
| `pnpm run typecheck` / `pnpm run editor:build` | 通过；构建仍有既存 chunk 体积提示 |
| `pnpm run architecture:check` | 334文件，无错误 |
| `pnpm run knowledge:check` / `git diff --check` | 通过 |
| `pnpm run scene:check` | 通过：27个schema v22场景、282项资产哈希；LOD38、音效22项等门禁通过 |

两套浏览器串行使用固定测试profile、1600×1000可见Chrome、严格HTTPS MagicDNS。
核心采样实际渲染器设备：secure=true、fallback=false、vendor=nvidia、architecture=lovelace。
结果：[核心JSON](core-results.json)、[完整日志](core-console.txt)、[截图](core.png)；
[绑定JSON](binding-results.json)、[完整日志](binding-console.txt)、[截图](binding.png)。
截图已实际查看；核心画布与父子夹具可见，绑定截图为末尾关面板后的测试现场，
不将其称为正常玩法构图或美术匹配证据。绑定套件还实测权重、姿态、半径变化的几何/
像素反馈、BVH重定向及新旧骨架导入诊断；无骨架源按产品规则拒绝，不伪装成功导入。

绑定测试的后续发现：旧脚本重开/关闭刚编辑过的绑定会被未保存确认框挂起。
现仅在同一CDP session处理三个精确的“放弃当前绑定修改”confirm文案，记录断言后接受；
未知对话框记FAIL并拒绝。确认仅作用于本套件内存夹具，产品保护逻辑没有关闭，未写资产sidecar。
首次停在确认框的运行不计通过，已核实父子PID后仅结束该轮自建Node/Chrome/Vite；
最终完整运行正常finally收尾。Git差异核对没有额外模型/元数据变更。

## 独立审核与知识导航

独立代码子代理只读审核确认：修正了未知GPU误判、报告写入阻断清理、eval无界等待、
失败截图无界等待；未放宽原业务断言。审核方实际重跑Node7/7、布局1/1，最终无P0/P1/P2阻断。

CodeGraph 0.167.0 对当前检出先查工具/模块关系；起初project_map遇正在索引，定向概览可用。
改动后结构增量更新11文件，project_map及目标模块概览可返回；main.ts仍有tree-sitter恢复
警告、embedding仅部分覆盖，动态派发不能据空入边认定未使用。类型检查与构建均通过。

## 范围与剩余边界

本次交付修复完整核心冒烟与受共享启动变更影响的绑定回归。未运行包含combat-probe、
dynamic-skin-probe的`editor:smoke:all`聚合命令；既有launcher f5夹具限制见
[原主线整合记录](../../architecture/main-integration-20261018.md)，不将该未运行部分报为通过。
未重新认证整体美术、移动端、全部GPU和性能；此前对象池/主线报告的旧smoke失败是当时
事实，当前两套件结果由本记录替代，不改写历史测量。
