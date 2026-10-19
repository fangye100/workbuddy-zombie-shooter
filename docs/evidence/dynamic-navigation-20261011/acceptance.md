# 动态吊门白盒验收

日期 2026-10-11；基线 `c96929c`；最终源码指纹见 `source-hashes.json`。
场景 `assets/scenes/sandbox/dynamic-navigation-whitebox.scene.json` 已登记进项目清单，55 节点、46 个静态 mesh，21 个导航面、1245 个固定图格。

实际有头 Chrome、HTTPS secure context、NVIDIA Lovelace、WebGPU fallback=false，见 `hardware.json`。生产 MCP 控制对应白盒实例；CDP 仅读取生产运行状态，截图包含真实 DOM 控件及 GPU 画面。

| 证据 | 实际结果 |
|---|---|
| `detour.json/jpg` | tick 300，A 关 B 开；坡道组实际经过楼梯，脚底 Y 按踏面由 1.5→3.5 递增 |
| `closed.json/jpg` | tick 160，两门完全关闭，12 NPC 无路等待；图格数 1245 未变 |
| `opening.json/jpg` | tick 180，A 开启 44.4%，minY=2.778，净空仍不足；12 NPC 保持不可达 |
| `arrival.json/jpg` | tick 780，A 开 B 关；两组 8 NPC 全部 x>8、Y=4；隔离层和孤岛 4 NPC 仍不可达。可见 A=[4,7,0]、B=[4,3,6] 与运行碰撞一致 |
| `roundtrip.json` | travelSec 1.5→1.6 保存重开→1.5 保存重开，完整文档与初态恢复一致 |
| `runtime-stop.json`、`stop-view.json/jpg` | Stop 后作者文档逐字序列化一致；门外观均恢复关闭作者姿态。gates=[]、navigation=null；资源账本 registered=6/disposed=6/pending=0 |
| `cpu-benchmark.json` | 100/500 NPC、30 步预热+300 步测量，包含固定门开关及占用等待；报告记录初始化、P50/P95、预算、重叠和源码 hash |

占用扫掠等待、中途反向、弹道遮挡、贴门 Float32 接触回归、上下层不误挡与 reset 另由 owner 测试覆盖；不把 CPU 复现声明为真实玩家键鼠操作验收。白盒使用现有 E-01 静态实例和胶囊玩家，不认证完整蒙皮动画或 500 人 GPU 性能。

本轮独立复审及关闭的 P1 见 `review.md`。相关 Vitest、Node 场景/MCP测试、类型、编辑器构建、场景、架构和知识门禁的最终结果见 `checks.json`。

本轮固定 5100 HTTPS 服务在该 worktree detached 启动，启动 PID=36208；日志 `.workbuddy/tmp/dynamic-navigation/editor.out.log`、`editor.err.log`，记录 `editor.pid`。停止前必须重新核对 PID 对应该 worktree 的 Vite，再执行 `Stop-Process -Id 36208`，不得停止其他会话服务。白盒浏览器入口保留供用户检查。

当前能力为固定可步行三维地表上的动态 AABB 阻挡层；不包含飞行、动态地形重烘焙、移动支撑面或旋转刚体门。密集 1m 出生夹具残余重叠不为零，不能宣称任意数量零穿透。
