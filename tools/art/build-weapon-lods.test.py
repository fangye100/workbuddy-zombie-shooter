"""配方空间和参考尺度回归；完整 GLB/预算/hash 由 prepare-weapon-lod-review --check 校验。"""
import importlib.util, unittest
from pathlib import Path
import numpy as np
spec=importlib.util.spec_from_file_location('weapon_pipeline',Path(__file__).with_name('build-weapon-lods.py'))
pipeline=importlib.util.module_from_spec(spec);spec.loader.exec_module(pipeline)
class PlacementTests(unittest.TestCase):
 def test_launcher_barrel_points_positive_x_after_node_baked_rotation(self):
  r=pipeline.rotation([0,90,0]);np.testing.assert_allclose(r@np.array([0,0,1]),[1,0,0],atol=1e-12)
 def test_uniform_normalization_preserves_aspect_and_bottom(self):
  v=np.array([[-2,-1,-4],[2,3,4]],dtype=float)
  r,s,origin,expected=pipeline.placement(v,dict(rotationDeg=[0,90,0],sourceLengthAxis=2,lengthM=.75))
  placed=(v@r.T-origin)*s
  self.assertAlmostEqual(np.ptp(placed,axis=0)[0],.75)
  self.assertAlmostEqual(placed[:,1].min(),0)
  np.testing.assert_allclose(np.ptp(placed,axis=0),expected)
 def test_fuel_reference_length_does_not_scale_to_hose_bounds(self):
  v=np.array([[0,0,0],[2,4,1]],dtype=float)
  _,scale,_,_=pipeline.placement(v,dict(rotationDeg=[0,0,90],sourceLengthAxis=0,lengthM=.25),reference_length=1)
  self.assertEqual(scale,.25)
 def test_reject_degenerate_and_nonfinite_source(self):
  recipe=dict(rotationDeg=[0,0,0],sourceLengthAxis=0,lengthM=.75)
  for v in [np.zeros((3,3)),np.array([[0,0,0],[float('nan'),1,1]])]:
   with self.assertRaises(ValueError):pipeline.placement(v,recipe)
if __name__=='__main__':unittest.main()
