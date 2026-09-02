/**
 * 兼容桥：设备初始化真源已上提进 @aether/gfx（packages/gfx/src/context.ts）。
 * 编辑器侧保留作桥，待 0b.8 收敛后删除。main/renderer 仍在 import './gpu/device'。
 * 新代码请直接 import { initGpu, GpuUnavailableError, type GpuContext } from '@aether/gfx'。
 */
export * from '@aether/gfx';
