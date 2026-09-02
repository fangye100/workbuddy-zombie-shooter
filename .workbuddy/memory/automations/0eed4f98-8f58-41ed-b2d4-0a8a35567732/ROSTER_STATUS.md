# 末日尸潮 · 角色绑骨名册状态（2026-09-02 续跑）

## 一、现状：6/8 完成

| ID | 角色 | EN | 状态 | 校验 |
|----|------|----|------|------|
| E-01 | 游荡者 | Shambler | ✅ DONE | bind-pose LBS max_err 1.12e-7, 6 段动画 |
| E-02 | 扑跃者 | Lunger | ✅ DONE | max_err 9.27e-8, 6 段动画 |
| E-03 | 呕吐者 | Spitter | ✅ DONE | max_err 8.25e-8, 6 段动画 |
| E-04 | 盾卫 | Bulwark | ✅ DONE | max_err 9.76e-8, 6 段动画 |
| E-05 | 爆尸 | Bloater | ✅ DONE | max_err 9.50e-8, 6 段动画 |
| B-01 | 屠夫 | THE BUTCHER | ✅ DONE | max_err 9.74e-8, 6 段动画 |
| B-02 | 母体 | THE BROODMOTHER | ⏳ PENDING | 混元额度挡住（见下） |
| B-03 | 零号 | PATIENT ZERO | ⏳ PENDING | 混元额度挡住（见下） |

`verify_roster.py` 实跑结论：**6/8 通过**（bind-pose LBS tol=1e-3，animated sanity 全过）。

## 二、rigged 角色 + 动画在 Asset Library 里在哪（回答 Q2）

编辑器 Asset Library 是**文件系统镜像**（ROOT_NAME=`game-design-zombie`，默认目录 `assets`），
没有单独的「rigged」分类——rigged 角色就是普通的 `.glb` 文件，按真实路径出现在树里：

1. 在 Asset Library 面板左侧树形导航到：
   `assets/characters/models/E-01/rigged/`
   （其余角色同理：`E-02` `E-03` `E-04` `E-05` `B-01`）
2. 内容区会列出 `E01_Shambler_900_rigged_animated.glb` 等文件。
3. **双击**该 `.glb`（或拖到画布）→ `onSpawn` 载入场景，**自动播放**。
4. 载入后右侧动画面板自动出现：片段下拉（idle/run/attack/walk/hit/death）、
   播放/暂停/停止/循环/速率/时间轴、蒙皮权重热力图（debugMode 9）。

> 注意：B-02 / B-03 此刻**不在** Library 里，因为对应 GLB 还没生成（被混元每日 5 次提交上限挡住）。

## 三、怎么预览 rig + 动画（回答 Q1）

- 启动：`npm run lab` → 打开 `https://localhost:5178`（因 `.workbuddy/tmp/certs` 存在自动 HTTPS）。
- 导入：「导入 GLB…」按钮（`ui.ts:427` 的隐藏 file input）或把 `.glb` 拖到画布（`main.ts:880` 的 drop 处理）。
- 动画面板（`buildAnimation`，`ui.ts:466`）：片段下拉 → `renderer.playAnimation(idx)`；
  播放/暂停 `[data-anim=play]`；停止 `stopAnimation`；循环/速率/时间轴；
  蒙皮权重可视化 = `debugMode=9` 开关。

## 四、B-02 / B-03 阻塞与排期

- **阻塞原因**：混元 3D（dimension `hy-3d`）**每日仅 5 次提交**（HTTP 429）。
  今日配额已被 E-01/E-02/E-03/E-05/B-01 用满（首提交约 14:52 北京，滚动 24h 窗口），
  重试仍 `daily submit limit exceeded (5/5)`，不循环重试。
- **前置已全部就绪**（本次续跑确认）：
  - `assets/characters/images/B-02/front/B-02_front.png` ✓ 与 `B-03/front/B-03_front.png` ✓ 存在。
  - `roster.json` 含 B-02（tris 6000 / 4.0m）、B-03（tris 5200 / 2.6m）条目 ✓。
  - `rig_character.py` 对**所有**角色统一归一化到 2.05m（骨点固定世界位，
    相对身高由编辑器对象缩放表达），与已完成的 6 个一致 → B-02/B-03 绑骨无需改脚本。
- **补齐方式**：一次性自动化（scheduledAt `2026-09-03T15:00:00+08:00`）届时自动：
  取 fresh tempToken → `pipeline_character.py --id B-02 --id B-03 --token-stdin`
  → `validate_glb` → 8/8。遵守 git 红线（不 commit/push），遇 429 只记录不重试。

## 五、Git 红线（本自动化不碰）

- 21 个早前文件仍 staged；本次新增未跟踪（主 session 提交前需 `git add`）：
  `pipeline_character.py`、`rig_character.py`、`verify_roster.py`、`cdp-rigged.mjs`、
  `roster_manifest.json`、E-01/E-02/E-03/E-05/B-01 各 `models/<ID>/` 产物。
- 提交交由用户指定的主 session 执行；本自动化只改工作区。
