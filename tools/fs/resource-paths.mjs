/** Typed path slots only. Free-form annotations are never interpreted as references. */
export function pathRewriter(oldPath, newPath, directory, insensitive = false) {
  const key = (p) => insensitive ? p.toLowerCase() : p;
  return (p) => {
    if (typeof p !== 'string') return p;
    const normalized = p.replace(/\\/g, '/').replace(/^\.\//, '');
    return key(normalized) === key(oldPath) || (directory && key(normalized).startsWith(`${key(oldPath)}/`))
      ? newPath + normalized.slice(oldPath.length) : p;
  };
}

export function rewriteResourcePaths(json, kind, rewrite, maxSceneVersion) {
  let changed = false;
  const touch = (obj, key) => {
    if (!obj || typeof obj !== 'object' || typeof obj[key] !== 'string') return;
    const next = rewrite(obj[key]); if (next !== obj[key]) { obj[key] = next; changed = true; }
  };
  const ref = (r) => touch(r, 'path');
  const material = (m) => {
    if (m?.type !== 'override') return;
    ref(m.patch?.texture); material(m.base);
  };
  const unsupported = (value, at) => {
    if (typeof value === 'string' && rewrite(value) !== value) throw new Error(`不支持安全更新的引用：${at}（需声明资产类型后再改名）`);
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) unsupported(v, `${at}.${k}`);
  };
  if (kind === 'project') {
    for (const s of json.scenes ?? []) touch(s, 'path');
    for (const k of ['assetRoots', 'behaviorRoots']) if (Array.isArray(json[k])) json[k] = json[k].map((p) => { const n = rewrite(p); if (n !== p) changed = true; return n; });
    for (const k of ['defaultStyle', 'inputMap', 'gameplayConfig', 'materialLibrary']) touch(json, k);
  } else if (kind === 'scene') {
    if (!Array.isArray(json.nodes) || !Number.isInteger(json.schemaVersion) || json.schemaVersion < 1 || json.schemaVersion > maxSceneVersion) throw new Error('场景/预制体结构或版本不受支持');
    for (const node of json.nodes) {
      ref(node.prefab?.ref); unsupported(node.prefab?.overrides, `nodes[${node.id}].prefab.overrides`);
      if (!Array.isArray(node.components)) throw new Error(`nodes[${node.id}].components 不合法`);
      for (const c of node.components) {
        switch (c.kind) {
          case 'MeshRenderer':
            if (c.source?.type === 'asset') ref(c.source.ref);
            for (const binding of c.materials ?? []) material(binding.material);
            break;
          case 'SpawnPoint': ref(c.prefab); break;
          case 'NavZone': ref(c.baked); break;
          case 'Script': unsupported(c.params, `nodes[${node.id}].Script.params`); break;
          case 'Light': case 'Camera': case 'Collider': case 'RoomVolume': break;
          default: unsupported(c, `nodes[${node.id}].${c.kind}`);
        }
      }
    }
  } else if (kind === 'meta') {
    for (const binding of json.bindings ?? []) for (const primitive of binding.prims ?? []) material(primitive.material);
    ref(json.retarget?.recipe?.source); ref(json.retarget?.recipe?.target);
  } else if (kind === 'manifest') {
    for (const section of ['characters', 'environments']) for (const entry of json[section] ?? []) {
      const manifestTouch = (obj, key) => {
        if (typeof obj?.[key] !== 'string') return;
        const p = obj[key].replace(/\\/g, '/').replace(/^\.\//, '');
        const rooted = p.startsWith('assets/') ? p : `assets/${p}`;
        const next = rewrite(rooted);
        if (next !== rooted) { obj[key] = p.startsWith('assets/') ? next : next.replace(/^assets\//, ''); changed = true; }
      };
      for (const lod of entry.lods ?? []) manifestTouch(lod, 'file');
      if (entry.views) for (const k of Object.keys(entry.views)) manifestTouch(entry.views, k);
    }
  }
  return changed;
}
