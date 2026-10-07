#!/usr/bin/env python3
"""Validate an explicit batch. Statistics do not prove listening quality."""
import argparse
import hashlib
import json
import re
from pathlib import Path
import wave
import numpy as np

def read_wav(path):
    with wave.open(str(path), 'rb') as w:
        sr, ch, bits = w.getframerate(), w.getnchannels(), w.getsampwidth() * 8
        if bits != 24 or w.getcomptype() != 'NONE':
            raise ValueError('Expected 24-bit PCM WAV')
        b = np.frombuffer(w.readframes(w.getnframes()), dtype=np.uint8).reshape(-1, 3).astype(np.int32)
    v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
    v = np.where(v >= 1 << 23, v - (1 << 24), v)
    return (v / 8388608.0).reshape(-1, ch), sr, ch, bits

def onset_s(x, sr):
    indices = np.flatnonzero(np.max(np.abs(x), axis=1) > .01)
    return float(indices[0] / sr) if len(indices) else float('inf')

def verify(root):
    root = Path(root).resolve()
    batch = json.loads((root / 'batch.json').read_text(encoding='utf-8'))
    cues = batch.get('cues', [])
    if not cues or len({c['id'] for c in cues}) != len(cues):
        raise ValueError('Missing, empty or duplicate expected cue inventory')
    expected, seen_hashes, rows, failures = set(), set(), [], []
    for cue in cues:
        cid = cue['id']
        if not isinstance(cid, str) or not re.fullmatch(r'SFX-[A-Z0-9-]+', cid):
            raise ValueError('Invalid cue identity')
        if not isinstance(cue['variants'], int) or cue['variants'] < 1:
            raise ValueError(f'{cid}: empty variant inventory')
        meta = json.loads((root / cid / 'delivery.json').read_text(encoding='utf-8'))
        if meta['id'] != cid or len(meta['variants']) != cue['variants']:
            raise ValueError(f'{cid}: delivery identity/count mismatch')
        for v in meta['variants']:
            p = (root / cid / v['file']).resolve()
            if not p.is_relative_to(root / cid) or p in expected:
                raise ValueError(f'{cid}: unsafe/duplicate file path')
            expected.add(p)
            digest = hashlib.sha256(p.read_bytes()).hexdigest()
            if digest != v['sha256'] or digest in seen_hashes:
                failures.append(f'{p.name}: hash mismatch or duplicate take')
            seen_hashes.add(digest)
            x, sr, ch, bits = read_wav(p)
            if not len(x):
                raise ValueError(f'{p.name}: empty PCM')
            peak = float(np.max(np.abs(x)))
            db = 20 * np.log10(max(peak, 1e-12))
            if sr != 48000 or ch != cue['channels'] or ch != v['channels'] or bits != v['bitDepth'] or sr != v['sampleRate']:
                failures.append(f'{p.name}: format mismatch')
            if len(x) != v['frames'] or abs(len(x)/sr - v['durationS']) > .0001:
                failures.append(f'{p.name}: measured duration/frames mismatch')
            # Three dB is minimum headroom, not a mandatory normalization target.
            if db > -2.99 or db < -80:
                failures.append(f'{p.name}: clipped/too loud/silent ({db:.2f} dBFS)')
            onset = onset_s(x, sr)
            if v['playback'] != cue['playback']:
                failures.append(f'{p.name}: playback mismatch')
            if v['playback'] == 'one-shot' and onset > .010:
                failures.append(f'{p.name}: onset >10ms')
            row = {'file': p.name, 'frames': len(x), 'peakDb': round(db, 2), 'onsetMs': round(onset*1000, 3)}
            if v['playback'] == 'loop':
                start, end = v['loopStartSample'], v['loopEndSample']
                if not isinstance(start, int) or not isinstance(end, int) or not 0 <= start < end - 1 < len(x):
                    failures.append(f'{p.name}: invalid loop sample indices')
                else:
                    loop = x[start:end]
                    ratios = []
                    for channel in range(ch):
                        a = loop[:, channel]
                        scale = max(float(np.percentile(np.abs(np.diff(a)), 99)), 1e-9)
                        ratios.append(float(abs(a[0]-a[-1])/scale))
                    row['joinRatioPerChannel'] = ratios
                    if max(ratios) > 3:
                        failures.append(f'{p.name}: loop join outlier {ratios}')
                    w = min(int(.008 * sr), len(loop))
                    row['loopWindowRms'] = [float(np.sqrt(np.mean(loop[:w]**2))), float(np.sqrt(np.mean(loop[-w:]**2)))]
            rows.append(row)
    actual = {p.resolve() for p in root.glob('*/**/*.wav') if not p.relative_to(root).parts[0].startswith('_')}
    if actual != expected:
        failures.append(f'WAV inventory mismatch: missing {len(expected-actual)}, extra {len(actual-expected)}')
    return rows, failures

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('root')
    args = ap.parse_args()
    try:
        rows, failures = verify(args.root)
    except (OSError, ValueError, KeyError, TypeError, wave.Error) as e:
        print(f'FAIL: {e}')
        return 1
    for row in rows:
        print(json.dumps(row))
    print(f'{len(rows)} files, {len(failures)} failures; listening acceptance remains separate')
    for f in failures:
        print('FAIL:', f)
    return 1 if failures else 0

if __name__ == '__main__':
    raise SystemExit(main())
