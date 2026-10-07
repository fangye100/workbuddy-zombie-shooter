"""Local planar-structure checks for static architectural QEM outputs.

This detects invented slopes on source axis-aligned surfaces, not artistic approval
or a guarantee that the source itself has straight geometry. Curved/diagonal source
surfaces are excluded. Normals for shading remain a separate concern.
"""
import numpy as np
from scipy.spatial import cKDTree


def face_geometry(points, faces):
    triangles = points[faces]
    cross = np.cross(triangles[:, 1]-triangles[:, 0], triangles[:, 2]-triangles[:, 0])
    lengths = np.linalg.norm(cross, axis=1)
    return triangles.mean(axis=1), cross/np.maximum(lengths[:, None], 1e-15), lengths/2


class ArchitectureReference:
    def __init__(self, points, faces, vertex_normals=None):
        self.centres, self.normals, self.areas = face_geometry(points, faces)
        if vertex_normals is not None:
            self.normals=vertex_normals[faces].mean(axis=1)
            self.normals/=np.maximum(np.linalg.norm(self.normals,axis=1,keepdims=True),1e-15)
        self.tree = cKDTree(self.centres)
        self.diagonal = float(np.linalg.norm(np.ptp(points, axis=0)))

    def measure(self, points, faces):
        centres, normals, areas = face_geometry(points, faces)
        _, neighbours = self.tree.query(centres,k=min(64,len(self.centres)))
        if neighbours.ndim==1: neighbours=neighbours[:,None]
        nearest=neighbours[:,0]
        neighbourhood=self.normals[neighbours]
        source_normals=neighbourhood.mean(axis=1)
        source_normals/=np.maximum(np.linalg.norm(source_normals,axis=1,keepdims=True),1e-15)
        # A single axis-facing source triangle on a broken edge is not a plane.
        # Require a coherent local source patch before calling a slope invented.
        coherence=np.mean(np.sum(neighbourhood*source_normals[:,None,:],axis=2)>=np.cos(np.deg2rad(15)),axis=1)
        planar = (np.max(np.abs(source_normals), axis=1) >= np.cos(np.deg2rad(10))) & (coherence>=.85)
        planar &= (areas > 1e-15) & (self.areas[nearest] > 1e-15)
        total = float(areas[planar].sum())
        coverage=total/max(float(areas.sum()),1e-15)
        if total <= 0:
            return {'planarArea':0,'coverage':0,'status':'insufficient-planar-coverage','limits':{}}
        dots = np.sum(normals*source_normals, axis=1)
        slopes = planar & (dots < np.cos(np.deg2rad(20)))
        offsets = np.abs(np.sum((centres-self.centres[nearest])*source_normals, axis=1))/self.diagonal
        order = np.argsort(offsets[planar])
        cumulative = np.cumsum(areas[planar][order])/total
        p95 = float(offsets[planar][order[min(np.searchsorted(cumulative, .95), len(order)-1)]])
        return {'planarArea': total,'coverage':coverage,'status':'measured' if coverage>=.05 else 'insufficient-planar-coverage', 'inventedSlopeAreaRatio': float(areas[slopes].sum()/total),
                'planeOffsetP95DiagonalRatio': p95,
                'limits': {'inventedSlopeAreaRatio': .08, 'planeOffsetP95DiagonalRatio': .005} if coverage>=.05 else {}}


def failures(metrics):
    return [f'Architecture {key} {metrics[key]:.5f} > {limit}'
            for key, limit in metrics['limits'].items()
            if not np.isfinite(metrics[key]) or metrics[key] > limit]
