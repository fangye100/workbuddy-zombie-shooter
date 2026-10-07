# iPhone Play 崩溃排查与资源减负（2026-10-07）

## 问题与结论边界

用户在 iPhone 13 Pro Max 打开 QA 端口 5197 的第二层场景，加载画面后点击运行发生崩溃。iOS 版本、浏览器和具体表现（网页重载、浏览器退出或黑屏）尚待用户补充。

本次确认并修复了一处显著的角色图片常驻内存压力；**未取得 iPhone 真机日志，不能认定它就是崩溃的唯一原因，也不能以桌面通过代替手机验收**。没有继续人数递增或 FPS 性能采样。

## 已确认的资源问题

原 Play 入口遍历角色资产清单，预载全部 9 个带骨架角色，包括当前关卡未使用的角色。逐项读取这些 GLB 的内嵌图片，均为 4096×4096。ActorLibrary 保存解码后的 ImageBitmap，而实际出现的 NPC 还会获得 GPU 贴图。

以 RGBA 8 位、无 mip、仅像素量估算：一张 4096×4096 图片为 64 MiB，9 张图片缓存约 576 MiB。该数值不包含图片解码临时峰值、GLB 数据、动画、GPU 副本、主角、环境和渲染目标；也不是 Safari 进程内存实测值。第二层的 SpawnPoint（包含后续波次）只需要 E-01 至 E-04 四类角色，初始 48 个 NPC 使用 E-01、E-02 两类。

## 修改后的行为

- 预载集合由当前场景中启用且数量大于零的 SpawnPoint 派生，包含后续波次；资产清单继续作为路径与角色排序的真源。
- 运行时额外生成的角色进入非 Proxy 表现档后，通过 RuntimeBridge 请求装配。请求去重、串行执行；加载完成前保持胶囊，完成后刷新角色批次。
- 复用项目 `render.targetTier`：t0/t1 的 NPC albedo 最长边限制为 1024，保持宽高比；其他档位保持 4096。不修改源资产、场景或作者贴图。当前项目为 t1。
- 缩小图片后立即关闭原始大尺寸 ImageBitmap，失败时也释放；不支持缩放或解码失败时记录角色诊断并使用代理色。仍有一次完整图片解码的临时峰值，尚未实现浏览器解码前缩小或离线移动贴图资产。
- Stop、新 Play、资产清单失效以及 HMR 会取消旧预载队列；迟到结果不会向已经停止的 Play 上传 GPU 资源。
- 收到 `GPUDevice.lost` 时停止 Play、释放 Play 资源并显示原因；致命 GPU 错误后停止帧循环。操作系统直接终止网页进程的情况无法依靠页面内回调捕获。

第二层新缓存像素量约为 4×4 MiB = **16 MiB**，比原全库缓存估算少约 97%。初始两类实际绘制 NPC 的 GPU albedo 像素量由约 128 MiB 降至约 8 MiB；后续出现其他角色时会增加。上述估算不含其他资源。

## 验证记录

- `pnpm run typecheck`：通过。
- `pnpm run editor:build`：通过，存在既有的 bundle 大小提示。
- 五个相关测试文件：64 项通过，覆盖场景需求、异步清单、请求去重、Stop/重启迟到结果、解码失败释放和已有角色/批次行为。
- GPU context 两项测试通过；不支持 WebGPU 的启动提示和 README 的 Safari 最低版本同步纠正为 26。
- Windows headed Chrome + 真实 NVIDIA GPU，原第二层 URL：自动加载后暂停，初始 NPC 为 48；库中仅 E-01/E-02/E-03/E-04，四张 ImageBitmap 全部 1024×1024，角色诊断为空。
- 通过可见 Ready · Resume 按钮进入运行，出现正常战斗和生命值变化；原始 100 HP 玩家约 5 秒后正常死亡结算。另一次 Resume/Pause 回归显示时间推进至 0:01，画面含带贴图 NPC。
- 仅在独立测试页临时生成一个 E-05 并单步：从代理切换为 `actor:E-05`，图片宽度 1024，诊断为空；Stop 后临时实体清除，资源账目 registered=3/disposed=3/pending=0，实例数 0，作者文档保持 61 节点。
- 再次 Play 后，在独立测试页注入 `GPUDevice.destroy()`：可见“GPU 设备连接中断（destroyed）”提示，Play 为 stopped，资源账目 registered=6/disposed=6/pending=0。这是桌面故障注入测试，不能证明手机崩溃属于同一种错误。

## 手机复测与进一步定位

请刷新原链接后重新点击运行，补充 iOS 版本、浏览器名称以及崩溃的具体表现。若页面显示 GPU 设备中断，保留原因文本；若直接重载/退出，仍需真机进程或 Safari 日志才能区分内存终止、驱动错误和其他故障。当前修复的 iPhone 真机结果待确认。

官方资料说明 Safari 26 开始正式支持 WebGPU：[WebKit Safari 26 发布说明](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)。版本未知时，不将能够显示画面等同于所有运行功能都稳定。

WebKit 公开存在与 WebGPU 内存有关的版本性问题：[实例 vertex buffer draw 顺序泄漏记录](https://bugs.webkit.org/show_bug.cgi?id=302711)、[分辨率变化泄漏记录](https://bugs.webkit.org/show_bug.cgi?id=312563)。这些是后续诊断线索，不是本项目崩溃已经命中的证据；当前 NPC 变换使用 storage buffer，也不能直接套用 vertex buffer 问题的结论。

既有桌面性能记录保持原样：[39-CrowdPerformanceBaseline-2026-10-07.md](39-CrowdPerformanceBaseline-2026-10-07.md)。本次改变了角色预载集合和 t1 贴图尺寸，后续性能对比必须记录版本和该资源策略，不能把新结果当成原基线同配置结果。
