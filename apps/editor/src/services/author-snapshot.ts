/**
 * 作者状态快照 / 恢复 —— **纯函数**（复审 #3 的验收要求）。
 *
 * ## 为什么要抽出来
 *
 * 原来 `LabRenderer.snapshotAuthorState()` / `restoreAuthorState()` 各写了一份
 * 字段级拷贝逻辑，而恢复验收只测了"替身返回 mismatched=true 并检查告警" ——
 * 那测的是替身，不是恢复实现本身（评审原话：「验证应执行真实恢复实现」）。
 * 抽成纯函数后，**真实实现**可以直接在 node 环境里被测：
 * 不需要 GPU、不需要渲染器，给它一个对象数组就能验证恢复语义。
 *
 * ## 语义（与 Unity 一致）
 *
 * Play 期间对场景的改动在 Stop 后丢弃，Stop 恢复 Play 前的作者状态。
 * 只存**可序列化的编辑态**（变换 / 显隐 / 材质槽 / 名字），不存 GPU 资源。
 * 物体数与快照不一致时**保守处理**：能对上的逐个恢复，对不上的原样留着，
 * 宁可残留一个改动，也不要把索引搞错导致张冠李戴。
 */

import type { Quat } from '@aether/core';
import type { AuthorObjectState, AuthorSnapshot } from '../renderer';

/** 快照/恢复所需的最小对象形状（渲染器的 ObjectRecord 与替身都满足它） */
export interface SnapshotObjectLike {
  pos: [number, number, number];
  rot: [number, number, number];
  /** 与 `SceneObject.quat` 同型（readonly 元组）：属性可整体重赋，元素不可变 */
  quat: Quat;
  scale: number;
  bob: number;
  visible: boolean;
  removed: boolean;
  pickable: boolean;
  name: string;
  category: string;
  subMeshes: { visible: boolean }[];
}

export interface RestoreResult {
  restored: number;
  mismatched: boolean;
  /** 恢复出来的选中索引（渲染器据此回写 state.selectedIndex） */
  selectedIndex: number | null;
}

/** 打快照。数组内容全部拷贝（不持有活引用 —— 否则"快照"会被后续编辑污染） */
export function snapshotObjects(
  objects: readonly SnapshotObjectLike[],
  selectedIndex: number | null,
): AuthorSnapshot {
  return {
    count: objects.length,
    objects: objects.map((o) => ({
      pos: [o.pos[0], o.pos[1], o.pos[2]],
      rot: [o.rot[0], o.rot[1], o.rot[2]],
      quat: [o.quat[0], o.quat[1], o.quat[2], o.quat[3]],
      scale: o.scale,
      bob: o.bob,
      visible: o.visible,
      removed: o.removed,
      pickable: o.pickable,
      name: o.name,
      category: o.category,
      subVisible: o.subMeshes.map((sm) => sm.visible),
    })),
    selectedIndex,
  };
}

/** 按快照恢复。能对上的逐个恢复，对不上的原样留着；返回恢复的选中索引 */
export function restoreObjects(objects: SnapshotObjectLike[], snap: AuthorSnapshot): RestoreResult {
  const n = Math.min(objects.length, snap.objects.length);
  for (let i = 0; i < n; i++) {
    const o = objects[i]!;
    const s = snap.objects[i]!;
    o.pos = [s.pos[0], s.pos[1], s.pos[2]];
    o.rot = [s.rot[0], s.rot[1], s.rot[2]];
    o.quat = [s.quat[0], s.quat[1], s.quat[2], s.quat[3]] as Quat;
    o.scale = s.scale;
    o.bob = s.bob;
    o.visible = s.visible;
    o.removed = s.removed;
    o.pickable = s.pickable;
    o.name = s.name;
    o.category = s.category;
    for (let k = 0; k < o.subMeshes.length && k < s.subVisible.length; k++) {
      o.subMeshes[k]!.visible = s.subVisible[k]!;
    }
  }
  return {
    restored: n,
    mismatched: objects.length !== snap.count,
    selectedIndex: snap.selectedIndex !== null && snap.selectedIndex < objects.length ? snap.selectedIndex : null,
  };
}

// 类型上是重导出：调用方与测试都用这里的名字，renderer 不再私有一份定义
export type { AuthorObjectState, AuthorSnapshot };
