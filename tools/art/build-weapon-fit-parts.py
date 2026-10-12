"""实际装配派生：区域切割去重复mag/can；旧props明示来源/缩放，局部Shell底火封口。"""
import argparse,importlib.util,json,tempfile,shutil
from pathlib import Path
from io import BytesIO
import numpy as np
import pymeshlab
from PIL import Image
def module(name,file):
 spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
p=module('lod_pipeline','build-weapon-lods.py');cut=module('region_cut','weapon-region-cut.py')
ROOT=p.ROOT;dec=p.dec;surface=p.surface;STAGE=ROOT/'.workbuddy/tmp/wpn-integration/fit-parts'
SPECS={
 'WPN-03-SMG-without-mag':dict(owner='WPN-03-SMG',source='assets/_delivery/WPN-20261012/WPN-03-SMG/WPN-03-SMG.glb',planes=[(0,-.09,-1),(1,.30,-1)],rotation=[0,90,0],scale='body',targets=[5000,2500,800],reason='去除可见外露stick-mag：node-baked x<-.09且y<.30；保留receiver/trigger/grip，边插值UV后局部cap'),
 'WPN-06-FLAME-without-can':dict(owner='WPN-06-FLAME',source='assets/_delivery/WPN-20261012/WPN-06-FLAME/WPN-06-FLAME.glb',planes=[(0,.19,1),(1,.395,-1)],rotation=[0,90,0],scale='body',targets=[6000,3000,1000],reason='去除后方固有can及冲突return-hose段：x>.19且y<.395；保留主体双握/喷嘴及其余hose，不按component切'),
 'WPN-MAG-02-SMG-fit':dict(owner='WPN-MAG-02-SMG',source='assets/_delivery/WPN-20261011/WPN-MAG-02-SMG/WPN-MAG-02-SMG.glb',planes=[],rotation=[0,0,-90],scale=[.126,.114,.252],targets=[400,200,80],reason='原弹匣源的真实fit派生；source-X插入端转+Y；按SMG移出区高度约.15m/深约.07m标定XYZ，非均匀缩放明示，待GPU槽口确认'),
 'WPN-MAG-02-SNIPER-derived':dict(owner='WPN-MAG-02-SMG',source='assets/_delivery/WPN-20261011/WPN-MAG-02-SMG/WPN-MAG-02-SMG.glb',planes=[],rotation=[0,0,-90],scale=[.068,.114,.20],targets=[400,200,80],reason='缺狙击弹匣；由已交付SMG弹匣局部米制缩放派生短弹匣，非WorkBuddy新生成，待槽口fit'),
 'WPN-FUEL-01-fit-can':dict(owner='WPN-FUEL-01',source='assets/_delivery/WPN-20261011/WPN-FUEL-01/WPN-FUEL-01.glb',planes=[(1,.53,1)],rotation=[0,90,0],scale=[.232,.301,.339],targets=[800,400,150],reason='交付note允许移除冲突软管；切Y>.53长软管，保留罐体+下部阀座；按Flame原can约.216长/.148径调整XYZ，保持原源；非均匀法线由变换后几何重新计算'),
 'WPN-SHELL-01-primer-fixed':dict(owner='WPN-SHELL-01',source='assets/_delivery/WPN-20261011/WPN-SHELL-01/WPN-SHELL-01.glb',planes=[(0,.174,1)],rotation=[0,0,-90],scale=[.066075,.066075,.066075],targets=[400,200,80],reason='只截原底火端X>.174（约源长2.1%）并封局部端孔，红壳/黄铜rim保留；橙色cap UV取原黄铜有效texel，不重造整个弹壳',shell=True),
 'WPN-07-LAUNCHER-round-derived':dict(owner='WPN-SHELL-01',source='assets/_delivery/WPN-20261011/WPN-SHELL-01/WPN-SHELL-01.glb',planes=[(0,.174,1)],rotation=[0,0,0],scale=[.17,.085,.085],targets=[400,200,80],reason='缺发射器弹丸；由Shell局部底火修复源派生，+X轴约.176m，不宣称新交付弹丸或完整火箭造型',shell=True),
}

def prepared(spec,tmp):
 v,f,u,tex=dec.load_raw(ROOT/spec['source']);image=Image.open(BytesIO(tex)).convert('RGB');source_topo=None
 if spec['planes']:
  outside,removed=cut.partition(v,f,u,spec['planes']);vv,ff,uu=outside
 else:vv,ff,uu=v,f,u;removed=None
 obj=Path(tmp)/'clipped.obj';dec.write_obj(obj,vv,ff,uu)
 ms=pymeshlab.MeshSet();ms.load_new_mesh(str(obj));ms.meshing_remove_duplicate_vertices()
 m=ms.current_mesh();source_topo=dec._topo(m.vertex_matrix(),m.face_matrix());before=m.face_number()
 if spec.get('shell'):ms.meshing_remove_connected_component_by_face_number(mincomponentsize=1000)
 ms.meshing_remove_null_faces();ms.meshing_remove_duplicate_faces();ms.meshing_repair_non_manifold_edges(method='Remove Faces')
 ms.meshing_re_orient_faces_coherently()
 removed_count=before-ms.current_mesh().face_number();ms.set_selection_none()
 ms.meshing_close_holes(maxholesize=2000,selfintersection=False)
 native=ms.current_mesh();native_topo=dec._topo(native.vertex_matrix(),native.face_matrix())
 if native_topo['nonmanifold']:
  count=native.face_number();ms.meshing_repair_non_manifold_edges(method='Remove Faces');removed_count+=count-ms.current_mesh().face_number()
 ms.meshing_re_orient_faces_coherently()
 m=ms.current_mesh();points,faces,w=m.vertex_matrix(),m.face_matrix(),m.wedge_tex_coord_matrix().reshape(-1,3,2)
 selected=m.face_selection_array();topo=dec._topo(points,faces)
 if topo['boundary'] and not topo['nonmanifold']:
  points,faces,simple_added=cut.cap_boundary(points,faces,2000)
  w=np.concatenate([w,np.zeros((simple_added,3,2))]);selected=np.concatenate([selected,np.ones(simple_added,dtype=bool)])
 added=int(selected.sum())
 centers=v[f].mean(1);corner_uv=u[f]
 if added:
  if spec.get('shell'):
   rgb=surface.sample_rgb(image,u);mask=(rgb[:,0]>100)&(rgb[:,1]>45)&(rgb[:,1]<190)&(rgb[:,2]<65)&(v[:,0]>.02)
   options=u[mask]
   if not len(options):raise ValueError('Shell无可验证黄铜源UV')
   cap_uv=options[len(options)//2];w[selected]=cap_uv
  else:
   for i in np.flatnonzero(selected):
    nearest=int(np.argmin(np.sum((centers-points[faces[i]].mean(0))**2,axis=1)));w[i]=corner_uv[nearest]
 topo=dec._topo(points,faces)
 if topo['nonmanifold'] or topo['boundary']:raise ValueError(f'局部切割/cap未闭合 {topo}')
 return points,faces,w,image,dict(planesSource=spec['planes'],afterPartition=source_topo,cleanupRemovedFaces=removed_count,capFaces=added,
  generatedCapBounds=None if not added else [points[faces[selected]].min((0,1)).tolist(),points[faces[selected]].max((0,1)).tolist()],
  afterCap=topo,removedRegionBounds=None if removed is None else [removed[0].min(0).tolist(),removed[0].max(0).tolist()],
  capUv='原黄铜有效texel' if spec.get('shell') else '最近原源三角UV；局部内部封口，非新贴图'),v

def build(aid,spec):
 dest=STAGE/aid;dest.mkdir(parents=True,exist_ok=True)
 with tempfile.TemporaryDirectory(prefix='weapon-fit-cut-') as tmp:
  v,f,w,image,repair,raw_v=prepared(spec,tmp)
  r=p.rotation(spec['rotation'])
  if spec['scale']=='body':
   body=json.loads((ROOT/f'assets/art/models/{spec["owner"]}/lod-report.json').read_text(encoding='utf-8'));scale=np.array(body['scaleXYZ']);origin=np.array(body['originRotatedSource'])
   place=lambda points:(points@r.T-origin)*scale
  else:
   scale=np.array(spec['scale']);rv=(v*scale)@r.T;origin=np.array([(rv[:,0].min()+rv[:,0].max())/2,rv[:,1].min(),(rv[:,2].min()+rv[:,2].max())/2]);place=lambda points:(points*scale)@r.T-origin
  ref=place(v);expected=np.ptp(ref,axis=0)
  source_obj=surface.textured_source(tmp,v,f,w,image)
  geometry=Path(tmp)/'prepared.obj';p.write_wedges(geometry,v,f,w.reshape(-1,2))
  report=dict(id=aid,owner=spec['owner'],source=spec['source'],sourceHash=p.sha(ROOT/spec['source']),recipe=spec,pipelineHash=p.sha(__file__),
   helperHashes={Path(m.__file__).relative_to(ROOT).as_posix():p.sha(m.__file__) for m in [p,cut,dec,surface]},repair=repair,
   normalization='node-baked -> spatial edge-interpolated cut -> local cap -> explicit scaleXYZ / rotation -> parser XZcenter/Yfloor',
   scaleXYZ=scale.tolist(),origin=origin.tolist(),sourceDimensions=np.ptp(raw_v,axis=0).tolist(),dimensionsM=expected.tolist(),status='visual-review-candidate',visual='pending',fit='pending-headed-slot',levels=[])
  for lod,target in enumerate(spec['targets']):
   print(aid,lod,'start protected-QEM',target,flush=True)
   ms=pymeshlab.MeshSet();ms.load_new_mesh(str(geometry));ms.meshing_remove_duplicate_vertices()
   ms.meshing_decimation_quadric_edge_collapse(targetfacenum=target,qualitythr=.3,preserveboundary=False,preservetopology=True,optimalplacement=True,planarquadric=True,selected=False)
   topology_floor=ms.current_mesh().face_number();cleanup=None
   print(aid,lod,'protected result',topology_floor,flush=True)
   if topology_floor>target:
    # Valve/rim 的源微孔属高genus，拓扑保护有真实floor。只在props保留外形/预算，显式记录微孔消失。
    if spec['scale']=='body':raise ValueError('本体拓扑保护未达到预算')
    ms=pymeshlab.MeshSet();ms.load_new_mesh(str(geometry));ms.meshing_remove_duplicate_vertices()
    ms.meshing_decimation_quadric_edge_collapse(targetfacenum=int(target*.85),qualitythr=.3,preserveboundary=False,preservetopology=False,optimalplacement=True,planarquadric=True,selected=False)
    print(aid,lod,'geometry-QEM result',ms.current_mesh().face_number(),flush=True)
    before=ms.current_mesh().face_number();native=ms.current_mesh();qem_topo=dec._topo(native.vertex_matrix(),native.face_matrix())
    print(aid,lod,'fallback topology',qem_topo,flush=True)
    if qem_topo['nonmanifold']:ms.meshing_repair_non_manifold_edges(method='Remove Faces')
    deleted=before-ms.current_mesh().face_number();native=ms.current_mesh();remaining=dec._topo(native.vertex_matrix(),native.face_matrix())
    if remaining['boundary']:ms.set_selection_none();ms.meshing_close_holes(maxholesize=200,selfintersection=False)
    cleanup=dict(topologyProtectedFloor=topology_floor,geometryTarget=int(target*.85),removedFaces=deleted,addedCapFaces=ms.current_mesh().face_number()-(before-deleted),
     policy='props高genus微孔可丢失；保外部轮廓，局部封QEM新孔，仍需GPU验证阀/底火')
   m=ms.current_mesh();points,faces=m.vertex_matrix(),m.face_matrix()
   pending=dec._topo(points,faces)
   if pending['boundary'] and not pending['nonmanifold']:
    points,faces,local_added=cut.cap_boundary(points,faces)
    ms=pymeshlab.MeshSet();ms.add_mesh(pymeshlab.Mesh(vertex_matrix=points,face_matrix=faces),'locally-capped');m=ms.current_mesh()
    cleanup={**(cleanup or {}),'explicitSimpleBoundaryCapFaces':local_added}
   topo=dec._topo(points,faces)
   if len(faces)>target or topo['nonmanifold'] or topo['boundary']:raise ValueError(f'{aid} LOD{lod}硬预算/闭合失败 {topo}')
   print(aid,lod,'start atlas',len(faces),flush=True)
   uv,encoded,transfer=surface.transfer(source_obj,points,faces,np.zeros((len(faces)*3,2)),tmp,f'{aid}_lod{lod}')
   transfer['sampleError']=surface.color_error(source_obj,points,faces,uv,Image.open(BytesIO(encoded)))
   texture=f'{aid}_lod{lod}_basecolor.png';(dest/texture).write_bytes(encoded);transfer.update(textureFile=texture,textureHash=p.sha(dest/texture))
   placed=place(points)
   # 非均匀变换后在最终geometry计算角法线，等价逆转置平面法线；不错误乘rotation代替。
   normal_mesh=pymeshlab.MeshSet();normal_mesh.add_mesh(pymeshlab.Mesh(vertex_matrix=placed,face_matrix=faces),'placed');normals=normal_mesh.current_mesh().vertex_normal_matrix()
   placed,output_faces,normals,repaired_normals=surface.consistent_corner_normals(placed,faces,normals)
   file=dest/f'{aid}_lod{lod}.glb';pairs=[[(int(vi),i*3+k) for k,vi in enumerate(tri)] for i,tri in enumerate(output_faces)]
   dec.build_glb(str(file),placed,pairs,uv,encoded,'image/png',N=normals);p.helper.tag_glb(file,dict(id=aid,level=f'LOD{lod}',sourceHash=report['sourceHash'],algorithm='spatial-cut-cap+topology-QEM+source-atlas',targetFaces=target))
   row=dict(level=lod,file=file.name,hash=p.sha(file),triangles=len(faces),topology=topo,qemRepair=cleanup,dimensionsM=np.ptp(placed,axis=0).tolist(),
    surfaceRatio=dec.tri_area(points,faces)/dec.tri_area(v,f),boundsDrift=float(np.max(abs(np.ptp(placed,axis=0)/expected-1))),silhouetteIoU=p.silhouette(points,faces,v,f),
    parserRecenterMeters=[float((placed[:,0].min()+placed[:,0].max())/2),float(placed[:,1].min()),float((placed[:,2].min()+placed[:,2].max())/2)],surfaceTransfer=transfer,textureSize=[1024,1024],visual='pending')
   report['levels'].append(row);print(aid,lod,len(faces),topo,'RGB',round(transfer['sampleError']['meanAbsoluteRgbError'],2),flush=True)
  p.write_json(dest/'fit-report.json',report)

def main():
 cli=argparse.ArgumentParser();cli.add_argument('--only',nargs='+',required=True);cli.add_argument('--publish',action='store_true');args=cli.parse_args()
 if set(args.only)-set(SPECS):cli.error('未知派生ID')
 for aid in args.only:
  if not args.publish:build(aid,SPECS[aid]);continue
  src=STAGE/aid;report=json.loads((src/'fit-report.json').read_text(encoding='utf-8'))
  if report['recipe']!=json.loads(json.dumps(SPECS[aid])) or report['pipelineHash']!=p.sha(__file__) or report['sourceHash']!=p.sha(ROOT/report['source']):raise ValueError('过期派生配方/源')
  for file,hash in report['helperHashes'].items():
   if p.sha(ROOT/file)!=hash:raise ValueError('过期helper')
  dest=ROOT/f'assets/art/models/{report["owner"]}/game_ready';dest.mkdir(parents=True,exist_ok=True)
  for row in report['levels']:
   if p.sha(src/row['file'])!=row['hash'] or row['triangles']>report['recipe']['targets'][row['level']]:raise ValueError('派生hash/预算失败')
   shutil.copyfile(src/row['file'],dest/row['file']);t=row['surfaceTransfer']
   if p.sha(src/t['textureFile'])!=t['textureHash']:raise ValueError('贴图hash失配')
   shutil.copyfile(src/t['textureFile'],dest/t['textureFile'])
  p.write_json(dest.parent/f'{aid}-fit-report.json',report);print('发布待fit派生',aid,flush=True)
if __name__=='__main__':main()
