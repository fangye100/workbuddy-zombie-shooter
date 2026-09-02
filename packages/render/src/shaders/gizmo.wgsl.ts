/**
 * Gizmo 着色：position-only 顶点，unlit 纯色输出，绘于后处理之后的 swapchain 之上。
 *
 * 复用场景的 Frame buffer（binding 0，含 viewProj）做 MVP；
 * 每个 handle 自带 model（binding 1，T·R·S，S 由距离算出 → 屏幕恒定大小）与 color（binding 2）。
 * 不接光照、不吃雾，保证 gizmo 颜色就是编辑器 token 色，不被 tonemap 冲淡。
 */
export const GIZMO_WGSL = /* wgsl */ `
struct Frame {
  viewProj : mat4x4f,
  cameraPos : vec4f,
  screen : vec4f,
};
@group(0) @binding(0) var<uniform> frame : Frame;

struct Gizmo {
  model : mat4x4f,
};
@group(0) @binding(1) var<uniform> giz : Gizmo;

struct Col {
  color : vec4f,
};
@group(0) @binding(2) var<uniform> col : Col;

@vertex
fn vs_main(@location(0) position : vec3f) -> @builtin(position) vec4f {
  let world = giz.model * vec4f(position, 1.0);
  return frame.viewProj * world;
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(col.color.rgb, 1.0);
}
`;
