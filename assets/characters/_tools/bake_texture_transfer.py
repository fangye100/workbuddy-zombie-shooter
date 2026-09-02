# -*- coding: utf-8 -*-
"""
把 80k 高模的 18MB 详细 baseColor 贴图，投影/转移到 1600 低模的 xatlas UV 上，
产出编辑器能直接用的「有细节」的 e04_baseColor.png（替代原来逐面平涂的 134KB 版本）。

方法（无法肉眼校验，全靠数据兜底）：
  1. 从高模 glb 里按 material->baseColorTexture->source 抽取正确的 baseColor 图（不是 images[0]）。
  2. 把高模归一化到与低模同一空间（Z-up->Y-up、XZ 居中、脚底 y=0、身高 2.05m）。
     —— 已验证两模型最近点中位 1.37cm，转移可信。
  3. 对每个低模 atlas 像素：由 UV 反算 3D 点 P，找最近高模顶点 v；
     再在 v 的 1-ring 面里做重心投影拿高模 UV，采样 18MB 贴图（crisp）；
     投影不中就用 v 自身的顶点色兜底（稳健）。
  4. 背景灰边用前景色外扩填充，根除 UV 缝合白边。
"""
import json, struct, sys
from io import BytesIO
from collections import defaultdict

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HP = sys.argv[1]   # E04_20260901_010134.glb (80k, 18MB embedded)
LP = sys.argv[2]   # lab/E04_Bulwark_1600.labmesh
OUT = sys.argv[3]  # output png
SIZE = int(sys.argv[4]) if len(sys.argv) > 4 else 1024

# ---------------------------------------------------------------------------
# 1. 解析 glb：几何 + 正确的 baseColor 图
# ---------------------------------------------------------------------------
def read_floats(binbuf, acc, views):
    bv = views[acc["bufferView"]]
    comp = acc["componentType"]; tp = acc["type"]
    cs = {5126:4,5123:2,5125:4,5121:1,5122:2,5120:1}[comp]
    ts = {"SCALAR":1,"VEC2":2,"VEC3":3,"VEC4":4}[tp]
    stride = bv.get("byteStride", cs*ts)
    start = bv["byteOffset"] + acc.get("byteOffset",0)
    n = acc["count"]
    arr = np.frombuffer(binbuf, dtype="<f4", count=n*ts, offset=start).reshape(n,ts)
    if comp != 5126 and acc.get("normalized"):
        arr = arr / (255 if comp==5121 else 65535 if comp==5123 else 32767)
    return arr

def read_indices(binbuf, acc, views):
    bv = views[acc["bufferView"]]; comp=acc["componentType"]
    cs={5125:4,5123:2,5121:1}[comp]
    start=bv["byteOffset"]+acc.get("byteOffset",0); n=acc["count"]
    dt={4:"<u4",2:"<u2",1:"<u1"}[cs]
    return np.frombuffer(binbuf, dtype=dt, count=n, offset=start).astype(np.int64)

def parse_glb(path):
    with open(path,"rb") as f: data=f.read()
    off=12; binbuf=None; js=None
    while off+8<=len(data):
        ln=struct.unpack("<I",data[off:off+4])[0]; ty=struct.unpack("<I",data[off+4:off+8])[0]
        s=off+8
        if ty==0x4E4F534A: js=json.loads(data[s:s+ln])
        elif ty==0x004E4942: binbuf=data[s:s+ln]
        off=s+ln+((4-(ln%4))%4)
    views=js["bufferViews"]; accs=js["accessors"]
    mesh=js["meshes"][0]; prim=mesh["primitives"][0]; attr=prim["attributes"]
    pos=read_floats(binbuf, accs[attr["POSITION"]], views)
    uv = read_floats(binbuf, accs[attr["TEXCOORD_0"]], views) if "TEXCOORD_0" in attr else np.zeros((len(pos),2))
    idx = read_indices(binbuf, accs[prim["indices"]], views).reshape(-1,3) if "indices" in prim else np.arange(len(pos)).reshape(-1,3)
    # baseColor 图：material[0].pbrMetallicRoughness.baseColorTexture -> texture -> source image
    mat=js["materials"][0]; bct=mat["pbrMetallicRoughness"]["baseColorTexture"]["index"]
    img_idx=js["textures"][bct]["source"]; img=js["images"][img_idx]
    bv=views[img["bufferView"]]; raw=binbuf[bv["byteOffset"]:bv["byteOffset"]+bv["byteLength"]]
    tex=Image.open(BytesIO(raw)).convert("RGB")
    return pos.astype(np.float64), idx.astype(np.int64), uv.astype(np.float64), tex

V_hp, F_hp, UV_hp, tex_hp = parse_glb(HP)
print(f"[hp ] verts={len(V_hp)} tris={len(F_hp)} tex={tex_hp.size}", file=sys.stderr)

# 归一化（与 export_labmesh 同约定）
yspan=V_hp[:,1].max()-V_hp[:,1].min(); zspan=V_hp[:,2].max()-V_hp[:,2].min()
if zspan > yspan*1.5:
    o=np.empty_like(V_hp); o[:,0]=V_hp[:,0]; o[:,1]=-V_hp[:,2]; o[:,2]=V_hp[:,1]; V_hp=o
c=((V_hp.min(0)+V_hp.max(0))/2.0); V_hp[:,0]-=c[0]; V_hp[:,2]-=c[2]; V_hp[:,1]-=V_hp[:,1].min()
h=V_hp[:,1].max(); V_hp*=2.05/max(h,1e-6)

# ---------------------------------------------------------------------------
# 2. 低模 labmesh（已是同约定）
# ---------------------------------------------------------------------------
with open(LP,"rb") as f: raw=f.read()
magic,ver,vc,ic=struct.unpack("<4sIII", raw[:16])
lv=np.frombuffer(raw, dtype="<f4", count=vc*15, offset=16).reshape(vc,15)
pos_lp=lv[:,0:3].astype(np.float64); uv_lp=lv[:,9:11].astype(np.float64)
idx_lp=np.frombuffer(raw, dtype="<u4", count=ic, offset=16+vc*15*4).reshape(-1,3).astype(np.int64)
print(f"[lp ] verts={vc} tris={ic}", file=sys.stderr)

# ---------------------------------------------------------------------------
# 3. 高模空间哈希 + 顶点->面邻接 + 每顶点颜色
# ---------------------------------------------------------------------------
cell=0.05
keys=np.floor(V_hp/cell).astype(int)
grid=defaultdict(list)
for i,k in enumerate(keys): grid[tuple(k)].append(i)
adj=defaultdict(list)
for fi,(a,b,c) in enumerate(F_hp):
    adj[int(a)].append(fi); adj[int(b)].append(fi); adj[int(c)].append(fi)
# 每顶点颜色（采样 18MB 贴图）
HW,HH=tex_hp.size
sx=(np.clip(UV_hp[:,0],0,1)*(HW-1)).astype(int)
sy=(np.clip(1.0-UV_hp[:,1],0,1)*(HH-1)).astype(int)
arr_hp=np.asarray(tex_hp)
vcol=arr_hp[sy,sx].astype(np.float64)
# 高模面顶点/UV 预取
Fa=V_hp[F_hp[:,0]]; Fb=V_hp[F_hp[:,1]]; Fc=V_hp[F_hp[:,2]]
Ua=UV_hp[F_hp[:,0]]; Ub=UV_hp[F_hp[:,1]]; Uc=UV_hp[F_hp[:,2]]

# ---------------------------------------------------------------------------
# 4. 光栅化低模 UV 三角形 -> id map + 每像素重心
# ---------------------------------------------------------------------------
idmap=Image.new("I",(SIZE,SIZE),0)
dr=ImageDraw.Draw(idmap)
uvp=np.stack([uv_lp[:,0]*(SIZE-1),(1.0-uv_lp[:,1])*(SIZE-1)],axis=1)
for ti,(a,b,c) in enumerate(idx_lp):
    pa=tuple(uvp[a]); pb=tuple(uvp[b]); pc=tuple(uvp[c])
    dr.polygon([pa,pb,pc], fill=ti+1)
idarr=np.asarray(idmap)
ys,xs=np.where(idarr>0)
tri_of=idarr[ys,xs]-1

# 预计算每个三角形的 2D 重心矩阵（uv -> bary）
def bary_matrix(t):
    p0=uvp[t[0]]; p1=uvp[t[1]]; p2=uvp[t[2]]
    mat=np.array([[p0[0],p1[0],p2[0]],[p0[1],p1[1],p2[1]],[1,1,1]],float)
    return np.linalg.inv(mat)

# 输出图
out=np.zeros((SIZE,SIZE,3),dtype=np.float64)
TW,TH=tex_hp.size
def sample_tex(uv):
    u=np.clip(uv[0],0,1)*(TW-1); v=(1.0-np.clip(uv[1],0,1))*(TH-1)
    return arr_hp[int(v),int(u)].astype(np.float64)

# 批量处理：对每个三角形，取它的像素，算 3D 点，最近高模顶点+投影
print("[bake] projecting ...", file=sys.stderr)
unique_tris=np.unique(tri_of)
for t in unique_tris:
    mask=(tri_of==t)
    px=xs[mask]; py=ys[mask]
    M=bary_matrix(idx_lp[t])
    # 像素 uv -> 重心
    hom=np.stack([px,py,np.ones_like(px)],axis=1).astype(float)
    w=hom@M.T  # (K,3)
    # 3D 点
    a=pos_lp[idx_lp[t,0]]; b=pos_lp[idx_lp[t,1]]; c=pos_lp[idx_lp[t,2]]
    P=w[:,0:1]*a+w[:,1:2]*b+w[:,2:3]*c  # (K,3)
    cols=np.empty((len(px),3),dtype=np.float64)
    for k in range(len(px)):
        Pk=P[k]
        ki=np.floor(Pk/cell).astype(int)
        best=-1; bd=1e9
        for dx in (-1,0,1):
            for dy in (-1,0,1):
                for dz in (-1,0,1):
                    bk=grid.get((int(ki[0])+dx,int(ki[1])+dy,int(ki[2])+dz))
                    if not bk: continue
                    for vi in bk:
                        d=np.sum((V_hp[vi]-Pk)**2)
                        if d<bd: bd=d; best=vi
        # 投影到 best 的相邻面
        chosen_uv=None
        for fi in adj[best]:
            a3=Fa[fi]; b3=Fb[fi]; c3=Fc[fi]
            v0=b3-a3; v1=c3-a3; v2=Pk-a3
            d00=v0@v0; d01=v0@v1; d11=v1@v1; d20=v2@v0; d21=v2@v1
            den=d00*d11-d01*d01
            if abs(den)<1e-12: continue
            vv=(d11*d20-d01*d21)/den; ww=(d00*d21-d01*d20)/den; uu=1-vv-ww
            if uu>=-0.02 and vv>=-0.02 and ww>=-0.02 and uu<=1.02 and vv<=1.02 and ww<=1.02:
                uvc=uu*Ua[fi]+vv*Ub[fi]+ww*Uc[fi]
                chosen_uv=uvc; break
        if chosen_uv is not None:
            cols[k]=sample_tex(chosen_uv)
        else:
            cols[k]=vcol[best]
    out[py,px]=cols

baked=Image.fromarray(np.clip(out,0,255).astype(np.uint8),"RGB")
# 背景用前景色外扩填充（根除白边）
bgmask=(idarr==0)
# 用 MaxFilter 把前景色向背景扩散几次
fill=baked.copy()
for _ in range(8):
    fill=fill.filter(ImageFilter.MaxFilter(3))
out_img=baked.copy()
out_img.paste(fill, mask=Image.fromarray((bgmask*255).astype(np.uint8)))
out_img.save(OUT)

# ---- 数据自检 ----
o=np.asarray(out_img).astype(float)
fg=o[~bgmask]
import os as _os
print(f"[done] saved {OUT} size={out_img.size} bytes={_os.path.getsize(OUT)//1024}KB", file=sys.stderr)
print(f"[stat] fg pixel std (R,G,B) = {fg.std(0).round(1)}  fg mean = {fg.mean(0).round(0)}", file=sys.stderr)
print(f"[stat] foreground coverage = {100*(~bgmask).mean():.1f}%", file=sys.stderr)
