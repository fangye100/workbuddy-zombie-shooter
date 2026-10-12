import importlib.util
import json
from pathlib import Path
import struct
import unittest

spec=importlib.util.spec_from_file_location('ergonomic_scale',Path(__file__).with_name('rescale-launcher-assembly.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

def fixture():
    binary=struct.pack('<ffffff',-2,0,1,2,4,-1)+b'NORMAL-UV-INDEX-TEXTURE!!'
    binary+=b'\0'*((-len(binary))%4)
    # 同一POSITION被两个primitive引用，不能缩两次。
    js=dict(nodes=[dict(mesh=0)],meshes=[dict(primitives=[dict(attributes=dict(POSITION=0)),dict(attributes=dict(POSITION=0))])],
            accessors=[dict(bufferView=0,type='VEC3',componentType=5126,count=2)],bufferViews=[dict(byteOffset=0,byteLength=24)],buffers=[dict(byteLength=len(binary))])
    payload=json.dumps(js).encode();payload+=b' '*((-len(payload))%4)
    return struct.pack('<III',0x46546C67,2,28+len(payload)+len(binary))+struct.pack('<II',len(payload),0x4E4F534A)+payload+struct.pack('<II',len(binary),0x004E4942)+binary

class ScaleTests(unittest.TestCase):
    def test_shared_position_scales_once_and_preserves_remaining_bytes(self):
        original=fixture();scaled,stats=module.scale_glb(original,.9)
        js,bd=module.unpack_glb(scaled);oldjs,oldbd=module.unpack_glb(original)
        self.assertAlmostEqual(struct.unpack_from('<f',bd)[0],-1.8,places=6)
        self.assertEqual(bd[24:],oldbd[24:]);self.assertEqual(module.non_position_hash(js,bd),module.non_position_hash(oldjs,oldbd))
        self.assertAlmostEqual(stats['dimensionsM'][1],3.6,places=6)
        self.assertAlmostEqual(stats['parserRecenterMeters'][0],0)
        self.assertEqual(js['accessors'][0]['min'],[-1.7999999523162842,0,-.8999999761581421])
    def test_invalid_scale_and_truncated_header_rejected(self):
        for factor in (0,-1,float('nan')):
            with self.assertRaises(ValueError):module.scale_glb(fixture(),factor)
        with self.assertRaises(ValueError):module.scale_glb(fixture()[:-4],.9)
    def test_unbaked_node_rejected(self):
        js,bd=module.unpack_glb(fixture());js['nodes'][0]['scale']=[2,2,2]
        with self.assertRaises(ValueError):module.position_ranges(js,bd)

if __name__=='__main__':unittest.main()
