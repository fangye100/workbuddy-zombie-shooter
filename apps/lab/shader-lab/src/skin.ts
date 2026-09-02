/**
 * 兼容桥：骨骼蒙皮/动画求值真源已上提进 @aether/render（packages/render/src/skin.ts）。
 * 编辑器侧保留作桥，待 0b.8 收敛后删除。renderer/skin.test 仍在 import './skin'。
 * 新代码请直接 import { evalJointMatrices, packSkin } from '@aether/render'。
 */
export * from '@aether/render';
