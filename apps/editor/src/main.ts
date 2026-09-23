import { GpuUnavailableError, initGpu, type GpuContext } from '@aether/gfx';
import { LabRenderer, type CameraState, type SceneObject } from './renderer';
import { Panel } from './ui';
import * as m4 from '@aether/core';
import { axisPlaneNormal, rotatePlaneBasis, angleInPlane, wrapAngle } from './gizmo';
import { DEBUG_OPTIONS, type LabParams } from './params';
import { BUILTIN_MODELS, MODEL_RULER_HEIGHT_M } from './models';
import { parseGlb, validateAssetMeta, SceneGraph, worldToLocalTransform, identityTransform } from '@aether/scene';
import type { EditorCameraData, EnvironmentData, GltfResult, SceneDocument, NodeId, TransformData } from '@aether/scene';
import {
  PlaySession,
  SpawnEditStore,
  captureInitialScatter,
  compareScatter,
  describeDelta,
  listSpawnPoints,
  sceneFingerprint,
  formatAuthorEdit,
  findNode,
} from '@aether/runtime';
import type { ScatterComparison, ScatterFingerprint, TransformValues } from '@aether/runtime';
import { SpawnPanel } from './services/spawn-panel';
import { AssetBrowser } from './asset-browser';
import { AssetInspector } from './asset-inspector';
import { AssetPreview } from './services/asset-preview';
import { resolveStartScenePath } from './scene-boot';
import { RuntimeBridge } from './services/runtime-bridge';
import { PlayController } from './services/play-controller';
import { BindingPanel } from './services/binding/binding-panel';
import { buildCylinderOverlay } from './services/binding/cylinder-overlay';
import { rigToTPoseWithImage, downloadBlob } from './services/binding/binding-export';
import type { BindAnimationInput, BindExportStats } from './services/binding/binding-export';
import type { FitResult, JointPositions } from './services/binding/binding-math';
import { skeletonPositionsFromGltf } from './services/binding/import-skeleton';
import type { SkeletonImportResult } from './services/binding/import-skeleton';
import {
  ASSET_MIME,
  stemName,
  readProjectFile,
  writeProjectFile,
  copyText,
  fetchAssetInfo,
  renameProjectEntry,
  revealInFileManager,
  type AssetSelection,
} from './asset-util';
import { makeSplitter, restoreCssVar } from './splitter';
import { summarizeMatch, createSkinState, selectClip, play, pause, seek } from '@aether/render';
import { parseBvh } from './services/binding/bvh-parser';
import {
  retargetBvh,
  retargetSummary,
  clipToAnimClip,
  skeletonRestWorldPositions,
  type RetargetReport,
  type RetargetOptions,
} from './services/binding/retarget';
import {
  RetargetSession,
  type RetargetAnimPayload,
  type RetargetSidecarStore,
} from './services/binding/retarget-session';
import {
  RetargetWorkbench,
  type RetargetWorkbenchState,
} from './services/binding/retarget-workbench';

/**
 * Game Editor 入口（原 Shader Lab）。
 *
 * 相机默认 55° 俯角 —— 项目里 god view 就是 55°，所有灯光参数都该在这个角度下调。
 * 相机操作（鼠标与触屏同一套 Pointer Events，canvas 已 touch-action:none）：
 *   环绕 rotate：左键拖 / 单指拖
 *   平移 pan：  右键或中键拖、Shift+左键拖 / 双指拖（质心）
 *   缩放 zoom：滚轮 / 双指捏合
 *   拾取：      左键或单指轻点（位移 < 6px 判定为点击）
 */

const canvas = document.getElementById('gpu') as HTMLCanvasElement | null;
const groups = document.getElementById('groups');
const hud = document.getElementById('hud');
const fatal = document.getElementById('fatal');
const fatalTitle = document.getElementById('fatal-title');
const fatalBody = document.getElementById('fatal-body');

function showFatal(title: string, bodyHtml: string): void {
  if (fatal === null || fatalTitle === null || fatalBody === null) return;
  fatalTitle.textContent = title;
  fatalBody.innerHTML = bodyHtml;
  fatal.style.display = 'flex';
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function dpr(): number {
  return Math.min(2, window.devicePixelRatio || 1);
}

async function tryInitGpu(target: HTMLCanvasElement): Promise<GpuContext | null> {
  try {
    return await initGpu(target);
  } catch (err) {
    if (err instanceof GpuUnavailableError) {
      showFatal(err.message, `<p>${err.detail}</p>`);
    } else {
      showFatal('WebGPU 初始化失败', `<p>${String(err)}</p>`);
    }
    return null;
  }
}

/** 面向相机的竖直面上的 NdotL —— god view 下这是角色最常露给玩家的那一面 */
function frontNdotL(p: LabParams, camera: CameraState): number {
  const az = (p.keyAzimuth * Math.PI) / 180;
  const el = (p.keyElevation * Math.PI) / 180;
  const lx = Math.sin(az) * Math.cos(el);
  const lz = Math.cos(az) * Math.cos(el);
  // 相机位于 target + (sin yaw, ·, cos yaw) * r，所以朝相机的面法线就是这个方向
  return Math.max(0, Math.sin(camera.yaw) * lx + Math.cos(camera.yaw) * lz);
}

async function boot(): Promise<void> {
  if (canvas === null || groups === null || hud === null) {
    showFatal('页面结构异常', '缺少 #gpu / #groups / #hud 节点。');
    return;
  }

  const gpu = await tryInitGpu(canvas);
  if (gpu === null) return;

  // 只展示第一个错误：后续每一帧都会因同一个原因报错，级联信息会把真正的源头冲掉
  let fatalShown = false;
  gpu.device.onuncapturederror = (event) => {
    console.error(`[WebGPU] ${event.error.message}`);
    if (fatalShown) return;
    fatalShown = true;
    showFatal(
      '渲染管线错误',
      `<p>${event.error.message}</p><p>通常是 WGSL 编译失败或 bind group 布局不匹配，完整日志见控制台。</p>`,
    );
  };

  let renderer: LabRenderer;
  try {
    renderer = new LabRenderer(gpu, canvas);
  } catch (err) {
    showFatal('渲染器创建失败', `<p>${String(err)}</p>`);
    return;
  }

  const inspPanes = {
    inspector: document.querySelector<HTMLElement>('#inspector .insp-pane[data-pane="inspector"]')!,
    scene: document.querySelector<HTMLElement>('#inspector .insp-pane[data-pane="scene"]')!,
    render: document.querySelector<HTMLElement>('#inspector .insp-pane[data-pane="render"]')!,
  };
  const panel = new Panel(groups, inspPanes, renderer);
  // 材质 API 要按 id 回查共享材质（params.materials），先把引用挂上
  renderer.attachParams(panel.params);

  /**
   * 运行时桥（WU-3）：headless 会话与渲染之间的**唯一**翻译层。
   * 它不产玩法，只把实体视图翻译成实例批次；真模型接进来后换代理网格即可。
   */
  const bridge = new RuntimeBridge();

  /**
   * Play 控制器（WU-4）：只做装配 —— 快照/恢复作者态、把推进同步给 Bridge、
   * 通知 UI。状态机本体在 `PlaySession`（runtime 包，纯 CPU 可测）。
   *
   * 这里**不自动进入 Play**：编辑器打开就该是编辑态，跑起来要用户显式点 ——
   * 否则每次改完参数刷新页面都会被"已经在跑的世界"干扰判断。
   */
  const playCtl = new PlayController(renderer, bridge, {
    onStateChange: () => {
      syncPlayButtons();
      refreshSpawnPanel(); // 面板里的实体区与「重跑」可用性都随播放状态变
      hudDirty = true;
    },
  });

  // ---- Play 控制按钮（装配层：只负责按钮 → 控制器，无玩法逻辑）----
  const btnPlay = document.querySelector<HTMLButtonElement>('#btn-play');
  const btnPause = document.querySelector<HTMLButtonElement>('#btn-pause');
  const btnStep = document.querySelector<HTMLButtonElement>('#btn-step');
  const btnReset = document.querySelector<HTMLButtonElement>('#btn-reset');
  const btnStop = document.querySelector<HTMLButtonElement>('#btn-stop');

  /**
   * 启动一个新会话（**所有入口共用**）。
   *
   * 🔴 每一次新会话都是一个新的世界：诊断去重集合必须随之清空，否则第二轮
   * Play 里同类的"容量不足"告警会被上一轮的记录吞掉。清理要归会话生命周期
   * 统一管理（复审 #8），不能在按钮里各写一份 —— 漏一个入口就是吞一类告警。
   */
  function startPlay(): boolean {
    const ok = playCtl.start();
    if (ok) shownRuntimeDiags.clear();
    return ok;
  }

  /** 同种子重跑（**所有入口共用**）：runId 换代，去重集合同样要清空 */
  function resetPlay(): void {
    playCtl.reset();
    shownRuntimeDiags.clear();
  }

  btnPlay?.addEventListener('click', () => {
    if (playCtl.state === 'stopped') {
      if (!startPlay()) {
        // 启动失败：不动作者状态，只提示。错误原因由 HUD 显示
        console.warn(`[play] 启动失败：${playCtl.error ?? '未知'}`);
        hudDirty = true;
      }
    } else playCtl.togglePause();
  });
  btnPause?.addEventListener('click', () => playCtl.togglePause());
  btnStep?.addEventListener('click', () => playCtl.step());
  btnReset?.addEventListener('click', () => resetPlay());

  /**
   * 取走并展示运行期诊断（容量不足整批拒绝等）。
   *
   * 信号产出之后**必须有消费者**：否则 diagnostic 写了一整套，UI 上依旧一片寂静，
   * 等于没写。去重由 `pushDiag`（同 code+node 只记一次）与这里的一次性展示共同保证 ——
   * 每帧刷同一条告警会把真正重要的那条冲掉（WebGPU 错误那条踩过同样的坑）。
   */
  const shownRuntimeDiags = new Set<string>();
  function drainRuntimeDiagnostics(): void {
    for (const d of playCtl.runtimeDiagnostics) {
      const key = `${d.code}|${d.nodeId ?? ''}`;
      if (shownRuntimeDiags.has(key)) continue;
      shownRuntimeDiags.add(key);
      console.warn(`[runtime] ${d.code}: ${d.message}`);
      spawnMsg = { text: `运行告警：${d.message}`, kind: 'warn' };
      refreshSpawnPanel();
      hudDirty = true;
    }
  }
  // stopPlay 而不是 playCtl.stop()：退出 Play 后要顺带定位到选中实体的来源刷怪点
  btnStop?.addEventListener('click', () => stopPlay());

  /** 按钮的启用/高亮完全由 PlayController 的状态推导，不自己存第二份状态 */
  function syncPlayButtons(): void {
    const st = playCtl.state;
    const playing = st !== 'stopped';
    if (btnPlay !== null) {
      btnPlay.classList.toggle('active', playing);
      btnPlay.textContent = st === 'paused' ? '▶ 继续' : '▶ Play';
    }
    if (btnPause !== null) {
      btnPause.disabled = !playing;
      btnPause.classList.toggle('active', st === 'paused');
      btnPause.textContent = st === 'paused' ? '⏸ 已暂停' : '⏸ 暂停';
    }
    if (btnStep !== null) btnStep.disabled = st !== 'paused';
    if (btnReset !== null) btnReset.disabled = !playing;
    if (btnStop !== null) btnStop.disabled = !playing;
  }
  syncPlayButtons();

  // ---- 场景加载（ADR-010：场景是唯一数据载体；ADR-015：项目容器是路径锚点）----
  // 构造期那组硬编码物体只是 fallback，真内容从这里读。失败不阻断启动：
  // 控制台告警 + 保留 fallback 场景 —— 场景文件坏了不该让编辑器起不来。
  // boot 依赖 camera / hudDirty（定义在后），实际执行挪到 __editor 钩子接线之后。

  /** 右侧 Inspector Tab 切换：选中场景物体→检视，选中资产→资产 */
  const switchInspectorTab = (tab: 'inspector' | 'scene' | 'render' | 'asset' | 'spawn'): void => {
    for (const t of document.querySelectorAll<HTMLElement>('#inspector .insp-tab')) {
      t.classList.toggle('active', t.dataset.tab === tab);
    }
    for (const p of document.querySelectorAll<HTMLElement>('#inspector .insp-pane')) {
      p.classList.toggle('active', p.dataset.pane === tab);
    }
  };
  // 标签页本身可点击切换：让「场景/光照」「渲染」页可达（默认只随选中物体/资产自动切）。
  for (const t of document.querySelectorAll<HTMLButtonElement>('#inspector .insp-tab')) {
    t.addEventListener('click', () => {
      const tab = t.dataset.tab;
      if (tab === 'inspector' || tab === 'scene' || tab === 'render' || tab === 'asset' || tab === 'spawn') {
        switchInspectorTab(tab);
      }
    });
  }
  let hudDirty = true;
  panel.onChange = () => {
    hudDirty = true;
  };

  // ---- 模型浏览器 ----
  /**
   * 贴图解码。两个要点：
   *   - colorSpaceConversion:'none'：着色器把 albedo 当 raw sRGB 自己转 linear（见 renderer 注释），
   *     让浏览器再做一次色彩管理会把混元偏暗的 baseColor 压得更暗。
   *   - 超大贴图降采样：4096² 原图解码后 67MB，编辑器预览没必要吃满显存，按长边缩到 2048。
   */
  const MAX_TEX_SIZE = 2048;
  async function decodeTexture(blob: Blob, label: string): Promise<ImageBitmap | null> {
    try {
      const raw = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
      const long = Math.max(raw.width, raw.height);
      if (long <= MAX_TEX_SIZE) return raw;
      const k = MAX_TEX_SIZE / long;
      const w = Math.max(1, Math.round(raw.width * k));
      const h = Math.max(1, Math.round(raw.height * k));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (ctx === null) return raw; // 没有 2D 上下文就原样用，不为了省显存牺牲可用性
      ctx.drawImage(raw, 0, 0, w, h);
      raw.close();
      return canvas.transferToImageBitmap();
    } catch (err) {
      console.warn(`[模型] 贴图解码失败: ${label}`, err);
      return null;
    }
  }

  async function loadBitmap(url: string): Promise<ImageBitmap | null> {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      return await decodeTexture(await resp.blob(), url);
    } catch (err) {
      console.warn(`[模型] 贴图加载失败: ${url}`, err);
      return null;
    }
  }

  /**
   * 模型替换的统一边界（复审 P1）。
   *
   * Play 中替换网格 = 改变对象的可序列化状态（快照只存变换/显隐/材质，**不存网格与骨架**），
   * Stop 后恢复不回来 —— 原网格就这么没了。与增删同一约束：所有模型修改入口
   * （内置下拉、文件导入、及其异步完成路径）都走这一个判定点。
   */
  function modelReplaceBlocked(): boolean {
    if (!playCtl.isPlaying) return false;
    console.warn('[play] Play 中禁止替换模型（快照不存网格/骨架，Stop 后无法恢复；先 Stop 再换）');
    panel.setModelInfo('Play 中不能替换模型（Stop 后无法恢复原网格），先 Stop');
    hudDirty = true;
    return true;
  }

  function applyBuiltin(id: string): void {
    if (modelReplaceBlocked()) return;
    const bm = BUILTIN_MODELS.find((b) => b.id === id);
    if (bm === undefined) return;
    void loadBitmap(bm.texUrl).then((bmp) => {
      // 异步完成路径：贴图解码期间用户可能按了 Play —— 同样不能换
      if (modelReplaceBlocked()) return;
      renderer.setCharacter(bm.mesh, bmp, null);
      panel.setModelInfo(
        `${bm.label} · ${bm.meta.vertices} 顶点 / ${bm.meta.triangles} 面 / ` +
          `${bm.meta.heightMeters} m / 贴图${bmp !== null ? '已载入' : '缺失（平色预览）'}`,
      );
      panel.refreshHierarchy(); // 角色槽位的面数变了
      panel.setSelection(renderer.getSelected(), renderer.getSelectedSub());
      hudDirty = true;
    });
  }

  panel.onModelSelect = (id) => {
    if (modelReplaceBlocked()) return;
    if (id === null) {
      renderer.setCharacter(null, null);
      panel.setModelInfo('程序化胶囊 · 材质在「材质」面板调');
      hudDirty = true;
      return;
    }
    applyBuiltin(id);
  };

  // ---- 场景层级 Hierarchy ----
  // 点到 mesh 子节点时连子网格一起选中：材质面板的作用对象就是它，描边也只描那一段
  panel.onHierarchySelect = (index, subIndex) => {
    renderer.selectObject(index, subIndex);
    panel.setSelection(index, subIndex);
    switchInspectorTab('inspector');
    hudDirty = true;
  };
  panel.onHierarchyToggle = (index, visible) => {
    renderer.setObjectVisible(index, visible);
    panel.setSelection(renderer.getSelected(), renderer.getSelectedSub()); // 隐藏被选中的物体时同步清掉选中面板
    hudDirty = true;
  };
  panel.onSubMeshToggle = (index, subIndex, visible) => {
    renderer.setSubMeshVisible(index, subIndex, visible);
    // 隐藏的正好是当前材质面板的目标时，渲染器已把选中退回物体层，这里同步面板
    panel.setSelection(renderer.getSelected(), renderer.getSelectedSub());
    hudDirty = true;
  };
  panel.onHierarchyDelete = (index) => {
    // Play 中禁止增删（同 Delete 键）：作者状态按索引恢复，物体数变了就会张冠李戴
    if (playCtl.isPlaying) {
      console.warn('[play] Play 中禁止删除物体（Stop 后作者状态按索引恢复，数量必须一致）');
      hudDirty = true;
      return;
    }
    renderer.removeObject(index);
    panel.setSelection(renderer.getSelected(), renderer.getSelectedSub());
    panel.refreshHierarchy();
    hudDirty = true;
  };
  // 悬停只改渲染器的索引（复用已有 outline 管线多 1 个 draw call），不重建 UI、不遍历场景
  panel.onHierarchyHover = (index, subIndex) => {
    renderer.setHovered(index, subIndex);
    hudDirty = true;
  };
  // 双击层级行 = 选中 + 相机聚焦过去
  panel.onHierarchyFocus = (index) => {
    renderer.selectObject(index, null);
    panel.setSelection(index, null);
    focusOn(index);
    hudDirty = true;
  };

  panel.onModelFile = (buffer, name) => {
    if (modelReplaceBlocked()) return;
    try {
      // 身高用与内置 LOD 同一把尺子（roster 真源），保证导入档与内置档体型一致
      const model = parseGlb(buffer, MODEL_RULER_HEIGHT_M);
      void (async () => {
        const bmp = model.image === null ? null : await decodeTexture(model.image, name);
        // 异步完成路径：贴图解码期间用户可能按了 Play —— 同样不能换
        if (modelReplaceBlocked()) return;
        // subMeshes：GLB 的每个 primitive 拆成一条子网格 → 层级树里可展开、各自一个材质槽；
        // nodeTree：GLB 原始父子层级，层级面板按它还原树形（不再平铺）
        renderer.setCharacter(model.mesh, bmp, model.subMeshes, model.nodeTree, model.skeleton, model.animations);
        const texState =
          model.image === null
            ? '无贴图（平色预览）'
            : bmp !== null
              ? '贴图已载入'
              : '⚠ 贴图解码失败（见控制台）';
        // 换模型时旧材质绑定按「nodeId → 反向路径」两层匹配继承，结果一并告知
        const inheritNote = summarizeMatch(renderer.getLastMatchReport() ?? []);
        panel.setModelInfo(
          `${name} · ${model.vertices} 顶点 / ${model.triangles} 面 / ` +
            `${model.heightMeters.toFixed(2)} m / ${texState}` +
            (inheritNote === null ? '' : ` · ${inheritNote}`),
        );
        panel.refreshHierarchy(); // 导入模型替换了角色槽位，面数与子网格都变了
        // 选中可能落在旧的（现已不存在的）子网格上，重挂一次
        panel.setSelection(renderer.getSelected(), renderer.getSelectedSub());
        hudDirty = true;
      })();
    } catch (err) {
      panel.setModelInfo(`导入失败：${String(err)}`);
      console.error('[模型] GLB 导入失败', err);
    }
  };

  // 不再默认加载任何内置模型：E-04 内置档（LOD 中间产物）已全部移除，
  // 启动即为程序化胶囊，角色一律通过「导入 GLB…」载入原始模型（唯一真源）。
  panel.setModelInfo('未载入模型 · 用「导入 GLB…」载入原始 .glb');

  // 默认取景：target 落在角色身上才能居中构图，而不是看向角色前方的空地
  const DEFAULT_VIEW = { yaw: 0.35, distance: 9, target: [0, 0.95, 0] as [number, number, number] };
  const camera: CameraState = {
    yaw: DEFAULT_VIEW.yaw,
    distance: DEFAULT_VIEW.distance,
    target: [...DEFAULT_VIEW.target],
  };

  // 调试/自动化钩子：控制台与无头 CDP 验证直接读写相机/材质状态（都是引用，读到即实时值）
  (window as unknown as { __editor: unknown }).__editor = {
    camera,
    elevation: () => panel.params.cameraElevation,
    params: panel.params,
    renderer,
    /**
     * 视口变换写回的**可验证面**（复审 B1；冒烟脚本用：找手柄 → 真事件链拖 → 查文档/撤销）。
     *
     * `worldPosFromDoc` 刻意**独立**于渲染物体与拖拽数学：它从文档重新建图解算世界位置。
     * 于是「视口位置 == 从文档重算的世界位置」这个断言能真正抓出
     * 「世界值当局部值写进文件」这类错（局部与世界相差一个父偏移时就露馅）。
     */
    viewportEdit: {
      hitTest: (x: number, y: number) => hitTestGizmo(x, y),
      worldPosFromDoc: (nodeId: string) => {
        if (spawnStore === null) return null;
        const g = SceneGraph.fromDocument(spawnStore.document);
        g.updateWorldTransforms();
        const n = g.getNode(nodeId);
        return n === null ? null : [n.world.position[0], n.world.position[1], n.world.position[2]];
      },
      localPos: (nodeId: string) => {
        if (spawnStore === null) return null;
        const n = findNode(spawnStore.document, nodeId);
        return n === null ? null : [...n.transform.position];
      },
      /** 从文档重算的**世界**四元数（转向 gizmo 的写回判据：视口 quat == 它） */
      quatOfDoc: (nodeId: string) => {
        if (spawnStore === null) return null;
        const g = SceneGraph.fromDocument(spawnStore.document);
        g.updateWorldTransforms();
        const n = g.getNode(nodeId);
        return n === null
          ? null
          : [n.world.rotation[0], n.world.rotation[1], n.world.rotation[2], n.world.rotation[3]];
      },
      /** 文档里某节点的子节点 id 列表（冒烟用它挑"有可渲染子节点的父节点"来拖） */
      childIds: (nodeId: string) => {
        if (spawnStore === null) return null;
        const g = SceneGraph.fromDocument(spawnStore.document);
        return g.childrenOf(nodeId);
      },
      state: () => ({ dirty: spawnStore?.dirty ?? false, undoDepth: spawnStore?.undoDepth ?? 0 }),
      undo: () => undoSpawnEdit(),
    },
  };

  // boot 场景加载：应用场景 editorCamera 到主视图 —— 关卡物件常在 x=0..70m，
  // 不应用的话相机停在 DEFAULT_VIEW（target 原点 distance 9），用户看到的是
  // 局部特写，会误以为"关卡没加载出来"。
  const applySceneCamera = (ec: EditorCameraData): void => {
    camera.target = [...ec.target] as [number, number, number];
    camera.distance = ec.distance;
    camera.yaw = ec.yaw;
    panel.params.cameraElevation = (ec.elevation * 180) / Math.PI;
    hudDirty = true;
  };

  // 场景环境 → 面板参数。环境是场景内容（docs/14 §14：每层主题一套 EnvironmentData），
  // 不应用的话火场/暗巷等主题环境全部失效，画面永远是编辑器默认的那套冷灰参数。
  // 覆盖的字段与 EnvironmentData 一一对应；key 方位角/仰角场景 schema 没有，保持编辑器值。
  const applySceneEnvironment = (env: EnvironmentData): void => {
    const p = panel.params;
    p.ambientColor = env.ambient.color;
    p.ambientIntensity = env.ambient.intensity;
    p.fillSkyColor = env.hemisphere.sky;
    p.fillSkyIntensity = env.hemisphere.skyIntensity;
    p.fillGroundColor = env.hemisphere.ground;
    p.fillGroundIntensity = env.hemisphere.groundIntensity;
    p.fogColor = env.fog.color;
    p.fogDensity = env.fog.density;
    p.rimColor = env.rim.color;
    p.rimIntensity = env.rim.intensity;
    p.rimPower = env.rim.power;
    p.rimTopBias = env.rim.topBias;
    p.exposure = env.exposure;
  };

  void (async () => {
    const start = await resolveStartScenePath();
    if (start.warning !== null) {
      console.warn(`[boot] 起始场景解析：${start.warning}，回落到 ${start.path}`);
    }
    const r = await renderer.loadScene(start.path);
    if (!r.ok) {
      console.warn(`[boot] 场景加载失败（${r.reason ?? '未知'}），保留硬编码 fallback 场景`);
      return;
    }
    for (const w of r.warnings ?? []) console.warn(`[boot] 场景告警：${w}`);
    console.info(
      `[boot] 场景已加载：${r.objects} 个物体（跳过 ${r.skipped ?? 0} 个非渲染节点），来自 ${start.path}`,
    );
    if (r.editorCamera !== undefined) applySceneCamera(r.editorCamera);
    // 环境与场景灯光写进面板（真源是场景文件，面板滑块是它的读写器），
    // syncAll 让「场景/光照」「渲染」页的控件立即反映覆盖后的值。
    if (r.environment !== undefined) applySceneEnvironment(r.environment);
    if (r.keyLight) {
      panel.params.keyColor = r.keyLight.color;
      panel.params.keyIntensity = r.keyLight.intensity;
    }
    // 点光同样来自场景（priority 最高的那一盏）。位置仍由引擎轨道驱动 —— 见已知遗留：
    // 场景 schema 有点光的 color/intensity/range，但没有位置字段。
    if (r.pointLight) {
      panel.params.pointColor = r.pointLight.color;
      panel.params.pointIntensity = r.pointLight.intensity;
      if (r.pointLight.range > 0) panel.params.pointRange = r.pointLight.range;
      // 位置同样来自场景（复审 B5）：过去引擎按固定轨道摆放，场景声明的位置被无视
      panel.params.pointPosition = [
        r.pointLight.position[0],
        r.pointLight.position[1],
        r.pointLight.position[2],
      ];
    }
    panel.syncAll();
    // WU-5：场景一载入就把作者文档交给 SpawnEditStore，之后它就是唯一真源
    setSpawnScene(renderer.getDocument());
    // ---- WU-4：不再自动进入 Play ----
    // 编辑器打开就该是编辑态。之前是"加载完场景就跑起来"，结果是每次刷新页面
    // 都被一个已经在动的世界干扰 —— 想安静看关卡反而要先点停止。
    // 现在由用户显式点 ▶（或空格）进入 Play，失败时 HUD 给出原因。
    hudDirty = true;
    // loadScene 是绕过 UI 的直接路径（构造期 fallback → 整体替换），
    // 不刷 Hierarchy 的话面板还显示构造时的 12 个 fallback 对象（陈旧快照）。
    panel.refreshHierarchy();
  })();

  // ---- 相机交互：环绕 / 平移 / 缩放 + 拾取 ----
  // 鼠标与触屏统一走 Pointer Events：单指=环绕，双指=捏合缩放+质心平移，
  // 右键/中键/Shift+左键=平移，滚轮=缩放，轻点（位移<阈值）=拾取。
  const CLICK_THRESHOLD = 6; // 像素：低于此位移视为「点击」而非「拖拽」
  const ORBIT_RAD_PER_PX = 0.006; // 环绕灵敏度：每像素多少弧度
  const PITCH_DEG_PER_PX = 0.25; // 俯仰灵敏度：每像素多少度
  const PITCH_LIMIT_DEG = 89; // 俯仰上限（留 1° 避免 lookAt 的 up 与视线平行退化）
  const PAN_LIMIT_XZ = 120; // 平移边界：target 的 X/Z 活动范围（米）。关卡跨度 ~76m（一层一关），20 会把用户困在第一个房间
  const PAN_MIN_Y = 0.05; // 平移边界：target 最低高度，避免钻到地面下
  const PAN_MAX_Y = 8;
  const ZOOM_MIN = 1.2;
  const ZOOM_MAX = 120; // 全览一层的距离（关卡 editorCamera.distance=62，40 会一滚轮就被拽回来）
  const FOVY = (45 * Math.PI) / 180; // 与 renderer.render 的 perspective 保持一致

  interface Ptr {
    x: number;
    y: number;
  }
  const pointers = new Map<number, Ptr>();
  let gesture: 'orbit' | 'pan' | 'pinch' | 'gizmo' = 'orbit';
  let lastX = 0;
  let lastY = 0;
  let downX = 0;
  let downY = 0;
  let downMoved = 0;
  let pinchDist = 0;

  // 把屏幕位移换算成 target 的世界位移：视角里一像素对应的世界尺寸随距离/视高变化，
  // 平移手感是「内容跟着手指走」。相机基与 orbitEye/lookAt 同约定：
  // right = (cos yaw, 0, -sin yaw)，up = (-sin yaw·sin el, cos el, -cos yaw·sin el)
  function panBy(dx: number, dy: number): void {
    const el = (panel.params.cameraElevation * Math.PI) / 180;
    const se = Math.sin(el);
    const ce = Math.cos(el);
    const sy = Math.sin(camera.yaw);
    const cy = Math.cos(camera.yaw);
    const worldPerPx =
      (2 * camera.distance * Math.tan(FOVY / 2)) / Math.max(1, canvas!.clientHeight);
    camera.target[0] = clamp(camera.target[0] + (-cy * dx - sy * se * dy) * worldPerPx, -PAN_LIMIT_XZ, PAN_LIMIT_XZ);
    camera.target[1] = clamp(camera.target[1] + ce * dy * worldPerPx, PAN_MIN_Y, PAN_MAX_Y);
    camera.target[2] = clamp(camera.target[2] + (sy * dx - cy * se * dy) * worldPerPx, -PAN_LIMIT_XZ, PAN_LIMIT_XZ);
    hudDirty = true;
  }

  function zoomBy(factor: number): void {
    camera.distance = clamp(camera.distance * factor, ZOOM_MIN, ZOOM_MAX);
  }

  // 把屏幕坐标转 NDC 并交给渲染器做射线拾取
  // penetrate（Alt+点击）：穿透拾取——同一射线上的命中物体按深度循环切换，
  // 解决「小物体包在大凹面外壳里选不中」：外壳 → 内部 → 再回外壳
  function pickAtClient(clientX: number, clientY: number, penetrate = false): void {
    const rect = canvas!.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;

    // 运行时实体优先：它们不在静态场景的拾取表里，GPU 拾取根本拿不到。
    // 命中则选中实体（并清掉静态选中），未命中才走原来的静态物体拾取。
    //
    // 🔴 射线只有一条来源：`renderer.pointerRay()`（对 core.invViewProj 做反投影，
    // 与画出这一帧的 viewProj 严格互逆，和静态拾取同一条）。
    // 这里曾经另有一份手算 lookAt 基向量的 screenRay()，与画面矩阵"看起来一样"，
    // 结果运行时实体的命中点整体偏开 —— 点在僵尸身上却选不中，且俯视角下才明显。
    // 两条射线实现 = 两份相机约定 = 迟早漂移，宁可删掉也不要"两份都对"。
    if (bridge.active) {
      const ray = renderer.pointerRay(clientX, clientY);
      const hit = ray === null ? null : bridge.pickRay(ray.o, ray.d);
      if (hit !== null) {
        bridge.select(hit.id, hit.generation, hit.runId);
        renderer.selectObject(null);
        panel.setSelection(null);
        // 面板直接切到这只僵尸的来源刷怪点：「它是从哪冒出来的」就该一步到位
        if (hit.sourceNodeId !== null) selectedSpawnNode = hit.sourceNodeId;
        switchInspectorTab('spawn');
        refreshSpawnPanel();
        hudDirty = true;
        return;
      }
      bridge.clearSelection();
      refreshSpawnPanel();
    }

    let idx: number | null;
    if (penetrate) {
      const hits = renderer.pickAtAll(ndcX, ndcY);
      if (hits.length === 0) {
        idx = null;
      } else {
        const cur = renderer.getSelected();
        const pos = cur === null ? -1 : hits.findIndex((h) => h.index === cur);
        idx = pos >= 0 ? hits[(pos + 1) % hits.length]!.index : hits[0]!.index;
      }
    } else {
      idx = renderer.pickAt(ndcX, ndcY);
    }
    renderer.selectObject(idx);
    panel.setSelection(idx);
    switchInspectorTab('inspector');
    hudDirty = true;
  }

  // =====================================================================
  // Transform Gizmo 交互：命中测试 + 拖拽（移动/旋转/缩放，local/world）
  // 纯 CPU 数学，不触碰 GPU；验证靠 typecheck + vite build。
  // =====================================================================
  type V3 = m4.Vec3; // 与 gizmo / 相机共用的向量类型（实现统一在 gpu/math.ts）
  /** 射线(o,d) 与平面(法线 n，过 p) 交点；平行返回 null */
  const rayPlane = (o: V3, d: V3, n: V3, p: V3): V3 | null => {
    const denom = m4.v3dot(d, n);
    if (Math.abs(denom) < 1e-7) return null;
    const t = m4.v3dot(m4.v3sub(p, o), n) / denom;
    return [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  };
  /** 2D 点到线段距离（像素） */
  const distPointSeg = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
    const vx = bx - ax;
    const vy = by - ay;
    const wx = px - ax;
    const wy = py - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 > 1e-9 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
    return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
  };

  interface GizmoHit {
    /** 0/1/2 = 轴；-1 = 中心（整体移动 / 整体缩放） */
    axis: number;
  }

  const GIZMO_HIT_PX = 12; // 命中阈值：手柄投影到屏幕后 12px 内算抓取

  /**
   * 屏幕空间 gizmo 命中测试：把手柄几何投影到像素坐标量距离。
   * 与 3D 距离法的本质区别：轴向朝着相机被透视压短时，命中带跟着缩，
   * 看似点在空白处绝不会误抓手柄 —— 手柄之外的所有拖拽都归视角导航。
   */
  function hitTestGizmo(clientX: number, clientY: number): GizmoHit | null {
    const info = renderer.getGizmoInfo();
    if (info === null) return null;
    const origin = info.origin as V3;
    const o2 = renderer.worldToScreen(origin);
    if (o2.behind) return null;
    let bestAxis: number | null = null;
    let bestScore = Infinity;
    const consider = (axis: number, x: number, y: number): void => {
      const d = Math.hypot(clientX - x, clientY - y);
      if (d < GIZMO_HIT_PX && d < bestScore) {
        bestScore = d;
        bestAxis = axis;
      }
    };
    if (info.mode === 'rotate') {
      // 圆环：沿轴向采样 40 点投影成屏幕折线，取最小像素距离
      for (let a = 0; a < 3; a++) {
        const dir = info.axes[a] as V3;
        const ref: V3 = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const u = m4.v3norm(m4.v3cross(dir, ref));
        const w = m4.v3cross(dir, u);
        const SEG = 40;
        for (let s = 0; s < SEG; s++) {
          const ang = (s / SEG) * Math.PI * 2;
          const pt = m4.v3add(origin, m4.v3add(m4.v3scale(u, Math.cos(ang) * info.k), m4.v3scale(w, Math.sin(ang) * info.k)));
          const sp = renderer.worldToScreen(pt);
          if (!sp.behind) consider(a, sp.x, sp.y);
        }
      }
    } else {
      // 箭头（移动）/ 轴方块（缩放）：投影轴线段，点到线段像素距离
      for (let a = 0; a < 3; a++) {
        const dir = info.axes[a] as V3;
        const tip = renderer.worldToScreen(m4.v3add(origin, m4.v3scale(dir, info.k)));
        if (!tip.behind) {
          const d = distPointSeg(clientX, clientY, o2.x, o2.y, tip.x, tip.y);
          if (d < GIZMO_HIT_PX && d < bestScore) {
            bestScore = d;
            bestAxis = a;
          }
        }
      }
      // 中心方块（移动/缩放整体）
      if (info.mode === 'translate' || info.mode === 'scale') {
        consider(-1, o2.x, o2.y);
      }
    }
    return bestAxis === null ? null : { axis: bestAxis };
  }

  interface DragStart {
    axis: number;
    mode: 'translate' | 'rotate' | 'scale';
    objIndex: number;
    startPos: V3;
    startQuat: m4.Quat;
    startScale: number;
    dir: V3; // 拖拽开始时的世界轴方向（移动/旋转/缩放轴用）
    planeN: V3; // 拖拽平面法线（移动/缩放轴、中心用）
    startGrab: V3; // 拖拽开始的抓取点（在平面上）
    startParam: number; // 沿轴参数（移动/缩放轴）
    startAngle: number; // 旋转起始角
    lastAngle: number; // 上一帧极角（逐帧差值用，避免 atan2 分支跳变）
    totalAngle: number; // 本次拖拽累计角（可连续旋转任意圈）
    startDist: number; // 中心缩放起始距离
    /**
     * 本次拖拽的**文档图快照**与节点 id（拖拽开始时建一次；父节点被拖时用它把整棵
     * 子树的世界变换逐帧推到视口）。拿不到文档来源（兜底场景/拖入资产）时为 null。
     */
    docGraph: SceneGraph | null;
    docNodeId: NodeId | null;
  }
  let drag: DragStart | null = null;

  function beginGizmoDrag(hit: GizmoHit, clientX: number, clientY: number): void {
    const info = renderer.getGizmoInfo();
    if (info === null) return;
    const idx = renderer.getSelected();
    if (idx === null) return;
    const q = renderer.getObjectQuat(idx);
    const st = renderer.getObjectState(idx);
    if (q === null || st === null) return;
    const origin = info.origin as V3;
    const ray = renderer.pointerRay(clientX, clientY);
    if (ray === null) return;
    const eye = renderer.getEye();
    const viewDir = m4.v3norm(m4.v3sub([eye[0], eye[1], eye[2]], origin));
    const axis = hit.axis;
    const dir: V3 = axis === -1 ? [0, 0, 0] : (info.axes[axis] as V3);

    const ds: DragStart = {
      axis,
      mode: info.mode,
      objIndex: idx,
      startPos: [st.pos[0], st.pos[1], st.pos[2]],
      startQuat: q,
      startScale: st.scale,
      dir,
      planeN: [0, 0, 0],
      startGrab: [0, 0, 0],
      startParam: 1,
      startAngle: 0,
      lastAngle: 0,
      totalAngle: 0,
      startDist: 1,
      // 文档图快照：拖拽开始时的文档（拖拽中不重读磁盘，只重算世界变换）
      docGraph: spawnStore === null ? null : graphOfDoc(spawnStore.document),
      docNodeId: renderer.getObjectNodeId(idx),
    };

    if (info.mode === 'rotate') {
      const n = dir;
      const { u, w } = rotatePlaneBasis(n, viewDir);
      const gp = rayPlane(ray.o, ray.d, n, origin);
      if (gp !== null) {
        ds.startAngle = angleInPlane(gp, origin, u, w);
        ds.lastAngle = ds.startAngle;
        ds.totalAngle = 0;
      }
    } else if (axis === -1) {
      // 中心：沿视线平面自由移动，或整体缩放
      const gp = rayPlane(ray.o, ray.d, viewDir, origin);
      if (gp !== null) {
        ds.planeN = viewDir;
        ds.startGrab = gp;
        if (info.mode === 'scale') {
          ds.startDist = Math.hypot(gp[0] - origin[0], gp[1] - origin[1], gp[2] - origin[2]) || 1e-3;
        }
      }
    } else {
      // 轴约束：平面含该轴且尽量朝相机
      const n = axisPlaneNormal(viewDir, dir);
      const gp = rayPlane(ray.o, ray.d, n, origin);
      if (gp !== null) {
        ds.planeN = n;
        ds.startGrab = gp;
        ds.startParam = m4.v3dot(m4.v3sub(gp, ds.startPos), dir) || 1e-3;
      }
    }
    drag = ds;
    renderer.setGizmoActiveAxis(axis);
    canvas!.style.cursor = 'grabbing';
  }

  function updateGizmoDrag(clientX: number, clientY: number): void {
    if (drag === null) return;
    const idx = drag.objIndex;
    const info = renderer.getGizmoInfo();
    if (info === null) return;
    const ray = renderer.pointerRay(clientX, clientY);
    if (ray === null) return;
    const origin = info.origin as V3;
    const eye = renderer.getEye();
    const viewDir = m4.v3norm(m4.v3sub([eye[0], eye[1], eye[2]], origin));

    if (drag.mode === 'rotate') {
      const n = drag.dir;
      const { u, w } = rotatePlaneBasis(n, viewDir);
      const gp = rayPlane(ray.o, ray.d, n, origin);
      if (gp !== null) {
        const ang = angleInPlane(gp, origin, u, w);
        // 逐帧差值过 wrapAngle 再累计：跨 ±180° 分支不跳变，可连续转任意圈
        drag.totalAngle += wrapAngle(ang - drag.lastAngle);
        drag.lastAngle = ang;
        const dq = m4.quatAxisAngle(n, drag.totalAngle);
        renderer.setObjectQuat(idx, m4.quatMul(dq, drag.startQuat));
      }
    } else if (drag.axis === -1) {
      const gp = rayPlane(ray.o, ray.d, drag.planeN, origin);
      if (gp !== null) {
        if (drag.mode === 'translate') {
          const delta = m4.v3sub(gp, drag.startGrab);
          renderer.setObjectPos(idx, 0, drag.startPos[0] + delta[0]);
          renderer.setObjectPos(idx, 1, drag.startPos[1] + delta[1]);
          renderer.setObjectPos(idx, 2, drag.startPos[2] + delta[2]);
        } else {
          const dist = Math.hypot(gp[0] - origin[0], gp[1] - origin[1], gp[2] - origin[2]) || 1e-3;
          renderer.setObjectScale(idx, drag.startScale * (dist / drag.startDist));
        }
      }
    } else {
      const gp = rayPlane(ray.o, ray.d, drag.planeN, origin);
      if (gp !== null) {
        const param = m4.v3dot(m4.v3sub(gp, drag.startPos), drag.dir);
        const d = param - drag.startParam;
        if (drag.mode === 'translate') {
          const np = m4.v3add(drag.startPos, m4.v3scale(drag.dir, d));
          renderer.setObjectPos(idx, 0, np[0]);
          renderer.setObjectPos(idx, 1, np[1]);
          renderer.setObjectPos(idx, 2, np[2]);
        } else {
          renderer.setObjectScale(idx, drag.startScale * (param / drag.startParam));
        }
      }
    }
    panel.syncSelectionFromRenderer();
    // 拖父节点时让整棵子树跟着走（视口物体是扁平的，不推子物体就留在原地）
    pushDraggedSubtree(drag);
    hudDirty = true;
  }

  /** 从文档建一次图（父级世界变换的来源；几十个节点，按需建，不维护增量缓存） */
  function graphOfDoc(doc: SceneDocument): SceneGraph {
    const g = SceneGraph.fromDocument(doc);
    g.updateWorldTransforms();
    return g;
  }

  /** 节点父级的**世界**变换（根节点 → 单位变换） */
  function parentWorldOf(graph: SceneGraph, nodeId: NodeId): TransformData | null {
    const n = graph.getNode(nodeId);
    if (n === null) return null;
    if (n.parent === null) return identityTransform();
    const p = graph.getNode(n.parent);
    if (p === null) return identityTransform();
    return {
      position: [p.world.position[0], p.world.position[1], p.world.position[2]],
      rotation: [p.world.rotation[0], p.world.rotation[1], p.world.rotation[2], p.world.rotation[3]],
      scale: [p.world.scale[0], p.world.scale[1], p.world.scale[2]],
    };
  }

  /** 把图里某节点的**世界**变换写进对应的渲染物体（没有对应物体时静默跳过） */
  function pushWorldOfNode(graph: SceneGraph, nodeId: NodeId): void {
    const idx = renderer.findObjectIndexByNodeId(nodeId);
    if (idx === null) return;
    const n = graph.getNode(nodeId);
    if (n === null) return;
    renderer.setObjectPos(idx, 0, n.world.position[0]);
    renderer.setObjectPos(idx, 1, n.world.position[1]);
    renderer.setObjectPos(idx, 2, n.world.position[2]);
    renderer.setObjectQuat(idx, [
      n.world.rotation[0], n.world.rotation[1], n.world.rotation[2], n.world.rotation[3],
    ]);
    renderer.setObjectScale(idx, n.world.scale[0]);
  }

  /**
   * 文档 → 视口：把某节点**及其整棵子树**的世界变换写回渲染物体。
   *
   * 子树必须一起推：视口物体是**扁平**的，每个物体一份世界变换；而文档是层级 ——
   * 拖父节点时（act1 的 `nd_f1r0` / `nd_f1r2` 各有 6 个可渲染子节点）子物体在文档里
   * 跟着走，视口里却留在原地，松手/保存/Play 之后才跳过去（codex 评审 P1）。
   * YAGNI 说明：不做整体重建 —— 重建会销毁并重传全部 GPU 资源、丢选中态与相机。
   */
  function pushSubtreeToView(graph: SceneGraph, nodeId: NodeId): void {
    pushWorldOfNode(graph, nodeId);
    for (const d of graph.descendantsOf(nodeId)) pushWorldOfNode(graph, d);
  }

  /**
   * 拖拽**进行中**把子树同步到视口。
   *
   * 用拖拽开始时缓存的文档图（`d.docGraph`）逐帧重算：先把被拖节点的当前世界量反解成
   * 局部量写进图，再 `updateWorldTransforms()`，然后推子树。逐帧成本 = 节点数（几十）。
   * 不这么做的话，拖父节点期间子物体不动，只有松手才跟上 —— 正是"视口与文档不一致"。
   */
  function pushDraggedSubtree(d: DragStart): void {
    const g = d.docGraph;
    const id = d.docNodeId;
    if (g === null || id === null) return;
    const st = renderer.getObjectState(d.objIndex);
    const q = renderer.getObjectQuat(d.objIndex);
    const parentWorld = parentWorldOf(g, id);
    if (st === null || q === null || parentWorld === null) return;
    const local = worldToLocalTransform(
      parentWorld,
      {
        position: [st.pos[0], st.pos[1], st.pos[2]],
        rotation: [q[0], q[1], q[2], q[3]],
        scale: [st.scale, st.scale, st.scale],
      },
      identityTransform(),
    );
    if (local === null) return;
    g.setLocalTransform(id, {
      position: local.position,
      rotation: local.rotation,
      scale: local.scale,
    });
    g.updateWorldTransforms();
    for (const child of g.descendantsOf(id)) pushWorldOfNode(g, child);
  }

  /**
   * gizmo 拖拽收尾：把渲染物体的**世界**变换换算成**局部**变换写回场景文档。
   *
   * 复审 B1 的修复本体。过去这里什么都不做：拖完点保存不落盘、点 Play 也看不见
   * （文档里还是旧位置）—— 那是「编辑器拥有场景状态」的活标本（AGENTS.md §2.1）。
   * 现在走 `SpawnEditStore.setTransform`：一条拖拽 = 一条可撤销编辑，保存范围
   * （`changedPaths`）自动包含它，Play 读同一份文档于是立刻生效。
   *
   * 🔴 旋转必须与位置/缩放一起写：`TransformValues` 的标量分量只覆盖位置与统一缩放，
   * 纯旋转拖拽时位置/缩放都没变。曾经这里只写位置+缩放 → 旋转被丢弃，纯旋转既不进
   * 撤销栈也不落盘（codex / Copilot 评审 P1）。
   */
  function commitGizmoTransform(d: DragStart): void {
    const store = spawnStore;
    if (store === null) return;
    const idx = d.objIndex;
    const nodeId = renderer.getObjectNodeId(idx);
    const st = renderer.getObjectState(idx);
    const q = renderer.getObjectQuat(idx);
    if (nodeId === null || st === null || q === null) {
      // 兜底场景与拖入的资产模型没有文档来源：明确说清"存不了"，而不是静默丢弃
      spawnMsg = {
        text: '该物体不属于场景文档（兜底场景或拖入的资产模型），变换不会被保存',
        kind: 'warn',
      };
      refreshSpawnPanel();
      hudDirty = true;
      return;
    }
    const parentWorld = parentWorldOf(graphOfDoc(store.document), nodeId);
    if (parentWorld === null) {
      spawnMsg = { text: `场景文档里找不到父级链（节点 ${nodeId}），变换未写回`, kind: 'warn' };
      refreshSpawnPanel();
      hudDirty = true;
      return;
    }
    const world: TransformData = {
      position: [st.pos[0], st.pos[1], st.pos[2]],
      rotation: [q[0], q[1], q[2], q[3]],
      scale: [st.scale, st.scale, st.scale],
    };
    const local = worldToLocalTransform(parentWorld, world, identityTransform());
    if (local === null) {
      // 父级缩放含 0 → 世界量反解不出局部量。宁可拒绝也不写一个错变换进文件
      spawnMsg = { text: '父级缩放为 0，无法把世界变换换算成局部变换：请先修正父节点缩放', kind: 'warn' };
      refreshSpawnPanel();
      hudDirty = true;
      return;
    }
    const to: TransformValues = {
      posX: local.position[0],
      posY: local.position[1],
      posZ: local.position[2],
      scale: local.scale[0],
      // 旋转与位置/缩放一起提交（纯旋转拖拽时标量分量都没变，漏了它就整条编辑丢失）
      rotation: [local.rotation[0], local.rotation[1], local.rotation[2], local.rotation[3]],
    };
    // 拖回原处（或只点了一下手柄没真动）→ 不进撤销栈、不弹提示。
    // 交给 store.setTransform 自己判定"值没变化"（它按 |四元数点积| 比旋转，q 与 −q
    // 是同一姿态，逐分量比会把"转一圈回到原处"误报成一次编辑）。
    const r = store.setTransform(nodeId, to);
    if (r.ok) {
      spawnMsg = { text: `已写入场景文档：${formatAuthorEdit(r.edit!)}（↶ 撤销 可回退）`, kind: 'ok' };
    } else if (r.error !== '值没有变化') {
      spawnMsg = { text: r.error ?? '变换写回被拒绝', kind: 'warn' };
    } else {
      return; // 没真动：不刷面板、不提示
    }
    refreshSpawnPanel();
    hudDirty = true;
  }

  function endGizmoDrag(): void {
    if (drag !== null) {
      commitGizmoTransform(drag);
      renderer.setGizmoActiveAxis(null);
      drag = null;
      canvas!.style.cursor = '';
      suppressDblclickUntil = performance.now() + 350;
    }
  }

  /** 工具栏模式 / 坐标空间切换（同步渲染器 + 按钮高亮） */
  function setGizmoModeUI(mode: 'translate' | 'rotate' | 'scale'): void {
    renderer.setGizmoMode(mode);
    for (const btn of document.querySelectorAll<HTMLButtonElement>('#gizmo-bar .gz-mode')) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    }
    hudDirty = true;
  }
  function setGizmoSpaceUI(space: 'local' | 'world'): void {
    renderer.setGizmoSpace(space);
    for (const btn of document.querySelectorAll<HTMLButtonElement>('#gizmo-bar .gz-space')) {
      btn.classList.toggle('active', btn.dataset.space === space);
    }
    hudDirty = true;
  }

  // ---- 聚焦：双击 / F 键把相机平滑拉到选中物体 ----
  interface FocusAnim {
    t: number;
    dur: number;
    fromT: [number, number, number];
    toT: [number, number, number];
    fromD: number;
    toD: number;
  }
  let focusAnim: FocusAnim | null = null;
  let suppressDblclickUntil = 0; // gizmo 拖拽结束后的短暂窗口内忽略 dblclick，防连点手柄误触聚焦

  const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

  /** 聚焦到某物体（null = 无选中，回默认取景）。距离按包围球适配视锥，留 1.5 倍余量 */
  function focusOn(index: number | null): void {
    let toT: [number, number, number];
    let toD: number;
    if (index === null) {
      toT = [...DEFAULT_VIEW.target];
      toD = DEFAULT_VIEW.distance;
    } else {
      const b = renderer.getObjectBounds(index);
      if (b === null) return;
      toT = b.center;
      toD = clamp((b.radius / Math.tan(FOVY / 2)) * 1.5, ZOOM_MIN, ZOOM_MAX);
    }
    focusAnim = {
      t: 0,
      dur: 0.35,
      fromT: [camera.target[0], camera.target[1], camera.target[2]],
      toT,
      fromD: camera.distance,
      toD,
    };
  }

  // =====================================================================
  // 刷怪点编辑闭环（WU-5）
  //
  // 分工严格遵守「每类状态只有一个 owner」：作者文档与撤销栈在 `SpawnEditStore`
  // （runtime 包，纯 CPU 可测），校验在 store 里，A/B 指纹在 runtime 里。
  // 这里只做编辑器专属的三件事：画控件、写文件、把改动送进 Play。
  // 面板**不持有状态** —— 每次改动后由 store 重算整份 vm 重绘，杜绝
  // 「面板显示 8、场景里其实还是 3」这种只有刷新才复现的错位。
  // =====================================================================
  const spawnHost = document.getElementById('spawn-host');
  let spawnStore: SpawnEditStore | null = null;
  let selectedSpawnNode: string | null = null;
  let spawnAb: { before: ScatterFingerprint; after: ScatterFingerprint; cmp: ScatterComparison } | null = null;
  let spawnMsg: { text: string; kind: 'info' | 'warn' | 'ok' } | null = null;

  const spawnPanel =
    spawnHost === null
      ? null
      : new SpawnPanel(spawnHost, {
          onSelect: (id) => {
            selectedSpawnNode = id;
            refreshSpawnPanel();
          },
          onEdit: (field, value) => editSpawnField(field, value),
          onUndo: () => undoSpawnEdit(),
          onSave: () => void saveSpawnEdits(),
          onRerun: () => restartPlay(),
          onFocusSource: () => focusSourceNode(),
        });

  /** 场景换了一份（或首次载入）：store 成为作者文档的唯一所有者 */
  function setSpawnScene(doc: SceneDocument | null): void {
    if (doc === null) {
      spawnStore = null;
      spawnAb = null;
      selectedSpawnNode = null;
      refreshSpawnPanel();
      return;
    }
    spawnStore = new SpawnEditStore(doc);
    // 渲染器与 PlayController 从此只读 store 的工作副本：刷怪点参数不产生可渲染
    // 内容，改完不需要同步给谁 —— 重新装载（点「重跑」）时自然读到新值。
    renderer.setDocument(spawnStore.document);
    spawnAb = null;
    selectedSpawnNode = listSpawnPoints(spawnStore.document)[0]?.nodeId ?? null;
    refreshSpawnPanel();
  }

  function editSpawnField(field: 'radius' | 'count', value: number): void {
    const store = spawnStore;
    if (store === null || selectedSpawnNode === null) return;
    const seed = playCtl.session.seed;
    // A = 编辑前的同种子指纹；改完再抓一次 B。只展示"改后"看不出改动到底生没生效
    // （房间还没进 → 一个都没刷，params 变了但画面纹丝不动，作者会以为没保存）
    const before = captureInitialScatter(store.document, { seed });
    const r = store.set(selectedSpawnNode, field, value);
    if (!r.ok) {
      spawnMsg = { text: r.error ?? '编辑被拒绝', kind: 'warn' };
      refreshSpawnPanel();
      hudDirty = true;
      return;
    }
    const after = captureInitialScatter(store.document, { seed });
    spawnAb = { before, after, cmp: compareScatter(before, after) };
    const d = spawnAb.cmp.deltas.find((x) => x.nodeId === selectedSpawnNode);
    spawnMsg = {
      text:
        `已改 ${formatAuthorEdit(r.edit!)}` +
        (d !== undefined ? `　散布均 ${d.meanBefore.toFixed(2)} → ${d.meanAfter.toFixed(2)} m` : ''),
      kind: 'ok',
    };
    refreshSpawnPanel();
    hudDirty = true;
  }

  function undoSpawnEdit(): void {
    const store = spawnStore;
    if (store === null) return;
    const undone = store.undo();
    if (undone === null) return;
    // 撤销后 A/B 的"改前"保持不变，只有 B 端点重抓 —— 撤销也要能证明它真的撤了
    if (spawnAb !== null) {
      const after = captureInitialScatter(store.document, { seed: playCtl.session.seed });
      spawnAb = { before: spawnAb.before, after, cmp: compareScatter(spawnAb.before, after) };
    }
    // 变换编辑撤销后必须把视口也退回去：文档是唯一真源，但渲染物体是另一份表示，
    // 不主动回写就会出现「文档已退、画面还留着」（复审 B1）。**连同子树**一起回写 ——
    // 撤销父节点编辑时子物体在文档里也退回去了，视口不同步就会留下"错位的子物体"。
    if (undone.kind === 'transform') {
      const store2 = spawnStore;
      if (store2 !== null) pushSubtreeToView(graphOfDoc(store2.document), undone.nodeId);
    }
    spawnMsg = { text: `已撤销：${formatAuthorEdit(undone)}`, kind: 'ok' };
    refreshSpawnPanel();
    hudDirty = true;
  }

  /**
   * 保存。
   *
   * 写盘前先做一次**改动集合自检**：
   *
   *   ① 路径必须落在**某个 `SpawnPoint` 组件**的 radius / count 上
   *      —— 光匹配正则不够：`Collider{sphere}.radius` 或任何组件上的 `count`
   *      都能骗过 `/components\[\d+\]\.(radius|count)$/`，等于放行；
   *   ② 至少要有一条改动（零改动就没必要写盘）。
   *
   * ⚠️ 这里**不能**限制"恰好一条"：作者完全可能连续改两个刷怪点再保存，
   * 那时 2 处改动是合法的。曾经这么写过，结果把合法保存给拒了（复审抓出来的回归）。
   * "一次编辑只产生一处改动"这条性质由 `spawn-edit.test.ts` 在 runtime 侧断言，
   * 不该在保存这一步用条数来卡。
   *
   * 这条兜底的意义：store 的实现保证了它不会去碰别的字段，但把断言放在保存这一步，
   * 才能保证将来有人加了新命令也不会悄悄破坏这个性质。
   */
  async function saveSpawnEdits(): Promise<void> {
    const store = spawnStore;
    const src = renderer.getSceneSource();
    if (store === null || src === null) {
      spawnMsg = { text: '没有可保存的场景文件', kind: 'warn' };
      refreshSpawnPanel();
      return;
    }
    // 🔴 重复保存必须串行（复审 P2）：上一次保存还在写盘，这次的快照/确认
    // 会跟它交错 —— 确认范围是按编辑身份记的，交错会把还没包含进快照的编辑
    // 当成已保存。客户端这里先拒，服务端对同一路径还有队列兜底。
    if (saveInFlight) {
      spawnMsg = { text: '上一次保存尚未完成，稍候再试', kind: 'warn' };
      refreshSpawnPanel();
      return;
    }
    const diffs = store.changedPaths();
    if (diffs.length === 0) {
      spawnMsg = { text: '没有改动需要保存', kind: 'warn' };
      refreshSpawnPanel();
      return;
    }
    saveInFlight = true;
    try {
      await saveSpawnEditsInner(store, src, diffs);
    } finally {
      saveInFlight = false;
    }
  }

  let saveInFlight = false;

  /** saveSpawnEdits 的主体（串行门在外层） */
  async function saveSpawnEditsInner(store: SpawnEditStore, src: { url: string }, diffs: ReturnType<SpawnEditStore['changedPaths']>): Promise<void> {
    // 合法路径集合 = 全文所有 SpawnPoint 组件的 radius / count（按 kind 限定，不是按路径形状）
    const doc = store.document;
    const expected = new Set<string>();
    if (Array.isArray(doc.nodes)) {
      for (let i = 0; i < doc.nodes.length; i++) {
        const comps = doc.nodes[i]!.components;
        for (let c = 0; c < comps.length; c++) {
          if (comps[c]!.kind !== 'SpawnPoint') continue;
          expected.add(`nodes[${i}].components[${c}].radius`);
          expected.add(`nodes[${i}].components[${c}].count`);
        }
      }
    }
    const unexpected = diffs.filter((d) => !expected.has(d.path));
    if (unexpected.length > 0) {
      spawnMsg = {
        text: `拒绝保存：检测到 ${unexpected.length} 处非刷怪点字段的改动（如 ${unexpected[0]!.path}）`,
        kind: 'warn',
      };
      refreshSpawnPanel();
      return;
    }

    // ① 竞态边界：**快照**这次要发送的版本。保存是异步 IO，从序列化到写盘返回之间
    // 作者可能继续编辑；确认时只提交快照（按编辑身份，不按栈长 —— 复审 P2）。
    const snap = store.beginSave();
    // 行尾补一个换行：场景文件是进 git 的，每次保存都把最后一个换行吃掉的话，
    // diff 里会永远挂着一条 "\ No newline at end of file" 的噪声。
    const content = `${JSON.stringify(snap.doc, null, 2)}\n`;
    const baseFp = sceneFingerprint(store.committedDocument);

    // ② 提前提示（不是判定）：先读盘看一眼有没有明显的外部修改，
    // 能早一步给作者更清楚的中文提示。
    const disk = await readProjectFile(src.url);
    if (!disk.ok) {
      spawnMsg = { text: `保存失败：读不到磁盘基准版本（${disk.error ?? '未知'}）`, kind: 'warn' };
      refreshSpawnPanel();
      return;
    }
    const diskFp = sceneFingerprint(disk.json);
    if (diskFp !== baseFp) {
      spawnMsg = {
        text:
          `拒绝保存：磁盘上的场景已被外部修改（基准 ${baseFp} → 磁盘 ${diskFp}）。` +
          '为避免覆盖对方内容，本次未写盘；本地编辑已保留。重新装载或人工合并后再保存。',
        kind: 'warn',
      };
      refreshSpawnPanel();
      return;
    }

    // ③ 写盘：**基准指纹随请求一起交给服务端**，版本校验与写入在同一个受控操作里
    // （复审 P1：浏览器两步之间被注入修改的 TOCTOU 窗口，由服务端队列 + 校验封死）。
    const res = await writeProjectFile(src.url, { content, baseHash: baseFp });
    if (!res.ok) {
      spawnMsg = {
        text: res.conflict
          ? `拒绝保存：服务端确认磁盘已被外部修改（当前 ${res.currentHash ?? '?'}）。本地编辑已保留，请重新装载或人工合并。`
          : `保存失败：${res.error ?? `HTTP ${res.status}`}`,
        kind: 'warn',
      };
      refreshSpawnPanel();
      return;
    }
    store.confirmSave(snap.doc, snap.lastEditId);
    const kept = store.undoDepth;
    spawnMsg = {
      text:
        `已保存 ${res.bytes ?? content.length} 字节 · ${diffs.length} 处改动 · 未消费组件与无关字段原样保留` +
        (kept > 0 ? `（另有 ${kept} 处保存期间的编辑仍为未保存）` : ''),
      kind: 'ok',
    };
    refreshSpawnPanel();
    hudDirty = true;
  }

  /** 按改动后的场景重新装载并开跑 */
  function restartPlay(): void {
    if (spawnStore === null) return;
    // 🔴 不能只调 playCtl.reset()：reset 用的是**装载时**的运行描述，改完 radius
    // 它根本看不见。要让改动生效必须重新装载 = stop（恢复作者态）→ start（按新文档建会话）
    if (playCtl.isPlaying) stopPlay();
    if (!startPlay()) {
      spawnMsg = { text: `重跑失败：${playCtl.error ?? '未知'}`, kind: 'warn' };
    } else {
      spawnMsg = { text: '已按改动后的场景重新装载并开跑（同种子）', kind: 'ok' };
    }
    refreshSpawnPanel();
    hudDirty = true;
  }

  /** 按场景节点 id 在视口里选中并聚焦（WU-5「Stop 后定位该来源节点」） */
  function focusNode(nodeId: string): void {
    const idx = renderer.findObjectIndexByNodeId(nodeId);
    if (idx === null) {
      spawnMsg = {
        text: `节点 ${nodeId} 没有可见网格，无法在视口定位（刷怪点本身通常不挂网格）`,
        kind: 'info',
      };
      refreshSpawnPanel();
      return;
    }
    renderer.selectObject(idx);
    panel.setSelection(idx);
    focusOn(idx);
    hudDirty = true;
  }

  function focusSourceNode(): void {
    // 优先用运行实体的来源（"这只僵尸从哪来的"），没有运行时退回面板里选中的刷怪点
    const src = bridge.selectedEntity?.sourceNodeId ?? selectedSpawnNode;
    if (src !== null) focusNode(src);
  }

  /**
   * 退出 Play 并定位来源节点。
   *
   * 顺序：先取出来源 id（stop 会摘掉会话、清空实体选中），再 stop，最后定位。
   */
  function stopPlay(): void {
    const src = bridge.selectedEntity?.sourceNodeId ?? null;
    playCtl.stop();
    if (src !== null) focusNode(src);
    hudDirty = true;
  }

  function refreshSpawnPanel(): void {
    if (spawnPanel === null) return;
    const store = spawnStore;
    const doc = store?.document ?? null;
    const ent = bridge.selectedEntity;
    const cmp = spawnAb?.cmp ?? null;
    const lines: string[] = [];
    let summary: string | null = null;
    if (cmp !== null) {
      if (!cmp.usable) {
        lines.push('A/B 不可用：装载失败，没有可比指纹');
      } else {
        for (const d of cmp.deltas) lines.push(describeDelta(d));
        summary =
          `改动 ${cmp.changedNodeIds.length} 处 / 共 ${cmp.deltas.length} 个刷怪点` +
          `　NPC ${cmp.npcBefore} → ${cmp.npcAfter}　种子 ${spawnAb!.before.seed}`;
      }
    }
    spawnPanel.render({
      scenePath: renderer.getSceneSource()?.url ?? null,
      spawns: doc === null ? [] : listSpawnPoints(doc),
      selectedNodeId: selectedSpawnNode,
      entity:
        ent === null
          ? null
          : {
              characterId: ent.characterId,
              sourceNodeId: ent.sourceNodeId,
              targetId: ent.targetId,
              behavior: ent.behavior,
              x: ent.x,
              z: ent.z,
            },
      dirty: store?.dirty ?? false,
      undoDepth: store?.undoDepth ?? 0,
      message: spawnMsg?.text ?? null,
      messageKind: spawnMsg?.kind ?? 'info',
      abLines: lines,
      abSummary: summary,
      playing: playCtl.isPlaying,
    });
  }

  // 自动化钩子：无头/实机 CDP 验证驱动刷怪点闭环（面板是 DOM，只能靠实机验证）
  {
    const hook = (window as unknown as { __editor: Record<string, unknown> }).__editor;
    hook.spawn = {
      /** 面板当前状态的纯数据镜像（探针据此断言，不解析 DOM 文本） */
      state: () => {
        const doc = spawnStore?.document ?? null;
        const sel =
          doc === null || selectedSpawnNode === null
            ? null
            : listSpawnPoints(doc).find((s) => s.nodeId === selectedSpawnNode) ?? null;
        const ent = bridge.selectedEntity;
        return {
          scenePath: renderer.getSceneSource()?.url ?? null,
          dirty: spawnStore?.dirty ?? false,
          undoDepth: spawnStore?.undoDepth ?? 0,
          selectedNodeId: selectedSpawnNode,
          radius: sel?.radius ?? null,
          count: sel?.count ?? null,
          spawnCount: doc === null ? 0 : listSpawnPoints(doc).length,
          message: spawnMsg?.text ?? null,
          messageKind: spawnMsg?.kind ?? null,
          ab: spawnAb === null ? null : {
            usable: spawnAb.cmp.usable,
            changed: spawnAb.cmp.changedNodeIds,
            unchanged: spawnAb.cmp.unchangedNodeIds,
            npcBefore: spawnAb.cmp.npcBefore,
            npcAfter: spawnAb.cmp.npcAfter,
            lines: spawnAb.cmp.deltas.map(describeDelta),
          },
          entity:
            ent === null
              ? null
              : { characterId: ent.characterId, sourceNodeId: ent.sourceNodeId, targetId: ent.targetId, behavior: ent.behavior },
          changedPaths: spawnStore?.changedPaths().map((d) => d.path) ?? [],
        };
      },
      select: (id: string | null) => {
        selectedSpawnNode = id;
        refreshSpawnPanel();
      },
      edit: (field: 'radius' | 'count', value: number) => editSpawnField(field, value),
      undo: () => undoSpawnEdit(),
      /** 全部撤回（不提交）。此前只有 API 没有任何入口 —— 探针/用户都到不了 */
      revertAll: () => {
        spawnStore?.revertAll();
        refreshSpawnPanel();
        hudDirty = true;
      },
      save: () => saveSpawnEdits(),
      rerun: () => restartPlay(),
      focusSource: () => focusSourceNode(),
      /** 选中第一个 NPC（等价于在画面里点它） */
      pickFirstNpc: () => {
        const e = bridge.entities.find((x) => x.kind === 'npc');
        if (e === undefined) return null;
        bridge.select(e.id, e.generation, e.runId);
        if (e.sourceNodeId !== null) selectedSpawnNode = e.sourceNodeId;
        switchInspectorTab('spawn');
        refreshSpawnPanel();
        return { id: e.id, generation: e.generation, sourceNodeId: e.sourceNodeId, characterId: e.characterId };
      },
      /** 面板可见文本（验证 DOM 真的渲染出来了，而不只是内存状态对） */
      panelText: () => document.getElementById('spawn-host')?.innerText ?? '',
    };

    // §8-5「在画面中对应到它」要用到的**原语**（不是验证逻辑本身）：
    // 屏幕坐标 → 世界射线（与静态拾取同一条），与真实点击走的同一个入口。
    // 刻意暴露「点击」而不是「射线」，因为要证明的是"用户在画面上点它就能选中它"。
    hook.bridge = bridge;
    hook.pointerRay = (clientX: number, clientY: number) => renderer.pointerRay(clientX, clientY);
    hook.pickAtClient = (clientX: number, clientY: number) => pickAtClient(clientX, clientY);

    /**
     * §8-1「Node 与浏览器使用同一初始化、seed 和固定 tick 输入」的浏览器侧取样口。
     *
     * 用**页面里同一个 bundle** 的 runtime 模块跑一次给定种子 / 步数的会话，
     * 返回实体快照。自建自停，**不碰用户正在播放的会话** —— 否则对比会撞上
     * 真实时间推进，那就不再是「同输入」了。
     */
    /**
     * 把「浏览器实际喂给 runtime 的那份文档」原样导出来。
     *
     * 这是 §8-1 的**取证口**，不是产品功能：指纹对不上时必须能立刻拿到两侧文档的
     * 逐路径差异，否则只能靠猜（"大概是被迁移补了字段吧"），而猜错一次就是半天。
     */
    hook.runtime = {
      docJson: () => JSON.stringify(spawnStore?.document ?? renderer.getDocument()),
      runTo: (seed: number, ticks: number, inputs?: { x: number; z: number }[]) => {
        const doc = spawnStore?.document ?? renderer.getDocument();
        if (doc === null) return { ok: false as const, error: '场景未加载' };
        const ps = new PlaySession({ seed, fixedStep: 1 / 30 });
        const r = ps.play(doc);
        if (!r.ok) return { ok: false as const, error: r.errors.join('；') };
        const s = ps.runtime;
        if (s === null) return { ok: false as const, error: '会话为空' };
        for (let i = 0; i < ticks; i++) {
          // 固定 tick 输入消费（复审 #7）：与 Node 侧喂同一条序列，玩家输入才算进比对
          const inp = inputs?.[i];
          if (inp !== undefined) s.setInput(inp.x, inp.z);
          s.step();
        }
        const out = {
          ok: true as const,
          seed,
          fixedStep: ps.fixedStep,
          tick: s.tick,
          sceneId: s.desc.sceneId,
          schemaVersion: s.desc.schemaVersion,
          // 与 Node 侧 runtime-parity.mjs 用**同一个** sceneFingerprint：
          // 先确认喂进去的是同一份文档，再谈输出一致。
          docFingerprint: sceneFingerprint(doc),
          entities: s.view().map((e) => ({
            id: e.id,
            generation: e.generation,
            characterId: e.characterId,
            kind: e.kind,
            x: e.x,
            z: e.z,
            yaw: e.yaw,
            sourceNodeId: e.sourceNodeId,
            targetId: e.targetId,
            behavior: e.behavior,
          })),
        };
        ps.stop();
        return out;
      },
    };
  }

  for (const btn of document.querySelectorAll<HTMLButtonElement>('#gizmo-bar .gz-mode')) {
    btn.addEventListener('click', () =>
      setGizmoModeUI(btn.dataset.mode as 'translate' | 'rotate' | 'scale'),
    );
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#gizmo-bar .gz-space')) {
    btn.addEventListener('click', () =>
      setGizmoSpaceUI(btn.dataset.space as 'local' | 'world'),
    );
  }
  // ---- Play 期玩家输入（虚拟摇杆的键盘装配，复审 #7 的编辑器侧）----
  // 用**箭头键**而不是 WASD：W/E/R 已被 gizmo 快捷键占用，混用会一边走一边切模式。
  // 宿主（这里）只负责把真实输入转成约定的运行输入向量，消费全在 runtime 的固定步里。
  const playKeys = new Set<string>();
  const PLAY_KEYS = new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
  window.addEventListener('keyup', (e) => {
    playKeys.delete(e.key.toLowerCase());
  });

  /**
   * 失焦必须清空按键并**立即**提交零输入（复审 P2）。
   * 按住方向键切到别的窗口、在那边松开，本页收不到 keyup —— 玩家会一直走。
   * 不能等下一帧：失焦后 rAF 可能直接被节流停掉，那时候"等 frame 再提交"等于不提交。
   */
  const clearPlayKeys = (): void => {
    if (playKeys.size === 0) return;
    playKeys.clear();
    if (playCtl.isPlaying) playCtl.session.setInput(0, 0);
  };
  window.addEventListener('blur', clearPlayKeys);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearPlayKeys();
  });

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    const k = e.key.toLowerCase();

    if (PLAY_KEYS.has(k)) {
      playKeys.add(k);
      if (playCtl.isPlaying) e.preventDefault(); // Play 中箭头键归玩家，不滚动页面
      return;
    }

    // ---- Play 控制（WU-4）----
    // 空格：停止态 → 进入 Play；播放中 → 暂停；暂停中 → 继续。
    // Esc：退出 Play 并恢复作者状态。句点：单步。逗号：同种子重跑。
    // 必须 preventDefault —— 否则空格会滚动页面，且焦点在按钮上时还会重复触发 click。
    if (k === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (playCtl.state === 'stopped') {
        if (!startPlay()) console.warn(`[play] 启动失败：${playCtl.error ?? '未知'}`);
      } else playCtl.togglePause();
      return;
    }
    if (k === 'escape') {
      if (playCtl.isPlaying) {
        e.preventDefault();
        stopPlay();
      }
      return;
    }
    if (k === '.') {
      if (playCtl.isPaused) {
        e.preventDefault();
        playCtl.step();
      }
      return;
    }
    if (k === ',') {
      if (playCtl.isPlaying) {
        e.preventDefault();
        resetPlay();
      }
      return;
    }

    if (k === 'w') setGizmoModeUI('translate');
    else if (k === 'e') setGizmoModeUI('rotate');
    else if (k === 'r') setGizmoModeUI('scale');
    else if (k === 'f') focusOn(renderer.getSelected());
    else if (k === 'delete') {
      // Delete 删除选中物体（Unity 惯例）
      const idx = renderer.getSelected();
      if (idx !== null && !playCtl.isPlaying) {
        e.preventDefault();
        renderer.removeObject(idx);
        panel.setSelection(renderer.getSelected());
        panel.refreshHierarchy();
        hudDirty = true;
      } else if (idx !== null && playCtl.isPlaying) {
        // Play 中禁止增删：作者状态快照是按索引恢复的，物体数一变就会张冠李戴
        e.preventDefault();
        console.warn('[play] Play 中禁止删除物体（Stop 后作者状态按索引恢复，数量必须一致）');
        hudDirty = true;
      }
    }
  });
  // 双击：第一下轻点已把光标下的物体选上，双击事件紧接着聚焦过去；双击空白 = 回默认取景
  canvas.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (performance.now() < suppressDblclickUntil) return;
    focusOn(renderer.getSelected());
  });
  // 初始高亮：translate + world（与渲染器默认值一致）
  setGizmoModeUI('translate');
  setGizmoSpaceUI('world');

  canvas.addEventListener('pointerdown', (e) => {
    focusAnim = null; // 用户接管相机，聚焦动画立即让位
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      // gizmo 手柄抓取：仅普通左键（右键/中键/Shift+左键永远归视角导航，绝不抢）
      if (e.button === 0 && !e.shiftKey && renderer.getSelected() !== null) {
        const hit = hitTestGizmo(e.clientX, e.clientY);
        if (hit !== null) {
          beginGizmoDrag(hit, e.clientX, e.clientY);
          gesture = 'gizmo';
          lastX = e.clientX;
          lastY = e.clientY;
          downX = e.clientX;
          downY = e.clientY;
          downMoved = 0;
          return;
        }
      }
      gesture = e.button === 2 || e.button === 1 || e.shiftKey ? 'pan' : 'orbit';
      lastX = e.clientX;
      lastY = e.clientY;
      downX = e.clientX;
      downY = e.clientY;
      downMoved = 0;
    } else if (pointers.size === 2) {
      downMoved = CLICK_THRESHOLD + 1; // 双指手势绝不触发拾取
      const pts = [...pointers.values()];
      const a = pts[0]!;
      const b = pts[1]!;
      pinchDist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      lastX = (a.x + b.x) / 2;
      lastY = (a.y + b.y) / 2;
      gesture = 'pinch';
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const pt = pointers.get(e.pointerId);
    if (pt === undefined) {
      // 悬停（无按键按下）：gizmo 手柄上显示抓手，提示此处点击是拖手柄而非转视角。
      // 先算好再比对旧值：无条件写 style.cursor 会让每次鼠标移动都触发一次样式失效，
      // 而绝大多数移动光标形态根本没变。
      const next =
        renderer.getSelected() !== null && hitTestGizmo(e.clientX, e.clientY) !== null ? 'grab' : '';
      if (canvas.style.cursor !== next) canvas.style.cursor = next;
      return;
    }
    pt.x = e.clientX;
    pt.y = e.clientY;
    if (pointers.size === 1) {
      downMoved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (gesture === 'gizmo') {
        updateGizmoDrag(e.clientX, e.clientY);
      } else if (gesture === 'orbit') {
        camera.yaw -= (e.clientX - lastX) * ORBIT_RAD_PER_PX;
        // 自由俯仰：上下拖可越过地平线（负 = 仰视，eye 在 target 之下）。
        // 仅在接近 ±90° 时 lookAt 的 up 与视线平行才退化，故留 1° 余量。
        panel.params.cameraElevation = clamp(
          panel.params.cameraElevation + (e.clientY - lastY) * PITCH_DEG_PER_PX,
          -PITCH_LIMIT_DEG,
          PITCH_LIMIT_DEG,
        );
        panel.syncValues();
        hudDirty = true;
      } else if (gesture === 'pan') {
        panBy(e.clientX - lastX, e.clientY - lastY);
      }
      lastX = e.clientX;
      lastY = e.clientY;
    } else if (pointers.size >= 2 && gesture === 'pinch') {
      const pts = [...pointers.values()];
      const a = pts[0]!;
      const b = pts[1]!;
      const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      zoomBy(pinchDist / d); // 双指张开 → 拉近
      pinchDist = d;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      panBy(cx - lastX, cy - lastY);
      lastX = cx;
      lastY = cy;
    }
  });

  const endPointer = (e: PointerEvent): void => {
    const had = pointers.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (!had) return;
    if (pointers.size === 0) {
      const wasDrag = downMoved > CLICK_THRESHOLD;
      // gizmo 拖拽结束：清手柄高亮，不触发拾取
      if (drag !== null) {
        endGizmoDrag();
      } else if (!wasDrag && e.button === 0) {
        // 轻点 = 拾取选中（触摸的 button 也是 0）；Alt+点击 = 穿透循环；任何拖拽/双指/右键操作不拾取
        pickAtClient(e.clientX, e.clientY, e.altKey);
      }
    } else if (pointers.size === 1) {
      // 双指抬起一根：用剩下那根重新锚定，视角不跳变；拾取基点一并重置
      const rest = [...pointers.values()][0]!;
      lastX = rest.x;
      lastY = rest.y;
      downX = rest.x;
      downY = rest.y;
      downMoved = CLICK_THRESHOLD + 1;
      gesture = 'orbit';
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // 右键留给平移
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault(); // 挡掉中键自动滚动
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      focusAnim = null;
      zoomBy(Math.exp(e.deltaY * 0.0012));
    },
    { passive: false },
  );

  // =====================================================================
  // 资产库 Asset Library + 属性 Inspector
  // 底部 dock 浏览项目文件；GLB 双击/拖入画布生成为新场景物体（renderer.addObject，
  // 与「导入 GLB…」替换角色槽位是两条路）；选中资产在右侧 Inspector 显示静态属性。
  // =====================================================================

  // 三栏宽度恢复 + 分界线拖拽（左侧栏 / 右侧 Inspector；dock 与目录树的把手在组件内部）
  restoreCssVar('--panel-w', 'zh.ui.panelW', 330);
  restoreCssVar('--insp-w', 'zh.ui.inspW', 300);
  const splitLeft = document.getElementById('split-left');
  if (splitLeft !== null) {
    makeSplitter(splitLeft, {
      cssVar: '--panel-w',
      valueFromPointer: (e) => e.clientX,
      min: 220,
      max: 560,
      persistKey: 'zh.ui.panelW',
    });
  }
  const splitRight = document.getElementById('split-right');
  if (splitRight !== null) {
    makeSplitter(splitRight, {
      cssVar: '--insp-w',
      valueFromPointer: (e) => window.innerWidth - e.clientX,
      min: 220,
      max: 560,
      persistKey: 'zh.ui.inspW',
    });
  }

  /** Unity 式去重命名：同名物体追加 2 / 3 / 4… */
  function uniqueObjectName(base: string): string {
    const names = new Set(renderer.getObjectList().map((n) => n.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) {
      const cand = `${base} ${i}`;
      if (!names.has(cand)) return cand;
    }
  }

  /**
   * 把项目里的 .glb 资产生成到场景（双击 / Inspector 按钮 / 画布拖放共用）。
   * pos 为 null 时放原点；拖放路径会把落点（视线与地面交点）传进来。
   */
  async function spawnAssetAt(relPath: string, pos: [number, number, number] | null): Promise<void> {
    // 🔴 Play 中禁止增删（复审 #3）：作者状态按索引恢复，物体数变了就会张冠李戴。
    // 这一条与层级删除 / Delete 键同一约束，所有入口统一。
    if (playCtl.isPlaying) {
      console.warn('[play] Play 中禁止导入 / 生成资产（Stop 后作者状态按索引恢复，数量必须一致）');
      panel.setModelInfo('Play 中不能导入 / 生成资产，先 Stop');
      hudDirty = true;
      return;
    }
    try {
      const resp = await fetch(`/__fs/file?path=${encodeURIComponent(relPath)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buffer = await resp.arrayBuffer();
      // 与「导入 GLB…」同一把身高尺，保证资产库生成的与导入的体型一致
      const model = parseGlb(buffer, MODEL_RULER_HEIGHT_M);
      const bmp = model.image === null ? null : await decodeTexture(model.image, relPath);
      // 🔴 异步情况（复审 #3）：导入在 Play **之前**发起、在 Play **中**完成。
      // fetch + 解码期间用户可能按了 Play —— 此时同样不能往对象集合里塞东西。
      if (playCtl.isPlaying) {
        console.warn('[play] 资产载入完成时已进入 Play，本次导入被丢弃（Stop 后可重新导入）');
        panel.setModelInfo(`已进入 Play，${stemName(relPath)} 的导入被丢弃；Stop 后重新导入`);
        hudDirty = true;
        return;
      }
      const name = uniqueObjectName(stemName(relPath));
      // nodeTree 一并传入：拖入的资产在层级面板同样按 GLB 父子结构成树
      const idx = renderer.addObject(model.mesh, bmp, model.subMeshes, name, pos ?? [0, 0, 0], model.nodeTree, model.skeleton, model.animations);
      if (idx === null) {
        panel.setModelInfo('场景物体已达上限（64），先在层级里删掉一些再拖入');
        return;
      }
      renderer.selectObject(idx);
      panel.setSelection(idx);
      switchInspectorTab('inspector');
      panel.refreshHierarchy();
      panel.setModelInfo(
        `${name} · ${model.vertices} 顶点 / ${model.triangles} 面 · 来自资产库 ${relPath}`,
      );
      focusOn(idx);
      hudDirty = true;
    } catch (err) {
      panel.setModelInfo(`资产载入失败：${stemName(relPath)} · ${String(err)}`);
      console.error('[资产库] 载入失败', relPath, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 绑定面板 Binding —— 资产库 / 层级面板右键「进入绑定」共用一套实现
  //
  // 核心契约（改这块之前先读 services/binding/ 三个文件的头注释）：
  //   · 面板全程只在**模型 local 空间**里操作，不读任何节点世界矩阵；
  //   · 正视改 (x,y)、侧视改 (z,y)，两次拖拽定一个三维坐标；
  //   · mirror 是 x 取反，属于正视图（侧视图里 x 是深度轴，看不出镜像）；
  //   · 拟合产出两类数据：**骨长采纳进 T-pose**，**姿态旋转 ΔR 只在反解时被消耗，
  //     绝不进骨架** —— 否则 bind pose 不是干净 T-pose，接入 BVH/动捕会带 offset。
  //
  // 必须定义在资产库之前：资产库的右键回调直接调 openCtxMenu / bindAssetAt。
  // ═══════════════════════════════════════════════════════════════════════════
  const bindingDockEl = document.getElementById('binding-dock');
  const ctxMenuEl = document.getElementById('ctx-menu');

  /** 一次绑定会话的素材：源网格（**当前姿态**）+ 索引 + 原始 baseColor 贴图 */
  interface BindingSession {
    name: string;
    vertices: Float32Array<ArrayBuffer>;
    indices: Uint32Array<ArrayBuffer>;
    image: Blob | null;
  }
  let bindingSession: BindingSession | null = null;
  let binding: BindingPanel | null = null;
  // 当前绑定会话对应的 .meta.json 落盘点（资产库入口才有；层级/场景物体入口为 null）
  let currentBindingMetaPath: string | null = null;
  // 资产库当前选中的资产路径（供顶部菜单「进入绑定」取目标 .glb）
  let lastAssetPath: string | null = null;
  // 最近一次「导入文件骨架」的映射诊断（__editor.binding.importDiag 供自动化断言）
  let lastSkeletonImport: SkeletonImportResult | null = null;

  /**
   * 重定向会话（MR-06）：源 / 目标 / 标定 / 配方 / 结果统一由 session 管理，
   * 两入口（绑定面板「载入动作」/ 层级「应用动画」）汇入同一会话。
   * `animClip` 是会话**烘焙产物**（骨名为键、与骨架解耦）——导出与挂载共用同一份，
   * 与预览同版本（session.requireResult 守门）；`animReport` 只是 L0 换基映射诊断
   * （对齐角 / 映射表），不参与求解。
   */
  const retargetStore: RetargetSidecarStore = {
    read: async (p) => {
      const r = await readProjectFile(p);
      return r.ok
        ? { ok: true, json: (r.json && typeof r.json === 'object' ? r.json : null) as Record<string, unknown> | null }
        : { ok: false, json: null, error: r.error ?? `HTTP ${r.status}` };
    },
    patch: async (p, patchBody) => {
      const r = await writeProjectFile(p, { patch: patchBody });
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? `HTTP ${r.status}` };
    },
  };
  const retargetSession = new RetargetSession(retargetStore);
  let retargetWorkbench: RetargetWorkbench | null = null;
  /** 当前入口：binding = 绑定面板 T-pose（导出动画），object = 场景物体（应用到角色） */
  let retargetEntry: 'binding' | 'object' = 'binding';
  let retargetTargetObject: SceneObject | null = null;
  let previewFrame = 0;
  /** 标定 sidecar 路径（工作台输入框的真值在 main，面板只回显） */
  let retargetCalSrcPath = '';
  let retargetCalTgtPath = '';
  /** 上一次自动填入的源 sidecar 缺省值（用户手改过的路径不被下一次缺省值覆盖） */
  let previousCalSrcDefault = '';
  /** 一次性通知（如载入失败但已保留上一份结果）；下一次成功操作清除 */
  let retargetNotice: string | null = null;
  let animClip: RetargetAnimPayload | null = null;
  let animReport: RetargetReport | null = null;

  // ── 右键菜单：资产库与层级面板共用一套 DOM 与关闭逻辑 ──
  interface CtxItem {
    label: string;
    disabled?: boolean;
    /** 分隔线项：label 留空，只渲染横线（菜单动作分组用） */
    separator?: boolean;
    run(): void;
  }

  function openCtxMenu(x: number, y: number, items: CtxItem[]): void {
    if (ctxMenuEl === null) return;
    ctxMenuEl.replaceChildren();
    for (const it of items) {
      if (it.separator === true) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        ctxMenuEl.appendChild(sep);
        continue;
      }
      const b = document.createElement('button');
      b.className = 'ctx-item';
      b.type = 'button';
      b.textContent = it.label;
      if (it.disabled === true) b.disabled = true;
      b.addEventListener('click', () => {
        closeCtxMenu();
        it.run();
      });
      ctxMenuEl.appendChild(b);
    }
    ctxMenuEl.classList.add('open');
    // 先可见才量得到尺寸，故 add('open') 之后再定位；贴边翻转避免被窗口裁掉
    const r = ctxMenuEl.getBoundingClientRect();
    ctxMenuEl.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 6))}px`;
    ctxMenuEl.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 6))}px`;
  }

  function closeCtxMenu(): void {
    ctxMenuEl?.classList.remove('open');
  }
  // 捕获阶段监听：菜单里的按钮在冒泡到 window 前就可能被移除，捕获更稳
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (ctxMenuEl === null || !ctxMenuEl.classList.contains('open')) return;
      if (!ctxMenuEl.contains(e.target as Node)) closeCtxMenu();
    },
    true,
  );
  window.addEventListener('blur', () => closeCtxMenu());

  // ── 面板开关 ──
  function openBinding(session: BindingSession, saved?: unknown): void {
    if (bindingDockEl === null) return;
    bindingSession = session;
    if (binding === null) {
      binding = new BindingPanel(bindingDockEl, {
        onClose: () => closeBinding(),
        onApply: (fit, opts) => void applyBinding(fit, opts?.smoothWeights ?? true),
        onLoadBvh: () => pickBvhFile((t, n) => loadBvhForBinding(t, n)),
        onExportAnim: () => void exportAnimGlb(),
        onSave: () => void saveBinding(),
        onToggleViewportCylinders: (on) => {
          panel.setModelInfo(
            on
              ? '3D 视口：已显示 Skin Wrapper 圆柱体（半透明 X-ray，随骨骼动画实时更新）'
              : '3D 视口：已隐藏 Skin Wrapper 圆柱体',
          );
                  hudDirty = true;
        },
        onAutoFit: (changed) => {
          panel.setModelInfo(
            changed.length > 0
              ? `已自动适配半径：${changed.length} 根骨（手动改过的不动）`
              : '已自动适配半径：没有可改的骨（都手动改过了）',
          );
        },
      }, gpu);
      wireBindingGrip();
    }
    bindingDockEl.classList.add('open');
    binding.setModel(session.name, session.vertices, session.indices);
    // 资产库入口会把上次写进 .meta.json 的编辑态灌回来（有则回填，无则保持模板默认）
    if (saved !== undefined) binding.hydrate(saved);
    // canvas 必须等 open 之后才量得到 clientWidth，晚一帧再重算视图缩放
    requestAnimationFrame(() => binding?.resize());
    panel.setModelInfo(
      `已进入绑定：${session.name} · 正视改 x/y、侧视改 z/y · ` +
        `骨长采纳进 T-pose，姿态偏移不入骨架`,
    );
  }

  function closeBinding(): void {
    bindingDockEl?.classList.remove('open');
    binding?.clear();
    bindingSession = null;
    currentBindingMetaPath = null;
  }

  /**
   * 「保存绑定」：把当前编辑态（骨架摆位 + Skin Wrapper 半径）写回
   * `<mesh>.meta.json` 的 `bindingEditor` 节点。
   *
   * - 仅资产库入口（currentBindingMetaPath 非空）能落盘；层级/场景物体入口无路径，
   *   点保存会提示「无路径」而不写盘，避免误把数据写进无关文件。
   * - 用 devfs 的 patch 模式浅合并：只动 `bindingEditor` 顶层键，保留
   *   importer / userData / rig / bindings 等其余字段（含手改），与 node 管线互不踩。
   */
  function saveBinding(): void {
    if (binding === null) return;
    if (currentBindingMetaPath === null) {
      binding.setSaveStatus(false, '无路径：层级入口不支持存盘');
      return;
    }
    const data = binding.getEditorData();
    const path = currentBindingMetaPath;
    void (async () => {
      // 写盘前必须确认目标 sidecar 是合法的，否则一律拒绝写。
      // 事故复现：patch 到一个「不存在 / 不完整」的 `.meta.json` 上，会产出只有
      // bindingEditor、缺 schemaVersion/guid/kind/importer 的非法文件，
      // 直接把 `scene:check` 打红（E04 的 40MB 原始产物就因此多了一个本不该存在的 sidecar
      // —— 它命中 gen 脚本的 RAW_SOURCE_RE，压根不该有 meta）。
      // 项目铁律是「不静默修数据」→ 这里只报错、不代补字段，指引用户跑 scene:gen。
      const cur = await readProjectFile(path);
      if (!cur.ok) {
        binding?.setSaveStatus(
          false,
          `读不到 sidecar${cur.error ? ` (${cur.error})` : ''}，请先跑 npm run scene:gen`,
        );
        return;
      }
      const errs = validateAssetMeta(cur.json).filter((d) => d.severity === 'error');
      if (errs.length > 0) {
        binding?.setSaveStatus(
          false,
          `sidecar 不完整（${errs[0]!.code}），请先跑 npm run scene:gen`,
        );
        return;
      }
      const res = await writeProjectFile(path, { patch: { bindingEditor: data } });
      if (res.ok) {
        binding?.setSaveStatus(true, `已保存${res.bytes !== undefined ? ` ${res.bytes}B` : ''}`);
      } else {
        binding?.setSaveStatus(false, `保存失败 ${res.status}${res.error ? ` ${res.error}` : ''}`);
      }
    })();
  }

  /** 顶边把手：下压面板露出上方 3D 视图对照（只改 style.top） */
  function wireBindingGrip(): void {
    const grip = bindingDockEl?.querySelector<HTMLElement>('.bd-grip');
    if (grip === null || grip === undefined || bindingDockEl === null) return;
    let startY = 0;
    let startTop = 0;
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startTop = parseFloat(getComputedStyle(bindingDockEl).top) || 0;
      grip.setPointerCapture(e.pointerId);
      grip.classList.add('dragging');
    });
    grip.addEventListener('pointermove', (e) => {
      if (!grip.classList.contains('dragging')) return;
      const host = bindingDockEl.parentElement;
      const max = host === null ? 0 : Math.max(0, host.clientHeight - 140);
      bindingDockEl.style.top = `${clamp(startTop + (e.clientY - startY), 0, max)}px`;
    });
    const end = (e: PointerEvent): void => {
      if (!grip.classList.contains('dragging')) return;
      grip.classList.remove('dragging');
      if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
      binding?.resize();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  /**
   * 应用 T-pose：算权重 → 反解网格 → 导出 GLB → 回灌显示。
   *
   * @param fit     当前姿态的拟合结果（面板刻意先交 fit、后复位关节：
   *                LBS 权重必须在当前姿态骨架 + 当前姿态网格上算，顺序反了
   *                A-pose 手臂权重全错）
   * @param anim    可选的重定向动画，一并烘焙进 `animations[]`
   * @param suffix  文件名后缀（`_tpose` / `_anim`）；download=false 时不落盘
   */
  async function exportBound(
    fit: FitResult,
    anim: BindAnimationInput | null,
    download: boolean,
    suffix: string,
    smoothWeights = true,
  ): Promise<BindExportStats | null> {
    const s = bindingSession;
    if (s === null || binding === null) return null;
    const mesh = binding.getMesh();
    if (mesh === null) return null;
    try {
      const base = {
        name: s.name,
        vertices: mesh.vertices,
        indices: mesh.indices,
        image: s.image,
        placed: binding.getState().positions,
        smoothWeights,
        // 平滑迭代 / λ 由面板外置（旧评审 §2.4，进 .meta.json 可复现）；
        // 面板未开（如顶部菜单直接导出）时退回 runExport 默认值
        smoothIters: binding?.getSmoothIters() ?? 2,
        smoothLambda: binding?.getSmoothLambda() ?? 0.5,
        // Skin Wrapper（代理圆柱体）蒙皮：有则按圆柱体包裹算权重，否则退回胶囊权重。
        // 权重算法由面板显式选择（默认 wrapper，保持历史行为）；选「距离衰减」时
        // 必须传 undefined，否则 runExport 会一直走圆柱体分支（cylinders 载入即建）。
        cylinders: binding?.getWeightMode() === 'distance'
          ? undefined
          : (binding?.getCylinders() ?? undefined),
        mirrorWeights: binding?.getMirrorWeights() ?? false,
      };
      // exactOptionalPropertyTypes：`animation?: T` 不接受显式 undefined，只能整包展开
      const res = await rigToTPoseWithImage(
        anim === null ? base : { ...base, animation: anim },
      );
      const file = `${s.name}${suffix}.glb`;
      if (download) {
        downloadBlob(file, new Blob([res.glb], { type: 'model/gltf-binary' }));
      }
      // 回灌 T-pose 网格：网格摆正 + 骨架摆正，两者重合即证明反解成立（一眼可验证）
      binding.showTPoseResult(res.fit, res.tposeVertices);
      const st = res.stats;
      const animPart =
        anim === null
          ? ''
          : ` · 动画 ${st.animClips.join('/')} (${st.animChannels} 轨道)`;
      panel.setModelInfo(
        (download ? `已导出 ${file}` : '已试算') +
          ` · ${st.vertices} 顶点 / ${st.triangles} 面 / ` +
          `${(st.bytes / 1024).toFixed(0)} KB · 最大姿态偏移 ${st.maxPoseAngleDeg.toFixed(1)}° · ` +
          `身高 ${st.heightBefore.toFixed(3)} → ${st.heightAfter.toFixed(3)} m` +
          animPart +
          (st.zeroWeightVerts > 0 ? ` · ⚠ ${st.zeroWeightVerts} 个零权重顶点` : ''),
      );
      console.log('[绑定] 导出完成', {
        name: s.name,
        file: download ? file : null,
        vertices: st.vertices,
        triangles: st.triangles,
        bytes: st.bytes,
        maxPoseAngleDeg: st.maxPoseAngleDeg,
        offAxisBones: st.offAxisBones,
        heightBefore: st.heightBefore,
        heightAfter: st.heightAfter,
        zeroWeightVerts: st.zeroWeightVerts,
        animChannels: st.animChannels,
        animClips: st.animClips,
      });
      return st;
    } catch (err) {
      panel.setModelInfo(`绑定导出失败：${String(err)}`);
      console.error('[绑定] 导出失败', err);
      return null;
    }
  }

  async function applyBinding(
    fit: FitResult,
    download = true,
    smoothWeights = true,
  ): Promise<BindExportStats | null> {
    return await exportBound(fit, null, download, '_tpose', smoothWeights);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 动画应用：任意 BVH → 重定向 → ① 导出带动画的 GLB  ② 直接挂到场景里已绑定的模型
  //
  // 为什么必须重定向而不能直接拷轨道值，见 services/binding/retarget.ts 的头注释。
  // 一句话：glTF 轨道是**绝对本地旋转**，源 A-pose / 目标 T-pose 直接拷会整体偏 45°，
  // 这就是用户说的「所有导入的动画都会有 offset」。
  // ═══════════════════════════════════════════════════════════════════════════

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"]/g, (c) =>
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
    );
  }

  /** 绑定面板侧栏的诊断 HTML：L0 映射诊断 + 会话状态，一句话看清这次重定向发生了什么 */
  function animInfoHtml(): string {
    const row = (k: string, v: string): string =>
      `<div class="bd-row"><span class="bd-dim">${k}</span> ${v}</div>`;
    const out: string[] = [];
    const r = animReport;
    const sum = retargetSession.summary();
    if (r !== null) {
      out.push(`<div><b>${escapeHtml(r.clipName)}</b></div>`);
      out.push(row('帧', `${r.frameCount} @ ${r.fps.toFixed(1)}fps · ${r.duration.toFixed(2)}s`));
      out.push(
        row(
          '骨',
          `${r.mapped.length} 已映射` +
            (r.missingBones.length > 0
              ? ` · <span class="bd-warn">缺 ${escapeHtml(r.missingBones.join(' '))}</span>`
              : ''),
        ),
      );
      out.push(row('对齐', `最大 ${r.maxAlignAngleDeg.toFixed(2)}°`));
      out.push(row('缩放', `${r.skeletonScale.toFixed(4)} · 源 ${r.srcUpAxis}-up`));
      if (r.unmatchedBvh.length > 0) {
        const list = r.unmatchedBvh.slice(0, 6).join(' ');
        out.push(row('未用', escapeHtml(list) + (r.unmatchedBvh.length > 6 ? ' …' : '')));
      }
      for (const w of r.warnings) out.push(row('提示', `<span class="bd-warn">${escapeHtml(w)}</span>`));
    }
    const statusLabel: Record<string, string> = {
      idle: '未载入', ready: '可生成', pass: '通过', partial: '部分完成', failed: '生成失败', stale: '结果待更新',
    };
    out.push(
      row(
        '管线',
        `<span class="${sum.status === 'pass' ? 'bd-ok' : 'bd-warn'}">${statusLabel[sum.status] ?? sum.status}</span>` +
          (sum.coverage.length > 0 ? ` · 覆盖 ${escapeHtml(sum.coverage.join('/'))}` : ''),
      ),
    );
    if (animClip === null && sum.hasSource) {
      out.push(row('产物', '<span class="bd-warn">无烘焙轨道（求解/烘焙失败，见重定向工作台）</span>'));
    }
    return out.join('');
  }

  /**
   * L0 换基映射诊断（对齐角 / 映射表 / 根通道）——侧栏与冒烟断言的数据源。
   * 动画产物**不再**来自这条路径：求解 / 接触 / 烘焙全部走 retarget-session 管线。
   */
  function l0MappingReport(
    text: string,
    clipName: string,
    targetPositions: JointPositions | null,
  ): RetargetReport {
    const opts: RetargetOptions = { clipName };
    if (targetPositions !== null) opts.targetPositions = targetPositions;
    return retargetBvh(parseBvh(text), opts).report;
  }

  /** 会话求解 → 烘焙产物缓存（animClip）→ 工作台 / 侧栏刷新。失败时 animClip 置空。 */
  function solveAndRefresh(): void {
    // 入口 A 的 fit 在绑定面板里随时可被拖改：求解前先同步目标，
    // 解的一定是当前 fit（有变 → bump 失效 → 本次求解即重算）
    if (retargetEntry === 'binding' && binding !== null) {
      const sync = retargetSession.syncTarget({
        fitPositions: binding.currentFit().tposePositions,
        name: bindingSession?.name ?? 'binding',
        assetKey: bindingSession ?? undefined,
      });
      // PR 复审 P1：fit 构建失败（invalid）不得继续求解——否则解的是旧目标，
      // 与绑定面板显示的 fit 错配。拦下并保留上一份结果。
      if (sync.state === 'invalid') {
        retargetNotice = `目标同步失败：${sync.diagnostics[0]?.message ?? 'MRS'}（已保留上一份结果，请修正绑定 T-pose 后重试）`;
        panel.setModelInfo(`生成被拦截：${retargetNotice}`);
        updateRetargetWorkbench();
        return;
      }
    }
    const outcome = retargetSession.solve();
    retargetNotice = null; // 求解完成（含失败：失败信息走诊断与 lastFailureCode）
    animClip = null;
    const baked = retargetSession.bake();
    if (baked.ok) {
      animClip = retargetSession.toAnimPayload(
        baked.tracks,
        retargetSession.sourceInfo()?.clipName ?? 'retargeted',
      );
    }
    // 版本一致性（UX 复审 P1）：入口 B 重新生成成功后**自动重挂载**新轨道并恢复播放——
    // 时间轴 scrub/播放驱动的蒙皮角色永远是当前版本，不再需要手动再点「应用到角色」
    let autoApplied = false;
    if (
      outcome.status !== 'failed' && animClip !== null &&
      retargetEntry === 'object' && retargetTargetObject !== null
    ) {
      autoApplied = applyAnimToObject(retargetTargetObject) !== null;
    }
    if (binding !== null && retargetEntry === 'binding') {
      binding.setAnimationInfo(animInfoHtml());
    }
    const sum = retargetSession.summary();
    if (outcome.status === 'failed') {
      panel.setModelInfo(`重定向失败（${sum.lastFailureCode ?? 'MRC'}）：上一份可用结果已保留，详见工作台诊断`);
    } else {
      panel.setModelInfo(
        `动画已重定向：${sum.status === 'pass' ? '通过' : '部分完成'} · ` +
          `${sum.frames ?? 0} 帧 · 覆盖 ${sum.coverage.join('/') || '自由运动'}` +
          (autoApplied && retargetTargetObject !== null ? ` · 新轨道已应用到 ${retargetTargetObject.name}` : '') +
          (animReport !== null ? ` · ${retargetSummary(animReport)}` : ''),
      );
    }
    console.log('[动画] 会话求解完成', {
      status: sum.status,
      coverage: sum.coverage,
      metrics: sum.metrics,
      hasPayload: animClip !== null,
      autoApplied,
    });
    updateRetargetWorkbench();
  }

  /** 把当前会话状态快照灌进工作台（含当前帧的源 / 目标正视投影线段） */
  function updateRetargetWorkbench(): void {
    if (retargetWorkbench === null || !retargetWorkbench.isOpen()) return;
    const sum = retargetSession.summary();
    const frames = sum.frames ?? 0;
    if (previewFrame >= frames) previewFrame = Math.max(0, frames - 1);

    // 源骨架线段（HumanIK 名的父链关系）
    let sourceSegments: RetargetWorkbenchState['sourceSegments'] = null;
    const srcPos = retargetSession.sourceFramePositions(previewFrame);
    if (srcPos !== null) {
      const lines: Array<readonly [number, number, number, number]> = [];
      for (const bone of Object.keys(srcPos)) {
        const parent = retargetSession.sourceParentOf(bone);
        if (parent === null || srcPos[parent] === undefined) continue;
        const a = srcPos[bone]!;
        const b = srcPos[parent]!;
        lines.push([b[0], b[1], a[0], a[1]]);
      }
      sourceSegments = lines;
    }

    // 目标骨架线段 + 接触标记（来自当前结果的第 previewFrame 帧）
    let targetSegments: RetargetWorkbenchState['targetSegments'] = null;
    let markers: RetargetWorkbenchState['markers'] = [];
    const view = retargetSession.resultFrameView(previewFrame);
    const skelView = retargetSession.targetSkeletonView();
    if (view !== null && skelView !== null) {
      const lines: Array<readonly [number, number, number, number]> = [];
      for (const bone of skelView.order) {
        const parent = skelView.parentOf(bone);
        if (parent === null) continue;
        const a = view.bonePos[bone];
        const b = view.bonePos[parent];
        if (a === undefined || b === undefined) continue;
        lines.push([b[0], b[1], a[0], a[1]]);
      }
      targetSegments = lines;
      markers = Object.keys(skelView.markers)
        .map((id) => {
          const w = view.markerWorld(id);
          return w === null ? null : ([w[0], w[1], id] as const);
        })
        .filter((v): v is readonly [number, number, string] => v !== null);
    }

    // 两视口统一包围盒（同尺度对比）
    let bounds: RetargetWorkbenchState['bounds'] = null;
    const all = [...(sourceSegments ?? []), ...(targetSegments ?? [])];
    if (all.length > 0) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [x1, y1, x2, y2] of all) {
        minX = Math.min(minX, x1, x2); maxX = Math.max(maxX, x1, x2);
        minY = Math.min(minY, y1, y2); maxY = Math.max(maxY, y1, y2);
      }
      for (const [mx, my] of markers) {
        minX = Math.min(minX, mx); maxX = Math.max(maxX, mx);
        minY = Math.min(minY, my); maxY = Math.max(maxY, my);
      }
      bounds = { minX, maxX, minY, maxY };
    }

    retargetWorkbench.update({
      summary: sum,
      source: retargetSession.sourceInfo(),
      frame: previewFrame,
      sourceSegments,
      targetSegments,
      markers,
      bounds,
      groundY: skelView?.planeY ?? null,
      canApply: retargetEntry === 'object' && retargetTargetObject !== null,
      canExport: retargetEntry === 'binding' && binding !== null,
      entry: retargetEntry,
      calSrcPath: retargetCalSrcPath,
      calTgtPath: retargetCalTgtPath,
      notice: retargetNotice,
    });
  }

  /** 打开（或复用）工作台。entry 决定操作区的「应用到角色 / 导出动画」语义。 */
  function openRetargetWorkbench(entry: 'binding' | 'object', obj: SceneObject | null): void {
    // 换入口/换目标时，旧的入口 B 物体可能被上次 scrub 暂停——先恢复它的自动播放
    if (retargetTargetObject !== null && retargetTargetObject !== obj && retargetTargetObject.skinState !== null) {
      play(retargetTargetObject.skinState);
    }
    retargetEntry = entry;
    retargetTargetObject = obj;
    if (retargetWorkbench === null) {
      const dock = document.getElementById('retarget-dock');
      if (dock === null) return;
      retargetWorkbench = new RetargetWorkbench(dock, {
        onLoadBvh: () => pickBvhFile((t, n) => reloadBvhIntoSession(t, n)),
        onSolve: () => solveAndRefresh(),
        onApply: () => applyCurrentToTargetObject(),
        onExport: () => void exportAnimGlb(),
        onSpaceModeChange: (mode) => {
          retargetSession.updateRecipeSettings({ spaceMode: mode });
          // 状态立即变「结果待更新」：侧栏同步刷新（管线行），旧结果由消费点守门拦截
          if (binding !== null && retargetEntry === 'binding') {
            binding.setAnimationInfo(animInfoHtml());
          }
          updateRetargetWorkbench();
        },
        onRootMotionChange: (mode) => {
          // 纠正动作位移声明（覆盖 buildSourceMotion 的根模式分类）→ 重采样 + 待更新
          const r = retargetSession.setSourceRootMotion(mode);
          retargetNotice = r.ok ? null : (r.diagnostics[0]?.message ?? '动作位移声明不可用');
          if (binding !== null && retargetEntry === 'binding') {
            binding.setAnimationInfo(animInfoHtml());
          }
          updateRetargetWorkbench();
        },
        onCalPathInput: (side, path) => {
          if (side === 'source') retargetCalSrcPath = path;
          else retargetCalTgtPath = path;
          // 立即重渲染：路径从空变有效后「载入」按钮必须马上可用（UX 复审 P2）
          updateRetargetWorkbench();
        },
        onCalAction: (side, action, path) => void handleCalAction(side, action, path),
        onFrameChange: (f) => {
          previewFrame = f;
          seekAppliedObjectToFrame(f);
          updateRetargetWorkbench();
        },
        onClose: () => {
          retargetWorkbench?.close();
          resumeAppliedObjectPlayback();
        },
      });
    }
    previewFrame = 0;
    const srcInfo = retargetSession.sourceInfo();
    if (srcInfo !== null) {
      // 源 sidecar 缺省 = BVH 样材目录约定；用户可在输入框改（编辑后不再被默认值覆盖）
      retargetCalSrcPath = retargetCalSrcPath !== '' && retargetCalSrcPath !== previousCalSrcDefault
        ? retargetCalSrcPath
        : `assets/characters/_tools/${srcInfo.clipName}.bvh.meta.json`;
    }
    previousCalSrcDefault = retargetCalSrcPath;
    retargetCalTgtPath = entry === 'binding' ? (currentBindingMetaPath ?? '') : '';
    retargetWorkbench.open();
    updateRetargetWorkbench();
  }

  /** 标定 sidecar 载入 / 保存（工作台「角色标定」分区的动作） */
  async function handleCalAction(
    side: 'source' | 'target',
    action: 'load' | 'save',
    path: string,
  ): Promise<void> {
    if (path === '') {
      retargetNotice = `请先填写${side === 'source' ? '源' : '目标'}标定的 sidecar 路径`;
      updateRetargetWorkbench();
      return;
    }
    if (action === 'load') {
      const r = await retargetSession.loadCalibrationFromMeta(side, path);
      retargetNotice = r.ok
        ? `已从 ${path} 载入${side === 'source' ? '源' : '目标'}标定（结果待更新，请重新生成）`
        : (r.diagnostics[0]?.message ?? `载入失败：${path}`);
      if (binding !== null && retargetEntry === 'binding') {
        binding.setAnimationInfo(animInfoHtml());
      }
      updateRetargetWorkbench();
      return;
    }
    const r = await retargetSession.saveCalibrationToMeta(side, path);
    retargetNotice = r.ok ? `已保存${side === 'source' ? '源' : '目标'}标定到 ${path}` : (r.error ?? '保存失败');
    updateRetargetWorkbench();
  }

  /**
   * 时间轴驱动真实角色（P1-3 的最小闭环）：入口 B 已应用动画的物体暂停自动播放、
   * seek 到当前帧——工作台预览与主视口蒙皮角色逐帧对应。最终蒙皮播放即「应用到角色」
   * 后的主视口动画；工作台双视口是求解器世界投影（诊断用），不冒充蒙皮验收。
   */
  function seekAppliedObjectToFrame(frame: number): void {
    const obj = retargetTargetObject;
    if (obj === null || obj === undefined || obj.skinState === null) return;
    const times = animClip !== null ? animClip.times : null;
    if (times === null || times.length === 0) return;
    const t = frame < times.length ? times[frame]! : times[times.length - 1]!;
    pause(obj.skinState);
    seek(obj.skinState, t);
    hudDirty = true;
  }

  /** 关工作台时恢复场景角色的自动播放（scrub 期间被暂停） */
  function resumeAppliedObjectPlayback(): void {
    const obj = retargetTargetObject;
    if (obj !== null && obj !== undefined && obj.skinState !== null) play(obj.skinState);
  }

  /** 工作台内换一份 BVH（保留当前目标 / 入口语义） */
  function reloadBvhIntoSession(text: string, clipName: string): void {
    const fit = retargetEntry === 'binding' && binding !== null
      ? binding.currentFit().tposePositions
      : null;
    const obj = retargetEntry === 'object' ? retargetTargetObject : null;
    if (retargetEntry === 'binding' && binding !== null) {
      loadBvhForBinding(text, clipName);
    } else if (obj !== null && obj !== undefined) {
      loadBvhForObject(text, clipName, obj);
    } else if (fit !== null) {
      loadBvhForBinding(text, clipName);
    }
  }

  function clearAnim(): void {
    animClip = null;
    animReport = null;
    previewFrame = 0;
    retargetWorkbench?.close();
  }

  /** 入口 A：绑定面板「载入动作」—— 目标骨架就是面板拟合的那个 T-pose */
  function loadBvhForBinding(text: string, clipName: string): RetargetReport | null {
    if (binding === null) return null;
    try {
      const report = l0MappingReport(text, clipName, binding.currentFit().tposePositions);
      // PR 复审 P2：源+目标成对载入——任一失败回滚源快照，旧结果保持新鲜可消费
      const sourceSnap = retargetSession.snapshotSourceState();
      const load = retargetSession.loadSourceBvh(text, clipName);
      if (!load.ok) {
        retargetSession.rollbackSourceTo(sourceSnap);
        throw new Error(load.diagnostics[0]?.message ?? '源采样失败');
      }
      const tgt = retargetSession.setTarget({
        fitPositions: binding.currentFit().tposePositions,
        name: bindingSession?.name ?? 'binding',
        assetKey: bindingSession ?? undefined,
      });
      if (!tgt.ok) {
        retargetSession.rollbackSourceTo(sourceSnap);
        throw new Error(tgt.diagnostics[0]?.message ?? '目标骨架构建失败');
      }
      // 源+目标都成功才提交映射诊断（PR#5 评审 P2）：提交早于 setTarget 时，目标侧
      // 失败的回滚不覆盖 animReport，侧栏会把保留的旧结果标成坏文件的名字与统计
      animReport = report;
      openRetargetWorkbench('binding', null);
      solveAndRefresh();
      return report;
    } catch (err) {
      // 载入失败**不破坏已有工作状态**（UX 审核 P1）：会话源/结果未动（loadSourceBvh
      // 失败先于状态变更），上一份可用结果与工作台保持打开，只亮一次性通知
      retargetNotice = `BVH 载入失败：${String(err)}（已保留上一份结果）`;
      panel.setModelInfo(`BVH 载入失败：${String(err)}（已保留上一份结果）`);
      if (binding !== null && animReport !== null) binding.setAnimationInfo(animInfoHtml());
      updateRetargetWorkbench();
      console.error('[动画] 重定向失败', err);
      return null;
    }
  }

  /**
   * 入口 B：层级面板「应用动画」—— 目标骨架是**场景里这个模型自己的**。
   * 载入即应用（保持既有 UX：用户挑完文件就看到动画挂上并播放），
   * 工作台同步打开供看质量 / 修标定 / 重生成。
   */
  function loadBvhForObject(text: string, clipName: string, obj: SceneObject): RetargetReport | null {
    if (obj.skeleton === null) return null;
    try {
      const report = l0MappingReport(text, clipName, skeletonRestWorldPositions(obj.skeleton));
      const sourceSnap = retargetSession.snapshotSourceState();
      const load = retargetSession.loadSourceBvh(text, clipName);
      if (!load.ok) {
        retargetSession.rollbackSourceTo(sourceSnap);
        throw new Error(load.diagnostics[0]?.message ?? '源采样失败');
      }
      const tgt = retargetSession.setTarget({ skeleton: obj.skeleton, name: obj.name, assetKey: obj });
      if (!tgt.ok) {
        retargetSession.rollbackSourceTo(sourceSnap);
        throw new Error(tgt.diagnostics[0]?.message ?? '目标骨架构建失败');
      }
      animReport = report; // 同入口 A：源+目标都成功才提交（目标失败时侧栏保持旧文件的诊断）
      openRetargetWorkbench('object', obj);
      solveAndRefresh();
      const applied = applyAnimToObject(obj);
      if (applied === null) return null;
      panel.setModelInfo(
        `${obj.name} 已应用 ${clipName} · ${applied.tracks} 条轨道 · ` +
          `片段 #${applied.clip} · ${retargetSummary(report)}`,
      );
      console.log('[动画] 已挂到场景物体', { obj: obj.name, ...applied, report });
      return report;
    } catch (err) {
      // 同入口 A：失败不破坏已有工作状态
      retargetNotice = `BVH 载入失败：${String(err)}（已保留上一份结果）`;
      panel.setModelInfo(`BVH 载入失败：${String(err)}（已保留上一份结果）`);
      updateRetargetWorkbench();
      console.error('[动画] 重定向失败', err);
      return null;
    }
  }

  /** 工作台「应用到角色」：把当前会话产物挂到入口 B 的目标物体 */
  function applyCurrentToTargetObject(): void {
    const obj = retargetTargetObject;
    if (obj === null || obj === undefined) {
      panel.setModelInfo('应用失败：入口目标物体不存在（从层级右键「应用动画」重新进入）');
      return;
    }
    const applied = applyAnimToObject(obj);
    if (applied === null) return;
    panel.setModelInfo(
      `${obj.name} 已应用 · ${applied.tracks} 条轨道 · 片段 #${applied.clip}`,
    );
    hudDirty = true;
  }

  /** 隐藏 file input：BVH 没有别的入口，只能从磁盘挑 */
  function pickBvhFile(onText: (text: string, name: string) => void): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.bvh';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      input.remove();
      if (f === undefined) return;
      void f
        .text()
        .then((t) => onText(t, stemName(f.name)))
        .catch((err: unknown) => {
          panel.setModelInfo(`BVH 读取失败：${String(err)}`);
          console.error('[动画] 读取失败', err);
        });
    });
    input.click();
  }

  /**
   * 消费守门（导出 / 挂载共用）：stale、无结果、或入口 A 的 fit 已被拖改 → 拒绝并提示。
   * 这是 session.requireResult 之外的第二道防线——绑定面板自带的「导出动画」按钮
   * 不感知会话状态，真正的防线必须在消费点。
   */
  function guardedAnimForConsumption(): RetargetAnimPayload | null {
    const guard = retargetSession.requireResult();
    if (!guard.ok) {
      panel.setModelInfo(`导出/应用被拦截：${guard.message}`);
      return null;
    }
    if (retargetEntry === 'binding' && binding !== null) {
      // fit 在求解后被拖改 → 解与导出骨架错配，必须重新生成
      const sync = retargetSession.syncTarget({
        fitPositions: binding.currentFit().tposePositions,
        name: bindingSession?.name ?? 'binding',
        assetKey: bindingSession ?? undefined,
      });
      if (sync.state === 'changed') {
        panel.setModelInfo('导出被拦截：目标（绑定 T-pose）在生成后被修改，请重新「生成预览」再导出');
        return null;
      }
      if (sync.state === 'invalid') {
        panel.setModelInfo(`导出被拦截：目标骨架构建失败（${sync.diagnostics[0]?.message ?? 'MRS'}）`);
        return null;
      }
    }
    const c = animClip;
    if (c === null) {
      panel.setModelInfo('导出被拦截：没有烘焙产物（求解/烘焙失败，见重定向工作台诊断）');
      return null;
    }
    return c;
  }

  /** 导出「T-pose 网格 + 骨架 + 会话烘焙动画」的 GLB（与预览同版本，双守门） */
  async function exportAnimGlb(): Promise<BindExportStats | null> {
    if (binding === null) return null;
    const c = guardedAnimForConsumption();
    if (c === null) return null;
    const anim: BindAnimationInput = {
      name: c.name,
      times: c.times,
      rotations: c.rotations,
      translation: c.translation,
    };
    return await exportBound(binding.currentFit(), anim, true, '_anim');
  }

  /**
   * 把会话烘焙的动画挂到一个**场景里已绑定的模型**上。
   *
   * 这是「通用」的另一半：不要求模型来自绑定面板，只要骨架命名能对上 HumanIK
   * （rig_character.py 产物、Mixamo 导出、绑定面板导出的 GLB 都满足）。
   * 同名片段先移除再追加——工作台里反复「应用」不堆叠重复片段。
   */
  function applyAnimToObject(obj: SceneObject): { tracks: number; clip: number } | null {
    const guard = retargetSession.requireResult();
    if (!guard.ok) {
      panel.setModelInfo(`应用被拦截：${guard.message}`);
      return null;
    }
    const c = animClip;
    if (c === null || obj.skeleton === null) return null;
    const clip = clipToAnimClip(c, obj.skeleton);
    if (clip === null) {
      panel.setModelInfo(
        `动画应用失败：${obj.name} 的骨架没有一根骨对上 HumanIK 骨架（无法按名重定向）`,
      );
      return null;
    }
    obj.animations = [...obj.animations.filter((a) => a.name !== clip.name), clip];
    obj.skinState = createSkinState(obj.skeleton, obj.animations);
    selectClip(obj.skinState, obj.animations.length - 1);
    play(obj.skinState);
    hudDirty = true;
    return { tracks: clip.tracks.length, clip: obj.animations.length - 1 };
  }

  /** 入口一：资产库里右键 .glb → 「进入绑定」 */
  async function bindAssetAt(relPath: string, opts?: { importSkeleton?: boolean }): Promise<void> {
    try {
      const resp = await fetch(`/__fs/file?path=${encodeURIComponent(relPath)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buffer = await resp.arrayBuffer();
      // 与「导入 GLB…」同一把身高尺，保证绑定面板里的体型与场景里一致
      const model = parseGlb(buffer, MODEL_RULER_HEIGHT_M);
      lastSkeletonImport = null;

      // 导入文件骨架模式：摆位来自 GLB 内嵌 skin（rigged GLB 桥），
      // 不回填 sidecar 的 bindingEditor（那是「源网格 + 模板骨架」世界的会话）
      if (opts?.importSkeleton === true) {
        if (model.skeleton === null) {
          panel.setModelInfo(
            `导入文件骨架失败：${stemName(relPath)} 不含蒙皮骨架（纯网格）· 请用普通「进入绑定」`,
          );
          return;
        }
        // 落盘点只在「真的会打开」之后才切换：early return 时若已改指向，
        // 旧会话的「保存绑定」会写进新纯网格的 sidecar（PR #13 评审）
        currentBindingMetaPath = `${relPath}.meta.json`;
        const imp = skeletonPositionsFromGltf(model.skeleton);
        lastSkeletonImport = imp;
        openBinding({
          name: stemName(relPath),
          vertices: model.mesh.vertices,
          indices: model.mesh.indices,
          image: model.image,
        }, { positions: imp.positions });
        // 以导入骨架为起点适配半径（与 autoFit 按钮同一条路径）
        const changed = binding?.autoFit() ?? [];
        const bits = [`已从文件骨架导入 ${imp.imported.length}/${imp.imported.length + imp.keptTemplate.length} 骨`];
        if (imp.keptTemplate.length > 0) bits.push(`保持模板位：${imp.keptTemplate.join('、')}`);
        if (imp.unknown.length > 0) bits.push(`未识别骨名：${imp.unknown.join('、')}`);
        if (imp.duplicates.length > 0) bits.push(`重复骨名（取第一个）：${imp.duplicates.join('、')}`);
        bits.push(`autoFit 适配 ${changed.length} 根骨`);
        panel.setModelInfo(bits.join(' · '));
        return;
      }

      // 落盘点：与 GLB 同目录同名的 .meta.json（gen-asset-meta 已生成过）
      currentBindingMetaPath = `${relPath}.meta.json`;
      // 尝试回填上次的编辑态（bindingEditor 节点）；没有/损坏都不影响打开
      let saved: unknown = undefined;
      const meta = await readProjectFile(currentBindingMetaPath);
      if (meta.ok && meta.json !== null && typeof meta.json === 'object') {
        const ed = (meta.json as Record<string, unknown>).bindingEditor;
        if (ed !== undefined && ed !== null) saved = ed;
      }
      openBinding({
        name: stemName(relPath),
        vertices: model.mesh.vertices,
        indices: model.mesh.indices,
        image: model.image,
      }, saved);
    } catch (err) {
      panel.setModelInfo(`进入绑定失败：${stemName(relPath)} · ${String(err)}`);
      console.error('[绑定] 载入失败', relPath, err);
    }
  }

  /** 入口二：层级面板右键场景物体 → 「进入绑定」 */
  panel.onHierarchyContextMenu = (index, x, y) => {
    const obj = renderer.state.objects[index];
    openCtxMenu(x, y, [
      {
        label: obj === undefined ? '进入绑定 Binding…（物体不存在）' : '进入绑定 Binding…',
        disabled: obj === undefined,
        run: () => {
          if (obj === undefined) return;
          // 层级入口无 GLB 路径 → 没有可落盘的 .meta.json，保存按钮会被拦下
          currentBindingMetaPath = null;
          openBinding({
            name: obj.name,
            // 拷贝一份：场景网格是渲染器的活引用，applyAo 之类会就地改它
            vertices: new Float32Array(obj.mesh.vertices),
            indices: new Uint32Array(obj.mesh.indices),
            // 场景物体的贴图已上传成 GPUTexture，原始字节取不回来 → 导出不带贴图
            image: null,
          });
        },
      },
      {
        label:
          obj === undefined
            ? '应用动画 (BVH)…（物体不存在）'
            : obj.skeleton === null
              ? '应用动画 (BVH)…（该物体无骨骼）'
              : '应用动画 (BVH)…',
        disabled: obj === undefined || obj.skeleton === null,
        run: () => {
          if (obj === undefined) return;
          pickBvhFile((t, n) => loadBvhForObject(t, n, obj));
        },
      },
      { label: '聚焦 Focus', disabled: obj === undefined, run: () => focusOn(index) },
    ]);
  };

  window.addEventListener('resize', () => {
    binding?.resize();
    retargetWorkbench?.resize();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 顶部菜单栏 Skeleton ▸ 绑定动作（外壳入口；绑定逻辑全在 services/binding）
  // ═══════════════════════════════════════════════════════════════════════════
  /** 从顶部菜单「进入绑定」：优先资产库选中的 .glb，其次场景选中的物体 */
  function enterBindingFromMenu(): void {
    if (lastAssetPath !== null && lastAssetPath.toLowerCase().endsWith('.glb')) {
      void bindAssetAt(lastAssetPath);
      return;
    }
    const idx = renderer.state.selectedIndex;
    if (idx !== null) {
      const obj = renderer.state.objects[idx];
      if (obj !== undefined && obj.mesh !== null) {
        // 场景物体入口无 .meta.json 路径 → 保存按钮会被拦下
        currentBindingMetaPath = null;
        openBinding({
          name: obj.name,
          vertices: new Float32Array(obj.mesh.vertices),
          indices: new Uint32Array(obj.mesh.indices),
          image: null,
        });
        return;
      }
    }
    dockEl?.classList.remove('collapsed');
    panel.setModelInfo('请先在底部资产库选中一个 .glb 模型，或右键场景物体 → 进入绑定');
    hudDirty = true;
  }

  function exportTposeFromMenu(): void {
    if (binding === null || bindingSession === null) return;
    void applyBinding(binding.currentFit(), true, binding.getSmoothWeights());
  }

  function loadBvhFromMenu(): void {
    if (binding === null) return;
    pickBvhFile((t, n) => loadBvhForBinding(t, n));
  }

  function setupTopMenu(): void {
    const btn = document.getElementById('skeleton-menu-btn');
    const dd = document.getElementById('skeleton-dropdown');
    if (btn === null || dd === null) return;

    const setOpen = (open: boolean): void => {
      if (open) { dd.removeAttribute('hidden'); btn.classList.add('open'); }
      else { dd.setAttribute('hidden', ''); btn.classList.remove('open'); }
    };

    btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(dd.hasAttribute('hidden')); });

    dd.querySelectorAll<HTMLButtonElement>('.tb-item').forEach((item) => {
      item.addEventListener('click', () => {
        setOpen(false);
        const a = item.dataset.tbAction;
        if (a === 'enter') enterBindingFromMenu();
        else if (a === 'export') void exportTposeFromMenu();
        else if (a === 'bvh') loadBvhFromMenu();
        else if (a === 'close') closeBinding();
      });
    });

    // 绑定面板开/关 → 同步「导出 / 载入 BVH / 退出」可用态
    const refresh = (): void => {
      const open = bindingDockEl?.classList.contains('open') ?? false;
      dd.querySelectorAll<HTMLButtonElement>('.tb-item').forEach((item) => {
        const a = item.dataset.tbAction;
        if (a === 'export' || a === 'bvh' || a === 'close') item.disabled = !open;
      });
    };
    if (bindingDockEl !== null) {
      new MutationObserver(refresh).observe(bindingDockEl, { attributes: true, attributeFilter: ['class'] });
    }
    window.addEventListener('pointerdown', (e) => {
      if (!dd.contains(e.target as Node) && !btn.contains(e.target as Node)) setOpen(false);
    }, true);
    refresh();
  }
  setupTopMenu();

  // 自动化钩子：无头 CDP 验证驱动绑定面板（全部走函数，避免持有过期引用）
  {
    const hook = (window as unknown as { __editor: Record<string, unknown> }).__editor;
    hook.binding = {
      isOpen: () => bindingDockEl?.classList.contains('open') ?? false,
      open: (p: string, o?: { importSkeleton?: boolean }) => void bindAssetAt(p, o),
      close: () => closeBinding(),
      /** 最近一次「导入文件骨架」的映射诊断（未走过导入模式为 null） */
      importDiag: () => lastSkeletonImport,
      state: () => binding?.getState() ?? null,
      fit: () => binding?.currentFit() ?? null,
      pose: (n: string, p: [number, number, number]) => binding?.poseJoint(n, p),
      select: (n: string | null) => binding?.select(n),
      distance: (n: string) => binding?.distanceToMesh(n) ?? NaN,
      /** 只跑导出算一遍（不触发下载），返回统计结果供断言 */
      dryRun: async () => {
        if (binding === null) return null;
        return await applyBinding(binding.currentFit(), false);
      },
      /**
       * 3D 视口 Skin Wrapper 包裹器圆柱体（自动化断言用）：
       * 开关状态 + 本帧实际送进管线的顶点数（>0 才说明真的画了）。
       */
      wrappers: {
        set: (v: boolean) => {
          binding?.setViewportCylinders(v);
          return binding?.getViewportCylinders() ?? false;
        },
        get: () => binding?.getViewportCylinders() ?? false,
        verts: () => renderer.debugCylinderVertexCount(),
        cylinders: () => binding?.getCylinders() ?? null,
        /** 几何指纹：顶点数看不出半径变化，改半径必须体现在 sum 上 */
        stats: () => renderer.debugCylinderStats(),
        setRadius: (bone: string, seg: 'top' | 'medium' | 'bottom', v: number) =>
          binding?.setCylinderRadius(bone, seg, v) ?? false,
        /** 画布局部坐标点选圆柱体子段（与鼠标点选同一套判定） */
        pick: (axis: 'front' | 'side', x: number, y: number) => {
          const c = document.querySelector<HTMLCanvasElement>(`[data-bd="${axis}"]`);
          if (c === null || binding === null) return null;
          return binding.pickCylinderAt(x, y, axis, c);
        },
        /**
         * 某根骨的骨段在视图里的屏幕两端点。
         * 断言「拖离骨轴 = 改半径」时据此取**垂直**于骨轴的拖动方向 ——
         * 沿轴拖垂距不变，半径本就不该变（否则会误判成「拖动没反应」）。
         */
        axis: (bone: string, view: 'front' | 'side') => {
          const c = document.querySelector<HTMLCanvasElement>(`[data-bd="${view}"]`);
          if (c === null || binding === null) return null;
          return binding.segmentScreen(bone, view, c);
        },
      },
      /**
       * 面板正/侧视的 3D 正交层（自动化断言用）：
       * 网格是否已上 GPU + 本帧圆柱体顶点数（>0 才说明真的画了）。
       */
      view3d: () => binding?.getView3dStats() ?? null,
      /** 当前显示网格的几何指纹（T/A 预览失效断言：权重输入变了它必须变） */
      meshSum: () => binding?.previewMeshSum() ?? NaN,
      /** 诊断条文本（权重质量数字，与导出同源；§2.7） */
      diag: () => binding?.diagText() ?? '',
      /** 热力图状态：开关 + 当前热力骨（P0-3） */
      heat: () => binding?.getHeatInfo() ?? null,
      /** Undo/Redo（§2.6）：撤销 / 重做一步 + 栈深查询 */
      undo: () => binding?.undo(),
      redo: () => binding?.redo(),
      history: () => binding?.historyDepth() ?? null,
      /** 切到蒙皮模式（半径表是惰性初始化的，不切模式拿不到 cylinders） */
      setMode: (m: 'skeleton' | 'skin') => binding?.setEditModeForAutomation(m),
      redraw: () => {
        binding?.resize();
        return true;
      },
    };

    /**
     * 动画钩子：无头冒烟直接喂 BVH 文本，绕过 file input（headless 里没法点）。
     *
     * 两条路都要能验证：
     *   · `load(text, name)`           → 绑到面板当前的 T-pose（对应面板「载入 BVH…」）
     *   · `applyTo(index, text, name)` → 直接挂到场景物体（对应层级右键「应用动画」）
     */
    hook.anim = {
      /** 当前缓存的重定向报告；没载入过为 null */
      report: () => animReport,
      /** 当前缓存的片段名 / 帧数；没载入过为 null */
      info: () =>
        animClip === null
          ? null
          : { name: animClip.name, frames: animClip.times.length, bones: Object.keys(animClip.rotations).length, hasRoot: animClip.translation !== null },
      load: (text: string, name = 'clip') => loadBvhForBinding(text, name),
      applyTo: (index: number, text: string, name = 'clip') => {
        const obj = renderer.state.objects[index];
        if (obj === undefined) return null;
        return loadBvhForObject(text, name, obj);
      },
      /** 导出带动画的 GLB 走一遍全流程（不落盘），返回统计供断言；与用户导出同守门 */
      exportDryRun: async () => {
        if (binding === null) return null;
        const c = guardedAnimForConsumption();
        if (c === null) return null;
        const anim: BindAnimationInput = {
          name: c.name,
          times: c.times,
          rotations: c.rotations,
          translation: c.translation,
        };
        return await exportBound(binding.currentFit(), anim, false, '_anim');
      },
      /** 场景物体当前的片段数与正在播的片段下标 */
      objectClips: (index: number) => {
        const obj = renderer.state.objects[index];
        if (obj === undefined || obj.skinState === null) return null;
        return {
          clips: obj.skinState.clips.length,
          clip: obj.skinState.clip,
          playing: obj.skinState.playing,
          tracks: obj.skinState.clips[obj.skinState.clip]?.tracks.length ?? 0,
        };
      },
      clear: () => {
        clearAnim();
        binding?.setAnimationInfo(null);
      },
      /**
       * 重定向会话（MR-06）钩子：状态汇总 / 失效标记 / 重新求解。
       * 与 load/applyTo 共用同一条会话路径——自动化断言的就是用户路径本身。
       */
      session: {
        summary: () => retargetSession.summary(),
        stale: () => retargetSession.isStale(),
        solve: () => {
          solveAndRefresh();
          return retargetSession.summary();
        },
        frameView: (f: number) => retargetSession.resultFrameView(f),
      },
    };
  }

  let assetPreview: AssetPreview | null = null;
  // 预览缓存提到块外：动画应用要往缓存里的 model.animations 追加片段
  const previewCache = new Map<string, GltfResult>();
  const inspectorEl = document.querySelector<HTMLElement>('#inspector .insp-pane[data-pane="asset"] .ai-host');
  const previewHostEl = document.getElementById('asset-preview-host');
  const dockEl = document.getElementById('asset-dock');
  if (inspectorEl !== null && dockEl !== null) {
    const inspector = new AssetInspector(inspectorEl, {
      onSpawn: (p) => void spawnAssetAt(p, null),
    });
    assetPreview = previewHostEl !== null ? new AssetPreview(previewHostEl, gpu) : null;

    // 资产库预览缓存：避免反复 fetch + 解析 GLB（贴图仍每次重新解码，因 ImageBitmap 已被 close）
    async function previewAsset(sel: AssetSelection): Promise<void> {
      if (sel.entry.kind !== 'file' || !sel.entry.ext.toLowerCase().endsWith('.glb')) {
        assetPreview?.clear();
        return;
      }
      try {
        let model = previewCache.get(sel.path);
        if (model === undefined) {
          const resp = await fetch(`/__fs/file?path=${encodeURIComponent(sel.path)}`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const buffer = await resp.arrayBuffer();
          model = parseGlb(buffer, MODEL_RULER_HEIGHT_M);
          previewCache.set(sel.path, model);
        }
        const bmp = model.image === null ? null : await decodeTexture(model.image, sel.path);
        await assetPreview?.load(model, bmp);
      } catch (err) {
        console.error('[资产库] 预览解析失败', sel.path, err);
      }
    }

    const assets = new AssetBrowser(dockEl, {
      onSelect: (sel) => {
        lastAssetPath = sel === null ? null : sel.path;
        if (sel === null) {
          inspector.clear();
          assetPreview?.clear();
        } else {
          inspector.showAsset(sel);
          switchInspectorTab('asset');
          void previewAsset(sel);
        }
      },
      onSpawn: (p) => void spawnAssetAt(p, null),
      onRename: async (path, newName) => {
        const r = await renameProjectEntry(path, newName);
        if (!r.ok) {
          panel.setModelInfo(`重命名失败：${r.error ?? '未知错误'}`);
          hudDirty = true;
          return false;
        }
        const extras: string[] = [];
        if (r.metaRenamed) extras.push('sidecar 已随迁');
        if (r.projectUpdated) extras.push('场景登记已更新');
        panel.setModelInfo(`已重命名 → ${r.path}${extras.length > 0 ? `（${extras.join('，')}）` : ''}`);
        hudDirty = true;
        return true;
      },
      // 右键条目 → 统一菜单（与层级面板共用一套 DOM）。上面三段是编辑器动作，
      // 分隔线以下是通用文件动作（复制路径 / 重命名 / 资源管理器定位）。只有 .glb 才给「进入绑定」
      onContextMenu: (path, entry, x, y) => {
        const isGlb = entry.kind === 'file' && entry.ext.toLowerCase() === '.glb';
        openCtxMenu(x, y, [
          {
            label: isGlb ? '进入绑定 Binding…' : '进入绑定 Binding…（仅 .glb）',
            disabled: !isGlb,
            run: () => void bindAssetAt(path),
          },
          {
            // rigged GLB 桥：把文件内嵌 skin 的骨架摆位灌进会话再加工；
            // 纯网格点这个会在打开前收到明确报错（不静默退化成模板模式）
            label: isGlb ? '进入绑定 Binding…（导入文件骨架）' : '进入绑定 · 导入文件骨架（仅 .glb）',
            disabled: !isGlb,
            run: () => void bindAssetAt(path, { importSkeleton: true }),
          },
          {
            label: isGlb ? '载入场景 Spawn' : '载入场景 Spawn（仅 .glb）',
            disabled: !isGlb,
            run: () => void spawnAssetAt(path, null),
          },
          { label: '', separator: true, run: () => {} },
          {
            label: '复制相对路径 Copy Relative Path',
            run: () => {
              void (async () => {
                const ok = await copyText(path);
                panel.setModelInfo(ok ? `已复制相对路径：${path}` : '复制失败（剪贴板不可用）');
                hudDirty = true;
              })();
            },
          },
          {
            label: '复制绝对路径 Copy Absolute Path',
            run: () => {
              void (async () => {
                const info = await fetchAssetInfo(path);
                if (!info.ok) {
                  panel.setModelInfo(`取绝对路径失败：${info.error ?? '未知错误'}`);
                  hudDirty = true;
                  return;
                }
                const ok = await copyText(info.abs);
                panel.setModelInfo(ok ? `已复制绝对路径：${info.abs}` : '复制失败（剪贴板不可用）');
                hudDirty = true;
              })();
            },
          },
          {
            label: '重命名 Rename…',
            run: () => {
              if (!assets.beginRename(path)) {
                panel.setModelInfo('重命名：条目当前不可见（可能被筛选隐藏），先清除筛选再试');
                hudDirty = true;
              }
            },
          },
          {
            label: '在资源管理器中显示 Reveal in Explorer',
            run: () => {
              void (async () => {
                const r = await revealInFileManager(path);
                if (!r.ok) {
                  panel.setModelInfo(`打开文件位置失败：${r.error ?? '未知错误'}`);
                  hudDirty = true;
                }
              })();
            },
          },
        ]);
      },
    });

    // 画布接收资产拖放：落点 = 视线与地面 y=0 的交点（落不出地面就退回原点）
    canvas.addEventListener('dragover', (e) => {
      if (e.dataTransfer !== null && e.dataTransfer.types.includes(ASSET_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    canvas.addEventListener('drop', (e) => {
      const rel = e.dataTransfer?.getData(ASSET_MIME);
      if (rel === undefined || rel === '') return;
      e.preventDefault();
      if (!rel.toLowerCase().endsWith('.glb')) {
        panel.setModelInfo('只有 .glb 模型能拖入场景（其他资产在右侧 Inspector 里预览）');
        hudDirty = true;
        return;
      }
      let pos: [number, number, number] = [0, 0, 0];
      const ray = renderer.pointerRay(e.clientX, e.clientY);
      if (ray !== null && ray.d[1] < -1e-4) {
        const t = -ray.o[1] / ray.d[1];
        pos = [
          clamp(ray.o[0] + ray.d[0] * t, -PAN_LIMIT_XZ, PAN_LIMIT_XZ),
          0,
          clamp(ray.o[2] + ray.d[2] * t, -PAN_LIMIT_XZ, PAN_LIMIT_XZ),
        ];
      }
      void spawnAssetAt(rel, pos);
    });

    // 自动化钩子扩展：无头 CDP 验证直接驱动资产库
    const hook = (window as unknown as { __editor: Record<string, unknown> }).__editor;
    hook.assets = assets;
    hook.inspector = inspector;
    hook.preview = assetPreview;
    hook.previewShow = (p: string) => {
      const base = p.split('/').pop() ?? p;
      const dot = base.lastIndexOf('.');
      const ext = dot >= 0 ? base.slice(dot).toLowerCase() : '';
      void previewAsset({
        entry: { name: base, kind: 'file', size: 0, mtime: 0, ext },
        path: p,
      });
    };
    hook.spawnAsset = (p: string, pos?: [number, number, number]) => void spawnAssetAt(p, pos ?? null);
    // 无头冒烟 / 自动化钩子需要直接摸到渲染器（对象列表、字符槽），否则只能绕 UI 后门。
    // renderer 在初始化钩子对象里已经挂过一次（简写属性），这里**不要重复赋值** ——
    // 两处指向同一个键，改一处会让人以为另一处是新的真源。

    // 主视图骨骼 X-ray 开关（gizmo-bar 上的「骨骼 X」按钮）
    const xrayBtn = document.querySelector<HTMLButtonElement>('#gizmo-bar .gz-xray');
    if (xrayBtn !== null) {
      xrayBtn.addEventListener('click', () => {
        const on = !xrayBtn.classList.contains('active');
        xrayBtn.classList.toggle('active', on);
        assetPreview?.setSkeletonVisible(on);
        renderer.setSkeletonVisible(on);
      });
    }
  }

  // ---- 尺寸 ----
  const resize = (): void => {
    renderer.resize(
      Math.max(1, Math.round(canvas.clientWidth * dpr())),
      Math.max(1, Math.round(canvas.clientHeight * dpr())),
    );
    hudDirty = true;
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  // ---- HUD ----
  const updateHud = (fps: number): void => {
    const p = panel.params;
    const s = renderer.stats;
    const gap = Math.abs(p.keyElevation - p.cameraElevation);
    const name = DEBUG_OPTIONS.find((o) => o.value === p.debugMode)?.label ?? '';

    const rows: string[] = [
      `<b>FPS</b> ${fps.toFixed(0)}`,
      `<b>画布</b> ${s.width}×${s.height}`,
      `<b>Draw</b> ${s.drawCalls}　<b>Tri</b> ${(s.triangles / 1000).toFixed(1)}k`,
      `<b>顶面 NdotL</b> ${Math.sin((p.keyElevation * Math.PI) / 180).toFixed(2)}　` +
        `<b>立面</b> ${frontNdotL(p, camera).toFixed(2)}`,
      `<b>视图</b> ${name}`,
      `<b>GPU</b> ${gpu.info.vendor || '?'} ${gpu.info.architecture || ''}`,
    ];

    const selName = renderer.selectedName();
    const subName = renderer.selectedSubName();
    if (selName !== null) {
      rows.push(
        `<b>选中</b> <span style="color:#FFC531;font-weight:700">${selName}` +
          `${subName !== null ? ` › ${subName}` : ''}</span>` +
          `　<span class="hint">拖 gizmo 手柄变换 · 双击/F 聚焦 · Delete 删除 · 顶部工具栏或 W/E/R 切换</span>`,
      );
    } else {
      rows.push('<b>选中</b> 无（轻点选中 · Alt+点击穿透嵌套 · 双击/F 聚焦 · 拖拽/单指环绕 · 右键/双指平移 · 滚轮/捏合缩放）');
    }

    if (gap < 15) {
      rows.push(
        `<span class="warn">⚠ 主光与视线夹角仅 ${gap.toFixed(0)}°，角色会平成一整块色</span>`,
      );
    }
    if (p.rimIntensity < 0.2 && p.keyIntensity < 0.8) {
      rows.push('<span class="warn">⚠ 暗场 + rim 不足：深色敌人会消失在背景里</span>');
    }
    if (p.halftoneStrength > 0.25) {
      rows.push('<span class="warn">⚠ 半调强度 &gt; 0.25，会从印刷质感变成波普艺术</span>');
    }

    // ---- 运行时状态（WU-4）----
    const st = playCtl.state;
    const badge =
      st === 'playing'
        ? '<span style="color:#7FE03F;font-weight:700">● PLAYING</span>'
        : st === 'paused'
          ? '<span style="color:#FFC531;font-weight:700">❚❚ PAUSED</span>'
          : '<span class="hint">■ 已停止（空格进入 Play）</span>';
    // 实例数**常驻显示**（停止态也要显示 0）：它是「动态批次有没有真的从渲染侧
    // 摘干净」的唯一可见指标，只在 Play 中显示的话，Stop 后泄漏根本看不出来。
    rows.push(
      `<b>运行时</b> ${badge}　<b>启停</b> ${playCtl.session.cycleCount} 次　` +
        `<b>实例</b> ${renderer.debugDynamicInstanceCount()}`,
    );

    if (playCtl.isPlaying) {
      const ents = bridge.entities;
      const npc = ents.filter((e) => e.kind === 'npc').length;
      rows.push(
        `<b>tick</b> ${playCtl.tick}　` +
          `<b>实体</b> ${ents.length}（NPC ${npc}）　` +
          `<span class="hint">动态实体走独立 instancing，不占静态 64 槽位</span>`,
      );
      const sel = bridge.selectedEntity;
      if (sel !== null) {
        rows.push(
          `<b>实体选中</b> <span style="color:#FFC531;font-weight:700">${sel.characterId}</span>` +
            `　槽位 ${sel.id}·代 ${sel.generation}　来源 ${sel.sourceNodeId ?? '—'}` +
            `　目标 ${sel.targetId >= 0 ? sel.targetId : '—'}　(${sel.x.toFixed(1)}, ${sel.z.toFixed(1)})`,
        );
      }
      for (const d of playCtl.diagnostics) {
        if (d.severity === 'warning') rows.push(`<span class="warn">⚠ 运行时：${d.message}</span>`);
      }
    } else if (playCtl.error !== null) {
      rows.push(`<span class="warn">⚠ 无法进入 Play：${playCtl.error}</span>`);
    }

    hud.innerHTML = rows.join('<br>');
  };

  // ---- 主循环 ----
  // HMR 会整页替换这个模块。旧模块的 requestAnimationFrame 链不会自动停，
  // 不主动断掉就会在已 destroy 的渲染器上继续 render → 每帧抛错刷屏。
  let disposed = false;
  if (import.meta.hot !== undefined) {
    import.meta.hot.dispose(() => {
      disposed = true;
      renderer.destroy();
    });
  }

  let fps = 60;
  let frames = 0;
  let hudTimer = 0;
  let elapsed = 0;
  let last = performance.now();

  const frame = (now: number): void => {
    if (disposed) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    elapsed += dt;
    frames++;
    hudTimer += dt;

    if (hudTimer > 0.4 || hudDirty) {
      if (hudTimer > 0.001) fps = frames / hudTimer;
      frames = 0;
      hudTimer = 0;
      hudDirty = false;
      updateHud(fps);
    }

    if (panel.params.autoOrbit) {
      camera.yaw += dt * 0.25;
      hudDirty = true;
    }

    // 聚焦动画：easeOutCubic 平滑过渡 target 与 distance
    if (focusAnim !== null) {
      focusAnim.t += dt;
      const k = Math.min(1, focusAnim.t / focusAnim.dur);
      const e = 1 - Math.pow(1 - k, 3);
      camera.target[0] = lerp(focusAnim.fromT[0], focusAnim.toT[0], e);
      camera.target[1] = lerp(focusAnim.fromT[1], focusAnim.toT[1], e);
      camera.target[2] = lerp(focusAnim.fromT[2], focusAnim.toT[2], e);
      camera.distance = lerp(focusAnim.fromD, focusAnim.toD, e);
      hudDirty = true;
      if (k >= 1) focusAnim = null;
    }

    // ── 蒙皮包裹器圆柱体（Skin Wrapper）主 3D 视口叠加 ──
    // 几何由 binding 模块按「本帧实时关节矩阵」算出来（随骨骼动画实时更新），
    // 渲染器只负责画 —— 它完全不认识绑定语义。
    const bp = binding;
    if (bp !== null && bp.getViewportCylinders()) {
      const src = renderer.getSkeletonOverlaySource();
      renderer.setCylinderOverlay(
        src === null
          ? null
          : buildCylinderOverlay(
              src.jointMatrices,
              src.skeleton,
              src.modelMatrix,
              bp.getCylinders(),
            ),
      );
    } else {
      renderer.setCylinderOverlay(null);
    }

    // ── 运行时推进 + 动态实例注入（WU-3 / WU-4） ──
    // playCtl.update 内部走 PlaySession 的固定步累加器：渲染帧率不决定游戏步数，
    // 且只在 playing 状态推进（暂停就是真的停）。
    // 玩家输入装配（复审 #7）：宿主把箭头键状态转成约定的运行输入向量，
    // 每帧喂给会话；runtime 在固定步里消费。俯视世界轴向：↑ = -z，→ = +x。
    if (playCtl.isPlaying) {
      const ix = (playKeys.has('arrowright') ? 1 : 0) - (playKeys.has('arrowleft') ? 1 : 0);
      const iz = (playKeys.has('arrowdown') ? 1 : 0) - (playKeys.has('arrowup') ? 1 : 0);
      playCtl.session.setInput(ix, iz);
    }
    playCtl.update(dt);
    renderer.setDynamicBatches(bridge.batches());
    // 运行期诊断必须有消费者，否则"容量不足整批不生成"在 UI 上依旧是一片寂静，
    // 跟没产出这个信号没有区别（AGENTS.md §2.2：不静默）。
    drainRuntimeDiagnostics();

    renderer.render(panel.params, camera, elapsed, dpr());
    panel.tickAnimation();
    assetPreview?.tick(dt, elapsed, panel.params);
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

void boot().catch((err: unknown) => {
  showFatal('启动异常', `<p>${String(err)}</p>`);
});
