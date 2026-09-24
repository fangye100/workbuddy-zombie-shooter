/**
 * 绑定 MCP 的领域调度层 —— 把 MCP 工具薄壳映射到 `BindingSession`（WU-2）。
 *
 * 分层（docs/17 §3.5 依赖纪律）：
 *   - 本文件与 `./render.ts` 是**纯 TS**：不 import 任何 node:* 模块，
 *     由 `tsconfig.check.json` 全量类型检查；
 *   - 文件读写经 `FsPort` 注入（server.mjs 用 node:fs 实现），领域逻辑不碰 fs；
 *   - GLB 解析直接复用 `@aether/scene` 的 `parseGlb` —— **与编辑器同一把身高尺**
 *    （targetHeight 默认 2.05 = models.ts 的 MODEL_RULER_HEIGHT_M，真源
 *     roster.json E-04 height），保证 MCP 里看到的体型与编辑器一致。
 *
 * 导出（WU-3 收口）：`export_glb` 直接复用编辑器 `exportBound` 同一条管线
 * （binding-export `rigToTPoseWithImage`：当前姿态算权重 → 反解 T-pose → 写干净骨架），
 * 产物经 FsPort 落盘仓内；动画烘焙（BVH 重定向）仍不走 MCP —— 那是 retarget 的领域。
 */

import {
  BindingSession,
  type BindingMesh,
  type WeightMode,
} from '../../../apps/editor/src/services/binding/binding-session';
import {
  HUMANIK_ORDER,
  isTipBone,
} from '../../../apps/editor/src/services/binding/humanik-template';
import { boneSegments, type JointPositions } from '../../../apps/editor/src/services/binding/binding-math';
import {
  offsetSegmentEndpoints,
  type SkinCylinderMap,
} from '../../../apps/editor/src/services/binding/skin-proxy';
import { rigToTPoseWithImage } from '../../../apps/editor/src/services/binding/binding-export';
import { parseGlb, validateAssetMeta } from '@aether/scene';
import {
  renderOrthographic,
  type Capsule,
  type GridSpec,
  type Marker,
  type OrthoScene,
  type PointCloud,
  type Rgb,
  type RgbaImage,
  type Segment,
  type ViewAxis,
} from './render';

/** 引擎顶点布局 stride（packages/scene/src/gltf.ts 的 VF：pos3+normal3+smoothNormal3+uv2+color4） */
const VERTEX_FLOATS = 15;

/** 工具参数 / 前置条件错误（→ JSON-RPC -32602）；实现 bug 走未知错误（→ -32603） */
export class ToolError extends Error {}

/** 文件系统端口：server.mjs 用 node:fs 实现后注入，领域层因此保持纯 TS */
export interface FsPort {
  /** 仓内相对路径 → 绝对路径。实现方必须拒绝目录穿越（解析结果必须在仓库内） */
  resolve(rel: string): string;
  readBinary(abs: string): ArrayBuffer;
  /** 文件不存在返回 null（区别于读失败抛错） */
  readText(abs: string): string | null;
  writeText(abs: string, text: string): void;
  /**
   * 写二进制。exclusive=true 时目标已存在必须抛 message 含 "EEXIST" 的错
   * （底层用独占创建 —— 覆盖检查与写入必须原子，否则并发双导出同路径会双双通过
   * 检查再互相覆盖，Copilot PR #11 评审）
   */
  writeBinary(abs: string, data: ArrayBuffer, exclusive: boolean): void;
  /** 文件是否存在（export_glb 的覆盖守卫，提前报错省一次导出计算） */
  exists(abs: string): boolean;
  /** 两路径是否指向同一文件（dev+ino；任一不存在返回 false）。防硬链/软链别名绕过自覆盖守卫 */
  sameFile(a: string, b: string): boolean;
  /** 小写 hex sha256（export 后刷新 sidecar 的 sourceHash，与 scene:gen 同算法） */
  sha256(abs: string): string;
}

export interface ToolResult {
  /** 文本块（JSON 会被 shell 序列化进 content[text]） */
  json: unknown;
  /** render 工具附带的图像块（shell 负责 PNG 编码 + base64） */
  image?: RgbaImage | undefined;
}

// ─────────────────────────── 参数小校验器 ───────────────────────────

function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
function reqStr(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string' || v === '') throw new ToolError(`缺少必填字符串参数：${k}`);
  return v;
}
/**
 * 骨名白名单校验。**不能用 `positions[name] === undefined` 查**：那会走原型链
 * （`positions['constructor']` 命中 Object.prototype.constructor ≠ undefined），
 * 非法骨名会被接受并以 own 属性写进 positions → 污染 save 产物（独立审核 P1-1，
 * 实测复现）。合法骨名 = HUMANIK_ORDER 全集（含 tip）。
 */
function requireBone(o: Record<string, unknown>, k: string): string {
  const b = reqStr(o, k);
  if (!HUMANIK_ORDER.includes(b)) {
    throw new ToolError(`未知骨名：${b}（合法值见 get_joints 的 order）`);
  }
  return b;
}
function optStr(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === 'string' ? v : undefined;
}
function optBool(o: Record<string, unknown>, k: string): boolean | undefined {
  const v = o[k];
  return typeof v === 'boolean' ? v : undefined;
}
function optNum(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function reqVec3(o: Record<string, unknown>, k: string): [number, number, number] {
  const v = o[k];
  if (
    !Array.isArray(v) || v.length !== 3 ||
    !(v as unknown[]).every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    throw new ToolError(`参数 ${k} 必须是 3 个有限数的数组 [x, y, z]`);
  }
  return [v[0] as number, v[1] as number, v[2] as number];
}
function clampInt(v: number | undefined, lo: number, hi: number, dflt: number): number {
  if (v === undefined) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

// ─────────────────────────── 渲染配色（与面板语义对齐） ───────────────────────────

const COLOR_BONE: Rgb = [84, 110, 122]; // 骨线：蓝灰
const COLOR_JOINT: Rgb = [46, 125, 50]; // 骨干关节：绿
const COLOR_JOINT_TIP: Rgb = [158, 158, 158]; // tip 骨：灰圈（不参与蒙皮）
const COLOR_SELECTED: Rgb = [211, 47, 47]; // 选中关节：红
const COLOR_CYL_AUTO: Rgb = [0, 131, 143]; // 自动半径 wrapper：青
const COLOR_CYL_MANUAL: Rgb = [239, 108, 0]; // 手动调过的 wrapper：橙

// ─────────────────────────── 领域持有器 ───────────────────────────

export class BindingDomain {
  /** 领域状态唯一 owner（面板瘦身后同一个类，Agent 与 GUI 调同一套操作） */
  readonly session = new BindingSession();
  /** 当前载入模型的仓内相对路径（save / hydrate 的落盘锚点） */
  private glbPath: string | null = null;
  /** parseGlb 抽出的 baseColor 贴图（export 时嵌回产物，与编辑器 s.image 同源） */
  private image: Blob | null = null;

  constructor(private readonly fs: FsPort) {}

  private requireMesh(): BindingMesh {
    const m = this.session.getMesh();
    if (m === null) throw new ToolError('未载入模型：先调 load_model');
    return m;
  }

  /** 已载入模型的仓内相对路径（loadModel 成功路径上与网格同时就位） */
  private requireGlbPath(): string {
    this.requireMesh();
    // glbPath 与网格在 loadModel 里同一段成功路径赋值，mesh 在则 path 在
    return this.glbPath!;
  }

  private metaPath(): string {
    if (this.glbPath === null) throw new ToolError('未载入模型：先调 load_model');
    return `${this.glbPath}.meta.json`;
  }

  /** load_model：读 GLB → parseGlb（编辑器同尺）→ setModel → 尝试回填 sidecar */
  loadModel(relPath: string): Record<string, unknown> {
    if (!relPath.toLowerCase().endsWith('.glb')) {
      throw new ToolError(`只支持 .glb：${relPath}`);
    }
    const abs = this.fs.resolve(relPath);
    let buf: ArrayBuffer;
    try {
      buf = this.fs.readBinary(abs);
    } catch (err) {
      throw new ToolError(`读取失败：${relPath}（${String(err)}）`);
    }
    let model;
    try {
      // targetHeight 用默认值 2.05 —— 即 MODEL_RULER_HEIGHT_M（roster E-04），
      // 与编辑器 bindAssetAt 的 parseGlb(buffer, MODEL_RULER_HEIGHT_M) 同尺
      model = parseGlb(buf);
    } catch (err) {
      throw new ToolError(`GLB 解析失败：${relPath}（${String(err)}）`);
    }
    const name = relPath.split(/[\\/]/).pop()!.replace(/\.glb$/i, '');
    this.session.setModel(name, model.mesh.vertices, model.mesh.indices, VERTEX_FLOATS);
    this.glbPath = relPath;
    this.image = model.image;
    // 回填上次编辑态（与编辑器 bindAssetAt 同语义：没有 / 损坏都不影响打开）
    const ed = this.readBindingEditor();
    let hydrated = false;
    if (ed !== undefined) {
      this.session.hydrate(ed);
      hydrated = true;
    }
    return {
      name,
      path: relPath,
      vertices: this.session.vertexCount(),
      triangles: this.session.triangleCount(),
      hydrated,
    };
  }

  /** 读 sidecar 的 bindingEditor 槽位；文件不存在 / 损坏 / 无此键 → undefined */
  private readBindingEditor(): unknown {
    const text = this.fs.readText(this.fs.resolve(this.metaPath()));
    if (text === null) return undefined;
    try {
      const meta: unknown = JSON.parse(text);
      if (meta === null || typeof meta !== 'object') return undefined;
      const ed = (meta as Record<string, unknown>).bindingEditor;
      return ed === undefined || ed === null ? undefined : ed;
    } catch {
      return undefined;
    }
  }

  /** save：把编辑态写进 sidecar 的 bindingEditor 槽（浅合并，不碰其他键） */
  save(): Record<string, unknown> {
    this.requireMesh();
    const rel = this.metaPath();
    const abs = this.fs.resolve(rel);
    const text = this.fs.readText(abs);
    if (text === null) {
      throw new ToolError(`sidecar 不存在：${rel}（先跑 pnpm run scene:gen 生成）`);
    }
    let meta: unknown;
    try {
      meta = JSON.parse(text);
    } catch {
      throw new ToolError(`sidecar JSON 损坏：${rel}（不静默修数据，先人工检查）`);
    }
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
      throw new ToolError(`sidecar 根节点不是对象：${rel}`);
    }
    (meta as Record<string, unknown>).bindingEditor = this.session.getEditorData();
    // 写前走与编辑器 saveBinding 同一把守门尺
    const diags = validateAssetMeta(meta);
    const errors = diags.filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      throw new ToolError(
        `写前校验失败（未落盘）：${errors.map((d) => `${d.code} ${d.message}`).join('；')}`,
      );
    }
    const out = `${JSON.stringify(meta, null, 2)}\n`;
    this.fs.writeText(abs, out);
    return {
      path: rel,
      // UTF-8 字节数（sidecar 常含中文节点名，out.length 是 UTF-16 码元数，会偏小）
      bytes: new TextEncoder().encode(out).length,
      warnings: diags.filter((d) => d.severity !== 'error'),
    };
  }

  /** hydrate：从 sidecar 重新灌入编辑态（进历史，可 undo 回灌前） */
  hydrateFromDisk(): Record<string, unknown> {
    this.requireMesh();
    const ed = this.readBindingEditor();
    if (ed === undefined) {
      return { hydrated: false, reason: 'sidecar 无 bindingEditor 槽位（或文件不存在/损坏）' };
    }
    this.session.hydrate(ed);
    return { hydrated: true, history: this.session.historyDepth() };
  }

  /** render：把当前会话状态装配成正交场景并光栅化 */
  render(args: Record<string, unknown>): ToolResult {
    const mesh = this.requireMesh();
    const v = optStr(args, 'view');
    const view: ViewAxis = v === 'side' || v === 'top' ? v : 'front';
    const width = clampInt(optNum(args, 'width'), 64, 1024, 480);
    const height = clampInt(optNum(args, 'height'), 64, 1024, 640);
    const showMesh = optBool(args, 'showMesh') !== false;
    const showSkeleton = optBool(args, 'showSkeleton') !== false;
    const showCylinders = optBool(args, 'showCylinders') !== false;
    const selectedJoint = optStr(args, 'selectedJoint');
    const heatBone = optStr(args, 'heatBone');
    // 视差观察角（度）：侧视 + azimuthDeg 时重叠的手臂/躯干轮廓在 z 向错开可读
    const azRaw = optNum(args, 'azimuthDeg');
    const azimuthDeg = azRaw === undefined ? 0 : Math.min(60, Math.max(-60, azRaw));
    // 网格风格：toon = 实心填充 + 视向法线翻转边实体轮廓（2D 卡通效果，无线框）
    const meshStyle = optStr(args, 'style') === 'toon' ? ('toon' as const) : ('wire' as const);

    const positions = this.session.positions;
    const segments: Segment[] = [];
    const markers: Marker[] = [];
    const capsules: Capsule[] = [];

    if (showSkeleton || showCylinders) {
      const segs = boneSegments(positions);
      if (showSkeleton) {
        for (const s of segs) {
          if (isTipBone(s.bone)) continue;
          segments.push({ a: s.a, b: s.b, color: COLOR_BONE });
        }
      }
      if (showCylinders) {
        const cyls = this.session.getCylinders();
        if (cyls !== null) {
          for (const s of segs) {
            if (isTipBone(s.bone)) continue;
            const c = cyls[s.bone];
            if (c === undefined || !c.enabled) continue;
            const { a, b } = offsetSegmentEndpoints(s.a, s.b, c.offset);
            capsules.push({
              a, b,
              // 三段约定：bottom 近 parent（= 骨段 a 端），top 近 child（= b 端）
              rA: c.radii.bottom,
              rB: c.radii.top,
              rM: c.radii.medium,
              color: c.manual === true ? COLOR_CYL_MANUAL : COLOR_CYL_AUTO,
            });
          }
        }
      }
    }
    if (showSkeleton) {
      for (const name of HUMANIK_ORDER) {
        const p = positions[name];
        if (p === undefined) continue;
        const selected = name === selectedJoint;
        markers.push({
          p,
          r: selected ? 6 : isTipBone(name) ? 3 : 4,
          color: selected ? COLOR_SELECTED : isTipBone(name) ? COLOR_JOINT_TIP : COLOR_JOINT,
          filled: selected || !isTipBone(name),
        });
      }
    }

    // 点云 + 可选热力（某根骨对每顶点的权重 → 色带）
    let points: PointCloud | undefined;
    let heatNote: string | undefined;
    if (showMesh) {
      let heat: Float32Array | undefined;
      if (heatBone !== undefined) {
        const boneIdx = HUMANIK_ORDER.indexOf(heatBone);
        if (boneIdx < 0) throw new ToolError(`未知关节：${heatBone}`);
        if (isTipBone(heatBone)) throw new ToolError(`tip 骨不参与蒙皮，热力恒为 0：${heatBone}`);
        const r = this.session.computeSkin();
        if (r === null) throw new ToolError('未载入模型');
        const n = mesh.vertices.length / mesh.vertexFloats;
        heat = new Float32Array(n);
        for (let v = 0; v < n; v++) {
          let w = 0;
          for (let k = 0; k < 4; k++) {
            if (r.skin.joints[v * 4 + k] === boneIdx) w += r.skin.weights[v * 4 + k] ?? 0;
          }
          heat[v] = w;
        }
        heatNote = `热力 = ${heatBone} 的逐顶点权重（蓝 0 → 红 1）；权重管线 = 算法→镜像→平滑`;
      }
      points = {
        xyz: mesh.vertices,
        stride: mesh.vertexFloats,
        count: mesh.vertices.length / mesh.vertexFloats,
        // 线框模式：减面模型的顶点太稀读不出体型，三角形边才行（点关闭）
        indices: mesh.indices,
        heat,
        size: 0,
      };
    }

    // 量化坐标参考线：审图时读出「这个关节偏高多少」靠它，不是靠肉眼估
    const gridOn = optBool(args, 'grid') === true;
    const gridStep = optNum(args, 'gridStep');
    const gridMajor = optNum(args, 'gridMajor');
    const grid: GridSpec | undefined = gridOn
      ? {
          ...(gridStep !== undefined ? { step: gridStep } : {}),
          ...(gridMajor !== undefined ? { majorEvery: gridMajor } : {}),
        }
      : undefined;

    const scene: OrthoScene = { view, width, height, points, segments, capsules, markers, azimuthDeg, meshStyle, grid };
    const image = renderOrthographic(scene);
    return {
      json: {
        view,
        width,
        height,
        azimuthDeg,
        meshStyle,
        grid: gridOn
          ? {
              stepM: grid?.step ?? 0.05,
              majorEveryM: (grid?.step ?? 0.05) * (grid?.majorEvery ?? 5),
              note: '网格为世界坐标等间距（正交投影下屏幕等距）：读数 = 数格子 × step',
            }
          : null,
        vertices: mesh.vertices.length / mesh.vertexFloats,
        capsules: capsules.length,
        heatBone: heatBone ?? null,
        note: heatNote,
      },
      image,
    };
  }

  /**
   * export_glb：把当前会话态（骨架 + wrapper + 权重选项）导成干净 T-pose 的 rigged GLB。
   *
   * 与编辑器 main.ts `exportBound` 同一条管线（`rigToTPoseWithImage`）：当前姿态算权重
   * （wrapper/distance → 镜像 → 平滑）→ 反解 T-pose → 骨架只采纳骨长、rotation 恒为单位
   * 四元数。产物落盘仓内，**不回传字节**（token 纪律：GLB 以 MB 计，统计足够决策）。
   *
   * sidecar 纪律：目标已有 .meta.json 时只**外科式刷新** sourceHash/updatedAt（不碰其他键，
   * 与 scene:gen 的 merge 语义一致）；没有则不代建 —— 首版 sidecar 要 roster 字段
   * （characterId / normalizeHeightM），那是 scene:gen 的职责，结果里给 next 提示。
   */
  async exportGlb(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const mesh = this.requireMesh();
    const srcRel = this.requireGlbPath();
    const s = this.session;

    const outRel = optStr(args, 'outPath') ?? srcRel.replace(/\.glb$/i, '_tpose.glb');
    if (!outRel.toLowerCase().endsWith('.glb')) {
      throw new ToolError(`导出目标必须是 .glb：${outRel}`);
    }
    // 守卫一律比**解析后的绝对路径**：resolve 会 collapse 掉 `./`、`sub/..` 段，
    // 比原始相对串会被这些变体绕过（独立审核 P0-1 实测：源模型被穿透覆盖）。
    // 再补 sameFile（dev+ino）：硬链/软链别名的绝对路径不同但指向同一文件
    const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
    const outAbs = this.fs.resolve(outRel);
    const srcAbs = this.fs.resolve(srcRel);
    if (norm(outAbs) === norm(srcAbs) || this.fs.sameFile(outAbs, srcAbs)) {
      // 自覆盖硬拒（overwrite 也不放行）：产物反解成 T-pose 并嵌骨架，
      // 盖掉源文件等于销毁绑定原料
      throw new ToolError(`导出目标不能覆盖源模型：${outRel}`);
    }
    // 目标已存在默认拒：存在的可能是在版本管理下的别的资产，静默覆盖 + 刷新
    // sidecar hash 会把 scene:check 门禁「洗白」（独立审核 P0-2 实测）。迭代重导
    // 同一产物走显式 overwrite: true
    const overwrite = optBool(args, 'overwrite') === true;
    if (this.fs.exists(outAbs) && !overwrite) {
      throw new ToolError(`目标已存在：${outRel}（确认覆盖请显式传 overwrite: true）`);
    }
    const outName = optStr(args, 'name') ?? s.getModelName() ?? 'bound';

    // TOCTOU 防护（独立审核 P1-2 实测）：贴图解码的 await 会让出事件循环，并发的
    // set_joint 会渗进活引用 —— 所有会话输入在第一个 await 之前同步深拷贝快照
    const placed = JSON.parse(JSON.stringify(s.positions)) as JointPositions;
    const cylLive = s.getWeightMode() === 'distance' ? null : s.getCylinders();
    const cylinders = cylLive === null
      ? undefined
      : (JSON.parse(JSON.stringify(cylLive)) as SkinCylinderMap);
    const smoothW = s.getSmoothWeights();
    const smoothI = s.getSmoothIters();
    const smoothL = s.getSmoothLambda();
    const mirror = s.getMirrorWeights();

    // 与 exportBound 的 base 包逐字段同构（动画除外：BVH 重定向不在 MCP 面内）
    const res = await rigToTPoseWithImage({
      name: outName,
      vertices: mesh.vertices,
      indices: mesh.indices,
      image: this.image,
      placed,
      smoothWeights: smoothW,
      smoothIters: smoothI,
      smoothLambda: smoothL,
      cylinders,
      mirrorWeights: mirror,
    });

    // 独占创建写：exists 预检只是省计算的快速路径，原子性靠 wx —— 两个并发导出
    // 同一新路径时，后到的在写边界收到 EEXIST 而不是静默覆盖先到的产物
    try {
      this.fs.writeBinary(outAbs, res.glb, !overwrite);
    } catch (err) {
      if (String(err).includes('EEXIST')) {
        throw new ToolError(`目标已存在：${outRel}（确认覆盖请显式传 overwrite: true）`);
      }
      throw err;
    }

    // sidecar 存在 → 只刷新 sourceHash/updatedAt，让 scene:check 的哈希门禁立刻转绿；
    // 不存在 → 不代建（roster 耦合字段是 gen-asset-meta 的职责），提示跑 scene:gen
    const metaRel = `${outRel}.meta.json`;
    const metaAbs = this.fs.resolve(metaRel);
    const metaText = this.fs.readText(metaAbs);
    let metaRefreshed = false;
    let metaWarning: string | undefined;
    if (metaText !== null) {
      try {
        const meta: unknown = JSON.parse(metaText);
        if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
          metaWarning = 'sidecar 根节点不是对象，跳过 hash 刷新（不静默修数据）';
        } else {
          const m = meta as Record<string, unknown>;
          m.sourceHash = `sha256:${this.fs.sha256(outAbs)}`;
          m.updatedAt = new Date().toISOString();
          this.fs.writeText(metaAbs, `${JSON.stringify(meta, null, 2)}\n`);
          metaRefreshed = true;
        }
      } catch {
        metaWarning = 'sidecar JSON 损坏，跳过 hash 刷新（不静默修数据）';
      }
    }

    const st = res.stats;
    return {
      glbPath: outRel,
      bytes: res.glb.byteLength,
      metaRefreshed,
      metaWarning,
      // metaWarning 时 sidecar 是「在但坏」，「不存在跑 scene:gen」的提示会误导（P2）
      next: metaRefreshed || metaWarning !== undefined
        ? undefined
        : 'sidecar 不存在：跑 pnpm run scene:gen 生成首版（roster 字段）并复核 scene:check',
      stats: {
        vertices: st.vertices,
        triangles: st.triangles,
        bones: st.bones,
        maxPoseAngleDeg: st.maxPoseAngleDeg,
        offAxisBones: st.offAxisBones,
        heightBefore: st.heightBefore,
        heightAfter: st.heightAfter,
        zeroWeightVerts: st.zeroWeightVerts,
        tipWeightSum: st.tipWeightSum,
        tipRefVerts: st.tipRefVerts,
      },
    };
  }
}

// ─────────────────────────── 工具表（tools/list 的唯一真源） ───────────────────────────

const VEC3_SCHEMA = {
  type: 'array',
  items: { type: 'number' },
  minItems: 3,
  maxItems: 3,
  description: '[x, y, z] 米，模型 local 空间（归一化身高 2.05m）',
};

export const TOOLS_TABLE = [
  {
    name: 'load_model',
    description:
      '载入仓内 .glb 并归一到编辑器同一把身高尺（2.05m）；若 sidecar .meta.json 有 bindingEditor 存档会自动回填。返回网格规模与是否回填。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '仓内相对路径，如 assets/characters/models/E-04/game_ready/E04_..._1600tris.glb' },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_state',
    description: '会话总览：模型 / 权重导出选项 / Undo 深度 / Bind 指纹。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_joints',
    description: '27 关节当前坐标（local 空间）+ 合法骨名顺序表（set_joint 的 name 取值域）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_joint',
    description: '摆一个关节（一次性，自带历史可 undo）。非法骨名 / 非有限坐标报错。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '骨名，如 LeftArm / Head（合法值见 get_joints 的 order）' },
        position: VEC3_SCHEMA,
      },
      required: ['name', 'position'],
    },
  },
  {
    name: 'mirror',
    description: '左右镜像骨架 + wrapper 半径（x 取反并互换左右骨名）。',
    inputSchema: {
      type: 'object',
      properties: { dir: { type: 'string', enum: ['L2R', 'R2L'], description: 'L2R = 左拷到右' } },
      required: ['dir'],
    },
  },
  {
    name: 'reset_pose',
    description: '清空全部关节编辑回到模板 T-pose（进历史，可 undo）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'undo',
    description: '撤销一步编辑。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'redo',
    description: '重做一步编辑。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cylinders',
    description:
      'Skin Wrapper 圆柱体表操作：get 读表；autoFit 按骨长重算未手动锁定的半径；setRadius/setOffset 调单骨；clearOffset 清位移；mirror/mirrorAll 镜像；unpin 交还自动适配。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'autoFit', 'setRadius', 'setOffset', 'clearOffset', 'mirror', 'mirrorAll', 'unpin'],
        },
        bone: { type: 'string', description: '目标骨（setRadius/setOffset/clearOffset/mirror/unpin 必填）' },
        seg: { type: 'string', enum: ['top', 'medium', 'bottom'], description: 'setRadius 必填；top 近子骨、bottom 近父骨' },
        value: { type: 'number', description: 'setRadius 必填，半径（米，必须 > 0；0/负数会被拒）' },
        offset: { ...VEC3_SCHEMA, description: 'setOffset 必填，骨局部坐标位移（x=沿骨轴）' },
      },
      required: ['action'],
    },
  },
  {
    name: 'set_options',
    description:
      '设权重导出选项（只动传入的键；越界值按面板同款规则钳制）。管线顺序铁律：算法 → 镜像 → 平滑。',
    inputSchema: {
      type: 'object',
      properties: {
        weightMode: { type: 'string', enum: ['wrapper', 'distance'] },
        smoothWeights: { type: 'boolean' },
        smoothIters: { type: 'integer', description: '1..12' },
        smoothLambda: { type: 'number', description: '0..1' },
        mirrorWeights: { type: 'boolean' },
      },
    },
  },
  {
    name: 'compute_skin',
    description:
      '算一遍当前权重（算法 → 镜像 → 平滑，与导出同序），只返回统计不返回权重数组（token 纪律）：未包裹顶点数等。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'render',
    description:
      '渲染正/侧视正交投影图（PNG 图像块）：网格点云 + 骨架 + wrapper 圆柱轮廓，可选 heatBone 画逐顶点权重热力。视觉反馈闭环的核心工具。⚠️ 骨骼对齐阶段必须传 showCylinders:false 先关掉圆柱 Skin Wrapper（半透明 proxy 会污染截图、干扰 joint 对位判读），骨骼验证通过后再显示 wrapper。',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['front', 'side', 'top'], description: '默认 front；top = 俯视（右=+X 角色左侧，上=+Z 前方），查体姿偏航/脚外八用' },
        width: { type: 'integer', description: '64..1024，默认 480' },
        height: { type: 'integer', description: '64..1024，默认 640' },
        heatBone: { type: 'string', description: '画该骨权重热力图（tip 骨不参与蒙皮，会被拒）' },
        selectedJoint: { type: 'string', description: '高亮标红的关节名' },
        showMesh: { type: 'boolean', description: '默认 true' },
        showSkeleton: { type: 'boolean', description: '默认 true' },
        showCylinders: { type: 'boolean', description: '默认 true' },
        style: { type: 'string', enum: ['wire', 'toon'], description: '网格风格：wire=三角形线框（默认）；toon=实心填充+视向法线翻转边实体轮廓（2D 卡通轮廓，配 azimuthDeg 视差角判读重叠肢体）' },
        azimuthDeg: { type: 'number', description: '视差观察角 -60..60（度，默认 0）：投影前绕 Y 旋转，侧视 + 30° 时左右重叠的手臂/躯干轮廓在 z 向错开，便于判读重叠部位' },
        grid: { type: 'boolean', description: '默认 false。画**量化坐标参考线**（工程图风格网格 + 刻度数值，单位米）：网格线在模型下层、数值在最上层带白描边。审图要「读出这个关节偏高多少」时开它 —— 正交投影下世界等间距 = 屏幕等间距，读数 = 数格子 × step，无需额外标定。⚠️ azimuthDeg≠0 时网格不再对齐世界轴，别叠用' },
        gridStep: { type: 'number', description: '网格间距（米），默认 0.05。配合 grid:true' },
        gridMajor: { type: 'number', description: '每几格一条主线并标数值，默认 5（即 0.25m 标一次）。配合 grid:true' },
      },
    },
  },
  {
    name: 'get_editor_data',
    description: '当前持久化编辑态（= 会写进 sidecar bindingEditor 槽的内容）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'save',
    description:
      '把编辑态浅合并写进 <glb>.meta.json 的 bindingEditor 槽（不碰其他键），写前过 validateAssetMeta 守门；sidecar 不存在 / 损坏会报错而不是静默修。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hydrate',
    description: '从 sidecar 重新灌入编辑态（进历史，可 undo 回灌前）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'export_glb',
    description:
      '把当前会话态导成干净 T-pose 的 rigged GLB 并落盘仓内（与编辑器 exportBound 同管线：当前姿态算权重 → 反解 T-pose → 骨架只采纳骨长）。只回统计不回字节；已有 sidecar 会外科式刷新 sourceHash，没有则提示跑 scene:gen。',
    inputSchema: {
      type: 'object',
      properties: {
        outPath: {
          type: 'string',
          description: '仓内相对输出路径，默认 <源文件去 .glb>_tpose.glb；不许覆盖源模型',
        },
        name: { type: 'string', description: '导出名（GLB 内 mesh/材质命名），默认载入模型名' },
        overwrite: {
          type: 'boolean',
          description: '目标已存在时显式放行覆盖（重导迭代用）；覆盖源模型恒拒',
        },
      },
    },
  },
] as const;

// ─────────────────────────── 调度 ───────────────────────────

/**
 * 纯读工具（不改写会话状态；export_glb 读会话 + 写产物文件，不动 positions/权重，
 * 历史栈无需封口）。其余工具一律视为写操作，成功后 sealHistory 封口 ——
 * MCP 调用没有 GUI 的手势边界（pointerup / 换选中），800ms 合并窗口会把 Agent
 * 脚本化的连续调用并成一步 undo（独立审核 P1-2 实测复现）。
 */
const READONLY_TOOLS: ReadonlySet<string> = new Set([
  'get_state', 'get_joints', 'compute_skin', 'render', 'get_editor_data', 'export_glb',
]);

export async function dispatchTool(
  domain: BindingDomain,
  name: string,
  rawArgs: unknown,
): Promise<ToolResult> {
  // 写工具路径在 dispatchInner 里**同步执行完毕**（只有 export_glb 内含 await），
  // 所以封口必须赶在 await 让出事件循环之前：否则同一 stdin chunk 连发的下一个
  // 写工具会撞见未关闭的 800ms 合并窗，两次调用被并成一步 undo（Copilot PR #11）
  const p = dispatchInner(domain, name, rawArgs);
  if (!READONLY_TOOLS.has(name)) domain.session.sealHistory();
  return await p;
}

async function dispatchInner(
  domain: BindingDomain,
  name: string,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args = asObj(rawArgs);
  const s = domain.session;
  switch (name) {
    case 'load_model':
      return { json: domain.loadModel(reqStr(args, 'path')) };

    case 'get_state': {
      const mesh = s.getMesh();
      return {
        json: {
          model: mesh === null
            ? null
            : {
                name: s.getModelName(),
                vertices: s.vertexCount(),
                triangles: s.triangleCount(),
              },
          options: {
            weightMode: s.getWeightMode(),
            smoothWeights: s.getSmoothWeights(),
            smoothIters: s.getSmoothIters(),
            smoothLambda: s.getSmoothLambda(),
            mirrorWeights: s.getMirrorWeights(),
          },
          history: s.historyDepth(),
          bound: s.getBoundSig() !== null,
          bindPoseFrozen: s.getBindPose() !== null,
          editSig: s.editSig(),
        },
      };
    }

    case 'get_joints':
      return { json: { order: HUMANIK_ORDER, positions: s.positions } };

    case 'set_joint': {
      const jointName = requireBone(args, 'name');
      const p = reqVec3(args, 'position');
      if (!s.poseJoint(jointName, p)) throw new ToolError('坐标非法（非有限数）');
      return { json: { ok: true, position: s.positions[jointName] } };
    }

    case 'mirror': {
      const dir = reqStr(args, 'dir');
      if (dir !== 'L2R' && dir !== 'R2L') throw new ToolError(`dir 只能是 L2R / R2L：${dir}`);
      s.mirror(dir);
      return { json: { ok: true } };
    }

    case 'reset_pose':
      s.resetPositions();
      return { json: { ok: true, note: '已回模板 T-pose（进历史，可 undo）' } };

    case 'undo':
      return { json: { done: s.undo(), history: s.historyDepth() } };

    case 'redo':
      return { json: { done: s.redo(), history: s.historyDepth() } };

    case 'cylinders': {
      const action = reqStr(args, 'action');
      // 取骨名的 action 一律过白名单（P1-1：防原型链键污染 session 状态）
      const bone = (): string => requireBone(args, 'bone');
      switch (action) {
        case 'get':
          return { json: { cylinders: s.getCylinders() } };
        case 'autoFit':
          return { json: { changed: s.autoFitCylinders() } };
        case 'setRadius': {
          const b = bone();
          const seg = reqStr(args, 'seg');
          if (seg !== 'top' && seg !== 'medium' && seg !== 'bottom') {
            throw new ToolError(`seg 只能是 top / medium / bottom：${seg}`);
          }
          const value = optNum(args, 'value');
          if (value === undefined) throw new ToolError('setRadius 缺 value（半径，米）');
          // 半径必须为正：0/负数会在蒙皮算法里被静默替换成 1e-6（防除零），
          // 产物几乎包不住任何顶点且非法值还被持久化（PR #10 评审）
          if (value <= 0) throw new ToolError(`半径必须为正数（米）：${value}`);
          if (!s.setCylinderRadius(b, seg, value)) {
            throw new ToolError(`写入失败：${b}（值非法 / 未载入模型）`);
          }
          return { json: { ok: true, cylinder: s.getCylinders()?.[b] } };
        }
        case 'setOffset': {
          const b = bone();
          const offset = reqVec3(args, 'offset');
          if (!s.setCylinderOffset(b, offset)) {
            throw new ToolError(`写入失败：${b}（未载入模型）`);
          }
          return { json: { ok: true, offset: s.getOffset(b) } };
        }
        case 'clearOffset': {
          const b = bone();
          // 全零位移在存储层归一为 undefined（session 约定：默认不写 = [0,0,0]）
          if (!s.setCylinderOffset(b, [0, 0, 0])) {
            throw new ToolError(`写入失败：${b}（未载入模型）`);
          }
          return { json: { ok: true, offset: s.getOffset(b) } };
        }
        case 'mirror': {
          const b = bone();
          if (!s.mirrorCylinder(b)) {
            throw new ToolError(`镜像失败：${b}（无镜像对 / 未载入模型）`);
          }
          return { json: { ok: true } };
        }
        case 'mirrorAll':
          s.mirrorAllCylinders();
          return { json: { ok: true } };
        case 'unpin': {
          const b = bone();
          if (!s.unpinCylinder(b)) {
            throw new ToolError(`unpin 失败：${b}（未载入模型）`);
          }
          return { json: { ok: true, cylinder: s.getCylinders()?.[b] } };
        }
        default:
          throw new ToolError(`未知 action：${action}`);
      }
    }

    case 'set_options': {
      const wm = optStr(args, 'weightMode');
      if (wm !== undefined && wm !== 'wrapper' && wm !== 'distance') {
        throw new ToolError(`weightMode 只能是 wrapper / distance：${wm}`);
      }
      // 批量设置走 session.applyOptions：多字段合并为一步历史（PR #10 评审），
      // 逐 setter 调用会各打一条快照、undo 一次只回退最后一个字段
      const batch: Parameters<BindingSession['applyOptions']>[0] = {};
      if (wm !== undefined) batch.weightMode = wm;
      const sw = optBool(args, 'smoothWeights');
      if (sw !== undefined) batch.smoothWeights = sw;
      const mw = optBool(args, 'mirrorWeights');
      if (mw !== undefined) batch.mirrorWeights = mw;
      const si = optNum(args, 'smoothIters');
      if (si !== undefined) batch.smoothIters = si;
      const sl = optNum(args, 'smoothLambda');
      if (sl !== undefined) batch.smoothLambda = sl;
      s.applyOptions(batch);
      return {
        json: {
          applied: {
            weightMode: s.getWeightMode() satisfies WeightMode,
            smoothWeights: s.getSmoothWeights(),
            smoothIters: s.getSmoothIters(),
            smoothLambda: s.getSmoothLambda(),
            mirrorWeights: s.getMirrorWeights(),
          },
        },
      };
    }

    case 'compute_skin': {
      const r = s.computeSkin();
      if (r === null) throw new ToolError('未载入模型：先调 load_model');
      return {
        json: {
          weightMode: s.getWeightMode(),
          vertices: s.vertexCount(),
          unwrappedVerts: r.stats?.unwrappedVerts ?? null,
          pipeline: '算法 → 镜像 → 平滑（与导出同序）',
          note: r.stats === null ? 'distance 模式无 wrapper 统计' : undefined,
        },
      };
    }

    case 'render':
      return domain.render(args);

    case 'get_editor_data':
      return { json: s.getEditorData() };

    case 'save':
      return { json: domain.save() };

    case 'hydrate':
      return { json: domain.hydrateFromDisk() };

    case 'export_glb':
      return { json: await domain.exportGlb(args) };

    default:
      throw new ToolError(`unknown tool: ${name}`);
  }
}
