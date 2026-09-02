"""E-04 对齐校验：高模 glb 与低模的最近点距离。

用法:
    python verify_alignment.py <高模.glb> <低模.labmesh | 低模.glb>

两种模式:
  - 低模是 .labmesh: 已按导出时自己的 bbox 归一化，脚本只归一化高模。
    注意: 若低模 raw bbox 与高模不同（QECS 会撑大 2-7%），结果会混入归一化失配。
  - 低模是 .glb: 同一把尺子模式 —— 高模归一化参数（轴变换/居中/脚底/缩放）
    原样作用于低模，测出的是纯减面表面偏差，无归一化污染。

基线数字（2026-09-01, E-04 高模 80k）:
  - 簇减面 1600 labmesh（导出时 raw 身高≈源模，失配可忽略）: median 0.0137 m / max 0.0449 m
  - QECS uv1600 glb 同尺子: 见运行输出（QECS 顶点落在二次误差最优点，会偏离原顶点但应贴着原表面）
"""
import numpy as np, trimesh, sys, struct, os
from collections import defaultdict

HP = sys.argv[1]; LP = sys.argv[2]

def load_labmesh(path):
    with open(path,'rb') as f: data=f.read()
    magic,ver,vc,ic = struct.unpack('<4sIII', data[:16])
    verts = np.frombuffer(data[16:16+vc*15*4], dtype='<f4').reshape(vc,15)
    idx = np.frombuffer(data[16+vc*15*4:16+vc*15*4+ic*4], dtype='<u4').reshape(-1,3)
    return verts[:,0:3].astype(float), verts[:,9:11].astype(float), idx

def load_glm_mesh(path):
    s = trimesh.load(path)
    if hasattr(s,'geometry'):
        s = trimesh.util.concatenate([g for g in s.geometry.values() if hasattr(g,'vertices')])
    return np.asarray(s.vertices, float), np.asarray(s.faces)

hp = trimesh.load(HP)
if hasattr(hp,'geometry'):  # Scene
    geoms=list(hp.geometry.values())
    hp = trimesh.util.concatenate([g for g in geoms if hasattr(g,'vertices')])
V = np.asarray(hp.vertices, float).copy()
F = np.asarray(hp.faces)
yspan=V[:,1].max()-V[:,1].min(); zspan=V[:,2].max()-V[:,2].min()
if zspan > yspan*1.5:
    o=np.empty_like(V); o[:,0]=V[:,0]; o[:,1]=-V[:,2]; o[:,2]=V[:,1]; V=o
c=((V.min(0)+V.max(0))/2.0); V[:,0]-=c[0]; V[:,2]-=c[2]; V[:,1]-=V[:,1].min()
h=V[:,1].max(); s=2.05/max(h,1e-6); V*=s

lp_is_glb = os.path.splitext(LP)[1].lower() == '.glb'
if lp_is_glb:
    lp_v, lp_f = load_glm_mesh(LP)
    if zspan > yspan*1.5:
        o=np.empty_like(lp_v); o[:,0]=lp_v[:,0]; o[:,1]=-lp_v[:,2]; o[:,2]=lp_v[:,1]; lp_v=o
    lc=((lp_v.min(0)+lp_v.max(0))/2.0)
    lp_v[:,0]-=lc[0]; lp_v[:,2]-=lc[2]; lp_v[:,1]-=lp_v[:,1].min()
    lp_v*=s  # 只统一缩放尺子；平移（居中/脚底）按低模自己的，与导出管线一致
    pos_lp, uv_lp, idx_lp = lp_v, None, lp_f
    print("[mode] 同一把尺子：轴变换同高模，缩放用高模尺子，平移按低模自己（纯减面偏差）")
else:
    pos_lp, uv_lp, idx_lp = load_labmesh(LP)

print("low-poly verts/tris:", pos_lp.shape[0], idx_lp.shape[0])
print("high-poly verts/tris:", V.shape[0], F.shape[0])

cell=0.05
keys=(np.floor(V/cell)).astype(int)
grid=defaultdict(list)
for i,k in enumerate(keys): grid[tuple(k)].append(i)
def nearest(p):
    ki=np.floor(p/cell).astype(int); best=-1; bd=1e9
    for r in range(0,6):
        for dx in range(-r,r+1):
            for dy in range(-r,r+1):
                for dz in range(-r,r+1):
                    if max(abs(dx),abs(dy),abs(dz))!=r: continue
                    b=grid.get((ki[0]+dx,ki[1]+dy,ki[2]+dz))
                    if not b: continue
                    for i in b:
                        d=np.sum((V[i]-p)**2)
                        if d<bd: bd=d; best=i
        if best>=0 and r>=1: break
    return best, bd
dists=np.array([nearest(p)[1]**0.5 for p in pos_lp])
print("align nearest-dist median/max (m):", round(float(np.median(dists)),4), round(float(dists.max()),4))
print("frac<0.05m:", round(float((dists<0.05).mean()),3), " frac<0.1m:", round(float((dists<0.1).mean()),3))

try:
    mat=hp.visual.material
    tex=getattr(mat,'baseColorTexture',None)
    img=getattr(tex,'image',None)
    print("baseColor image:", None if img is None else (img.size, img.mode))
except Exception as e:
    print("texture probe err:", repr(e))
