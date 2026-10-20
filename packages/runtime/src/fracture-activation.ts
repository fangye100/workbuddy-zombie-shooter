/**
 * WU-04 生产共用的碎片激活准备与资产准入（R1）。
 *
 * 责任：读取并核验当前 profile/source/sidecar 的 GUID/kind/status/引用，复用 scene
 * 的 validateFractureAsset/validateAssetMeta 格式校验；真实加载正式碰撞代理（含离线
 * convex 网格点集）；按唯一变换链（资产 bind/pivot → assemblyScale → 事件世界变换）
 * 生成 chunk 输入与物理参数；由来向/接触/seed 驱动初始运动。Preview/Play 共用此职责。
 *
 * 分层：IO 经注入端口（readText/readBinary），runtime 不直接碰 fs/DOM；僵尸策略、
 * 伤害/死亡、作者 UI 不在此。准入失败在 body/租约分配前拒绝并给诊断，不静默丢块。
 */

import {
  validateFractureAsset,
  migrateFractureAsset,
  validateAssetMeta,
  type AssetMeta,
} from '@aether/scene';
import { parseGlb, VERTEX_FLOATS } from '@aether/scene';
import type { FractureEvent, FractureVec3, FractureQuat } from './fracture';
import type { FractureActivation, FractureChunkInput } from './fracture-runtime';

/** 资产读取端口（宿主注入；编辑器/Preview/Play 各自实现 fs/devfs/内存）。 */
export interface FractureAssetIO {
  /** 读 UTF-8 文本（profile/sidecar JSON）。 */
  readText(path: string): Promise<string>;
  /** 读二进制（离线 convex GLB 点集等）。 */
  readBinary(path: string): Promise<ArrayBuffer>;
}

/** 准入/准备失败诊断（不静默；调用方可保留作者草稿/原表现保底）。 */
export interface FractureAdmissionFailure {
  readonly stage: 'profile-read' | 'profile-validate' | 'sidecar-read' | 'sidecar-validate'
    | 'identity' | 'target-kind' | 'quarantined' | 'ref-read' | 'ref-identity' | 'ref-binary'
    | 'proxy-load' | 'transform';
  readonly detail: string;
}

export type FracturePrepareResult =
  | { readonly ok: true; readonly activation: FractureActivation }
  | { readonly ok: false; readonly failure: FractureAdmissionFailure };

/** 确定性伪随机（mulberry32）：同 seed 同输入可复现，不掺入奖励/AI 随机序列。 */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 四元数乘法（R6：世界旋转 = 事件旋转 ∘ bind 旋转）。 */
function quatMul(a: FractureQuat, b: FractureQuat): FractureQuat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** 四元数 ⊗ 向量旋转。 */
function rotateByQuat(v: FractureVec3, q: FractureQuat): FractureVec3 {
  const [x, y, z] = v;
  const [qx, qy, qz, qw] = q;
  const uvx = qy * z - qz * y, uvy = qz * x - qx * z, uvz = qx * y - qy * x;
  const uuvx = qy * uvz - qz * uvy, uuvy = qz * uvx - qx * uvz, uuvz = qx * uvy - qy * uvx;
  return [
    x + 2 * (qw * uvx + uuvx),
    y + 2 * (qw * uvy + uuvy),
    z + 2 * (qw * uvz + uuvz),
  ];
}

/** 离线 convex GLB 点集提取端口（宿主注入；复用既有解析责任，不复制简化加载器）。 */
export interface ConvexPointsResolver {
  /** 从 GLB 二进制提取凸代理顶点（已含资产局部尺度）。 */
  (buffer: ArrayBuffer): Float32Array;
}

export interface PrepareOptions {
  readonly io: FractureAssetIO;
  /** 离线 convex 点集解析；仅在 profile 含 convex 代理时必需。 */
  readonly resolveConvexPoints?: ConvexPointsResolver;
  /**
   * 已核验过的二进制引用路径缓存（可选，按会话复用）。
   * 同一 profile 的 GLB 在会话内不变，重复激活无需每次重读数 MB 数据。
   */
  readonly verifiedRefs?: Set<string>;
}

/**
 * 正式 GLB 凸代理解析器（R1 生产实现）：用 scene 的 parseGlb 提取**原始位置**。
 *
 * 坐标合同：碎裂 profile 的 pivot 是碎块在**资产原始坐标**里的局部点
 * （实测 chunk-0009 原始 POSITION y 落在 0.6005..0.9005，profile pivot.y=0.7894）。
 * 因此代理点必须取未规整化的坐标，再由调用方减去 pivot，得到「以 pivot 为原点」
 * 的代理局部系；若取 parseGlb 默认的居中/贴地结果，碰撞体会整体偏离 body。
 * 所以这里传 normalize:false（仍保留 node 世界变换烘焙）。
 *
 * 布局合同：MeshData.vertices 是交错顶点缓冲（VERTEX_FLOATS=15：
 * position3 + normal3 + smoothNormal3 + uv2 + color4）。按整块返回会把
 * 法线/UV/颜色当成坐标，碰撞体被撑到 [-1,1]。这里逐顶点只取前 3 个分量。
 */
export function createGlbConvexResolver(): ConvexPointsResolver {
  return (buffer: ArrayBuffer): Float32Array => {
    const verts = parseGlb(buffer, null, 'auto', { normalize: false }).mesh.vertices;
    const stride = VERTEX_FLOATS;
    if (verts.length % stride !== 0) {
      throw new Error('GLB 顶点缓冲长度 ' + verts.length + ' 不是顶点步长 ' + stride + ' 的整数倍');
    }
    const count = verts.length / stride;
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const o = i * stride;
      out[i * 3] = verts[o]!;
      out[i * 3 + 1] = verts[o + 1]!;
      out[i * 3 + 2] = verts[o + 2]!;
    }
    return out;
  };
}

/**
 * 核验引用资产二进制：能读到、不是 LFS 指针、是合法 GLB（magic + 声明长度）。
 * 已核验路径记入 verifiedRefs 缓存（按会话复用，避免每次激活重读数 MB）。
 */
async function checkRefBinary(
  io: FractureAssetIO,
  path: string,
  verified: Set<string> | undefined,
): Promise<FractureAdmissionFailure | null> {
  if (verified?.has(path)) return null;
  let buf: ArrayBuffer;
  try {
    buf = await io.readBinary(path);
  } catch (e) {
    return { stage: 'ref-binary', detail: '引用资产读取失败（' + path + '）：' + String(e) };
  }
  if (buf.byteLength < 20) {
    return { stage: 'ref-binary', detail: '引用资产不是合法 GLB（' + path + ' 仅 ' + buf.byteLength + ' 字节，疑似 LFS 指针/空文件）' };
  }
  const head = new DataView(buf);
  if (head.getUint32(0, true) !== 0x46546c67) {
    return { stage: 'ref-binary', detail: '引用资产缺 glTF magic（' + path + '）' };
  }
  const declared = head.getUint32(8, true);
  if (declared !== buf.byteLength) {
    return { stage: 'ref-binary', detail: 'GLB 声明长度 ' + declared + ' 与实际 ' + buf.byteLength + ' 不一致（' + path + '）' };
  }
  verified?.add(path);
  return null;
}

const SCALE_EPS = 1e-4;
/** 事件世界尺度是否近似均匀（非均匀组合在 R6 明确拒绝，不平均近似）。 */
function isUniformScale(s: FractureVec3): boolean {
  return Math.abs(s[0] - s[1]) <= SCALE_EPS && Math.abs(s[1] - s[2]) <= SCALE_EPS;
}

/** 读一个被引用资产的 sidecar 并核验其 guid/kind（R1：证明引用指向正确资产）。 */
async function checkRefMeta(
  io: FractureAssetIO,
  refPath: string,
  expectedGuid: string,
  expectedKind: AssetMeta['kind'],
  label: string,
): Promise<FractureAdmissionFailure | null> {
  let meta: AssetMeta;
  try {
    meta = JSON.parse(await io.readText(refPath + '.meta.json')) as AssetMeta;
  } catch (e) {
    return { stage: 'ref-read', detail: label + ' sidecar 读取失败（' + refPath + '）：' + String(e) };
  }
  const errs = validateAssetMeta(meta);
  if (errs.some((d) => d.severity === 'error')) {
    return { stage: 'ref-identity', detail: label + ' sidecar 非法（' + refPath + '）：' + errs.map((d) => d.message).join('；') };
  }
  if (meta.kind !== expectedKind) {
    return { stage: 'ref-identity', detail: label + ' kind=' + meta.kind + '，应为 ' + expectedKind + '（' + refPath + '）' };
  }
  if (meta.guid !== expectedGuid) {
    return { stage: 'ref-identity', detail: label + ' guid 不一致：profile 引用=' + expectedGuid + ' sidecar=' + meta.guid + '（' + refPath + '）' };
  }
  return null;
}

/**
 * 读取并核验正式 profile + sidecar，按事件变换/来向/seed 生成激活输入。
 * 任一准入失败在分配物理资源前返回诊断（不建 body/租约）。异步迟到/Stop 由调用方
 * 经 session generation 守卫（本函数纯数据准备，不持有会话）。
 */
export async function prepareFractureActivation(
  event: FractureEvent,
  opts: PrepareOptions,
): Promise<FracturePrepareResult> {
  const profilePath = event.profile.path;
  // 1) 读 profile
  let profileRaw: unknown;
  try {
    profileRaw = JSON.parse(await opts.io.readText(profilePath));
  } catch (e) {
    return { ok: false, failure: { stage: 'profile-read', detail: 'profile 读取失败：' + String(e) } };
  }
  // 2) scene 格式校验（版本/坏代理/非法数值/重复 chunkId/超预算均显式报错）
  const profileErrors = validateFractureAsset(profileRaw);
  if (profileErrors.length) {
    return { ok: false, failure: { stage: 'profile-validate', detail: profileErrors.join('；') } };
  }
  const profile = migrateFractureAsset(profileRaw); // 已校验，structuredClone
  // 3) sidecar 准入：profile 文件自身的 .meta.json 必须有合法 guid/kind/status
  let meta: AssetMeta;
  try {
    meta = JSON.parse(await opts.io.readText(profilePath + '.meta.json')) as AssetMeta;
  } catch (e) {
    return { ok: false, failure: { stage: 'sidecar-read', detail: 'sidecar 读取失败：' + String(e) } };
  }
  const metaErrs = validateAssetMeta(meta);
  if (metaErrs.some((d) => d.severity === 'error')) {
    return { ok: false, failure: { stage: 'sidecar-validate', detail: metaErrs.map((d) => d.message).join('；') } };
  }
  // 4) 身份核验：事件 profile.guid 必须等于 profile.id 且等于 sidecar guid；kind 必须是 fracture。
  if (meta.kind !== 'fracture') {
    return { ok: false, failure: { stage: 'identity', detail: 'sidecar kind=' + meta.kind + '，应为 fracture' } };
  }
  if (event.profile.guid !== profile.id || profile.id !== meta.guid) {
    return { ok: false, failure: { stage: 'identity', detail: 'GUID 不一致：event=' + event.profile.guid + ' profile=' + profile.id + ' sidecar=' + meta.guid } };
  }
  // 4b) 目标类型必须与 profile.kind 对齐：object 资产不能被 NPC 事件激活，反之亦然。
  const wantNpc = profile.kind === 'npc';
  const isNpcTarget = event.target.kind === 'npc';
  if (wantNpc !== isNpcTarget) {
    return {
      ok: false,
      failure: {
        stage: 'target-kind',
        detail: 'profile kind=' + profile.kind + ' 与事件目标 kind=' + event.target.kind + ' 不匹配',
      },
    };
  }
  // 5) 隔离：quarantined 在分配前拒绝（恢复 accepted 后下一次播放可重新准入）。
  if (profile.status !== 'accepted') {
    return { ok: false, failure: { stage: 'quarantined', detail: 'profile 状态 ' + profile.status + '，未验收' } };
  }

  // 6) R1：核验全部引用资产的 sidecar 身份（source.model + 每个 chunk.mesh + 每个 convex.mesh），
  //    证明引用指向正确资产而非仅格式合法。
  const srcFail = await checkRefMeta(opts.io, profile.source.model.path, profile.source.model.guid, 'gltf', '源模型');
  if (srcFail) return { ok: false, failure: srcFail };
  for (const c of profile.chunks) {
    const mf = await checkRefMeta(opts.io, c.mesh.path, c.mesh.guid, 'gltf', '碎块 ' + c.chunkId);
    if (mf) return { ok: false, failure: mf };
    if (c.proxy.shape.type === 'convex') {
      const cf = await checkRefMeta(opts.io, c.proxy.shape.mesh.path, c.proxy.shape.mesh.guid, 'gltf', '碎块 ' + c.chunkId + ' 凸代理');
      if (cf) return { ok: false, failure: cf };
    }
  }
  // 6b) 引用资产的**二进制可用性**：sidecar 合法不代表文件读得到/是 GLB。
  //     逐个核验 conic（source + 每块 mesh），坏文件在分配前拒绝而不是播到一半崩。
  const refs = [profile.source.model.path, ...profile.chunks.map((c) => c.mesh.path)];
  for (const path of refs) {
    const bf = await checkRefBinary(opts.io, path, opts.verifiedRefs);
    if (bf) return { ok: false, failure: bf };
  }

  // 7) R6：事件世界尺度必须均匀（非均匀组合不平均近似，明确拒绝）。
  const ws = event.scale;
  if (!isUniformScale(ws)) {
    return { ok: false, failure: { stage: 'transform', detail: '事件世界尺度非均匀（' + ws.join(',') + '），不支持近似，请改用均匀尺度' } };
  }
  const rng = makeRng(event.seed);
  const chunks: FractureChunkInput[] = [];
  for (const c of profile.chunks) {
    // R6：bind.scale 三轴也必须均匀（schema 允许非均匀，但物理代理标量尺度无法表示；明确拒绝）。
    const bs = c.bind.scale;
    if (!isUniformScale(bs)) {
      return { ok: false, failure: { stage: 'transform', detail: '碎块 ' + c.chunkId + ' bind.scale 非均匀（' + bs.join(',') + '），不支持近似，请改用均匀尺度' } };
    }
    // R6 唯一变换链（标准 bind TRS 公式，assemblyScale 已含在事件世界变换，不二次乘）：
    // bind 局部：质心 = bindT + bindR * (bindS * pivot)
    // 世界：质心 = eventT + eventR * (bindT + bindR * (bindS * pivot)) * eventS
    const pivotScaled: FractureVec3 = [
      c.bind.scale[0] * c.pivot[0],
      c.bind.scale[1] * c.pivot[1],
      c.bind.scale[2] * c.pivot[2],
    ];
    const bindLocal = rotateByQuat(pivotScaled, c.bind.rotation);
    const bindPos: FractureVec3 = [
      c.bind.position[0] + bindLocal[0],
      c.bind.position[1] + bindLocal[1],
      c.bind.position[2] + bindLocal[2],
    ];
    const worldOffset = rotateByQuat(bindPos, event.rotation);
    const worldPos: FractureVec3 = [
      event.position[0] + worldOffset[0] * ws[0],
      event.position[1] + worldOffset[1] * ws[1],
      event.position[2] + worldOffset[2] * ws[2],
    ];
    const worldRot = quatMul(event.rotation, c.bind.rotation);
    // bind.scale 已在上文拒绝非均匀；此处直接用 bind.scale[0]（均匀值）× 事件均匀尺度。
    const worldScale = c.bind.scale[0] * ws[0];

    let shape: FractureChunkInput['shape'];
    if (c.proxy.shape.type === 'convex') {
      if (!opts.resolveConvexPoints) {
        return { ok: false, failure: { stage: 'proxy-load', detail: '碎块 ' + c.chunkId + ' 需离线 convex 代理但未提供 resolveConvexPoints' } };
      }
      let buf: ArrayBuffer;
      try {
        buf = await opts.io.readBinary(c.proxy.shape.mesh.path);
      } catch (e) {
        return { ok: false, failure: { stage: 'proxy-load', detail: '碎块 ' + c.chunkId + ' convex 代理读取失败：' + String(e) } };
      }
      let pts: Float32Array;
      try {
        pts = opts.resolveConvexPoints(buf);
      } catch (e) {
        return { ok: false, failure: { stage: 'proxy-load', detail: '碎块 ' + c.chunkId + ' convex 代理解析失败：' + String(e) } };
      }
      // 代理局部系以 profile.pivot 为原点：resolver 给的是资产原始坐标，
      // 减去 pivot 后与 body 的平移（= pivot + 事件世界变换）自洽。
      if (pts instanceof Float32Array && pts.length % 3 === 0 && pts.length >= 3) {
        const px = c.pivot[0], py = c.pivot[1], pz = c.pivot[2];
        for (let i = 0; i < pts.length; i += 3) {
          pts[i] = pts[i]! - px;
          pts[i + 1] = pts[i + 1]! - py;
          pts[i + 2] = pts[i + 2]! - pz;
        }
      }
      if (!(pts instanceof Float32Array) || pts.length < 9 || pts.length % 3 !== 0) {
        return { ok: false, failure: { stage: 'proxy-load', detail: '碎块 ' + c.chunkId + ' convex 代理点数非法（需 ≥3 点且为 3 的倍数），实际 ' + pts.length } };
      }
      let degenerate = false;
      for (let i = 0; i < pts.length; i++) { if (!Number.isFinite(pts[i])) { degenerate = true; break; } }
      if (degenerate) {
        return { ok: false, failure: { stage: 'proxy-load', detail: '碎块 ' + c.chunkId + ' convex 代理含非有限值' } };
      }
      // 非退化三维凸包校验：找非共面四点（点到基面距离 > 1e-6 米）。
      // maxDist/maxArea 为平方量（阈值 1e-12 对应长度/叉积 < 1e-6），maxVol 为长度量。
      {
        const nPts = pts.length / 3;
        // 找最远两点作为基线
        let maxDist = 0, i0 = 0, i1 = 1;
        for (let a = 0; a < nPts; a++) for (let b = a + 1; b < nPts; b++) {
          const dx = pts[a*3]!-pts[b*3]!, dy = pts[a*3+1]!-pts[b*3+1]!, dz = pts[a*3+2]!-pts[b*3+2]!;
          const d = dx*dx+dy*dy+dz*dz;
          if (d > maxDist) { maxDist = d; i0 = a; i1 = b; }
        }
        if (maxDist < 1e-12) {
          return { ok: false, failure: { stage: 'proxy-load', detail: '碎块 ' + c.chunkId + ' convex 代理所有点重合（零体积）' } };
        }
        // 找离基线最远的点
        const ax = pts[i0*3]!, ay = pts[i0*3+1]!, az = pts[i0*3+2]!;
        const bx = pts[i1*3]!, by = pts[i1*3+1]!, bz = pts[i1*3+2]!;
        const abx = bx-ax, aby = by-ay, abz = bz-az;
        let maxArea = 0, i2 = -1;
        for (let a = 0; a < nPts; a++) {
          if (a === i0 || a === i1) continue;
          const cx = pts[a*3]!, cy = pts[a*3+1]!, cz = pts[a*3+2]!;
          const acx = cx-ax, acy = cy-ay, acz = cz-az;
          // 叉积 |AB × AC| = 2 * 三角形面积
          const nx = aby*acz - abz*acy, ny = abz*acx - abx*acz, nz = abx*acy - aby*acx;
          const area = nx*nx + ny*ny + nz*nz;
          if (area > maxArea) { maxArea = area; i2 = a; }
        }
        if (maxArea < 1e-12 || i2 < 0) {
          return { ok: false, failure: { stage: 'proxy-load', detail: '碎块 ' + c.chunkId + ' convex 代理所有点共线（零面积）' } };
        }
        // 找离平面最远的点（非共面校验）
        const cx2 = pts[i2*3]!, cy2 = pts[i2*3+1]!, cz2 = pts[i2*3+2]!;
        const nx = aby*(cz2-az) - abz*(cy2-ay), ny2 = abz*(cx2-ax) - abx*(cz2-az), nz2 = abx*(cy2-ay) - aby*(cx2-ax);
        const nLen = Math.sqrt(nx*nx + ny2*ny2 + nz2*nz2);
        let maxVol = 0;
        for (let a = 0; a < nPts; a++) {
          if (a === i0 || a === i1 || a === i2) continue;
          const dx2 = pts[a*3]!-ax, dy2 = pts[a*3+1]!-ay, dz2 = pts[a*3+2]!-az;
          const vol = Math.abs(nx*dx2 + ny2*dy2 + nz2*dz2) / (nLen || 1);
          if (vol > maxVol) maxVol = vol;
        }
        if (maxVol < 1e-6) {
          return { ok: false, failure: { stage: 'proxy-load', detail: '碎块 ' + c.chunkId + ' convex 代理所有点共面（零体积）' } };
        }
      }
      shape = { type: 'convex', points: pts };
    } else if (c.proxy.shape.type === 'box') {
      shape = { type: 'box', halfExtents: [c.proxy.shape.halfExtents[0], c.proxy.shape.halfExtents[1], c.proxy.shape.halfExtents[2]] };
    } else if (c.proxy.shape.type === 'sphere') {
      shape = { type: 'sphere', radius: c.proxy.shape.radius };
    } else {
      // capsule：资产 halfHeight → 后端 height（全高）语义核对
      shape = { type: 'capsule', radius: c.proxy.shape.radius, height: c.proxy.shape.halfHeight * 2 };
    }

    // 来向/接触/seed 驱动初始运动：冲量方向 + 命中点偏离质心产生角运动 + 确定性抖动。
    const imp = event.impulse ?? [0, 1, 0];
    const jitter = 0.3;
    const lv: FractureVec3 = [
      imp[0] / c.proxy.mass + (rng() - 0.5) * jitter,
      imp[1] / c.proxy.mass + rng() * 0.5,
      imp[2] / c.proxy.mass + (rng() - 0.5) * jitter,
    ];
    const contact = event.contact ?? event.position;
    const offX = contact[0] - worldPos[0], offZ = contact[2] - worldPos[2];
    const av: FractureVec3 = [
      (rng() - 0.5) * 2 + offZ * imp[1],
      (rng() - 0.5) * 2,
      (rng() - 0.5) * 2 - offX * imp[1],
    ];

    chunks.push({
      chunkId: c.chunkId,
      cls: c.class,
      mesh: { path: c.mesh.path, guid: c.mesh.guid },
      position: worldPos,
      rotation: worldRot,
      scale: worldScale,
      shape,
      mass: c.proxy.mass,
      friction: c.proxy.friction,
      restitution: c.proxy.restitution,
      pivot: [c.pivot[0], c.pivot[1], c.pivot[2]],
      collisionGroup: c.proxy.collisionGroup,
      linearVelocity: lv,
      angularVelocity: av,
      // CCD 仅对确有穿透风险的快速块开启（资产声明速度上限才开，不无差别打开）。
      ...(((c.proxy.maxLinearSpeed !== undefined && c.proxy.maxLinearSpeed > 10)
        || (c.proxy.maxAngularSpeed !== undefined && c.proxy.maxAngularSpeed > 20)) ? { ccd: true } : {}),
      // R6：块级速度限制进入 chunk 输入（供 runtime 传给后端 per-body 限幅）。
      ...(c.proxy.maxLinearSpeed !== undefined ? { maxLinearSpeed: c.proxy.maxLinearSpeed } : {}),
      ...(c.proxy.maxAngularSpeed !== undefined ? { maxAngularSpeed: c.proxy.maxAngularSpeed } : {}),
    });
  }

  return {
    ok: true,
    activation: {
      event,
      chunks,
      priority: profile.playback.priority,
      lifetimeSec: profile.playback.lifetimeSec,
      fadeSec: profile.playback.fadeSec,
    },
  };
}
