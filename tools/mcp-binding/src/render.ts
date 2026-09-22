/**
 * 绑定 MCP 的正交投影光栅器 —— 视觉反馈闭环的「渲染端」（WU-2）。
 *
 * 输入是**视图无关的几何图元**（点云 / 线段 / 胶囊 / 圆标记），输出 RGBA 位图。
 * 本文件零 node 依赖：PNG 编码（zlib）在 server.mjs 里做。这样分层是因为
 * 本仓库未装 @types/node、tsconfig 的 types 是白名单 —— 纯 TS 核心才能被
 * `tsconfig.check.json` 覆盖（见 tools/mcp-binding/README.md 的分层说明）。
 *
 * 与编辑器绑定面板同一套投影约定（binding-panel.ts `project()`）：
 *   - front：水平取 X，垂直取 Y（Y 向上）
 *   - side ：水平取 Z，垂直取 Y
 *   - 自动取景：所有图元的联合包围盒 + 边距，等比缩放居中
 */

export type Rgb = readonly [number, number, number];
export type Vec3 = readonly [number, number, number];
export type ViewAxis = 'front' | 'side';

export interface PointCloud {
  /**
   * 世界坐标，长度 = count × stride（floats）。
   * 交织顶点缓冲直接传 stride=vertexFloats 即可，零拷贝。
   */
  readonly xyz: Float32Array;
  /** 每个点的步长（floats），默认 3（紧凑 xyz） */
  readonly stride?: number | undefined;
  /** 顶点数 */
  readonly count: number;
  /**
   * 三角形索引（长度 3M）：给了就画**网格线框**而不是点云 ——
   * 减面模型（1600 面级）顶点太稀，点云读不出体型轮廓，线框才行。
   * 边色 = 两端点热力均值的色带色（无热力时用 wireColor）。
   */
  readonly indices?: Uint32Array | undefined;
  /** 线框颜色（无热力时），默认深灰 */
  readonly wireColor?: Rgb | undefined;
  /** 逐点热力值 0..1（长度 = count）；给了按色带上色，没给画统一灰色 */
  readonly heat?: Float32Array | undefined;
  /** 点尺寸 px（默认 2，画 2×2 方块；有线框时建议 0 = 不画点） */
  readonly size?: number | undefined;
}

export interface Segment {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly color: Rgb;
}

/** 圆柱（胶囊）轮廓：正交投影 = 两条侧边线 + 两端圆帽。rA 近 a 端，rB 近 b 端 */
export interface Capsule {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly rA: number;
  readonly rB: number;
  readonly color: Rgb;
}

export interface Marker {
  readonly p: Vec3;
  /** 屏幕半径 px（不随场景缩放） */
  readonly r: number;
  readonly color: Rgb;
  /** 默认填实；false = 只画圈（tip 骨用） */
  readonly filled?: boolean | undefined;
}

export interface OrthoScene {
  readonly view: ViewAxis;
  readonly width: number;
  readonly height: number;
  readonly points?: PointCloud | undefined;
  readonly segments?: readonly Segment[] | undefined;
  readonly capsules?: readonly Capsule[] | undefined;
  readonly markers?: readonly Marker[] | undefined;
  /** 背景色，默认白（与面板画布一致，热力图在白底上对比最好） */
  readonly background?: Rgb | undefined;
}

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

/** 热力色带：0 → 蓝，0.5 → 绿，1 → 红（两段线性插值） */
export function heatRamp(t: number): Rgb {
  const c = Math.min(1, Math.max(0, t));
  if (c < 0.5) {
    const k = c * 2;
    return [0, Math.round(255 * k), Math.round(255 * (1 - k))];
  }
  const k = (c - 0.5) * 2;
  return [Math.round(255 * k), Math.round(255 * (1 - k)), 0];
}

/** 取图元在视图平面上的 (u, v)：front = (x, y)，side = (z, y) */
function plane(p: Vec3, view: ViewAxis): readonly [number, number] {
  return view === 'front' ? [p[0], p[1]] : [p[2], p[1]];
}

export function renderOrthographic(scene: OrthoScene): RgbaImage {
  const { view, width, height } = scene;
  const bg: Rgb = scene.background ?? [255, 255, 255];
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = bg[0];
    rgba[i * 4 + 1] = bg[1];
    rgba[i * 4 + 2] = bg[2];
    rgba[i * 4 + 3] = 255;
  }

  // ── 自动取景：全部图元的联合包围盒（胶囊/标记带半径），等比缩放居中 ──
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  const extend = (u: number, v: number, pad: number): void => {
    if (u - pad < minU) minU = u - pad;
    if (u + pad > maxU) maxU = u + pad;
    if (v - pad < minV) minV = v - pad;
    if (v + pad > maxV) maxV = v + pad;
  };
  const pts = scene.points;
  if (pts !== undefined && pts.count > 0) {
    const stride = pts.stride ?? 3;
    for (let i = 0; i < pts.count; i++) {
      const x = pts.xyz[i * stride] ?? 0;
      const y = pts.xyz[i * stride + 1] ?? 0;
      const z = pts.xyz[i * stride + 2] ?? 0;
      const [u, v] = plane([x, y, z], view);
      extend(u, v, 0);
    }
  }
  for (const s of scene.segments ?? []) {
    const [au, av] = plane(s.a, view);
    const [bu, bv] = plane(s.b, view);
    extend(au, av, 0);
    extend(bu, bv, 0);
  }
  for (const c of scene.capsules ?? []) {
    const [au, av] = plane(c.a, view);
    const [bu, bv] = plane(c.b, view);
    const r = Math.max(c.rA, c.rB);
    extend(au, av, r);
    extend(bu, bv, r);
  }
  // 标记的 r 是屏幕 px，不参与世界包围盒（只按圆心扩一点世界余量）
  for (const m of scene.markers ?? []) {
    const [u, v] = plane(m.p, view);
    extend(u, v, 0.02);
  }
  if (!Number.isFinite(minU) || maxU - minU < 1e-6 || maxV - minV < 1e-6) {
    // 空场景 / 退化：画背景即返回（调用方据此知道没东西可看）
    return { width, height, rgba };
  }
  const margin = 14;
  const scale = Math.min(
    (width - margin * 2) / (maxU - minU),
    (height - margin * 2) / (maxV - minV),
  );
  const cu = (minU + maxU) / 2;
  const cv = (minV + maxV) / 2;
  const sx = (u: number): number => width / 2 + (u - cu) * scale;
  const sy = (v: number): number => height / 2 - (v - cv) * scale; // Y 向上

  const putPx = (x: number, y: number, c: Rgb): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const o = (y * width + x) * 4;
    rgba[o] = c[0];
    rgba[o + 1] = c[1];
    rgba[o + 2] = c[2];
  };

  const drawPoint = (x: number, y: number, size: number, c: Rgb): void => {
    const half = Math.max(1, Math.round(size)) - 1;
    for (let dy = 0; dy <= half; dy++) {
      for (let dx = 0; dx <= half; dx++) putPx(x + dx, y + dy, c);
    }
  };

  const drawLine = (x0: number, y0: number, x1: number, y1: number, c: Rgb): void => {
    let ax = Math.round(x0);
    let ay = Math.round(y0);
    const bx = Math.round(x1);
    const by = Math.round(y1);
    const dx = Math.abs(bx - ax);
    const dy = Math.abs(by - ay);
    const stepX = ax < bx ? 1 : -1;
    const stepY = ay < by ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      putPx(ax, ay, c);
      if (ax === bx && ay === by) break;
      const e2 = err * 2;
      if (e2 > -dy) {
        err -= dy;
        ax += stepX;
      }
      if (e2 < dx) {
        err += dx;
        ay += stepY;
      }
    }
  };

  const drawCircle = (cx: number, cy: number, r: number, c: Rgb, filled: boolean): void => {
    const ri = Math.max(1, Math.round(r));
    const r2 = ri * ri;
    const inner = (ri - 1) * (ri - 1);
    for (let dy = -ri; dy <= ri; dy++) {
      for (let dx = -ri; dx <= ri; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        if (filled || d2 >= inner) putPx(Math.round(cx) + dx, Math.round(cy) + dy, c);
      }
    }
  };

  // ── 绘制顺序：网格（底）→ 胶囊 → 骨线 → 关节标记（顶） ──
  if (pts !== undefined) {
    const stride = pts.stride ?? 3;
    const gray: Rgb = [70, 70, 70];
    const uvOf = (i: number): readonly [number, number] => {
      const x = pts.xyz[i * stride] ?? 0;
      const y = pts.xyz[i * stride + 1] ?? 0;
      const z = pts.xyz[i * stride + 2] ?? 0;
      return plane([x, y, z], view);
    };
    if (pts.indices !== undefined) {
      // 线框模式：边色 = 两端点热力均值（无热力 = wireColor）
      const wire = pts.wireColor ?? gray;
      const idx = pts.indices;
      for (let t = 0; t + 2 < idx.length; t += 3) {
        for (let e = 0; e < 3; e++) {
          const ia = idx[t + e] ?? 0;
          const ib = idx[t + ((e + 1) % 3)] ?? 0;
          const [au, av] = uvOf(ia);
          const [bu, bv] = uvOf(ib);
          let c = wire;
          if (pts.heat !== undefined) {
            c = heatRamp(((pts.heat[ia] ?? 0) + (pts.heat[ib] ?? 0)) / 2);
          }
          drawLine(sx(au), sy(av), sx(bu), sy(bv), c);
        }
      }
    }
    const size = pts.indices !== undefined ? (pts.size ?? 0) : (pts.size ?? 2);
    if (size > 0) {
      for (let i = 0; i < pts.count; i++) {
        const [u, v] = uvOf(i);
        const c = pts.heat !== undefined ? heatRamp(pts.heat[i] ?? 0) : gray;
        drawPoint(Math.round(sx(u)), Math.round(sy(v)), size, c);
      }
    }
  }

  for (const c of scene.capsules ?? []) {
    const [au, av] = plane(c.a, view);
    const [bu, bv] = plane(c.b, view);
    const ax = sx(au);
    const ay = sy(av);
    const bx = sx(bu);
    const by = sy(bv);
    const rA = c.rA * scale;
    const rB = c.rB * scale;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) {
      // 骨轴几乎垂直于视平面 → 投影就是一个圆
      drawCircle(ax, ay, Math.max(rA, rB), c.color, false);
      continue;
    }
    const px = (-dy / len) * 1;
    const py = (dx / len) * 1;
    drawLine(ax + px * rA, ay + py * rA, bx + px * rB, by + py * rB, c.color);
    drawLine(ax - px * rA, ay - py * rA, bx - px * rB, by - py * rB, c.color);
    drawCircle(ax, ay, rA, c.color, false);
    drawCircle(bx, by, rB, c.color, false);
  }

  for (const s of scene.segments ?? []) {
    const [au, av] = plane(s.a, view);
    const [bu, bv] = plane(s.b, view);
    drawLine(sx(au), sy(av), sx(bu), sy(bv), s.color);
  }

  for (const m of scene.markers ?? []) {
    const [u, v] = plane(m.p, view);
    drawCircle(sx(u), sy(v), m.r, m.color, m.filled !== false);
  }

  return { width, height, rgba };
}
