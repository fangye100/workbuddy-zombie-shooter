"""本体米制空间与输出硬约束；可视质量仍由 headed 检视判断。"""
import importlib.util,json,unittest
from pathlib import Path
import numpy as np
spec=importlib.util.spec_from_file_location('body_pipeline',Path(__file__).with_name('build-weapon-body-lods.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class BodyPlacementTests(unittest.TestCase):
 def test_confirmed_negative_x_muzzles_become_positive_z(self):
  np.testing.assert_allclose(p.pipeline.rotation([0,90,0])@[-1,0,0],[0,0,1],atol=1e-12)
 def test_uniform_scale_keeps_source_aspect_instead_of_forcing_spec_width_height(self):
  v=np.array([[-3,0,-.2],[3,2,.2]])
  r,s,o,size=p.pipeline.placement(v,dict(rotationDeg=[0,90,0],sourceLengthAxis=0,lengthM=.6))
  np.testing.assert_allclose(size,[.04,.2,.6],atol=1e-12)
  self.assertAlmostEqual(s,.1);self.assertEqual(float(((v@r.T-o)*s)[:,1].min()),0)
 def test_published_geometry_respects_budget_and_welded_topology(self):
  for aid in p.AXES:
   report=json.loads((p.ROOT/f'assets/art/models/{aid}/lod-report.json').read_text(encoding='utf-8'))
   for row in report['levels']:
    file=p.ROOT/f'assets/art/models/{aid}/game_ready'/row['file'];v,f,uv,tex=p.dec.load_raw(file)
    self.assertEqual(p.pipeline.sha(file),row['hash']);self.assertEqual(len(f),row['triangles'])
    self.assertLessEqual(len(f),report['recipe']['targets'][row['level']]);self.assertFalse(row['errors'])
    # 独立atlas产生wedge seam，位置焊接后再计算实际geometry topology。
    _,mapping=np.unique(np.round(v,7),axis=0,return_inverse=True);topo=p.dec._topo(np.unique(np.round(v,7),axis=0),mapping[f])
    self.assertEqual(topo['nonmanifold'],0,aid+str(row['level']))
    self.assertTrue(np.isfinite(v).all() and np.isfinite(uv).all())
    self.assertLessEqual(max(row['textureSize']),1024)
if __name__=='__main__':unittest.main()
