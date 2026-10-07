/**
 * Play 相机接线（ADR-018 P6）。
 *
 * ## 为什么必须自己保存/恢复相机
 *
 * `AuthorSnapshot`（renderer.ts:377）**只存 objects / selectedIndex，不含相机**。
 * 此前 Play 不动相机，所以"Stop 后相机不被污染"是自然成立的；一旦 P6 切到游戏相机，
 * 不自己恢复就会让 Stop 之后编辑视角停在游戏相机位置 —— 那是实打实的污染。
 *
 * 因此本模块负责：Play 前存下编辑相机，Stop 时还原。相机恢复也注册进
 * PlaySession 的资源账目（AGENTS.md §2.4：Stop 后 pending 必须为 0）。
 *
 * ## 回退链路（schema 契约：document.ts:508）
 *
 *   entryCamera → 场景里第一个启用的 Camera 组件 → null（保持编辑相机不动）
 *
 * ## 当前限制（诚实记录，不假装支持）
 *
 * 1. `orbit-follow` 的**运行时跟随**依赖外部传入玩家位置；没有玩家实体时退回
 *    followTarget 节点的静态位置。
 * 2. 视口的 `CameraState` 只有 yaw/distance/target，俯仰角走
 *    `panel.params.cameraElevation`（度）。本模块据此写入 `pitchDeg`。
 */

import type { CameraComponent, NodeId, SceneDocument } from '@aether/scene';

/** 主视图相机的可读写状态。宿主（main.ts）负责映射到真实 camera 对象 */
export interface ViewCameraState {
  target: [number, number, number];
  distance: number;
  /** 弧度 */
  yaw: number;
  /** 俯角（度，正值向下看） */
  elevationDeg: number;
}

export interface ViewCameraControl {
  get(): ViewCameraState;
  set(s: ViewCameraState): void;
}

/** 运行时玩家（相机跟随目标）的位置。null = 当前没有玩家实体 */
export interface PlayCameraTarget {
  x: number;
  z: number;
  /** Render Y rotation (+Z forward), converted from the runtime planar heading. */
  yaw: number;
}

export type WorldPosOf = (nodeId: NodeId) => [number, number, number] | null;

export interface EntryCamera {
  nodeId: NodeId;
  cam: CameraComponent;
}

/**
 * 解析本场 Play 用哪台相机。
 *
 * 回退链路见文件头。注意两点：
 * - 只看**启用**的 Camera 组件（enabled=false 视为不存在，否则 enabled 字段在说谎）
 * - entryCamera 指向的节点若没有 Camera 组件，**继续回退**，不要把它当错误——
 *   作者改了节点类型不该让 Play 起不来
 */
export function resolveEntryCamera(doc: SceneDocument): EntryCamera | null {
  const pick = (nodeId: NodeId | null | undefined): EntryCamera | null => {
    if (nodeId === null || nodeId === undefined) return null;
    const n = doc.nodes.find((x) => x.id === nodeId);
    if (n === undefined) return null;
    const c = n.components.find((x) => x.kind === 'Camera') as CameraComponent | undefined;
    if (c === undefined || !c.enabled) return null;
    return { nodeId: n.id, cam: c };
  };

  const byEntry = pick(doc.entryCamera);
  if (byEntry !== null) return byEntry;

  for (const n of doc.nodes) {
    const hit = pick(n.id);
    if (hit !== null) return hit;
  }
  return null;
}

/** 度 → 弧度 */
function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * 计算进入 Play 时的相机姿态（纯函数，便于单测）。
 *
 * @param entry  解析到的游戏相机
 * @param worldPosOf 取节点世界坐标
 * @param baseYaw 目标朝向（弧度）。fixed 模式用它 + yawOffsetDeg
 */
export function planPlayCamera(
  entry: EntryCamera,
  worldPosOf: WorldPosOf,
  baseYaw = 0,
): ViewCameraState | null {
  const { cam } = entry;
  // 🔴 数值守卫：场景里 Camera 组件可能缺字段（sandbox/default.scene.json 就缺
  // distance 与 yawOffsetDeg）。直接喂给相机会让 distance 变 NaN → 视口黑屏。
  // 宁可按"没有可用相机"处理（保持编辑机位），也不要把视口弄黑。
  for (const v of [cam.distance, cam.pitchDeg, cam.yawOffsetDeg]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  }
  if (cam.distance <= 0) return null;

  const anchorId = cam.followTarget ?? entry.nodeId;
  const p = worldPosOf(anchorId);
  if (p === null) return null;

  return {
    target: [p[0], p[1], p[2]],
    distance: cam.distance,
    yaw: baseYaw + rad(cam.yawOffsetDeg),
    // pitchDeg：正值向下看（schema 注释），与 panel 的 elevation 同向
    elevationDeg: cam.pitchDeg,
  };
}

/**
 * Play 相机控制器。
 *
 * 生命周期：attach（存编辑相机 + 切游戏相机）→ update（跟随）→ detach（还原）。
 * 没解析到游戏相机时 attach 返回 false，全程不碰相机（保持编辑相机自由移动）。
 */
export class PlayCameraController {
  private readonly view: ViewCameraControl;
  private saved: ViewCameraState | null = null;
  private plan: ViewCameraState | null = null;
  private mode: CameraComponent['mode'] | null = null;
  private anchorId: NodeId | null = null;
  /** 相对目标朝向的偏航偏移（度） */
  private yawOffsetDeg = 0;
  /**
   * 偏航跟随模式（v5）：'world' = 相机朝向锁世界方向（俯视上帝视角，缺省）；
   * 'target' = 相机朝向跟目标转身（肩后视角）。见 `CameraComponent.yawMode`。
   */
  private yawMode: NonNullable<CameraComponent['yawMode']> = 'world';

  constructor(view: ViewCameraControl) {
    this.view = view;
  }

  get active(): boolean {
    return this.saved !== null;
  }

  /**
   * 接管相机。返回 false = 场景没有可用游戏相机，保持编辑相机（不污染）。
   */
  attach(doc: SceneDocument, worldPosOf: WorldPosOf): boolean {
    const entry = resolveEntryCamera(doc);
    if (entry === null) return false;
    const plan = planPlayCamera(entry, worldPosOf);
    if (plan === null) return false;

    this.saved = this.view.get(); // 先存，再改 —— 顺序反了就还原不回去
    this.plan = plan;
    this.mode = entry.cam.mode;
    this.anchorId = entry.cam.followTarget ?? entry.nodeId;
    this.yawOffsetDeg = entry.cam.yawOffsetDeg;
    this.yawMode = entry.cam.yawMode ?? 'world';
    this.view.set(plan);
    return true;
  }

  /**
   * 每帧更新跟随目标。
   *
   * 🔴 只有 `orbit-follow` 才跟随；`fixed` 模式一旦定位就不再动，
   * 否则作者摆好的固定机位会被玩家拖着走，语义就反了。
   *
   * **偏航（yaw）是否跟随由 `yawMode` 决定**（v5，2026-10-02 修复）：
   * - `'world'`（缺省）：yaw 锁在 `plan` 定好的世界方向，**玩家转身不带相机**。
   *   俯视上帝视角必须是这个行为 —— 否则摇杆的"上"随角色朝向漂移，
   *   左右移动时整个画面在转，操作感直接崩坏（用户实测报的正是这个）。
   * - `'target'`：yaw = 目标朝向 + yawOffsetDeg（肩后跟随视角）。
   */
  update(target: PlayCameraTarget | null): void {
    if (this.saved === null || this.plan === null) return;
    if (this.mode !== 'orbit-follow') return;
    if (target === null) return;
    const cur = this.view.get();
    this.view.set({
      ...cur,
      target: [target.x, cur.target[1], target.z],
      yaw: this.yawMode === 'target' ? target.yaw + rad(this.yawOffsetDeg) : this.plan.yaw,
    });
  }

  /** 还原编辑相机。幂等：重复调用无副作用 */
  detach(): void {
    if (this.saved === null) return;
    this.view.set(this.saved);
    this.saved = null;
    this.plan = null;
    this.mode = null;
    this.anchorId = null;
  }

  /** 当前锚点节点（诊断/显示用） */
  get anchor(): NodeId | null {
    return this.anchorId;
  }
}
