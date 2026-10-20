# 碎裂资产离线制作链（WU-02）

日期：2026-10-20。基线：codex/vfx-system-20261019（WU-01 批准 SHA 7c550b16 起）。
数据契约真源：packages/scene/src/fracture.ts（FRACTURE_VERSION=1）；开发总计划见
fracture-system-development-plan-20261020.md。

## 职责

| 模块 | 职责 | 边界 |
|---|---|---|
| tools/fracture/glb-io.mjs | GLB 容器读写、accessor 解码、按位置焊接（保留首个顶点属性） | 只支持本仓资产链产出的非 sparse accessor |
| tools/fracture/split-core.mjs | 几何核心：平面切割、边界环提取、封口（平面耳切/加权扇形/残边收口）、拓扑与体积统计 | 纯函数无 IO；拓扑按量化位置键统计，渲染顶点保留 UV/法线接缝 |
| tools/fracture/build-fracture-assets.mjs | 正式资产构建：油桶平面切块（manifold-3d CSG）、盾卫骨骼分区+蒙皮保持，产出 chunk GLB 与 .fracture.json 及确定性 sidecar | 不做物理/渲染/玩法（WU-03/05/06/07） |
| tools/fracture/verify-fracture-assets.mjs | 数值验收：闭合/非退化/有限值/法线/UV、装配守恒（体积或外表面精确分割）、代理/质量、蒙皮保持与非 bind 姿态采样 | 输出报告 JSON，失败 exit 1 |
| tools/verify/fracture-assets-probe.mjs | headed 真实 GPU 近景证据（既有编辑器渲染器，静态展示） | 不冒充刚体/击碎验收 |

依赖：manifold-3d@3.5.4（Apache-2.0，devDependency，仅离线工具使用，锁定于 pnpm-lock.yaml）。

## 正式资产与选择依据

- 物体：P-01 油桶（assets/environment/models/P-01/tex2/P-01_baked.glb，LOD1 30k 面，
  Git LFS，sidecar as_74w6e6hg）。选择依据：asset-manifest 标记 destructible: true，
  为计划点名的罐体类正式可破坏物体；LOD1 已通过 headed 视觉评审（sidecar 内证据链）。
- NPC：E-04 盾卫（assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged_animated.glb，
  HumanIK 22 骨蒙皮 + 6 动画含 death，Git LFS，sidecar as_68c5qqtl）。
- 产物：
  - assets/fracture/p01-barrel/：p01-barrel-chunks.glb（12 分块，外表面=源贴图材质、
    切口=内侧深锈色材质）与 p01-barrel.fracture.json（id as_p01frct）。
  - assets/fracture/e04-bulwark/：e04-bulwark-chunks.glb（10 骨骼分区块，保留
    JOINTS/WEIGHTS 与骨架）与 e04-bulwark.fracture.json（id as_e04frct，kind npc，
    mode skinned，boneMap 逐块主骨）。
- 稳定标识：chunkId 顺序固定（chunk-0001…/head、torso…）；chunk GLB 的 sidecar guid 由
  构建工具从内容种子确定性生成（as_+sha256 前 8 位），重跑不漂移。

## 可重建步骤

~~~powershell
pnpm install                                          # 安装 manifold-3d（已锁定）
node tools/fracture/build-fracture-assets.mjs         # 重建分块 GLB + .fracture.json + GLB sidecar
node tools/scene/gen-asset-meta.mjs                   # 生成/同步 .fracture.json sidecar（guid=资产 id）
node tools/fracture/verify-fracture-assets.mjs        # 数值验收（exit 0 = 通过）
node tools/verify/fracture-assets-probe.mjs --headed --out .workbuddy/tmp/fracture-assets
~~~

输入版本与参数（构建器内固化并在配方 JSON 输出）：油桶按数据包围盒三等分高度 + 过轴心
的 x/z 直径面切 12 块；密度按总体积 18kg 归一；盾卫按主导骨骼权重分 10 区（头/躯干/双上臂/
双前臂/双大腿/双小腿），总质量 80kg 归一；盒代理=AABB；摩擦/恢复系数与碰撞组见
.fracture.json。数值验收口径：每块闭合（边界/非流形=0）、非退化（>1e-12）、法线单位
（±0.05）、UV 有限；油桶 12 块体积和 = 源实体体积（CSG 精确，实测 0.221548 m³ 全等）；
盾卫外表面三角形与源网格精确集合相等；蒙皮：非 bind 姿态（run@0.4s）下共享顶点
蒙皮位置与源网格逐点相等（maxDelta=0），新增封口顶点按邻域权重随动（delta=0）。

## 失败行为

- 源网格非定向闭合流形、CSG 单元失败、关节未映射、耳切停摆：构建器显式抛错退出，
  不产出 accepted 资产。
- 数值验收任一项失败：verify-fracture-assets.mjs exit 1 并输出完整失败清单
  （.workbuddy/tmp/wu02/fracture-verify-report.json）。
- sidecar 身份不匹配（guid ≠ 资产 id）：gen-asset-meta 显式报错（WU-01 语义）。

## 证据（2026-10-20，Windows/NVIDIA Lovelace 真实 GPU）

- 数值：.workbuddy/tmp/wu02/fracture-verify-report.json（failures=[]，含逐块统计）。
- headed：.workbuddy/tmp/fracture-assets/（01 原桶近景、02 油桶分块与切口、
  03 盾卫分块；results.json 记录 adapter 信息与 5/5 检查通过）。
- 场景门禁：pnpm run scene:check 通过（312 元数据同步、43 场景 v25、
  scene-files 17/17 含 fracture 资产跨文件校验）。

## 边界与遗留

- 分块静态展示用既有 MeshRenderer/材质路径；刚体运动、动态实例扩展、真实伤害/死亡
  接线、作者面板分别属 WU-03/05/06/07/08。
- 盾卫封口在骨骼分区边界为加权拟平面耳切/扇形面：闭合与蒙皮连续性已验证；
  个别夹点区域（腋下/胯部多股边界交点）经 figure-8 拆分与残边收口处理，拓扑闭合。
- 油桶切块依赖 manifold-3d（Apache-2.0）；该依赖不进入运行时包。
