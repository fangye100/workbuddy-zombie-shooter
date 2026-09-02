/**
 * 兼容桥：math 真源已上提进 @aether/core（packages/core/src/math.ts）。
 * 本文件仅作 re-export 桥，待 0b.8 编辑器收敛后删除。
 *
 * 注意：main / renderer / skin / gltf 当前仍在 import './gpu/math'（并行 session 已
 * 暂存这些文件，本步不触碰），故不可直接删文件，只保留桥。
 * 新代码请直接 import { ... } from '@aether/core'。
 */
export * from '@aether/core';
