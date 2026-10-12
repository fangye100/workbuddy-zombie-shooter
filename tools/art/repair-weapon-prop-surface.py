"""Fuel有界后处理：逐三角本面gutter；不改几何、减面或原交付。"""
import argparse,importlib.util,json,math,tempfile,shutil,hashlib
from pathlib import Path
from io import BytesIO
from datetime import datetime,timezone
import numpy as np
from PIL import Image

spec=importlib.util.spec_from_file_location('fit',Path(__file__).with_name('build-weapon-fit-parts.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
ROOT=p.ROOT;STAGE=ROOT/'.workbuddy/tmp/wpn-integration/prop-surface-repair'
IDS=['WPN-FUEL-01-fit-can']

def padded_atlas(source_obj,vertices,faces):
 """每格只填本三角最近重心点；不让全局pull-push取邻chart颜色作gutter。"""
 side=math.ceil(math.sqrt(len(faces)));cell=1024//side;pad=6
 if cell<=2*pad+4:raise ValueError('当前局部props atlas格太小')
 uv=[];positions=[];indices=[]
 yy,xx=np.mgrid[:cell,:cell];a=(xx.ravel()+.5-pad)/(cell-2*pad);b=(yy.ravel()+.5-pad)/(cell-2*pad)
 # Euclidean nearest point on the right triangle (0,0),(1,0),(0,1).
 a=np.maximum(a,0);b=np.maximum(b,0);over=a+b>1;delta=(a[over]+b[over]-1)/2
 a[over]=np.clip(a[over]-delta,0,1);b[over]=1-a[over];weights=np.column_stack([1-a-b,a,b])
 for i,face in enumerate(faces):
  x=i%side*cell;y=i//side*cell
  uv.append(np.array([[x+pad,y+pad],[x+cell-pad,y+pad],[x+pad,y+cell-pad]])/1024)
  positions.append(weights@vertices[face]);indices.append((yy.ravel()+y)*1024+xx.ravel()+x)
 ms=p.pymeshlab.MeshSet();ms.load_new_mesh(str(source_obj));ms.add_mesh(p.pymeshlab.Mesh(vertex_matrix=np.concatenate(positions)),'texel-and-gutter-probes')
 ms.transfer_texture_to_color_per_vertex(sourcemesh=0,targetmesh=1,upperbound=p.pymeshlab.PercentageValue(10))
 rgb=np.clip(np.rint(ms.current_mesh().vertex_color_matrix()[:,:3]*255),0,255).astype(np.uint8).reshape(len(faces),cell*cell,3)
 atlas=np.zeros((1024*1024,3),dtype=np.uint8);atlas[np.concatenate(indices)]=rgb.reshape(-1,3)
 # Unused last cells are never referenced; avoid black at the outer texture boundary.
 atlas=atlas.reshape(1024,1024,3);used=side*cell
 atlas[used:,:used]=atlas[used-1:used,:used];atlas[:,used:]=atlas[:,used-1:used]
 image=Image.fromarray(atlas);encoded=BytesIO();image.save(encoded,format='PNG')
 return np.asarray(uv).reshape(-1,2),encoded.getvalue(),dict(method='independent square cells; source-surface colour at nearest point on the SAME target triangle including gutter',resolution=[1024,1024],cellPixels=cell,gutterPixels=pad,pullPush=False,texelSamples=len(faces)*cell*cell)

def mip_edge_error(source_obj,vertices,faces,old_uv,old_texture,new_uv,new_texture):
 """真实normalized UV线性采样口径：texel=UV*size-.5；有界LOD0..3 mip比较。"""
 bary=np.array([[1/3]*3,[.4999,.4999,.0002],[.4999,.0002,.4999],[.0002,.4999,.4999]])
 positions=np.einsum('kc,fcj->fkj',bary,vertices[faces]).reshape(-1,3)
 ms=p.pymeshlab.MeshSet();ms.load_new_mesh(str(source_obj));ms.add_mesh(p.pymeshlab.Mesh(vertex_matrix=positions),'mip-edge-probes')
 ms.transfer_texture_to_color_per_vertex(sourcemesh=0,targetmesh=1,upperbound=p.pymeshlab.PercentageValue(10));expected=ms.current_mesh().vertex_color_matrix()[:,:3]*255
 def bilinear(image,coords):
  pixels=np.asarray(image.convert('RGB'),dtype=float);xy=np.clip(coords*np.array(image.size)-.5,0,np.array(image.size)-1);lo=np.floor(xy).astype(int);hi=np.minimum(lo+1,np.array(image.size)-1);w=xy-lo
  return pixels[lo[:,1],lo[:,0]]*(1-w[:,0,None])*(1-w[:,1,None])+pixels[lo[:,1],hi[:,0]]*w[:,0,None]*(1-w[:,1,None])+pixels[hi[:,1],lo[:,0]]*(1-w[:,0,None])*w[:,1,None]+pixels[hi[:,1],hi[:,0]]*w[:,0,None]*w[:,1,None]
 result={}
 for name,uv,encoded in [('before',old_uv,old_texture),('after',new_uv,new_texture)]:
  coords=np.einsum('kc,fcj->fkj',bary,uv.reshape(-1,3,2)).reshape(-1,2);image=Image.open(BytesIO(encoded));result[name]=[]
  for level in range(4):
   size=1024//2**level;error=np.mean(abs(bilinear(image.resize((size,size),Image.Resampling.BOX),coords)-expected),axis=1).reshape(-1,4)
   result[name].append(dict(level=level,size=size,centerMeanRgb=float(error[:,0].mean()),edgeMeanRgb=float(error[:,1:].mean()),edgeFractionAbove40=float((error[:,1:]>40).mean())))
 return dict(policy='same source surface and identical geometry; bilinear normalized-UV texel centres, box mip0..3 (1024..128); neither anisotropic GPU/pixels nor art approval',**result)

def build(aid):
 recipe=p.SPECS[aid]
 # Original deterministic cut/QEM outputs are reused, not another reduction pass.
 original=json.loads((p.STAGE/aid/'fit-report.json').read_text(encoding='utf8'))
 if original['sourceHash']!=p.p.sha(ROOT/original['source']):raise ValueError('原源hash改变')
 output=STAGE/aid;output.mkdir(parents=True,exist_ok=True)
 with tempfile.TemporaryDirectory(prefix='prop-surface-') as td:
  ref,rf,rw,image,repair,raw=p.prepared(recipe,td);obj=p.surface.textured_source(td,ref,rf,rw,image)
  r=p.p.rotation(recipe['rotation']);scale=np.array(original['scaleXYZ']);origin=np.array(original['origin'])
  for row in original['levels']:
   file=p.STAGE/aid/row['file']
   if p.p.sha(file)!=row['hash']:raise ValueError('原减面stage hash不符；请先执行原build recipe')
   points,faces,old_uv,old_tex=p.dec.load_raw(file);js,bd=p.dec.read_glb(file);prim=js['meshes'][0]['primitives'][0];normals=p.dec.read_acc(js,bd,prim['attributes']['NORMAL'])
   source=(points+origin)@r/scale
   uv,encoded,transfer=padded_atlas(obj,source,faces)
   transfer['mipEdgeComparison']=mip_edge_error(obj,source,faces,old_uv,old_tex,uv,encoded)
   if len(faces)>recipe['targets'][row['level']]:raise ValueError('原geometry超预算')
   welded,mapping=np.unique(np.round(points,7),axis=0,return_inverse=True);topo=p.dec._topo(welded,mapping[faces])
   if topo['boundary'] or topo['nonmanifold']:raise ValueError('原geometry未闭合')
   pairs=[[(int(vi),i*3+k) for k,vi in enumerate(tri)] for i,tri in enumerate(faces)]
   dest=output/row['file'];p.dec.build_glb(str(dest),points,pairs,uv,encoded,'image/png',N=normals)
   output_v,output_f,_,_=p.dec.load_raw(dest);output_js,output_bd=p.dec.read_glb(dest);output_n=p.dec.read_acc(output_js,output_bd,output_js['meshes'][0]['primitives'][0]['attributes']['NORMAL'])
   if not np.array_equal(points[faces],output_v[output_f]) or not np.array_equal(normals[faces],output_n[output_f]):raise ValueError('仅贴图后处理意外改变geometry/normal')
   texture=row['surfaceTransfer']['textureFile'];(output/texture).write_bytes(encoded)
   previous=dict(glbHash=row['hash'],surfaceTransfer=row['surfaceTransfer'])
   row.update(hash=p.p.sha(dest),triangles=len(faces),topology=topo,surfaceTransfer={**transfer,'textureFile':texture,'textureHash':p.p.sha(output/texture)},surfacePostprocess=dict(input=previous,geometryCornerSha256=hashlib.sha256(points[faces].astype('<f4').tobytes()).hexdigest(),normalCornerSha256=hashlib.sha256(normals[faces].astype('<f4').tobytes()).hexdigest(),tool='tools/art/repair-weapon-prop-surface.py',toolHash=p.p.sha(__file__)))
   print(aid,row['level'],row['triangles'],transfer['cellPixels'],flush=True)
  original['surfacePostprocess']=dict(tool='tools/art/repair-weapon-prop-surface.py',toolHash=p.p.sha(__file__),status='visual-review-candidate',sourceUnchanged=True,positionsUnchanged=True,scope='independently padded source-transfer atlas; geometry unchanged; GPU pending')
  p.p.write_json(output/'fit-report.json',original)

def publish(aid):
 recipe=p.SPECS[aid];output=STAGE/aid;report=json.loads((output/'fit-report.json').read_text(encoding='utf8'));base=ROOT/f'assets/art/models/{recipe["owner"]}';dest=base/'game_ready'
 if report['surfacePostprocess']['toolHash']!=p.p.sha(__file__) or report['sourceHash']!=p.p.sha(ROOT/report['source']):raise ValueError('后处理过期')
 for row in report['levels']:
  f=output/row['file'];t=row['surfaceTransfer']
  if p.p.sha(f)!=row['hash'] or p.p.sha(output/t['textureFile'])!=t['textureHash']:raise ValueError('后处理hash不符')
  shutil.copyfile(f,dest/row['file']);shutil.copyfile(output/t['textureFile'],dest/t['textureFile'])
  meta=dest/(row['file']+'.meta.json');data=json.loads(meta.read_text(encoding='utf8'));data['sourceHash']='sha256:'+row['hash'];data['updatedAt']=datetime.now(timezone.utc).isoformat();p.p.write_json(meta,data)
 p.p.write_json(base/f'{aid}-fit-report.json',report)

if __name__=='__main__':
 cli=argparse.ArgumentParser();cli.add_argument('--only',choices=IDS,nargs='+',required=True);cli.add_argument('--publish',action='store_true');args=cli.parse_args()
 for aid in args.only:(publish if args.publish else build)(aid)
