/**
 * 兼容桥：glTF 加载器真源已上提进 @aether/scene（packages/scene/src/gltf.ts）。
 * 编辑器侧保留作桥，待 0b.8 收敛后删除。main/renderer/skin/asset-inspector 仍在 import './gpu/gltf'。
 * 新代码请直接 import { parseGlb } from '@aether/scene'。
 */
export * from '@aether/scene';
