# 程序贴花验收记录

2026-10-13，基线 `384b381`，分支 `codex/procedural-decals-20261013`。源码指纹见 `source-hashes.json`。

采用用户现有 hi.Fang Chrome 的独立验收标签，保留其他会话页面。HTTPS secure context、NVIDIA Lovelace、WebGPU fallback=false（`hardware.json`），本轮无浏览器/GPU error 日志。业务读写全部通过生产 Game Editor MCP，CDP 只观察生产状态；截图为真实 headed 页面。

| 证据 | 实际结果 |
|---|---|
| `whitebox.jpg` | 平地五种图案、26.565°坡面贴附、墙面弹孔/裂纹、遮挡柱；12 作者痕迹在40静态mesh之外以单批绘制 |
| `roundtrip.json` | 血迹 seed 31→32 保存重开→31 保存重开；完整作者文档 JSON/hash 恢复一致，NodeId/mark id及无关字段保留 |
| `pause.json`、`fade.json`、`expired.json` | 暂停跨多个工具调用仍tick0、剩余2s；45固定步后time1.5s/opacity0.45；65步后到期移除 |
| `stress32/128/512-view.json` 与 JPG | 分别32/128/512运行痕迹，加12作者共44/140/524实例，始终1贴花draw；buffer4096/16384/65536字节。可见稠密痕迹，保留深度遮挡 |
| `stop.json`、`stop-view.json` | 运行池count0/runId=null、即时GPU实例/buffer归零；registered=4/disposed=4/pending=0。下一编辑帧重建12作者痕迹，完整场景未污染 |
| `floor1.jpg`、`floor1-play.jpg/json` | 第一层街道24痕迹，编辑态与Play tick60均1贴花draw；57静态mesh未增加，伤害/导航/角色规则不变 |
| `floor1-stop.json` | 第二次Play结束后registered=9/disposed=9/pending=0 |

压力样本认证实例容量、合批、无GPU错误和清理，不认证整帧GPU耗时、FPS、任意分辨率或手机性能。既有场景道路共面纹理与角色资源表现不由本任务调整。

相关 owner 测试、Node场景/MCP协议、类型、构建、架构、场景与知识门禁的最终结果见 `checks.json`。CodeGraph 在该worktree刷新后查询渲染核心及相关模块；整体map部分文件未重检，动态派发和资源释放以源码核对，不以图中心性认证性能。

未完成的后续能力：专用mark Inspector、命中事件自动产生血迹/弹孔策略、图集接入、曲面/墙角裁切或体积投影、法线/粗糙度覆盖；本期明确提供平面程序痕迹及运行API。

本轮Vite固定5100服务在该worktree detached启动，初始PID36904；日志 `.workbuddy/tmp/decals/editor.out.log`、`editor.err.log`，PID记录 `editor.pid`。停止前复核PID仍对应该worktree Vite，再用 `Stop-Process -Id 36904`；不能停止其他会话服务。保留白盒入口供用户检查。
