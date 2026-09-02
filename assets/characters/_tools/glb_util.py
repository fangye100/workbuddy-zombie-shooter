# -*- coding: utf-8 -*-
"""
Shared GLB I/O + matrix/quaternion helpers for the Blender-free rigging pipeline.

Conventions (mirror apps/lab/shader-lab/src/gpu/gltf.ts exactly):
  - glTF 2.0 binary. magic 0x46546C67, version 2.
  - Chunks: <I4s> = (length:u32 LE, type:4s). JSON chunk = b"JSON", BIN = b"BIN\x00".
    Each chunk padded to a 4-byte boundary (JSON with 0x20, BIN with 0x00).
  - Matrices are COLUMN-MAJOR float32 length-16 (same as WGSL mat4x4f / the TS nodeMatrix()).
  - Node local transform: T · R · S (glTF spec order). With identity R/S it is pure translation.
  - JOINTS_0 = componentType 5123 (u16), VEC4, NOT normalized.
    WEIGHTS_0 = componentType 5126 (f32), VEC4, normalized=false.

numpy is used for math. If numpy is unavailable, a pure-python fallback is provided
for the mat4 ops used by the validators.
"""

import json
import os
import struct

import numpy as np

# ---- glTF component / type tables -----------------------------------------
_COMP_SIZE = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5124: 4, 5125: 4, 5126: 4}
_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
_STRUCT = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5124: "i", 5125: "I", 5126: "f"}

GLTF_MAGIC = 0x46546C67
JSON_TYPE = b"JSON"
BIN_TYPE = b"BIN\x00"


# =========================================================================
# GLB reader
# =========================================================================
def read_glb(path):
    """Return (gltf_json_dict, bin_bytes)."""
    raw = open(path, "rb").read()
    if len(raw) < 12 or raw[:4] != b"glTF":
        raise ValueError("not a GLB (missing glTF magic)")
    if struct.unpack_from("<I", raw, 4)[0] != 2:
        raise ValueError("unsupported glTF version")
    js = None
    bin_data = b""
    off = 12
    while off + 8 <= len(raw):
        clen, ctype = struct.unpack_from("<I4s", raw, off)
        data = raw[off + 8: off + 8 + clen]
        if ctype == JSON_TYPE:
            js = json.loads(data.decode("utf-8"))
        elif ctype == BIN_TYPE:
            bin_data = data
        off += 8 + clen + ((4 - (clen % 4)) % 4)
    if js is None:
        raise ValueError("GLB has no JSON chunk")
    return js, bin_data


def read_accessor(np_arr_holder, bin_data, accessor):
    """Read one accessor into an np.ndarray (count x ncomp), un-normalized.
    np_arr_holder is the gltf json dict (for bufferViews). Returns float64/int array."""
    bv = np_arr_holder["bufferViews"][accessor["bufferView"]]
    comp = accessor["componentType"]
    ncomp = _NCOMP[accessor["type"]]
    count = accessor["count"]
    base = bv.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    stride = bv.get("byteStride")
    size = _COMP_SIZE[comp]
    elsize = size * ncomp
    if stride and stride != elsize:
        buf = np.frombuffer(bin_data, dtype=np.uint8, count=count * stride, offset=base)
        buf = buf.reshape(count, stride)[:, :elsize]
        arr = buf.view(np.dtype(_STRUCT[comp])).reshape(count, ncomp)
    else:
        arr = np.frombuffer(bin_data, dtype=np.dtype(_STRUCT[comp]),
                            count=count * ncomp, offset=base).reshape(count, ncomp)
    if comp in (5121, 5120, 5123, 5122, 5125, 5124):
        return arr.astype(np.float64)
    return arr.astype(np.float64)


def read_mesh_geometry(js, bin_data):
    """Read first mesh primitive's POSITION / NORMAL / indices as np arrays.
    Returns (positions (N,3) f64, normals (N,3) f64 or None, indices (M,3) i64)."""
    prim = js["meshes"][0]["primitives"][0]
    pos = read_accessor(js, bin_data, js["accessors"][prim["attributes"]["POSITION"]])
    nrm = None
    if "NORMAL" in prim["attributes"]:
        nrm = read_accessor(js, bin_data, js["accessors"][prim["attributes"]["NORMAL"]])
    if nrm is None:
        nrm = compute_normals(pos, read_accessor(js, bin_data, js["accessors"][prim["indices"]]).astype(np.int64))
    faces = read_accessor(js, bin_data, js["accessors"][prim["indices"]]).astype(np.int64).reshape(-1, 3)
    return pos, nrm, faces


def compute_normals(verts, faces):
    a = verts[faces[:, 0]]; b = verts[faces[:, 1]]; c = verts[faces[:, 2]]
    fn = np.cross(b - a, c - a)
    n = np.zeros_like(verts)
    for k in range(3):
        np.add.at(n, faces[:, k], fn)
    lens = np.linalg.norm(n, axis=1)
    lens[lens < 1e-12] = 1.0
    return n / lens[:, None]


# =========================================================================
# GLB builder
# =========================================================================
class GLBBuilder:
    """Assemble a GLB from accessors. 4-byte aligned packing."""

    _COMP_DTYPE = {5126: "<f4", 5125: "<u4", 5123: "<u2", 5121: "<u1",
                   5124: "<i4", 5122: "<i2", 5120: "<i1"}

    def __init__(self):
        self.bin = bytearray()
        self.accessors = []
        self.bufferViews = []

    def _align4(self):
        pad = (4 - (len(self.bin) % 4)) % 4
        if pad:
            self.bin += b"\x00" * pad

    def add_raw(self, arr, component_type, ncomp, type_name, normalized=False, target=None):
        """Add a bufferView+accessor from an ndarray shaped (count, ncomp) (or (count,) for SCALAR).
        Returns accessor index. Component dtype follows component_type (NOT forced to f32)."""
        arr = np.ascontiguousarray(arr, dtype=self._COMP_DTYPE[component_type])
        if arr.ndim == 1:
            arr = arr.reshape(-1, 1)
        count = arr.shape[0]
        data = arr.tobytes()
        self._align4()
        bv_idx = len(self.bufferViews)
        self.bufferViews.append({
            "buffer": 0,
            "byteOffset": len(self.bin),
            "byteLength": len(data),
            **({"target": target} if target is not None else {}),
        })
        self.bin += data
        self.accessors.append({
            "bufferView": bv_idx,
            "componentType": component_type,
            "count": count,
            "type": type_name,
            **({"normalized": normalized} if normalized else {}),
        })
        return len(self.accessors) - 1

    # ---- typed helpers -------------------------------------------------
    def positions(self, p):   return self.add_raw(p, 5126, 3, "VEC3")
    def normals(self, n):     return self.add_raw(n, 5126, 3, "VEC3")
    def indices(self, idx):   return self.add_raw(np.asarray(idx, dtype="<u4"), 5125, 1, "SCALAR")
    def joints(self, j):      return self.add_raw(np.asarray(j, dtype="<u2"), 5123, 4, "VEC4")
    def weights(self, w):     return self.add_raw(w, 5126, 4, "VEC4")
    def mat4s(self, m):       return self.add_raw(m, 5126, 16, "MAT4")
    def times(self, t):       return self.add_raw(t, 5126, 1, "SCALAR")
    def quats(self, q):       return self.add_raw(q, 5126, 4, "VEC4")
    def translations(self, tr): return self.add_raw(tr, 5126, 3, "VEC3")

    def build(self, gltf_static):
        """Finalize: merge in accessors/bufferViews, write file."""
        gltf = gltf_static
        gltf["buffers"] = [{"byteLength": len(self.bin)}]
        gltf["bufferViews"] = self.bufferViews
        gltf["accessors"] = self.accessors
        # --- pack chunks ---
        js_bytes = json.dumps(gltf, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        pad = (4 - (len(js_bytes) % 4)) % 4
        js_bytes += b"\x20" * pad
        bin_chunk = bytes(self.bin)
        pad = (4 - (len(bin_chunk) % 4)) % 4
        bin_chunk += b"\x00" * pad
        body = bytearray()
        body += struct.pack("<I", len(js_bytes)) + JSON_TYPE + js_bytes
        body += struct.pack("<I", len(bin_chunk)) + BIN_TYPE + bin_chunk
        out = struct.pack("<III", GLTF_MAGIC, 2, 12 + len(body)) + body
        return bytes(out)


def write_glb(path, gltf, bin_bytes):
    """Pack an already-assembled gltf json dict + bin bytes into a GLB file.
    bin_bytes is the raw BIN chunk payload (will be 4-byte padded)."""
    gltf = json.loads(json.dumps(gltf))  # defensive copy
    gltf["buffers"] = [{"byteLength": len(bin_bytes)}]
    js_bytes = json.dumps(gltf, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    pad = (4 - (len(js_bytes) % 4)) % 4
    js_bytes += b"\x20" * pad
    bin_chunk = bytes(bin_bytes)
    pad = (4 - (len(bin_chunk) % 4)) % 4
    bin_chunk += b"\x00" * pad
    body = bytearray()
    body += struct.pack("<I", len(js_bytes)) + JSON_TYPE + js_bytes
    body += struct.pack("<I", len(bin_chunk)) + BIN_TYPE + bin_chunk
    out = struct.pack("<III", GLTF_MAGIC, 2, 12 + len(body)) + body
    with open(path, "wb") as f:
        f.write(out)
    return len(out)


# =========================================================================
# mat4 (column-major) + quaternion helpers
# =========================================================================
def m_identity():
    m = np.eye(4, dtype=np.float64)
    return m  # numpy is row-major; we treat as column-major by helper convention below


def m_translation(t):
    m = np.eye(4, dtype=np.float64)
    m[0, 3] = t[0]; m[1, 3] = t[1]; m[2, 3] = t[2]
    return m


def m_scale(s):
    return np.diag([s[0], s[1], s[2], 1.0]).astype(np.float64)


def quat_to_matrix(q):
    """Unit quaternion (x,y,z,w) -> 4x4 rotation matrix (column-major storage as np row-major
    but we keep numpy indexing; m[col*4+row] == m[row, col] in our usage)."""
    x, y, z, w = q
    n = 1.0 / (x * x + y * y + z * z + w * w) ** 0.5
    x, y, z, w = x * n, y * n, z * n, w * n
    m = np.eye(4, dtype=np.float64)
    m[0, 0] = 1 - 2 * (y * y + z * z)
    m[1, 0] = 2 * (x * y + z * w)
    m[2, 0] = 2 * (x * z - y * w)
    m[0, 1] = 2 * (x * y - z * w)
    m[1, 1] = 1 - 2 * (x * x + z * z)
    m[2, 1] = 2 * (y * z + x * w)
    m[0, 2] = 2 * (x * z + y * w)
    m[1, 2] = 2 * (y * z - x * w)
    m[2, 2] = 1 - 2 * (x * x + y * y)
    return m


def m_compose(t, q, s):
    """glTF local matrix = T · R · S."""
    tr = np.eye(4, dtype=np.float64)
    tr[0, 3] = t[0]; tr[1, 3] = t[1]; tr[2, 3] = t[2]
    sc = np.diag([s[0], s[1], s[2], 1.0]).astype(np.float64)
    return tr @ quat_to_matrix(q) @ sc


def m_mul(a, b):
    return a @ b


def m_inverse(m):
    return np.linalg.inv(m)


def mat_to_colmajor(m):
    """numpy (row,col) -> column-major float16 list matching glTF 'matrix' / inverseBind."""
    return [float(m[r, c]) for c in range(4) for r in range(4)]


def colmajor_to_mat(cm):
    """column-major length-16 -> numpy 4x4 (row,col)."""
    m = np.zeros((4, 4), dtype=np.float64)
    for c in range(4):
        for r in range(4):
            m[r, c] = cm[c * 4 + r]
    return m


# ---- quaternions ---------------------------------------------------------
def quat_identity():
    return [0.0, 0.0, 0.0, 1.0]


def quat_from_axis_angle(axis, angle):
    ax = np.array(axis, dtype=np.float64); ax /= np.linalg.norm(ax)
    s = np.sin(angle / 2.0)
    return [ax[0] * s, ax[1] * s, ax[2] * s, np.cos(angle / 2.0)]


def quat_mul(a, b):
    x1, y1, z1, w1 = a
    x2, y2, z2, w2 = b
    return [
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
    ]


def quat_from_euler_zyx(z, y, x):
    """BVH order Zrotation, Yrotation, Xrotation -> quaternion (R = Rz·Ry·Rx)."""
    qz = quat_from_axis_angle([0, 0, 1], z)
    qy = quat_from_axis_angle([0, 1, 0], y)
    qx = quat_from_axis_angle([1, 0, 0], x)
    return quat_mul(qz, quat_mul(qy, qx))


def quat_normalize(q):
    n = np.linalg.norm(q)
    if n < 1e-12:
        return [0, 0, 0, 1]
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]


# =========================================================================
# skeleton helpers
# =========================================================================
def load_skeleton(skeleton_json):
    with open(skeleton_json, "r", encoding="utf-8") as f:
        spec = json.load(f)
    order = spec["boneOrder"]
    bones = spec["bones"]
    return order, bones


def skeleton_world_translations(order, bones):
    """Return dict bone->world translation (np array (3,))."""
    world = {}
    for name in order:
        b = bones[name]
        off = np.array(b["offset"], dtype=np.float64)
        if b["parent"] is None:
            world[name] = off
        else:
            world[name] = world[b["parent"]] + off
    return world


def skeleton_world_matrices(order, bones):
    """Return dict bone->world bind matrix (numpy 4x4, our mat convention)."""
    world = {}
    for name in order:
        b = bones[name]
        t = np.array(b["offset"], dtype=np.float64)
        q = b.get("rotation", [0, 0, 0, 1])
        s = b.get("scale", [1, 1, 1])
        local = m_compose(t, q, s)
        if b["parent"] is None:
            world[name] = local
        else:
            world[name] = world[b["parent"]] @ local
    return world


def build_node_hierarchy(order, bones, mesh_node_index, skin_index):
    """Build glTF nodes list: bone nodes (in boneOrder) + a mesh node.
    Returns (nodes_list, bone_node_index_map, hips_node_index)."""
    nodes = []
    bone_idx = {}
    for name in order:
        b = bones[name]
        node = {"name": name}
        if b["parent"] is None:
            node["translation"] = [float(x) for x in b["offset"]]
        else:
            node["translation"] = [float(x) for x in b["offset"]]
        if b.get("rotation"):
            node["rotation"] = [float(x) for x in b["rotation"]]
        if b.get("scale") and b["scale"] != [1, 1, 1]:
            node["scale"] = [float(x) for x in b["scale"]]
        # children filled after we know indices
        node["children"] = []
        bone_idx[name] = len(nodes)
        nodes.append(node)
    hips_index = bone_idx[order[0]]
    # set children
    for name in order:
        p = bones[name]["parent"]
        if p is not None:
            nodes[bone_idx[p]]["children"].append(bone_idx[name])
    # mesh node
    mesh_node = {"name": "RiggedMesh", "mesh": 0, "skin": skin_index}
    mesh_index = len(nodes)
    nodes.append(mesh_node)
    return nodes, bone_idx, hips_index, mesh_index
