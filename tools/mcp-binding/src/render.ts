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
export type ViewAxis = 'front' | 'side' | 'top';

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
  /** 中段半径（三段 wrapper 的 medium）：给了在中点加画一道环，否则中段形状不可见 */
  readonly rM?: number | undefined;
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
  /**
   * 视差观察角（度）：投影前全体图元绕 Y 轴旋转 azimuthDeg ——
   * 侧视 + 30° 时前后重叠的手臂/躯干在 z 向错开 ±x·sinθ，轮廓可分离判读；
   * 0（默认）= 正交正/侧视，无旋转。
   */
  readonly azimuthDeg?: number | undefined;
  /**
   * 网格绘制风格：'wire' = 三角形线框（默认）；'toon' = 2D 卡通轮廓 ——
   * 实心填充 + 视向法线翻转边用实体线勾边（对「视差求导」的轮廓：
   * 面片朝向相对视线翻转处即深度不连续边界），重叠肢体以填充前后
   * 关系（画家算法）呈现，无线框噪音。toon 忽略 heat（热力走 wire）。
   */
  readonly meshStyle?: 'wire' | 'toon' | undefined;
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

/** 取图元在视图平面上的 (u, v)：front = (x, y)，side = (z, y)；rot 给定时先绕 Y 旋转（视差角） */
function plane(p: Vec3, view: ViewAxis, rot?: { c: number; s: number }): readonly [number, number] {
  let x = p[0];
  let z = p[2];
  if (rot !== undefined) {
    x = p[0] * rot.c + p[2] * rot.s;
    z = -p[0] * rot.s + p[2] * rot.c;
  }
  // top（俯视，从 +Y 往下看）：右 = +X（角色左侧），上 = +Z（前方）
  if (view === 'top') return [x, z];
  return view === 'front' ? [x, p[1]] : [z, p[1]];
}

export function renderOrthographic(scene: OrthoScene): RgbaImage {
  const { view, width, height } = scene;
  const az = scene.azimuthDeg ?? 0;
  const rot =
    az !== 0
      ? { c: Math.cos((az * Math.PI) / 180), s: Math.sin((az * Math.PI) / 180) }
      : undefined;
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
      const [u, v] = plane([x, y, z], view, rot);
      extend(u, v, 0);
    }
  }
  for (const s of scene.segments ?? []) {
    const [au, av] = plane(s.a, view, rot);
    const [bu, bv] = plane(s.b, view, rot);
    extend(au, av, 0);
    extend(bu, bv, 0);
  }
  for (const c of scene.capsules ?? []) {
    const [au, av] = plane(c.a, view, rot);
    const [bu, bv] = plane(c.b, view, rot);
    const r = Math.max(c.rA, c.rB, c.rM ?? 0);
    extend(au, av, r);
    extend(bu, bv, r);
  }
  // 标记的 r 是屏幕 px，不参与世界包围盒（只按圆心扩一点世界余量）
  for (const m of scene.markers ?? []) {
    const [u, v] = plane(m.p, view, rot);
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
      return plane([x, y, z], view, rot);
    };
    if (pts.indices !== undefined && scene.meshStyle === 'toon') {
      // ── toon 模式：z-buffer 实心填充 + 三类轮廓线实体勾边 ──
      // 轮廓判据（并集）：
      //  ① 蒙版边界（外轮廓 + 破洞沿）—— 对渲染结果求导；
      //  ② 深度梯度边 —— z-buffer 深度不连续处（重叠在躯干上的四肢与躯干的
      //     深度台阶，无论是否露出背景）；
      //  ③ 掠射法线翻转边 —— 面片朝向相对视线翻转且两侧都接近切向
      //     （内部褶皱的类轮廓效果；只认二连边，破 cloth 洞沿不参与）。
      // ②③ 让用户在纯侧视重叠剪影里也能看到身体结构，而不只是外轮廓。
      const idx = pts.indices;
      const n = pts.count;
      const d: Vec3 = view === 'front' ? [0, 0, 1] : view === 'side' ? [-1, 0, 0] : [0, 1, 0];
      const px = new Float64Array(n);
      const py = new Float64Array(n);
      const pdep = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const x = pts.xyz[i * stride] ?? 0;
        const y = pts.xyz[i * stride + 1] ?? 0;
        const z = pts.xyz[i * stride + 2] ?? 0;
        const [u, v] = plane([x, y, z], view, rot);
        px[i] = sx(u);
        py[i] = sy(v);
        // 深度取旋转后坐标在视向上的投影（plane 内部已旋转，这里重算一次保持一致）
        const rx = rot !== undefined ? x * rot.c + z * rot.s : x;
        const rz = rot !== undefined ? -x * rot.s + z * rot.c : z;
        pdep[i] = view === 'front' ? rz : view === 'side' ? -rx : y; // 越大越近（front:+z；side:−x；top:+y；绕Y旋转 y 不变）
      }
      const T = idx.length / 3;
      const order = new Int32Array(T);
      const tdep = new Float64Array(T);
      // 视向法线归一化点积（掠射判据用），按三角形存
      const tface = new Float64Array(T);
      for (let t = 0; t < T; t++) {
        order[t] = t;
        const ia = idx[t * 3] ?? 0;
        const ib = idx[t * 3 + 1] ?? 0;
        const ic = idx[t * 3 + 2] ?? 0;
        tdep[t] = (pdep[ia]! + pdep[ib]! + pdep[ic]!) / 3;
        const A = rot3r(ia);
        const B = rot3r(ib);
        const C = rot3r(ic);
        const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
        const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        tface[t] = len < 1e-12 ? 1 : (nx * d[0] + ny * d[1] + nz * d[2]) / len;
      }
      function rot3r(i: number): [number, number, number] {
        const x = pts.xyz[i * stride] ?? 0;
        const y = pts.xyz[i * stride + 1] ?? 0;
        const z = pts.xyz[i * stride + 2] ?? 0;
        return rot !== undefined
          ? [x * rot.c + z * rot.s, y, -x * rot.s + z * rot.c]
          : [x, y, z];
      }
      // 画家算法（远→近）打底，z-buffer 兜底保证重叠处近表面覆盖
      Array.prototype.sort.call(order, (a: number, b: number) => tdep[a]! - tdep[b]!);
      const body: Rgb = [226, 214, 194]; // 卡通填充色（肤色），与面板网格观感一致
      const mask = new Uint8Array(width * height);
      const zbuf = new Float64Array(width * height).fill(-Infinity);
      const fillTri = (
        x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
        c: Rgb, da: number, db: number, dc: number,
      ): void => {
        const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
        const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)));
        const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
        const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)));
        const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
        if (Math.abs(den) < 1e-9) return;
        for (let yy = minY; yy <= maxY; yy++) {
          for (let xx = minX; xx <= maxX; xx++) {
            const w0 = ((y1 - y2) * (xx - x2) + (x2 - x1) * (yy - y2)) / den;
            const w1 = ((y2 - y0) * (xx - x2) + (x0 - x2) * (yy - y2)) / den;
            const w2 = 1 - w0 - w1;
            if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
            const o = yy * width + xx;
            const dep = w0 * da + w1 * db + w2 * dc;
            if (dep <= zbuf[o]!) continue; // 远表面不覆盖近表面
            putPx(xx, yy, c);
            mask[o] = 1;
            zbuf[o] = dep;
          }
        }
      };
      for (let k = 0; k < T; k++) {
        const t = order[k]!;
        const ia = idx[t * 3] ?? 0;
        const ib = idx[t * 3 + 1] ?? 0;
        const ic = idx[t * 3 + 2] ?? 0;
        fillTri(px[ia]!, py[ia]!, px[ib]!, py[ib]!, px[ic]!, py[ic]!, body, pdep[ia]!, pdep[ib]!, pdep[ic]!);
      }
      const contour: Rgb = [40, 40, 40];
      const isEdge = new Uint8Array(width * height);
      // ① 蒙版边界（8 邻域内有背景即轮廓）
      for (let yy = 1; yy < height - 1; yy++) {
        for (let xx = 1; xx < width - 1; xx++) {
          const o = yy * width + xx;
          if (mask[o] === 0) continue;
          if (
            mask[o - 1] === 0 || mask[o + 1] === 0 ||
            mask[o - width] === 0 || mask[o + width] === 0 ||
            mask[o - width - 1] === 0 || mask[o - width + 1] === 0 ||
            mask[o + width - 1] === 0 || mask[o + width + 1] === 0
          ) {
            isEdge[o] = 1;
          }
        }
      }
      // ② 深度台阶边：相邻像素深度差超过绝对阈值（约 1px 内跳 ≥8mm ——
      //    四肢/躯干重叠处的深度台阶是 5–10cm 级；连续曲面坡度 ~2–4mm/px 不触发）
      const DEPTH_STEP = 0.008;
      for (let yy = 1; yy < height - 1; yy++) {
        for (let xx = 1; xx < width - 1; xx++) {
          const o = yy * width + xx;
          if (zbuf[o]! === -Infinity) continue;
          const gx = Math.abs(zbuf[o + 1]! - zbuf[o]!);
          const gy = Math.abs(zbuf[o + width]! - zbuf[o]!);
          if (gx > DEPTH_STEP || gy > DEPTH_STEP) isEdge[o] = 1;
        }
      }
      // ③ 掠射法线翻转边（内部褶皱类轮廓；只认二连边，破洞沿不勾）
      const edgeMap = new Map<number, { e1: number; a: number; b: number }>();
      for (let t = 0; t < T; t++) {
        for (let e = 0; e < 3; e++) {
          const ia = idx[t * 3 + e] ?? 0;
          const ib = idx[t * 3 + ((e + 1) % 3)] ?? 0;
          const a = Math.min(ia, ib);
          const b = Math.max(ia, ib);
          const key = a * n + b;
          const cur = edgeMap.get(key);
          if (cur === undefined) {
            edgeMap.set(key, { e1: tface[t]!, a, b });
          } else if (Math.sign(cur.e1) !== Math.sign(tface[t]!) && Math.abs(cur.e1) < 0.5 && Math.abs(tface[t]!) < 0.5) {
            drawLine(Math.round(px[a]!), Math.round(py[a]!), Math.round(px[b]!), Math.round(py[b]!), contour);
          }
        }
      }
      // 实体化：轮廓像素外扩 1px
      for (let yy = 0; yy < height; yy++) {
        for (let xx = 0; xx < width; xx++) {
          const o = yy * width + xx;
          if (isEdge[o] === 0) continue;
          putPx(xx, yy, contour);
          if (xx + 1 < width && mask[o + 1] === 0) putPx(xx + 1, yy, contour);
          if (yy + 1 < height && mask[o + width] === 0) putPx(xx, yy + 1, contour);
        }
      }
    } else if (pts.indices !== undefined) {
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
    const [au, av] = plane(c.a, view, rot);
    const [bu, bv] = plane(c.b, view, rot);
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
      drawCircle(ax, ay, Math.max(rA, rB, (c.rM ?? 0) * scale), c.color, false);
      continue;
    }
    const px = (-dy / len) * 1;
    const py = (dx / len) * 1;
    drawLine(ax + px * rA, ay + py * rA, bx + px * rB, by + py * rB, c.color);
    drawLine(ax - px * rA, ay - py * rA, bx - px * rB, by - py * rB, c.color);
    drawCircle(ax, ay, rA, c.color, false);
    drawCircle(bx, by, rB, c.color, false);
    if (c.rM !== undefined) {
      drawCircle((ax + bx) / 2, (ay + by) / 2, c.rM * scale, c.color, false);
    }
  }

  for (const s of scene.segments ?? []) {
    const [au, av] = plane(s.a, view, rot);
    const [bu, bv] = plane(s.b, view, rot);
    drawLine(sx(au), sy(av), sx(bu), sy(bv), s.color);
  }

  for (const m of scene.markers ?? []) {
    const [u, v] = plane(m.p, view, rot);
    drawCircle(sx(u), sy(v), m.r, m.color, m.filled !== false);
  }

  return { width, height, rgba };
}
