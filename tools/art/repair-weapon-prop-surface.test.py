"""atlas gutter来源必须属于本三角，不能借邻chart颜色。"""
import importlib.util,tempfile,unittest
from pathlib import Path
from io import BytesIO
import numpy as np
from PIL import Image
spec=importlib.util.spec_from_file_location('repair',Path(__file__).with_name('repair-weapon-prop-surface.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class PropSurfaceTests(unittest.TestCase):
 def test_gutter_uses_same_face_colour_instead_of_neighbour_chart_pull_push(self):
  v=np.array([[0.,0,0],[1,0,0],[0,1,0],[3,0,0],[4,0,0],[3,1,0]]);f=np.arange(6).reshape(2,3);u=np.array([[[.25,.5]]*3,[[.75,.5]]*3])
  image=Image.new('RGB',(16,16),'red');image.paste((0,0,255),(8,0,16,16))
  with tempfile.TemporaryDirectory() as td:
   source=p.p.surface.textured_source(td,v,f,u,image);uv,encoded,report=p.padded_atlas(source,v,f)
   rgb=np.array(Image.open(BytesIO(encoded)));cell=report['cellPixels'];self.assertFalse(report['pullPush'])
   np.testing.assert_array_equal(rgb[:cell,:cell],np.broadcast_to([255,0,0],(cell,cell,3)))
   np.testing.assert_array_equal(rgb[:cell,cell:cell*2],np.broadcast_to([0,0,255],(cell,cell,3)))
   self.assertTrue(np.isfinite(uv).all());self.assertLessEqual(rgb.shape[0],1024)
if __name__=='__main__':unittest.main()
