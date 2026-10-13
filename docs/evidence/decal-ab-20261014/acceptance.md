# 贴花 A/B 真实GPU验收与性能对比

2026-10-14（Asia/Singapore）；源码基线 `ef239dac` + 本次工作差异；分支
`codex/procedural-decals-20261013`。性能结果不代表整个游戏FPS。

交付：CPU固定槽对象池、复用打包/排序记录，A直接实例化与B真正Compute稳定剔除/压缩+
间接绘制。两套共享CPU寿命与坐标输入，工作区和MCP可以切换；默认A。
契约与复测入口见 [性能指南](../../render/decal-performance.md)。

## 环境、协议与原始证据

可见Chrome154，Windows11，HTTPS secure context，实际adapter vendor=nvidia、
architecture=lovelace、isFallbackAdapter=false；timestamp-query=true。adapter未返回具体
型号/description，故不编造型号。512² RGBA16F，两套同相机、矩阵、seed、80B输入与SDF。

两次完整记录：[run-1.json](run-1.json)、[run-2.json](run-2.json)。每个GPU case采用AB/BA
交替；3批×32帧预热，10批×32帧测量。GPU时间是整批首pass到末Render的timestamp差/32，
B计入Compute、Render及pass间隙。GPU上传、读回在该窗口外；上传字节另列。CPU编码耗时
按32帧批次平均，排除submit/等待/读回，不与CPU打包成本混为一谈。

单pass时间戳存在约65536ns量化，首轮探索的许多零值没有用于正式结论；修正为批量协议。
Compute细分仍是量化观察值，不用于高精度结论。修正基准重复getMappedRange异常后，两次
完整测量全部通过。一次额外复测被Vite依赖重启打断，没有被当作完成证据。

CPU另测4批预热+10批×100帧；同一新packer下比较snapshot深复制与frame借用。这个基线
只隔离复制成本，不能表述为旧版全部CPU耗时或整个游戏提升12倍。并行桌面负载/动态GPU
频率未被隔离，两个完整run展示时间波动，不能拿单个更好的样本推广到所有设备。

## CPU复制成本

| 项数 | 复制帧中位 ms（轮1 / 轮2） | 借用帧中位 ms（轮1 / 轮2） | 相对倍数（轮1 / 轮2） |
|---|---|---|---|
| 32 | 0.665 / 0.867 | 0.054 / 0.061 | 12.3 / 14.2 |
| 128 | 2.472 / 3.591 | 0.207 / 0.275 | 11.9 / 13.1 |
| 256 | 4.756 / 6.866 | 0.401 / 0.528 | 11.9 / 13.0 |
| 512 | 10.166 / 13.211 | 0.810 / 1.077 | 12.6 / 12.3 |

对象/向量/style均复用固定槽；游戏规则直接计数，不再为每次命中snapshot整个池。
基准的池分配槽数保持count，额外一次emit复用了已有槽；独立审核还以20,000次确定性随机
操作对照参考Map验证淘汰/到期/组计数与free+active，未发现余额或FIFO问题。没有声称
整个JS程序零分配，输入验证、事件输入与外部诊断复制仍有分配。

## GPU绘制时间

以下均为每批平均后取中位（ms），完整p95、编码耗时、数量、字节成本在JSON。

| 输入 / 离屏 | A 轮1 / 轮2 | B 轮1 / 轮2（Compute+Render） | 两轮HDR差异通道 |
|---|---|---|---|
| 32 / 0 | 0.1065 / 0.0307 | 0.2273 / 0.0369 | 0 / 0 |
| 32 / 16 | 0.0164 / 0.0082 | 0.0471 / 0.0287 | 0 / 0 |
| 32 / 28 | 0.0082 / 0.0041 | 0.0410 / 0.0246 | 0 / 0 |
| 128 / 0 | 0.1987 / 0.0696 | 0.2499 / 0.0758 | 0 / 0 |
| 128 / 64 | 0.0471 / 0.0573 | 0.0922 / 0.0471 | 0 / 0 |
| 128 / 115 | 0.0307 / 0.0307 | 0.0573 / 0.0328 | 0 / 0 |
| 256 / 0 | 0.1126 / 0.0430 | 0.2007 / 0.0676 | 0 / 0 |
| 256 / 128 | 0.1454 / 0.0328 | 0.1188 / 0.0594 | 0 / 0 |
| 256 / 230 | 0.0307 / 0.0307 | 0.0348 / 0.0369 | 0 / 0 |
| 512 / 0 | 0.1208 / 0.0819 | 0.1290 / 0.1106 | 0 / 0 |
| 512 / 256 | 0.0328 / 0.0451 | 0.0512 / 0.0696 | 0 / 0 |
| 512 / 460 | 0.0184 / 0.0328 | 0.0471 / 0.0430 | 0 / 0 |
| 1024 / 0 | 0.1905 / 0.1372 | 0.2580 / 0.2335 | 0 / 0 |
| 1024 / 512 | 0.0512 / 0.0553 | 0.0696 / 0.0758 | 0 / 0 |
| 1024 / 921 | 0.0246 / 0.0164 | 0.0532 / 0.0430 | 0 / 0 |
| 256 / 0（重叠） | 0.5919 / 0.6574 | 0.6021 / 0.6799 | 0 / 0 |
| 1024 / 1024 | 0.0020 / 0.0020 | 0.0102 / 0.0123 | 0 / 0 |

17组×2轮RGBA16F逐通道按位一致：全部九种pattern、普通透明重叠、0/约50%/约90%离屏、
1024上限及全离屏。所有B读回候选数量与预期相同，未发现WGSL compilation或GPU validation
错误。全离屏instanceCount=0但仍有间接draw命令；报告没有把它写成零drawCalls。

B在少数样本略快，但未稳定复现；多数case额外Compute/压缩比省下的顶点工作更贵，A本来
已只有一次draw且每项只有6顶点，因此不能认为indirect天然更快。透明重叠两者仍承担相同
SDF片元/overdraw，B并不解决它。**保留A默认，B保留显式选择与后续复测能力。**

| 输入项数 | A持续缓冲 | B持续缓冲 | A上传 / B上传 |
|---|---|---|---|
| 512 | 65536B | 131104B | 40960B / 40976B |
| 1024 | 131072B | 262176B | 81920B / 81936B |

bufferBytes统计持续绑定的数据缓冲；显式计数读回另有16B短期staging，完成/清理销毁。
本次没有GPU上传timestamp，不能把绘制时间称完整GPU帧总成本。

![A/B合成输入与可见硬件结果](benchmark.png)

## 实际Editor与Play验证

在单独实例打开已登记 `assets/scenes/sandbox/combat-decal-whitebox.scene.json`，未改其文件。
真实Ready点击+原生J输入消耗1发弹药，触发NPC血迹；权威模拟推进后产生E03酸液落地。
在tick343暂停，当前存活血迹+酸液2项；A→B→A不推进tick、不改变mark/TTL或作者revision。

[play-switch.json](play-switch.json)：A输入2、4096B、上传160B、1draw；B输入2、GPU读回候选2、
8224B、上传176B、1Compute+1间接draw。A的visibleInstances=null/countSource=submitted；
B是gpu-frustum，未称像素遮挡可见。1523×672实际viewport A/B PNG字节完全相同。

![实际战斗中的B血迹/酸液](game-b.png)

[play-stop.json](play-stop.json)：以B执行Stop后，运行池count=0、runId=null，GPU实例/缓冲/
上传/dispatch/draw全部0；Play ledger registered5/disposed5/pending0。作者revision仍def05d63，
dirty=false。ledger只是既有Play宿主账本，不用它单独认证贴花内部全部分配；GPUAPI owner测试
明确核对旧缓冲destroy，真实贴花自有缓冲诊断同样清零。

打开既有 `assets/scenes/sandbox/procedural-decal-whitebox.scene.json`，编辑态18作者贴花含平地/
斜坡/墙面及遮挡：[authored-switch.json](authored-switch.json)，A/B输入18，B候选18；1331×769
A/B PNG字节相同，revision=d4c7c8bb，未写作者数据。B覆盖作者及运行痕迹，不仅测试合成平面。

![18个作者贴花B模式](authored-b.png)

工作区新建仅预览草稿，真实UI选择B→A，预览正常；[workbench-b.png](workbench-b.png)、
[workbench-a.png](workbench-a.png)。随后放弃草稿、关闭工作区，主渲染器回到A；没有保存
测试草稿或改变资产/场景。草稿存在期间的顶部圆点只是草稿提醒，释放后消失。

## 自动门禁、独立审查与剩余范围

实际通过：6个Vitest文件31项；MCP broker/server/workflow的6个Node测试；typecheck；
editor:build；game:build；architecture:check。knowledge:check（153目录项、0错误）与最终diff检查通过。
没有assets变更，未把scene:check写成执行过。本次没有合并主线或创建PR。

两位独立子代理分别审核CPU/A共享池与B/GPU/测量。独立审核与主代理实测发现并修复：旧组合key排序语义、
可变池槽id缓存、异步读回generation与sequence、A提交数与B候选数、重跑/异常预览资源清理、
GPU/mock与MCP发现夹具及测量量化问题；终审还修正文档的Reset缓冲复用及UI/MCP门禁描述。
GPU独立终审核对两份原始JSON、所有性能表、PNG SHA256、Stop记录与新UI端口，确认无未解决
P0/P1/P2；CPU独立复核同样通过。审核记录来自本次同任务子代理消息，不冒充GitHub bot review。

CodeGraph按当前检出增量刷新；结构/语义索引完成。仍有已知main/weapon/audio等4个解析
恢复文件及未解析边，不能据图谱计数证明全部运行时关系；关键数据流以源码和owner验证为准。

未认证：手机与所有GPU、整游戏FPS、256真实战斗压力或500NPC性能；动态GPU频率/并行桌面
负载的严格隔离；GPU全驻留寿命与生成；曲面/蒙皮投影、DBuffer及overdraw削减。不存在
以本报告承诺任意规模或indirect必快的结论。
