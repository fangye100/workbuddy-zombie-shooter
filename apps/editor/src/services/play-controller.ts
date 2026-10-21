import {decalReceivers} from './vfx-decal-receivers';
/**
 * PlayController —— 编辑器侧的**装配层**（WU-4）。
 *
 * 严格遵守 docs/17「编辑器入口只装配服务与按钮」：这里**没有任何玩法逻辑，也没有
 * 运行状态**。状态机在 `PlaySession`（runtime 包，纯 CPU 可测），渲染翻译在
 * `RuntimeBridge`。本类只做三件装配工作：
 *
 *   1. Play 前给作者状态打快照，Stop 时整份恢复（不从磁盘重载）；
 *   2. 把 PlaySession 的世界推进同步给 Bridge（推进后 refresh 一次）；
 *   3. 把状态变化通知给 UI（按钮启用/禁用、层级面板刷新）。
 *
 * ## 相机（ADR-018 P6，已改）
 *
 * 早期（docs/17 WU-4）定的是 A 方案：**不引入游戏相机**，编辑相机在 Play 中
 * 照常自由移动，理由是"改之前/改之后要能同机位对比"。
 *
 * 🔴 **该方案已被 P6 取代**：现在 Play 会切到场景的游戏相机（`entryCamera` →
 * 第一个启用的 Camera 组件），Stop 精确还原编辑机位。上面那段旧说明已作废，
 * 保留这段是为了说明"为什么变了"——别照旧注释理解现状。
 *
 * 不接管的情况（场景无可用 Camera / 未注入 viewCamera）仍保持编辑相机自由移动，
 * 即旧的 A 方案行为，所以调试对比能力没有丢。
 */

import { PlaySession, type PlayState } from '@aether/zombie-game';
import type { BehaviorExecutor } from '@aether/runtime';
import { SceneGraph } from '@aether/scene';
import {
  attachFixedTick, bindFractureToPlay, createGlbConvexResolver, prepareFractureActivation,
  type FractureAssetIO, type FractureEvent, type FracturePlayBinding, type FracturePlayResult,
} from '@aether/runtime';
import { createEditorFractureIO } from './fracture-io';
import { PlayFractureRenderer } from './fracture-renderer';
import {
  PlayCameraController,
  type ViewCameraControl,
  type WorldPosOf,
} from './play-camera';
import type { RuntimeBridge } from './runtime-bridge';
import type { AuthorSnapshot, LabRenderer } from '../renderer';
import type { PlayerPresentation } from './player-presentation';
import type { RuntimeSceneMotion } from './runtime-scene-motion';
import type { RuntimeBodyIk } from './runtime-body-ik';
import type { RuntimeWeapons } from './runtime-weapons';
import { characterYaw } from './character-facing';
import { PlayVfx } from './play-vfx';
import { syncGatePresentation } from './gate-presentation';
import type {RuntimeDecals} from './runtime-decals';

export interface PlayControllerOptions {
  /** 碎片资产 IO（默认走编辑器 /__fs/file；测试注入内存实现）。 */
  readonly fractureIO?: FractureAssetIO;
  weapons?: RuntimeWeapons;
  decals?:RuntimeDecals;
  bodyIk?: RuntimeBodyIk;
  sharedMotions?: RuntimeSceneMotion;
  playerPresentation?: PlayerPresentation;
  seed?: number;
  capacity?: number;
  /**
   * 行为执行器（ADR-018 P3）。由**编辑器宿主**注入（`behavior-host.ts` 提供），
   * runtime 侧保持纯 CPU、不 import 行为代码。
   */
  executor?: BehaviorExecutor;
  /**
   * 主视图相机控制（ADR-018 P6）。传入后 Play 会切到场景的游戏相机。
   *
   * **不传 = 保持编辑相机不动**（此前的行为）。必须显式传入，避免"悄悄改了视角"
   * 这种没有声明的副作用。
   */
  viewCamera?: ViewCameraControl;
  /** 取场景节点世界坐标（Play 相机定位用） */
  worldPosOf?: WorldPosOf;
  /** 状态变化时回调（UI 据此刷新按钮与面板） */
  onStateChange?: () => void;
}

export class PlayController {
  readonly vfx:PlayVfx;
  readonly session: PlaySession;
  private readonly bridge: RuntimeBridge;
  private readonly renderer: LabRenderer;
  private readonly onStateChange: (() => void) | null;
  /** 碎片运行时绑定（R3：真实 Play 驱动；null = 未启用或已释放）。 */
  private fractureBinding: (FracturePlayBinding & { onFixedTick(dtSec: number): void }) | null = null;
  /** 碎片账目项是否已登记（每轮 Play 只登记一次，reset 复用同一项）。 */
  private fractureRegistered = false;
  /** 碎片资产 IO（默认走编辑器 /__fs/file；测试可注入）。 */
  private readonly fractureIO: FractureAssetIO;
  /** 碎片动态渲染装配（WU-05）：ActiveChunk → 原 CoreDynamicBatch。 */
  private fractureRenderer: PlayFractureRenderer | null = null;
  /** 本 Play 内已破坏的稳定 NodeId（Reset/Stop 恢复完整显示）。 */
  private readonly brokenNodes = new Set<string>();
  private brokenMirrorsDirty = false;
  private readyRetryBinding: FracturePlayBinding | null = null;
  private pendingDestructibleEvents: FractureEvent[] = [];
  private lastDestructibleError: string | null = null;
  /** Play 相机控制器。null = 不接管相机（保持编辑相机） */
  private readonly playCamera: PlayCameraController | null;
  private readonly worldPosOf: WorldPosOf | null;
  private snap: AuthorSnapshot | null = null;
  private lastError: string | null = null;
  private readonly playerPresentation: PlayerPresentation | null;
  private readonly sharedMotions: RuntimeSceneMotion | null;
  private readonly bodyIk: RuntimeBodyIk | null;
  private readonly optionsWeapons: RuntimeWeapons | null;
  private readonly decals:RuntimeDecals|null;

  constructor(renderer: LabRenderer, bridge: RuntimeBridge, opts: PlayControllerOptions = {}) {
    this.renderer = renderer;
    this.vfx=new PlayVfx(renderer.core,doc=>decalReceivers(renderer,doc));
    this.decals=opts.decals??null;
    this.playerPresentation = opts.playerPresentation ?? null;
    this.sharedMotions = opts.sharedMotions ?? null;
    this.bodyIk = opts.bodyIk ?? null;
    this.optionsWeapons = opts.weapons ?? null;
    this.bridge = bridge;
    this.onStateChange = opts.onStateChange ?? null;
    // 没传 viewCamera 就是"不接管相机"，此时控制器存在但 attach 恒为 false
    this.playCamera =
      opts.viewCamera === undefined
        ? null
        : new PlayCameraController(opts.viewCamera);
    this.worldPosOf = opts.worldPosOf ?? null;
    this.fractureIO = opts.fractureIO ?? createEditorFractureIO();
    this.session = new PlaySession({
      seed: opts.seed ?? 1,
      capacity: opts.capacity ?? 512,
      ...(opts.executor !== undefined ? { executor: opts.executor } : {}),
    });
  }

  get state(): PlayState {
    return this.session.state;
  }

  /** 是否处于 Play 模式（含暂停）。Play 中要禁掉会改变物体数的编辑操作 */
  get isPlaying(): boolean {
    return this.session.state !== 'stopped';
  }

  get isPaused(): boolean {
    return this.session.state === 'paused';
  }
  get observing():boolean {return this.playCamera?.observation??false;}
  setObservation(on:boolean):boolean {return this.isPlaying&&(this.playCamera?.setObservation(on)??false);}

  get tick(): number {
    return this.session.tick;
  }

  /** 最近一次启动失败的原因；null = 没有失败 */
  get error(): string | null {
    return this.lastError;
  }

  get diagnostics() {
    return this.session.diagnostics;
  }

  /** 运行期诊断（容量不足整批拒绝等）。装载期诊断在 `diagnostics`，两者语义不同 */
  get runtimeDiagnostics() {
    return this.session.runtimeDiagnostics;
  }

  /** 资源账目。`pending === 0` = Stop 后无未释放的 Play 期资源 */
  get ledger() {
    return this.session.ledger;
  }

  /**
   * 进入 Play。
   *
   * 失败时**不动作者状态**（快照都还没打），只把原因留在 `error` 里给 UI 显示 ——
   * 装载失败还把场景快照一遍再恢复，是纯粹的自我感动。
   */
  start(): boolean {
    const doc = this.renderer.getDocument();
    if (doc === null) {
      this.lastError = '场景尚未加载，无法进入 Play';
      return false;
    }
    let playerNode: string | null = null;
    try { playerNode = this.playerPresentation?.prepare(doc) ?? null; }
    catch (error) { this.lastError = String(error); return false; }
    const r = this.session.play(doc);
    if (!r.ok) {
      this.lastError = r.errors.length > 0 ? r.errors.join('；') : '场景装载失败';
      return false;
    }
    // 未 Stop 就再次 Play（换场景）时，PlaySession 已经释放了旧登记资源
    // （含旧 fracture binding）。控制器必须同步清引用并允许重新登记，
    // 否则新 binding 不登记、Stop 时无人释放，账目 pending=0 是假账。
    this.fractureBinding = null;
    this.fractureRegistered = false;
    // 快照必须在装载成功之后：装载失败不该动作者状态
    this.snap = this.renderer.snapshotAuthorState();
    for (const node of doc.nodes) {
      if (!node.components.some(c => c.kind === 'MeshRenderer' &&
        (c.editorOnly === true || (node.id === doc.playerStart && playerNode === null)))) continue;
      const index = this.renderer.findObjectIndexByNodeId(node.id);
      if (index !== null) this.renderer.setObjectVisible(index, false);
    }

    // Play 相机（ADR-018 P6）。相机不在 AuthorSnapshot 里，所以必须自己存/还原：
    // attach 内部先存编辑相机再切游戏相机，顺序反了就还原不回去。
    if (this.playCamera !== null && this.worldPosOf !== null) {
      const took = this.playCamera.attach(doc, this.worldPosOf);
      if (took) {
        // 🔴 登记顺序 = 释放顺序，勿随意调整。
        // 相机登记在 bridge-batches（下面）**之前**，是为了保证 Stop 时先还原相机、
        // 再摘 Bridge —— 反序会闪一下"关卡回到编辑态但视角还在游戏里"的鬼影。
        // stop() 里另有一句显式 detach 作为第一重保险；两重都在，去掉任一重仍成立，
        // 但**不要两重都去**。
        this.session.registerResource('play-camera', () => this.playCamera?.detach());
      }
    }

    this.bridge.attach(this.session.runtime);
    this.decals?.start(this.session.runtime);
    if(this.decals)this.session.registerResource('procedural-decals',()=>this.decals?.stop());
    this.syncGates();
    this.sharedMotions?.start(doc);
    this.bodyIk?.start(doc);
    this.optionsWeapons?.start(doc,this.session);
    if (this.playerPresentation) this.bridge.setPlayerPresentation(playerNode);
    this.playerPresentation?.sync(this.session.runtime?.player() ?? null, this.bodyIk?.locomotion(this.session.runtime?.player()?.sourceNodeId ?? '') ?? false);
    this.sharedMotions?.sync(this.session.runtime);
    this.bodyIk?.sync(this.session.runtime);
    this.optionsWeapons?.sync(this.session.runtime);
    // Play 期分配的句柄必须进 PlaySession 的账目（AGENTS.md §2.4），
    // 否则"Stop 后无残留"只能靠人眼观察 —— 项目正是这么踩过泄漏坑的。
    this.session.registerResource('bridge-batches', () => this.bridge.attach(null));
    // 🔴 渲染侧的动态实例资源也要进账目：只摘 CPU 侧 bridge 的话，账目显示 pending = 0
    // 而 GPU 上仍留着 Play 期分配的实例 buffer 与代理网格缓存（由 renderer-core 持有）。
    // 见 PR #3 review / AGENTS.md §2.4「Play 期每次 GPU 分配都必须登记并在 Stop 释放」。
    this.session.registerResource('dynamic-instances', () => this.renderer.core.releaseDynamicResources());
    this.vfx.start(this.session,doc);

    // R3：碎片运行时接入真实 Play（装配→固定 tick 驱动→Stop 释放）。
    // 场景 collider 镜像从 doc 重建 SceneGraph（与 loader 同一真源）。
    {
      const graph = SceneGraph.fromDocument(doc);
      graph.updateWorldTransforms();
      // 单一账目项：只在首次装配时向 PlaySession 登记一次，回调释放"当前"绑定。
      // 这样 reset 换绑（旧代释放、新代接管）后 Stop 仍释放新绑定，
      // 也不会像之前那样每轮额外登记一项，把 pending 从 2/3 顶到 4/5。
      this.fractureBinding = this.createFractureBinding(graph);
      // WU-05：碎片动态渲染装配。资源所有权仍在 renderer-core（Play 新分配由
      // PlaySession 账目在 Stop 时 releaseDynamicResources 统一 destroy）。
      this.renderer.core.resetDynamicDiagnostics?.();
      this.fractureRenderer?.dispose();
      this.fractureRenderer = new PlayFractureRenderer(this.fractureIO);
      this.session.registerResource('fracture-renderer', () => {
        this.fractureRenderer?.dispose();
        this.fractureRenderer = null;
      });
      // 初始即开启的导航门（initialOpen:true）在运行时已处于开启姿态，而作者文档
      // 仍是关闭位置。binding ready 后、接受首个碎片 tick 前把当前门姿态灌进镜像，
      // 否则启动瞬间的静态可观察状态是错的（要等第一帧才纠正）。
      void this.fractureBinding.ready.then((ok) => {
        if (ok) this.syncGateMirrors();
      });
    }

    this.lastError = null;
    this.notify();
    return true;
  }

  pause(): void {
    this.session.pause();
    this.notify();
  }

  resume(): void {
    this.session.resume();
    this.notify();
  }

  togglePause(): void {
    if (this.session.state === 'playing') this.pause();
    else if (this.session.state === 'paused') this.resume();
  }

  /** 碎片动态批次（WU-05；main 每帧与角色批次合并后交给 renderer）。 */
  get fractureBatches() {
    return this.fractureRenderer?.dynamicBatches ?? [];
  }

  /** 本 Play 会话累计的动态资源构建/绘制失败次数（新 Play 开始时清零）。 */
  get fractureRenderFailures(): number {
    return this.renderer.core.dynamicFailureCount;
  }

  /** 最近一次碎片网格准备失败的原因（null = 无失败；供 HUD/诊断读取）。 */
  get fractureRenderError(): string | null {
    // 当前仍失败：网格准备（碎片渲染装配）或 GPU 网格构建（renderer-core）。
    const current = this.fractureRenderer?.error ?? this.renderer.core.dynamicError;
    if (current !== null && current !== undefined) return current;
    // 曾经失败但已恢复：保留"发生过 N 次"的明确说明，不冒充当前仍坏。
    const failures = this.renderer.core.dynamicFailureCount;
    return failures > 0 ? ('曾发生 ' + failures + ' 次 GPU 动态资源构建/绘制失败（当前已恢复）') : null;
  }

  /** 碎片渲染统计（验收观察：已加载网格/实例/三角形）。 */
  get fractureRenderStats() {
    return this.fractureRenderer?.stats ?? {
      meshes: 0, instances: 0, triangles: 0, textures: 0,
      geometryBytes: 0, textureFileBytes: 0, textureUploadBytes: 0, textureResidentBytes: 0,
      uploadBytes: 0, residentBytes: 0, instanceBytes: 0,
    };
  }

  /** 场景物体破坏→碎裂表现失败诊断（null = 无失败）。 */
  get destructibleError(): string | null {
    return this.lastDestructibleError;
  }

  /**
   * 消费游戏会话的一次性破坏事实：先切完整表现/碰撞，再走正式 spawnFracture。
   * 事实在会话侧已完成状态转换；表现失败不回滚，只记录诊断。
   */
  private consumeDestructibleEvents(): void {
    const rt = this.session.runtime;
    if (rt === null) return;
    this.pendingDestructibleEvents.push(...rt.takeDestructibleEvents());
    if (this.pendingDestructibleEvents.length === 0) {
      if (this.brokenMirrorsDirty) this.syncBrokenMirrors();
      return;
    }
    const queue = this.pendingDestructibleEvents;
    this.pendingDestructibleEvents = [];
    const binding = this.fractureBinding;
    for (const ev of queue) {
      if (ev.target.kind !== 'scene-object') continue;
      const nodeId = ev.target.nodeId;
      // 表现切换先于后端就绪：玩法事实成立时完整对象必须立即不可见，且物理镜像同步移除。
      if (!this.brokenNodes.has(nodeId)) {
        this.brokenNodes.add(nodeId);
        this.brokenMirrorsDirty = true;
        const index = this.renderer.findObjectIndexByNodeId(nodeId);
        if (index !== null) this.renderer.setObjectVisible(index, false);
        this.syncBrokenMirrors();
      }
      if (binding === null || binding.backend() === null) {
        this.pendingDestructibleEvents.push(ev);
        this.brokenMirrorsDirty = true;
        this.lastDestructibleError = nodeId + '：碎片运行时未就绪（等待重试）';
        // 真实后端就绪后必须再按去掉 broken 的运行图 sync 一次，否则 ready 的初始
        // author-graph sync 会把镜像重新加回来（幽灵 collider）。
        if (binding !== null && this.readyRetryBinding !== binding) {
          this.readyRetryBinding = binding;
          void binding.ready.then(() => {
            this.brokenMirrorsDirty = true;
            this.consumeDestructibleEvents();
          });
        }
        continue;
      }
      if (binding.failure !== null) {
        this.lastDestructibleError = nodeId + '：碎片运行时不可用（' + binding.failure.stage + ' — ' + binding.failure.detail + '）';
        console.warn('[fracture] ' + this.lastDestructibleError);
        continue;
      }
      this.syncBrokenMirrors();
      void this.spawnFracture(ev).then((r) => {
        if (!r.accepted) {
          const rej = r.rejection;
          // Reset/Stop 造成的旧代取消是预期取消，不是用户可见的破坏表现失败。
          if (rej !== null && rej.reason === 'session-closed') return;
          this.lastDestructibleError = nodeId + '：' + (rej === null ? 'fracture-rejected' : rej.reason + ' — ' + rej.detail);
          console.warn('[fracture] ' + this.lastDestructibleError);
        } else if (this.lastDestructibleError?.startsWith(nodeId + '：碎片运行时未就绪')) {
          this.lastDestructibleError = null;
        }
      });
    }
    if (this.brokenMirrorsDirty) this.syncBrokenMirrors();
  }

  /** 用去掉 broken 节点的运行图同步物理镜像；后端未就绪时保持 dirty 供重试。 */
  private syncBrokenMirrors(): boolean {
    const binding = this.fractureBinding;
    if (binding === null || binding.backend() === null) return false;
    const graph = this.runtimeGraphWithoutBroken();
    if (graph === null) return false;
    binding.syncScene(graph);
    this.brokenMirrorsDirty = false;
    return true;
  }

  /** 从作者文档派生运行期图：仅把已破坏节点标为不可见，用于移除其物理镜像。 */
  private runtimeGraphWithoutBroken(): SceneGraph | null {
    const doc = this.renderer.getDocument();
    if (doc === null) return null;
    const copy = structuredClone(doc);
    for (const n of copy.nodes) if (this.brokenNodes.has(n.id)) n.visible = false;
    const graph = SceneGraph.fromDocument(copy);
    graph.updateWorldTransforms();
    return graph;
  }

  private restoreBrokenNodes(): void {
    for (const nodeId of this.brokenNodes) {
      const index = this.renderer.findObjectIndexByNodeId(nodeId);
      if (index !== null) this.renderer.setObjectVisible(index, true);
    }
    this.brokenNodes.clear();
    this.brokenMirrorsDirty = false;
    this.readyRetryBinding = null;
    this.pendingDestructibleEvents = [];
    this.lastDestructibleError = null;
  }

  /** 把当前运行时状态同步成动态批次（large 读后端快照，small 读简化 sim）。 */
  private syncFractureBatches(): void {
    const binding = this.fractureBinding;
    // 后端未就绪（WASM 加载中）时没有可画的碎片；不要碰 runtime getter（它会抛）。
    if (binding === null || binding.backend() === null) {
      this.fractureRenderer?.sync(null, null);
      return;
    }
    this.fractureRenderer?.sync(binding.runtime, binding.backend());
  }

  /** 碎片绑定只读视图（调试/验收观察；Stop 后为 null）。 */
  get fracture(): (FracturePlayBinding & { onFixedTick(dtSec: number): void }) | null {
    return this.fractureBinding;
  }

  /**
   * 释放当前碎片绑定（不发会话账目；Stop 由登记的回调统一处理）。
   * 走 binding 的完整释放链：退役活动块/归还租约/清队列/标记 disposed，再销毁 World。
   * 只销毁 session 会把活动租约与排队请求留在旧代里（曾经的真实缺陷）。
   */
  private disposeFracture(): void {
    const b = this.fractureBinding;
    this.fractureBinding = null;
    if (b !== null) b.dispose();
  }

  /**
   * 装配/换绑碎片运行时。会话账目只登记一次：回调永远释放当时的 fractureBinding，
   * 因此 reset 后的新绑定同样会被 Stop 释放，且账目项数不随重跑增长。
   */
  private createFractureBinding(graph: SceneGraph): FracturePlayBinding & { onFixedTick(dtSec: number): void } {
    if (!this.fractureRegistered) {
      this.fractureRegistered = true;
      this.session.registerResource('fracture-runtime', () => {
        this.disposeFracture();
      });
    }
    return attachFixedTick(bindFractureToPlay(
      { fixedStepSec: this.session.fixedStep, registerResource: () => { /* 由上面的单一项统一登记 */ } },
      { initialScene: graph },
    ));
  }

  /** reset 换绑：先释放旧代，再按当前作者场景重建（不新增账目项）。 */
  private rebuildFractureBinding(): void {
    this.disposeFracture();
    // Reset/换绑：让重置之前挂起的网格读取失效，不能写回新代的渲染缓存。
    this.fractureRenderer?.beginGeneration();
    // CPU 缓存已换代；core 的 fracture GPU mesh 也按前缀释放，下一次 sync 必须重新上传
    // 当前资产字节，不能复用同路径的旧 vbuf。
    this.renderer.core.releaseDynamicMeshesWithPrefix?.('fracture:');
    const doc = this.renderer.getDocument();
    if (doc === null) return;
    const graph = SceneGraph.fromDocument(doc);
    graph.updateWorldTransforms();
    this.fractureBinding = this.createFractureBinding(graph);
    // reset 后 NavigationGates 已恢复到 initialOpen 姿态；新 binding 的首次镜像仍来自
    // 作者文档，必须在 ready 后立刻对齐，不能等到下一次 update/step。
    void this.fractureBinding.ready.then((ok) => {
      if (ok) this.syncGateMirrors();
    });
  }

  /**
   * 生产激活入口：按碎裂事件读取 profile/资产、走正式准入，再交给碎片运行时播放。
   * WU-06/07 的伤害/死亡策略从这里喂事件；Preview 走同一 prepare 函数。
   */
  async spawnFracture(event: FractureEvent): Promise<FracturePlayResult | { accepted: false; rejection: { reason: string; detail: string; eventKey: string }; activationGen: number }> {
    const binding = this.fractureBinding;
    if (binding === null || binding.backend() === null) {
      return { accepted: false, rejection: { reason: 'not-ready', detail: '碎片运行时未就绪', eventKey: '' }, activationGen: 0 };
    }
    const prepared = await prepareFractureActivation(event, {
      io: this.fractureIO,
      resolveConvexPoints: createGlbConvexResolver(),
    });
    if (!prepared.ok) {
      return {
        accepted: false,
        rejection: { reason: prepared.failure.stage, detail: prepared.failure.detail, eventKey: '' },
        activationGen: 0,
      };
    }
    // IO 是异步的：读取期间可能发生 Stop/Reset/换场景。await 之后必须重新核对
    // 当前代，不能拿捕获的旧 binding 直接 play（否则要么复活旧代，要么抛未预期异常）。
    if (this.fractureBinding !== binding || binding.backend() === null) {
      return {
        accepted: false,
        rejection: {
          reason: 'session-closed',
          detail: '碎片资产读取期间会话已结束或换绑，本次激活作废（可重试）',
          eventKey: '',
        },
        activationGen: 0,
      };
    }
    try {
      return binding.runtime.play(prepared.activation);
    } catch (e) {
      return {
        accepted: false,
        rejection: { reason: 'runtime-unavailable', detail: String(e), eventKey: '' },
        activationGen: 0,
      };
    }
  }

  /** 单步。只在暂停下有效（语义由 PlaySession 保证） */
  step(): void {
    this.session.stepOnce();
    this.consumeDestructibleEvents();
    // 只在暂停态实际推进时驱动碎片（非暂停下 stepOnce 为空操作，不重复 tick）。
    if (this.session.state === 'paused' && this.session.outcome === 'running') {
      this.syncGateMirrors();
      this.fractureBinding?.onFixedTick(this.session.fixedStep);
    }
    this.syncGates();
    this.decals?.sync(this.session.runtime);
    this.sharedMotions?.sync(this.session.runtime);
    this.playerPresentation?.sync(this.session.runtime?.player() ?? null, this.bodyIk?.locomotion(this.session.runtime?.player()?.sourceNodeId ?? '') ?? false);
    this.bodyIk?.sync(this.session.runtime, true);
    this.syncFractureBatches();
    this.optionsWeapons?.sync(this.session.runtime);
    this.syncPlayCamera();
    this.bridge.refresh();
    this.vfx.update(this.session);
    this.notify();
  }

  /** 同种子重跑 */
  reset(): void {
    // 碎片绑定按 Play 代数隔离：重跑先释放旧代（session 仍活着，Stop 账目不会替你收），
    // 再按当前场景重建，避免旧代碎片跨重跑残留。
    this.rebuildFractureBinding();
    this.session.reset();
    this.restoreBrokenNodes();
    this.decals?.start(this.session.runtime);
    this.syncGates();
    this.sharedMotions?.sync(this.session.runtime);
    this.playerPresentation?.sync(this.session.runtime?.player() ?? null, this.bodyIk?.locomotion(this.session.runtime?.player()?.sourceNodeId ?? '') ?? false);
    this.bodyIk?.sync(this.session.runtime);
    this.optionsWeapons?.sync(this.session.runtime);
    this.syncPlayCamera();
    this.bridge.refresh();
    this.vfx.stop();this.vfx.start(this.session,this.renderer.getDocument()??undefined);this.vfx.update(this.session);
    this.notify();
  }

  /**
   * 退出 Play 并恢复作者状态。
   *
   * 顺序很关键：**先恢复场景，再断会话**。反过来做的话，恢复期间画面上还挂着
   * 上一帧的动态实例，会闪一下"僵尸还在但关卡回到编辑态"的鬼影。
   */
  stop(): void {
    this.optionsWeapons?.stop();
    this.bodyIk?.stop();
    this.sharedMotions?.stop();
    this.playerPresentation?.detach();
    if (this.snap !== null) {
      const res = this.renderer.restoreAuthorState(this.snap);
      if (res.mismatched) {
        console.warn(
          `[play] Stop 时物体数与快照不一致（快照 ${this.snap.count}，当前 ${res.restored} 起），` +
            'Play 期间发生过增删 —— 已按索引逐个恢复，请检查是否张冠李戴',
        );
      }
      this.snap = null;
    }
    this.brokenNodes.clear();
    this.brokenMirrorsDirty = false;
    this.readyRetryBinding = null;
    this.pendingDestructibleEvents = [];
    this.lastDestructibleError = null;
    // 先还原相机，再断会话：反过来做的话，恢复期间画面还挂着游戏机位，
    // 会闪一下"关卡回到编辑态但视角还在游戏里"的鬼影。
    this.playCamera?.detach();
    this.session.stop();
    this.fractureBinding = null;
    this.fractureRegistered = false;
    this.fractureRenderer = null;
    this.bridge.attach(null);
    this.notify();
  }

  /** 每帧调用：推进固定步 → 同步实例数据 → 跟随相机。返回本帧走的步数 */
  update(dt: number): number {
    const n = this.session.advance(dt);
    this.consumeDestructibleEvents();
    if (n > 0) {
      // R3：真实固定步驱动碎片物理（渲染频率不反推物理时钟）。
      // 终态（game-over / floor-clear）时 PlaySession 仍可能返回步数，但世界已冻结：
      // 碎片必须跟随冻结，不能继续模拟（装饰物不该在结算画面里继续动）。
      if (this.session.outcome === 'running') {
        // 门等运行期 collider 的权威姿态先落到碎片镜像，再驱动本帧碎片 tick；
        // 反序会让每个碎片 tick 都用上一帧的门位置（catch-up 时连续用旧位置）。
        this.syncGateMirrors();
        for (let i = 0; i < n; i++) this.fractureBinding?.onFixedTick(this.session.fixedStep);
      }
      this.syncGates();
      this.decals?.sync(this.session.runtime);
      this.sharedMotions?.sync(this.session.runtime);
      this.playerPresentation?.sync(this.session.runtime?.player() ?? null, this.bodyIk?.locomotion(this.session.runtime?.player()?.sourceNodeId ?? '') ?? false);
      this.bridge.refresh();
      this.syncPlayCamera();
      this.syncFractureBatches();
    }
    if (this.session.state === 'playing') this.bodyIk?.sync(this.session.runtime);
    this.vfx.update(this.session);
    // 暂停只重建同一相位的装配请求；异步资产就绪与持握草稿预览不推进模拟/动画时钟。
    if (this.session.state !== 'stopped') this.optionsWeapons?.sync(this.session.runtime);
    return n;
  }

  /**
   * 让游戏相机跟随玩家（仅 orbit-follow 模式生效）。
   *
   * 玩家位置取自**运行时实体**而不是场景节点——场景里的节点是静态的，
   * 只有玩家实体会在 Play 中移动。取不到玩家（还没生成/已死亡）就传 null，
   * 相机保持上一次的位置，不抖动。
   */
  private syncPlayCamera(): void {
    if (this.playCamera === null || !this.playCamera.active) return;
    const rt = this.session.runtime;
    if (rt === null) {
      this.playCamera.update(null);
      return;
    }
    // O(1) 取玩家（旧实现是 view().find() —— 每帧全表扫 + 建整个数组）
    const p = rt.player();
    this.playCamera.update(p === null ? null : { x: p.x,y:p.y??0,z:p.z,yaw:characterYaw(p.yaw) });
  }

  private notify(): void {
    this.onStateChange?.();
  }
  private syncGates():void {
    const rt=this.session.runtime;
    syncGatePresentation(rt,id=>{const i=this.renderer.findObjectIndexByNodeId(id);return i===null?null:this.renderer.state.objects[i]??null;});
    this.syncGateMirrors();
  }
  /** 只把门的权威运行姿态同步进碎片静态镜像（不碰渲染表现）。 */
  private syncGateMirrors():void {
    const rt=this.session.runtime;
    // 门的权威运行姿态同时要进碎片静态镜像：只同步渲染对象会让碎片后端
    // 继续留在作者文档的初始位置，出现「门已升起、碎片仍被旧位置挡住」。
    this.fractureBinding?.syncRuntimePoses(rt?.gateSnapshot()??[]);
  }
}
