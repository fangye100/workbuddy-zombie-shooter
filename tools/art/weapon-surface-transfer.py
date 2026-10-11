"""源表面贴图转移：新逐面 atlas 避免低模三角跨越原小 UV chart。"""
from pathlib import Path
from io import BytesIO
import numpy as np
import pymeshlab
from PIL import Image


def consistent_corner_normals(vertices, faces, normals):
    """只修与面绕序反向的平滑法线；拆面角防止把邻面正常法线一起改动。"""
    points=vertices[faces].reshape(-1,3);out=normals[faces].copy()
    face_n=np.cross(vertices[faces[:,1]]-vertices[faces[:,0]],vertices[faces[:,2]]-vertices[faces[:,0]])
    bad=np.einsum('ij,ij->i',face_n,out.sum(1))<0
    unit=face_n/np.maximum(np.linalg.norm(face_n,axis=1,keepdims=True),1e-12)
    out[bad]=unit[bad,None,:]
    return points,np.arange(len(points)).reshape(-1,3),out.reshape(-1,3),int(bad.sum())


def sample_rgb(image, uv):
    rgb = np.asarray(image.convert('RGB'), dtype=float)
    xy = np.clip(uv, 0, 1) * np.array([image.width-1, image.height-1])
    lo = np.floor(xy).astype(int); hi = np.minimum(lo+1, np.array(image.size)-1); w = xy-lo
    return (rgb[lo[:,1],lo[:,0]]*(1-w[:,0,None])*(1-w[:,1,None]) +
        rgb[lo[:,1],hi[:,0]]*w[:,0,None]*(1-w[:,1,None]) +
        rgb[hi[:,1],lo[:,0]]*(1-w[:,0,None])*w[:,1,None] +
        rgb[hi[:,1],hi[:,0]]*w[:,0,None]*w[:,1,None])


def color_error(source_obj, vertices, faces, wedges, image):
    """五个面内样本与最近源表面颜色比较，避免只检查 UV 数量。"""
    bary = np.array([[1/3]*3,[.6,.2,.2],[.2,.6,.2],[.2,.2,.6],[.45,.45,.1]])
    points = np.einsum('kc,fcj->fkj', bary, vertices[faces]).reshape(-1,3)
    coords = np.einsum('kc,fcj->fkj', bary, wedges.reshape(-1,3,2)).reshape(-1,2)
    ms = pymeshlab.MeshSet(); ms.load_new_mesh(str(source_obj))
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=points), 'color-probe')
    ms.transfer_texture_to_color_per_vertex(sourcemesh=0,targetmesh=1,upperbound=pymeshlab.PercentageValue(10))
    expected = ms.current_mesh().vertex_color_matrix()[:,:3]*255
    actual = sample_rgb(image, coords)
    error = np.mean(np.abs(actual-expected),axis=1)
    distance = ms.get_hausdorff_distance(sampledmesh=1,targetmesh=0,samplevert=True,
        sampleedge=False,sampleface=False,samplenum=len(points),maxdist=pymeshlab.PercentageValue(10))
    return dict(samples=len(points), meanAbsoluteRgbError=float(error.mean()),p95AbsoluteRgbError=float(np.percentile(error,95)),
        fractionErrorAbove40=float(np.mean(error>40)),surfaceDistance=distance,
        policy='五个面内样本，RGB 0..255，与原生最近源表面采样比较；不替代完整 texel 或 GPU 审计')


def textured_source(directory, vertices, faces, corner_uv, image):
    """glTF 图片 V 向下；OBJ/MeshLab 图片 V 向上，仅临时 OBJ 翻转。"""
    directory = Path(directory)
    uv = np.array(corner_uv, copy=True).reshape(-1, 2)
    uv[:, 1] = 1 - uv[:, 1]
    image.save(directory / 'source.png')
    (directory / 'source.mtl').write_text('newmtl source\nKd 1 1 1\nmap_Kd source.png\n', encoding='utf-8')
    obj = directory / 'transfer-source.obj'
    with obj.open('w', encoding='utf-8') as out:
        out.write('mtllib source.mtl\nusemtl source\n')
        for row in vertices: out.write('v ' + ' '.join(map(str, row)) + '\n')
        for row in uv: out.write('vt ' + ' '.join(map(str, row)) + '\n')
        for i, face in enumerate(faces):
            out.write('f ' + ' '.join(f'{v+1}/{i*3+k+1}' for k, v in enumerate(face)) + '\n')
    return obj


def transfer(source_obj, vertices, faces, old_wedges, directory, name):
    """原生 AABB 最近源三角 + barycentric texture 采样；几何不变。"""
    directory = Path(directory)
    ms = pymeshlab.MeshSet()
    ms.load_new_mesh(str(source_obj))
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=vertices, face_matrix=faces), 'target')
    ms.compute_texcoord_parametrization_triangle_trivial_per_wedge(textdim=1024, border=2)
    wedges = ms.current_mesh().wedge_tex_coord_matrix().copy()
    texture_name = f'{name}_basecolor.png'
    result = ms.transfer_attributes_to_texture_per_vertex(sourcemesh=0, targetmesh=1,
        attributeenum='Texture Color', upperbound=pymeshlab.PercentageValue(10),
        textname=texture_name, textw=1024, texth=1024, overwrite=False, pullpush=True)
    # 保存会将 MeshLab 的内存贴图写入指定目录。
    ms.set_current_mesh(1)
    ms.save_current_mesh(str(directory / f'{name}-transfer.obj'))
    texture_path = directory / texture_name
    if not texture_path.exists(): raise ValueError('MeshLab 未写出转移贴图')
    written = Image.open(texture_path).convert('RGBA')
    transparent_fraction=float(np.mean(np.asarray(written)[:,:,3]==0))
    if transparent_fraction == 1: raise ValueError('源表面转移无有效 texel（原生采样不支持退化平面 bounds）')
    texture = written.convert('RGB')
    if texture.size != (1024, 1024): raise ValueError('转移贴图尺寸错误')
    encoded = BytesIO(); texture.save(encoded, format='PNG')
    wedges[:, 1] = 1 - wedges[:, 1]
    return wedges, encoded.getvalue(), dict(method='MeshLab Texture Color closest-source-surface to independent per-face atlas',
        resolution=[1024, 1024], borderPixels=2, searchDistancePercent=10,
        sourceUvVFlipForObj=True, outputUvVFlipForGltf=True, filterResult=result,
        geometryUnchanged=True, transparentFractionAfterPullPush=transparent_fraction, visual='pending')
