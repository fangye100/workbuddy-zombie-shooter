"""P0 source -> independently simplified runtime LODs. Never overwrites sources.
Run using .workbuddy/tmp/art-python/Scripts/python.exe (pymeshlab, numpy, Pillow).
Numeric gates stage outputs; --publish requires the reviewed IDs explicitly.
"""
import argparse, hashlib, importlib.util, json, sys, tempfile, shutil
from pathlib import Path
from io import BytesIO
import numpy as np
import pymeshlab
from PIL import Image
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'assets/characters/_tools'))
import decimate_uvkeep as dec
spec = importlib.util.spec_from_file_location('environment_lods', ROOT/'assets/environment/_tools/build_environment_lods.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
STAGE = ROOT/'.workbuddy/tmp/p0-lods'
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def write_json(p, v):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
def build(e):
    aid=e['id']; source=ROOT/f'assets/art/sources/{aid}/{aid}_source.glb'
    js,_=dec.read_glb(source)
    if len([p for m in js['meshes'] for p in m['primitives']])!=1 or js.get('skins'):
        raise ValueError('Static single primitive source required')
    v,f,uv,tex=dec.load_raw(source) # includes glTF node transform: sources are already Y-up
    rotation=np.eye(3)
    for axis,degrees in enumerate(e['rotationDeg']):
        a=np.deg2rad(degrees); c,s=np.cos(a),np.sin(a)
        r=([ [1,0,0],[0,c,-s],[0,s,c] ] if axis==0 else [[c,0,s],[0,1,0],[-s,0,c]] if axis==1 else [[c,-s,0],[s,c,0],[0,0,1]])
        rotation=np.array(r)@rotation
    rotated=v@rotation.T
    scale=e['scaleMeters']/np.ptp(rotated,axis=0)['xyz'.index(e['scaleAxis'])]
    if 'pivotFraction' in e:
        source_origin=v.min(0)+np.ptp(v,axis=0)*e['pivotFraction']
        origin=source_origin@rotation.T
    else:
        lo,hi=rotated.min(0),rotated.max(0); origin=np.array([(lo[0]+hi[0])/2,lo[1],(lo[2]+hi[2])/2])
    expected=np.ptp(rotated,axis=0)*scale
    image=Image.open(BytesIO(tex)).convert('RGB')
    image.thumbnail((e['textureSize'],e['textureSize']),Image.Resampling.LANCZOS)
    buf=BytesIO(); image.save(buf,format='PNG'); encoded=buf.getvalue()
    out=STAGE/aid;out.mkdir(parents=True,exist_ok=True)
    report={'id':aid,'sourceHash':sha(source),'recipe':e,'sourceTriangles':len(f),
            'dimensions':expected.tolist(),'scale':scale,'pivot':origin.tolist(),
            'textureSize':list(image.size),'levels':[]}
    source_area=dec.tri_area(v,f)
    with tempfile.TemporaryDirectory(prefix='p0-lod-') as tmp:
        obj=str(Path(tmp)/'source.obj');dec.write_obj(obj,v,f,uv)
        for lod,target in enumerate(e['targets']):
            ms=pymeshlab.MeshSet();ms.load_new_mesh(obj);ms.meshing_remove_duplicate_vertices()
            source_topology=dec._topo(ms.current_mesh().vertex_matrix(),ms.current_mesh().face_matrix())
            ms.meshing_decimation_quadric_edge_collapse_with_texture(targetfacenum=target,qualitythr=.6,
                extratcoordw=1.0,preserveboundary=True,boundaryweight=1.0,optimalplacement=True,planarquadric=True)
            m=ms.current_mesh();points=m.vertex_matrix();faces=m.face_matrix();wedges=m.wedge_tex_coord_matrix()
            topology=dec._topo(points,faces); area=dec.tri_area(points,faces)/source_area
            placed=(points@rotation.T-origin)*scale
            normals=m.vertex_normal_matrix()@rotation.T
            normals/=np.maximum(np.linalg.norm(normals,axis=1,keepdims=True),1e-12)
            drift=float(np.max(np.abs(np.ptp(placed,axis=0)/expected-1)))
            errors=[]
            if not np.isfinite(placed).all() or not np.isfinite(wedges).all():errors.append('Nonfinite attributes')
            if not .9<=area<=1.1:errors.append(f'Surface ratio {area:.4f}')
            if drift>.05:errors.append(f'Bounds drift {drift:.4f}')
            if abs(len(faces)/target-1)>.05:errors.append('Triangle target missed')
            if any(topology[k]>source_topology[k] for k in ['boundary','nonmanifold']):errors.append('Topology worsened')
            file=out/f'{aid}_lod{lod}.glb'
            pairs=[[(int(vi),i*3+k) for k,vi in enumerate(tri)] for i,tri in enumerate(faces)]
            dec.build_glb(str(file),placed,pairs,wedges,encoded,'image/png',N=normals)
            helper.tag_glb(file,{'id':aid,'level':f'LOD{lod}','algorithm':'p0-uvkeep-independent',
                'sourceHash':report['sourceHash'],'targetFaces':target})
            row={'level':lod,'file':file.name,'triangles':len(faces),'surfaceRatio':area,'boundsDrift':drift,
                 'sourceTopology':source_topology,'topology':topology,'hash':sha(file),'errors':errors,'visual':'pending'}
            report['levels'].append(row)
            print(aid,'LOD'+str(lod),len(faces),'area',round(area,4),'drift',round(drift,4),errors,flush=True)
    write_json(out/'report.json',report)
    return report
def main():
    p=argparse.ArgumentParser();p.add_argument('--only',nargs='+');p.add_argument('--publish',action='store_true');a=p.parse_args()
    entries=json.loads((ROOT/'assets/art/p0-intake.json').read_text(encoding='utf-8'))['models']
    entries=[e for e in entries if e['status']=='delivered' and (not a.only or e['id'] in a.only)]
    if a.only and set(a.only)!={e['id'] for e in entries}:raise ValueError('Unknown source ID')
    for e in entries:
        if not a.publish:build(e);continue
        aid=e['id'];r=json.loads((STAGE/aid/'report.json').read_text(encoding='utf-8'))
        if r['recipe']!=e or r['sourceHash']!=sha(ROOT/f'assets/art/sources/{aid}/{aid}_source.glb'):raise ValueError('Stale source/recipe')
        if len(r['levels'])!=3 or any(l['errors'] for l in r['levels']):raise ValueError('Failed numerical gates')
        for l in r['levels']:
            if sha(STAGE/aid/l['file'])!=l['hash']:raise ValueError('Stale LOD bytes')
        target=ROOT/f'assets/art/models/{aid}/game_ready';target.mkdir(parents=True,exist_ok=True)
        for l in r['levels']:shutil.copyfile(STAGE/aid/l['file'],target/l['file'])
        write_json(target.parent/'lod-report.json',r)
        print('Published numeric-accepted LODs; visual review remains required:',aid,flush=True)
if __name__=='__main__': main()
