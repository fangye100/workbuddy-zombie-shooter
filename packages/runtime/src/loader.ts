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

import { SceneGraph } from '@aether/scene';
import { lookupCharacterStats } from '@aether/content';
import type {
  AabbData,
  ColliderComponent,
  NodeId,
  RoomVolumeComponent,
  SceneDocument,
  SpawnPointComponent,
} from '@aether/scene';

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
  depth: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  enabled: boolean;
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
}

/** 导航作用域。null = 场景没声明 NavZone，装载会报 error */
export interface NavDesc {
  nodeId: NodeId;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  cellSize: number;
}

/** 运行描述：装载产物，RuntimeSession 的唯一输入（除种子与固定步长外） */
export interface LevelRuntimeDesc {
  sceneId: string;
  sceneName: string;
  /** 场景 schemaVersion + 本装载器的契约版本，用于复现比对 */
  schemaVersion: number;
  playerStart: { nodeId: NodeId; x: number; z: number };
  rooms: RoomDesc[];
  spawns: SpawnDesc[];
  obstacles: ObstacleDesc[];
  nav: NavDesc | null;
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
): { x: number; z: number; halfX: number; halfZ: number; radius: number } {
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
  return { x: tx, z: tz, halfX, halfZ, radius: Math.max(halfX, halfZ) };
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
        z: n.world.position[2],
      };
    }
  }

  // ---------------------------------------------------------- 房间 / 刷怪点 / 障碍 / 导航
  const rooms: RoomDesc[] = [];
  const spawns: SpawnDesc[] = [];
  const obstacles: ObstacleDesc[] = [];
  let nav: NavDesc | null = null;

  graph.traverse((n) => {
    for (const c of n.components) {
      if (c.kind === 'RoomVolume') {
        const r = c as RoomVolumeComponent;
        const b = aabbToXZ(r.bounds);
        rooms.push({
          nodeId: n.id,
          name: n.name,
          roomType: r.roomType,
          theme: r.theme,
          clearRule: r.clearRule,
          depth: r.depth,
          minX: b.minX,
          maxX: b.maxX,
          minZ: b.minZ,
          maxZ: b.maxZ,
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
          z: n.world.position[2],
          enabled: s.enabled,
          roomNodeId: findOwningRoom(graph, n.id),
        });
      } else if (c.kind === 'Collider') {
        const col = c as ColliderComponent;
        if (col.isTrigger) continue; // 触发器不挡路
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
        const b = aabbToXZ(c.bounds);
        nav = {
          nodeId: n.id,
          minX: b.minX,
          minZ: b.minZ,
          maxX: b.maxX,
          maxZ: b.maxZ,
          cellSize: c.cellSize,
        };
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
  if (rooms.length === 0) {
    warn('W_NO_ROOM', '场景没有 RoomVolume，room-enter 触发的刷怪点永远不会投放');
  }

  const hasError = diags.some((d) => d.severity === 'error');
  if (hasError || playerStart === null) {
    return { desc: null, diagnostics: diags };
  }

  return {
    desc: {
      sceneId: doc.id,
      sceneName: doc.name,
      schemaVersion: doc.schemaVersion,
      playerStart,
      rooms,
      spawns,
      obstacles,
      nav,
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
