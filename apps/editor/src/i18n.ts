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
  '在主 3D 视口里把每个 joint 的包裹圆柱体画到模型上（半透明 X-ray，不会被模型挡住），并随骨骼动画实时更新': 'Draw each joint\'s wrapper cylinder onto the model in the main 3D viewport (translucent X-ray, never hidden by the mesh), updating live with skeletal animation',
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

};



