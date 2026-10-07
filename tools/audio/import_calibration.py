"""Import individually verified WAVs and emit an explicit scene-authoring seed."""
import argparse,json,shutil,hashlib,uuid
from pathlib import Path
from verify_audio import verify

def dump(p,value):
    p.parent.mkdir(parents=True,exist_ok=True)
    p.write_bytes((json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode('utf-8'))

def main():
    ap=argparse.ArgumentParser();ap.add_argument('delivery');args=ap.parse_args()
    root=Path(__file__).resolve().parents[2];source=(root/args.delivery).resolve()
    rows,failures=verify(source)
    if failures:raise ValueError('\n'.join(failures))
    target=root/'assets/audio/calibration'
    batch=json.loads((source/'batch.json').read_text(encoding='utf-8'))
    expected={'SFX-WPN-PISTOL-SHOT':3,'SFX-WPN-SMG-SHOT':4,'SFX-HIT-FLESH':4,'SFX-WPN-FLAME-LOOP':2,'SFX-E03-ACID-POOL':2,'SFX-E03-ACID-LAUNCH':3,'SFX-E02-POUNCE-WARN':3,'SFX-ENV-HIGHWAY-BED':1}
    if {c['id']:c['variants'] for c in batch['cues']}!=expected:raise ValueError('Incomplete calibration batch')
    cues=[]
    for entry in batch['cues']:
        cid=entry['id'];m=json.loads((source/cid/'delivery.json').read_text(encoding='utf-8'));refs=[]
        for v in m['variants']:
            origin=source/cid/v['file'];dest=target/cid/origin.name;dest.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(origin,dest);v['file']=dest.name
            rel=dest.relative_to(root).as_posix();mp=Path(str(dest)+'.meta.json')
            existing=json.loads(mp.read_text(encoding='utf-8')) if mp.exists() else {}
            guid=existing.get('guid','as_'+uuid.uuid5(uuid.NAMESPACE_URL,rel).hex[:24]);refs.append({'path':rel,'guid':guid})
            meta={**existing,'schemaVersion':1,'guid':guid,'kind':'audio','importer':existing.get('importer',{'normalizeHeightM':None,'weldTolerance':.0001,'upAxisFlip':False,'aoBakeFloor':None,'splitSubMeshes':True,'maxSubMeshes':8}),
              'bindings':existing.get('bindings',[]),'rig':existing.get('rig'),'animations':existing.get('animations'),
              'userData':{**existing.get('userData',{}),'cueId':cid,'deliveryVersion':'v02','status':'in-game-calibration'},
              'audio':{k:v.get(k) for k in ['channels','sampleRate','bitDepth','frames','loopStartSample','loopEndSample']},'sourceHash':'sha256:'+hashlib.sha256(dest.read_bytes()).hexdigest()}
            dump(mp,meta)
        dump(target/cid/'delivery.json',m)
        bus='ambience' if 'HIGHWAY' in cid else 'impact' if cid=='SFX-HIT-FLESH' else 'enemy' if cid.startswith('SFX-E0') else 'weapon'
        gain=.18 if bus=='ambience' else .27 if bus=='impact' else .7 if bus=='weapon' and entry['playback']=='one-shot' else .3
        cues.append({'id':cid,'variants':refs,'loop':entry['playback']=='loop','gain':gain,'priority':8 if 'WARN' in cid else 6 if bus=='weapon' else 4 if bus=='impact' else 3 if bus=='enemy' else 0,'cooldownSec':.1 if bus=='impact' else 0,'bus':bus})
    dump(target/'batch.json',batch)
    bind=lambda cue,rate=1,gain=1:{'cue':cue,'rate':rate,'gain':gain}
    pistol='SFX-WPN-PISTOL-SHOT';flame='SFX-WPN-FLAME-LOOP'
    config={'enabled':True,'masterGain':.65,'maxVoices':24,'maxImpactVoices':4,'decodedBudgetMiB':24,'distanceM':28,'warningDistanceM':18,'cues':cues,'ambience':bind('SFX-ENV-HIGHWAY-BED'),
      'weapons':{'pistol':{'fire':bind(pistol),'loop':None},'smg':{'fire':bind('SFX-WPN-SMG-SHOT'),'loop':None},
      'shotgun':{'fire':bind(pistol,.7),'loop':None},'sniper':{'fire':bind(pistol,.8),'loop':None},'launcher':{'fire':bind(pistol,.6,.7),'loop':None},
      'chainsaw':{'fire':None,'loop':bind(flame,.6,.7)},'flame':{'fire':None,'loop':bind(flame)}},
      'warnings':{'E-02':bind('SFX-E02-POUNCE-WARN')},'fleshHit':bind('SFX-HIT-FLESH'),'acidLaunch':bind('SFX-E03-ACID-LAUNCH'),'acidPool':bind('SFX-E03-ACID-POOL')}
    dump(target/'gameplay-audio.json',config)
    print(f'Imported {len(rows)} isolated WAVs. Shotgun/sniper/launcher/saw deliberately share provisional cues until dedicated assets arrive.')

if __name__=='__main__':main()
