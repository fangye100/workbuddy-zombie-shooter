/** 裁剪和循环接缝处理；配方属于内容数据，工具不决定游戏攻击计时。 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Euler, Quaternion } from 'three';

export const hash = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
export function deriveBvh(text, recipe) {
  const match = /\bMOTION\s+Frames:\s*(\d+)\s+Frame Time:\s*([\d.eE+-]+)\s*\n/.exec(text);
  if (!match) throw Error('Invalid BVH motion header');
  const header = text.slice(0, match.index), dt = Number(match[2]);
  const channels = [...header.matchAll(/CHANNELS\s+(\d+)\s+([^\n]+)/g)].flatMap(m => m[2].trim().split(/\s+/));
  if (!(dt > 0) || !channels.length) throw Error('Invalid BVH channels/frame time');
  const frames = text.slice(match.index + match[0].length).trim().split(/\r?\n/).map(l => l.trim().split(/\s+/).map(Number));
  if (frames.length !== Number(match[1]) || frames.some(f => f.length !== channels.length || !f.every(Number.isFinite))) throw Error('Invalid BVH frame rows');
  const { startFrame, endFrame, seamFrames = 0 } = recipe;
  if (![startFrame, endFrame, seamFrames].every(Number.isInteger) || startFrame < 0 || endFrame >= frames.length || endFrame <= startFrame || seamFrames < 0 || seamFrames >= (endFrame - startFrame) / 2) throw Error('Invalid crop/seam range');
  const rows = frames.slice(startFrame, endFrame + 1).map(f => [...f]);
  // XZ root drift is removed offline as well as at runtime; y bob is retained.
  for (let c = 0; c < channels.length; c++) if (channels[c] === 'Xposition' || channels[c] === 'Zposition') for (const row of rows) row[c] = rows[0][c];
  if (seamFrames) for (let k = 0; k < seamFrames; k++) {
    const row = rows[rows.length - seamFrames + k], w = (k + 1) / seamFrames;
    for (let c = 0; c < channels.length;) {
      if (channels[c].endsWith('position')) { row[c] += (rows[0][c] - row[c]) * w; c++; continue; }
      if (channels.slice(c, c + 3).join(',') !== 'Xrotation,Yrotation,Zrotation') throw Error('Derivation requires XYZ rotations');
      const q = new Quaternion().setFromEuler(new Euler(...row.slice(c, c + 3).map(v => v * Math.PI / 180), 'XYZ'));
      const first = new Quaternion().setFromEuler(new Euler(...rows[0].slice(c, c + 3).map(v => v * Math.PI / 180), 'XYZ'));
      const e = new Euler().setFromQuaternion(q.slerp(first, w), 'XYZ');
      row.splice(c, 3, ...[e.x, e.y, e.z].map(v => v * 180 / Math.PI)); c += 3;
    }
  }
  return `${header}MOTION\nFrames: ${rows.length}\nFrame Time: ${dt}\n${rows.map(f => f.map(v => v.toFixed(6)).join(' ')).join('\n')}\n`;
}

export function publish(root, recipePath) {
  const recipe = JSON.parse(readFileSync(resolve(root, recipePath), 'utf8'));
  if (recipe.schemaVersion !== 1 || !Array.isArray(recipe.clips) || !recipe.clips.length) throw Error('Invalid recipe');
  const pending = [], seen = new Set(), report = [];
  const libPath = resolve(root, 'assets/animations/mixamo/shared.motion.json');
  const lib = JSON.parse(readFileSync(libPath, 'utf8'));
  for (const item of recipe.clips) {
    if (!/^game_[a-z0-9_]+$/.test(item.id) || seen.has(item.id) || !/^ani_[a-z0-9_]+$/.test(item.source)) throw Error('Invalid/duplicate derived identity');
    seen.add(item.id);
    const sourcePath = `assets/animations/mixamo/${item.source}.bvh`, source = readFileSync(resolve(root, sourcePath), 'utf8');
    const sourceMeta = JSON.parse(readFileSync(resolve(root, `${sourcePath}.meta.json`), 'utf8'));
    if (sourceMeta.sourceHash !== hash(source)) throw Error(`${item.source}: stale source hash`);
    const output = deriveBvh(source, item), path = `assets/animations/gameplay/${item.id}.bvh`;
    const old = existsSync(resolve(root, `${path}.meta.json`)) ? JSON.parse(readFileSync(resolve(root, `${path}.meta.json`), 'utf8')) : {};
    const meta = { ...sourceMeta, ...old, guid: old.guid ?? `as_motion_${item.id}`, sourceHash: hash(output),
      userData: { ...sourceMeta.userData, ...old.userData, acceptance: 'gameplay-derived', derivedFrom: { path: sourcePath, guid: sourceMeta.guid },
        derivedSourceHash: hash(source), recipe: recipePath, startFrame: item.startFrame, endFrame: item.endFrame, seamFrames: item.seamFrames ?? 0, timingBasis: 'authored-after-headed-preview' } };
    pending.push([path, output], [`${path}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`]);
    lib.clips[item.id] = { source: { path, guid: meta.guid }, rootPolicy: 'in-place', loop: !!item.seamFrames,
      ...(lib.clips[item.source]?.nominalSpeedMps ? { nominalSpeedMps: lib.clips[item.source].nominalSpeedMps } : {}) };
    report.push({ id: item.id, source: item.source, frames: item.endFrame - item.startFrame + 1, sourceHash: hash(source), outputHash: hash(output) });
  }
  for (const [name, states] of Object.entries(recipe.profiles)) {
    if (Object.values(states).some(id => !lib.clips[id])) throw Error(`${name}: unknown clip`);
    lib.profiles[name] = states;
  }
  const text = `${JSON.stringify(lib, null, 2)}\n`, metaPath = `${libPath}.meta.json`;
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')); meta.sourceHash = hash(text);
  pending.push(['assets/animations/mixamo/shared.motion.json', text], ['assets/animations/mixamo/shared.motion.json.meta.json', `${JSON.stringify(meta, null, 2)}\n`]);
  // Validate the whole recipe before publishing any derived output.
  mkdirSync(resolve(root, 'assets/animations/gameplay'), { recursive: true });
  for (const [path, text] of pending) writeFileSync(resolve(root, path), text);
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2).filter(a => a !== '--');
  if (args.length !== 1) throw Error('Usage: derive-clips.mjs <recipe.json>');
  console.log(JSON.stringify(publish(resolve(import.meta.dirname, '../..'), args[0]), null, 2));
}
