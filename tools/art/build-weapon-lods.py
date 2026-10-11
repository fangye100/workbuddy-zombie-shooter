"""五件武器交付的独立保 UV LOD。原 GLB 不写入；数值通过后仍须 headed GPU 目检。"""
import argparse, hashlib, importlib.util, json, sys, tempfile
from pathlib import Path
from io import BytesIO
import numpy as np
import pymeshlab
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'assets/characters/_tools'))
import decimate_uvkeep as dec
spec = importlib.util.spec_from_file_location('environment_lods', ROOT/'assets/environment/_tools/build_environment_lods.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
STAGE = ROOT/'.workbuddy/tmp/wpn-integration/lods'
RECIPES = [
    dict(id='WPN-07-LAUNCHER', rotationDeg=[0,90,0], sourceLengthAxis=2, lengthM=.75, targets=[3000,1500,500],
         axisEvidence='节点变换后 +Z 为有孔炮口，-Z 为实心黄后盖；转 Y+90° 后炮口 +X；待 GPU 端面复核'),
    dict(id='WPN-MAG-01', rotationDeg=[0,0,0], sourceLengthAxis=1, lengthM=.11, targets=[400,200,80],
         axisEvidence='节点变换后黄铜底板 -Y、开口 +Y；插入端 +Y'),
    dict(id='WPN-MAG-02-SMG', rotationDeg=[0,0,-90], sourceLengthAxis=0, lengthM=.11, targets=[400,200,80],
         axisEvidence='长轴 X；-X 为较窄突出颈，+X 为宽底缘；候选插入端 -X 转为 +Y，缺 WPN-02 本体，精确 fit 待定'),
    dict(id='WPN-SHELL-01', rotationDeg=[0,0,-90], sourceLengthAxis=0, lengthM=.07, targets=[400,200,80],
         axisEvidence='红壳 -X、黄铜底座/底火 +X；转 Z-90° 后壳口 +Y、底火 -Y'),
    dict(id='WPN-FUEL-01', rotationDeg=[0,0,90], sourceLengthAxis=0, lengthM=.25, targets=[800,400,150],
         axisEvidence='罐体长轴 X 转为 Y；保留整体软管，按非黑色罐体实测长度统一缩放，缺 WPN-06 精确 fit 待定'),
]

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def write_json(p,data):
    p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
def rotation(degrees):
    out=np.eye(3)
    for axis,a in enumerate(np.deg2rad(degrees)):
        c,s=np.cos(a),np.sin(a)
        r=([[1,0,0],[0,c,-s],[0,s,c]] if axis==0 else [[c,0,s],[0,1,0],[-s,0,c]] if axis==1 else [[c,-s,0],[s,c,0],[0,0,1]])
        out=np.array(r)@out
    return out
def placement(v,recipe,reference_length=None):
    r=rotation(recipe['rotationDeg']);placed=v@r.T
    source_length=reference_length if reference_length is not None else np.ptp(v,axis=0)[recipe['sourceLengthAxis']]
    if not np.isfinite(v).all() or not np.isfinite(source_length) or source_length<=1e-8 or recipe['lengthM']<=0:raise ValueError('非有限或退化的长度/尺度')
    scale=recipe['lengthM']/source_length
    low,high=placed.min(0),placed.max(0)
    origin=np.array([(low[0]+high[0])/2,low[1],(low[2]+high[2])/2])
    return r,scale,origin,np.ptp(placed,axis=0)*scale
def write_wedges(p,v,f,w):
    with open(p,'w',encoding='utf-8') as o:
        for a in v:o.write('v '+' '.join(f'{n:.9g}' for n in a)+'\n')
        for a in w:o.write('vt '+' '.join(f'{n:.9g}' for n in a)+'\n')
        for i,a in enumerate(f):o.write('f '+' '.join(f'{int(n)+1}/{i*3+k+1}' for k,n in enumerate(a))+'\n')

def shell_repair(ms,source_v,source_f,source_uv):
    """只清理浮片/非流形并封局部洞；不重建弹壳本体。新增面 UV 从邻近源面取样。"""
    logs=[]
    def record(label):
        m=ms.current_mesh();logs.append(dict(step=label,topology=dec._topo(m.vertex_matrix(),m.face_matrix()),
            area=dec.tri_area(m.vertex_matrix(),m.face_matrix())))
    record('position-welded')
    ms.meshing_remove_connected_component_by_face_number(mincomponentsize=1000)
    record('remove-detached-fragments')
    ms.meshing_remove_null_faces();ms.meshing_remove_duplicate_faces()
    ms.meshing_repair_non_manifold_edges(method='Remove Faces');ms.meshing_re_orient_faces_coherently()
    record('remove-degenerate-nonmanifold-and-orient')
    ms.meshing_close_holes(maxholesize=400,selfintersection=True)
    ms.meshing_repair_non_manifold_edges(method='Remove Faces')
    ms.meshing_close_holes(maxholesize=400,selfintersection=False)
    ms.meshing_repair_non_manifold_edges(method='Remove Faces');ms.meshing_re_orient_faces_coherently()
    record('local-hole-fill-and-final-orient')
    m=ms.current_mesh();v,f,w=m.vertex_matrix(),m.face_matrix(),m.wedge_tex_coord_matrix()
    tri_uv=w.reshape(-1,3,2);new=(np.ptp(tri_uv,axis=1).max(1)<1e-8)
    centers=source_v[source_f].mean(1)
    new_centers=v[f[new]].mean(1)
    for i,center in zip(np.flatnonzero(new),new_centers):
        near=int(np.argmin(np.sum((centers-center)**2,axis=1)))
        tri_uv[i]=source_uv[source_f[near]]
    return v,f,tri_uv.reshape(-1,2),dict(steps=logs,filledUvFaces=int(new.sum()),
        generatedFaceBounds=None if not len(new_centers) else [new_centers.min(0).tolist(),new_centers.max(0).tolist()],
        uvMethod='新增洞面沿用距离最近源面三角角 UV；原 BaseColor 不改；视觉待验收',
        remainingBoundary=logs[-1]['topology']['boundary'])

def silhouette(v,f,ref_v,ref_f):
    """三正交投影的几何覆盖诊断；不是 GPU 视觉验收。"""
    result=[]
    for axes in [(0,1),(0,2),(2,1)]:
        low=ref_v[:,axes].min(0);high=ref_v[:,axes].max(0);span=high-low
        masks=[]
        for points,faces in [(ref_v,ref_f),(v,f)]:
            projected=(points[:,axes]-low)/span*480+16
            canvas=Image.new('1',(512,512));draw=ImageDraw.Draw(canvas)
            for triangle in projected[faces]:draw.polygon([tuple(p) for p in triangle],fill=1)
            masks.append(np.asarray(canvas,dtype=bool))
        result.append(float(np.logical_and(*masks).sum()/max(1,np.logical_or(*masks).sum())))
    return result
def volume(v,f):
    return float(abs(np.sum(np.einsum('ij,ij->i',v[f[:,0]],np.cross(v[f[:,1]],v[f[:,2]])))/6))

def build(recipe):
    aid=recipe['id'];source=ROOT/f'assets/_delivery/WPN-20261011/{aid}/{aid}.glb'
    v,f,uv,tex=dec.load_raw(source)
    image=Image.open(BytesIO(tex)).convert('RGB')
    reference=None;body=None
    if aid=='WPN-FUEL-01':
        # 颜色仅用于测量罐体，不裁剪任何三角形。黑色软管不决定罐体米制尺度。
        rgb=np.asarray(image);ij=np.clip(uv,0,.999999)*np.array(image.size)
        sampled=rgb[ij[:,1].astype(int),ij[:,0].astype(int)].astype(float)
        mask=(sampled[:,0]>45)&(sampled[:,1]>45)&(sampled[:,0]>sampled[:,2]*1.05)
        body=[v[mask].min(0),v[mask].max(0)];reference=float(np.ptp(v[mask],axis=0)[0])
    r,scale,origin,expected=placement(v,recipe,reference)
    image.thumbnail((1024,1024),Image.Resampling.LANCZOS)
    encoded=BytesIO();image.save(encoded,format='PNG');encoded=encoded.getvalue()
    dest=STAGE/aid;dest.mkdir(parents=True,exist_ok=True)
    image.save(dest/f'{aid}_basecolor.png')
    report=dict(id=aid,source=str(source.relative_to(ROOT)).replace('\\','/'),sourceHash=sha(source),
        sourceTriangles=len(f),recipe=recipe,recipeHash=hashlib.sha256(json.dumps(recipe,sort_keys=True).encode()).hexdigest(),
        pipelineHash=sha(__file__),helperHashes={str(Path(module.__file__).relative_to(ROOT)):sha(module.__file__) for module in [dec,helper]},
        toolVersions=dict(python=sys.version.split()[0],pymeshlab='2025.7.post1',numpy=np.__version__,pillow=Image.__version__),
        nodeTransformsApplied=True,sourceDimensions=np.ptp(v,axis=0).tolist(),scaleXYZ=[scale]*3,
        rawNodeBakedCenterSource=[float((v[:,0].min()+v[:,0].max())/2),float(v[:,1].min()),float((v[:,2].min()+v[:,2].max())/2)],
        simplificationParameters=dict(texture=dict(qualitythr=.3,extratcoordw=.1,preserveboundary=False,optimalplacement=True,preservenormal=False,planarquadric=True),
            geometry=dict(qualitythr=.3,preserveboundary=False,preservetopology=False,optimalplacement=True,planarquadric=True)),
        originRotatedSource=origin.tolist(),dimensionsM=expected.tolist(),bodyBoundsSource=None if body is None else np.asarray(body).tolist(),
        bodyDimensionsM=None if body is None else ((body[1]-body[0])*scale).tolist(),
        textureSize=list(image.size),textureHash=sha(dest/f'{aid}_basecolor.png'),levels=[],visual='pending',preciseFit='pending',
        status='visual-review-candidate',qualityPolicy='面积 .9..1.1 / 包围盒漂移 <=.05 为诊断；远档细槽损失不单独判定轮廓；预算硬门禁；需 GPU 对比关键端面/握把/阀门及贴图')
    with tempfile.TemporaryDirectory(prefix='weapon-uvkeep-') as tmp:
        obj=Path(tmp)/'source.obj';dec.write_obj(obj,v,f,uv)
        reference_v,reference_f=v,f
        if aid=='WPN-SHELL-01':
            repair=pymeshlab.MeshSet();repair.load_new_mesh(str(obj));repair.meshing_remove_duplicate_vertices()
            reference_v,reference_f,reference_w,report['repair']=shell_repair(repair,v,f,uv)
            obj=Path(tmp)/'repaired.obj';write_wedges(obj,reference_v,reference_f,reference_w)
            normals=repair.current_mesh().vertex_normal_matrix()@r.T
            pairs=[[(int(vi),i*3+k) for k,vi in enumerate(tri)] for i,tri in enumerate(reference_f)]
            reference_file=dest/f'{aid}_repaired_reference.glb'
            dec.build_glb(str(reference_file),(reference_v@r.T-origin)*scale,pairs,reference_w,encoded,'image/png',N=normals)
            helper.tag_glb(reference_file,dict(id=aid,level='REPAIRED_REFERENCE',algorithm='local-source-repair',sourceHash=report['sourceHash']))
            report['repairedReference']=dict(file=reference_file.name,hash=sha(reference_file),triangles=len(reference_f),visual='pending')
            repaired_placed=(reference_v@r.T-origin)*scale
            report['repairedReference']['parserRecenterMeters']=[float((repaired_placed[:,0].min()+repaired_placed[:,0].max())/2),float(repaired_placed[:,1].min()),float((repaired_placed[:,2].min()+repaired_placed[:,2].max())/2)]
        for lod,target in enumerate(recipe['targets']):
            ms=pymeshlab.MeshSet();ms.load_new_mesh(str(obj));ms.meshing_remove_duplicate_vertices()
            m=ms.current_mesh();base_topo=dec._topo(m.vertex_matrix(),m.face_matrix());base_area=dec.tri_area(m.vertex_matrix(),m.face_matrix())
            ms.meshing_decimation_quadric_edge_collapse_with_texture(targetfacenum=target,qualitythr=.3,extratcoordw=.1,
                preserveboundary=False,optimalplacement=True,preservenormal=False,planarquadric=True)
            algorithm='texture-QEM-wedge-UV'
            m=ms.current_mesh();trial_area=dec.tri_area(m.vertex_matrix(),m.face_matrix())/base_area
            trial_drift=float(np.max(np.abs(np.ptp(m.vertex_matrix()@r.T,axis=0)*scale/expected-1)))
            failed_texture=dict(triangles=m.face_number(),surfaceRatio=trial_area,boundsDrift=trial_drift)
            if m.face_number()>target or trial_area<.9 or trial_drift>.05:
                # 原 atlas 与逐角 UV 继续保留；不暗示通用 QEM 对贴图拉伸已通过。
                ms=pymeshlab.MeshSet();ms.load_new_mesh(str(obj));ms.meshing_remove_duplicate_vertices()
                ms.meshing_decimation_quadric_edge_collapse(targetfacenum=target,qualitythr=.3,preserveboundary=False,
                    preservetopology=False,optimalplacement=True,planarquadric=True)
                algorithm='geometry-QEM-original-wedge-UV-candidate'
            before_clean=ms.current_mesh().face_number()
            ms.meshing_remove_null_faces();ms.meshing_remove_duplicate_faces()
            ms.meshing_repair_non_manifold_edges(method='Remove Faces')
            m=ms.current_mesh();points,faces,wedges=m.vertex_matrix(),m.face_matrix(),m.wedge_tex_coord_matrix()
            placed=(points@r.T-origin)*scale
            normals=m.vertex_normal_matrix()@r.T;normals/=np.maximum(np.linalg.norm(normals,axis=1,keepdims=True),1e-12)
            area=dec.tri_area(points,faces)/base_area;drift=float(np.max(np.abs(np.ptp(placed,axis=0)/expected-1)))
            topo=dec._topo(points,faces);errors=[];diagnostics=[]
            if len(faces)>target:errors.append(f'硬上限失败 {len(faces)} > {target}')
            if not .9<=area<=1.1:diagnostics.append(f'面积比 {area:.4f} 不在 [.9,1.1]；需要轮廓和关键结构对照')
            if drift>.05:diagnostics.append(f'包围盒漂移 {drift:.4f} > .05；需要 GPU 对比，尚未批准')
            if not all(np.isfinite(a).all() for a in [placed,normals,wedges]):errors.append('非有限属性')
            if topo['nonmanifold']>base_topo['nonmanifold']:errors.append('非流形边增加')
            file=dest/f'{aid}_lod{lod}.glb'
            pairs=[[(int(vi),i*3+k) for k,vi in enumerate(tri)] for i,tri in enumerate(faces)]
            dec.build_glb(str(file),placed,pairs,wedges,encoded,'image/png',N=normals)
            helper.tag_glb(file,dict(id=aid,level=f'LOD{lod}',algorithm=algorithm,sourceHash=report['sourceHash'],targetFaces=target))
            row=dict(level=lod,file=file.name,triangles=len(faces),hash=sha(file),surfaceRatio=area,boundsDrift=drift,
                dimensionsM=np.ptp(placed,axis=0).tolist(),sourceTopology=base_topo,topology=topo,errors=errors,diagnostics=diagnostics,
                algorithm=algorithm,textureQemTrial=failed_texture,silhouetteIoU=silhouette(points,faces,reference_v,reference_f),
                exteriorSignedVolumeRatio=volume(points,faces)/max(volume(reference_v,reference_f),1e-12),visual='pending',
                postQemRemovedDegenerateDuplicateNonmanifoldFaces=before_clean-len(faces),
                parserRecenterMeters=[float((placed[:,0].min()+placed[:,0].max())/2),float(placed[:,1].min()),float((placed[:,2].min()+placed[:,2].max())/2)])
            report['levels'].append(row);print(aid,lod,len(faces),round(area,4),round(drift,4),algorithm,errors,diagnostics,flush=True)
    write_json(dest/'lod-report.json',report)
    return report

def main():
    p=argparse.ArgumentParser();p.add_argument('--only',nargs='+');p.add_argument('--publish',action='store_true');args=p.parse_args()
    entries=[e for e in RECIPES if not args.only or e['id'] in args.only]
    if args.only and set(args.only)!={e['id'] for e in entries}:p.error('未知 ID')
    if args.publish and not args.only:p.error('发布必须明确 --only ID')
    for e in entries:
        if not args.publish:build(e);continue
        src=STAGE/e['id'];report=json.loads((src/'lod-report.json').read_text(encoding='utf-8'))
        if report['recipe']!=e or report['pipelineHash']!=sha(__file__) or report['sourceHash']!=sha(ROOT/report['source']):raise ValueError('过期 source/recipe/pipeline')
        if any(l['errors'] or sha(src/l['file'])!=l['hash'] for l in report['levels']):raise ValueError('数值失败或 LOD hash 失配')
        target=ROOT/f'assets/art/models/{e["id"]}/game_ready';target.mkdir(parents=True,exist_ok=True)
        import shutil
        for l in report['levels']:shutil.copyfile(src/l['file'],target/l['file'])
        if 'repairedReference' in report:shutil.copyfile(src/report['repairedReference']['file'],target/report['repairedReference']['file'])
        shutil.copyfile(src/f'{e["id"]}_basecolor.png',target/f'{e["id"]}_basecolor.png')
        write_json(target.parent/'lod-report.json',report)
        print('发布数值候选，GPU 目检待完成:',e['id'],flush=True)
if __name__=='__main__':main()
