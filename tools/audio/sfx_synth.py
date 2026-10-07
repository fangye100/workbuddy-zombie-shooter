#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
程序化音效合成器 —— 末日尸潮 (docs/40 Gameplay sound-effect asset brief)

本脚本产出可复现的程序化校准原型。格式指标不代表审听通过；其他制作路线
同样可以通过后处理达到交付规格。接入游戏后再判断声音身份与混音效果。

用法:
  python sfx_synth.py --all-calibration --out <dir>
  python sfx_synth.py --id SFX-WPN-PISTOL-SHOT --variants 3 --out <dir>
"""
import argparse
import hashlib
import json
import os
import struct
import sys

import numpy as np
from scipy import signal as sps

SR = 48000
PEAK_TARGET = 10 ** (-3.0 / 20.0)  # -3 dBFS headroom


# ---------------------------------------------------------------- WAV (24-bit)
def write_wav24(path, x, sr=SR):
    """写 24-bit PCM WAV。x: (n,) 或 (n, ch)，float [-1,1]。"""
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = x[:, None]
    n, ch = x.shape
    x = np.clip(x, -1.0, 1.0)
    ints = np.round(x * 8388607.0).astype(np.int32)
    packed = np.empty((n, ch, 3), dtype=np.uint8)
    packed[..., 0] = ints & 0xFF
    packed[..., 1] = (ints >> 8) & 0xFF
    packed[..., 2] = (ints >> 16) & 0xFF
    data = packed.tobytes()
    byte_rate = sr * ch * 3
    block_align = ch * 3
    pad = b'\0' if len(data) & 1 else b''
    hdr = b"RIFF" + struct.pack("<I", 36 + len(data) + len(pad)) + b"WAVE"
    fmt = b"fmt " + struct.pack("<IHHIIHH", 16, 1, ch, sr, byte_rate, block_align, 24)
    hdr += fmt + b"data" + struct.pack("<I", len(data))
    with open(path, "wb") as f:
        f.write(hdr)
        f.write(data)
        f.write(pad)


# ---------------------------------------------------------------- DSP helpers
def rng_for(key):
    seed = int.from_bytes(hashlib.sha256(key.encode('utf-8')).digest()[:8], 'little')
    return np.random.default_rng(seed)


def noise(n, kind="white", r=None):
    r = r or np.random.default_rng()
    if kind == "pink":
        # Voss-McCartney 近似（Paul Kellet 系数）
        b = [0.049922035, -0.095993537, 0.050612699, -0.004408786]
        w = r.standard_normal(n)
        out = np.zeros(n)
        for i in range(n):
            w[i] = r.standard_normal() if False else w[i]
        # 用 IIR 近似粉噪
        b0, b1, b2, b3 = b
        y = np.zeros(n)
        x1 = x2 = x3 = 0.0
        for i in range(n):
            white = w[i]
            y[i] = (b0 * white + b1 * x1 + b2 * x2 + b3 * x3
                    + 0.98486 * (y[i - 1] if i else 0.0))
            x3, x2, x1 = x2, x1, white
        return y / (np.max(np.abs(y)) + 1e-9)
    if kind == "brown":
        w = r.standard_normal(n)
        return np.cumsum(w) / (np.max(np.abs(np.cumsum(w))) + 1e-9)
    return r.standard_normal(n)


def bp(x, lo, hi, sr=SR, order=4):
    nyq = sr / 2
    lo = max(lo / nyq, 1e-5)
    hi = min(hi / nyq, 0.999)
    sos = sps.butter(order, [lo, hi], btype="band", output="sos")
    return sps.sosfilt(sos, x)


def lp(x, f, sr=SR, order=4):
    sos = sps.butter(order, min(f / (sr / 2), 0.999), btype="low", output="sos")
    return sps.sosfilt(sos, x)


def hp(x, f, sr=SR, order=4):
    sos = sps.butter(order, max(f / (sr / 2), 1e-5), btype="high", output="sos")
    return sps.sosfilt(sos, x)


def env_exp(n, decay_s, attack_s=0.0008, sr=SR, power=1.0):
    """指数衰减包络，attack 极短（保证 onset < 10ms）。"""
    t = np.arange(n) / sr
    a = np.clip(t / max(attack_s, 1e-6), 0, 1)
    d = np.exp(-t / max(decay_s, 1e-4)) ** power
    return a * d


def env_ar(n, attack_s, release_s, sr=SR):
    t = np.arange(n) / sr
    a = np.clip(t / max(attack_s, 1e-6), 0, 1)
    r = np.exp(-np.clip(t - attack_s, 0, None) / max(release_s, 1e-4))
    return np.where(t < attack_s, a, r)


def tone_sweep(f0, f1, n, sr=SR, phase0=0.0):
    t = np.arange(n) / sr
    k = (f1 / f0) ** (1 / max(n - 1, 1))
    inst = f0 * k ** np.arange(n)
    ph = phase0 + 2 * np.pi * np.cumsum(inst) / sr
    return np.sin(ph)


def mix(*layers):
    n = max(len(x) for x in layers)
    out = np.zeros(n)
    for x in layers:
        out[: len(x)] += x
    return out


def at(x, offset_s, sr=SR):
    """把片段放到 offset 秒处。"""
    off = int(offset_s * sr)
    n = off + len(x)
    out = np.zeros(n)
    out[off: off + len(x)] = x
    return out


def fit(x, length_s, sr=SR, tail_fade=0.006):
    n = int(length_s * sr)
    if len(x) > n:
        x = x[:n]
    elif len(x) < n:
        x = np.pad(x, (0, n - len(x)))
    m = int(tail_fade * sr)
    if m > 0:
        x[-m:] *= np.linspace(1, 0, m)
    return x


def normalize(x, target=PEAK_TARGET):
    p = np.max(np.abs(x))
    if p < 1e-9:
        return x
    return x * (target / p)


def make_loop(body_fn, length_s, crossfade_s=0.15, sr=SR):
    """生成无缝循环：多渲染 crossfade 长度，等功率交叉淡化首尾。"""
    n = int(length_s * sr)
    cf = int(crossfade_s * sr)
    raw = body_fn(n + cf)
    head = raw[:n].copy()
    tail = raw[n: n + cf]
    w = np.linspace(0, 1, cf)
    # Start with the continuation after raw[n-1], then fade back into the head.
    head[:cf] = tail * np.sqrt(1 - w) + head[:cf] * np.sqrt(w)
    return head


def stereo(x, spread=0.35, r=None):
    r = r or np.random.default_rng(7)
    n = len(x)
    d = int(spread * SR * 0.02)
    l = x
    rr = np.roll(x, d) if d else x
    m = max(len(l), len(rr))
    out = np.zeros((m, 2))
    out[: len(l), 0] = l
    out[: len(rr), 1] = rr * (0.9 + 0.1 * r.random())
    return out


# ---------------------------------------------------------------- cue synths
def pistol_shot(v):
    r = rng_for(f"pistol{v}")
    L = 0.28
    n = int(L * SR)
    body = bp(noise(n, "white", r), 700, 2600) * env_exp(n, 0.115, power=1.2)
    thump = tone_sweep(190 * (1 + 0.06 * r.random()), 62, n) * env_exp(n, 0.055)
    crack = hp(noise(n, "white", r), 3600) * env_exp(n, 0.030)
    click = at(bp(noise(int(0.03 * SR), "white", r), 2200, 4200)
               * env_exp(int(0.03 * SR), 0.016), 0.048)
    x = mix(thump * 0.85, body * 1.0, crack * 0.45, click * 0.32)
    return normalize(fit(x, L))


def smg_shot(v):
    r = rng_for(f"smg{v}")
    L = 0.13
    n = int(L * SR)
    body = bp(noise(n, "white", r), 1200, 3600) * env_exp(n, 0.058, power=1.3)
    thump = tone_sweep(250 * (1 + 0.08 * r.random()), 95, n) * env_exp(n, 0.032)
    crack = hp(noise(n, "white", r), 5000) * env_exp(n, 0.018)
    click = at(bp(noise(int(0.02 * SR), "white", r), 3000, 5200)
               * env_exp(int(0.02 * SR), 0.010), 0.022)
    x = mix(thump * 0.6, body * 1.0, crack * 0.35, click * 0.40)
    return normalize(fit(x, L))


def hit_flesh(v):
    r = rng_for(f"hitflesh{v}")
    L = 0.18
    n = int(L * SR)
    thump = tone_sweep(150 * (1 + 0.10 * r.random()), 68, n) * env_exp(n, 0.050)
    thwack = bp(noise(n, "white", r), 320, 950) * env_exp(n, 0.090, power=1.1)
    cloth = hp(noise(n, "white", r), 2200) * env_exp(n, 0.045) * 0.22
    wet = lp(noise(n, "white", r), 420) * env_exp(n, 0.055) * 0.30
    x = mix(thump * 0.9, thwack * 1.0, cloth, wet)
    x = np.tanh(x * 1.4) * 0.8  # 轻微软饱和，增加"厚"感
    return normalize(fit(x, L))


def flame_loop(v):
    r = rng_for(f"flame{v}")
    L = 1.5
    n = int(L * SR)

    def body(m):
        # 整数周期 LFO 保证无缝
        t = np.arange(m) / SR
        lfo = (1.0
               + 0.22 * np.sin(2 * np.pi * 3 / L * t)
               + 0.14 * np.sin(2 * np.pi * 5 / L * t + 1.1)
               + 0.08 * np.sin(2 * np.pi * 8 / L * t + 2.3))
        low = lp(noise(m, "pink", r), 850) * 1.0
        mid = bp(noise(m, "white", r), 900, 2600) * 0.35
        hiss = hp(noise(m, "white", r), 4500) * 0.06
        return (low + mid + hiss) * lfo

    x = make_loop(body, L, crossfade_s=0.18)
    return normalize(x)


def acid_pool(v):
    r = rng_for(f"acidpool{v}")
    L = 1.5
    n = int(L * SR)

    def body(m):
        t = np.arange(m) / SR
        fizz = hp(noise(m, "white", r), 3200) * 0.085
        fizz += bp(noise(m, "white", r), 1400, 3000) * 0.10
        # 气泡：随机小 pop（上扫 chirp），跨边界的会被 crossfade 处理
        for _ in range(int(m / SR * 4.5)):
            st = int(r.random() * m)
            ln = int(0.020 * SR + 0.02 * SR * r.random())
            seg = tone_sweep(180 + 120 * r.random(), 520 + 380 * r.random(), ln)
            seg *= env_exp(ln, 0.010)
            idx = (np.arange(ln) + st) % m
            fizz[idx] += seg * (0.18 + 0.16 * r.random())
        return fizz * (1.0 + 0.10 * np.sin(2 * np.pi * 2 / L * t))

    x = make_loop(body, L, crossfade_s=0.16)
    return normalize(x)


def acid_launch(v):
    r = rng_for(f"acidlaunch{v}")
    L = 0.22
    n = int(L * SR)
    pop = tone_sweep(950 * (1 + 0.15 * r.random()), 190, int(0.035 * SR))
    pop *= env_exp(len(pop), 0.014)
    spray = bp(noise(int(0.05 * SR), "white", r), 1200, 3400) * env_exp(int(0.05 * SR), 0.020)
    gulp = tone_sweep(140, 90, int(0.06 * SR)) * env_exp(int(0.06 * SR), 0.030)
    x = mix(at(pop, 0.0) * 0.9, at(spray, 0.006) * 0.55, at(gulp, 0.055) * 0.35)
    return normalize(fit(x, L))


def pounce_warn(v):
    """共振峰合成：紧吸气 + 上扬兽性 rasp（非人类语言，符合 zombie nonverbal 要求）"""
    r = rng_for(f"pounce{v}")
    L = 0.36
    n = int(L * SR)
    t = np.arange(n) / SR
    f0 = 105 + 40 * r.random()
    # 源：脉冲串（声门）+ 噪声
    src = np.zeros(n)
    ph = 0.0
    for i in range(n):
        fi = f0 * (1 + 0.35 * (i / n))  # 上扬
        ph += 2 * np.pi * fi / SR
        src[i] = np.sin(ph) + 0.35 * np.sin(2 * ph) + 0.15 * np.sin(3 * ph)
    breath = hp(noise(n, "white", r), 1100) * 0.55
    voiced = bp(src, 400, 900, order=2) * 1.0 + bp(src, 1000, 1600, order=2) * 0.55 \
        + bp(src, 2200, 3000, order=2) * 0.22
    env = env_ar(n, 0.16, 0.10) * (0.35 + 0.65 * (t / L) ** 1.6)
    x = (voiced * 0.75 + breath * env) * env
    # 起始瞬态：预警必须在 10ms 内可闻，否则低音量下会被枪声盖掉
    n_on = int(0.025 * SR)
    onset = hp(noise(n_on, "white", r), 900) * env_ar(n_on, 0.0015, 0.013)
    x = mix(x, at(onset * 0.55, 0.0))
    x = np.tanh(x * 1.6) * 0.85
    return normalize(fit(x, L, tail_fade=0.02))


def highway_bed(v):
    """空旷郊区公路底噪：低频风 + 远处工业嗡鸣 + 稀疏沙沙。立体声 30s 无缝。"""
    r = rng_for(f"highway{v}")
    L = 30.0
    n = int(L * SR)

    def body(m):
        t = np.arange(m) / SR
        wind = lp(noise(m, "brown", r), 260) * 0.9
        wind *= (1.0 + 0.35 * np.sin(2 * np.pi * 1 / L * t)
                 + 0.20 * np.sin(2 * np.pi * 3 / L * t + 0.8))
        hum = (np.sin(2 * np.pi * 57 * t) * 0.030
               + np.sin(2 * np.pi * 114 * t + 0.4) * 0.014
               + np.sin(2 * np.pi * 171 * t + 1.2) * 0.006)
        base = wind + hum
        # 稀疏沙沙事件（跨边界 wrap）
        for _ in range(9):
            st = int(r.random() * m)
            ln = int(0.25 * SR + 0.5 * SR * r.random())
            seg = bp(noise(ln, "white", r), 1800, 6000) * env_exp(ln, 0.18, attack_s=0.05)
            idx = (np.arange(ln) + st) % m
            base[idx] += seg * 0.10
        # 去低频漂移：brown noise 的积分漂移会让首尾电平差很大，破坏 loop 能量连续性
        return lp(hp(base, 28, order=2), 9000)

    x = make_loop(body, L, crossfade_s=3.0)
    return normalize(stereo(x, spread=0.5, r=r))


# ---------------------------------------------------------------- registry
CUES = {
    "SFX-WPN-PISTOL-SHOT":  (pistol_shot, 3, "one-shot", 1),
    "SFX-WPN-SMG-SHOT":     (smg_shot, 4, "one-shot", 1),
    "SFX-HIT-FLESH":        (hit_flesh, 4, "one-shot", 1),
    "SFX-WPN-FLAME-LOOP":   (flame_loop, 2, "loop", 1),
    "SFX-E03-ACID-POOL":    (acid_pool, 2, "loop", 1),
    "SFX-E03-ACID-LAUNCH":  (acid_launch, 3, "one-shot", 1),
    "SFX-E02-POUNCE-WARN":  (pounce_warn, 3, "one-shot", 1),
    "SFX-ENV-HIGHWAY-BED":  (highway_bed, 1, "loop", 2),
}


def synth(cue_id, variant):
    fn, _, mode, ch = CUES[cue_id]
    x = fn(variant)
    if ch == 1 and x.ndim > 1:
        x = x.mean(axis=1)
    return np.asarray(x, dtype=np.float64), mode


def measure(x):
    if x.ndim == 1:
        x2 = x[:, None]
    else:
        x2 = x
    return {
        "sampleRate": SR,
        "bitDepth": 24,
        "channels": int(x2.shape[1]),
        "durationS": round(len(x2) / SR, 4),
        "frames": int(len(x2)),
        "peakDbfs": round(20 * np.log10(max(np.max(np.abs(x2)), 1e-9)), 2),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", help="cue id")
    ap.add_argument("--variants", type=int, default=0)
    ap.add_argument("--all-calibration", action="store_true")
    ap.add_argument("--out", required=True, help="交付根目录")
    a = ap.parse_args()

    targets = []
    if a.all_calibration:
        targets = list(CUES.items())
    elif a.id:
        if a.id not in CUES:
            print(f"unknown cue {a.id}; known: {list(CUES)}")
            sys.exit(1)
        fn, vc, mode, ch = CUES[a.id]
        targets = [(a.id, (fn, a.variants or vc, mode, ch))]
    else:
        print("need --id or --all-calibration")
        sys.exit(1)

    for cue_id, (fn, vcount, mode, ch) in targets:
        d = os.path.join(a.out, cue_id)
        os.makedirs(os.path.join(d, "source"), exist_ok=True)
        os.makedirs(os.path.join(d, "runtime"), exist_ok=True)
        os.makedirs(os.path.join(d, "preview"), exist_ok=True)
        files = []
        for v in range(1, vcount + 1):
            x, mode_ = synth(cue_id, v)
            name = f"{cue_id}__v{v:02d}.wav"
            p = os.path.join(d, "source", name)
            write_wav24(p, x)
            h = hashlib.sha256(open(p, "rb").read()).hexdigest()
            m = measure(x)
            entry = {"file": f"source/{name}", "variant": f"v{v:02d}", "sha256": h}
            entry.update(m)
            if mode_ == "loop":
                entry["loopStartSample"] = 0
                entry["loopEndSample"] = m["frames"]
            entry["playback"] = mode_
            files.append(entry)
        meta = {
            "id": cue_id,
            "version": "v02",
            "status": "delivered-synthetic-prototype",
            "synthesis": {
                "tool": "tools/audio/sfx_synth.py (procedural, numpy+scipy)",
                "seedBasis": "SHA256 of per-generator family + variant; first 8 bytes little-endian",
                "note": "程序化合成原型，非生成式 AI，非录音素材；用于风格校准与响度对齐",
            },
            "license": "project-original, no third-party sample",
            "variants": files,
        }
        with open(os.path.join(d, "delivery.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        print(f"{cue_id}: {len(files)} variants -> {d}")
    batch = {'version': 2, 'cues': [{'id': cid, 'variants': count, 'channels': ch, 'playback': mode}
                                  for cid, (_, count, mode, ch) in targets]}
    with open(os.path.join(a.out, 'batch.json'), 'w', encoding='utf-8') as f:
        json.dump(batch, f, indent=2)


if __name__ == "__main__":
    main()
