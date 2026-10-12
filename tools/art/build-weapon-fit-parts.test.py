"""区域切割插值、局部封口与实际发布资产硬约束；可视槽口不由数值批准。"""
import importlib.util,json,unittest
from pathlib import Path
import numpy as np
spec=importlib.util.spec_from_file_location('fit',Path(__file__).with_name('build-weapon-fit-parts.py'));p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class FitPartsTests(unittest.TestCase):
 def test_spatial_cut_preserves_area_and_linear_source_uv(self):
  v=np.array([[0.,0,0],[2,0,0],[0,2,0]]);f=np.array([[0,1,2]]);uv=v[:,:2]/2
  outside,inside=p.cut.partition(v,f,uv,[(0,1,1)])
  self.assertAlmostEqual(sum(p.dec.tri_area(a,b) for a,b,_ in [outside,inside]),2)
  for points,faces,coords in [outside,inside]:np.testing.assert_allclose(coords,points[:,:2]/2);self.assertTrue(np.isfinite(points).all())
 def test_simple_cap_closes_real_hole_but_refuses_branching(self):
  v=np.array([[0.,0,0],[1,0,0],[0,1,0],[0,0,1]]);f=np.array([[0,1,3],[1,2,3],[2,0,3]])
  points,faces,n=p.cut.cap_boundary(v,f);self.assertEqual(n,1);self.assertEqual(p.dec._topo(points,faces)['boundary'],0)
  with self.assertRaisesRegex(ValueError,'分叉'):p.cut.cap_boundary(v,np.array([[0,1,2],[0,1,3]]))
 def test_all_published_parts_have_budget_closed_welded_geometry_and_source_provenance(self):
  for aid,spec in p.SPECS.items():
   report=json.loads((p.ROOT/f'assets/art/models/{spec["owner"]}/{aid}-fit-report.json').read_text(encoding='utf-8'))
   self.assertEqual(report['sourceHash'],p.p.sha(p.ROOT/report['source']));self.assertEqual(report['pipelineHash'],p.p.sha(p.__file__))
   for file,digest in report['helperHashes'].items():self.assertEqual(p.p.sha(p.ROOT/file),digest)
   for row in report['levels']:
    file=p.ROOT/f'assets/art/models/{spec["owner"]}/game_ready'/row['file'];v,f,uv,texture=p.dec.load_raw(file)
    self.assertEqual(p.p.sha(file),row['hash']);self.assertEqual(len(f),row['triangles']);self.assertLessEqual(len(f),spec['targets'][row['level']])
    points,mapping=np.unique(np.round(v,7),axis=0,return_inverse=True);topo=p.dec._topo(points,mapping[f]);self.assertEqual(topo['nonmanifold'],0,aid);self.assertEqual(topo['boundary'],0,aid)
    self.assertTrue(np.isfinite(v).all() and np.isfinite(uv).all());self.assertLessEqual(max(row['textureSize']),1024)
    self.assertEqual(report['status'],'visual-review-candidate')
if __name__=='__main__':unittest.main()
