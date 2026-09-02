/**
 * 兼容桥：几何契约真源已上提进 @aether/scene（packages/scene/src/geometry.ts）。
 * 编辑器侧保留作桥，待 0b.8 收敛后删除。renderer/models/skin.test 等仍在 import './gpu/geometry'。
 * 新代码请直接 import { VERTEX_LAYOUT, createBox, weldMesh } from '@aether/scene'。
 */
export * from '@aether/scene';
