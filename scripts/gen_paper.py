#!/usr/bin/env python3
"""Procedural torn-parchment 9-slice sources for the phone UI ("Field Journal").

Writes public/assets/frames/paper_page.png and paper_card.png. Each is a 192x192 tile used as
CSS `border-image: url(...) 48 fill / 22px round`. All noise is periodic with a 96 px period so
the repeated edge and centre slices join seamlessly. Fallback used when no painted
parchment sheet is imported.
"""
import math
import random
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / 'public' / 'assets' / 'frames'
SIZE, PERIOD = 192, 96


def periodic_noise_1d(n, rng, amp, octaves=((1, 1.0), (2, 0.55), (5, 0.35), (11, 0.22), (23, 0.12))):
    x = np.arange(n)
    out = np.zeros(n)
    for k, w in octaves:
        phase = rng.uniform(0, 2 * math.pi)
        out += w * np.sin(2 * math.pi * k * x / PERIOD + phase)
    out /= sum(w for _, w in octaves)
    return out * amp


def periodic_noise_2d(rng, terms=28):
    y, x = np.mgrid[0:SIZE, 0:SIZE]
    out = np.zeros((SIZE, SIZE))
    for _ in range(terms):
        kx, ky = rng.randint(0, 9), rng.randint(0, 9)
        if kx == 0 and ky == 0:
            continue
        w = 1.0 / (1 + 0.35 * (kx + ky))
        out += w * np.sin(2 * math.pi * (kx * x + ky * y) / PERIOD + rng.uniform(0, 2 * math.pi))
    out -= out.min()
    out /= out.max()
    return out


def make(name, seed, base=(234, 223, 194), base2=(222, 207, 170), inset=9, amp=4.5, burn=14):
    rng = random.Random(seed)
    nrng = np.random.RandomState(seed)
    # torn edge offsets (distance from the tile border to the paper), periodic along each side
    top = inset + periodic_noise_1d(SIZE, rng, amp)
    bottom = inset + periodic_noise_1d(SIZE, rng, amp)
    left = inset + periodic_noise_1d(SIZE, rng, amp)
    right = inset + periodic_noise_1d(SIZE, rng, amp)
    y, x = np.mgrid[0:SIZE, 0:SIZE].astype(float)
    # signed distance-ish to the torn boundary (positive inside the paper)
    d = np.minimum.reduce([y - top[x.astype(int)], (SIZE - 1 - y) - bottom[x.astype(int)], x - left[y.astype(int)], (SIZE - 1 - x) - right[y.astype(int)]])
    alpha = np.clip(d + 0.8, 0, 1)
    # paper body: two-tone mottling + fine fibres + speckles
    mott = periodic_noise_2d(rng)
    fib = periodic_noise_2d(rng, terms=60)
    t = 0.55 * mott + 0.45 * fib
    col = np.zeros((SIZE, SIZE, 3))
    for c in range(3):
        col[..., c] = base[c] * (1 - t) + base2[c] * t
    # aged, slightly burnt edge band
    edge = np.clip(1 - d / burn, 0, 1) ** 1.6
    burnt = np.array([150, 112, 60])
    col = col * (1 - 0.55 * edge[..., None]) + burnt * (0.55 * edge[..., None])
    # darker lip right at the tear
    lip = np.clip(1 - d / 2.2, 0, 1)
    col = col * (1 - 0.35 * lip[..., None]) + np.array([112, 80, 40]) * (0.35 * lip[..., None])
    # periodic speckles
    for _ in range(140):
        sx, sy = nrng.randint(0, PERIOD), nrng.randint(0, PERIOD)
        r = nrng.uniform(0.4, 1.3)
        a = nrng.uniform(0.05, 0.16)
        for ox in (0, PERIOD):
            for oy in (0, PERIOD):
                cx, cy = sx + ox, sy + oy
                m = ((x - cx) ** 2 + (y - cy) ** 2) <= r * r
                col[m] = col[m] * (1 - a) + np.array([110, 85, 45]) * a
    img = np.dstack([np.clip(col, 0, 255), alpha * 255]).astype(np.uint8)
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray(img, 'RGBA').save(OUT / f'{name}.png', optimize=True)
    print('wrote', OUT / f'{name}.png')


if __name__ == '__main__':
    make('paper_page', 7)
    make('paper_card', 19, base=(238, 228, 200), base2=(226, 212, 176), amp=5.5, burn=12)
