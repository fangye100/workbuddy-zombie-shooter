"""低模 OBJ 的俯视+侧视快速预览渲染（纯 numpy 光栅，出 PNG 拼图）。"""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "..", "models")


def render(verts, faces, W=260, H=260):
    """正交投影 + 每三角形深度排序 + 顶点色平涂。"""
    img = np.full((H, W, 3), 0.12, dtype=np.float64)  # 深灰底
    # 简单平行光
    light = np.array([0.4, 0.8, 0.45]); light /= np.linalg.norm(light)

    def draw(proj, ax1, ax2, depth_ax, flip2=False):
        a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
        n = np.cross(b - a, c - a)
        n /= (np.linalg.norm(n, axis=1, keepdims=True) + 1e-12)
        # 面色：顶点色均值 × 兰伯特
        tri_c = colors[faces].mean(axis=1)
        lam = np.clip(n @ light, 0, 1) * 0.75 + 0.25
        shade = tri_c * lam[:, None]
        depth = verts[faces].mean(axis=1)[:, depth_ax]
        order = np.argsort(depth)
        xs = verts[:, ax1]; ys = verts[:, ax2]
        span_x = xs.max() - xs.min(); span_y = ys.max() - ys.min()
        s = min((W - 20) / max(span_x, 1e-9), (H - 20) / max(span_y, 1e-9))
        px = (xs - xs.min()) * s + (W - span_x * s) / 2
        py = (ys.max() - ys) * s + (H - span_y * s) / 2
        for i in order:
            x0, y0 = px[faces[i, 0]], py[faces[i, 0]]
            x1, y1 = px[faces[i, 1]], py[faces[i, 1]]
            x2, y2 = px[faces[i, 2]], py[faces[i, 2]]
            col = shade[i]
            # 重心填充（小三角形足够）
            steps = max(int(max(abs(x1 - x0) + abs(x2 - x0), abs(y1 - y0) + abs(y2 - y0)) * 2) + 1, 4)
            for u in range(steps + 1):
                for v in range(steps + 1 - u):
                    w_ = steps - u - v
                    fx = (x0 * u + x1 * v + x2 * w_) / steps
                    fy = (y0 * u + y1 * v + y2 * w_) / steps
                    ix, iy = int(fx), int(fy)
                    if 0 <= ix < W and 0 <= iy < H:
                        img[iy, ix] = col

    draw(verts[:, [0, 1]], 0, 1, 2)  # 先画侧视（XY）作底
    return img


def load_obj(path):
    vs, fs_, cs = [], [], []
    with open(path) as f:
        for line in f:
            p = line.split()
            if p[0] == "v":
                vs.append([float(x) for x in p[1:4]])
                cs.append([float(x) for x in p[4:7]] if len(p) >= 7 else [0.6, 0.6, 0.6])
            elif p[0] == "f":
                fs_.append([int(x.split("/")[0]) - 1 for x in p[1:4]])
    return np.array(vs), np.array(fs_), np.array(cs)


try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

ids = sys.argv[1:] or [d for d in os.listdir(MODELS) if os.path.exists(os.path.join(MODELS, d, f"{d}_low.obj"))]
cols = 5
rows = (len(ids) + cols - 1) // cols
sheet = np.full((rows * 260 + (rows + 1) * 8, cols * 260 + (cols + 1) * 8, 3), 0.06)
for k, eid in enumerate(ids):
    obj = os.path.join(MODELS, eid, f"{eid}_low.obj")
    if not os.path.exists(obj):
        continue
    vs, fs_, cs = load_obj(obj)
    globals()["colors"] = cs
    img = render(vs, fs_)
    r, c = divmod(k, cols)
    y0 = 8 + r * 268; x0 = 8 + c * 268
    sheet[y0:y0 + 260, x0:x0 + 260] = img
    print(f"{eid}: {len(fs_)} 面")

if HAS_PIL:
    Image.fromarray((np.clip(sheet, 0, 1) * 255).astype(np.uint8)).save(os.path.join(HERE, "..", "models", "_preview_top.png"))
    print("预览已存 models/_preview_top.png")
else:
    print("(无 PIL，跳过拼图输出)")
