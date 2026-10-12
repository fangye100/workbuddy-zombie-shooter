"""Launcher 人体工学后处理：已发布三档本体/round统一0.90；不重减面、重采样或封底火。"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[2]
FACTOR = .90
REPORTS = [('WPN-07-LAUNCHER', 'lod-report.json'),
           ('WPN-SHELL-01', 'WPN-07-LAUNCHER-round-derived-fit-report.json')]

def sha(b): return hashlib.sha256(b).hexdigest()
def read(p): return json.loads(p.read_text(encoding='utf-8'))
def encoded(d): return (json.dumps(d, ensure_ascii=False, indent=2)+'\n').encode('utf-8')

def unpack_glb(data):
    if len(data)<28 or struct.unpack_from('<III',data)!= (0x46546C67,2,len(data)):
        raise ValueError('GLB header/length不符')
    chunks=[];offset=12
    while offset<len(data):
        length,kind=struct.unpack_from('<II',data,offset);offset+=8
        if length%4 or offset+length>len(data): raise ValueError('GLB chunk越界')
        chunks.append((kind,data[offset:offset+length]));offset+=length
    if [k for k,_ in chunks]!=[0x4E4F534A,0x004E4942]: raise ValueError('只接受单JSON/BIN刚体GLB')
    return json.loads(chunks[0][1]),bytearray(chunks[1][1])

def position_ranges(js,bd):
    if js.get('skins') or js.get('animations'): raise ValueError('不能缩放骨架/动画')
    for n in js.get('nodes',[]):
        if any(k in n for k in ('matrix','translation','rotation','scale')):
            raise ValueError('需要已node-baked的identity节点')
    accessors={p['attributes']['POSITION'] for m in js['meshes'] for p in m['primitives']}
    ranges=[]
    for index in sorted(accessors):
        acc=js['accessors'][index];view=js['bufferViews'][acc['bufferView']]
        if acc.get('sparse') or acc['type']!='VEC3' or acc['componentType']!=5126 or view.get('buffer',0)!=0:
            raise ValueError('POSITION不是本地float32 VEC3')
        stride=view.get('byteStride',12);start=view.get('byteOffset',0)+acc.get('byteOffset',0)
        if stride<12 or start+(acc['count']-1)*stride+12>len(bd): raise ValueError('POSITION越界')
        ranges.append((index,acc,[start+i*stride for i in range(acc['count'])]))
    return ranges

def non_position_hash(js,bd):
    masked=bytearray(bd)
    for _,_,offsets in position_ranges(js,bd):
        for offset in offsets: masked[offset:offset+12]=b'\0'*12
    return sha(masked)

def scale_glb(data,factor):
    if not math.isfinite(factor) or factor<=0: raise ValueError('scale必须正有限')
    js,bd=unpack_glb(data);before=non_position_hash(js,bd);bounds=[]
    for _,acc,offsets in position_ranges(js,bd):
        points=[]
        for offset in offsets:
            p=struct.unpack_from('<fff',bd,offset)
            if not all(math.isfinite(v) for v in p): raise ValueError('非有限POSITION')
            struct.pack_into('<fff',bd,offset,*(v*factor for v in p))
            points.append(struct.unpack_from('<fff',bd,offset))
        acc['min']=[min(p[k] for p in points) for k in range(3)]
        acc['max']=[max(p[k] for p in points) for k in range(3)]
        bounds.extend(points)
    if non_position_hash(js,bd)!=before: raise ValueError('非位置BIN发生变化')
    payload=json.dumps(js,separators=(',',':')).encode();payload+=b' '*((-len(payload))%4)
    total=12+8+len(payload)+8+len(bd)
    glb=struct.pack('<III',0x46546C67,2,total)+struct.pack('<II',len(payload),0x4E4F534A)+payload+struct.pack('<II',len(bd),0x004E4942)+bd
    low=[min(p[k] for p in bounds) for k in range(3)];high=[max(p[k] for p in bounds) for k in range(3)]
    return glb,dict(nonPositionBinHash=before,dimensionsM=[high[k]-low[k] for k in range(3)],
                    parserRecenterMeters=[(low[0]+high[0])/2,low[1],(low[2]+high[2])/2])

def run(check=False):
    planned=[];summaries=[]
    for owner,name in REPORTS:
        report_path=ROOT/f'assets/art/models/{owner}/{name}';report=read(report_path)
        if sha((ROOT/report['source']).read_bytes())!=report['sourceHash']: raise ValueError('原source漂移')
        post=report.get('ergonomicNormalization')
        if post:
            if post['factor']!=FACTOR: raise ValueError('已有不同人体工学倍率')
            for level in report['levels']:
                p=report_path.parent/'game_ready'/level['file'];data=p.read_bytes();meta=read(Path(str(p)+'.meta.json'));js,bd=unpack_glb(data)
                if level['hash']!=sha(data) or meta['sourceHash']!='sha256:'+sha(data): raise ValueError('输出/meta hash漂移')
                if non_position_hash(js,bd)!=level['ergonomicNormalization']['nonPositionBinHash']: raise ValueError('UV/法线/纹理/索引发生变化')
            summaries.append(dict(owner=owner,status='already-0.90-candidate',levels=len(report['levels'])));continue
        if check: raise ValueError('未执行0.90后处理')
        baseline=dict(dimensionsM=report['dimensionsM'],scaleXYZ=report['scaleXYZ'])
        report['ergonomicNormalization']=dict(factor=FACTOR,baseHead='f5ac7bbd7c8c771e2a3273009cf32142371b819b',baseNormalization=baseline,
            processor='tools/art/rescale-launcher-assembly.py',processorHash=sha(Path(__file__).read_bytes()),
            reason='真实肩链423帧与颈肩局部界驱动的一档等比修正；本体/round/槽/三LOD统一；不证明全空间最优或GPU通过',
            policy='只改POSITION和accessor bounds；保持UV/NORMAL/indices/embedded texture/cap逐字节，旧底火仍待用户新版源',visual='pending-headed')
        report['scaleXYZ']=[n*FACTOR for n in report['scaleXYZ']];report['dimensionsM']=[n*FACTOR for n in report['dimensionsM']]
        if owner=='WPN-SHELL-01': report['origin']=[n*FACTOR for n in report['origin']]
        for level in report['levels']:
            p=report_path.parent/'game_ready'/level['file'];data=p.read_bytes();meta_path=Path(str(p)+'.meta.json');meta=read(meta_path)
            if level['hash']!=sha(data) or meta['sourceHash']!='sha256:'+sha(data): raise ValueError('输入hash失配，拒绝部分发布')
            glb,stats=scale_glb(data,FACTOR)
            level['ergonomicNormalization']=dict(previousGlbHash=level['hash'],**stats)
            level['hash']=sha(glb);level['dimensionsM']=stats['dimensionsM'];level['parserRecenterMeters']=stats['parserRecenterMeters'];level['visual']='pending'
            meta['sourceHash']='sha256:'+sha(glb);meta['userData']['ergonomicNormalization']=report['ergonomicNormalization']
            meta['userData']['canonicalToImportTranslation']=[-n for n in stats['parserRecenterMeters']]
            for socket in meta.get('modelSockets',{}).values(): socket['position']=[n*FACTOR for n in socket['position']]
            planned.extend([(p,glb),(meta_path,encoded(meta))])
        report['status']='visual-review-candidate';report['visual']='pending';planned.append((report_path,encoded(report)))
        summaries.append(dict(owner=owner,dimensionsM=report['dimensionsM'],factor=FACTOR,levels=len(report['levels'])))
    # 两组全数验证完成后才写；重跑不会重复缩放，也不会修改原source。
    for p,data in planned: p.write_bytes(data)
    print(json.dumps(summaries,ensure_ascii=False,indent=2))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');run(parser.parse_args().check)
