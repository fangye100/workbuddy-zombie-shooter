# 环境 LOD 重做 —— 交接文档

> 接手人先读这一篇，不用翻聊天记录。
> 分支 `fix/lod-regen-20261004`（从 `origin/main` @ `5aade8f` 开出）。
> 文档时间：2026-10-04 18:00。**工作区有 38 个文件未提交**（见 §7），先读§7 再动手。

---

## 0. 一句话现状

用户要求「用最新算法把环境侧模型重新生成一遍」。角色侧本来就已完成（不是本次范围），
环境侧 38 件已全部改走最新算法，但**发现「最新算法在环境侧产出的几何仍不可用」**，
根因已定位到「平面数（UV chart 数）」这个结构性下限，**尚未定档完成**。

**这不是一个「做完就能收」的任务。接手前务必先读 §3 的两个已验证结论。**

---

## 1. 背景：两套 LOD 算法，项目里并存

| | 角色侧（现行） | 环境侧（本次要换掉的） |
|---|---|---|
| 工具 | `assets/characters/_tools/decimate_uvkeep.py` | `assets/environment/_tools/env_pipeline.py` → `env_bake.py` → `env_transfer.py` |
| 减面 | 焊点 + **保纹理 QEM**（`meshing_decimation_quadric_edge_collapse_with_texture`） | **空间聚类**（vertex clustering，`decimate_cluster.py`） |
| UV | **继承原生**（焊点保留逐面角wedge） | xatlas **重新展** |
| 贴图 | **直接内嵌原生 4096²** | 顶点色 → xatlas UV → 转移烘焙成 512² |
| 产物指纹 | `image/jpeg` 4096² | `image/png` 512² |

两套工具都是 2026-09-18 同日由 `FANGYE\fangy` 提交（`cf206b9` / `d145818`，均在 main）。
`bake_lowpoly.py` 头部有 **DEPRECATED** 标注，说明第一代（顶点色烘焙）已被弃用。
`decimate_cluster.py` 的注释记录了「QEM 对混元网格不可用」的历史判断，
**但这个判断后来被推翻了** —— `decimate_uvkeep.py` 证明混元高模是完美封闭流形，
焊点后边界边/非流形均为 0。环境侧停在了被推翻的旧判断上。

`decimate_uvkeep.py` 是**通用工具**，吃任意 raw glb，不挑角色 —— 这是本次能换算法的前提。

---

## 2. 已完成的工作

### 2.1 36/38 件环境 LOD1 已改走路线 A

- 27 件（首轮）+ 9 件（补做）= 36 件，全部 `image/jpeg` 4096² 内嵌原生贴图
- 剩 2 件：**P-05 / P-43**，碎壳体，见 §5

### 2.2 修掉一个隐蔽 bug：`baseColorFactor = 0.4`

**症状**：用户在 asset browser 里切 LOD 发现「LOD 色彩完全没继承」。

**根因**：11 件旧产物的材质带 `pbrMetallicRoughness.baseColorFactor = [0.4,0.4,0.4,1]`。
glTF 里这是**乘在贴图上**的整体色调 —— 0.4 灰乘子把贴图压暗到 40%，贴图本身再准也全灰。

**来源**：`env_transfer.py` 的 `pack_glb()` 用 trimesh 导出，
trimesh 的 `TextureVisuals` 会硬写这个 0.4（它自己的默认材质色），非人为。

**已修**：
- 生成器 `env_transfer.py` 加 `_fix_base_color_factor()`（导出后改 JSON，trimesh 不暴露该参数）
- 存量 11 件用 `assets/environment/_tools/fix_basecolor_factor.py` 修完（带 `.pre-bcf.bak` 备份）
- `--check` 已并入 `pnpm run scene:check`

🔴 **教训**：这个 bug 我一开始没发现，因为我只测「贴图像素彩度」、**没测材质参数**。
彩度判据对材质层的bug 完全无感。

### 2.3 asset browser 已接入算法溯源

环境卡片新增标签：**青 `路线A`** / **红 `贴图旧法`** + 彩度百分比。

- 数据：`assets/_data/lod-quality.json`（入库）
- 生成器：`assets/environment/_tools/audit_lod_quality.py`（`--check` 已入门禁）
- `gen_manifest.mjs` 读它填`lod1Alg` / `lod1Colorful`

**判据试了三种，前两种都错**（详见 §6 纪律 2）：最终用「贴图格式+尺寸」
（JPEG 4096²= 路线 A，PNG 512² = 旧法），零阈值、38 件 27/11 精确匹配。

### 2.4 顺手补齐 H-01（玩家角色）的 LOD1

H-01 此前**完全没有 LOD**（只有 79980 面 LOD0 raw）。已用 `rig_uvkeep.py` 补 LOD1：
10500 面（命中 roster 预算 3500×3）、UV 密度 2.1、面积保持 96.9%。

**并修掉 `rig_uvkeep.py` 两个真 bug**：
1. `roster_target()` 只查 npcs+bosses，漏了 protagonists → H-01 静默退到 3000 面（应10500）
2. LOD1 分支「只覆盖不新建」→ 从未做过 LOD 的角色缺口永远补不上

LOD2/LOD3 仍缺（需先走 `rig_character.py` 出 rigged 模板）。

---

## 3. ⚠️ 核心未完成问题：环境侧几何崩坏

### 3.1 用户截图发现

用户让我在 asset browser 里看 P-41 病床。截图显示：

- **LOD0**：能认出的病床（白床单、红栏杆、蓝床架、输液杆）
- **LOD1**：认不出的碎块

**我的错**：之前只验文件层数据（贴图=原生贴图、factor=1、UV数量正常）就标OK，
**没看渲染**。我甚至在报告里写「LOD1 的贴图就是 LOD0 那张，一个像素没改」——
贴图没错，但挂在错乱的几何上一样是花的。

### 3.2 判据失效（我照搬了角色侧判据，没验证）

`docs/06` §7.8 的两条判据在环境侧失效，我当时把它们设成「只记录不否决」：

| 判据 | 角色侧 | 环境侧实测 | 后果 |
|---|---|---|---|
| UV 密度 `p99/med < 3` | 2.0~2.7 | **5~21** | P-41 = 20.8，崩坏 |
| 面积保持 `> 90%` | 92.8~98.6% | **可 > 100%**（P-41 达 166%） | 我明明测到了却放过 |

我给的理由是「环境 raw 含内部面，分母虚高」—— 这理由在环境侧**不成立**，
且我没验证就照搬。于是「P-41 面积 166%」这个明确的崩坏信号被放过。

### 3.3 ✅ 已验证：平面数是必要下限

**实测 P-33**：

| LOD1 面数 | UV 密度 | 平面数 | 视觉 |
|---|---|---|---|
| 1040 | 4.5「达标」 | 3815 | 明显碎 |
| **3814（= 平面数）** | **2.8** | 3815 | **明显改善** |

新增 `assets/environment/_tools/uv_chart_count.py` 算平面数。
**全 38 件合计：LOD0 1899 万面→ 平面 147901 个**（仅 0.8%）。

**根因原理**：路线 A 保住原生 UV 后，一个低模三角形若跨了两个原始平面，
采样时跨越贴图边界 → 撕裂/花脸。**面数 < 平面数，必然有面跨平面。**

`props.json` 的 `tris` 已按平面数重定档（38 件，总 147901 面）。

### 3.4 ❌ 未验证：平面数是必要但不充分

P-33 按 3815 面（= 平面数）后**仍有碎面**。原因：**中位 chart 只有 4 个面**
—— 按平面数分配后每个 chart 平均只剩 1 个面，**chart 内部形状也塌了**。

**推测的真正下限 = 中位 chart 面数 × 平面数**（P-33 约需 15260 面）。
**这一档尚未验证。**

---

## 4. 接手后的第一步（建议）

**先做单件双点验证，不要直接全量重跑**（我今天已经因为跳过这步白跑了两轮）：

```
# P-33 按「中位 chart × 平面数」= 15260 面做一件
# 然后截图看视觉
node tools/verify/ab-shot.mjs P-33 env
```

- **若干净** → 按这个公式给 38 件定档，全量重做（总量约 60 万面 = LOD0 的 3.2%）
- **若仍碎** → 说明混元 UV atlas 本身太碎，路线 A 在环境侧有更深问题，
  **该换思路而非继续加面数**（选项：环境侧改走「适度减面 + 接受贴图是氛围色」/ 重新生成源模型）

验证通过后再全量，并**每件都截图确认**（别信数值，见 §6 纪律 1）。

---

## 5. P-05 / P-43：路线 A 救不了，需要重新生成源模型

这两件是**碎壳体**：

| ID | 面数 | 连通壳数 | props 预算 |
|---|---|---|---|
| P-05 轮胎堆 | 520937 | **17255** | 320 |
| P-43 轮椅 | 480322 | **6208** | 420 |

**全局 QEM 按二次误差全局排序** → 优先把大壳减碎、小壳一个不动：
- P-43 卡在 5186~5190 面下不来（预算 420，差 12 倍）
- P-05 减到 615 面时相邻壳被焊到一起 → 边界 49 / 非流形 42

**参数扫描已证明调参无用**（焊点阈值 0.0002/0.002/0.01 × UV 权重 1.0/0.3，六组全试）。

`assets/environment/_tools/regen_shelly_lod.py` 试过「按壳分配预算」：
算下来至少要 18567 面（预算 420 差 44 倍），最后抽稀回420 面反而产生 595 边界边。**此路不通。**

**结论：这两件需要重新跑混元生成源模型**（`assets/characters/_tools/gen3d_from_image.py`），
混元每次输出轴向不保证一致（8 只里 7 只 Y-up、1 只 Z-up），要逐件判定。

---

## 6. 纪律（我今天踩过的坑，别重蹈）

### 1. 🔴 必须看渲染，不能只信数值指标

我今天最大的错误。文件层数据全对（贴图=原生、factor=1、UV 数正常），
**视觉依然崩坏** —— 因为几何坏了。「间接指标」不能当结论。

工具：`tools/verify/ab-shot.mjs <资产ID> [env|char]`
—— **用 asset browser 自己的 viewer 截图**（复用页面 GLTFLoader/灯光/轨道）。
产出 `.workbuddy/tmp/ab-verify/AB_<ID>_LOD{0,1,2}.png`。

> 注：我另写的 `tools/verify/lod-render-probe.mjs`（自建渲染器）在本机**渲出全黑**，
> 排查后确认 GPU 是 NVIDIA RTX 4070、GL 正常（最小用例 clearPixel 红色正确），
> 是探针代码问题。**用 `ab-shot.mjs` 就好，别用那个。**

### 2. 🔴 判「产物是哪套算法产的」要找结构性证据，不要用连续量阈值

试过三种：
- 查备份文件在不在 ❌ 备份已 gitignore，换机器/克隆后不在 → 全标错
- 彩度阈值 35% ❌ 旧产物彩度是**连续长尾0%~43%**，与新产物 87% **有重叠**
  （P-05=43% / P-43=38% / P-11=37% 都是旧产物但彩度不低）→ 误判 3 件
- 贴图格式+尺寸 ✅ 结构性、零阈值、38 件 27/11 精确匹配

### 3. 判别力实验：每条结论都要能自证

「篡改 → FAIL → 恢复 → PASS」，不能只跑一次 happy path。
`audit_lod_quality.py --check` 我验证过：篡改 P-33 → `exit 1` → 恢复 → `exit 0`。

### 4. 扫描探针起点要贴着目标，别一上来就放大 12×

`tools/tune_env_budget.py` 我最初从 12× 起步扫，P-41 一路探到 6000 才返回，
白烧 5 倍时间，还给出 4 倍偏高的建议（实际 1500 就够）。改成从 1× 逐级向上。

### 5. 边数判据必须按位置去重，不能按顶点索引

wedge顶点分裂后同一位置不同 UV → 不同索引，按索引算边会把闭合边拆成两条边界边
（P-33 正确 0，按索引算假报 1146）。量化到 1e-6 m 整数键。

### 6. Windows 行尾

Python `open(OUT,'w')` 默认写 CRLF → git 拒收（`fatal: CRLF would be replaced by LF`）。
必须 `newline='\n'`。仓库无 `text=auto eol=` 规则，标准是 LF。

### 7. QEM 不保证精确命中目标面数

P-33 要3815 实际得 3814。面数下限卡 95%，别卡 100%。

---

## 7. 工作区状态（**未提交，接手第一件事**）

`git status`有 **38 个文件未提交**：

```
M assets/environment/models/*/tex2/*_baked.glb        (34 个，34 件已按平面数定档重做)
M assets/environment/props.json                        (tris 已按平面数重定档)
M assets/environment/_tools/regen_env_lods.py          (面数下限 95%、相对基线拓扑判据)
M assets/environment/_tools/uv_chart_count.py          (新增，未提交)
M assets/_data/asset-manifest.json
```

已提交的 7 笔（`cc4776b..ae700b0`）是调查文档 + 前 36 件 + browser 接入 + P-41 验证。

**建议先把这批提交掉**（提交即推送是项目铁律），再继续 §4 的验证。
或直接接着改 —— 反正都是同一分支。

---

## 8. 工具清单（本轮新增/修改）

| 文件 | 用途 |
|---|---|
| `assets/environment/_tools/regen_env_lods.py` | **批量重做主工具**。`--list DROP/all` `--only <ID>` `--dry` `--tol` `--face-tol`。带备份 + 判据 + JSON 报告 |
| `assets/environment/_tools/uv_chart_count.py` | **算平面数**（新增，核心判据依据） |
| `assets/environment/_tools/tune_env_budget.py` | 扫面数预算找最小达标值 |
| `assets/environment/_tools/audit_lod_quality.py` | 生成/校验 `lod-quality.json`（算法溯源） |
| `assets/environment/_tools/fix_basecolor_factor.py` | 修 `baseColorFactor=0.4`（带 `--check`） |
| `assets/environment/_tools/regen_shelly_lod.py` | 碎壳体按壳分配预算（**结论：此路不通**，留作记录） |
| `assets/characters/_tools/rig_uvkeep.py` | 修了两个 bug（protagonists 漏查、LOD1 不新建） |
| `assets/environment/_tools/env_transfer.py` | 加 `_fix_base_color_factor()` |
| `tools/verify/ab-shot.mjs` | **用 asset browser viewer 截图**（唯一可靠的视觉验证手段） |
| `tools/verify/lod-render-probe.mjs` | ⚠️ 自建渲染器，本机渲出全黑，**别用** |

`pnpm run lod:audit` =跑 `audit_lod_quality.py`。
`pnpm run scene:check` 已并入 `audit_lod_quality --check` 与 `fix_basecolor_factor --check`。

---

## 9. asset browser（验证入口）

```powershell
node assets/_tools/serve_assets.mjs 5612
# → http://localhost:5612/asset-browser.html
```

点「环境」tab → 卡片带`路线A`/`贴图旧法` 标签 + 彩度 → 点卡片进 3D viewer
→ 点底部 LOD0/LOD1/LOD2 按钮切档。

服务当前在跑（后台任务，端口 5612）。

---

## 10. 门禁

```powershell
pnpm run typecheck
pnpm test                # 69 文件 / 1314 测试
pnpm run scene:check# 含 2 项新检查（lod-quality / baseColorFactor）
node tools/verify/guard-classprefix.mjs
```

⚠️ `pnpm test` 偶发报 2 个 `Errors` 但 `Test Files 69 passed` ——是沙箱 worker
抢写 ssr 缓存的环境噪声，复跑干净。判绿要认文件数。

---

## 11. 还有一件没碰的：环境 LOD2

环境侧 LOD2 = `<ID>_low.obj`，**顶点色、无贴图**，38 件全部是老算法产物，**本次一件没动**。

它是老流程 `env_pipeline.py` 的中间产物，本质是「没有贴图的降级档」，
与 LOD0/LOD1 不存在「复用同一张贴图」的关系。

要不要把它也改走路线 A（变成「更低面数但同贴图」的真正 LOD2），需要先确认
**引擎实际有没有在加载 `_low.obj`** —— 现状是 `gen_manifest.mjs` 把它硬指向
`<ID>_low.obj`，但引擎侧是否真读没查过。

---

## 12. 相关文档

- `docs/06-从2D概念图到3D游戏模型管线.md` §7 —— 路线 A 完整方法论与踩坑史
- `docs/LOD重做范围调查-2026-10-04.md` —— 本次调查全过程与判据推演
- `.workbuddy/memory/2026-10-04.md` —— 今日全部踩坑记录
- `assets/characters/_tools/decimate_uvkeep.py` 头部 —— 路线 A 的技术细节
- `assets/environment/_tools/env_transfer.py` 头部 —— 旧链路为什么被弃用
