/** Summarize archived captures without opening a browser or running a game. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { summarizeCrowdCapture } from './crowd-performance-page.mjs';

const [directory, output] = process.argv.slice(2);
if (!directory || !output) throw new Error('Usage: node tools/verify/crowd-performance-report.mjs <capture-directory> <output.json>');
const samples = [];
for (const name of (await fs.readdir(directory)).filter(n => n.endsWith('.json') && n !== 'cleanup.json').sort()) {
  const raw = await fs.readFile(path.join(directory, name));
  const capture = JSON.parse(raw);
  if (!Array.isArray(capture.frames)) continue;
  const summary = summarizeCrowdCapture(capture);
  samples.push({ capture: name, sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    category: name.startsWith('mixed-') ? 'run-plus-upper-body-ik-and-live-combat' : name.startsWith('gameplay-') ? 'live-movement-and-combat-default-animation' : 'stationary-control',
    ...summary, mixedAnimationStableAbove50: summary.validMixedAnimationSample && summary.stableAbove50,
    frameCount: capture.frames.length, gpuSamples: capture.gpu.length,
    environment: { scene: capture.scene, userAgent: capture.userAgent, deviceFeatures: capture.deviceFeatures, secure: capture.secure },
    animation: capture.animation ?? null });
}
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify({ formatVersion: 1, samples, cleanup: JSON.parse(await fs.readFile(path.join(directory, 'cleanup.json'))) }, null, 2) + '\n');
for (const s of samples.filter(s => s.capture.startsWith('mixed-'))) console.log(JSON.stringify({ capture: s.capture, seconds: +(s.elapsedMs / 1000).toFixed(2), npc: s.npc, fps: +s.fps.toFixed(2), minWindow: +Math.min(...s.tenSecondWindows).toFixed(2), cpu95: +s.metrics.cpuMs.p95.toFixed(2), gpu95: +s.metrics.gpuMs.p95.toFixed(2), stable: s.mixedAnimationStableAbove50, triangles: s.submittedDynamicTriangles, raster: s.raster }));
