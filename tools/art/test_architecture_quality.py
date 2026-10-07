import importlib
import unittest
import numpy as np

quality = importlib.import_module('architecture-quality')


class ArchitectureQualityTests(unittest.TestCase):
    def setUp(self):
        self.points = np.array([[0.,0,0], [0,0,1], [1,0,1], [1,0,0]])
        self.faces = np.array([[0,1,2],[0,2,3]])
        self.reference = quality.ArchitectureReference(self.points,self.faces)

    def test_planar_retriangulation_remains_valid(self):
        metrics = self.reference.measure(self.points,np.array([[0,1,3],[1,2,3]]))
        self.assertEqual(quality.failures(metrics),[])

    def test_folded_roof_is_rejected_despite_same_footprint(self):
        points=self.points.copy();points[2,1]=.6
        metrics=self.reference.measure(points,self.faces)
        self.assertGreater(metrics['inventedSlopeAreaRatio'],.08)
        self.assertTrue(quality.failures(metrics))

    def test_parallel_displaced_surface_is_rejected(self):
        points=self.points.copy();points[:,1]=.1
        metrics=self.reference.measure(points,self.faces)
        self.assertEqual(metrics['inventedSlopeAreaRatio'],0)
        self.assertTrue(quality.failures(metrics))


if __name__=='__main__': unittest.main()
