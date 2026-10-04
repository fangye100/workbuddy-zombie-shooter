"""Focused regressions for placement, seam preservation and publish preflight."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
import build_environment_lods as build
from uv_chart_count import chart_sizes


class EnvironmentLodTests(unittest.TestCase):
    def test_placement_is_y_up_grounded_and_uses_wdh_contract(self):
        points = np.array([[x,y,z] for x in (-1,1) for y in (-2,2) for z in (-3,3)])
        linear, translation, matrix = build.placement(points, [8,4,2], [90,0,0])
        result = points @ linear.T + translation
        np.testing.assert_allclose(np.ptp(result, axis=0), [8,2,4])
        self.assertAlmostEqual(result[:,1].min(), 0)
        np.testing.assert_allclose((result.max(0)+result.min(0))[[0,2]], 0)
        np.testing.assert_allclose(np.array(matrix).reshape(4,4).T[:3,:3], linear)

    def test_uv_overlap_and_corner_contact_are_not_shared_edges(self):
        p=np.array([[0,0,0],[1,0,0],[0,1,0],[3,0,0],[4,0,0],[3,1,0]])
        uv=np.array([[0,0],[1,0],[0,1]]*2)
        self.assertEqual(chart_sizes(p,uv,np.array([[0,1,2],[3,4,5]])),[1,1])
        self.assertEqual(chart_sizes(p,uv,np.array([[0,1,2],[0,4,5]])),[1,1])
        self.assertEqual(chart_sizes(p,uv,np.array([[0,1,2],[1,0,5]])),[2])

    def test_incomplete_publish_is_rejected_before_touching_files(self):
        with self.assertRaisesRegex(ValueError, 'exactly LOD1 and LOD2'):
            build.publish({'levels': []})

    def test_bad_second_staged_hash_does_not_overwrite_first_delivered_lod(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); folder=root/'assets/environment/models/P-01'; stage=root/'stage'
            (folder/'tex2').mkdir(parents=True); (stage/'P-01').mkdir(parents=True)
            raw=folder/'P-01.glb'; raw.write_bytes(b'raw')
            config={'targets':[30,15]}
            (folder/'tex2/P-01_baked.glb.meta.json').write_text(json.dumps({'userData':{'lodBuild':config}}))
            (root/'assets/environment/props.json').write_text(json.dumps({'entries':[{'id':'P-01','footprint':[1,2,3]}]}))
            result={'id':'P-01','sourceHash':build.sha(raw),'config':config,'footprint':[1,2,3],'levels':[]}
            for i,file in enumerate(['P-01_baked.glb','P-01_lod2.glb'],1):
                (folder/'tex2'/file).write_bytes(b'original')
                staged=stage/'P-01'/file; staged.write_bytes(b'new')
                result['levels'].append({'level':f'LOD{i}','file':file,'failures':[],
                                        'sha256':build.sha(staged) if i==1 else 'wrong'})
            with patch.object(build,'ROOT',root), patch.object(build,'STAGE',stage):
                with self.assertRaisesRegex(ValueError,'staged hash mismatch'):
                    build.publish(result)
            self.assertEqual((folder/'tex2/P-01_baked.glb').read_bytes(),b'original')

    def test_compaction_preserves_uv_seams_and_every_render_corner(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'tiny.glb'
            p=np.array([[0.,0,0],[1,0,0],[0,1,0]])
            uv=np.array([[0.,0],[1,0],[0,1],[.2,.2]])
            n=np.array([[0.,0,1]]*3)
            pairs=[[(0,0),(1,1),(2,2)],[(0,3),(1,1),(2,2)]]
            build.dec.build_glb(str(path),p,pairs,uv,b'texture-bytes','image/png',N=n)
            before,bd=build.dec.read_glb(path)
            build.tag_glb(path,{'level':'LOD1'})
            after,ad=build.dec.read_glb(path)
            self.assertEqual(after['accessors'][0]['count'],4)
            for name in ('POSITION','TEXCOORD_0','NORMAL'):
                def corners(js,blob):
                    prim=js['meshes'][0]['primitives'][0]
                    idx=build.dec.read_acc(js,blob,prim['indices']).astype(int).ravel()
                    return build.dec.read_acc(js,blob,prim['attributes'][name])[idx]
                np.testing.assert_array_equal(corners(before,bd),corners(after,ad))
            self.assertEqual(after['asset']['extras']['coordinateSystem'],'Y-up')
            self.assertIn(b'texture-bytes',ad)


if __name__ == '__main__':
    unittest.main()
