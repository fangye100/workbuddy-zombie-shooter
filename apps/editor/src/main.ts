import { GameControls } from './services/game-controls';
import { GpuUnavailableError, initGpu, type GpuContext } from '@aether/gfx';
import { LabRenderer, type CameraState, type SceneObject } from './renderer';
import { Panel } from './ui';
import * as m4 from '@aether/core';
import { axisPlaneNormal, rotatePlaneBasis, angleInPlane, wrapAngle } from './gizmo';
import { DEBUG_OPTIONS, defaultParams, type LabParams } from './params';
import { MODEL_RULER_HEIGHT_M, resolveModelHeightM, resolveAssetImportHeightM, assetServer } from './models';
import { parseGlb, SceneGraph, parseAssetManifest, formatLodStats, findRiggedCharacterIds } from '@aether/scene';
import type { EditorCameraData, EnvironmentData, GltfResult, SceneDocument, NodeId, LodFamily, ScriptComponent } from '@aether/scene';
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
import type { ScatterComparison, ScatterFingerprint } from '@aether/runtime';
import { AuthorTransformController, graphOfDoc } from './services/author-transform';
import { AuthorAssetController, assetSceneNode } from './services/author-asset';
import { AuthorSceneSaver } from './services/author-scene-save';
import { SceneAuthorPanel } from './services/scene-author-panel';
import { RuntimeMotionPanel } from './services/runtime-motion-panel';
import { materialSnapshot, applyMaterialChanges, lightSnapshot, applyLightChanges } from './services/author-projection';
import { applySceneLightParams } from './services/scene-light';
import { removeNodeTree } from '@aether/runtime';
import { SpawnPanel } from './services/spawn-panel';
import { behaviorRegistry, createBehaviorExecutor } from './services/behavior-host';
import { ScriptPanel } from './services/script-panel';
import { AssetBrowser } from './asset-browser';
import { AssetInspector } from './asset-inspector';
import { AssetPreview } from './services/asset-preview';
import { resolveStartScenePath } from './scene-boot';
import { EditorMenu } from './services/editor-menu';
import { readSceneChoices, nextPlayableScene, sceneUrl } from './services/scene-workspace';
import { GameHud } from './services/game-hud';
import { RunTransfer } from './services/run-transfer';
import { RunProfile } from './services/run-profile';
import { RunSettlement } from './services/run-settlement';
import { renderPixelRatio } from './services/render-resolution';
import { environmentFromParams } from './services/scene-environment';
import { AtmospherePanel } from './services/atmosphere-panel';
import { EditorAgent, connectEditorAgent } from './services/editor-agent';
import { RuntimeBridge } from './services/runtime-bridge';
import { ActorLibrary } from './services/runtime-actors';
import { PlayController } from './services/play-controller';
import { PlayerPresentation } from './services/player-presentation';
import { SharedMotionRuntime } from './services/shared-motion-runtime';
import { RuntimeSceneMotion } from './services/runtime-scene-motion';
import { RuntimeBodyIk } from './services/runtime-body-ik';
import { BodyIkPanel } from './services/body-ik-panel';
import { BindingPanel } from './services/binding/binding-panel';
import { BindingPersistence } from './services/binding/binding-persistence';
import { CharacterBindingBar, characterBindingChoices } from './services/binding/character-binding-bar';
import { refreshAuthorResources, renamedResourcePath } from './services/resource-rename';
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
import { makeSplitter, restoreCssVar, readCssVarPx } from './splitter';
import { t, setLang, getLang, applyStaticI18n } from './i18n';
import { createSkinState, selectClip, play, pause, seek, bakeProfileForTier } from '@aether/render';
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
import { FREE_CAM_SPEED_MPS, stepFreeCamera } from './services/free-camera';

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
  let nativeResolution = false;
  if (canvas === null || groups === null || hud === null) {
    showFatal('页面结构异常', '缺少 #gpu / #groups / #hud 节点。');
    return;
  }

  const renderCanvas = canvas;
  const dpr = (): number => renderPixelRatio(renderCanvas.clientWidth, renderCanvas.clientHeight, window.devicePixelRatio, nativeResolution);

  // 多语言：index.html 里写死的静态文案（顶栏按钮 / dock 标题 / 占位符）在面板
  // 构建前先翻一遍；面板与菜单文案在各自代码里走 t()。
  applyStaticI18n(document.body);
  hud.hidden = true;
  document.getElementById('topbar')!.after(document.getElementById('gizmo-bar')!);
  // 语言切换按钮：gizmo-bar 尾部的「中/EN」。切换 = 持久化 + 整页刷新（见 i18n.ts）
  document.querySelector<HTMLButtonElement>('[data-lang-toggle]')?.addEventListener('click', () => {
    setLang(getLang() === 'zh' ? 'en' : 'zh');
  });

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
   * 运行时真角色装配库（docs/20 §5，P4 M2）：按需加载 rigged_animated GLB、
   * 烘焙姿态调色板。编辑器侧服务——runtime 保持纯 CPU，GPU 资源归 core。
   * 清单异步后补（编辑器启动时 manifest 尚未到位），到位前 preload 一律退胶囊。
   */
  const actorLib = new ActorLibrary(null);
  const sharedMotionLibrary = new SharedMotionRuntime();
  actorLib.setSharedMotions(sharedMotionLibrary);
  const sceneMotions = new RuntimeSceneMotion(sharedMotionLibrary, nodeId => {
    const index = renderer.findObjectIndexByNodeId(nodeId);
    return index === null ? null : renderer.state.objects[index] ?? null;
  }, () => { hudDirty = true; });
  const bodyIk = new RuntimeBodyIk(nodeId => {
    const index = renderer.findObjectIndexByNodeId(nodeId);
    return index === null ? null : renderer.state.objects[index] ?? null;
  }, path => sharedMotionLibrary.assetMeta(path), nodeId => {
    const index = renderer.findObjectIndexByNodeId(nodeId);
    return index === null ? null : renderer.state.objects[index]?.pos ?? null;
  }, height => gameControls?.targetWorld(height) ?? null, () => { hudDirty = true; });
  /** manifest 原始 JSON：kickActorPreload 从它派生预载清单（findAnimatedCharacterIds） */
  let assetManifest: unknown = null;
  const manifestReady = (async () => {
    // 烘焙档位（P4 M4）：真源是项目文件的 render.targetTier，先于任何 preload 拿到 ——
    // 否则先按默认桌面档烘完再改档位，已装配的角色不会重烘（显存没省下来）。
    const proj = await readProjectFile('aether.project.json');
    if (proj.ok) {
      const tier = (proj.json as { render?: { targetTier?: string } })?.render?.targetTier;
      actorLib.setBakeProfile(bakeProfileForTier(tier));
      console.log(`[actors] 烘焙档位 targetTier=${tier ?? '缺省'} →`, actorLib.bakeProfile);
    } else {
      console.warn(`[actors] 项目文件读不到，烘焙走默认档：${proj.error ?? '?'}`);
    }

    const r = await readProjectFile('assets/_data/asset-manifest.json');
    if (r.ok) {
      assetManifest = r.json;
      actorLib.setManifest(r.json);
    } else console.warn(`[actors] 资产清单加载失败，Play 全部退胶囊：${r.error ?? '?'}`);
  })();

  /**
   * 运行时桥（WU-3）：headless 会话与渲染之间的**唯一**翻译层。
   * 它不产玩法，只把实体视图翻译成实例批次；真模型接进来后换代理网格即可。
   */
  const bridge = new RuntimeBridge(actorLib);

  /**
   * Play 控制器（WU-4）：只做装配 —— 快照/恢复作者态、把推进同步给 Bridge、
   * 通知 UI。状态机本体在 `PlaySession`（runtime 包，纯 CPU 可测）。
   *
   * 这里**不自动进入 Play**：编辑器打开就该是编辑态，跑起来要用户显式点 ——
   * 否则每次改完参数刷新页面都会被"已经在跑的世界"干扰判断。
   */
  /** 上次已提示过的会话终态（'running' 之外只提示一次；Stop 复位） */
  let lastOutcomeShown: string = 'running';
  const playCtl = new PlayController(renderer, bridge, {
    bodyIk,
    sharedMotions: sceneMotions,
    playerPresentation: new PlayerPresentation(nodeId => {
      const index = renderer.findObjectIndexByNodeId(nodeId);
      return index === null ? null : renderer.state.objects[index] ?? null;
    }),
    // 行为执行器由宿主注入（ADR-018 R3）：runtime 不 import 行为代码，
    // 编辑器把"去哪儿找 behaviors/*.ts"这件事自己扛下来。
    executor: createBehaviorExecutor(),
    // 主视图相机（ADR-018 P6）。
    // 🔴 必须写成**闭包**：camera 对象与 panel.params 都定义在后面（相机在 407 行附近），
    // 这里直接读值会踩 TDZ。Play 只在用户点击后触发，那时都已初始化，闭包是安全的。
    viewCamera: {
      get: () => ({
        target: [camera.target[0], camera.target[1], camera.target[2]] as [number, number, number],
        distance: camera.distance,
        yaw: camera.yaw,
        elevationDeg: panel.params.cameraElevation,
      }),
      set: (s) => {
        camera.target[0] = s.target[0];
        camera.target[1] = s.target[1];
        camera.target[2] = s.target[2];
        camera.distance = s.distance;
        camera.yaw = s.yaw;
        panel.params.cameraElevation = s.elevationDeg;
      },
    },
    worldPosOf: (nodeId) => {
      const doc = renderer.getDocument();
      if (doc === null) return null;
      const n = graphOfDoc(doc).getNode(nodeId);
      if (n === null) return null;
      return [n.world.position[0], n.world.position[1], n.world.position[2]] as [number, number, number];
    },
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
  const runTransfer = new RunTransfer();
  const runProfile = new RunProfile(localStorage);
  let playAuthorParams: LabParams | null = null;
  function startPlay(): boolean {
    if (authorProjectionBusy) { editorMenu.message('场景正在更新，请稍后再播放'); return false; }
    if (sceneAuthorPanel.hasDraft || atmospherePanel.hasDraft) { editorMenu.message('请先应用或放弃表单修改'); return false; }
    if (renderer.pendingAssetCount > 0 || renderer.getSceneSource() === null) {
      editorMenu.message('场景或资产尚未加载完成，请稍后再播放'); return false;
    }
    // 进 Play 前强制退出自由相机：Play 的相机归 PlayCameraController（场景 Camera 组件），
    // 飞行模式会继续每帧写 camera，两套机位抢同一个对象 —— 用户只会看到"游戏相机乱飘"。
    if (freeCamOn) setFreeCam(false);
    focusAnim = null;
    pointers.clear();
    const paramsBeforePlay = structuredClone(panel.params);
    actorLib.beginPlay();
    const ok = playCtl.start();
    if (ok) {
      playAuthorParams ??= paramsBeforePlay;
      try {
        const progress = playCtl.session.runtime?.progress;
        if (progress) progress.setUnlocked(runProfile.read(progress.rules.campaign).unlocked);
        const carry = runTransfer.read(renderer.getSceneSource()!.url);
        if (carry && !playCtl.session.runtime?.restoreRun(carry)) throw new Error('跨层成长存档不符合当前场景规则');
      } catch (error) {
          stopPlay(false); runTransfer.retryRead(); editorMenu.message(String(error)); return false;
      }
      shownRuntimeDiags.clear();
      // 🔴 已缓存角色的调色板**同步**重传：attach() 会同步重建 actor 批次
      //（ActorLibrary CPU 缓存命中），若只等 kickActorPreload 的异步链路，
      // 头几帧 flags=1 的实例会绑着哑 palette 越界读全零 → 模型闪塌
      //（PR #18 review 抓的窗口）。新角色的加载与追加上传仍走异步路径。
      const cached = actorLib.buildPalette();
      if (cached !== null) renderer.setDynamicPalette(cached);
      kickActorPreload();
    } else {
      editorMenu.message(`${t('无法启动')}：${playCtl.error ?? t('场景装载失败')}`);
    }
    return ok;
  }

  /**
   * Play 期真角色装配（docs/20 M2/M3）：预载**全部**带「+动画」档的角色（清单
   * 从 manifest 数据派生，禁手抄——手抄 = 第二真源）。不阻塞 Play——加载完成前
   * 实体照画胶囊，完成后 `notifyActorsChanged()` 原地换真模型；单角色失败独立
   * warn 退胶囊（ActorLibrary.preload 内建）。代次守卫（PR #19 FR-A）：每次启动 +1、
   * stopPlay 也 +1，旧循环核对代次失配即作废——替换旧的布尔防重入（布尔会把
   * Stop 后应立刻启动的新循环也挡在外面）。
   */
  let actorPreloadGen = 0;
  async function kickActorPreload(): Promise<void> {
    const gen = ++actorPreloadGen;
    try {
      // 🔴 先等清单到位：页面刚 reload 就点 Play 的竞态下，manifest 尚未 fetch 完，
      // preload 会因清单为 null 直接跳过（不记失败）——这里等它，装配就不会被吞。
      await manifestReady;
      // 🔴 串行 await：paletteBase 布局由库内 manifest rank 规范序保证（PR #19
      // FR-B），与本循环的完成序无关；串行只是控制并发与失败可读性。
      for (const id of findRiggedCharacterIds(assetManifest)) {
        if (gen !== actorPreloadGen) return; // 新循环已启动 / 已 Stop：本循环作废
        const changed = await actorLib.preload(id);
        if (gen !== actorPreloadGen) {
          // 跨 Stop/新 Play 边界的迟到结果：成功注册无害（CPU 缓存，新轮 startPlay
          // 同步重传直接命中）；但**迟到失败**会把 id 写回 failed、让新轮跳过它
          // ——单角色清除，封死跨边界污染（FR-A）
          actorLib.resetFailure(id);
          return;
        }
        // 迟到保护：fetch/烘焙飞行期间用户已 Stop 的话不再上传——否则新 palette
        // buffer 悬挂到下一轮 Play/Stop，违反「Stop 释放全部 Play 期 GPU 资源」
        //（AGENTS.md §2.4）。已缓存角色的重传由 startPlay 的同步路径负责，
        // 这里只处理新装配角色（changed = true）的追加上传。Stop 后继续把剩余
        // 角色装配进 CPU 缓存是安全的（下次 Play 直接命中，不产生 GPU 副作用）。
        if (!changed || playCtl.state === 'stopped') continue;
        const pal = actorLib.buildPalette();
        if (pal !== null) {
          renderer.setDynamicPalette(pal);
          bridge.notifyActorsChanged();
        }
      }
    } finally {
      // 不复位任何状态：代次模型下旧循环自然终止，新循环随时可启动
    }
  }

  /** 同种子重跑（**所有入口共用**）：runId 换代，去重集合同样要清空 */
  function resetPlay(): void {
    runTransfer.restart();
    playCtl.reset();
    const progress = playCtl.session.runtime?.progress;
    if (progress) {
      try { progress.setUnlocked(runProfile.read(progress.rules.campaign).unlocked); }
      catch (e) { stopPlay(); editorMenu.message(String(e)); }
    }
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
      editorMenu.message(spawnMsg.text);
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
      btnPlay.textContent = st === 'paused' ? `▶ ${t('继续')}` : '▶ Play';
    }
    if (btnPause !== null) {
      btnPause.disabled = !playing;
      btnPause.classList.toggle('active', st === 'paused');
      btnPause.textContent = st === 'paused' ? `⏸ ${t('已暂停')}` : `⏸ ${t('暂停')}`;
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
  const switchInspectorTab = (tab: 'inspector' | 'scene' | 'render' | 'asset'): void => {
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
      if (tab === 'inspector' || tab === 'scene' || tab === 'render' || tab === 'asset') {
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

  // ---- 场景层级 Hierarchy ----
  // 点到 mesh 子节点时连子网格一起选中：材质面板的作用对象就是它，描边也只描那一段
  panel.onHierarchySelect = (index, subIndex) => {
    renderer.selectObject(index, subIndex);
    panel.setSelection(index, subIndex);
    switchInspectorTab('inspector');
    refreshSpawnPanel(); // 同上：层级点选也是选中变化，脚本分组要跟着重算
    hudDirty = true;
  };
  // 功能体（✦）行点选：与物体选中互斥，切到检视页显示对应属性分组（当前唯一功能体 = 刷怪点）
  panel.onFunctionalSelect = (node) => {
    if (node === null) {
      spawnSelActive = false;
      panel.setFunctionalSelection(null);
      refreshSpawnPanel();
      return;
    }
    selectedSpawnNode = node.nodeId;
    renderer.selectObject(null); // 物体选中与功能体选中互斥
    panel.setSelection(null); // 会触发 onFunctionalDeselect 清 flag，随后再立起
    spawnSelActive = true;
    panel.setFunctionalSelection(node.nodeId);
    switchInspectorTab('inspector');
    refreshSpawnPanel();
    hudDirty = true;
  };

  // 物体选中挤掉功能体选中（ui.setSelection → onFunctionalDeselect）：收属性分组
  panel.onFunctionalDeselect = () => {
    spawnSelActive = false;
    refreshSpawnPanel();
  };
  panel.onHierarchyToggle = (index, visible) => {
    const id = renderer.getObjectNodeId(index);
    if (id) editAuthorNodes('节点显隐', nodes => { nodes.find(n => n.id === id)!.visible = visible; }, true);
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
    deleteAuthorObject(index);
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

  // 模型进场景的唯一入口是底部资产库（双击/拖入 .glb）；「模型预览」面板与
  // setCharacter 角色槽路径已于 2026-09-23 布局改造收掉（槽位假设在场景化世界会错伤场景物体）。
  // 顶栏状态行初始为空：只在真的有操作反馈（复制/重命名/拦截提示…）时才出现文字。

  // 默认取景：target 落在角色身上才能居中构图，而不是看向角色前方的空地
  const DEFAULT_VIEW = { yaw: 0.35, distance: 9, target: [0, 0.95, 0] as [number, number, number] };
  const camera: CameraState = {
    yaw: DEFAULT_VIEW.yaw,
    distance: DEFAULT_VIEW.distance,
    target: [...DEFAULT_VIEW.target],
  };

  // 调试/自动化钩子：控制台与无头 CDP 验证直接读写相机/材质状态（都是引用，读到即实时值）
  (window as unknown as { __editor: unknown }).__editor = {
    motions: {
      summary: () => sceneMotions.summary(),
      setState: (nodeId: string, state: string) => sceneMotions.setState(nodeId, state),
    },
    bodyIk: {
      summary: () => bodyIk.summary(),
      setWeight: (nodeId: string, controlId: string | null, weight: number) => bodyIk.setWeight(nodeId, controlId, weight),
    },
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
      redo: () => reportAuthorTransform(authorTransform.history(true)),
    },
    /**
     * Play 控制器（P5 C5 战斗探针用）：state / outcome / session（setFire /
     * applyDamage / combatEvents）。只读断言与确定性输入注入，不代替 UI 操作。
     */
    playCtl,
    /**
     * 行为注册表面（**自动化防线用**，不是调试便利）。
     *
     * 🔴 为什么必须暴露：`behavior-host.ts` 用 `import.meta.glob` 收集行为脚本，
     * 一旦 glob 零命中（绝对路径在 vite 下按 root=apps/editor 解析 → 目录不存在），
     * 注册表就是**空的，而 typecheck 与 vitest 全绿**（vitest 的 root 是仓库根，
     * 同一行路径解析结果不同）。2026-10-02 这事真实发生过：行为脚本从第一天起
     * 就没注册上，能力一直是空转，只有人手工开浏览器才看得见。
     *
     * 所以冒烟必须有一条「注册表非空」的硬断言 —— 它抓的是"编辑器断、测试绿"
     * 这类宿主分裂，别的门禁都抓不到。
     */
    behaviors: () => ({
      size: behaviorRegistry.size,
      ids: behaviorRegistry.list().map((m) => m.id),
      schemaIssues: behaviorRegistry.schemaDiagnostics.length,
    }),
    /**
     * 当前帧率读数（P4 M4 压测探针用）。
     * 与 HUD 同源的**同一个变量**，探针不另算一份 —— 否则"HUD 显示 60、探针报 45"
     * 这种分歧会让人分不清谁对。闭包延迟求值（fps 定义在本对象之后）。
     */
    fps: () => fps,
    /** 烘焙档位（P4 M4 mobile 档的证据面：压测时能看到当前跑的是哪一档） */
    bakeProfile: () => actorLib.bakeProfile,
    /**
     * 自由相机的可验证面（冒烟 K 段用）。
     * 读的是**同一份**状态变量，不是另开一路 —— 否则"按钮亮着但没进模式"查不出来。
     */
    freeCam: () => ({ on: freeCamOn, speed: freeCamSpeed }),
    setFreeCam,
    /**
     * 运行时真角色装配库（docs/20 M2）。冒烟断言「动态蒙皮已激活」用：
     * Play 后 `actorLib.size > 0` 且 `renderer.debugDynamicMeshIds()` 含 `actor:*`，
     * 未装配角色仍为 `capsule:*`（降级是设计行为）。
     */
    actorLib,
    /**
     * 运行时桥（docs/17 WU-3）：探针读「世界 → 批次」翻译结果用 —— `batches()`
     * 的实例数组就是每帧上传 GPU 的内容（M3 动画断言隔帧读 inst[11] poseIndex，
     * 必须变化 = 动画在走）。公开 API，不暴露槽位内部状态。
     */
    bridge,
  };

  // boot 场景加载：应用场景 editorCamera 到主视图 —— 关卡物件常在 x=0..70m，
  // 不应用的话相机停在 DEFAULT_VIEW（target 原点 distance 9），用户看到的是
  // 局部特写，会误以为"关卡没加载出来"。
  /** 飞行中到达的场景机位先暂存，退出自由相机时补应用（不丢） */
  let pendingSceneCamera: EditorCameraData | null = null;
  const applySceneCamera = (ec: EditorCameraData): void => {
    // 自由相机是当前机位的**归属者**（编辑态内部也有两套写者）：飞行途中异步
    // 落地的场景机位如果照写，用户刚飞到的地方会被整机瞬移走（独立审核 P1-2
    // 抓到的可达路径）。机位让位由 setFreeCam 集中管理，这里只让路 —— 但要
    // 暂存，否则退出飞行后场景机位永久丢失、用户被留在 DEFAULT_VIEW 局部特写
    // 里（复审 P2-5）。
    if (freeCamOn) {
      pendingSceneCamera = ec;
      console.warn('[freecam] 场景机位暂存：自由相机持有中，退出后自动应用');
      return;
    }
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
    renderer.syncSkyTexture(env);
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
    const defaults = defaultParams();
    for (const key of ['tonemapMode', 'outlineWidth', 'inkColor', 'shadowMult', 'shadowMix', 'shadowTint', 'litSat', 'halftoneStrength', 'halftoneSize', 'vignette'] as const) {
      Object.assign(p, { [key]: env.comic?.[key] ?? defaults[key] });
    }
    p.outlineEnabled = true; p.outlineDistanceComp = true; p.outlinePostExempt = true;
    p.halftoneEnabled = true; p.halftoneThreshold = 0.45;
  };

  let editorMenu!: EditorMenu;
  async function loadAuthorScene(requested: string) {
    const assetFailures: unknown[] = [];
    const r = await renderer.loadScene(requested);
    if (!r.ok) {
      throw new Error(`场景加载失败：${r.reason ?? '未知'}`);
    }
    for (const w of r.warnings ?? []) console.warn(`[boot] 场景告警：${w}`);
    console.info(
      `[boot] 场景已加载：${r.objects} 个物体（跳过 ${r.skipped ?? 0} 个非渲染节点），来自 ${requested}`,
    );
    if (r.editorCamera !== undefined) applySceneCamera(r.editorCamera);
    // 外部资产补载（ADR-018 P4b）：场景里的 GLB 引用（掩体等）异步换成真网格。
    // 失败只告警并保留占位几何，不让装载失败 —— 与 spawnAssetAt 同一 fetch 链路。
    // 🔴 必须在 Play 之前完成：Play 的作者状态按索引快照，装载中途换网格会让
    // Stop 恢复对不上号（复审 #3 同源问题）。这里在 boot 阶段就做完。
    if (renderer.pendingAssetCount > 0) {
      const n = renderer.pendingAssetCount;
      // 与 spawnAssetAt 同一条 fetch 链路（/__fs/file 端点，见 asset-util.fileUrl 注释：
      // 直接 fetch 项目路径会被 vite SPA fallback 挡成 HTTP 200 + index.html）
      renderer.onPlayStateCheck = () => playCtl.isPlaying;
      const res = await renderer.loadSceneAssets(
        async (rel) => {
          const resp = await fetch(`/__fs/file?path=${encodeURIComponent(rel)}`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return await resp.arrayBuffer();
        },
        decodeTexture,
        // 逐资产标尺：sidecar normalizeHeightM 有值用它；null（环境道具常态，
        // 1unit=1m）保持原始尺寸 —— 一刀切 2.05 会把轿车拉成 6m（P4b 复审修）
        async (rel) => {
          const r = await resolveModelHeightM(rel);
          return r.fromMeta ? r.meters : null;
        },
        async rel => {
          const result = await assetServer.loadMeta(rel);
          if (result.missing || result.errors.length) { console.warn(`[scene] ${rel} 缺少有效轴向元数据，使用兼容推断`); return 'auto'; }
          return result.meta.importer.upAxisFlip ? 'z' : 'y';
        },
      );
      renderer.onPlayStateCheck = null;
      assetFailures.push(...res.failed);
      if (res.failed.length > 0) {
        for (const f of res.failed) console.warn(`[boot] 资产补载失败：${f.name} — ${f.reason}`);
      }
      console.info(`[boot] 场景资产补载：${res.swapped}/${n} 个外部 GLB 已就位`);
    }
    // 环境与场景灯光写进面板（真源是场景文件，面板滑块是它的读写器），
    // syncAll 让「场景/光照」「渲染」页的控件立即反映覆盖后的值。
    if (r.environment !== undefined) applySceneEnvironment(r.environment);
    applySceneLightParams(panel.params, r);
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
    editorMenu.message(r.warnings?.length ? `已打开 · ${r.warnings.length} 条场景警告（见控制台）` : '已打开');
    return { objects: r.objects, warnings: r.warnings ?? [], assetFailures };
  }
  void (async () => {
    const start = await resolveStartScenePath();
    if (start.warning !== null) {
      console.warn(`[boot] 起始场景解析：${start.warning}，回落到 ${start.path}`);
    }
    let requested = start.path;
    const selected = new URLSearchParams(window.location.search).get('scene');
    if (selected !== null) {
      try {
        const choices = await readSceneChoices();
        const entry = choices.find(c => c.path === selected.replace(/^\/+/, ''));
        if (!entry) throw new Error('该场景未登记在项目中');
        requested = entry.path;
      } catch (e) { editorMenu.message(`打开失败：${String(e)}`); return; }
    }
    await loadAuthorScene(requested);
    if (new URLSearchParams(window.location.search).get('play') === '1' && startPlay()) playCtl.pause();
  })().catch(error => editorMenu.message(String(error)));

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

  // =====================================================================
  // 自由相机 Free Camera（编辑态的 Scene View 飞行机位）
  //
  // 为什么不是「改 orbit 参数」就完事：orbit 永远是**绕 target 转**，进不去关卡
  // 内部（走廊、房间深处）。Unity/Unreal 的答案是「WASD 自由飞行 + 拖拽转头」。
  //
  // 为什么是**模式**而不是「按住某键临时生效」：飞行要同时占用鼠标拖拽与
  // WASD/QE，临时生效得一直按着修饰键，且会和右键平移抢键位。做成显式模式，
  // 退出后视角留在飞到的地方（这正是它的用途：飞进去看，再切回 orbit 编辑）。
  //
  // 为什么 Play 期间必须关掉：AGENTS.md §2.4 —— 编辑器相机与游戏相机严格分离，
  // Play 的相机归 PlayCameraController（由场景 Camera 组件决定）。两套机位同时
  // 写 camera 会互相打架，且用户会以为「游戏相机坏了」。
  // =====================================================================
  const FREE_CAM_MIN_SPEED = 1;
  const FREE_CAM_MAX_SPEED = 80;
  let freeCamOn = false;
  let freeCamSpeed = FREE_CAM_SPEED_MPS;
  const freeCamKeys = new Set<string>();
  /** 本帧累计的鼠标转向位移（像素）。帧循环消费后清零，避免丢帧时把转向丢掉 */
  let freeCamDxPx = 0;
  let freeCamDyPx = 0;

  function setFreeCam(on: boolean): void {
    if (on && playCtl.isPlaying) {
      // 不静默失败：用户点了按钮却没反应，比报错更难排查
      console.warn('[freecam] Play 期间相机归游戏相机，先停止 Play 再进自由相机');
      spawnMsg = { text: '自由相机不可用：Play 期间相机归游戏相机（先停止 Play）', kind: 'warn' };
      refreshSpawnPanel();
      hudDirty = true;
      return;
    }
    freeCamOn = on;
    freeCamKeys.clear();
    freeCamDxPx = 0;
    freeCamDyPx = 0;
    focusAnim = null; // 聚焦动画与飞行抢 camera，立即让位
    if (on) panel.params.autoOrbit = false; // 自动环绕会和飞行叠加，视角会飘
    if (!on && pendingSceneCamera !== null) {
      // 退出飞行后补应用暂存的场景机位（先清再调，避免 applySceneCamera 再暂存一次）
      const ec = pendingSceneCamera;
      pendingSceneCamera = null;
      applySceneCamera(ec);
    }
    document.querySelector<HTMLButtonElement>('#btn-freecam')?.classList.toggle('active', on);
    if (canvas !== null) canvas.style.cursor = on ? 'crosshair' : '';
    hudDirty = true;
    panel.syncValues();
  }

  interface Ptr {
    x: number;
    y: number;
  }
  const pointers = new Map<number, Ptr>();
  let gesture: 'orbit' | 'pan' | 'pinch' | 'gizmo' | 'freecam' = 'orbit';
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
        spawnSelActive = true;
        switchInspectorTab('inspector');
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
    // 选中变了必须刷面板。之前漏了这一句：脚本分组只在"先点过刷怪点功能体"
    // 的巧合路径下才出现，直接点物体永远不显示（独立审核抓到的假象）。
    refreshSpawnPanel();
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
    if (playCtl.isPlaying) return;
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

  function pushDraggedSubtree(d: DragStart): void {
    if (d.docGraph !== null && d.docNodeId !== null) {
      authorTransform.preview(d.docGraph, d.docNodeId, d.objIndex, d.mode);
    }
  }

  /** One drag produces one author command; transient renderer changes are only previews. */
  function commitGizmoTransform(d: DragStart): void {
    reportAuthorTransform(authorTransform.gizmo(d.objIndex, d.mode));
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
    // 自由相机持有期间不聚焦：focusAnim 在帧循环里排在飞行块之后，会每帧覆写
    // target 和 distance，把刚飞到的机位拽走（独立审核 P1-2）。飞行中"飞过去看"
    // 本来就是自由相机的职责，聚焦没有意义。
    if (freeCamOn) return;
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
  let authorProjectionBusy = false;
  let authorMaterialBaseline = materialSnapshot(renderer);
  let authorLightBaseline = lightSnapshot(panel.params);
  const authorHost = document.createElement('div');
  document.querySelector('.insp-pane[data-pane="scene"]')!.prepend(authorHost);
  const motionHost = document.createElement('div'); motionHost.id = 'runtime-motion-panel'; document.body.append(motionHost);
  const runtimeMotionPanel = new RuntimeMotionPanel(motionHost, sceneMotions, () => actorLib.diagnostics);
  const ikHost = document.createElement('div'); ikHost.id = 'runtime-body-ik-panel'; motionHost.after(ikHost);
  const bodyIkPanel = new BodyIkPanel(ikHost, bodyIk);
  const sceneAuthorPanel = new SceneAuthorPanel(authorHost, {
    document: () => spawnStore?.document ?? null,
    locked: () => playCtl.isPlaying || authorProjectionBusy,
    edit: editAuthorNodes,
  });
  const atmosphereHost = document.createElement('div'); authorHost.before(atmosphereHost);
  const atmospherePanel = new AtmospherePanel(atmosphereHost, {
    environment: () => spawnStore?.document.environment ?? null,
    diagnostic: () => renderer.skyTextureDiagnostic,
    locked: () => playCtl.isPlaying || authorProjectionBusy,
    apply: env => {
      if (!spawnStore || playCtl.isPlaying || authorProjectionBusy) return {ok:false, edit:null, error:'请先停止 Play 并等待场景加载'};
      const result = spawnStore.setEnvironment(env);
      if (result.ok) { applySceneEnvironment(spawnStore.document.environment); panel.syncAll(); editorMenu.message('天空与画风已写入场景，请保存'); }
      return result;
    },
  });
  renderer.onSkyTextureStatusChange = () => atmospherePanel.render();
  function editAuthorNodes(label: string, mutate: (nodes: import('@aether/scene').SceneNode[]) => void, rebuild: boolean): import('@aether/runtime').EditResult {
    if (!spawnStore || playCtl.isPlaying || authorProjectionBusy) return { ok: false, edit: null, error: '当前不能编辑场景，请等待装载完成并停止 Play' };
    const result = spawnStore.editNodes(label, mutate);
    if (result.ok) {
      editorMenu.message('场景已修改，请保存');
      if (rebuild) void rebuildAuthorScene();
    } else if (result.error !== '值没有变化') editorMenu.message(result.error ?? '修改被拒绝');
    return result;
  }
  function deleteAuthorObject(index: number): void {
    const id = renderer.getObjectNodeId(index);
    if (!id) { editorMenu.message('该物体没有场景节点，无法持久化删除'); return; }
    editAuthorNodes('删除节点及子节点', nodes => removeNodeTree(nodes, id), true);
  }
  async function rebuildAuthorScene(reportFailure = false): Promise<void> {
    const store = spawnStore, source = renderer.getSceneSource();
    if (!store || !source || authorProjectionBusy) return;
    authorProjectionBusy = true;
    try {
      const r = await renderer.loadScene(source.url, async () => ({ ok: true, status: 200, json: store.document }));
      if (!r.ok) throw new Error(r.reason);
      await renderer.loadSceneAssets(async rel => {
        const response = await fetch(`/__fs/file?path=${encodeURIComponent(rel)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.arrayBuffer();
      }, decodeTexture, async rel => { const h = await resolveModelHeightM(rel); return h.fromMeta ? h.meters : null; }, async rel => {
        const meta = await assetServer.loadMeta(rel); return meta.missing || meta.errors.length ? 'auto' : meta.meta.importer.upAxisFlip ? 'z' : 'y';
      }).then(result => { if (result.failed.length) throw new Error(result.failed.map(f => `${f.name}: ${f.reason}`).join('; ')); });
      applySceneLightParams(panel.params, r);
      applySceneEnvironment(store.document.environment);
      for (const warning of r.warnings ?? []) console.warn(`[scene] ${warning}`);
    } catch (e) { editorMenu.message(`场景视图更新失败，文档修改已保留：${String(e)}`); if (reportFailure) throw e; }
    finally {
      renderer.setDocument(store.document); authorMaterialBaseline = materialSnapshot(renderer); authorLightBaseline = lightSnapshot(panel.params);
      authorProjectionBusy = false; panel.setSelection(null); panel.refreshHierarchy(); panel.syncAll(); refreshSpawnPanel(); editorMenu.refresh(); hudDirty = true;
    }
  }
  const authorSaver = new AuthorSceneSaver();
  const authorAssets = new AuthorAssetController(() => spawnStore, renderer);
  const authorTransform = new AuthorTransformController(() => spawnStore, () => playCtl.isPlaying || authorProjectionBusy, renderer, (edit, redo) => {
    const error = authorAssets.project(edit, redo);
    authorMaterialBaseline = materialSnapshot(renderer);
    panel.refreshHierarchy();
    panel.syncSelectionFromRenderer(true);
    return error;
  });
  editorMenu = new EditorMenu({
    document: () => spawnStore?.document ?? null,
    dirty: () => (spawnStore?.dirty ?? false) || sceneAuthorPanel.hasDraft || atmospherePanel.hasDraft,
    playing: () => playCtl.isPlaying,
    current: () => {
      const s = renderer.getSceneSource(); const d = renderer.getDocument();
      return s && d ? { path: s.url, name: d.name } : null;
    },
    save: saveSpawnEdits,
    undo: () => undoSpawnEdit(),
    redo: () => reportAuthorTransform(authorTransform.history(true)),
    inspect: switchInspectorTab,
    resolution: native => { nativeResolution = native; resize(); editorMenu.message(native ? '已切换原生分辨率' : '已切换平衡分辨率'); },
  });
  panel.onChange = () => {
    hudDirty = true;
    if (spawnStore !== null && !playCtl.isPlaying && !authorProjectionBusy) {
      const nextMaterials = materialSnapshot(renderer);
      const nextLights = lightSnapshot(panel.params);
      const materialEdit = spawnStore.editNodes('场景材质与灯光', nodes => {
        applyMaterialChanges(nodes, authorMaterialBaseline, nextMaterials);
        applyLightChanges({ ...spawnStore!.document, nodes }, authorLightBaseline, nextLights);
      });
      if (materialEdit.ok) { authorMaterialBaseline = nextMaterials; authorLightBaseline = nextLights; editorMenu.message('材质与灯光已写入场景，请保存'); }
      else if (materialEdit.error !== '值没有变化') { editorMenu.message(materialEdit.error ?? '修改被拒绝'); void rebuildAuthorScene(); }
      const result = spawnStore.setEnvironment(environmentFromParams(spawnStore.document.environment, panel.params));
      if (result.ok) editorMenu.message('场景环境已修改，保存场景后生效于文件');
      // Keep an untouched node form current after edits through the material/light pane.
      // SceneAuthorPanel.render preserves a user's in-progress draft and its conflict guard.
      refreshSpawnPanel();
    }
  };
  panel.onTransformEdit = (index, input) => reportAuthorTransform(authorTransform.inspector(index, input));
  panel.onAuthorUndo = () => undoSpawnEdit();
  panel.onAuthorRedo = () => reportAuthorTransform(authorTransform.history(true));
  panel.onAuthorSave = () => void saveSpawnEdits();

  function reportAuthorTransform(result: import('@aether/runtime').EditResult): void {
    if (result.edit?.kind === 'nodes') void rebuildAuthorScene();
    if (result.edit?.kind === 'environment' && spawnStore) { applySceneEnvironment(spawnStore.document.environment); panel.syncAll(); }
    editorMenu.refresh();
    if (result.ok) spawnMsg = { text: `已写入场景文档：${formatAuthorEdit(result.edit!)}`, kind: 'ok' };
    else if (result.error !== '值没有变化') spawnMsg = { text: result.error ?? '变换被拒绝', kind: 'warn' };
    if (result.ok && spawnAb !== null && spawnStore !== null) {
      const after = captureInitialScatter(spawnStore.document, { seed: playCtl.session.seed });
      spawnAb = { before: spawnAb.before, after, cmp: compareScatter(spawnAb.before, after) };
    }
    panel.syncSelectionFromRenderer(true);
    refreshSpawnPanel();
    hudDirty = true;
  }
  let selectedSpawnNode: string | null = null;
  /** 刷怪点功能体被显式选中（层级行 / 面板列表 / Play 实体）。分组显隐只认它，
   *  selectedSpawnNode 的「自动选第一个」不再连带显示（那等于变相常驻） */
  let spawnSelActive = false;
  let spawnAb: { before: ScatterFingerprint; after: ScatterFingerprint; cmp: ScatterComparison } | null = null;
  let spawnMsg: { text: string; kind: 'info' | 'warn' | 'ok' } | null = null;

  const spawnPanel =
    spawnHost === null
      ? null
      : new SpawnPanel(spawnHost, {
          onSelect: (id) => {
            selectedSpawnNode = id;
            spawnSelActive = true;
            panel.setFunctionalSelection(id);
            refreshSpawnPanel();
          },
          onEdit: (field, value) => editSpawnField(field, value),
          onUndo: () => undoSpawnEdit(),
          onSave: () => void saveSpawnEdits(),
          onRerun: () => restartPlay(),
          onFocusSource: () => focusSourceNode(),
        });

  // =====================================================================
  // 脚本面板（ADR-018 P2）
  //
  // 控件完全由 BehaviorDef.params 的 schema 生成——Agent 新增行为/参数
  // **不需要改这里的代码**。这就是 R2 说的「schema 是 Agent 与人类的契约面」：
  // 人类在 Inspector 上看到的，就是 Agent 声明的那几个旋钮。
  //
  // 🔴 当前为只读态：作者命令与保存合同只覆盖 Transform 与 SpawnPoint 的
  // radius/count，Script 参数还不属于可编辑合同。
  // 与其让用户以为改了（刷新回原值，极难排查），不如置灰并写明原因。
  // 待 spawn-edit 支持通用组件编辑后放开。
  // =====================================================================
  const scriptHost = document.getElementById('script-host');
  const scriptPanel =
    scriptHost === null
      ? null
      : new ScriptPanel(scriptHost, {
          registry: behaviorRegistry,
          readonly: true,
          onChange: () => {
            /* 只读态不会触发 */
          },
        });

  /** 当前选中节点上的 Script 组件（无选中 / 该节点没挂脚本 → 空数组） */
  function selectedScripts(): ScriptComponent[] {
    const idx = renderer.getSelected();
    // 🔴 必须用 `getObjectNodeId`：它返回的是**场景节点 id**（视口物体 ↔ 存储节点的
    // 唯一映射依据）。别用 `getObjectState` 里的字段，也别拿 `subMeshes[].nodeId`
    // 顶替——后者是 **GLB 内部** id，与场景节点是两套东西。
    const nodeId = idx === null ? null : renderer.getObjectNodeId(idx);
    const doc = spawnStore?.document ?? renderer.getDocument();
    if (doc === null || nodeId === null) return [];
    const n = doc.nodes.find((x) => x.id === nodeId);
    if (n === undefined) return [];
    return n.components.filter((c) => c.kind === 'Script') as ScriptComponent[];
  }

  function refreshScriptPanel(): void {
    if (scriptPanel === null) return;
    const scripts = selectedScripts();
    const group = document.getElementById('script-group');
    // 没挂脚本就整组隐藏：检视页不该出现一个永远空白的「脚本」分组
    if (group !== null) group.hidden = scripts.length === 0;
    scriptPanel.render(scripts);
  }

  // 选中变化的**唯一收口**：任何路径改了选中（视口点选 / 层级点选 / 双击聚焦 /
  // focusNode / 删除 / 隐藏 / 拖入资产后自动选中）都会回调这里，面板必然跟着刷。
  // 之前靠每个调用点自己记得调刷新，漏了 7 条——其中 focusNode 那条会让
  // stopPlay() 后显示停 Play 前选中的物体，属于"显示了错的东西"。
  //
  // 🔴 注册位置必须在 `scriptPanel` 初始化**之后**：回调一注册就可能被触发，
  //    而 scriptPanel 是 const，在其初始化前访问会直接 ReferenceError（TDZ）。
  panel.onObjectSelect = () => {
    refreshSpawnPanel();
  };

  /** 场景换了一份（或首次载入）：store 成为作者文档的唯一所有者 */
  function setSpawnScene(doc: SceneDocument | null): void {
    sceneAuthorPanel.resetDraft();
    atmospherePanel.resetDraft();
    authorAssets.clear();
    if (doc === null) {
      spawnStore = null;
      spawnAb = null;
      selectedSpawnNode = null;
      refreshSpawnPanel();
      return;
    }
    spawnSelActive = false; // 新场景：功能体未选中，分组收起
    spawnStore = new SpawnEditStore(doc);
    authorMaterialBaseline = materialSnapshot(renderer);
    authorLightBaseline = lightSnapshot(panel.params);
    // 渲染器与 PlayController 从此只读 store 的工作副本：刷怪点参数不产生可渲染
    // 内容，改完不需要同步给谁 —— 重新装载（点「重跑」）时自然读到新值。
    renderer.setDocument(spawnStore.document);
    spawnAb = null;
    selectedSpawnNode = listSpawnPoints(spawnStore.document)[0]?.nodeId ?? null;
    refreshSpawnPanel();
  }

  function editSpawnField(field: 'radius' | 'count', value: number): void {
    const store = spawnStore;
    if (store === null || selectedSpawnNode === null || playCtl.isPlaying) return;
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
    const undone = authorTransform.history().edit;
    if (undone === null) return;
    if (undone.kind === 'nodes') void rebuildAuthorScene();
    if (undone.kind === 'environment') { applySceneEnvironment(store.document.environment); panel.syncAll(); }
    panel.syncSelectionFromRenderer(true);
    // 撤销后 A/B 的"改前"保持不变，只有 B 端点重抓 —— 撤销也要能证明它真的撤了
    if (spawnAb !== null) {
      const after = captureInitialScatter(store.document, { seed: playCtl.session.seed });
      spawnAb = { before: spawnAb.before, after, cmp: compareScatter(spawnAb.before, after) };
    }
    spawnMsg = { text: `已撤销：${formatAuthorEdit(undone)}`, kind: 'ok' };
    refreshSpawnPanel();
    hudDirty = true;
  }

  /** UI assembly only: field authority, snapshots and concurrent saves belong to authorSaver. */
  async function saveSpawnEdits(): Promise<void> {
    if (sceneAuthorPanel.hasDraft || atmospherePanel.hasDraft || authorProjectionBusy) { editorMenu.message('请先应用或放弃表单修改，并等待场景更新完成'); return; }
    if (playCtl.isPlaying) {
      spawnMsg = { text: 'Play 期间禁止作者场景保存，请先停止 Play', kind: 'warn' };
      refreshSpawnPanel();
      return;
    }
    const store = spawnStore;
    const source = renderer.getSceneSource();
    if (store === null || source === null) {
      spawnMsg = { text: '没有可保存的场景文件', kind: 'warn' };
    } else {
      const result = await authorSaver.save(store, source.url);
      // A scene switch during I/O must not attach an old scene's message to the new document.
      if (spawnStore !== store) return;
      if (result.ok && store.undoDepth === 0 && store.redoDepth === 0) authorAssets.clear();
      spawnMsg = { text: result.message, kind: result.ok ? 'ok' : 'warn' };
    }
    editorMenu.message(spawnMsg?.text ?? '');
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
  function stopPlay(clearRun = true): void {
    clearPlayKeys();
    const src = bridge.selectedEntity?.sourceNodeId ?? null;
    playCtl.stop();
    if (playAuthorParams) { Object.assign(panel.params, playAuthorParams); playAuthorParams = null; }
    if (clearRun) runTransfer.restart();
    if (spawnStore) { applySceneEnvironment(spawnStore.document.environment); panel.syncAll(); }
    // 预载代次 +1：在飞的 kickActorPreload 立即作废（其迟到失败由代次守卫清理）
    actorPreloadGen++;
    // 瞬时装配失败（网络抖动等）在会话边界解禁：下一轮 Play 允许重试
    //（成功装配的缓存不动，见 ActorLibrary.resetFailures）
    actorLib.resetFailures();
    if (src !== null) focusNode(src);
    hudDirty = true;
  }

  function refreshSpawnPanel(): void {
    authorAssets.prune();
    sceneAuthorPanel.render(renderer.getSelected() === null ? null : renderer.getObjectNodeId(renderer.getSelected()!));
    atmospherePanel.render();
    // 借用这个统一刷新点：选中变化 / 播放状态变化 / 场景装载都会走到这里，
    // 脚本面板跟着刷，不必在每个选中回调里各挂一次（容易漏）。
    refreshScriptPanel();
    panel.setAuthorState(spawnStore?.dirty ?? false, spawnStore?.undoDepth ?? 0,
      spawnStore?.redoDepth ?? 0, playCtl.isPlaying, spawnMsg?.text ?? null);
    if (spawnPanel === null) return;
    const store = spawnStore;
    const doc = store?.document ?? null;
    const ent = bridge.selectedEntity;
    // 分组显隐（2026-09-23 布局改造）：刷怪点不再是顶级 tab，而是检视页条件分组。
    // 编辑态 = 用户显式选中了刷怪点功能体（层级 ✦ 行 / 分组内列表）；运行态 = Play 中
    // 选中了僵尸实体。场景里有没有刷怪点只决定层级面板显不显 ✦ 行，不决定本分组。
    const spawnGroup = document.getElementById('spawn-group');
    if (spawnGroup !== null) spawnGroup.hidden = !(spawnSelActive || ent !== null);
    // 功能体喂层级面板（通用模式：场景装载/编辑后同步 ✦ 行）
    panel.setFunctionalNodes(
      doc === null
        ? []
        : listSpawnPoints(doc).map((sp) => ({
            kind: 'spawn',
            kindLabel: t('刷怪点'),
            nodeId: sp.nodeId,
            name: sp.name,
            meta: `×${sp.count} · r${sp.radius.toFixed(1)}`,
          })),
    );
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
        spawnSelActive = id !== null;
        panel.setFunctionalSelection(id);
        refreshSpawnPanel();
      },
      edit: (field: 'radius' | 'count', value: number) => editSpawnField(field, value),
      undo: () => undoSpawnEdit(),
      redo: () => reportAuthorTransform(authorTransform.history(true)),
      /** 全部撤回（不提交）。此前只有 API 没有任何入口 —— 探针/用户都到不了 */
      revertAll: () => {
        while (authorTransform.history().ok) { /* project each author inverse */ }
        panel.syncSelectionFromRenderer(true);
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
        spawnSelActive = true;
        switchInspectorTab('inspector');
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
  let gameControls: GameControls | null = null;
  const playKeys = new Set<string>();
  const PLAY_KEYS = new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
  const PLAY_WASD: Record<string, string> = { w: 'arrowup', a: 'arrowleft', s: 'arrowdown', d: 'arrowright' };

  // ---- 自由相机键位表 ----
  // WASD 前后左右 / Q E 升降（**注意 E 与 gizmo 的旋转快捷键撞车**，所以自由相机
  // 模式下必须在 gizmo 分支之前拦截，见 keydown）。箭头键也接上：习惯摇杆那套的人
  // 不用改手。Shift 加速、V 开关、Esc 退出。
  const FREE_CAM_KEYS: Record<string, [axis: 'forward' | 'right' | 'up', sign: number]> = {
    w: ['forward', 1],
    s: ['forward', -1],
    a: ['right', -1],
    d: ['right', 1],
    e: ['up', 1],
    q: ['up', -1],
    arrowup: ['forward', 1],
    arrowdown: ['forward', -1],
    arrowleft: ['right', -1],
    arrowright: ['right', 1],
  };

  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    playKeys.delete(k);
    if (PLAY_WASD[k]) playKeys.delete(PLAY_WASD[k]!);
    freeCamKeys.delete(k); // 飞行键同样要松开即停（只靠 keyup 会漏掉失焦路径，见下）
    // P5 C5：J 松开 = 停火（失焦路径由 clearPlayKeys 兜底）
    if (k === 'j') gameControls?.setKeyboardFire(false); // 无 isPlaying 守卫：暂停中松开也停火（stopped 时 PlaySession 内部 no-op）
  });

  /**
   * 失焦必须清空按键并**立即**提交零输入（复审 P2）。
   * 按住方向键切到别的窗口、在那边松开，本页收不到 keyup —— 玩家会一直走。
   * 不能等下一帧：失焦后 rAF 可能直接被节流停掉，那时候"等 frame 再提交"等于不提交。
   */
  const clearPlayKeys = (): void => {
    freeCamKeys.clear(); // 飞行键同理：切窗口回来发现相机还在自己飞，是最难自查的那类 bug
    // 🔴 停火必须**无条件**执行，不能跟着下面的早退一起跳过（评审 4166674734 /
    // 4171651555）：J 键故意不进 playKeys（它不是向量键），所以"只按住 J 时失焦"
    // 会命中 `playKeys.size === 0` 的早退 → fireHeld 永远停在 true。
    // 页面随后收不到 J 的 keyup，焦点回来就自动继续开火 —— 玩家没按键却在打子弹。
    gameControls?.clear();
    playCtl.session.setFire(false);
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
    if (playCtl.isPlaying && !e.ctrlKey && !e.metaKey && PLAY_WASD[k]) {
      e.preventDefault(); playKeys.add(PLAY_WASD[k]!); return;
    }
    if (playCtl.isPlaying && k === 'e') {
      e.preventDefault(); if (!e.repeat) playCtl.session.interact(); return;
    }
    if (playCtl.isPlaying && k === 'r') { e.preventDefault(); playCtl.session.runtime?.reload(); return; }
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
      e.preventDefault();
      reportAuthorTransform(authorTransform.history(k === 'y' || e.shiftKey));
      return;
    }
    if ((e.ctrlKey || e.metaKey) && k === 's') {
      e.preventDefault();
      void saveSpawnEdits();
      return;
    }

    // ---- 自由相机优先接管 ----
    // 必须在 PLAY_KEYS 与 gizmo 的 W/E/R 之前：飞行时 W 是"往前飞"而不是"切移动工具"，
    // 箭头键是"飞"而不是"走"。Play 期间 freeCamOn 恒为 false（setFreeCam 会拒绝），
    // 所以这里的拦截不会抢走玩家操作。
    if (freeCamOn) {
      if (k === 'v' || k === 'escape') {
        e.preventDefault();
        setFreeCam(false);
        return;
      }
      if (k === 'shift' || FREE_CAM_KEYS[k] !== undefined) {
        freeCamKeys.add(k);
        e.preventDefault(); // 方向键在飞行模式下不滚动页面（空格不放行，归 Play 控制）
        return;
      }
      // 其余键（F 聚焦 / Delete 删除…）照常放行
    } else if (k === 'v') {
      e.preventDefault();
      setFreeCam(true);
      return;
    }

    if (PLAY_KEYS.has(k)) {
      playKeys.add(k);
      if (playCtl.isPlaying) e.preventDefault(); // Play 中箭头键归玩家，不滚动页面
      return;
    }

    // P5 C5：J = 手枪开火（按住连发，武器 CD 节流在 runtime 侧）。
    // 不进 PLAY_KEYS（那是向量键集合）；终态冻结时 setFire 无效（fireStep 短路）。
    if (k === 'j') {
      if (playCtl.isPlaying) {
        e.preventDefault();
        gameControls?.setKeyboardFire(true);
      }
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
        deleteAuthorObject(idx);
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
    if (playCtl.isPlaying) return;
    if (performance.now() < suppressDblclickUntil) return;
    focusOn(renderer.getSelected());
  });
  // 初始高亮：translate + world（与渲染器默认值一致）
  setGizmoModeUI('translate');
  setGizmoSpaceUI('world');

  canvas.addEventListener('pointerdown', (e) => {
    // Author orbit/pan/picking must not overwrite the scene-owned game camera.
    if (playCtl.isPlaying) return;
    focusAnim = null; // 用户接管相机，聚焦动画立即让位
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      // 自由相机：任何键按下都是「转视角」，不抓 gizmo 手柄（飞行中拖手柄没有意义，
      // 而且手柄判定会抢走拖拽，导致转头时手柄跟着一起动）
      if (freeCamOn) {
        gesture = 'freecam';
        lastX = e.clientX;
        lastY = e.clientY;
        downX = e.clientX;
        downY = e.clientY;
        downMoved = 0;
        return;
      }
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
      // 自由相机不吃双指手势：第二根手指直接忽略，保持单指转视角。
      // 否则 pinch/pan 会写 distance 与 target，把飞行机位拽走（触屏可达路径）。
      if (freeCamOn) return;
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
    if (playCtl.isPlaying) return;
    const pt = pointers.get(e.pointerId);
    if (pt === undefined) {
      // 悬停（无按键按下）：gizmo 手柄上显示抓手，提示此处点击是拖手柄而非转视角。
      // 先算好再比对旧值：无条件写 style.cursor 会让每次鼠标移动都触发一次样式失效，
      // 而绝大多数移动光标形态根本没变。
      const next = freeCamOn
        ? 'crosshair'
        : renderer.getSelected() !== null && hitTestGizmo(e.clientX, e.clientY) !== null
          ? 'grab'
          : '';
      if (canvas.style.cursor !== next) canvas.style.cursor = next;
      return;
    }
    pt.x = e.clientX;
    pt.y = e.clientY;
    // 自由相机的转视角**不限指针数**：飞行中第二根手指落下后 pointers.size 变 2，
    // 若把它塞进 size===1 分支，第一根手指就会停止转向（手感像"卡住"）。
    if (gesture === 'freecam') {
      // downMoved 必须在这里也累计（终审抓的回归）：它在 endPointer 里决定
      // 「松手算不算轻点拾取」。飞行分支早退时漏掉它，拖拽转视角松手就会被
      // 当成轻点 → 每次看完一圈场景，选中的物体莫名其妙变了。
      downMoved = Math.hypot(e.clientX - downX, e.clientY - downY);
      // 累计而不是直接改相机：转向在帧循环里和键盘位移**同一帧**合成，
      // 否则一帧内多次 pointermove 会各转一次、和 dt 无关地甩视角。
      freeCamDxPx += e.clientX - lastX;
      freeCamDyPx += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      return;
    }
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
      // 回到单指：自由相机持有中仍归飞行（不能落回 orbit，否则剩下一根手指在甩机位）
      gesture = freeCamOn ? 'freecam' : 'orbit';
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
      if (playCtl.isPlaying) return;
      focusAnim = null;
      // 自由相机下滚轮**不缩放**：缩放改的是 orbit 半径，会把你刚飞到的位置又拽回去。
      // 这里改成调飞行速度 —— 大关卡要飞快、对准细节要飞慢，这才是真需求。
      if (freeCamOn) {
        freeCamSpeed = clamp(
          freeCamSpeed * Math.exp(-e.deltaY * 0.0012),
          FREE_CAM_MIN_SPEED,
          FREE_CAM_MAX_SPEED,
        );
        hudDirty = true;
        return;
      }
      zoomBy(Math.exp(e.deltaY * 0.0012));
    },
    { passive: false },
  );

  // =====================================================================
  // 资产库 Asset Library + 属性 Inspector
  // 底部 dock 浏览项目文件；GLB 双击/拖入画布生成为新场景物体（renderer.addObject，
  // 生成进场景，不替换任何既有物体）；选中资产在右侧 Inspector 显示静态属性。
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
    const store = spawnStore;
    if (store === null) { panel.setModelInfo('请先打开场景，再从资产库添加模型'); return; }
    // 🔴 Play 中禁止增删（复审 #3）：作者状态按索引恢复，物体数变了就会张冠李戴。
    // 这一条与层级删除 / Delete 键同一约束，所有入口统一。
    if (playCtl.isPlaying) {
      console.warn('[play] Play 中禁止导入 / 生成资产（Stop 后作者状态按索引恢复，数量必须一致）');
      panel.setModelInfo(t('Play 中不能导入 / 生成资产，先 Stop'));
      hudDirty = true;
      return;
    }
    try {
      if (authorProjectionBusy) throw new Error('场景尚未准备好');
      const resp = await fetch(`/__fs/file?path=${encodeURIComponent(relPath)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buffer = await resp.arrayBuffer();
      const metadata = await assetServer.loadMeta(relPath);
      if (metadata.missing || metadata.errors.length > 0) throw new Error('资产元数据缺失或无效，请先运行 scene:gen / scene:check');
      // Respect explicit metre-scale environment imports as well as character heights.
      const model = parseGlb(buffer, await resolveAssetImportHeightM(relPath));
      const bmp = model.image === null ? null : await decodeTexture(model.image, relPath);
      // 🔴 异步情况（复审 #3）：导入在 Play **之前**发起、在 Play **中**完成。
      // fetch + 解码期间用户可能按了 Play —— 此时同样不能往对象集合里塞东西。
      if (playCtl.isPlaying || authorProjectionBusy || spawnStore !== store) {
        bmp?.close();
        const reason = playCtl.isPlaying ? '已进入 Play' : '场景状态已变化';
        console.warn(`[资产库] ${reason}，丢弃尚未完成的导入`);
        panel.setModelInfo(`${reason}，请重新导入 ${stemName(relPath)}`);
        hudDirty = true;
        return;
      }
      const name = uniqueObjectName(stemName(relPath));
      const node = assetSceneNode(`nd_asset_${crypto.randomUUID()}`, name, relPath, metadata.meta.guid, pos ?? [0, 0, 0]);
      const idx = authorAssets.insert(store, node, model, bmp);
      authorMaterialBaseline = materialSnapshot(renderer);
      renderer.selectObject(idx);
      panel.setSelection(idx);
      switchInspectorTab('inspector');
      panel.refreshHierarchy();
      refreshSpawnPanel();
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
  let characterBindingBar: CharacterBindingBar | null = null;
  let bindingLoadVersion = 0;
  // 当前绑定会话对应的 .meta.json 落盘点（资产库入口才有；层级/场景物体入口为 null）
  let currentBindingMetaPath: string | null = null;
  const bindingPersistence = new BindingPersistence();
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
        onChange: () => characterBindingBar?.setDirty(binding?.hasUnsavedChanges() ?? false),
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
      characterBindingBar = new CharacterBindingBar(bindingDockEl, characterBindingChoices(assetManifest),
        (path) => void bindAssetAt(path));
      wireBindingGrip();
    }
    bindingDockEl.classList.add('open');
    // Each source starts with its own template/sidecar, never the previous character's pose.
    binding.clear();
    binding.setModel(session.name, session.vertices, session.indices);
    // 资产库入口会把上次写进 .meta.json 的编辑态灌回来（有则回填，无则保持模板默认）
    if (saved !== undefined) binding.hydrate(saved);
    binding.markSaved();
    characterBindingBar?.setSource(currentBindingMetaPath?.replace(/\.meta\.json$/, '') ?? null, saved !== undefined);
    // canvas 必须等 open 之后才量得到 clientWidth，晚一帧再重算视图缩放
    requestAnimationFrame(() => binding?.resize());
    panel.setModelInfo(
      `已进入绑定：${session.name} · 正视改 x/y、侧视改 z/y · ` +
        `骨长采纳进 T-pose，姿态偏移不入骨架`,
    );
  }

  function closeBinding(): void {
    if (binding?.hasUnsavedChanges() && !window.confirm('当前绑定有未保存修改，关闭并放弃这些修改？')) return;
    bindingLoadVersion++;
    bindingDockEl?.classList.remove('open');
    binding?.clear();
    bindingSession = null;
    currentBindingMetaPath = null;
    bindingPersistence.clear();
  }

  /** Binding version and validation are shared with offline MCP; main only supplies the GUI port. */
  function saveBinding(): void {
    if (binding === null) return;
    if (currentBindingMetaPath === null) {
      binding.setSaveStatus(false, '无路径：层级入口不支持存盘'); return;
    }
    const current = binding;
    const path = currentBindingMetaPath;
    const version = bindingLoadVersion;
    const savedSignature = current.editSignature();
    void bindingPersistence.save(current.getEditorData(), (request) =>
      writeProjectFile(request.path, { patch: request.patch, baseHash: request.baseHash }))
      .then((result) => {
        if (binding !== current || currentBindingMetaPath !== path || bindingLoadVersion !== version) return;
        if (result.ok) {
          current.markSaved(savedSignature);
          characterBindingBar?.saved();
          characterBindingBar?.setDirty(current.hasUnsavedChanges());
        }
        current.setSaveStatus(result.ok, result.ok ? `已保存 ${result.bytes ?? '?'}B`
          : result.conflict ? `保存冲突（磁盘 ${result.currentHash ?? '?'}）：本地修改已保留，请重新进入绑定接受最新版本`
          : `保存失败：${result.error ?? result.status}。本地修改已保留`);
      }).catch((error) => {
        if (binding === current && currentBindingMetaPath === path && bindingLoadVersion === version) current.setSaveStatus(false, String(error));
      });
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
      const weightMode = binding.getWeightMode();
      const inputSig = binding.editSignature();
      const computed = weightMode === 'volumetric' ? await binding.prepareSkin() : null;
      if (s !== bindingSession || mesh.vertices !== binding.getMesh()?.vertices || inputSig !== binding.editSignature()) throw new Error('导出期间角色或蒙皮输入已变更');
      const base = {
        name: s.name,
        vertices: mesh.vertices,
        indices: mesh.indices,
        image: s.image,
        placed: structuredClone(binding.getState().positions),
        smoothWeights,
        weightMode,
        volumetric: binding.getVolumetricOptions(),
        rigidRegions: binding.getEditorData().rigidRegions ?? [],
        ...(computed ? { computedSkin: computed.skin, ...(computed.volumetric ? { volumetricStats: computed.volumetric } : {}) } : {}),
        // 平滑迭代 / λ 由面板外置（旧评审 §2.4，进 .meta.json 可复现）；
        // 面板未开（如顶部菜单直接导出）时退回 runExport 默认值
        smoothIters: binding?.getSmoothIters() ?? 2,
        smoothLambda: binding?.getSmoothLambda() ?? 0.5,
        // Skin Wrapper（代理圆柱体）蒙皮：有则按圆柱体包裹算权重，否则退回胶囊权重。
        // 权重算法由面板显式选择（默认 wrapper，保持历史行为）；选「距离衰减」时
        // 必须传 undefined，否则 runExport 会一直走圆柱体分支（cylinders 载入即建）。
        cylinders: weightMode === 'wrapper' ? (structuredClone(binding.getCylinders()) ?? undefined) : undefined,
        mirrorWeights: binding?.getMirrorWeights() ?? false,
      };
      // exactOptionalPropertyTypes：`animation?: T` 不接受显式 undefined，只能整包展开
      const res = await rigToTPoseWithImage(
        anim === null ? base : { ...base, animation: anim },
      );
      if (s !== bindingSession || inputSig !== binding.editSignature()) throw new Error('导出期间蒙皮输入已变更');
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
    if (binding?.hasUnsavedChanges() && !window.confirm('当前绑定有未保存修改，切换/重载并放弃这些修改？')) return;
    const version = ++bindingLoadVersion;
    const previousSignature = binding?.editSignature();
    try {
      await manifestReady;
      const resp = await fetch(`/__fs/file?path=${encodeURIComponent(relPath)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buffer = await resp.arrayBuffer();
      // 与 roster 同一把身高尺，保证绑定面板里的体型与场景里一致
      const model = parseGlb(buffer, MODEL_RULER_HEIGHT_M);
      lastSkeletonImport = null;

      const acceptedMetaPath = `${relPath}.meta.json`;
      const acceptedMeta = await readProjectFile(acceptedMetaPath);
      if (version !== bindingLoadVersion) return;
      if (binding?.editSignature() !== previousSignature) {
        panel.setModelInfo('载入期间绑定已被编辑，本地修改已保留；请保存后重新打开角色');
        return;
      }

      // 导入文件骨架模式：摆位来自 GLB 内嵌 skin（rigged GLB 桥），
      // 不回填 sidecar 的 bindingEditor（那是「源网格 + 模板骨架」世界的会话）
      if (opts?.importSkeleton === true) {
        if (model.skeleton === null) {
          panel.setModelInfo(
            `导入文件骨架失败：${stemName(relPath)} 不含蒙皮骨架（纯网格）· 请改用「进入绑定 · 纯网格」`,
          );
          return;
        }
        // 落盘点只在「真的会打开」之后才切换：early return 时若已改指向，
        // 旧会话的「保存绑定」会写进新纯网格的 sidecar（PR #13 评审）
        currentBindingMetaPath = acceptedMetaPath;
        if (acceptedMeta.ok) bindingPersistence.accept(acceptedMetaPath, acceptedMeta.json);
        else bindingPersistence.clear();
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
      currentBindingMetaPath = acceptedMetaPath;
      if (acceptedMeta.ok) bindingPersistence.accept(acceptedMetaPath, acceptedMeta.json);
      else bindingPersistence.clear();
      // 尝试回填上次的编辑态（bindingEditor 节点）；没有/损坏都不影响打开
      let saved: unknown = undefined;
      const meta = acceptedMeta;
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
      if (version !== bindingLoadVersion) return;
      panel.setModelInfo(`进入绑定失败：${stemName(relPath)} · ${String(err)}`);
      console.error('[绑定] 载入失败', relPath, err);
    }
  }

  /** 入口二：层级面板右键场景物体 → 「进入绑定」 */
  panel.onHierarchyContextMenu = (index, x, y) => {
    const obj = renderer.state.objects[index];
    openCtxMenu(x, y, [
      {
        label: obj === undefined ? t('进入绑定（物体不存在）') : t('进入绑定'),
        disabled: obj === undefined,
        run: () => {
          if (obj === undefined) return;
          // 层级入口无 GLB 路径 → 没有可落盘的 .meta.json，保存按钮会被拦下
          if (binding?.hasUnsavedChanges() && !window.confirm('当前绑定有未保存修改，切换并放弃这些修改？')) return;
          bindingLoadVersion++;
          currentBindingMetaPath = null;
          bindingPersistence.clear();
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
      { label: t('聚焦'), disabled: obj === undefined, run: () => focusOn(index) },
    ]);
  };

  /**
   * 资产 dock 高度钳制（2026-09-23 布局自适应用户报告）：--dock-h 会持久化，
   * 窗口缩小后旧值可能超出窗口高度，把中心列（画布 + 绑定/重定向浮层）挤到 1px。
   * 拖拽时的 max 只在拖动瞬间求值，救不了「先拖大再缩窗」——启动与每次窗口
   * resize 都重新钳制并回写持久化值。
   */
  function clampDockHeight(): void {
    const cur = readCssVarPx('--dock-h', 260);
    const max = Math.max(320, window.innerHeight - 160);
    if (cur <= max) return;
    document.documentElement.style.setProperty('--dock-h', `${max}px`);
    try {
      localStorage.setItem('zh.ui.dockH', String(max));
    } catch {
      /* 持久化失败不影响本轮布局 */
    }
  }
  window.addEventListener('resize', () => {
    clampDockHeight();
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
        if (binding?.hasUnsavedChanges() && !window.confirm('当前绑定有未保存修改，切换并放弃这些修改？')) return;
        bindingLoadVersion++;
        currentBindingMetaPath = null;
        bindingPersistence.clear();
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
    panel.setModelInfo(t('请先在底部资产库选中一个 .glb 模型，或右键场景物体 → 进入绑定'));
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
        else if (a === 'characters') void (async () => {
          await manifestReady;
          const source = currentBindingMetaPath?.replace(/\.meta\.json$/, '') ?? characterBindingChoices(assetManifest)[0]?.path;
          if (source !== undefined) await bindAssetAt(source);
          else panel.setModelInfo('角色清单中没有可绑定的 GLB');
        })();
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
        /** 整根包裹器偏移（骨局部轴：x=轴向 / y=侧向 / z=前后）——MCP cylinders.setOffset 同语义 */
        setOffset: (bone: string, off: [number, number, number]) =>
          binding?.setCylinderOffset(bone, off) ?? false,
        /** 偏移归零（回到骨段原位）——不依赖视图选中态 */
        resetOffset: (bone: string) => binding?.setCylinderOffset(bone, [0, 0, 0]) ?? false,
        /** 取消手动标记并按骨长重适配（MCP cylinders.unpin 同语义；面板 autoFit() 管全部未钉骨） */
        unpin: (bone: string) => binding?.unpinCylinderForAutomation(bone) ?? false,
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
    // ---- 资产预览的 LOD 家族：领域逻辑在 @aether/scene 的 asset-manifest（2026-09-23
    // 上提成库，编辑器不再持有第二份解析实现）——这里只剩拉取清单 + 缓存 ----
    let lodFamilies: Map<string, LodFamily> | null = null;
    async function getLodFamilies(): Promise<Map<string, LodFamily>> {
      if (lodFamilies === null) {
        const r = await readProjectFile('assets/_data/asset-manifest.json');
        const parsed = parseAssetManifest(r.ok ? r.json : null);
        if (parsed.skipped > 0) console.warn(`[资产清单] ${parsed.skipped} 个坏条目被跳过`);
        lodFamilies = parsed.families;
      }
      return lodFamilies;
    }

    /** 按路径把 GLB 载入预览（选中流与 LOD 切换共用；不改资产库选中） */
    async function previewPath(path: string): Promise<void> {
      try {
        let model = previewCache.get(path);
        if (model === undefined) {
          const resp = await fetch(`/__fs/file?path=${encodeURIComponent(path)}`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const buffer = await resp.arrayBuffer();
          model = parseGlb(buffer, await resolveAssetImportHeightM(path));
          previewCache.set(path, model);
        }
        const bmp = model.image === null ? null : await decodeTexture(model.image, path);
        await assetPreview?.load(model, bmp);
        const family = (await getLodFamilies()).get(path) ?? [];
        assetPreview?.setLods(family, path);
        // 统计行走库里的 formatLodStats（含 Δ vs LOD0 降幅）；无家族时退回实测数
        const stats = formatLodStats(family, path);
        assetPreview?.setStats(stats !== '' ? stats : `${Math.round(model.triangles)} tris · ${model.vertices} verts`);
      } catch (err) {
        console.error('[资产库] 预览解析失败', path, err);
        assetPreview?.setLods([], null);
        assetPreview?.setStats('');
      }
    }

    async function previewAsset(sel: AssetSelection): Promise<void> {
      if (sel.entry.kind !== 'file' || !sel.entry.ext.toLowerCase().endsWith('.glb')) {
        assetPreview?.clear();
        return;
      }
      await previewPath(sel.path);
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
        if (playCtl.isPlaying || spawnStore?.dirty) {
          panel.setModelInfo('重命名冲突：请先停止 Play 并保存或处理作者修改；本地编辑已保留');
          hudDirty = true;
          return false;
        }
        const r = await renameProjectEntry(path, newName);
        if (!r.ok) {
          panel.setModelInfo(`${t('重命名失败')}：${r.error ?? '未知错误'}${r.recoveryPath ? `；恢复证据：${r.recoveryPath}` : ''}`);
          hudDirty = true;
          return false;
        }
        const extras: string[] = [];
        extras.push(...r.diagnostics ?? []);
        lodFamilies = null;
        assetPreview?.clear();
        if (lastAssetPath !== null) lastAssetPath = renamedResourcePath(lastAssetPath, r);
        if (currentBindingMetaPath !== null && renamedResourcePath(currentBindingMetaPath, r) !== currentBindingMetaPath) {
          currentBindingMetaPath = renamedResourcePath(currentBindingMetaPath, r);
          bindingPersistence.clear();
          binding?.setSaveStatus(false, '资源已改名，本地绑定修改已保留；请重新进入绑定接受新路径版本后保存');
        }
        const source = renderer.getSceneSource();
        const store = spawnStore;
        if (source !== null && store !== null) {
          const refreshed = await refreshAuthorResources(store, source.url, r, readProjectFile, () => spawnStore === store && !playCtl.isPlaying);
          renderer.setSceneSourcePath(refreshed.source);
          if (refreshed.status === 'refreshed' && spawnStore === store && !playCtl.isPlaying) {
            renderer.setDocument(store.document);
            refreshSpawnPanel();
          }
          if (refreshed.message) extras.push(refreshed.message);
        }
        if (r.updatedFiles?.includes('assets/_data/asset-manifest.json')) {
          actorPreloadGen++;
          actorLib.clear();
          const latest = await readProjectFile('assets/_data/asset-manifest.json');
          if (latest.ok) { assetManifest = latest.json; actorLib.setManifest(assetManifest); }
          else extras.push('角色清单重新载入失败，请重新打开编辑器');
        }
        if (r.metaRenamed) extras.push(t('sidecar 已随迁'));
        if (r.projectUpdated) extras.push(t('项目登记已更新'));
        // The transaction reports explicit recovery information on failure; successful paths are complete.
        if (r.projectError !== null) extras.push(`⚠ ${r.projectError}`);
        panel.setModelInfo(`${t('已重命名')} → ${r.path}${extras.length > 0 ? `（${extras.join('，')}）` : ''}`);
        hudDirty = true;
        return true;
      },
      // 右键条目 → 统一菜单（与层级面板共用一套 DOM）。上面三段是编辑器动作，
      // 分隔线以下是通用文件动作（复制路径 / 重命名 / 资源管理器定位）。只有 .glb 才给「进入绑定」
      onContextMenu: (path, entry, x, y) => {
        const isGlb = entry.kind === 'file' && entry.ext.toLowerCase() === '.glb';
        openCtxMenu(x, y, [
          {
            label: isGlb ? t('进入绑定 · 纯网格（继续上次编辑）…') : t('进入绑定 · 纯网格（仅 .glb）'),
            disabled: !isGlb,
            run: () => void bindAssetAt(path),
          },
          {
            // rigged GLB 桥：把文件内嵌 skin 的骨架摆位灌进会话再加工；
            // 纯网格点这个会在打开前收到明确报错（不静默退化成模板模式）
            label: isGlb ? t('进入绑定 · 已有骨骼（导入文件骨架）…') : t('进入绑定 · 已有骨骼（仅 .glb）'),
            disabled: !isGlb,
            run: () => void bindAssetAt(path, { importSkeleton: true }),
          },
          {
            label: isGlb ? t('载入场景') : t('载入场景（仅 .glb）'),
            disabled: !isGlb,
            run: () => void spawnAssetAt(path, null),
          },
          { label: '', separator: true, run: () => {} },
          {
            label: t('复制相对路径'),
            run: () => {
              void (async () => {
                const ok = await copyText(path);
                panel.setModelInfo(ok ? `${t('已复制相对路径')}：${path}` : t('复制失败（剪贴板不可用）'));
                hudDirty = true;
              })();
            },
          },
          {
            label: t('复制绝对路径'),
            run: () => {
              void (async () => {
                const info = await fetchAssetInfo(path);
                if (!info.ok) {
                  panel.setModelInfo(`${t('取绝对路径失败')}：${info.error ?? '未知错误'}`);
                  hudDirty = true;
                  return;
                }
                const ok = await copyText(info.abs);
                panel.setModelInfo(ok ? `${t('已复制绝对路径')}：${info.abs}` : t('复制失败（剪贴板不可用）'));
                hudDirty = true;
              })();
            },
          },
          {
            label: `${t('重命名')}…`,
            run: () => {
              if (!assets.beginRename(path)) {
                panel.setModelInfo('重命名：条目当前不可见（可能被筛选隐藏），先清除筛选再试');
                hudDirty = true;
              }
            },
          },
          {
            label: t('在资源管理器中显示'),
            run: () => {
              void (async () => {
                const r = await revealInFileManager(path);
                if (!r.ok) {
                  panel.setModelInfo(`${t('打开文件位置失败')}：${r.error ?? '未知错误'}`);
                  hudDirty = true;
                }
              })();
            },
          },
        ]);
      },
    });

    // 钳制要在 AssetBrowser 构造**之后**：restoreCssVar 在 buildDom 里恢复持久化的
    // --dock-h（可能是上一轮窗口更大时的残留超大值），先钳后恢复等于没钳
    clampDockHeight();

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
        panel.setModelInfo(t('只有 .glb 模型能拖入场景（其他资产在右侧 Inspector 里预览'));
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
    // LOD 下拉切换：只换预览内容，不动资产库选中
    if (assetPreview !== null) assetPreview.onLoadLod = (p) => void previewPath(p);
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

    // 自由相机开关（gizmo-bar 上的「✈ 自由相机」按钮 / V 键）
    document.querySelector<HTMLButtonElement>('#btn-freecam')?.addEventListener('click', () => {
      setFreeCam(!freeCamOn);
    });
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
  let lastWorkspaceUiTime = -1;
  const runSettlement = new RunSettlement(runProfile, () => runTransfer.runId);
  gameControls = new GameControls(canvas,(x,y)=>renderer.pointerRay(x,y),()=>camera.yaw);
  const gameHud = new GameHud({
    pause: () => playCtl.togglePause(),
    toggleTouch: () => { gameControls!.clear();gameControls!.touch=!gameControls!.touch;return gameControls!.touch; },
    interact: () => { playCtl.session.interact(); },
    resume: () => playCtl.resume(),
    retry: async () => {
      try {
        const source = renderer.getSceneSource(), doc = renderer.getDocument();
        if (!source || !doc) return;
        const first = await nextPlayableScene(null, doc.act);
        if (first && first.path !== source.url.replace(/^\/+/, '')) {
          const url = new URL(sceneUrl(window.location.href, first.path)); url.searchParams.set('play', '1');
          editorMenu.navigate(url.href);
        } else { stopPlay(); startPlay(); }
      } catch (e) { editorMenu.message(`重新开始失败：${String(e)}`); }
    },
    stop: () => stopPlay(),
    next: async () => {
      if (playCtl.session.outcome !== 'floor-clear') return 'blocked';
      if (playCtl.session.runtime?.progress?.choosing) return 'blocked';
      const source = renderer.getSceneSource(); const doc = renderer.getDocument();
      if (!source || !doc) return 'blocked';
      try {
        const next = await nextPlayableScene(source.url, doc.act);
        if (!next) { editorMenu.message('全部楼层已完成！可以再来一局或返回编辑。'); return 'complete'; }
        const url = new URL(sceneUrl(window.location.href, next.path)); url.searchParams.set('play', '1');
        const running = playCtl.session.runtime;
        if (running?.progress) url.searchParams.set('run', runTransfer.prepare(next.path, running.progress.snapshot(running.player()!.hp)));
        editorMenu.navigate(url.href);
        return 'navigating';
      } catch (e) { editorMenu.message(`下一层读取失败：${String(e)}`); return 'blocked'; }
    },
  }, p => renderer.worldToScreen(p));
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

    // 自由相机是**模式**，必须让用户随时看见自己在模式里 —— 否则「鼠标拖了却选不中物体」
    // 会当成 bug 报上来，实际上是飞行模式把拖拽吃掉了。
    if (freeCamOn) {
      rows.push(
        `<b style="color:#FF9F1C">✈ 自由相机</b> 速度 ${freeCamSpeed.toFixed(1)} m/s　` +
          `<span class="hint">WASD 飞行 · Q/E 升降 · Shift 加速 · 拖拽转视角 · 滚轮调速 · V 或 Esc 退出</span>`,
      );
    }

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
      const motion = sceneMotions.summary();
      const partial = motion.nodes.filter(n => n.reports.some(r => r.status === 'partial')).length;
      rows.push(`<b>共享动作</b> ${motion.nodes.length} 个角色 · 加载 ${motion.pending} · 部分能力 ${partial} · 缓存命中 ${motion.stats.cacheHits}`);
      for (const error of motion.errors) {
        const line = document.createElement('span'); line.className = 'warn';
        line.textContent = `⚠ 动作 ${error.nodeId}：${error.message}`;
        rows.push(line.outerHTML);
      }
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
    runtimeMotionPanel.render(playCtl.isPlaying);
    bodyIkPanel.render(playCtl.isPlaying);
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

  const editorAgent: EditorAgent = new EditorAgent({
    store: () => spawnStore,
    path: () => renderer.getSceneSource()?.url ?? null,
    busy: () => authorProjectionBusy,
    draft: () => sceneAuthorPanel.hasDraft || atmospherePanel.hasDraft,
    playing: () => playCtl.isPlaying,
    pendingAssets: () => renderer.pendingAssetCount,
    open: async path => {
      authorProjectionBusy = true;
      try { const result = await loadAuthorScene(path); const url = new URL(location.href); url.searchParams.set('scene', path); url.searchParams.delete('play'); history.replaceState(null, '', url); return result; }
      finally { authorProjectionBusy = false; refreshSpawnPanel(); }
    },
    rebuild: () => rebuildAuthorScene(true),
    environmentChanged: () => { if(spawnStore) applySceneEnvironment(spawnStore.document.environment); panel.syncAll(); refreshSpawnPanel(); editorMenu.message('Agent 已修改场景环境，请保存'); },
    history: async redo => {
      const result = authorTransform.history(redo);
      if(result.edit?.kind === 'nodes') await rebuildAuthorScene(true);
      else if(result.edit?.kind === 'environment' && spawnStore) { applySceneEnvironment(spawnStore.document.environment); panel.syncAll(); }
      panel.syncSelectionFromRenderer(true); refreshSpawnPanel(); editorMenu.refresh(); return result;
    },
    save: async () => {
      const store = spawnStore, source = renderer.getSceneSource();
      if(!store || !source) throw new Error('No author scene');
      const result = await authorSaver.save(store, source.url);
      if(result.ok && store.undoDepth===0 && store.redoDepth===0) authorAssets.clear();
      editorMenu.message(result.message); refreshSpawnPanel(); return result;
    },
    play: (action, steps) => {
      if(action === 'start') { if(playCtl.isPlaying || !startPlay()) throw new Error(playCtl.error ?? 'Play start rejected'); playCtl.pause(); }
      else if(action === 'stop') stopPlay();
      else if(action === 'pause') { if(!playCtl.isPlaying) throw new Error('Play is stopped'); playCtl.pause(); }
      else if(action === 'resume') { if(!playCtl.isPaused) throw new Error('Play is not paused'); playCtl.resume(); }
      else if(action === 'step') { if(!playCtl.isPaused) throw new Error('Step requires paused Play'); for(let i=0;i<steps;i++)playCtl.step(); }
    },
    runtime: () => ({state:playCtl.state,tick:playCtl.tick,player:playCtl.session.runtime?.player()??null,npcCount:playCtl.session.runtime?.countNpc()??0,
      diagnostics:playCtl.diagnostics,runtimeDiagnostics:playCtl.runtimeDiagnostics,ledger:playCtl.ledger,instances:renderer.debugDynamicInstanceCount(),meshIds:renderer.debugDynamicMeshIds(),actorLibrarySize:actorLib.size}),
    capture: () => editorAgentConnection?.capture() ?? Promise.reject(new Error('Editor MCP prototype is not enabled for this tab')),
  });
  const editorAgentConnection: ReturnType<typeof connectEditorAgent> | null = new URLSearchParams(location.search).get('agent') === '1' ? connectEditorAgent(editorAgent) : null;
  const frame = (now: number): void => {
    if (disposed) return;
    const wallDt = Math.max(0, (now - last) / 1000);
    const dt = Math.min(0.1, wallDt);
    last = now;
    elapsed += dt;
    frames++;
    hudTimer += wallDt;

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

    // 自由相机：把「按键轴 + 累计鼠标位移」在一帧里合成一次。
    // 只在**真的有输入**时才写回并标脏 —— 否则开着模式啥也不按也会每帧刷 HUD。
    if (freeCamOn) {
      let fwd = 0;
      let rgt = 0;
      let up = 0;
      for (const k of freeCamKeys) {
        const a = FREE_CAM_KEYS[k];
        if (a === undefined) continue; // 'shift' 之类只作修饰键
        if (a[0] === 'forward') fwd += a[1];
        else if (a[0] === 'right') rgt += a[1];
        else up += a[1];
      }
      const active = fwd !== 0 || rgt !== 0 || up !== 0 || freeCamDxPx !== 0 || freeCamDyPx !== 0;
      if (active) {
        const next = stepFreeCamera(
          {
            target: [camera.target[0], camera.target[1], camera.target[2]],
            distance: camera.distance,
            yaw: camera.yaw,
            elevationDeg: panel.params.cameraElevation,
          },
          {
            forward: fwd,
            right: rgt,
            up,
            dxPx: freeCamDxPx,
            dyPx: freeCamDyPx,
            boost: freeCamKeys.has('shift'),
          },
          dt,
          freeCamSpeed,
        );
        camera.target[0] = next.target[0];
        camera.target[1] = next.target[1];
        camera.target[2] = next.target[2];
        camera.yaw = next.yaw;
        panel.params.cameraElevation = next.elevationDeg;
        panel.syncValues();
        hudDirty = true;
      }
      freeCamDxPx = 0;
      freeCamDyPx = 0;
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
      gameControls?.update(playCtl.session.runtime,playCtl.isPaused,ix,iz);
    }
    if (!playCtl.isPlaying) gameControls?.update(null,false,0,0);
    // P4 M4 降级：LOD 按**编辑器相机**眼位刷新（runtime 不持有相机）。
    // 🔴 必须在 batches() 之前 —— 批次按 lodTier 分流，晚一帧会让压测帧率抖动。
    if (playCtl.isPlaying) {
      // Use the renderer's eye projection (degree pitch and identical yaw axes).
      const eye = m4.orbitEye(camera.target, camera.distance, camera.yaw, panel.params.cameraElevation);
      bridge.refreshLod(eye[0], eye[2]);
    }
    playCtl.update(dt);
    if (elapsed - lastWorkspaceUiTime >= 0.1) {
      lastWorkspaceUiTime = elapsed;
      gameHud.update(playCtl.session.runtime, playCtl.isPaused);
      runSettlement.update(playCtl.session.runtime);
      editorMenu.refresh();
    }
    renderer.setDynamicBatches(bridge.batches());
    gameHud.updateFeedback(playCtl.session.runtime);
    // P5 C5 终态提示（一次性）：世界已由 runtime 冻结，这里只负责让玩家看见。
    // 🔴 不自动 Stop —— 让玩家看清死状/战果，何时退出由玩家决定（docs/23 §2.5）。
    if (playCtl.isPlaying) {
      const oc = playCtl.session.outcome;
      if (oc !== lastOutcomeShown) {
        lastOutcomeShown = oc;
        if (oc === 'game-over') {
          spawnMsg = { text: '你死了 —— 世界已冻结（J 停止响应），点 ⏹ Stop 退出本局', kind: 'warn' };
          refreshSpawnPanel();
          hudDirty = true;
        } else if (oc === 'floor-clear') {
          spawnMsg = { text: '🏆 本层通关！全部房间已清空 —— 点 ⏹ Stop 退出', kind: 'ok' };
          refreshSpawnPanel();
          hudDirty = true;
        }
      }
    } else {
      lastOutcomeShown = 'running'; // Stop 后复位，下一局重新提示
    }
    // 运行期诊断必须有消费者，否则"容量不足整批不生成"在 UI 上依旧是一片寂静，
    // 跟没产出这个信号没有区别（AGENTS.md §2.2：不静默）。
    drainRuntimeDiagnostics();

    renderer.render(panel.params, camera, elapsed, dpr());
    editorAgentConnection?.afterFrame(canvas!);
    panel.tickAnimation();
    assetPreview?.tick(dt, elapsed, panel.params);
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

void boot().catch((err: unknown) => {
  showFatal('启动异常', `<p>${String(err)}</p>`);
});
