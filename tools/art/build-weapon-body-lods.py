"""五件本体：node-baked Y-up/+Z、等比长轴归一、独立 QEM/源表面 atlas。原源不写。"""
import argparse, importlib.util, json, shutil, tempfile
from pathlib import Path
from io import BytesIO
import numpy as np
import pymeshlab
from PIL import Image

spec=importlib.util.spec_from_file_location('weapon_lods',Path(__file__).with_name('build-weapon-lods.py'))
pipeline=importlib.util.module_from_spec(spec);spec.loader.exec_module(pipeline)
ROOT=pipeline.ROOT;dec=pipeline.dec;surface=pipeline.surface
STAGE=ROOT/'.workbuddy/tmp/wpn-integration/body-lods'
AXES={
 'WPN-02-SHOTGUN':(2,[0,0,0],'94c68a1 headed +Z 内环/孔及侧面，muzzle +Z confirmed'),
 'WPN-03-SMG':(0,[0,90,0],'94c68a1 headed -X 炮口内环及侧面，muzzle -X confirmed'),
 'WPN-04-SNIPER':(0,[0,90,0],'94c68a1 headed -X 内孔及侧面，muzzle -X confirmed'),
 'WPN-05-CHAINSAW':(0,[0,90,0],'94c68a1 侧视薄齿导板在左；node-baked -X 前三段厚Z .030..050、中央壳体 .266..384，支持薄齿端 -X；端视未确认，normalized GPU pending'),
 'WPN-06-FLAME':(0,[0,90,0],'94c68a1 headed -X 喷口内孔及侧面，muzzle -X confirmed'),
}

def recipe_for(item):
 axis,degrees,evidence=AXES[item['id']]
 return dict(id=item['id'],rotationDeg=degrees,sourceLengthAxis=axis,lengthM=item['targetDimsM']['lengthZ'],
  targetDimsM=item['targetDimsM'],targets=list(item['lodTarget'].values()),axisEvidence=evidence,
  policy='等比按原源长轴；宽/高保留实际比例，不硬凑规格；final parser XZcenter/Yfloor sockets')

def build(item):
 recipe=recipe_for(item);aid=item['id'];source=ROOT/f'assets/_delivery/WPN-20261012/{aid}/{aid}.glb'
 v,f,uv,tex=dec.load_raw(source);image=Image.open(BytesIO(tex)).convert('RGB')
 r,scale,origin,expected=pipeline.placement(v,recipe)
 dest=STAGE/aid;dest.mkdir(parents=True,exist_ok=True)
 previous=json.loads((dest/'lod-report.json').read_text(encoding='utf-8')) if (dest/'lod-report.json').exists() else None
 image_small=image.copy();image_small.thumbnail((1024,1024),Image.Resampling.LANCZOS);image_small.save(dest/f'{aid}_basecolor.png')
 report=dict(id=aid,source=source.relative_to(ROOT).as_posix(),sourceHash=pipeline.sha(source),sourceTriangles=len(f),
  recipe=recipe,pipelineHash=pipeline.sha(__file__),helperHashes={Path(m.__file__).relative_to(ROOT).as_posix():pipeline.sha(m.__file__) for m in [pipeline,dec,surface]},
  toolVersions=dict(pymeshlab='2025.7.post1',numpy=np.__version__,pillow=Image.__version__),nodeTransformsApplied=True,
  sourceDimensions=np.ptp(v,axis=0).tolist(),scaleXYZ=[scale]*3,originRotatedSource=origin.tolist(),
  rawNodeBakedCenterSource=[float((v[:,0].min()+v[:,0].max())/2),float(v[:,1].min()),float((v[:,2].min()+v[:,2].max())/2)],
  dimensionsM=expected.tolist(),dimensionDifferenceM=(expected-np.array([item['targetDimsM'][k] for k in ['widthX','heightY','lengthZ']])).tolist(),
  normalization='source node world -> R -> (R*v-origin)*uniformScale -> parser final XZcentre/Yfloor; each LOD offset below',
  texturePolicy='每档独立1024逐面 atlas；保留源 BaseColor 表面采样，非原 atlas UV；源4096未改',
  status='visual-review-candidate',visual='pending',preciseFit='pending',parts='integral source geometry retained; no duplicate external attachment fitted yet',levels=[])
 if previous:
  report['unprotectedQemAttempt']=previous.get('unprotectedQemAttempt',[dict(level=l['level'],triangles=l['triangles'],topology=l['topology'],errors=l['errors']) for l in previous['levels']])
 with tempfile.TemporaryDirectory(prefix='weapon-body-lod-') as tmp:
  obj=Path(tmp)/'geometry.obj';dec.write_obj(obj,v,f,uv)
  source_obj=surface.textured_source(tmp,v,f,uv[f],image)
  for lod,target in enumerate(recipe['targets']):
   ms=pymeshlab.MeshSet();ms.load_new_mesh(str(obj));ms.meshing_remove_duplicate_vertices()
   if aid=='WPN-06-FLAME':
    initial=ms.current_mesh();initial_topo=dec._topo(initial.vertex_matrix(),initial.face_matrix());initial_count=initial.face_number()
    ms.meshing_repair_non_manifold_edges(method='Remove Faces')
    removed=initial_count-ms.current_mesh().face_number()
    ms.meshing_close_holes(maxholesize=40,selfintersection=False)
    added=ms.current_mesh().face_number()-(initial_count-removed)
    fixed=ms.current_mesh();repair_topo=dec._topo(fixed.vertex_matrix(),fixed.face_matrix())
    report['sourceDerivedLocalRepair']=dict(before=initial_topo,after=repair_topo,removedFaces=removed,addedFaces=added,
     method='原源不改；派生输入仅去非流形邻面+<=40边局部孔封闭；纹理仍从原源表面重投影')
    if repair_topo['nonmanifold']:raise ValueError('Flame 派生局部修复仍非流形，拒绝减面')
   base=ms.current_mesh();base_topo=dec._topo(base.vertex_matrix(),base.face_matrix());base_area=dec.tri_area(base.vertex_matrix(),base.face_matrix())
   # close_holes 会选择新增面；MeshLab 的 selected 缺省依赖当前选择，必须显式全网格。
   params=dict(targetfacenum=target,qualitythr=.3,preserveboundary=False,preservetopology=True,optimalplacement=True,planarquadric=True,selected=False)
   ms.meshing_decimation_quadric_edge_collapse(**params)
   before=ms.current_mesh().face_number();ms.meshing_remove_null_faces();ms.meshing_remove_duplicate_faces()
   m=ms.current_mesh();points=m.vertex_matrix();faces=m.face_matrix();normals=m.vertex_normal_matrix()@r.T
   if len(faces)>target:raise ValueError(f'{aid} LOD{lod} 未达到硬预算 {len(faces)}>{target}，不进入atlas')
   wedges,encoded,transfer=surface.transfer(source_obj,points,faces,m.wedge_tex_coord_matrix(),tmp,f'{aid}_lod{lod}')
   transfer['sampleError']=surface.color_error(source_obj,points,faces,wedges,Image.open(BytesIO(encoded)))
   texture_file=f'{aid}_lod{lod}_basecolor.png';(dest/texture_file).write_bytes(encoded)
   transfer.update(textureFile=texture_file,textureHash=pipeline.sha(dest/texture_file))
   placed=(points@r.T-origin)*scale
   area=dec.tri_area(points,faces)/base_area;drift=float(np.max(abs(np.ptp(placed,axis=0)/expected-1)))
   topo=dec._topo(points,faces);errors=[];diagnostics=[]
   if len(faces)>target:errors.append('triangle budget exceeded')
   if any(not np.isfinite(a).all() for a in [placed,wedges,normals]):errors.append('nonfinite attributes')
   if topo['nonmanifold']>base_topo['nonmanifold']:errors.append('nonmanifold increased')
   if not .9<=area<=1.1:diagnostics.append(f'面积比{area:.4f}；不可独立判断外轮廓')
   if drift>.05:diagnostics.append(f'bounds drift {drift:.4f}>.05，关键结构待目检')
   # 修复仅逆向角法线；其余由同一 QEM 的几何法线输出。
   placed,faces,normals,repaired=surface.consistent_corner_normals(placed,faces,normals)
   transfer['normalRepairFaces']=repaired
   pairs=[[(int(vi),i*3+k) for k,vi in enumerate(tri)] for i,tri in enumerate(faces)]
   file=dest/f'{aid}_lod{lod}.glb';dec.build_glb(str(file),placed,pairs,wedges,encoded,'image/png',N=normals)
   pipeline.helper.tag_glb(file,dict(id=aid,level=f'LOD{lod}',algorithm='geometry-QEM+source-surface-atlas',sourceHash=report['sourceHash'],targetFaces=target))
   row=dict(level=lod,file=file.name,hash=pipeline.sha(file),triangles=len(faces),algorithm='geometry-QEM+source-surface-atlas',parameters=params,
    textureSize=list(Image.open(BytesIO(encoded)).size),surfaceTransfer=transfer,sourceTopology=base_topo,topology=topo,
    surfaceRatio=area,boundsDrift=drift,dimensionsM=np.ptp(placed,axis=0).tolist(),silhouetteIoU=pipeline.silhouette(points,m.face_matrix(),v,f),
    exteriorSignedVolumeRatio=pipeline.volume(points,m.face_matrix())/max(pipeline.volume(v,f),1e-12),
    postQemRemovedFaces=before-len(faces),parserRecenterMeters=[float((placed[:,0].min()+placed[:,0].max())/2),float(placed[:,1].min()),float((placed[:,2].min()+placed[:,2].max())/2)],errors=errors,diagnostics=diagnostics,visual='pending')
   report['levels'].append(row);print(aid,lod,len(faces),'area',round(area,4),'drift',round(drift,4),'rgb',round(transfer['sampleError']['meanAbsoluteRgbError'],3),errors,flush=True)
 pipeline.write_json(dest/'lod-report.json',report)
 return report

def main():
 p=argparse.ArgumentParser();p.add_argument('--only',nargs='+',required=True);p.add_argument('--publish',action='store_true');args=p.parse_args()
 items=json.loads((ROOT/'assets/_delivery/WPN-20261012/delivery.json').read_text(encoding='utf-8'))['items']
 if set(args.only)-{i['id'] for i in items}:p.error('未知本体ID')
 for item in items:
  if item['id'] not in args.only:continue
  if not args.publish:build(item);continue
  src=STAGE/item['id'];report=json.loads((src/'lod-report.json').read_text(encoding='utf-8'))
  if report['recipe']!=recipe_for(item) or report['sourceHash']!=pipeline.sha(ROOT/report['source']) or report['pipelineHash']!=pipeline.sha(__file__):raise ValueError('过期 source/recipe/pipeline')
  for helper,hash in report['helperHashes'].items():
   if pipeline.sha(ROOT/helper)!=hash:raise ValueError('过期 helper')
  if len(report['levels'])!=3 or any(l['errors'] or l['triangles']>report['recipe']['targets'][l['level']] or pipeline.sha(src/l['file'])!=l['hash'] for l in report['levels']):raise ValueError('硬门禁失败')
  dest=ROOT/f'assets/art/models/{item["id"]}/game_ready';dest.mkdir(parents=True,exist_ok=True)
  for l in report['levels']:
   shutil.copyfile(src/l['file'],dest/l['file']);texture=l['surfaceTransfer'];file=texture['textureFile']
   if pipeline.sha(src/file)!=texture['textureHash']:raise ValueError('贴图hash失配')
   shutil.copyfile(src/file,dest/file)
  shutil.copyfile(src/f'{item["id"]}_basecolor.png',dest/f'{item["id"]}_basecolor.png')
  pipeline.write_json(dest.parent/'lod-report.json',report);print('发布待视觉验收候选',item['id'],flush=True)
if __name__=='__main__':main()
