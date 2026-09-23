/**
 * 编辑器多语言（zh / en）。
 *
 * 设计约定（2026-09-23 定，方案 B）：
 *   - **中文源文案即键**：代码里写的就是中文；en 模式查 DICT 得英文，查不到回退中文
 *     （缺翻译 = 降级显示，绝不空白）。不引入另一套 key 命名，避免 200+ 字符串双份维护。
 *   - **行业术语不翻**：ACES / AgX / Bloom / NdotL / UV / mesh / T-pose / gizmo / GLB…
 *     中英文界面里都保留原文，DICT 只收「中文部分有信息量」的整句。
 *   - **切换 = 持久化 + 整页刷新**：面板 DOM 是启动时一次性构建的命令式 UI，
 *     运行时逐节点重翻一遍不如 reload 诚实可靠（dev 工具，刷新成本可接受）。
 *   - **静态 HTML 文案**（index.html 里写死的标题/按钮）：启动时 applyStaticI18n
 *     走一遍文本节点与 placeholder/title 属性做整串替换。
 *
 * 源文案统一纯中文（不带英文拼接副标）：「复制相对路径」而不是
 * 「复制相对路径 Copy Relative Path」——那是旧的双语混写风格，已被本方案取代。
 *
 * node 环境（vitest）守卫：localStorage/document 不存在时一律按 zh，t() 退化为恒等。
 */

export type Lang = 'zh' | 'en';

const LS_KEY = 'zh.ui.lang';

function detectLang(): Lang {
  try {
    const v = localStorage.getItem(LS_KEY);
    return v === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh'; // 无 localStorage 的环境（测试/SSR）默认中文
  }
}

let lang: Lang = detectLang();

export function getLang(): Lang {
  return lang;
}

/** 切换语言：持久化后整页刷新（面板 DOM 是一次性构建的，reload 才能整体重译） */
export function setLang(next: Lang): void {
  try {
    localStorage.setItem(LS_KEY, next);
  } catch {
    /* 持久化失败也照样切，只是刷新后回到旧语言 */
  }
  lang = next;
  location.reload();
}

/** 翻译入口：中文源文案 → 当前语言。en 模式查 DICT，缺译回退中文原文。 */
export function t(zh: string): string {
  if (lang === 'zh') return zh;
  return DICT[zh] ?? zh;
}

/**
 * 静态 DOM 翻译（index.html 里写死的文案）：整串匹配替换文本节点与
 * placeholder/title 属性。只做**精确整串**替换 —— 混排节点（含变量/图标的）
 * 属于面板代码管辖，那边走 t()。
 */
export function applyStaticI18n(root: ParentNode): void {
  if (lang !== 'zh') {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) texts.push(n as Text);
    for (const node of texts) {
      const raw = node.nodeValue ?? '';
      const key = raw.trim();
      const en = DICT[key];
      if (en !== undefined) node.nodeValue = raw.replace(key, en);
    }
    for (const el of root.querySelectorAll('[placeholder],[title]')) {
      for (const attr of ['placeholder', 'title'] as const) {
        const v = el.getAttribute(attr);
        if (v === null) continue;
        const key = v.trim();
        if (DICT[key] !== undefined) el.setAttribute(attr, v.replace(key, DICT[key]));
      }
    }
  }
}

// ================================================================ 词典（zh → en）

const DICT: Record<string, string> = {
  // ---- 通用 / 顶栏 / gizmo ----
  移动: 'Move',
  旋转: 'Rotate',
  缩放: 'Scale',
  世界坐标: 'World Space',
  局部坐标: 'Local Space',
  '移动 W': 'Move W',
  '旋转 E': 'Rotate E',
  '缩放 R': 'Scale R',
  '骨骼 X': 'Skeleton X',
  '骨骼 X-ray 叠加（主视图）': 'Skeleton X-ray overlay (main view)',
  切换界面语言: 'Toggle UI language',
  无法启动: 'Failed to Start',

  // ---- 右键菜单（资产库 / 层级共用） ----
  '进入绑定 · 纯网格（继续上次编辑）…': 'Enter Binding · Mesh-only (continue last edit)…',
  '进入绑定 · 纯网格（仅 .glb）': 'Enter Binding · Mesh-only (.glb only)',
  '进入绑定 · 已有骨骼（导入文件骨架）…': 'Enter Binding · Rigged (import file skeleton)…',
  '进入绑定 · 已有骨骼（仅 .glb）': 'Enter Binding · Rigged (.glb only)',
  载入场景: 'Spawn to Scene',
  '载入场景（仅 .glb）': 'Spawn to Scene (.glb only)',
  复制相对路径: 'Copy Relative Path',
  复制绝对路径: 'Copy Absolute Path',
  重命名: 'Rename',
  在资源管理器中显示: 'Reveal in Explorer',
  已复制相对路径: 'Relative path copied',
  已复制绝对路径: 'Absolute path copied',
  '复制失败（剪贴板不可用）': 'Copy failed (clipboard unavailable)',
  取绝对路径失败: 'Failed to resolve absolute path',
  重命名失败: 'Rename failed',
  已重命名: 'Renamed',
  'sidecar 已随迁': 'sidecar moved along',
  项目登记已更新: 'project registry updated',
  打开文件位置失败: 'Failed to open file location',

  // ---- 资产库 Asset Browser ----
  资产库: 'Asset Library',
  项目根: 'Project Root',
  返回上一层: 'Up One Level',
  '筛选当前目录…': 'Filter current folder…',
  列表: 'List',
  图标: 'Icons',
  收起: 'Collapse',
  展开资产库: 'Expand Asset Library',
  '收起 / 展开资产库': 'Collapse / Expand Asset Library',
  空目录: 'Empty folder',
  没有匹配筛选项: 'No items match the filter',
  名称: 'Name',
  大小: 'Size',
  修改时间: 'Modified',
  'Enter 提交 · Esc 取消': 'Enter to confirm · Esc to cancel',
  文件夹: 'Folder',
  '3D 模型': '3D Model',
  图片: 'Image',
  'JSON 数据': 'JSON Data',
  脚本: 'Script',
  文档: 'Document',
  音频: 'Audio',
  压缩包: 'Archive',
  字体: 'Font',
  文件: 'File',

  // ---- HUD / 状态行 ----
  选中: 'Selected',
  无: 'None',
  轻点选中: 'Click to select',
  视图: 'View',
  画布: 'Canvas',
  '目录读取失败': 'Failed to read folder',

  // ---- Inspector / 面板标题 ----
  动画: 'Animation',
  场景层级: 'Hierarchy',
  聚焦: 'Focus',
  删除: 'Delete',
  整体材质: 'Overall Material',
  'Mesh 材质': 'Mesh Material',
  材质: 'Material',
  导出: 'Export',
  '复制 JSON': 'Copy JSON',
  '导出 .json': 'Export .json',

  // ---- 全量词典（键扫描生成 + 人工翻译校对） ----
  '(项目根)': '(project root)',
  '0 · 僵尸绿（skin）': '0 · Zombie Green (skin)',
  '1 · 地面灰（cloth）': '1 · Ground Grey (cloth)',
  '2 · 皮肤（skin）': '2 · Skin (skin)',
  '3 · 金属（metal）': '3 · Metal (metal)',
  '4 · 自发光（emissive）': '4 · Emissive (emissive)',
  '5 · 布料（cloth）': '5 · Cloth (cloth)',
  'ACES（Narkowicz 近似）': 'ACES (Narkowicz approx.)',
  'AgX（推荐）': 'AgX (recommended)',
  'Albedo': 'Albedo',
  'Bind Skin 时真正生效的权重算法。包裹体：被 Skin Wrapper 圆柱体包住才归属该骨，边界较硬但可控，配合半径精细调整；距离衰减：按顶点到骨段距离衰减取 top-4，过渡自然、不用调半径，但对侧骨可能抢到少量权重': 'Weight algorithm used by Bind Skin. Wrapper: a vertex belongs to a bone only when enclosed by its Skin Wrapper cylinder - hard but controllable edges, fine-tuned via radii; Distance falloff: weights fall off with vertex-to-bone-segment distance, top-4 kept - smooth transitions without radius tuning, but opposite-side bones may steal a little weight',
  'Bloom 强度': 'Bloom Intensity',
  'Bloom 阈值': 'Bloom Threshold',
  'Fill 半球环境（不分阶）': 'Fill Hemisphere Ambient (unbanded)',
  'Grading 三段调色': 'Grading 3-Way Color',
  'Key 主光（唯一分阶）': 'Key Light (only banded)',
  'Merge Points（焊接顶点）': 'Merge Points (weld vertices)',
  'Mesh 材质（Material Slot）': 'Mesh Material (Material Slot)',
  'NdotL（灰度）': 'NdotL (grayscale)',
  'None（线性截断）': 'None (linear clamp)',
  'Reinhard': 'Reinhard',
  'Rim 边缘光（不分阶）': 'Rim Light (unbanded)',
  'Shift + 方向键': 'Shift + Arrow Keys',
  'Shift 拖拽': 'Shift + Drag',
  'Tonemap': 'Tonemap',
  'Toon 分阶': 'Toon Banding',
  'UV 坐标（RG）': 'UV Coordinates (RG)',
  'UV 棋盘格': 'UV Checker',
  'Unlit（跳过全部分阶）': 'Unlit (skip all banding)',
  '不入骨架': 'not in skeleton',
  '世界法线': 'World Normal',
  '个文件': 'files',
  '个文件夹': 'folders',
  '中轴骨': 'Axial Bones',
  '中间调上界': 'Midtones Upper',
  '中间调倍率': 'Midtones Gain',
  '中间调饱和度': 'Midtones Saturation',
  '产出': 'Output',
  '亮度阈值': 'Brightness Threshold',
  '亮部倍率': 'Highlights Gain',
  '亮部混 bone': 'Highlights Tint bone',
  '亮部饱和度': 'Highlights Saturation',
  '仅中轴': 'Axial Only',
  '从场景删除': 'Delete from Scene',
  '仰角': 'Elevation',
  '会被采纳进 T-pose；': 'gets adopted into the T-pose; ',
  '位置 local': 'Position (local)',
  '侧视 Side · (z, y)': 'Side View · (z, y)',
  '保存': 'Save',
  '保存绑定': 'Save Binding',
  '偏移 Offset（沿骨局部轴，米）': 'Offset (along bone local axis, meters)',
  '偏移归零': 'Zero Offset',
  '偏移归零：包裹器回到骨段原位': 'Zero offset: wrapper returns to the bone segment',
  '停止': 'Stop',
  '先在正/侧视图里点选一段包裹器，才能镜像到对侧': 'Select a wrapper in the front/side view first, then mirror it to the other side',
  '全部': 'All',
  '关卡灯光预设': 'Level Lighting Presets',
  '关闭绑定面板': 'Close binding panel',
  '分阶 ID': 'Band ID',
  '分阶阈值': 'Band Thresholds',
  '包含': 'Contains',
  '包裹体 Wrapper': 'Wrapper',
  '包裹器': 'Wrapper',
  '半径': 'Radius',
  '半调倍率': 'Halftone Gain',
  '半调网点': 'Halftone Dots',
  '取消当前骨的手动标记，交还给自动适配': 'Clear this bone\'s manual pin and hand it back to auto-fit',
  '取消选择': 'Deselect',
  '只是当前姿态与 T-pose 的差，': 'is only the delta between the current pose and the T-pose, ',
  '右侧 R': 'Right R',
  '后处理': 'Post-FX',
  '后处理豁免': 'Post-FX Exempt',
  '启用 Bloom': 'Enable Bloom',
  '启用 Grading': 'Enable Grading',
  '启用描边': 'Enable Outline',
  '启用点光': 'Enable Point Light',
  '启用网点': 'Enable Dots',
  '回到冻结的 Bind Pose（带 offset 的绑定姿态，可随时重绑）': 'Return to the frozen Bind Pose (binding pose with offset; rebind anytime)',
  '回到模板 T-pose 的初始摆放（会清空全部关节编辑，有二次确认）': 'Reset to the template T-pose placement (clears all joint edits, asks twice)',
  '圆柱（emissive）': 'Cylinder (emissive)',
  '包裹器 proxy 体积总开关：主 3D 视口与面板正/侧视同时生效（关掉 = 干净的网格+骨架视图，便于视觉对位）；数据保留，重新勾选即恢复': 'Wrapper proxy master toggle: applies to both the main 3D viewport and the panel front/side views (off = clean mesh+skeleton view for visual alignment); data is kept, re-check to restore',
  '在视图里点中包裹器后：拖': 'After picking a wrapper in the view: drag ',
  '地面': 'Ground',
  '地面反弹色': 'Ground Bounce Color',
  '地面强度': 'Ground Intensity',
  '场景角色（程序化胶囊）': 'Scene Character (procedural capsule)',
  '场景里没有对象。': 'No objects in the scene.',
  '天空强度': 'Sky Intensity',
  '天空色': 'Sky Color',
  '姿势': 'Pose',
  '姿势变形测试：拖 joint 摆出任意姿势，网格按当前权重实时蒙皮变形（改的是测试骨架快照，编辑骨架不动；切走即丢弃）': 'Pose deform test: drag joints into any pose and the mesh skin-deforms live with current weights (edits a test skeleton snapshot; the edit skeleton is untouched; discarded on leave)',
  '姿态': 'Pose',
  '姿态预览': 'Pose Preview',
  '实例名': 'Instance Name',
  '对象选择与变换': 'Selection & Transform',
  '导入 GLB…': 'Import GLB…',
  '导出动画 GLB': 'Export Animation GLB',
  '尺寸': 'Dimensions',
  '局部点光（调试用；位置取场景 Light 节点的世界坐标）': 'Local Point Light (debug; position from the scene Light node\'s world transform)',
  '屏幕空间恒定补偿': 'Screen-Space Constant Compensation',
  '展开 / 收起操作说明': 'Expand / collapse instructions',
  '属性': 'Properties',
  '左侧 L': 'Left L',
  '已复制 ✓': 'Copied ✓',
  '已自动创建覆盖：你的改动只作用于这条 mesh，共享材质未被改动。': 'Override auto-created: your change affects only this mesh; the shared material is untouched.',
  '已选对象': 'Selected Object',
  '常数环境': 'Constant Ambient',
  '平滑迭代 / 强度 λ': 'Smooth Iterations / Strength λ',
  '平滑迭代次数（1..12，默认 4）。越大晕得越开，apply 时耗时线性增长': 'Smoothing iterations (1..12, default 4). Higher = blurrier; apply time grows linearly',
  '强度': 'Intensity',
  '当前': 'Current',
  '当前编辑姿态（可拖拽）': 'Current edit pose (draggable)',
  '微调（Shift 5mm）。': ' fine step (Shift = 5mm).',
  '扩散强度 λ（0..1，默认 0.5）。每轮迭代向邻居均值靠近的比例，越大越糊': 'Diffusion strength λ (0..1, default 0.5). Fraction pulled toward the neighbor average each iteration; higher = blurrier',
  '把 T-pose 网格 + 骨骼 + 已重定向的动画一起导出 GLB（需要先载入 BVH）': 'Export the T-pose mesh + skeleton + retargeted animation as GLB (load a BVH first)',
  '把右侧关节与 Skin Wrapper 半径一并镜像到左侧（x 取反）': 'Mirror right-side joints and Skin Wrapper radii to the left (negate x)',
  '把左侧关节与 Skin Wrapper 半径一并镜像到右侧（x 取反）': 'Mirror left-side joints and Skin Wrapper radii to the right (negate x)',
  '把当前骨架摆位与 Skin Wrapper 半径存回 <mesh>.meta.json（仅资产库入口有路径时可用）': 'Save the current skeleton placement and Skin Wrapper radii back to <mesh>.meta.json (only available from the asset library entry)',
  '把未手动改过的骨半径重算为「骨长 ×0.35」；手动调过的骨不碰': 'Recompute untouched bone radii as bone length × 0.35; manually adjusted bones are left alone',
  '把网格重姿态为标准 A-pose 并叠加参考骨架': 'Repose the mesh to the standard A-pose with reference skeleton overlay',
  '把网格重姿态为标准 T-pose 并叠加参考骨架': 'Repose the mesh to the standard T-pose with reference skeleton overlay',
  '拖拽下压面板，露出上方 3D 视图对照': 'Drag to shrink the panel and expose the 3D view above',
  '描边 mask': 'Outline Mask',
  '描边倍率': 'Outline Gain',
  '描边色（禁止纯黑）': 'Outline Color (no pure black)',
  '描边（inverted hull）': 'Outline (inverted hull)',
  '播放': 'Play',
  '整体材质（所有 mesh）': 'Overall Material (all meshes)',
  '方位角': 'Azimuth',
  '方向偏移': 'Direction Offset',
  '方向键': 'Arrow Keys',
  '显示': 'Show',
  '暗角': 'Vignette',
  '暗部上界': 'Shadows Upper',
  '暗部亮度倍率': 'Shadows Brightness Gain',
  '暗部倍率': 'Shadows Gain',
  '暗部染紫蓝': 'Shadows Purple-Blue Tint',
  '暗部染色比例': 'Shadows Tint Amount',
  '暗部染色（night-deep）': 'Shadows Tint (night-deep)',
  '暗部饱和度': 'Shadows Saturation',
  '曝光': 'Exposure',
  '最终画面': 'Final Image',
  '未加载模型': 'No model loaded',
  '未载入动画': 'No animation loaded',
  '未选中圆柱体 · 在视图中点选一段': 'No cylinder selected · pick one in a view',
  '权重热力图：选中一根骨（joint 或包裹器）后，网格顶点按该骨的权重着色（蓝=无影响 → 红=全权重），与 Bind Skin 导出的权重同源': 'Weight heatmap: with a bone selected (joint or wrapper), mesh vertices are colored by that bone\'s weight (blue = none → red = full), same weights Bind Skin exports',
  '权重算法': 'Weight Algorithm',
  '材质（共享材质库）': 'Material (shared library)',
  '核心': 'Core',
  '模型预览': 'Model Preview',
  '正视 Front · (x, y)': 'Front View · (x, y)',
  '段间过渡': 'Inter-Band Transition',
  '滑块与数字框双向同步；方向键微调，': 'Slider and number box are two-way synced; arrow keys for fine steps, ',
  '灯光贡献分解': 'Light Contribution Breakdown',
  '点击场景中的物体（角色 / 敌人 / 道具）进行选择。地面不可选。': 'Click an object in the scene (character / enemy / prop) to select it. The ground is not selectable.',
  '热力图': 'Heatmap',
  '热扩散松弛参数（旧评审 §2.4：默认 2 次只能扩散 ~2 环顶点，15k 面角色关节处仍有折角）': 'Heat-diffusion relaxation (prior review §2.4: default 2 iterations only reach ~2 rings of vertices; creases remain at joints on 15k-tri characters)',
  '父骨': 'Parent Bone',
  '环境强度': 'Ambient Intensity',
  '球体（skin）': 'Sphere (skin)',
  '用当前编辑姿态（带 offset）做绑定并导出；同时把此姿态冻结记录为 Bind Pose': 'Bind and export with the current edit pose (offset included); the pose is also frozen as the Bind Pose',
  '相机俯仰': 'Camera Pitch',
  '移除已应用的皮肤结果，但保留 Bind Pose 与关节编辑（有二次确认）': 'Remove the applied skin result but keep the Bind Pose and joint edits (asks twice)',
  '立方体（metal）': 'Cube (metal)',
  '类型': 'Type',
  '粗糙度': 'Roughness',
  '线宽（px @1080p）': 'Line Width (px @1080p)',
  '绑定': 'Binding',
  '给该物体所有 mesh 换成同一个共享材质，并清空各自的局部覆盖。要单独调某条 mesh，用上面的「Mesh 材质」面板。': 'Assign one shared material to every mesh of this object and clear per-mesh overrides. To tune a single mesh, use the Mesh Material panel above.',
  '编辑': 'Edit',
  '编辑器当前只支持 .glb 拖入场景；该格式请先转换': 'The editor only supports dragging .glb into the scene; convert this format first',
  '编辑目标': 'Edit Target',
  '网点尺寸（px）': 'Dot Size (px)',
  '胶囊（cloth）': 'Capsule (cloth)',
  '自动环绕': 'Auto Orbit',
  '自动适配半径': 'Auto-fit Radii',
  '自发光强度': 'Emissive Intensity',
  '自发光颜色': 'Emissive Color',
  '角色模型': 'Character Model',
  '角色（中心胶囊）': 'Character (center capsule)',
  '解析失败': 'Parse failed',
  '解析模型中…': 'Parsing model…',
  '调试视图': 'Debug View',
  '调试视图与相机': 'Debug View & Camera',
  '资产': 'Asset',
  '距离衰减': 'Distance Falloff',
  '路径': 'Path',
  '软边倍率': 'Soft Edge Gain',
  '软边宽度': 'Soft Edge Width',
  '载入 BVH…': 'Load BVH…',
  '载入一份 BVH 动捕，重定向到当前 T-pose 骨架': 'Load a BVH mocap take and retarget it onto the current T-pose skeleton',
  '边缘': 'Edges',
  '选中一个 joint 查看骨长与姿态偏移': 'Select a joint to see bone length and pose offset',
  '选中带骨骼的模型后可用。无骨骼动画时控件灰显。': 'Available once a skinned model is selected. Controls are greyed out without skeletal animation.',
  '选择 Skeleton': 'Select Skeleton',
  '选择 Skin Wrapper': 'Select Skin Wrapper',
  '选择并编辑 27 关节（22 骨干 + 5 tip）：拖拽对齐模型解剖位置': 'Select and edit 27 joints (22 bones + 5 tips): drag to align with the model\'s anatomy',
  '选择并编辑蒙皮包裹圆柱体 Skin Wrapper（整段 wrapper = 一根骨，top/medium/bottom 只调三个半径）': 'Select and edit Skin Wrapper cylinders (one wrapper = one bone; top/medium/bottom are just three radii)',
  '采纳': 'adopted',
  '重置': 'Reset',
  '重置此骨为自动': 'Reset Bone to Auto',
  '金属度': 'Metalness',
  '锁定横/纵主轴；': 'locks the horizontal/vertical primary axis; ',
  '锐度（power）': 'Sharpness (power)',
  '镜像': 'Mirror',
  '镜像 L→R': 'Mirror L→R',
  '镜像 R→L': 'Mirror R→L',
  '镜像全部 L→R': 'Mirror All L→R',
  '镜像此圆柱 → 对侧': 'Mirror This Cylinder → Other Side',
  '隐藏 / 仅显某侧关节与 Skin Wrapper（左右都含包裹器）': 'Hide / show only one side of joints and Skin Wrappers (wrappers included on both sides)',
  '隐藏右': 'Hide Right',
  '隐藏左': 'Hide Left',
  '雾密度': 'Fog Density',
  '雾颜色': 'Fog Color',
  '顶边缘偏置': 'Top Edge Bias',
  '颜色': 'Color',
  '骨长': 'Bone Length',
  '高光下界': 'Highlights Lower',
  '高光混色': 'Highlights Tint',
  '高光混色比例': 'Highlights Tint Amount',
  '高光混色（bone）': 'Highlights Tint (bone)',

  // ---- main.ts 高频交互文案 ----
  '进入绑定': 'Enter Binding',
  '进入绑定（物体不存在）': 'Enter Binding (object missing)',
  '继续': 'Resume',
  '已暂停': 'Paused',
  '暂停': 'Pause',
  'Play 中不能替换模型（Stop 后无法恢复原网格），先 Stop': 'Cannot swap models during Play (Stop cannot restore the original mesh) - Stop first',
  '程序化胶囊 · 材质在「材质」面板调': 'Procedural capsule · tune the material in the Material panel',
  '未载入模型 · 用「导入 GLB…」载入原始 .glb': 'No model loaded · use Import GLB… to load a raw .glb',
  'Play 中不能导入 / 生成资产，先 Stop': 'Cannot import / spawn assets during Play - Stop first',
  '场景物体已达上限（64），先在层级里删掉一些再拖入': 'Scene object limit reached (64) - delete some in the hierarchy before dragging in',
  '请先在底部资产库选中一个 .glb 模型，或右键场景物体 → 进入绑定': 'Select a .glb model in the asset library below, or right-click a scene object → Enter Binding',
  '只有 .glb 模型能拖入场景（其他资产在右侧 Inspector 里预览）': 'Only .glb models can be dragged into the scene (preview other assets in the right Inspector)',

  // ---- 重定向工作台 ----
  '地面接触：先载入动作': 'Ground contact: load a motion first',
  '生成预览': 'Generate Preview',
  '载入动作 (BVH)…': 'Load Motion (BVH)…',

  '◀ 问题帧': '◀ Problem Frame',
  '先载入或设置标定后再保存': 'Load or set the calibration before saving',
  '动作适配': 'Motion Adaptation',
  '地面接触：不可用（源无世界轨迹）': 'Ground contact: unavailable (source has no world trajectory)',
  '地面接触：仅相位指导（原地 / 无可信轨迹，不做世界锁脚）': 'Ground contact: phase guidance only (in-place / no trusted trajectory, no world lock)',
  '地面接触：已启用世界锁脚（支撑段锚定）': 'Ground contact: world foot-lock enabled (stance anchoring)',
};



