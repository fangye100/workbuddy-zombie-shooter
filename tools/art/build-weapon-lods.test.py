"""配方空间和参考尺度回归；完整 GLB/预算/hash 由 prepare-weapon-lod-review --check 校验。"""
import importlib.util, unittest, tempfile
from pathlib import Path
import numpy as np
from PIL import Image
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

class SurfaceTransferTests(unittest.TestCase):
 def test_native_bake_preserves_known_vertical_color_gradient(self):
  # 原生 closest-surface texel 栅格要求 source bounds 三轴非退化。
  v=np.array([[0,0,0],[1,0,0],[1,1,.05],[0,1,0]],dtype=float);f=np.array([[0,1,2],[0,2,3]])
  uv=v[:,:2]
  y,x=np.mgrid[0:64,0:64];im=Image.fromarray(np.stack([x*4,y*4,np.full_like(x,100)],axis=-1).astype('uint8'))
  with tempfile.TemporaryDirectory() as temp:
   src=pipeline.surface.textured_source(temp,v,f,uv[f],im)
   w,encoded,_=pipeline.surface.transfer(src,v,f,uv[f],temp,'gradient')
   bary=np.array([[1/3]*3,[.6,.2,.2],[.2,.6,.2],[.2,.2,.6]])
   points=np.einsum('kc,fcj->fkj',bary,v[f]).reshape(-1,3)
   coords=np.einsum('kc,fcj->fkj',bary,w.reshape(-1,3,2)).reshape(-1,2)
   colors=pipeline.surface.sample_rgb(Image.open(pipeline.BytesIO(encoded)),coords)
   expected=np.column_stack([points[:,:2]*252,np.full(len(points),100)])
   self.assertLess(float(np.mean(np.abs(colors-expected))),3)
 def test_normal_repair_keeps_positions_and_unaffected_corner_normals(self):
  v=np.array([[0,0,0],[1,0,0],[0,1,0]],dtype=float);f=np.array([[0,1,2]])
  good=np.tile([0,0,1.],(3,1))
  p,ff,n,count=pipeline.surface.consistent_corner_normals(v,f,good)
  np.testing.assert_allclose(p[ff],v[f]);np.testing.assert_allclose(n,good);self.assertEqual(count,0)
  p,ff,n,count=pipeline.surface.consistent_corner_normals(v,f,-good)
  np.testing.assert_allclose(p[ff],v[f]);np.testing.assert_allclose(n,good);self.assertEqual(count,1)
if __name__=='__main__':unittest.main()
