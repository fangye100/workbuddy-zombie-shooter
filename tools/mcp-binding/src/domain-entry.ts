/**
 * esbuild 打包入口：产出 `dist/domain.mjs` 供 server.mjs（纯 .mjs shell）import。
 *
 * 构建：pnpm run mcp-binding:build
 * 为什么需要打包：领域层是 TS（apps/editor/src/services/binding/* + @aether/scene），
 * Node 直跑 .mjs 无法 import；打包后 server.mjs 保持零依赖、零构建时。
 */
export { TOOLS_TABLE, BindingDomain, ToolError, dispatchTool } from './tools';
export type { FsPort, ToolResult } from './tools';
export type { RgbaImage } from './render';
