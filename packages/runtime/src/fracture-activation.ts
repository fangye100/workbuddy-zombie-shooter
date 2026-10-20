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
import type { FractureEvent, FractureVec3 } from './fracture';
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
    | 'identity' | 'quarantined' | 'proxy-load';
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

/** 四元数 ⊗ 向量旋转。 */
function rotateByQuat(v: FractureVec3, q: readonly [number, number, number, number]): FractureVec3 {
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
  // 5) 隔离：quarantined 在分配前拒绝（恢复 accepted 后下一次播放可重新准入）。
  if (profile.status !== 'accepted') {
    return { ok: false, failure: { stage: 'quarantined', detail: 'profile 状态 ' + profile.status + '，未验收' } };
  }

  // 6) 唯一变换链：资产 bind/pivot（assemblyScale 已含资产局部→米）→ 事件世界变换。
  const rng = makeRng(event.seed);
  const chunks: FractureChunkInput[] = [];
  for (const c of profile.chunks) {
    const bindLocal: FractureVec3 = [
      (c.bind.position[0] + c.pivot[0]) * profile.assemblyScale,
      (c.bind.position[1] + c.pivot[1]) * profile.assemblyScale,
      (c.bind.position[2] + c.pivot[2]) * profile.assemblyScale,
    ];
    const rotated = rotateByQuat(bindLocal, event.rotation);
    const ws = event.scale;
    const worldPos: FractureVec3 = [
      event.position[0] + rotated[0] * ws[0],
      event.position[1] + rotated[1] * ws[1],
      event.position[2] + rotated[2] * ws[2],
    ];
    const uniformScale = profile.assemblyScale * ((ws[0] + ws[1] + ws[2]) / 3);

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
      shape = { type: 'convex', points: opts.resolveConvexPoints(buf) };
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
      position: worldPos,
      rotation: [event.rotation[0], event.rotation[1], event.rotation[2], event.rotation[3]],
      scale: uniformScale,
      shape,
      mass: c.proxy.mass,
      friction: c.proxy.friction,
      restitution: c.proxy.restitution,
      linearVelocity: lv,
      angularVelocity: av,
      ...(c.proxy.maxLinearSpeed !== undefined || c.proxy.maxAngularSpeed !== undefined ? { ccd: true } : {}),
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
