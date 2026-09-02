# -*- coding: utf-8 -*-
"""QECS 减面(80k->6000/1600) + 手组 glb + 颜色闭环定 V 约定。"""
import json, struct, sys, os
import numpy as np
from collections import defaultdict
from io import BytesIO
from PIL import Image
import pymeshlab as ml
import trimesh
from trimesh.visual.material import PBRMaterial

HP = sys.argv[1]; TMP = sys.argv[2]

def read_floats(binbuf, acc, views):
    bv=views[acc["bufferView"]]
    cs={5126:4,5123:2,5125:4,5121:1,5122:2,5120:1}[acc["componentType"]]
    ts={"SCALAR":1,"VEC2":2,"VEC3":3,"VEC4":4}[acc["type"]]
    st=bv.get("byteStride",cs*ts); start=bv["byteOffset"]+acc.get("byteOffset",0)
    return np.frombuffer(binbuf,dtype="<f4",count=acc["count"]*ts,offset=start).reshape(acc["count"],ts).astype(np.float64)

def parse_glb(path):
    with open(path,'rb') as f: data=f.read()
    off=12; binbuf=None; js=None
    while off+8<=len(data):
        ln=struct.unpack('<I',data[off:off+4])[0]; ty=struct.unpack('<I',data[off+4:off+8])[0]
        s=off+8
        if ty==0x4E4F534A: js=json.loads(data[s:s+ln])
        elif ty==0x004E4942: binbuf=data[s:s+ln]
        off=s+ln+((4-(ln%4))%4)
    views=js["bufferViews"]; accs=js["accessors"]
    prim=js["meshes"][0]["primitives"][0]; attr=prim["attributes"]
    pos=read_floats(binbuf,accs[attr["POSITION"]],views)
    uv=read_floats(binbuf,accs[attr["TEXCOORD_0"]],views) if "TEXCOORD_0" in attr else np.zeros((len(pos),2))
    acc=accs[prim["indices"]]; bv=views[acc["bufferView"]]
    cs={5125:4,5123:2,5121:1}[acc["componentType"]]
    idx=np.frombuffer(binbuf,dtype={4:"<u4",2:"<u2",1:"<u1"}[cs],count=acc["count"],offset=bv["byteOffset"]).astype(np.int64)
    return pos,uv,idx,js,binbuf

pos0,uv0,idx0,js0,bin0 = parse_glb(HP)
views=js0["bufferViews"]
bct=js0["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"]
img0=js0["textures"][bct]["source"]; imgd=js0["images"][img0]
bv=views[imgd["bufferView"]]
tex0=Image.open(BytesIO(bin0[bv["byteOffset"]:bv["byteOffset"]+bv["byteLength"]])).convert("RGB")
A0=np.asarray(tex0)
print(f"[orig] V={len(pos0)} F={len(idx0)//3} tex={tex0.size}")

cell=0.05
grid=defaultdict(list)
for i,k in enumerate(np.floor(pos0/cell).astype(int)): grid[tuple(k)].append(i)
def nearest_v(p):
    ki=np.floor(p/cell).astype(int); best=-1; bd=1e18
    for r in range(4):
        for dx in range(-r,r+1):
            for dy in range(-r,r+1):
                for dz in range(-r,r+1):
                    if max(abs(dx),abs(dy),abs(dz))!=r: continue
                    b=grid.get((int(ki[0])+dx,int(ki[1])+dy,int(ki[2])+dz))
                    if not b: continue
                    for vi in b:
                        d=np.sum((pos0[vi]-p)**2)
                        if d<bd: bd=d; best=vi
        if best>=0 and r>=1: break
    return best

def sample(arr,uvs,flip):
    H,W=arr.shape[:2]
    x=np.clip(uvs[...,0],0,1)*(W-1)
    y=(1.0-np.clip(uvs[...,1],0,1))*(H-1) if flip else np.clip(uvs[...,1],0,1)*(H-1)
    return arr[y.astype(int),x.astype(int)]

def stretch(pos,uv,idx):
    a,b,c=pos[idx[0::3]],pos[idx[1::3]],pos[idx[2::3]]
    ua,ub,uc=uv[idx[0::3]],uv[idx[1::3]],uv[idx[2::3]]
    ar3=0.5*np.linalg.norm(np.cross(b-a,c-a),axis=1)
    aruv=0.5*np.abs((ub[:,0]-ua[:,0])*(uc[:,1]-ua[:,1])-(uc[:,0]-ua[:,0])*(ub[:,1]-ua[:,1]))
    r=np.sqrt(aruv/np.maximum(ar3,1e-12))
    return r,int(((aruv<1e-12)&(ar3>1e-9)).sum())

rng=np.random.default_rng(7)
def verify(path,tag):
    pos,uv,idx,_,_=parse_glb(path)
    F=len(idx)//3
    r,brk=stretch(pos,uv,idx)
    fi=rng.choice(F,size=min(1500,F),replace=False)
    w=rng.random((len(fi),3)); w/=w.sum(1,keepdims=True)
    tri=idx.reshape(-1,3)[fi]
    P=w[:,0:1]*pos[tri[:,0]]+w[:,1:2]*pos[tri[:,1]]+w[:,2:3]*pos[tri[:,2]]
    UV=w[:,0:1]*uv[tri[:,0]]+w[:,1:2]*uv[tri[:,1]]+w[:,2:3]*uv[tri[:,2]]
    ref=np.empty((len(fi),3))
    for k in range(len(fi)):
        ref[k]=sample(A0,uv0[nearest_v(P[k]):nearest_v(P[k])+1],False)[0]
    res={}
    for flip in (False,True):
        new=np.empty_like(ref)
        for k in range(len(fi)): new[k]=sample(A0,UV[k:k+1],flip)[0]
        res[flip]=float(np.abs(ref-new).mean())
    win=min(res,key=res.get)
    print(f"[{tag}] F={F} uv破碎面={brk} density med={np.median(r):.3f} p95={np.percentile(r,95):.3f} | "
          f"MAE(V=v)={res[False]:.1f} MAE(V=1-v)={res[True]:.1f} -> 胜出:{'1-v' if win else 'v'}")
    return win,res

os.makedirs(TMP+"/uvkeep",exist_ok=True)
results={}
for target in (6000,1600):
    ms=ml.MeshSet(); ms.load_new_mesh(HP)
    ms.meshing_decimation_quadric_edge_collapse(targetfacenum=target,qualitythr=0.3)
    mm=ms.current_mesh()
    v=mm.vertex_matrix(); f=mm.face_matrix()
    wt=mm.wedge_tex_coord_matrix()      # (F,3,2) MeshLab 内部约定
    print(f"[dec{target}] V={mm.vertex_number()} F={mm.face_number()} wedgeTex={mm.has_wedge_tex_coord()}")
    # 逐角展开（unweld），UV 完整保留
    Vuw=v[f.reshape(-1)]; Uuw=wt.reshape(-1,2); Fuw=np.arange(3*mm.face_number()).reshape(-1,3)
    for flipuv in (False,True):
        uu=Uuw.copy()
        if flipuv: uu[:,1]=1.0-uu[:,1]
        mesh=trimesh.Trimesh(vertices=Vuw,faces=Fuw,process=False,
            visual=trimesh.visual.TextureVisuals(uv=uu,
                material=PBRMaterial(baseColorTexture=tex0,metallicFactor=0.0,roughnessFactor=0.9)))
        g=TMP+f"/uvkeep/E04_uv{target}{'_flipped' if flipuv else ''}.glb"
        mesh.export(g)
        win,res=verify(g,f"uv{target}{'_flipped' if flipuv else ''}")
        results[(target,flipuv)]=(win,res)
print("done")
