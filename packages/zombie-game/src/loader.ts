/**
 * 场景运行装载（WU-1b）—— 把 SceneDocument 解释成"运行描述"。
 *
 * ## 为什么它必须存在，且只能有一份
 *
 * docs/17 §4：「Node 和浏览器必须共用装载与游戏规则，宿主负责把真实输入/时钟转为
 * 约定的运行输入，**禁止各宿主解释一次场景语义**。」
 *
 * 在这之前，"哪些节点是房间、刷怪点在哪、障碍有哪些"这套解释写在 `sim-level.mjs` 里，
 * 只有 CLI 一份。等编辑器要做 Play 时，要么复制一份（两份语义必然漂移），
 * 要么回头抽——后者现在做，成本最低。
 *
 * ## 依赖方向（为什么这里可以 import @aether/*）
 *
 * docs/17 §3.5：headless 只要求与 DOM / GPU / 真实时间解耦，**不要求**禁止复用 `@aether/*`。
 * 本文件依赖的两者都是纯数据侧：
 *   - `@aether/scene`  —— 数据契约（SceneDocument）+ 世界变换（SceneGraph）
 *   - `@aether/content` —— 只读生成物（角色参数，来自 stats.json）
 * 不依赖 render（GPU）与任何编辑器模块，所以 vitest / Node CLI / 浏览器都能用。
 *
 * ## 世界变换
 *
 * 一律走 `SceneGraph.updateWorldTransforms()`。此前 CLI 里手写过"沿 parent 链累加
 * position"，那只对了没有旋转和缩放的场景 —— 一旦有父级缩放，刷怪点就会飘。
 */

import { SceneGraph, validRunRules, validNavigationSettings, validSurfaceNavigationSettings, type SurfaceNavigationSettings, type NavigationSettings, type RunRulesComponent } from '@aether/scene';
import type { NavigationSurface } from '@aether/ai';
import { lookupCharacterStats } from '@aether/content';
import { solidCollider, type SolidColliderDesc } from "@aether/runtime";
import type {
  AabbData,
  ColliderComponent,
  NodeId,
  RoomVolumeComponent,
  SceneDocument,
  SceneNodeRuntime,
  ScriptComponent,
  SpawnPointComponent,
} from '@aether/scene';
import type { ScriptDesc } from "@aether/runtime";

/** 装载诊断。与 SceneDiagnostic 同构，但额外带 NodeId 便于在运行期定位 */
export interface LoadDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  /** 定位到作者节点；场景级问题为 null */
  nodeId: NodeId | null;
}

/** 房间（世界 XZ 矩形）。Y 轴本轮不参与判定 */
export interface RoomDesc {
  nodeId: NodeId;
  name: string;
  roomType: RoomVolumeComponent['roomType'];
  theme: RoomVolumeComponent['theme'];
  clearRule: RoomVolumeComponent['clearRule'];
  clearTarget?: NodeId | null;
  depth: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  enabled: boolean;
  minY?:number;
  maxY?:number;
}

/** 刷怪点。x/z 是世界坐标；roomNodeId 指向它归属的房间（用于进入触发） */
export interface SpawnDesc {
  nodeId: NodeId;
  name: string;
  characterId: string;
  count: number;
  wave: number;
  trigger: SpawnPointComponent['trigger'];
  delaySec: number;
  /** 生成散布半径（米） */
  radius: number;
  x: number;
  y?: number;
  z: number;
  enabled: boolean;
  /** 沿 parent 链最近的有 RoomVolume 的祖先；自由刷怪点为 null */
  roomNodeId: NodeId | null;
}

/**
 * 静态障碍（世界 XZ）。
 *
 * 只取 `Collider` 且 `isTrigger === false` 的节点 —— 触发器是"进入就发事件"的语义，
 * 不挡路，混进来会让所有门框变成墙。
 */
export interface ObstacleDesc {
  nodeId: NodeId;
  name: string;
  x: number;
  z: number;
  /** box 用半宽/半深；sphere / capsule 用 radius（两个字段都填，消费方按 shape 取） */
  shape: ColliderComponent['shape']['type'];
  halfX: number;
  halfZ: number;
  radius: number;
  enabled: boolean;
  minY?:number;
  maxY?:number;
}

/** 导航作用域。null = 场景没声明 NavZone，装载会报 error */
export interface NavDesc {
  nodeId: NodeId;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  cellSize: number;
  /** 旧构造 API 可省略；场景装载必须显式携带通过校验的 v16 配置。 */
  crowd?: NavigationSettings;
  surface?:SurfaceNavigationSettings;
  surfaces?:NavigationSurface[];
}

/** 运行描述：装载产物，RuntimeSession 的唯一输入（除种子与固定步长外） */
export interface LevelRuntimeDesc {
  runRules?: RunRulesComponent | null;
  sceneId: string;
  sceneName: string;
  /** 场景 schemaVersion + 本装载器的契约版本，用于复现比对 */
  schemaVersion: number;
  playerStart: { nodeId: NodeId; x: number; y?:number; z: number };
  rooms: RoomDesc[];
  spawns: SpawnDesc[];
  obstacles: ObstacleDesc[];
  /** Actual finite 3D Collider solids, separate from the navigation XZ projection. */
  shotColliders: SolidColliderDesc[];
  nav: NavDesc | null;
  /**
   * 失败条件（P5，docs/23 §2.6）。**真源是场景的 `loseCondition`** —— 运行时不得
   * 硬编码"玩家死了就失败"，否则作者改场景里这条规则不会生效（schema 字段有定义
   * 却没人读 = 假数据载体，2026-10-02 审查抓到的空迁移）。
   *
   * `null` = 场景没声明（v4 之前且未走迁移链的文档）：**不猜**，玩家死亡不设终态，
   * 装载时出 warning 让作者看见（AGENTS.md §2.2：不静默修数据）。
   */
  loseCondition: 'player-death' | null;
  /**
   * 场景节点上的脚本（ADR-018 P3）。
   *
   * 只收**启用节点**的 Script 组件：层级里隐藏一个节点，作者的意图是"这个东西
   * 现在不参与"，脚本跟着停用才符合直觉。节点级隐藏与组件 enabled 是正交的两件事，
   * 这里按 visible 过滤（组件 enabled 的解释权归组件语义，本轮先不叠加）。
   */
  scripts: ScriptDesc[];
}

export interface LoadResult {
  desc: LevelRuntimeDesc | null;
  diagnostics: LoadDiagnostic[];
}

/** 本轮**支持**的触发类型。其余一律出 diagnostic，不静默当 room-enter 处理 */
const SUPPORTED_TRIGGERS: ReadonlySet<string> = new Set(['room-enter']);

function aabbToXZ(b: AabbData): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const [cx, , cz] = b.center;
  const [sx, , sz] = b.size;
  return {
    minX: cx - sx / 2,
    maxX: cx + sx / 2,
    minZ: cz - sz / 2,
    maxZ: cz + sz / 2,
  };
}

/** `RoomVolume` / `NavZone` 的 bounds 与世界位置一致性容差（米）——生成器写的是同一份数值 */
const BOUNDS_NODE_TOL_M = 1e-3;

/**
 * `RoomVolume` / `NavZone` 的 `bounds` 按**世界** XZ 解释（`aabbToXZ` 直接吃 center/size），
 * 而同一装载函数里的 `Collider` / `SpawnPoint` 走节点**世界矩阵** —— 这是两套空间假设，
 * schema 也没有声明 bounds 属于哪个空间。
 *
 * 今天不冲突（生成器把房间节点摆在与 bounds 中心相同的位置），但**编辑器里拖动房间节点
 * 会破了它**：gizmo 写的是 `transform`，bounds 留在原地 → 触发区不动、里面的刷怪点跟着
 * 走，而玩家侧碰撞照旧生效 —— 静默分家、排查成本极高。这里显式告警（复审 B4）。
 *
 * 只在**节点真的会被渲染**时告警：口径与 `instantiateScene` 严格对齐 —— 组件启用、
 * 自身与祖先可见、且 `builtin` 网格（`asset` 网格在装载期是异步的，loadScene 会跳过）。
 * 三者任一不满足，该节点在视口里根本选不中、拖不动，对它告警等于常年喊狼来了，
 * 反而训练大家忽略红灯。（生成器给导航区不挂代理，就是这一类。）
 *
 * 返回 null = 一致或不适用；否则返回给作者看的文案（发 diagnostic 由调用方做）。
 */
function boundsNodeMismatchMessage(
  graph: SceneGraph,
  n: SceneNodeRuntime,
  bounds: AabbData,
  kindLabel: string,
): string | null {
  const comp = n.components.find((c) => c.kind === 'MeshRenderer');
  const meshComp = comp as { enabled?: boolean; source?: { type?: string } } | undefined;
  if (meshComp === undefined || meshComp.enabled === false) return null;
  if (!graph.isEffectivelyVisible(n.id)) return null;
  if (meshComp.source?.type !== 'builtin') return null;
  const dx = n.world.position[0] - bounds.center[0];
  const dz = n.world.position[2] - bounds.center[2];
  const d = Math.hypot(dx, dz);
  if (d <= BOUNDS_NODE_TOL_M) return null;
  return (
    `${kindLabel} 的 bounds 按**世界** XZ 解释（节点变换不参与），但与节点世界位置差了 ${d.toFixed(3)}m：` +
    `节点 xz=(${n.world.position[0].toFixed(3)}, ${n.world.position[2].toFixed(3)})，` +
    `bounds 中心 xz=(${bounds.center[0].toFixed(3)}, ${bounds.center[2].toFixed(3)})。` +
    `当前以 bounds 为准 —— 在视口里拖走该节点不会带上触发区，请同步更新 bounds`
  );
}

/**
 * 碰撞体的**世界空间**障碍范围（XZ）。
 *
 * 用节点世界矩阵的线性部分把局部形状推出去，**含旋转、缩放与父级链**：
 *   - 盒（OBB 的精确世界 AABB）：半轴 i = Σⱼ |Lᵢⱼ| · hⱼ
 *   - 球 / 胶囊（椭球的精确世界 AABB）：半轴 i = r · ‖Lᵢ‖
 * 曾经直接用 `halfExtents` / `radius` 当世界半宽，只对了**未经变换**的默认场景 ——
 * 旋转过的长条盒在世界系里可能更长（低估 = 穿墙），缩放过的直接算错。
 */
export function colliderWorldAabb(
  graph: SceneGraph,
  nodeId: NodeId,
  shape: ColliderComponent['shape'],
): { x: number; z: number; halfX: number; halfZ: number; radius: number;minY:number;maxY:number } {
  const m = graph.worldMatrix(nodeId);
  // 列主序：第 i 行的线性部分 = (m[i], m[i+4], m[i+8])，平移在 12/13/14
  const rowX = [m[0]!, m[4]!, m[8]!] as const;
  const rowZ = [m[2]!, m[6]!, m[10]!] as const;
  const tx = m[12]!;
  const tz = m[14]!;

  let halfX: number;
  let halfZ: number;
  if (shape.type === 'box') {
    const h = shape.halfExtents;
    halfX = Math.abs(rowX[0]) * h[0] + Math.abs(rowX[1]) * h[1] + Math.abs(rowX[2]) * h[2];
    halfZ = Math.abs(rowZ[0]) * h[0] + Math.abs(rowZ[1]) * h[1] + Math.abs(rowZ[2]) * h[2];
  } else if (shape.type === 'capsule') {
    // 🔴 胶囊 = 轴向线段 + 半径。只按球体处理会完全丢掉 height（复审 P2）：
    // 横向旋转后障碍范围被低估成半径，等于"胶囊不存在"。
    // 局部轴沿 Y（居中于原点），世界投影 = 线性部分第 1 列 × 半轴长；
    // 再按椭球半径（r × 各行模长）外扩。
    const r = shape.radius;
    const segHalf = Math.max(0, shape.height / 2 - r);
    halfX = Math.abs(m[4]! * segHalf) + r * Math.hypot(rowX[0], rowX[1], rowX[2]);
    halfZ = Math.abs(m[6]! * segHalf) + r * Math.hypot(rowZ[0], rowZ[1], rowZ[2]);
  } else {
    // sphere：半径乘线性部分各行的模长（非均匀缩放 → 椭球的精确 AABB）
    const r = shape.radius;
    halfX = r * Math.hypot(rowX[0], rowX[1], rowX[2]);
    halfZ = r * Math.hypot(rowZ[0], rowZ[1], rowZ[2]);
  }
  const rowY=[m[1]!,m[5]!,m[9]!];
  const halfY=shape.type==='box'?rowY.reduce((s,v,i)=>s+Math.abs(v)*shape.halfExtents[i]!,0)
    :shape.radius*Math.hypot(...rowY)+(shape.type==='capsule'?Math.abs(m[5]!)*Math.max(0,shape.height/2-shape.radius):0);
  return { x: tx, z: tz, halfX, halfZ, radius: Math.max(halfX, halfZ),minY:m[13]!-halfY,maxY:m[13]!+halfY };
}

/**
 * 装载。
 *
 * **不抛异常**（除非 SceneGraph 建图失败这种真正的坏文件）：所有问题进 diagnostics。
 * 调用方按 `hasError` 决定是否继续 —— 文档 §5.3 要求"不创建半运行世界"。
 */
export function loadLevelRuntime(doc: SceneDocument): LoadResult {
  const diags: LoadDiagnostic[] = [];
  const err = (code: string, message: string, nodeId: NodeId | null = null): void => {
    diags.push({ severity: 'error', code, message, nodeId });
  };
  const warn = (code: string, message: string, nodeId: NodeId | null = null): void => {
    diags.push({ severity: 'warning', code, message, nodeId });
  };

  let graph: SceneGraph;
  try {
    graph = SceneGraph.fromDocument(doc);
  } catch (e) {
    err('E_GRAPH', `场景建图失败：${e instanceof Error ? e.message : String(e)}`);
    return { desc: null, diagnostics: diags };
  }
  // fromDocument 内部已算过一次；结构没变，这里不重复算，仅为语义明确
  if (graph.isDirty) graph.updateWorldTransforms();

  // ---------------------------------------------------------- 玩家起点
  // 必须来自显式契约。缺了就拒绝，绝不回落到 rooms[0] 或节点顺序 ——
  // 那种回落会让"在层级面板里拖一下节点"变成"玩家出生位置变了"。
  let playerStart: LevelRuntimeDesc['playerStart'] | null = null;
  if (doc.playerStart === null || doc.playerStart === undefined) {
    err(
      'E_PLAYER_START_UNSET',
      '场景未指定 playerStart。玩家出生点不能靠隐式推导，请在场景里指定后重试。',
    );
  } else {
    const n = graph.getNode(doc.playerStart);
    if (n === null) {
      err('E_PLAYER_START_MISSING', `playerStart 指向不存在的节点：${doc.playerStart}`, doc.playerStart);
    } else {
      playerStart = {
        nodeId: doc.playerStart,
        x: n.world.position[0],
        y: n.world.position[1],
        z: n.world.position[2],
      };
    }
  }

  // ---------------------------------------------------------- 房间 / 刷怪点 / 障碍 / 导航
  const rooms: RoomDesc[] = [];
  const spawns: SpawnDesc[] = [];
  const obstacles: ObstacleDesc[] = [];
  const shotColliders: SolidColliderDesc[] = [];
  const surfaces:NavigationSurface[]=[];
  const scripts: ScriptDesc[] = [];
  let nav: NavDesc | null = null;

  graph.traverse((n) => {
    for (const c of n.components) {
      if (c.kind === 'RoomVolume') {
        const r = c as RoomVolumeComponent;
        const b = aabbToXZ(r.bounds);
        const mis = boundsNodeMismatchMessage(graph, n, r.bounds, 'RoomVolume');
        if (mis !== null) warn('W_BOUNDS_NODE_MISMATCH', mis, n.id);
        rooms.push({
          nodeId: n.id,
          name: n.name,
          roomType: r.roomType,
          theme: r.theme,
          clearRule: r.clearRule,
          clearTarget: r.clearTarget ?? null,
          depth: r.depth,
          minX: b.minX,
          maxX: b.maxX,
          minZ: b.minZ,
          maxZ: b.maxZ,
          minY:r.bounds.center[1]-r.bounds.size[1]/2,
          maxY:r.bounds.center[1]+r.bounds.size[1]/2,
          enabled: r.enabled,
        });
      } else if (c.kind === 'SpawnPoint') {
        const s = c as SpawnPointComponent;

        // 角色参数必须来自真源。查不到 = 作者填了 roster 里没有的 id，
        // 或 stats.json 漏登记 —— 两种都要作者去修，不能运行时塞默认值。
        const stats = lookupCharacterStats(s.characterId);
        if (stats === undefined) {
          err(
            'E_SPAWN_UNKNOWN_CHAR',
            `刷怪点引用了未登记的角色 ${s.characterId}（roster/stats 里都没有）`,
            n.id,
          );
        }

        if (!SUPPORTED_TRIGGERS.has(s.trigger)) {
          warn(
            'W_SPAWN_TRIGGER_UNSUPPORTED',
            `触发类型 "${s.trigger}" 本轮未实现，该刷怪点不会自动投放（不会静默当作 room-enter）`,
            n.id,
          );
        }

        // delaySec 是非零的默认值 0：本轮没有波次/延迟调度，`delaySec = 10` 会
        // **立即**刷怪 —— 那是"读取了字段却没有执行语义"。明确告知，不静默。
        if (s.delaySec > 0) {
          warn(
            'W_SPAWN_DELAY_UNSUPPORTED',
            `delaySec=${s.delaySec} 本轮未实现，该刷怪点将**立即**投放而不是延迟 ${s.delaySec} 秒`,
            n.id,
          );
        }

        // wave 语义已实现（P5 C4 WaveScheduler）：wave ≤ 0 归 1（旧数据=触发即全量），
        // 正值 = 房间内第 N 波（清空前一波才投放）。「W_SPAWN_WAVE_UNSUPPORTED」
        // 警告退役 —— 曾经的「读了字段没有语义」现在有了，不再警告。
        //
        // 🔴 但正值必须是整数（评审 4171651605）：调度器按整数 `nextWave` 推进，
        // wave=1.5 会参与 lastWave 的 max、却永远匹配不上任何整数 nextWave ——
        // 这个刷怪点被**静默跳过**，作者只看到"怪少了一批"却查不到原因。
        // 校验器（document.ts E_SPAWN_WAVE）已拦住入库文件；装载期再兜一道，
        // 因为 desc 也可能来自测试/程序生成，不止磁盘 JSON 一条路。
        if (s.wave > 0 && !Number.isInteger(s.wave)) {
          warn(
            'W_SPAWN_WAVE_FRACTIONAL',
            `wave=${s.wave} 不是整数：调度器按整数波号推进，该刷怪点将**永不投放**（改成整数，或 ≤0 走旧数据归 1）`,
            n.id,
          );
        }

        spawns.push({
          nodeId: n.id,
          name: n.name,
          characterId: s.characterId,
          count: s.count,
          wave: s.wave,
          trigger: s.trigger,
          delaySec: s.delaySec,
          radius: s.radius,
          x: n.world.position[0],
          y: n.world.position[1],
          z: n.world.position[2],
          enabled: s.enabled,
          roomNodeId: findOwningRoom(graph, n.id),
        });
      } else if (c.kind === 'Collider') {
        const col = c as ColliderComponent;
        if (col.isTrigger) continue; // 触发器不挡路
        if (col.enabled && graph.isEffectivelyVisible(n.id)) {
          try { shotColliders.push(solidCollider(n.id, col.shape, graph.worldMatrix(n.id))); }
          catch (e) { err('E_SHOT_COLLIDER', String(e), n.id); }
        }
        // 🔴 必须按**世界矩阵**（含旋转、缩放与父级链）算障碍范围。
        // 曾经直接用 `halfExtents` 当世界半宽 —— 旋转过的长条盒在世界系里可能
        // 反而更长（低估 → 僵尸穿墙），缩放过的则直接算错。
        const o: ObstacleDesc = {
          nodeId: n.id,
          name: n.name,
          ...colliderWorldAabb(graph, n.id, col.shape),
          shape: col.shape.type,
          enabled: col.enabled,
        };
        obstacles.push(o);
      } else if (c.kind === 'NavSurface') {
        if(!c.enabled)continue;
        if(!Array.isArray(c.size)||c.size.length!==2||!c.size.every(v=>Number.isFinite(v)&&v>0)){
          err('E_NAV_SURFACE','导航面尺寸非法',n.id);continue;
        }
        const m=graph.worldMatrix(n.id),hx=c.size[0]/2,hz=c.size[1]/2;
        const point=(x:number,z:number)=>[m[0]!*x+m[8]!*z+m[12]!,m[1]!*x+m[9]!*z+m[13]!,m[2]!*x+m[10]!*z+m[14]!];
        surfaces.push({id:n.id,...(c.supportCollider?{supportCollider:c.supportCollider}:{}),origin:point(-hx,-hz),u:point(hx,-hz),v:point(-hx,hz)});
      } else if (c.kind === 'NavZone') {
        if (!c.enabled) {
          // 禁用的 NavZone 不能"被接受但导航还正常"——那等于 enabled 字段在说谎。
          // 视为不存在，并明确告知（若因此没有任何 NavZone，后面会报 E_NAV_MISSING）
          warn('W_NAV_DISABLED', `NavZone ${n.id} 被禁用（enabled=false），不参与导航计算`, n.id);
          continue;
        }
        if (nav !== null) {
          warn('W_NAV_MULTIPLE', `场景有多个 NavZone，本轮只取第一个（${nav.nodeId}）`, n.id);
          continue;
        }
        const navMis = boundsNodeMismatchMessage(graph, n, c.bounds, 'NavZone');
        if (navMis !== null) warn('W_BOUNDS_NODE_MISMATCH', navMis, n.id);
        const b = aabbToXZ(c.bounds);
        if (!validNavigationSettings(c.crowd)) {
          err('E_NAV_CROWD', 'NavZone 避让配置缺失或非法，请先迁移场景', n.id);
          continue;
        }
        nav = {
          nodeId: n.id,
          minX: b.minX,
          minZ: b.minZ,
          maxX: b.maxX,
          maxZ: b.maxZ,
          cellSize: c.cellSize,
          crowd: { ...c.crowd },
          ...(c.surface?{surface:{...c.surface},surfaces}:{}),
        };
      } else if (c.kind === 'Script') {
        // Script 只存 behavior id + params，**绝不存代码字符串**（ADR-017）。
        // 这里做的是"登记待执行清单"，真正的执行由宿主注入的 BehaviorExecutor 完成
        // （ADR-018 R3：runtime 不 import 行为代码）。
        const sc = c as ScriptComponent;
        // 组件级 enabled（ComponentBase 契约）：禁用的脚本不执行（PR#16 review）
        if (!sc.enabled) {
          warn(
            'W_SCRIPT_DISABLED',
            `节点「${n.name}」的脚本「${sc.behavior}」被禁用（enabled=false），不参与本次运行`,
            n.id,
          );
          continue;
        }
        // 可见性用**有效可见**（祖先隐藏 = 整个子树隐藏），与渲染节点同一把尺子：
        // 只查 n.visible 会出现"藏了分组，渲染停了但行为还在跑"（PR#16 review）
        if (!graph.isEffectivelyVisible(n.id)) {
          warn(
            'W_SCRIPT_HIDDEN',
            `节点「${n.name}」被隐藏（自身或祖先 visible=false），其脚本「${sc.behavior}」不参与本次运行`,
            n.id,
          );
          continue;
        }
        if (sc.behavior.trim() === '') {
          warn('W_SCRIPT_EMPTY', `节点「${n.name}」的 Script 组件没有填 behavior id，已忽略`, n.id);
          continue;
        }
        // params 必须拷贝：运行期若被行为改写，不能污染作者文档
        scripts.push({ nodeId: n.id, behavior: sc.behavior, params: { ...sc.params } });
      }
    }
  });

  // ---------------------------------------------------------- 完整性
  if (nav === null) {
    err(
      'E_NAV_MISSING',
      '场景没有 NavZone。流场寻路需要作用域，没有它移动无法受障碍约束（不能退化成直线追击）。',
    );
  }
  const surfaceNav=nav as NavDesc|null;
  // 旧场景的 SpawnPoint Y 常为编辑标记高度；仅显式地表模式启用三维出生语义。
  if(!surfaceNav?.surface){if(playerStart)(playerStart as LevelRuntimeDesc['playerStart']).y=0;for(const spawn of spawns)spawn.y=0;}
  if(surfaceNav?.surface){
    if(!validSurfaceNavigationSettings(surfaceNav.surface))err('E_NAV_SURFACE_SETTINGS','三维导航配置非法',surfaceNav.nodeId);
    if(!surfaces.length)err('E_NAV_SURFACE_MISSING','三维导航必须声明启用的 NavSurface',surfaceNav.nodeId);
  }else if(surfaces.length)err('E_NAV_SURFACE_MODE','NavSurface 需要 NavZone.surface 配置，不能静默按平面运行');
  if (rooms.length === 0) {
    warn('W_NO_ROOM', '场景没有 RoomVolume，room-enter 触发的刷怪点永远不会投放');
  }

  // ---------------------------------------------------------- 失败条件（P5 §2.6）
  // 真源在场景里。缺字段 = 老文档未走迁移链 → **不猜**（补默认值是迁移链的活，
  // 装载期静默补会让"作者以为有规则"变成幽灵）；未知值 = error，拒绝造半运行世界。
  let loseCondition: LevelRuntimeDesc['loseCondition'] = null;
  const rawLose = doc.loseCondition as string | undefined;
  if (rawLose === undefined || rawLose === null) {
    warn(
      'W_LOSE_CONDITION_UNSET',
      `场景未声明 loseCondition（schemaVersion=${doc.schemaVersion}）。玩家死亡将**不**判定失败 —— 请用迁移链升级到 v4 或在场景里显式声明。`,
    );
  } else if (rawLose !== 'player-death') {
    err(
      'E_LOSE_CONDITION_UNKNOWN',
      `未知的 loseCondition：${rawLose}（本版只支持 'player-death'）；拒绝加载而不是当默认值处理。`,
    );
  } else {
    loseCondition = 'player-death';
  }

  const ruleComponents = doc.nodes.filter(n => graph.isEffectivelyVisible(n.id)).flatMap(n => n.components.filter(c => c.kind === 'RunRules' && c.enabled));
  for (const room of rooms) {
    if (!room.enabled || room.clearRule !== 'elite-dead' || !room.clearTarget) continue;
    if (!spawns.some(s => s.nodeId === room.clearTarget && s.roomNodeId === room.nodeId
      && s.enabled && s.count > 0 && s.trigger === 'room-enter')) {
      err('E_CLEAR_TARGET_UNAVAILABLE', '精英清场目标必须是当前房间内启用、数量大于零且由进入房间触发的刷怪点', room.nodeId);
    }
  }
  if (ruleComponents.length > 1 || ruleComponents.some(c => !validRunRules(c))) err('E_RUN_RULES', '场景成长规则无效或重复');
  const runRules = ruleComponents[0] as RunRulesComponent | undefined;
  if (runRules?.bossAttack && !spawns.some(s => s.nodeId === runRules.bossAttack!.source && s.enabled)) err('E_BOSS_SOURCE', 'Boss 攻击必须引用可用的刷怪点');
  const hasError = diags.some((d) => d.severity === 'error');
  if (hasError || playerStart === null) {
    return { desc: null, diagnostics: diags };
  }

  return {
    desc: {
      sceneId: doc.id,
      runRules: runRules ? structuredClone(runRules) : null,
      sceneName: doc.name,
      schemaVersion: doc.schemaVersion,
      playerStart,
      rooms,
      spawns,
      obstacles,
      shotColliders,
      nav,
      loseCondition,
      scripts,
    },
    diagnostics: diags,
  };
}

/** 沿 parent 链找最近的有 RoomVolume 的祖先。用于"玩家进了哪个房间 → 触发哪些刷怪点" */
function findOwningRoom(graph: SceneGraph, id: NodeId): NodeId | null {
  let cur = graph.getNode(id);
  while (cur !== null) {
    if (cur.components.some((c) => c.kind === 'RoomVolume')) {
      return cur.id;
    }
    cur = cur.parent === null ? null : graph.getNode(cur.parent);
  }
  return null;
}
