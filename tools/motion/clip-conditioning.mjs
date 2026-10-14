/** 离线 BVH 内容调节。采样复用实际解析/FK；不改运行时或源资产。 */
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const domainPath = resolve(root, '.workbuddy/tmp/motion-conditioning/domain.mjs');
await build({ stdin: { contents: `export { parseBvh } from './apps/editor/src/services/binding/bvh-parser';
export { buildSourceMotion } from './apps/editor/src/services/binding/motion-retarget/source-motion';`, resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: domainPath, tsconfig: resolve(root, 'tsconfig.check.json') });
const { parseBvh, buildSourceMotion } = await import(pathToFileURL(domainPath));

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error(`Invalid ${label}`);
}
function bones(value, motion, label) {
  if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length || value.some(b => typeof b !== 'string' || !motion.worldPositions[b])) throw Error(`Unknown/invalid ${label} bones`);
}
function positive(value, label, max = Infinity) {
  if (!Number.isFinite(value) || value <= 0 || value > max) throw Error(`Invalid ${label}`);
}
function sampling(settings) {
  exactObject(settings, ['unitScale', 'upAxis'], 'conditioning sampling');
  positive(settings.unitScale, 'unitScale', 1000);
  if (!['y', 'z'].includes(settings.upAxis)) throw Error('Conditioning supports explicit Y/Z up only');
  return { unitScale: settings.unitScale, forceUpAxis: settings.upAxis === 'y' ? 1 : 2 };
}
export function sampleBvh(text, settings) {
  return buildSourceMotion(parseBvh(text), sampling(settings));
}

/** 返回调节后帧，根高度只保持输入每帧最低指定足点，不声明世界锁脚。 */
export function conditionFrames(header, frameTime, inputRows, settings) {
  exactObject(settings, ['sampling', 'rotationChannels', 'preserveFootHeight', 'nominalSpeed'], 'conditioning');
  const opts = sampling(settings.sampling);
  const serialize = rows => `${header}MOTION\nFrames: ${rows.length}\nFrame Time: ${frameTime}\n${rows.map(r => r.join(' ')).join('\n')}\n`;
  const bvh = parseBvh(serialize(inputRows)), source = buildSourceMotion(bvh, opts);
  if (!Array.isArray(settings.rotationChannels) || !settings.rotationChannels.length) throw Error('Empty rotationChannels');
  const seen = new Set();
  const columns = settings.rotationChannels.map(item => {
    exactObject(item, ['bone', 'channel', 'scale'], 'rotation channel');
    const joint = bvh.joints[item.bone], index = joint?.channels.indexOf(item.channel) ?? -1;
    if (!['Xrotation', 'Yrotation', 'Zrotation'].includes(item.channel) || index < 0) throw Error(`Unknown rotation channel ${item.bone}.${item.channel}`);
    if (!Number.isFinite(item.scale) || item.scale < 0 || item.scale > 1) throw Error('Rotation scale must be in [0,1]');
    const key = `${item.bone}.${item.channel}`;
    if (seen.has(key)) throw Error(`Duplicate rotation channel ${key}`);
    seen.add(key);
    return { column: joint.column + index, scale: item.scale };
  });
  const rows = inputRows.map(row => [...row]);
  for (const row of rows) for (const { column, scale } of columns) {
    // BVH rest 为零旋转，按最短有符号角收紧指定欧拉通道。
    const angle = ((row[column] + 180) % 360 + 360) % 360 - 180;
    row[column] = angle * scale;
  }
  let footHeightCorrectionM = null;
  if (settings.preserveFootHeight !== undefined) {
    const keep = settings.preserveFootHeight;
    exactObject(keep, ['bones', 'maxCorrectionM'], 'preserveFootHeight');
    bones(keep.bones, source, 'preserveFootHeight');
    positive(keep.maxCorrectionM, 'maxCorrectionM', .5);
    const root = bvh.joints[bvh.root], axis = settings.sampling.upAxis === 'y' ? 'Yposition' : 'Zposition';
    const index = root.channels.indexOf(axis);
    if (index < 0) throw Error(`Foot height preservation requires root ${axis}`);
    const changed = buildSourceMotion(parseBvh(serialize(rows)), opts);
    const correction = rows.map((_, f) => Math.min(...keep.bones.map(b => source.worldPositions[b][f * 3 + 1])) - Math.min(...keep.bones.map(b => changed.worldPositions[b][f * 3 + 1])));
    if (correction.some(v => !Number.isFinite(v) || Math.abs(v) > keep.maxCorrectionM)) throw Error('Foot height correction exceeds configured bound');
    rows.forEach((row, f) => { row[root.column + index] += correction[f] / opts.unitScale; });
    footHeightCorrectionM = { min: Math.min(...correction), max: Math.max(...correction) };
  }
  if (settings.nominalSpeed !== undefined) validateNominal(settings.nominalSpeed, source);
  return { rows, footHeightCorrectionM };
}

function validateNominal(settings, motion) {
  exactObject(settings, ['bones', 'heightToleranceM', 'minSpeedMps'], 'nominalSpeed');
  bones(settings.bones, motion, 'nominalSpeed');
  positive(settings.heightToleranceM, 'heightToleranceM', .1);
  positive(settings.minSpeedMps, 'minSpeedMps');
}
/** 与源导入的低位足速中位数口径一致，在最终接缝/量化输出上重测。 */
export function measureDerivedNominal(text, conditioning) {
  if (conditioning.nominalSpeed === undefined) return null;
  const motion = sampleBvh(text, conditioning.sampling);
  const settings = conditioning.nominalSpeed;
  validateNominal(settings, motion);
  const speeds = [];
  for (const bone of settings.bones) {
    const p = motion.worldPositions[bone], floor = Math.min(...Array.from({ length: motion.times.length }, (_, f) => p[f * 3 + 1]));
    for (let f = 1; f < motion.times.length; f++) if (p[f * 3 + 1] < floor + settings.heightToleranceM && p[(f - 1) * 3 + 1] < floor + settings.heightToleranceM) {
      const speed = Math.hypot(p[f * 3] - p[(f - 1) * 3], p[f * 3 + 2] - p[(f - 1) * 3 + 2]) / (motion.times[f] - motion.times[f - 1]);
      if (speed > settings.minSpeedMps) speeds.push(speed);
    }
  }
  if (!speeds.length) throw Error('Derived nominal speed has no low-foot samples');
  speeds.sort((a, b) => a - b);
  return { nominalSpeedMps: speeds[Math.floor(speeds.length / 2)], samples: speeds.length, basis: 'derived-low-foot-speed-median-v1' };
}
