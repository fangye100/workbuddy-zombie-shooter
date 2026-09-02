"""
把游戏用 GLB 转成 Aether Shader Lab 的顶点格式（.labmesh）。

Shader Lab 的顶点布局（apps/lab/shader-lab/src/gpu/geometry.ts）：
    stride 60 B / 15 floats
    0-2  position
    3-5  normal          着色法线
    6-8  smoothNormal    按位置焊接后平均的法线，只给 inverted hull 描边外扩用
    9-10 uv
    11   color.r  描边宽度倍率
    12   color.g  烘焙 AO（着色器里 mix(1.0, g, 0.85)）
    13   color.b  未用
    14   color.a  未用

产物是裸二进制，配一个 16 B 头，前端 fetch 后两次 typed-array view 就能用，
不带任何第三方依赖，也不需要 glTF 解析库。

用法：
    python export_labmesh.py --glb <in.glb> --out <out.labmesh> [--height 2.05]
                             [--zup] [--ao-rays 96] [--silhouette <png>]
                             [--ts <out.mesh.ts>]

默认按 Z-up 输入处理（混元 OBJ/GLB 是 Z-up），转成 Y-up、脚底贴地、缩放到指定身高。
"""

import argparse
import base64
import importlib.util
import json
import os
import struct
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_MGR = os.path.join(_HERE, "make_game_ready.py")


def _load_parser():
    spec = importlib.util.spec_from_file_location("_mgr", _MGR)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_mgr"] = mod
    spec.loader.exec_module(mod)
    return mod.parse_glb


parse_glb = _load_parser()

MAGIC = b"LABM"
VERSION = 1
HEADER = struct.Struct("<4sIII")  # magic, version, vertexCount, indexCount
STRIDE_FLOATS = 15


# --------------------------------------------------------------------------
# 法线
# --------------------------------------------------------------------------

def compute_normals(verts: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """面积加权的逐顶点法线。"""
    a = verts[faces[:, 0]]
    b = verts[faces[:, 1]]
    c = verts[faces[:, 2]]
    fn = np.cross(b - a, c - a)  # 未归一化，长度 = 2 * 面积，天然按面积加权
    n = np.zeros_like(verts)
    for k in range(3):
        np.add.at(n, faces[:, k], fn)
    lens = np.linalg.norm(n, axis=1)
    lens[lens < 1e-12] = 1.0
    return n / lens[:, None]


def compute_smooth_normals(verts: np.ndarray, normals: np.ndarray, prec: int = 10000) -> np.ndarray:
    """
    按位置焊接后平均的法线 —— 描边专用。

    硬边几何（盾板棱角）的着色法线在棱角处不连续，直接外扩会让描边裂开，
    所以位置相同的顶点共享一份平均法线。与 geometry.ts 的 MeshBuilder.build() 同算法
    （含同样的 1e-8 退化回退），保证程序化几何和导入几何行为一致。
    """
    key = np.round(verts * prec).astype(np.int64)
    # 用字典分组；1635 个顶点的量级，Python 循环完全够快
    groups: dict[tuple[int, int, int], list[int]] = {}
    for i, k in enumerate(key):
        groups.setdefault((int(k[0]), int(k[1]), int(k[2])), []).append(i)

    out = np.empty_like(normals)
    for idxs in groups.values():
        acc = normals[idxs].sum(axis=0)
        ln = float(np.linalg.norm(acc))
        if ln < 1e-8:
            acc = np.array([0.0, 1.0, 0.0])
        else:
            acc = acc / ln
        out[idxs] = acc
    return out


# --------------------------------------------------------------------------
# 烘焙 AO
# --------------------------------------------------------------------------

def bake_ao(verts: np.ndarray, faces: np.ndarray, normals: np.ndarray,
            rays: int = 128, max_dist: float | None = None, seed: int = 7) -> np.ndarray:
    """
    逐顶点 AO：用 pymeshlab 的 compute_scalar_ambient_occlusion。

    为什么不用自写射线求交：
    - pymeshlab 直接给 8-bit 量化值，0.01 秒出结果；自写 numpy 射线版
      1635 verts × 128 rays × 1599 tris 在 float32 下要 10+ 秒，且边界精度
      不一定更好。
    - pymeshlab 的 AO 是 VCGLib 的标准实现（半球射线 + 距离衰减 + 自交避让），
      跟 Maya / Blender / Substance 同款算法，对美术工具有锚定意义。
    """
    try:
        import pymeshlab
    except Exception as exc:  # pragma: no cover
        print(f"[warn] pymeshlab 不可用（{exc}），退回高度渐变假 AO", file=sys.stderr)
        h = verts[:, 1]
        t = (h - h.min()) / max(1e-5, h.max() - h.min())
        return 0.55 + 0.45 * np.clip(t, 0, 1)

    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(
        vertex_matrix=verts.astype(np.float64),
        face_matrix=faces.astype(np.int64),
    ))
    ms.compute_scalar_ambient_occlusion(rays=rays)

    packed = ms.current_mesh().vertex_color_array()
    if packed is None or packed.size != verts.shape[0]:
        print("[warn] pymeshlab 没返回顶点色，退回高度渐变", file=sys.stderr)
        h = verts[:, 1]
        t = (h - h.min()) / max(1e-5, h.max() - h.min())
        return 0.55 + 0.45 * np.clip(t, 0, 1)

    # VCGLib 打包：uint32 LE = R | G<<8 | B<<16 | A<<24
    rgba = packed.view(np.uint8).reshape(-1, 4).astype(np.float32) / 255.0
    # AO 写成 R=G=B 的灰度，取 R；值 1=敞开、0=遮蔽，与 Shader Lab 的 mix(1, ao, 0.85) 直接对齐
    ao = np.clip(rgba[:, 0], 0.0, 1.0)
    return ao


# --------------------------------------------------------------------------
# 几何整理
# --------------------------------------------------------------------------

def to_y_up(verts: np.ndarray, flip: bool = False) -> np.ndarray:
    """
    Z-up → Y-up。

    混元产物实测脚在 z-max（E-04 baked glb：底端切片宽 0.111m 是头、
    顶端有 0.057m² 朝 +Z 的脚底平面），所以默认走 new_y = -old_z 才正立。
    两个分支都是 det=+1 的纯旋转，绕序不变：
      默认  (x, -z, y)   矩阵 [[1,0,0],[0,0,-1],[0,1,0]]
      --up-flip (x,  z,-y) 矩阵 [[1,0,0],[0,0,1],[0,-1,0]]  —— 极性相反的模型用
    """
    out = np.empty_like(verts)
    out[:, 0] = verts[:, 0]
    if flip:
        out[:, 1] = verts[:, 2]
        out[:, 2] = -verts[:, 1]
    else:
        out[:, 1] = -verts[:, 2]
        out[:, 2] = verts[:, 1]
    return out


def fix_winding(verts: np.ndarray, faces: np.ndarray, smooth: np.ndarray) -> np.ndarray:
    """
    把三角形绕序校正为 CCW（与 geometry.ts 的 build() 同判据）。

    渲染管线是 cullMode:'back' + frontFace:'ccw'，描边是 cullMode:'front'。
    绕序反了主表面整片消失、只剩描边，很容易误判成「模型没加载进来」。
    """
    faces = faces.copy()
    a = verts[faces[:, 0]]
    b = verts[faces[:, 1]]
    c = verts[faces[:, 2]]
    fn = np.cross(b - a, c - a)
    vn = smooth[faces[:, 0]] + smooth[faces[:, 1]] + smooth[faces[:, 2]]
    dot = np.einsum("ij,ij->i", fn, vn)
    flip = dot < 0
    if flip.any():
        faces[flip] = faces[flip][:, [0, 2, 1]]
    return faces


# --------------------------------------------------------------------------
# 输出
# --------------------------------------------------------------------------

def write_labmesh(path: str, vertices: np.ndarray, indices: np.ndarray) -> None:
    with open(path, "wb") as fh:
        fh.write(HEADER.pack(MAGIC, VERSION, vertices.shape[0] // STRIDE_FLOATS, indices.shape[0]))
        fh.write(vertices.astype("<f4").tobytes())
        fh.write(indices.astype("<u4").tobytes())


def write_ts_module(path: str, name: str, vertices: np.ndarray, indices: np.ndarray,
                    meta: dict) -> None:
    """
    导出一个零依赖的 TS 模块（base64 内联）。

    存在意义：LabRenderer 的构造函数是同步的，加 fetch 会把它整个改成异步。
    直接 import 一个模块可以不动渲染器结构 —— 想快速看到效果时用这个。
    """
    vb64 = base64.b64encode(vertices.astype("<f4").tobytes()).decode("ascii")
    ib64 = base64.b64encode(indices.astype("<u4").tobytes()).decode("ascii")

    def chunk(s: str, width: int = 100) -> str:
        return "\n".join("  '%s'," % s[i:i + width] for i in range(0, len(s), width))

    body = f"""/* 自动生成，勿手改。源：export_labmesh.py */
import type {{ MeshData }} from './gpu/geometry';

export const {name}_META = {json.dumps(meta, ensure_ascii=False, indent=2)};

const VERT_B64 = [
{chunk(vb64)}
].join('');

const INDEX_B64 = [
{chunk(ib64)}
].join('');

function fromBase64(b64: string): ArrayBuffer {{
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}}

/** {meta.get('label', name)} —— {meta.get('triangles', 0)} 三角面 */
export function create{name}(): MeshData {{
  return {{
    vertices: new Float32Array(fromBase64(VERT_B64)),
    indices: new Uint32Array(fromBase64(INDEX_B64)),
  }};
}}
"""
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(body)


def dump_silhouette(path: str, verts: np.ndarray, faces: np.ndarray) -> None:
    """正交侧影，用来肉眼确认朝向 / 站姿 / 是不是人形。"""
    from PIL import Image, ImageDraw

    W, H = 260, 420
    lo = verts.min(0)
    hi = verts.max(0)
    span = np.maximum(1e-6, hi - lo)
    s = min((W - 20) / span[0], (H - 20) / span[1])
    ox = (W - span[0] * s) / 2
    oy = (H - span[1] * s) / 2

    img = Image.new("RGB", (W, H), (24, 20, 28))
    dr = ImageDraw.Draw(img)
    for f in faces:
        pts = []
        for k in range(3):
            x = (verts[f[k], 0] - lo[0]) * s + ox
            y = H - ((verts[f[k], 1] - lo[1]) * s + oy)
            pts.append((x, y))
        dr.polygon(pts, fill=(143, 209, 79))
    img.save(path)


# --------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--glb", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--height", type=float, default=2.05, help="目标身高（米）")
    ap.add_argument("--height-raw", type=float, default=None,
                    help="用指定原始身高算缩放（源模的 raw bbox 高），不用低模自己的 bbox。"
                         "同一角色的所有 LOD 传同一个值，保证 LOD 间比例一致"
                         "（QECS 会把 bbox 撑大 2-7%%，按各自 bbox 缩放会让 LOD 间比例漂移）")
    ap.add_argument("--zup", action="store_true", default=True)
    ap.add_argument("--no-zup", dest="zup", action="store_false")
    ap.add_argument("--up-flip", action="store_true",
                    help="Z-up 极性翻转：默认假设脚在 z-max（混元实测），脚在 z-min 的模型加这个")
    ap.add_argument("--ao-rays", type=int, default=96)
    ap.add_argument("--no-ao", action="store_true", help="跳过 AO 烘焙（快）")
    ap.add_argument("--outline", type=float, default=1.0, help="color.r 描边倍率")
    ap.add_argument("--silhouette", default=None)
    ap.add_argument("--ts", default=None)
    ap.add_argument("--ts-name", default="E04")
    ap.add_argument("--label", default="E-04 盾卫")
    args = ap.parse_args()

    verts, faces, uv, _ = parse_glb(args.glb)
    print(f"[in ] {os.path.basename(args.glb)}  verts={verts.shape[0]} tris={faces.shape[0]}")

    if args.zup:
        verts = to_y_up(verts, flip=args.up_flip)
        print(f"[axis] Z-up → Y-up (flip={args.up_flip})")

    # 居中 X/Z，脚底贴 y=0，统一缩放
    c = (verts.min(0) + verts.max(0)) / 2.0
    verts[:, 0] -= c[0]
    verts[:, 2] -= c[2]
    verts[:, 1] -= verts[:, 1].min()
    h = float(verts[:, 1].max())
    if h > 1e-6:
        # --height-raw：用源模的 raw 身高定缩放（同角色所有 LOD 一把尺子），
        # 平移仍按低模自己的脚底/中心（平移不影响比例）
        h_for_scale = args.height_raw if args.height_raw else h
        verts *= args.height / h_for_scale
    print(f"[norm] 身高 {h:.3f} → {args.height:.2f} m"
          + (f"（按源模 raw {args.height_raw:.3f} 定缩放）" if args.height_raw else "")
          + "，脚底 y=0，X/Z 居中")

    normals = compute_normals(verts, faces)
    smooth = compute_smooth_normals(verts, normals)
    faces = fix_winding(verts, faces, smooth)

    flipped = int((np.einsum("ij,ij->i",
                             np.cross(verts[faces[:, 1]] - verts[faces[:, 0]],
                                      verts[faces[:, 2]] - verts[faces[:, 0]]),
                             smooth[faces[:, 0]] + smooth[faces[:, 1]] + smooth[faces[:, 2]]) < 0).sum())
    print(f"[wind] CCW 校正后仍有 {flipped} 个反向面（应为 0）")

    if args.no_ao:
        ao = np.ones(verts.shape[0])
    else:
        ao = bake_ao(verts, faces, smooth, rays=args.ao_rays)
        print(f"[ao  ] min={ao.min():.3f} mean={ao.mean():.3f} max={ao.max():.3f}")

    if uv is None:
        uv = np.zeros((verts.shape[0], 2), dtype=np.float64)

    n = verts.shape[0]
    out = np.zeros(n * STRIDE_FLOATS, dtype=np.float32)
    out[0::STRIDE_FLOATS] = verts[:, 0]
    out[1::STRIDE_FLOATS] = verts[:, 1]
    out[2::STRIDE_FLOATS] = verts[:, 2]
    out[3::STRIDE_FLOATS] = normals[:, 0]
    out[4::STRIDE_FLOATS] = normals[:, 1]
    out[5::STRIDE_FLOATS] = normals[:, 2]
    out[6::STRIDE_FLOATS] = smooth[:, 0]
    out[7::STRIDE_FLOATS] = smooth[:, 1]
    out[8::STRIDE_FLOATS] = smooth[:, 2]
    out[9::STRIDE_FLOATS] = uv[:, 0]
    out[10::STRIDE_FLOATS] = uv[:, 1]
    out[11::STRIDE_FLOATS] = args.outline
    out[12::STRIDE_FLOATS] = ao
    out[13::STRIDE_FLOATS] = 0
    out[14::STRIDE_FLOATS] = 0

    indices = faces.astype(np.uint32).ravel()

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    write_labmesh(args.out, out, indices)
    size = os.path.getsize(args.out)
    print(f"[out ] {args.out}  {size/1024:.1f} KB  verts={n} tris={indices.shape[0]//3}")

    meta = {
        "label": args.label,
        "source": os.path.basename(args.glb),
        "vertices": int(n),
        "triangles": int(indices.shape[0] // 3),
        # 真实高度：--height-raw 下各 LOD 不再都被压到 args.height（而是共用一把尺子，
        # 高度随各自 raw bbox 浮动），这里记实际缩放后的 bbox 高，HUD 才不会显示假数字。
        "heightMeters": round(float(verts[:, 1].max()), 3),
        "upAxis": "y",
        "feetAtOrigin": True,
        "facing": "-Z",
        "bbox": [round(float(x), 4) for x in verts.min(0).tolist() + verts.max(0).tolist()],
        "strideFloats": STRIDE_FLOATS,
        "aoMin": round(float(ao.min()), 3),
        "aoMean": round(float(ao.mean()), 3),
    }

    if args.ts:
        write_ts_module(args.ts, args.ts_name, out, indices, meta)
        print(f"[out ] {args.ts}  {os.path.getsize(args.ts)/1024:.1f} KB")

    if args.silhouette:
        dump_silhouette(args.silhouette, verts, faces)
        print(f"[out ] {args.silhouette}")

    meta_path = os.path.splitext(args.out)[0] + ".json"
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)
    print(f"[out ] {meta_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
