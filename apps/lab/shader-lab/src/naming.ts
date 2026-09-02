/**
 * 兼容桥：naming 真源已上提进 @aether/core（packages/core/src/naming.ts）。
 * 本文件仅作 re-export 桥，待 0b.8 编辑器收敛后删除。
 *
 * materials / gltf 仍在 import './naming' / '../naming'，保留作桥。
 * 新代码请直接 import { uniqueName, nameAllocator } from '@aether/core'。
 */
export * from '@aether/core';
