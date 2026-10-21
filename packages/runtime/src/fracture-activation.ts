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
  type FractureAsset,
} from '@aether/scene';
import { parseGlb, VERTEX_FLOATS, type GltfResult, type MeshData } from '@aether/scene';
import { bakeSkinVertices, paletteForNamedPose, validateSkinMesh } from '@aether/render';
import type { FractureEvent, FractureVec3, FractureQuat } from './fracture';
import type { FractureActivation, FractureChunkInput } from './fracture-runtime';
import { changedJsonPaths } from './doc-diff';

/** 作者只修改物理/播放参数；当前磁盘只读身份不可被旧草稿覆盖。编辑侧共用此约束。 */
export function fractureAuthorDraft(value: unknown, baseline: FractureAsset): FractureAsset {
  const next=migrateFractureAsset(value);
  const allowed=/^(name|playback\.(priority|lifetimeSec|fadeSec)|chunks\[\d+\]\.(class|proxy\.(mass|friction|restitution|collisionGroup|maxLinearSpeed|maxAngularSpeed)))$/;
  const rejected=changedJsonPaths(baseline,next).find(change=>!allowed.test(change.path));
  if(rejected)throw new Error('离线配方的身份/来源/坐标/代理形状及未支持字段为只读：'+rejected.path+'；当前草稿已保留，请重载或合并当前磁盘版本');
  return next;
}

/** 资产读取端口（宿主注入；编辑器/Preview/Play 各自实现 fs/devfs/内存）。 */
export interface FractureAssetIO {
  /** 读 UTF-8 文本（profile/sidecar JSON）。 */
  readText(path: string): Promise<string>;
  /** 读二进制（离线 convex GLB 点集等）。 */
  readBinary(path: string): Promise<ArrayBuffer>;
}

/** 准入/准备失败诊断（不静默；调用方可保留作者草稿/原表现保底）。 */
export interface FractureAdmissionFailure {
  readonly stage: 'profile-read' | 'profile-validate' | 'sidecar-read' | 'sidecar-validate' | 'pose-missing' | 'pose-invalid'
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
  /** 作者未保存配方；磁盘源/sidecar仍先重新准入，草稿不能绕过隔离与身份。 */
  readonly draftProfile?: FractureAsset;
  /** 离线 convex 点集解析；仅在 profile 含 convex 代理时必需。 */
  readonly resolveConvexPoints?: ConvexPointsResolver;
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
  return buffer => convexPointsFromMesh(parseGlb(buffer, null, 'auto', { normalize: false }).mesh);
}

function convexPointsFromMesh(mesh: MeshData): Float32Array {
  const verts = mesh.vertices, stride = VERTEX_FLOATS;
  if (verts.length % stride !== 0) throw new Error('GLB 顶点缓冲长度 '+verts.length+' 不是顶点步长 '+stride+' 的整数倍');
  const count = verts.length / stride, out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    out[i*3] = verts[o]!; out[i*3+1] = verts[o+1]!; out[i*3+2] = verts[o+2]!;
  }
  return out;
}

/**
 * 核验引用二进制：实际GLB容器/解码内容、有限顶点/权重及合法索引，不以文件头代替内容。
 * 不做跨调用缓存：路径曾经可读不代表当前仍可用/仍是同一版本。
 */
async function checkRefBinary(
  io: FractureAssetIO,
  path: string,
  requireSkin = false,
): Promise<FractureAdmissionFailure | {buffer:ArrayBuffer;parsed:GltfResult}> {
  // 每次都读当前字节：路径曾经读成功过**不等于**当前资源仍可用/仍是同一版本。
  // （跨调用缓存曾让 Stop 后迟到的旧读取污染新代，并让已失效资源错误准入。）
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
  try {
    // 与正式渲染/烘焙使用同一解码器；合法文件头不能代替真实内容准入。
    const parsed = parseGlb(buf, null, 'auto', { normalize: false });
    const count = parsed.mesh.vertices.length / VERTEX_FLOATS;
    if (!Number.isInteger(count) || count < 1 || parsed.mesh.vertices.some(v=>!Number.isFinite(v)) || parsed.mesh.weights?.some(v=>!Number.isFinite(v))) {
      return { stage:'ref-binary', detail:'引用资产解码后含非有限或空几何（'+path+'）' };
    }
    if (parsed.mesh.indices.some(index=>index>=count)) {
      return { stage:'ref-binary', detail:'引用资产解码后索引越界（'+path+'）' };
    }
    if (requireSkin) {
      if (!parsed.skeleton || parsed.skeleton.jointNames.some(name=>!name)) throw new Error('NPC 引用缺少完整具名骨架');
      // 与paletteForNamedPose一致：最后一项是未蒙皮primitive的恒等关节。
      validateSkinMesh(parsed.mesh, parsed.skeleton.jointNames.length + 1);
    }
    return {buffer:buf,parsed};
  } catch(error) {
    return { stage:'ref-binary', detail:'引用资产 GLB 内容解码失败（'+path+'）：'+String(error) };
  }
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
  if (meta.userData?.status === 'quarantined') {
    return { stage: 'quarantined', detail: label + ' 当前 sidecar 被隔离（' + refPath + '）' };
  }
  return null;
}

/** 原prepare中与事件/姿态无关的支持条件；两种Apply与正式准备共用。 */
function checkStaticProfile(profile: FractureAsset): FractureAdmissionFailure | null {
  for (const c of profile.chunks) {
    // bind.rotation 同样必须是有限单位四元数（否则 bind 组合出来的世界姿态退化）。
    const br = c.bind.rotation;
    const brLen = Math.hypot(br[0], br[1], br[2], br[3]);
    if (!br.every((v) => Number.isFinite(v)) || Math.abs(brLen - 1) > 1e-3) {
      return {
        stage: 'transform',
        detail: '碎块 ' + c.chunkId + ' bind.rotation 不是有限单位四元数（|q|=' + brLen + '）',
      };
    }
    // R6：bind.scale 三轴也必须均匀（schema 允许非均匀，但物理代理标量尺度无法表示；明确拒绝）。
    const bs = c.bind.scale;
    if (!isUniformScale(bs)) {
      return { stage: 'transform', detail: '碎块 ' + c.chunkId + ' bind.scale 非均匀（' + bs.join(',') + '），不支持近似，请改用均匀尺度' };
    }
    if (profile.kind === 'npc') {
      // 当前 LBS 会改变代理的形状；只明确支持 posed AABB box，不拿 bind 代理冒充。
      if (c.proxy.shape.type !== 'box') {
        return { stage: 'proxy-load', detail: 'NPC 碎块 ' + c.chunkId + ' 当前姿态烘焙仅支持 box 代理，不支持 ' + c.proxy.shape.type };
      }
      // 正式 skin chunk 已与源 mesh 同空间；非单位 bind 不能被忽略或重复叠加。
      if (c.bind.position.some((v) => Math.abs(v) > 1e-6) || bs.some((v) => Math.abs(v - 1) > 1e-6)
        || br.slice(0, 3).some((v) => Math.abs(v) > 1e-6) || Math.abs(Math.abs(br[3]) - 1) > 1e-6) {
        return { stage: 'transform', detail: 'NPC 碎块 ' + c.chunkId + ' 的 skin 已在源模型空间，仅支持单位 bind' };
      }
    }
  }
  return null;
}

/** 原convex校验与唯一pivot中心化；复制resolver输出，避免重复准备污染其缓存。 */
function prepareConvexProxyPoints(input: unknown, pivot: FractureVec3): Float32Array {
  if (!(input instanceof Float32Array) || input.length < 9 || input.length % 3 !== 0) {
    throw new Error('convex 代理点数非法（需 ≥3 点且为 3 的倍数），实际 '+(input instanceof Float32Array?input.length:'非Float32Array'));
  }
  const pts = new Float32Array(input);
  // resolver给资产原始坐标；只在这里减一次pivot，原三维非退化公式/阈值保留。
  for (let i = 0; i < pts.length; i += 3) {
    pts[i] = pts[i]! - pivot[0]; pts[i+1] = pts[i+1]! - pivot[1]; pts[i+2] = pts[i+2]! - pivot[2];
  }
  let degenerate = false;
  for (let i = 0; i < pts.length; i++) { if (!Number.isFinite(pts[i])) { degenerate = true; break; } }
  if (degenerate) {
    throw new Error('convex 代理含非有限值');
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
      throw new Error('convex 代理所有点重合（零体积）');
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
      throw new Error('convex 代理所有点共线（零面积）');
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
      throw new Error('convex 代理所有点共面（零体积）');
    }
  }
  return pts;
}

/** 当前profile、草稿和全部引用准入。Apply/Preview/Play共用，不分配GPU/物理资源。 */
export async function admitFractureProfile(ref:{readonly path:string;readonly guid:string},io:FractureAssetIO,draftProfile?:FractureAsset,resolveConvexPoints?:ConvexPointsResolver):Promise<
  {readonly ok:true;readonly profile:FractureAsset;readonly binaries:Map<string,ArrayBuffer>|undefined;readonly convexPoints:Map<string,Float32Array>}|{readonly ok:false;readonly failure:FractureAdmissionFailure}> {
  let raw:unknown;
  try{raw=JSON.parse(await io.readText(ref.path));}
  catch(error){return {ok:false,failure:{stage:'profile-read',detail:'profile 读取失败：'+String(error)}};}
  const errors=validateFractureAsset(raw);
  if(errors.length)return {ok:false,failure:{stage:'profile-validate',detail:errors.join('；')}};
  let profile=migrateFractureAsset(raw);
  let meta:AssetMeta;
  try{meta=JSON.parse(await io.readText(ref.path+'.meta.json')) as AssetMeta;}
  catch(error){return {ok:false,failure:{stage:'sidecar-read',detail:'sidecar 读取失败：'+String(error)}};}
  const metaErrors=validateAssetMeta(meta);
  if(metaErrors.some(d=>d.severity==='error'))return {ok:false,failure:{stage:'sidecar-validate',detail:metaErrors.map(d=>d.message).join('；')}};
  if(meta.kind!=='fracture')return {ok:false,failure:{stage:'identity',detail:'sidecar kind='+meta.kind+'，应为 fracture'}};
  if(ref.guid!==profile.id||profile.id!==meta.guid)return {ok:false,failure:{stage:'identity',detail:'GUID 不一致：event='+ref.guid+' profile='+profile.id+' sidecar='+meta.guid}};
  if(profile.status!=='accepted'||meta.userData?.status==='quarantined')return {ok:false,failure:{stage:'quarantined',detail:ref.path+' 当前profile/sidecar被隔离'}};
  const diskProfile=profile;
  const draftErrors=draftProfile?validateFractureAsset(draftProfile):[];
  if(draftErrors.length)return {ok:false,failure:{stage:'profile-validate',detail:draftErrors.join('；')}};
  profile=draftProfile?migrateFractureAsset(draftProfile):diskProfile;
  if(profile.id!==diskProfile.id||profile.kind!==diskProfile.kind)return {ok:false,failure:{stage:'identity',detail:'草稿与当前磁盘的GUID/kind不一致'}};
  if(profile.status!=='accepted')return {ok:false,failure:{stage:'quarantined',detail:ref.path+' 草稿被隔离'}};
  if(draftProfile){
    try{profile=fractureAuthorDraft(profile,diskProfile);}
    catch(error){return {ok:false,failure:{stage:'profile-validate',detail:'当前磁盘配方与草稿不一致：'+String(error)}};}
  }
  // 6) R1：核验全部引用资产的 sidecar 身份（source.model + 每个 chunk.mesh + 每个 convex.mesh），
  //    证明引用指向正确资产而非仅格式合法。
  const srcFail = await checkRefMeta(io, profile.source.model.path, profile.source.model.guid, 'gltf', '源模型');
  if (srcFail) return { ok: false, failure: srcFail };
  for (const c of profile.chunks) {
    const mf = await checkRefMeta(io, c.mesh.path, c.mesh.guid, 'gltf', '碎块 ' + c.chunkId);
    if (mf) return { ok: false, failure: mf };
    if (c.proxy.shape.type === 'convex') {
      const cf = await checkRefMeta(io, c.proxy.shape.mesh.path, c.proxy.shape.mesh.guid, 'gltf', '碎块 ' + c.chunkId + ' 凸代理');
      if (cf) return { ok: false, failure: cf };
    }
  }
  // 6b) 引用资产的**二进制可用性**：sidecar 合法不代表文件读得到/是 GLB。
  //     source/chunk/独立convex均须存在且为GLB；不以合法sidecar替代实际文件。
  const refs = [profile.source.model.path, ...profile.chunks.map(c=>c.mesh.path), ...profile.chunks.flatMap(c=>c.proxy.shape.type==='convex'?[c.proxy.shape.mesh.path]:[])];
  // 仅本次准备持有原字节，NPC 随后解析同一份 chunk，不跨事件缓存/重读。
  const currentBinaries = profile.kind==='npc' ? new Map<string, ArrayBuffer>() : undefined;
  const skinRefs = profile.kind==='npc' ? new Set([profile.source.model.path,...profile.chunks.map(c=>c.mesh.path)]) : new Set<string>();
  const convexSources = new Map<string,{buffer:ArrayBuffer;parsed:GltfResult}>();
  const convexRefs = new Set(profile.chunks.flatMap(c=>c.proxy.shape.type==='convex'?[c.proxy.shape.mesh.path]:[]));
  for (const path of new Set(refs)) {
    const checked = await checkRefBinary(io, path, skinRefs.has(path));
    if ('stage' in checked) return {ok:false,failure:checked};
    currentBinaries?.set(path,checked.buffer);
    if (convexRefs.has(path)) convexSources.set(path,checked);
  }
  const staticFailure=checkStaticProfile(profile);
  if(staticFailure)return {ok:false,failure:staticFailure};
  const currentConvexPoints = new Map<string,Float32Array>();
  for (const c of profile.chunks) if(c.proxy.shape.type==='convex') {
    const path=c.proxy.shape.mesh.path, checked=convexSources.get(path)!;
    try {
      // 始终验当前GLB本身；自定义端口不能用替代点集救回坏资源。
      const raw=convexPointsFromMesh(checked.parsed.mesh);
      const validated=prepareConvexProxyPoints(raw,c.pivot);
      if (resolveConvexPoints) {
        const converted=resolveConvexPoints(checked.buffer);
        const same=converted instanceof Float32Array&&converted.length===raw.length&&converted.every((v,i)=>v===raw[i]);
        currentConvexPoints.set(c.chunkId,same?validated:prepareConvexProxyPoints(converted,c.pivot));
      } else currentConvexPoints.set(c.chunkId,validated);
    } catch(error) {
      return {ok:false,failure:{stage:'proxy-load',detail:'碎块 '+c.chunkId+' convex 代理解析/校验失败（'+path+'）：'+String(error)}};
    }
  }
  return {ok:true,profile,binaries:currentBinaries,convexPoints:currentConvexPoints};
}

/** 正式数据准备：当前资源准入后，按真实事件变换/姿态生成激活输入，不建body/租约。 */
export async function prepareFractureActivation(
  event: FractureEvent,
  opts: PrepareOptions,
): Promise<FracturePrepareResult> {
  const admitted=await admitFractureProfile(event.profile,opts.io,opts.draftProfile,opts.resolveConvexPoints);
  if(!admitted.ok)return admitted;
  const {profile,binaries:currentBinaries,convexPoints:currentConvexPoints}=admitted;
  const wantNpc=profile.kind==='npc';
  if(wantNpc!==(event.target.kind==='npc'))return {ok:false,failure:{stage:'target-kind',detail:'profile kind='+profile.kind+' 与事件目标 kind='+event.target.kind+' 不匹配'}};

  // 6c) 事件旋转必须是有限单位四元数：零/非单位四元数会让刚体姿态退化，
  //     必须在分配 body/租约前拒绝（与尺度校验同一层）。
  const er = event.rotation;
  const erLen = Math.hypot(er[0], er[1], er[2], er[3]);
  if (!er.every((v) => Number.isFinite(v)) || Math.abs(erLen - 1) > 1e-3) {
    return {
      ok: false,
      failure: {
        stage: 'transform',
        detail: '事件旋转不是有限单位四元数（|q|=' + erLen + '，q=' + er.join(',') + '）',
      },
    };
  }

  // 7) R6：事件世界尺度必须均匀（非均匀组合不平均近似，明确拒绝）。
  const ws = event.scale;
  if (!event.position.every(Number.isFinite) || !ws.every((v) => Number.isFinite(v) && v > 0) || !isUniformScale(ws)) {
    return { ok: false, failure: { stage: 'transform', detail: '事件世界尺度非均匀（' + ws.join(',') + '），不支持近似，请改用均匀尺度' } };
  }
  if (wantNpc && (!event.npcPose || !event.npcNormalization)) {
    return { ok: false, failure: { stage: 'pose-missing', detail: 'NPC 事件缺少完整 npcPose 或源 actor 的 npcNormalization' } };
  }
  const rng = makeRng(event.seed);
  const chunks: FractureChunkInput[] = [];
  for (const c of profile.chunks) {
    let bakedVertices: Float32Array<ArrayBuffer> | undefined;
    let posedHalfExtents: FractureVec3 | undefined;
    let pivot: FractureVec3 = [c.pivot[0], c.pivot[1], c.pivot[2]];
    let modelCenter: FractureVec3;
    let worldRot: FractureQuat;
    let worldScale: number;
    if (wantNpc) {
      let parsed: ReturnType<typeof parseGlb>;
      try {
        parsed = parseGlb(currentBinaries!.get(c.mesh.path)!, null, 'auto', { normalize: false });
      } catch (e) {
        return { ok: false, failure: { stage: 'ref-binary', detail: 'NPC 碎块 ' + c.chunkId + ' GLB 解析失败：' + String(e) } };
      }
      const sk = parsed.skeleton;
      if (!sk || sk.jointNames.length !== sk.joints.length || !parsed.mesh.joints || !parsed.mesh.weights) {
        return { ok: false, failure: { stage: 'pose-missing', detail: 'NPC 碎块 ' + c.chunkId + ' 缺少完整 skeleton/JOINTS/WEIGHTS' } };
      }
      for (let j = 0; j < sk.joints.length; j++) {
        const name = sk.jointNames[j];
        const matrix = name ? event.npcPose![name] : undefined;
        if (!matrix) {
          return { ok: false, failure: { stage: 'pose-missing', detail: 'NPC 碎块 ' + c.chunkId + ' npcPose 缺少关节 ' + String(name) } };
        }
        if (matrix.length !== 16) {
          return { ok: false, failure: { stage: 'pose-invalid', detail: 'NPC 关节 ' + name + ' 矩阵长度 ' + matrix.length + ' 不为 16' } };
        }
      }
      // parseGlb 为未蒙皮 primitive 使用末尾恒等关节，与正常渲染一致。
      const palette = paletteForNamedPose(sk.jointNames,event.npcPose!);
      try {
        bakedVertices = bakeSkinVertices(parsed.mesh, palette, event.npcNormalization!);
      } catch (e) {
        return { ok: false, failure: { stage: 'pose-invalid', detail: 'NPC 碎块 ' + c.chunkId + ' 蒙皮烘焙失败：' + String(e) } };
      }
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let v = 0; v < bakedVertices.length; v += VERTEX_FLOATS) {
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis]!, bakedVertices[v + axis]!);
          max[axis] = Math.max(max[axis]!, bakedVertices[v + axis]!);
        }
      }
      pivot = [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2];
      posedHalfExtents = [(max[0]! - min[0]!) / 2, (max[1]! - min[1]!) / 2, (max[2]! - min[2]!) / 2];
      if (!posedHalfExtents.every((v) => Number.isFinite(v) && v > 0)) {
        return { ok: false, failure: { stage: 'pose-invalid', detail: 'NPC 碎块 ' + c.chunkId + ' posed bounds 退化，不能生成 box 代理' } };
      }
      modelCenter = pivot;
      worldRot = event.rotation;
      worldScale = ws[0];
    } else {
      // WU06 物体唯一变换链（assemblyScale 已含在事件世界变换，不二次乘）：
      // bind 局部：质心 = bindT + bindR * (bindS * pivot)
      // 世界：质心 = eventT + eventR * (bindT + bindR * (bindS * pivot)) * eventS
      const pivotScaled: FractureVec3 = [
        c.bind.scale[0] * c.pivot[0],
        c.bind.scale[1] * c.pivot[1],
        c.bind.scale[2] * c.pivot[2],
      ];
      const bindLocal = rotateByQuat(pivotScaled, c.bind.rotation);
      const bindModel: FractureVec3 = [
        c.bind.position[0] + bindLocal[0],
        c.bind.position[1] + bindLocal[1],
        c.bind.position[2] + bindLocal[2],
      ];
      modelCenter = bindModel;
      worldRot = quatMul(event.rotation, c.bind.rotation);
      worldScale = c.bind.scale[0] * ws[0];
    }
    const worldOffset = rotateByQuat(modelCenter, event.rotation);
    const worldPos: FractureVec3 = [
      event.position[0] + worldOffset[0] * ws[0],
      event.position[1] + worldOffset[1] * ws[1],
      event.position[2] + worldOffset[2] * ws[2],
    ];
    let shape: FractureChunkInput['shape'];
    if (posedHalfExtents) {
      shape = { type: 'box', halfExtents: posedHalfExtents };
    } else if (c.proxy.shape.type === 'convex') {
      if (!opts.resolveConvexPoints) {
        return { ok: false, failure: { stage: 'proxy-load', detail: '碎块 ' + c.chunkId + ' 需离线 convex 代理但未提供 resolveConvexPoints' } };
      }
      const pts = currentConvexPoints.get(c.chunkId);
      if (!pts) return {ok:false,failure:{stage:'proxy-load',detail:'碎块 '+c.chunkId+' 缺少当次已验convex代理'}};
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
    // 来向：事件带 impulse 时以其方向为主；没有 impulse 时必须由 normal 决定方向
    // （否则 normal 成了纯装饰输入，反转来向得到完全相同的初速度）。
    const nrm = event.normal;
    const nLen = nrm === null ? 0 : Math.hypot(nrm[0], nrm[1], nrm[2]);
    const imp = event.impulse ?? (nrm !== null && nLen > 1e-6 ? [nrm[0], nrm[1], nrm[2]] : [0, 1, 0]);
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
      pivot,
      ...(bakedVertices ? { bakedVertices } : {}),
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
