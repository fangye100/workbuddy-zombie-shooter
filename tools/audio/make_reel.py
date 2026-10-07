#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把校准批串成一条审听 reel（实际完整循环重复三次）。
用法: python make_reel.py <交付根目录> <输出 wav>
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import json
from sfx_synth import SR, write_wav24  # noqa: E402
from verify_audio import read_wav

GAP = 0.45


def block(x):
    """统一成立体声；保留全部已测量源样本。"""
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = np.stack([x, x], axis=1)
    if x.shape[1] == 1:
        x = np.repeat(x, 2, axis=1)
    return x


def main():
    root, out = sys.argv[1], sys.argv[2]
    gap = np.zeros((int(GAP * SR), 2))
    pieces = []
    batch = json.load(open(os.path.join(root, 'batch.json'), encoding='utf-8'))
    for cue in batch['cues']:
        cue_id = cue['id']
        meta = json.load(open(os.path.join(root, cue_id, 'delivery.json'), encoding='utf-8'))
        v = meta['variants'][0]
        x, sr, ch, bits = read_wav(os.path.join(root, cue_id, v['file']))
        if sr != SR: raise ValueError('Unexpected sample rate')
        if v['playback'] == 'loop':
            x = np.concatenate([x[v['loopStartSample']:v['loopEndSample']]] * 3)
        pieces += [block(x), gap]
    reel = np.concatenate(pieces)
    peak = np.max(np.abs(reel))
    reel = reel * (10 ** (-3.0 / 20.0) / peak)
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    write_wav24(out, reel)
    print(f"reel: {out}  {len(reel)/SR:.1f}s  ({len(batch['cues'])} cues, actual full loops repeated 3 times)")


if __name__ == "__main__":
    main()
