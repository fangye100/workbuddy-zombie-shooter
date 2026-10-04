"""Build textured, metre-scale environment LODs; stage before publishing.

Run with the project's mesh Python environment (pymeshlab, numpy, Pillow).
UV chart count is diagnostic, not a triangle budget or a proof of visual quality.
Both levels require a subsequent headed Asset Browser inspection.
"""
import argparse
from concurrent.futures import ProcessPoolExecutor
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile

import numpy as np
import pymeshlab

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'assets/characters/_tools'))
import decimate_uvkeep as dec

STAGE = ROOT / '.workbuddy/tmp/environment-lods-v2'
GENERATOR = 'aether environment uvkeep-v2'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def placement(vertices, footprint, rotation_deg):
    """Explicit source rotation, then X/Y/Z dimensions W/H/D in metres."""
    rotation = np.eye(3)
    for axis, degrees in enumerate(rotation_deg):
        a = np.deg2rad(degrees)
        c, s = np.cos(a), np.sin(a)
        r = (np.array([[1, 0, 0], [0, c, -s], [0, s, c]]) if axis == 0 else
             np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]]) if axis == 1 else
             np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]]))
        rotation = r @ rotation
    rotated = vertices @ rotation.T
    # A yaw changes neither up nor the authored silhouette. Align the longer
    # horizontal side with the longer design footprint side before scaling.
    w, depth, h = footprint
    horizontal = np.ptp(rotated, axis=0)
    if (horizontal[0] - horizontal[2]) * (w - depth) < 0:
        rotation = np.array([[0, 0, 1], [0, 1, 0], [-1, 0, 0]]) @ rotation
        rotated = vertices @ rotation.T
    lo, hi = rotated.min(0), rotated.max(0)
    span = hi - lo
    if not np.isfinite(span).all() or (span <= 1e-8).any():
        raise ValueError('Source has invalid dimensions')
    scale = np.array([w, h, depth]) / span
    linear = np.diag(scale) @ rotation
    origin = np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2])
    translation = -origin * scale
    matrix = np.eye(4)
    matrix[:3, :3], matrix[:3, 3] = linear, translation
    return linear, translation, matrix.T.reshape(-1).tolist()


def tag_glb(path, provenance):
    js, binary = dec.read_glb(path)
    # Share identical render vertices, but never weld a UV seam or a hard normal.
    # Per-corner texture indices alone would otherwise duplicate all 3F vertices.
    primitive = js['meshes'][0]['primitives'][0]
    attributes = primitive['attributes']
    positions = dec.read_acc(js, binary, attributes['POSITION'])
    uvs = dec.read_acc(js, binary, attributes['TEXCOORD_0'])
    normals = dec.read_acc(js, binary, attributes['NORMAL'])
    indices = dec.read_acc(js, binary, primitive['indices']).astype(np.int64).reshape(-1, 3)
    packed = np.concatenate((positions, uvs, normals), axis=1)
    unique, inverse = np.unique(packed, axis=0, return_inverse=True)
    compact_indices = inverse[indices]
    if not np.array_equal(unique[compact_indices], packed[indices]):
        raise ValueError('Render vertex compaction changed triangle attributes')
    image = js['images'][0]
    view = js['bufferViews'][image['bufferView']]
    start = view.get('byteOffset', 0)
    texture = binary[start:start + view['byteLength']]
    pairs = [[(int(i), int(i)) for i in triangle] for triangle in compact_indices]
    dec.build_glb(str(path), unique[:, :3], pairs, unique[:, 3:5], texture, image['mimeType'], N=unique[:, 5:8])
    js, binary = dec.read_glb(path)
    js['asset']['generator'] = GENERATOR
    js['asset']['extras'] = {**provenance, 'coordinateSystem': 'Y-up', 'units': 'metres'}
    js['nodes'][0]['name'] = provenance['level']
    js['meshes'][0]['name'] = provenance['level']
    import struct
    j = json.dumps(js, separators=(',', ':')).encode()
    j += b' ' * (-len(j) % 4)
    Path(path).write_bytes(b'glTF' + struct.pack('<II', 2, 28 + len(j) + len(binary))
                          + struct.pack('<II', len(j), 0x4E4F534A) + j
                          + struct.pack('<II', len(binary), 0x004E4942) + binary)


def build_one(entry):
    eid = entry['id']
    folder = ROOT / 'assets/environment/models' / eid
    raw = folder / f'{eid}.glb'
    outdir = STAGE / eid
    outdir.mkdir(parents=True, exist_ok=True)
    meta = json.loads((folder / 'tex2' / f'{eid}_baked.glb.meta.json').read_text(encoding='utf-8'))
    config = meta.get('userData', {}).get('lodBuild', {})
    targets = config.get('targets', [30000, 15000])
    if len(targets) != 2 or not 0 < targets[1] < targets[0]:
        raise ValueError(f'{eid}: invalid LOD targets')
    document, _ = dec.read_glb(raw)
    primitives = [p for m in document.get('meshes', []) for p in m.get('primitives', [])]
    if len(primitives) != 1 or document.get('skins') or sum('mesh' in n for n in document.get('nodes', [])) != 1:
        raise ValueError(f'{eid}: this static pipeline requires one mesh instance/primitive')
    if any(view.get('byteStride') for view in document.get('bufferViews', [])):
        raise ValueError(f'{eid}: interleaved source needs an explicit accessor conversion')
    v, f, uv, texture = dec.load_raw(raw)
    linear, translation, matrix = placement(v, entry['footprint'], config.get('sourceRotationDeg', [0, 0, 0]))
    source_area = dec.tri_area(v, f)
    encoded, mime = dec.encode_texture(texture)
    result = {'id': eid, 'generator': GENERATOR, 'sourceHash': sha(raw),
              'sourceFaces': len(f), 'sourcePlacementMatrix': matrix,
              'footprint': entry['footprint'], 'config': config, 'levels': []}
    with tempfile.TemporaryDirectory(prefix=f'envlod-{eid}-') as tmp:
        obj = str(Path(tmp) / 'source.obj')
        dec.write_obj(obj, v, f, uv)
        ms = pymeshlab.MeshSet()
        ms.load_new_mesh(obj)
        # Do not weld nearby disconnected surfaces. OBJ preserves wedge UVs;
        # exact duplicate removal reconnects split UV vertices only.
        ms.meshing_remove_duplicate_vertices()
        m = ms.current_mesh()
        source_topology = dec._topo(m.vertex_matrix(), m.face_matrix())
        result['sourceTopology'] = source_topology
        for index, target in enumerate(targets, 1):
            ms.meshing_decimation_quadric_edge_collapse_with_texture(
                targetfacenum=target, qualitythr=0.6, extratcoordw=1.0,
                preserveboundary=True, boundaryweight=1.0,
                optimalplacement=True, planarquadric=True)
            m = ms.current_mesh()
            points, faces = m.vertex_matrix(), m.face_matrix()
            wedges = m.wedge_tex_coord_matrix()
            normals = m.vertex_normal_matrix()
            topology = dec._topo(points, faces)
            area = dec.tri_area(points, faces) / source_area
            placed = points @ linear.T + translation
            # Preserve the same scale and horizontal origin at both levels.
            ground_delta = float(placed[:, 1].min())
            placed[:, 1] -= ground_delta
            normals = normals @ np.linalg.inv(linear)
            normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
            extent = np.ptp(placed, axis=0)
            expected = np.array(entry['footprint'])[[0, 2, 1]]
            extent_error = float(np.max(np.abs(extent / expected - 1)))
            pairs = [[(int(vi), i * 3 + k) for k, vi in enumerate(tri)] for i, tri in enumerate(faces)]
            level = f'LOD{index}'
            file = outdir / (f'{eid}_baked.glb' if index == 1 else f'{eid}_lod2.glb')
            failures = []
            if not np.isfinite(placed).all() or not np.isfinite(wedges).all():
                failures.append('nonfinite attributes')
            if not 0.90 <= area <= 1.10:
                failures.append(f'surface area ratio {area:.4f} outside 0.90..1.10')
            if extent_error > 0.05:
                failures.append(f'bounds drift {extent_error:.4f} > 5%')
            if topology['boundary'] > source_topology['boundary'] or topology['nonmanifold'] > source_topology['nonmanifold']:
                failures.append('topology degraded against welded source')
            if len(faces) > target * 1.05 or len(faces) < target * 0.95:
                failures.append('triangle target missed')
            if index == 2 and len(faces) >= result['levels'][0]['tris']:
                failures.append('LOD2 is not smaller than LOD1')
            dec.build_glb(str(file), placed, pairs, wedges, encoded, mime, N=normals)
            tag_glb(file, {'id': eid, 'level': level, 'algorithm': 'uvkeep-v2',
                          'sourceHash': result['sourceHash'], 'targetFaces': target})
            row = {'level': level, 'file': file.name, 'tris': len(faces), 'target': target,
                   'surfaceAreaRatio': area, 'topology': topology, 'dimensions': extent.tolist(),
                   'boundsRelativeError': extent_error, 'groundCorrectionM': ground_delta,
                   'sha256': sha(file), 'bytes': file.stat().st_size,
                   'failures': failures, 'visualReview': 'pending'}
            result['levels'].append(row)
            print(f'{eid} {level}: {len(faces)} tris area={area:.3f} bounds={extent_error:.3f} {failures or "numeric PASS; visual pending"}', flush=True)
    (outdir / 'report.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8', newline='\n')
    return result


def publish(result):
    if len(result.get('levels', [])) != 2 or [l['level'] for l in result['levels']] != ['LOD1', 'LOD2']:
        raise ValueError('Publishing requires exactly LOD1 and LOD2')
    if any(level['failures'] for level in result['levels']):
        raise ValueError(f"{result['id']}: cannot publish failed numerical checks")
    eid = result['id']
    raw = ROOT / 'assets/environment/models' / eid / f'{eid}.glb'
    meta_path = raw.parent / 'tex2' / f'{eid}_baked.glb.meta.json'
    meta = json.loads(meta_path.read_text(encoding='utf-8'))
    if sha(raw) != result['sourceHash'] or meta['userData']['lodBuild'] != result['config']:
        raise ValueError(f'{eid}: source/config changed since staging')
    entries = json.loads((ROOT / 'assets/environment/props.json').read_text(encoding='utf-8'))['entries']
    if next(e['footprint'] for e in entries if e['id'] == eid) != result['footprint']:
        raise ValueError(f'{eid}: footprint changed since staging')
    # Preflight both files before touching either delivered level.
    for level in result['levels']:
        source = STAGE / eid / level['file']
        if sha(source) != level['sha256']:
            raise ValueError(f'{source}: staged hash mismatch')
    for level in result['levels']:
        source = STAGE / eid / level['file']
        target = ROOT / 'assets/environment/models' / eid / 'tex2' / level['file']
        backup = STAGE / 'before' / eid / level['file']
        if target.exists() and not backup.exists():
            backup.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, backup)
        shutil.copy2(source, target)
    meta['userData']['lodBuildResult'] = result
    pending = meta_path.with_suffix('.json.pending')
    pending.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    pending.replace(meta_path)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--only', nargs='+')
    ap.add_argument('--jobs', type=int, default=1)
    ap.add_argument('--publish', action='store_true', help='Publish staged files that passed numeric checks; visual review remains mandatory')
    args = ap.parse_args()
    entries = json.loads((ROOT / 'assets/environment/props.json').read_text(encoding='utf-8'))['entries']
    if args.only:
        known = {e['id'] for e in entries}
        if set(args.only) - known:
            ap.error('unknown environment id')
        entries = [e for e in entries if e['id'] in args.only]
    if args.publish:
        results = [json.loads((STAGE / e['id'] / 'report.json').read_text()) for e in entries]
        for result in results:
            publish(result)
    else:
        with ProcessPoolExecutor(max_workers=args.jobs) as pool:
            results = list(pool.map(build_one, entries))
    failures = sum(bool(level['failures']) for result in results for level in result['levels'])
    print(f'{len(results)} assets, {failures} failed levels; headed visual inspection required', flush=True)
    return int(failures > 0)


if __name__ == '__main__':
    sys.exit(main())
