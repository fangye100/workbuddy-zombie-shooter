"""Count UV-connected face charts (diagnostic only, not a LOD triangle floor).

Faces connect through a shared geometric edge with matching UVs at both ends.
Coincident UVs on separate geometry, or touching at one corner, do not join charts.
Counts are not geometric shells and do not establish visual fidelity.
"""
import argparse
from collections import defaultdict
from pathlib import Path
import sys
import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'assets/characters/_tools'))
from decimate_uvkeep import read_glb, read_acc


def chart_sizes(positions, uv, faces):
    parent = list(range(len(faces)))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    edges = {}
    keys = [tuple(p) + tuple(t) for p, t in zip(positions, uv)]
    for fi, face in enumerate(faces):
        for a, b in ((face[0], face[1]), (face[1], face[2]), (face[2], face[0])):
            edge = tuple(sorted((keys[int(a)], keys[int(b)])))
            if edge in edges:
                parent[find(fi)] = find(edges[edge])
            else:
                edges[edge] = fi
    counts = defaultdict(int)
    for fi in range(len(faces)):
        counts[find(fi)] += 1
    return sorted(counts.values())


def count_charts(path):
    js, binary = read_glb(path)
    if len(js['meshes']) != 1 or len(js['meshes'][0]['primitives']) != 1:
        raise ValueError('Diagnostic supports one primitive only')
    p = js['meshes'][0]['primitives'][0]
    faces = read_acc(js, binary, p['indices']).astype(np.int64).reshape(-1, 3)
    points = read_acc(js, binary, p['attributes']['POSITION'])
    uv = read_acc(js, binary, p['attributes']['TEXCOORD_0'])
    sizes = chart_sizes(points, uv, faces)
    return len(sizes), len(faces), min(sizes), float(np.median(sizes))


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--only', nargs='+')
    args = ap.parse_args()
    for folder in sorted((ROOT / 'assets/environment/models').iterdir()):
        source = folder / f'{folder.name}.glb'
        if source.exists() and (not args.only or folder.name in args.only):
            print(folder.name, dict(zip(('charts', 'faces', 'minChartFaces', 'medianChartFaces'), count_charts(source))), flush=True)
