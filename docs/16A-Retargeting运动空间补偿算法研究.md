> 项目正式参考文档，归档日期：2026-09-14。
> 开发合同、阶段任务和验收真源：[16-MotionMatch动画匹配设计](./16-MotionMatch动画匹配设计.md)。本文件保存完整研究正文，不将研究结果标成已实现功能。
> 正文第 6 节“本次验证”是研究发生时的记录；其中 `check_geometry.py` 的完整源代码保存在本文附录 A，复现需 Python 与 NumPy。该脚本仅验证几何关系，不属于项目生产测试门禁。

# 不同体型角色的运动空间补偿：源码、论文与可实现算法

检索与核查日期：2026-09-14。范围：HumanIK / MotionBuilder、游戏引擎开源重定向、机器人重定向、接触感知动画论文。

## 1. 结论与证据边界

“空间补偿”不是一个唯一算法。至少要分别定义：**根轨迹的尺度、身体相对运动的尺度、接触目标的坐标空间，以及怎样把这些目标解回固定骨长的姿态。**

- 空间目标的缩放通常是直接的坐标运算，不需要 IK 才能计算。
- 将目标位置落实到具有固定骨长、关节限制的角色上，是 IK / 约束优化问题。
- 在全身严格等比、地面也由同一变换保持、源接触正确的条件下，保持关节旋转并一致缩放根运动，已经可以保持接触，不需要 IK。
- 肢体比例不同、接触物体不能一起缩放、手脚同时支撑时，独立缩放通常不再满足全部约束；必须允许改变关节角度，有时还必须移动骨盆或重新安排落点。

本次找到 HumanIK 的公开流程与参数说明，但没有找到其 Auto 模式的完整内部比例公式、效应器目标构造代码与数值求解实现。因此下面严格区分“官方明确公开”“其他方案可复现”“本报告建议”。不能把其他方案的公式称为 HumanIK 的原算法。

## 2. 已核实的方案

### 2.1 HumanIK：公开到什么程度

SDK 明确描述：复制源节点朝向；设置效应器 Reach/Pull/Resist；进行 IK pass，包含启用的地面接触。IK pass 可以跳过。它不是只在碰地之后才开始使用 IK。[SDK 求解流程](https://help.autodesk.com/cloudhelp/2016/ENU/HumanIK-SDK-Help/files/GUID-6987D1B4-229F-4EE0-978C-DC2D0C807D2E.htm)

动作空间补偿有 Auto/User/Off；User 按百分比改变运动幅度。髋高、踝高、双脚间距分别有补偿设置。这说明“一个身高比解决一切”不足以描述它的公开功能，但不能据此推断 Auto 的精确公式。[Maya 参数](https://help.autodesk.com/cloudhelp/2022/ENU/Maya-CharacterAnimation/files/GUID-EB2A8BB0-801E-4251-8C4C-09986049CCBB.htm)

手脚地面接触通过接触标记与平面处理，求解中有预处理和后续修正。这个功能不等于膝盖、胸背与环境的完整碰撞处理。[SDK Foot and Hand Contact](https://help.autodesk.com/cloudhelp/2016/ENU/HumanIK-SDK-Help/files/GUID-DBE08C49-E87A-4053-A3D0-00C813122EE6.htm)

### 2.2 Babylon.js：明确的根运动比例公式

其根位置修正使用参考姿态下“根到地面参考骨”的竖直距离之比：

\[
s=\frac{h_t^0}{h_s^0},\qquad
H_t(t)=H_t^0+s\,[H_s(t)-H_s^0].
\]

这是世界空间中的意图，写动画轨道时还要转换到目标父坐标系。源码另设 ground correction；它与逐接触片段锁定落点不是一回事。上述根运动缩放本身无需 IK。[文档](https://github.com/BabylonJS/Documentation/blob/master/content/features/featuresDeepDive/animation/animationRetargeting.md)；[固定版本源码：`_findVerticalAxis`、`_fixRootPosition`](https://github.com/BabylonJS/Babylon.js/blob/5560048894661a00bdd43c63de278979c72a3ace/packages/dev/core/src/Animations/animatorAvatar.ts)

### 2.3 GMR：明确的分部位空间缩放，然后两阶段 IK

令 \(H\) 为源骨盆位置，\(P_b\) 为源部位位置，\(a=h/h_{ref}\) 为实际源身高对配置参考身高的修正，\(s_b,s_r\) 为配置中的部位与根缩放系数：

\[
\boxed{\widehat P_b=a\,s_b(P_b-H)+a\,s_rH},\qquad
\widehat H=a\,s_rH.
\]

论文式 (2)(3) 与源码 `scale_human_data` 一致。这里的 \(s_b\) 是预设/调校值，不能说源码自动将其计算为对应骨长比。随后第一阶段匹配各部位朝向与末端位置，第二阶段加入更多部位位置任务，并约束关节范围。它提供了可复现的“先造目标、再 IK”实现，不能单凭这个缩放式保证零滑步。[论文第 5 页](https://www.jiajunwu.com/papers/gmr_icra.pdf)；[固定版本源码](https://github.com/YanjieZe/GMR/blob/bb1bbe40774794fceb2a7c579a3464a28e68c844/general_motion_retargeting/motion_retarget.py)

### 2.4 Gleicher 1998：将接触约束与整段动作一起优化

用原动作加平滑修正表示结果：\(m(t)=m_0(t)+d(t)\)。优化修正幅度，并要求指定时段内的脚满足落点/地面约束；修正用低频样条表达，保留原动作细节。论文强调缩放中心、世界接触以及不同脚长的冲突：同时照搬源脚跟和脚尖的固定位置，并不总能适用于目标脚。[作者论文，第 5–6 页](https://ai.stanford.edu/~latombe/cs99k/2000/gleicher.pdf)

### 2.5 Contact-Aware Retargeting 2021：明确区分脚底高度与滑动

论文的足接触项同时惩罚接触脚的世界速度和离地高度：

\[
E_{foot}=\sum_{j\in C}\frac{1}{h_B}
\left(\|\dot g_j^B\|^2+\|(g_j^B)^y\|^2\right).
\]

它还按腿高比转移根速度，并以身高归一化手脚速度进行匹配；另有皮肤表面接触与穿插项。实际方法包含神经网络与潜变量优化，不能直接说成一个普通两骨 IK。对工程的启示是：**到地面与不滑动是两个独立目标，体积接触还需要表面信息。**[论文式 (6)(8)(9)](https://arxiv.org/pdf/2109.07431)

### 2.6 Unreal：比例补偿后仍单独做 Speed Planting

官方工作流从源动画提取脚的速度曲线，以阈值判断何时锁定 IK Goal，再由目标 IK solver 实现。由此可直接验证：比例适配与“该段时间脚不能移动”需要分别处理。[官方 Fix Foot Sliding](https://dev.epicgames.com/documentation/unreal-engine/fix-foot-sliding-with-ik-retargeter-in-unreal-engine?lang=en-US)

另一个独立问题是运行速度改变，其 Stride Warping 使用：

\[
StrideScale=\frac{LocomotionSpeed}{RootMotionSpeed}.
\]

这是运行时速度适配，不是源/目标身高比；分母接近零时必须保护。[官方 Pose Warping](https://dev.epicgames.com/documentation/en-us/unreal-engine/pose-warping-in-unreal-engine?application_version=5.6)

## 3. 两个直接推导：为什么此前的讨论容易绕圈

以下是本报告的数学分析，不宣称来自 HumanIK。

### 3.1 严格等比时，FK 就能保住正确的接触

设源目标骨架的对应偏移满足 \(b_i^t=s b_i^s\)，朝向已对齐，目标沿用源的关节旋转。根轨迹也使用同一世界相似变换：

\[
S(p)=o_t+sC(p-o_s),\qquad H_t=S(H_s).
\]

其中 \(C\) 是固定朝向对齐，\(o_s,o_t\) 是对应地面原点。逐层 FK 可得每个对应点：

\[
P_i^t=S(P_i^s),\qquad \dot P_i^t=sC\dot P_i^s.
\]

若源脚在支撑期固定，\(\dot P_{foot}^s=0\)，目标也固定。地面映射正确时，高度同样为零。

因此“2 米角色迈得更大”是保持相同步态角度与节奏的预期结果，并不自动意味着滑步。滑步可能来自根位移没有一起缩放、实际肢体非等比、源已有误差、脚底偏移错误或运行时速度变化。

### 3.2 根与末端使用不同缩放，会破坏静止接触

把 GMR 类型的映射简写为：

\[
\widehat P=r_r H+r_e(P-H).
\]

当源末端接触世界、\(\dot P=0\) 时：

\[
\boxed{\dot{\widehat P}=(r_r-r_e)\dot H}.
\]

只要两个比例不同，身体移动就会带着目标点漂移。例如根比例 0.25、脚相对骨盆比例 0.20，源骨盆移动 0.4 米，目标点便漂移 0.02 米。即便 IK 完全准确地跟踪这个目标，仍然会滑 2 厘米。

**这时错误发生在目标构造阶段，不是 IK 不够准确。** 接触期应采用世界固定目标或显式零速度约束。

## 4. 建议用于本项目的完整策略

以下是基于上述资料形成的工程方案，不是对某个闭源求解器的逆向还原。它覆盖几何重定向；动力学平衡、摩擦力与肌肉力量不是其自动保证的范围。

### 4.1 输入、标定和数据契约

每个角色提供：骨骼语义映射；参考姿态；固定骨长；统一为米的尺寸；关节轴/范围；脚跟、前脚掌、脚尖及掌面标记相对骨骼的局部坐标。需要胸背接触时增加身体表面代理。

每段动作提供：时间戳；源根轨迹；源局部旋转；可重建的源世界姿态；地面平面或环境；接触标注，或自动检测结果及置信度。

目标脚底标记必须来自目标模型。不能把源踝关节的高度直接当作目标脚底高度。模型整体包围盒高度也不能直接替代腿高。

### 4.2 先形成保留动作风格的旋转基准

源目标参考姿态不同，不能不经标定就逐骨复制四元数。对于已经处于同一轴向体系、对应拓扑的骨骼，可以使用参考世界旋转换基：

\[
\bar R_{j,local}^{t}=
(W_{parent(j)}^{t,0})^{-1}
W_{parent(j)}^{s,0}
R_{j,local}^{s}
(W_j^{s,0})^{-1}W_j^{t,0}.
\]

上式是一种公开实现采用的局部旋转映射；不同拓扑、额外 twist bones、容器变换需要单独映射规则。将源参考姿态代入应准确得到目标参考姿态。[UPF-GTI 算法及公式](https://github.com/upf-gti/retargeting-threejs/blob/82f1b8218813547224dd96df1638c950d241824d/docs/Algorithm.md)

得到的 \(\bar q\) 是后续求解应尽量保持的姿态，不代表所有帧最终必须保留这些角度。

### 4.3 根运动：选一种明确的产品语义

默认“保持归一化步态”，采用参考站姿骨盆到支撑平面高度：

\[
s_r=h_t^0/h_s^0,\quad
\bar H(t)=H_t^0+s_rC[H_s(t)-H_s^0].
\]

这个比值是本方案明确选择的规则，不是推测 HumanIK Auto 的规则。它应与落点使用的世界缩放保持一致。

如果业务要求角色用同样的现实距离行走、抓同一个门把手，便应保持这些世界目标的米制位置，并允许步态/骨盆发生更多改变。不能同时要求任意体型保持源关节角、源绝对步幅、全部接触和固定骨长。

### 4.4 自由运动：相对身体映射

对一条链，令 \(A\) 为链根，\(L\) 为参考骨长之和，\(U\) 为经过标定的链附着坐标框架。构造归一化源向量与目标点：

\[
u_c=(U_s)^T(P_s-A_s)/L_s,\qquad
\widehat P_{free}=A_t+L_tU_tu_c.
\]

简单同轴情况下就是 \(A_t+(L_t/L_s)(P_s-A_s)\)。\(A_t\) 必须来自当前目标姿态的真实 FK 链根，不能用“骨盆位置＋不随身体旋转的常量偏移”。

这是“保持相对伸展程度与方向”的一种明确选择，适用于自由摆动的手脚。若希望更强保留源关节角，可降低这个位置任务的权重，仅保留旋转基准。腿长总比也不能保证大小腿分配不同的目标一定可达。

### 4.5 接触运动：切换目标的空间语义

每个接触任务分为：

| 状态 | 目标构造 | 约束 |
|---|---|---|
| 自由摆动 | 相对骨盆/肩部的归一化位置 | 位置软目标＋姿态保留 |
| 静止支撑 | 一个接触时段共用的世界落点 | 标记位置固定 |
| 脚掌滚动 | 当前支撑标记，例如脚跟→前掌→脚尖 | 当前枢轴固定，允许脚旋转 |
| 沿地面滑动 | 世界轨迹或地面切向轨迹 | 限制法向高度，保留切向速度 |
| 抓取物体 | 物体局部接触点转换到当前世界 | 随物体移动 |
| 手触身体 | 目标身体的对应表面点 | 两个目标表面点相接触 |

静止支撑时段 \(I_k\) 的初始落点可取源标记稳定位置，经一致的世界映射后投影到目标平面：

\[
a_k=\Pi_{ground}\left(S\left(\operatorname{median}_{t\in I_k}P_{marker}^s(t)\right)\right),
\qquad F_{marker}^t(q(t))=a_k.
\]

median 可用逐坐标稳健中值作为工程实现；\(S\) 在这个时段不能随骨盆移动。为了适配脚宽和不同站姿，可把 \(a_k\) 作为整段共享优化变量，并惩罚偏离初值；**不能每帧独立移动落点来冒充锁脚**。

若已求得脚的目标世界旋转 \(R_f\)，脚底局部标记为 \(b\)，则踝目标是 \(P_{ankle}=a_k-R_fb\)。脚旋转时需要更新这个踝目标；不能锁住踝关节却期望任意脚尖都不动。

接触进入/退出使用连续权重或短窗口处理。只有完整锁定区间才承诺固定位置；过渡区间存在可测量的软误差。

### 4.6 没有动画师时，怎样得到接触状态

已有可信动作标注优先。无标注时，从源接触标记的世界高度与速度生成候选：

\[
d_j=n\cdot(P_j-o),\qquad
v_j=\frac{\|P_j(t)-P_j(t-\Delta t)\|}{\Delta t}.
\]

以 \(d_j/h_s\) 和 \(v_j/h_s\) 比较阈值，使用进入/退出不同阈值、最短持续时间和置信度。阈值取决于 mocap 噪声与动作类型，不能把某论文的“每帧移动 1 厘米”无条件用于所有帧率。

明确限制：

- 空中缓慢移动的手不一定是接触；高度和速度只是候选证据。
- in-place 动作缺少世界根轨迹时，脚在角色空间中向后移动可能正是支撑；须恢复轨迹、使用已知运动速度或依赖相位标注。
- 未知地面可尝试从长时稳定低位样本拟合，但不能逐帧把全身最低点降到零；那会破坏跳跃和翻滚。
- 翻滚中胸背接触需要表面标记/代理和接触模式，不能仅用“手脚低于某高度”恢复全部语义。

这些限制需要诊断输出，而不是静默宣称所有动作已经正确识别。

### 4.7 一个共享姿态求解问题

令 \(x_t\) 包含目标根位置、根朝向和有关关节角；所有末端位置由同一个 FK 函数得到。可使用以下窗口/整段目标：

\[
\min_{x,a}\sum_t\left[
w_p\|e_{pose}(x_t,\bar x_t)\|^2+
w_r\|H(x_t)-\bar H_t\|^2/h_t^2+
\sum_c w_c\|F_c(x_t)-\widehat P_{free,c}\|^2/h_t^2
\right]
+w_a\sum_k\|a_k-\bar a_k\|^2/h_t^2
+w_d\sum_t\|\Delta\delta_t\|^2.
\]

其中 \(\delta_t\) 是相对基准姿态的局部修正，旋转误差采用 SO(3) 对数；对修正做时序正则，而非强行抹平源动作。各残差须统一量纲、按关节配置权重。

约束包括：稳定接触标记 \(F_c(x_t)=a_k\)；有关表面点不穿地；关节范围；固定骨长由 FK 保证。需要手碰身体、身体避碰时，加入相应表面关系。脚跟、脚尖同时固定前，应确认目标脚几何允许两点的间距。

建议数值方法：阻尼 Gauss–Newton / SQP，使用上一帧与 FK 基准初始化。线性化残差 \(r\) 和当前活动约束 \(c=0\)，等式子问题为：

\[
\begin{bmatrix}J^TWJ+\mu I&J_c^T\\J_c&0\end{bmatrix}
\begin{bmatrix}\Delta x\\\lambda\end{bmatrix}
=-\begin{bmatrix}J^TWr\\c\end{bmatrix}.
\]

不等式和关节限制进入 QP/活动集；旋转用指数映射更新，配合步长/信赖域和残差终止。接触约束不兼容时须显式松弛或报告失败；非线性求解不保证任意初始化下得到全局最优。

双脚、手脚同时支撑时共用根变量，不能让每条链各自移动一份骨盆。一般优先满足可行的接触与不穿透，再尽量保留姿态和轨迹；不可行时报告哪个目标残差超标。

### 4.8 两骨 IK 的准确几何内核

单条、无耦合、球关节近似的肢体可以用解析解。根 \(A\)、末端 \(T\)、骨长 \(L_1,L_2\)：

\[
D=\|T-A\|,\quad |L_1-L_2|\le D\le L_1+L_2,
\]
\[
e=(T-A)/D,\quad
a=(L_1^2-L_2^2+D^2)/(2D),\quad
b=\sqrt{L_1^2-a^2},\quad K=A+ae+bv.
\]

\(v\) 是垂直于 \(e\) 的单位弯曲方向，由源膝/肘平面映射而来。退化时使用连续的历史 pole；\(D=0\) 等情形必须分支处理。计算上下骨朝向时保留并正确分配轴向 twist，末端世界朝向需再转回新的父空间。

超出可达区间时可以生成最近可达近似，但残差不能隐藏。特别是最小距离 \(|L_1-L_2|\) 不能遗漏。该解析核不处理一般关节限位、双支撑耦合和身体碰撞，它们仍由上层约束求解处理。

## 5. 对走路进入场地再翻滚的具体含义

不需要先把整段动画永久设成“手 FK、脚 IK”。程序可以始终保留全身 FK 姿态基准，同时按时间启用不同空间任务：

1. 走路时，脚的支撑片段是世界固定任务；手主要保留摆动风格。
2. 手掌开始支撑时，新增掌面世界接触任务，手臂、肩部、骨盆和脊椎共同调整。
3. 胸背滚地时，使用相应表面接触与不穿透任务；支撑点随滚动变化，不能永久固定胸骨一个点。
4. 离地后释放相关接触，回到自由运动目标及姿态保留。

这里变化的是接触约束与权重，而不是动画师控制器上的 IK/FK 开关。求解完成后的普通局部旋转关键帧仍然可以用 FK 播放。

## 6. 本次实际验证与交付边界

附带 `check_geometry.py` 使用 NumPy 对 81 个二维双骨姿态做独立计算：

| 场景 | 结果 |
|---|---|
| 骨长、根位置统一缩放到 0.25，沿用旋转 | 接触误差小于 1e-12 米 |
| 总腿长同样为 0.25，但大小腿改为 0.20 / 0.05，沿用旋转 | 脚水平变化约 8.67 毫米，最大离原接触点约 65.38 毫米 |
| 同一非等比腿，解析 IK 跟踪固定接触点 | 接触与骨长误差均小于 1e-12 米 |
| 根比 0.25、末端相对比 0.20 | 目标水平滑动 20 毫米，与推导一致 |
| 骨长 0.8 / 0.2，要求根末端距离 0.2 | 不可达；最小可达距离为 0.6 米 |

这是公式与反例验证，不是 HumanIK 黑盒测试，也不是实际 mocap / 网格 / WebGPU 验收。本次没有改动项目代码或原设计文档。

要以“默认自动合理”为产品验收，应分别检查：根位移、接触段最大滑动、地面穿透、关节限制、接触切换跳变、体积穿插，并覆盖等比大小角色、非等比四肢、双支撑、手支撑、翻滚、跳跃、in-place 与源噪声。单个走路片段不能证明完整覆盖。

**建议的实现主线：参考姿态旋转映射 → 一致的根/落点尺度 → 自由部位相对映射 → 接触状态及世界目标 → 共享根的约束 IK → 时序连续性与残差验收。**


## 附录 A：几何验证脚本完整存档

以下脚本可复制保存为 `check_geometry.py`，运行 `python -X utf8 check_geometry.py`。不需要项目引擎、mocap 文件或 GPU；它不能证明真实动画效果。

```python
"""Synthetic geometric checks, not a HumanIK or production animation test."""
import json
import numpy as np


def knee(hip, foot, upper, lower):
    delta = foot - hip
    distance = float(np.linalg.norm(delta))
    if not abs(upper - lower) <= distance <= upper + lower:
        raise ValueError("Unreachable two-bone target")
    direction = delta / distance
    pole = np.array([-direction[1], direction[0]])
    along = (upper * upper - lower * lower + distance * distance) / (2 * distance)
    height = np.sqrt(max(0.0, upper * upper - along * along))
    return hip + along * direction + height * pole


xs = np.linspace(-0.2, 0.2, 81)
uniform_feet, unequal_feet, ik_feet, radial_goals = [], [], [], []
length_errors = []
for x in xs:
    hip = np.array([x, 0.9])
    foot = np.zeros(2)
    mid = knee(hip, foot, 0.5, 0.5)
    upper_direction = (mid - hip) / 0.5
    lower_direction = (foot - mid) / 0.5
    target_hip = 0.25 * hip
    uniform_feet.append(target_hip + 0.125 * upper_direction + 0.125 * lower_direction)
    unequal_feet.append(target_hip + 0.2 * upper_direction + 0.05 * lower_direction)
    target_mid = knee(target_hip, foot, 0.2, 0.05)
    target_lower_direction = (foot - target_mid) / np.linalg.norm(foot - target_mid)
    ik_feet.append(target_mid + 0.05 * target_lower_direction)
    length_errors.extend([
        abs(np.linalg.norm(target_mid - target_hip) - 0.2),
        abs(np.linalg.norm(foot - target_mid) - 0.05),
    ])
    radial_goals.append(0.25 * hip + 0.2 * (foot - hip))

uniform_feet, unequal_feet, ik_feet, radial_goals = map(
    np.array, (uniform_feet, unequal_feet, ik_feet, radial_goals)
)
result = {
    "description": "2D exact two-bone geometry; meters; no engine or mocap validation",
    "uniform_fk_max_contact_error_m": float(np.max(np.linalg.norm(uniform_feet, axis=1))),
    "unequal_fk_horizontal_contact_travel_m": float(np.ptp(unequal_feet[:, 0])),
    "unequal_fk_max_contact_error_m": float(np.max(np.linalg.norm(unequal_feet, axis=1))),
    "contact_ik_max_contact_error_m": float(np.max(np.linalg.norm(ik_feet, axis=1))),
    "contact_ik_max_bone_length_error_m": float(max(length_errors)),
    "radial_scaling_contact_travel_m": float(np.ptp(radial_goals[:, 0])),
    "radial_scaling_predicted_travel_m": (0.25 - 0.2) * (xs[-1] - xs[0]),
    "unreachable_example": {"upper_m": 0.8, "lower_m": 0.2,
                            "desired_distance_m": 0.2, "minimum_distance_m": 0.6},
}
assert result["uniform_fk_max_contact_error_m"] < 1e-12
assert result["unequal_fk_horizontal_contact_travel_m"] > 1e-6
assert result["contact_ik_max_contact_error_m"] < 1e-12
assert result["contact_ik_max_bone_length_error_m"] < 1e-12
assert abs(result["radial_scaling_contact_travel_m"] - 0.02) < 1e-12
try:
    knee(np.array([0.0, 0.2]), np.zeros(2), 0.8, 0.2)
except ValueError:
    result["unreachable_example"]["rejected"] = True
else:
    raise AssertionError("An impossible target was accepted")
print(json.dumps(result, indent=2, ensure_ascii=False))

```
