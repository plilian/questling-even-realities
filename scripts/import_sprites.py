#!/usr/bin/env python3
"""
Import the companion sprite sheet (assets/source/companions_sheet.png:
5 columns × 8 rows, transparent background, row order = idle, happy, annoyed, thinking,
surprised, celebrating, concerned, sleepy) and re-grid every cell onto a true pixel grid.

Outputs the same stable paths the app already uses:
  public/assets/companions/<id>/<emotion>.png   (full-resolution cleaned cell, transparent;
                                                 SPRITE_GRID=48 re-grids to a strict pixel grid instead)
  public/assets/companions/<id>/react_<n>.png   (reaction sequence built from state frames)
  public/assets/glasses/companions/<id>/<emotion>.png (144×144 greyscale for the G2)
"""
import os
import sys
from collections import Counter
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets', 'source', 'companions_sheet.png')
PUB = os.path.join(ROOT, 'public', 'assets')
GEN = os.path.join(ROOT, 'assets', 'generated')
IDS = ['grumpy', 'commander', 'optimist', 'sage', 'savage']
EMOS = ['idle', 'happy', 'annoyed', 'thinking', 'surprised', 'celebrating', 'concerned', 'sleepy']
G = int(os.environ.get('SPRITE_GRID', '0'))  # 0 = keep full resolution (default)


def runs(arr, minlen=20):
    out, s = [], None
    for i, v in enumerate(arr):
        if v > 0 and s is None:
            s = i
        if v == 0 and s is not None:
            if i - s > minlen:
                out.append((s, i - 1))
            s = None
    if s is not None:
        out.append((s, len(arr) - 1))
    return out


def clean(im):
    im = im.convert('RGBA')
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            px[x, y] = (r, g, b, 255) if a >= 110 else (0, 0, 0, 0)
    return im


def cells(sheet):
    px = sheet.load()
    W, H = sheet.size
    cols = [sum(1 for y in range(H) if px[x, y][3] > 0) for x in range(W)]
    rows = [sum(1 for x in range(W) if px[x, y][3] > 0) for y in range(H)]
    cr, rr = runs(cols), runs(rows)
    if len(cr) != 5 or len(rr) != 8:
        sys.exit(f'unexpected grid {len(cr)}x{len(rr)}')
    # common square box per cell, bottom-aligned (feet on the ground), centred horizontally
    side = max(max(b - a for a, b in cr), max(b - a for a, b in rr)) + 6
    out = {}
    for ri, (y0, y1) in enumerate(rr):
        for ci, (x0, x1) in enumerate(cr):
            crop = sheet.crop((x0, y0, x1 + 1, y1 + 1))
            canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
            canvas.alpha_composite(crop, ((side - crop.width) // 2, side - crop.height - 2))
            out[(IDS[ci], EMOS[ri])] = canvas
    return out, side


def regrid(im, g):
    """Majority colour per block with the best sub-pixel phase → true g×g pixel art."""
    side = im.width
    step = side / g
    best = None
    for ph in (0.0, 0.25, 0.5, 0.75):
        off = ph * step
        out = Image.new('RGBA', (g, g), (0, 0, 0, 0))
        po = out.load()
        src = im.load()
        score = 0
        for gy in range(g):
            for gx in range(g):
                xs = range(int(gx * step + off), min(side, int((gx + 1) * step + off)))
                ys = range(int(gy * step + off), min(side, int((gy + 1) * step + off)))
                c = Counter()
                for y in ys:
                    for x in xs:
                        p = src[x, y]
                        c[(p[0] // 8, p[1] // 8, p[2] // 8, 255) if p[3] else (0, 0, 0, 0)] += 1
                if not c:
                    continue
                (col, n), = c.most_common(1)
                score += n
                po[gx, gy] = (col[0] * 8 + 4, col[1] * 8 + 4, col[2] * 8 + 4, 255) if col[3] else (0, 0, 0, 0)
        if best is None or score > best[0]:
            best = (score, out)
    return best[1]


def glasses(img):
    """Green display: transparent → off, dark outline → brightest, fills → mid tones.
    Uses a head-and-shoulders crop so expressions stay legible at 144×144 on the G2."""
    if img.width != 144:
        a = img.getchannel('A').load()
        W, H = img.size
        colc = [sum(1 for y in range(H) if a[x, y] >= 128) for x in range(W)]
        rowc = [sum(1 for x in range(W) if a[x, y] >= 128) for y in range(H)]
        xs = [x for x, c in enumerate(colc) if c > 14]  # body only: ignore thin detached marks
        ys = [y for y, c in enumerate(rowc) if c > 14]
        bx0, bx1, by0, by1 = xs[0], xs[-1], ys[0], ys[-1]
        box = int(max(bx1 - bx0, (by1 - by0) * 0.9) * 0.8)
        cx = (bx0 + bx1) // 2
        x0, y0 = cx - box // 2, max(0, by0 - 3)
        crop = Image.new('RGBA', (box, box), (0, 0, 0, 0))
        crop.alpha_composite(img.crop((max(0, x0), y0, min(img.width, x0 + box), min(img.height, y0 + box))), (max(0, -x0), 0))
        img = crop.resize((144, 144), Image.LANCZOS)
    w, h = img.size
    out = Image.new('L', (w, h), 0)
    s, d = img.load(), out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = s[x, y]
            if a < 128:
                continue
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            d[x, y] = 255 if lum < 42 else int(14 + (lum / 255.0) ** 1.35 * 125)
    return out.resize((144, 144), Image.NEAREST)


def shift(img, dx, dy):
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    out.alpha_composite(img, (dx, dy))
    return out


REACT = {  # signature reaction from consistent state frames (+ small motion)
    'grumpy': [('annoyed', 0, 0), ('thinking', 0, 0), ('annoyed', 0, 0)],          # eye-roll grumble
    'commander': [('idle', 0, 0), ('celebrating', 0, -1), ('happy', 0, 0)],        # salute
    'optimist': [('happy', 0, 0), ('celebrating', 0, -3), ('happy', 0, 0)],        # bounce
    'sage': [('thinking', 0, 0), ('surprised', 0, 0), ('happy', 0, 0)],            # staff glow → insight
    'savage': [('surprised', -1, 0), ('celebrating', 1, 0), ('happy', 0, 0)],      # chaotic laugh
}


def main():
    sheet = clean(Image.open(SRC))
    cs, side = cells(sheet)
    sprites = {}
    for (cid, emo), im in cs.items():
        sp = regrid(im, G) if G else im
        sprites[(cid, emo)] = sp
        d = os.path.join(PUB, 'companions', cid)
        os.makedirs(d, exist_ok=True)
        sp.quantize(colors=48, method=Image.Quantize.FASTOCTREE).save(os.path.join(d, f'{emo}.png'), optimize=True)
        gd = os.path.join(PUB, 'glasses', 'companions', cid)
        os.makedirs(gd, exist_ok=True)
        glasses(sp).save(os.path.join(gd, f'{emo}.png'), optimize=True)
    for cid, frames in REACT.items():
        for n, (emo, dx, dy) in enumerate(frames):
            k = 1 if G else max(1, round(sprites[(cid, emo)].width / 48))
            fr = shift(sprites[(cid, emo)], dx * k, dy * k)
            fr.quantize(colors=48, method=Image.Quantize.FASTOCTREE).save(os.path.join(PUB, 'companions', cid, f'react_{n}.png'), optimize=True)
            glasses(fr).save(os.path.join(PUB, 'glasses', 'companions', cid, f'react_{n}.png'), optimize=True)
    # brand mascot + app icon from the sprite sheet
    hero = sprites[('optimist', 'happy')]
    hero.save(os.path.join(PUB, 'brand', 'mascot.png'), optimize=True)
    icon = Image.new('RGBA', hero.size, (25, 37, 29, 255))
    icon.alpha_composite(hero)
    icon.resize((192, 192), Image.LANCZOS).save(os.path.join(PUB, 'brand', 'app-icon-192.png'), optimize=True)
    # review sheets
    cs_ = 144
    sheet_out = Image.new('RGBA', (5 * (cs_ + 10) + 10, 8 * (cs_ + 10) + 10), (25, 37, 29, 255))
    for ci, cid in enumerate(IDS):
        for ri, emo in enumerate(EMOS):
            sheet_out.alpha_composite(sprites[(cid, emo)].resize((cs_, cs_), Image.LANCZOS), (10 + ci * (cs_ + 10), 10 + ri * (cs_ + 10)))
    os.makedirs(GEN, exist_ok=True)
    sheet_out.save(os.path.join(GEN, 'contact_sheet.png'))
    gs = Image.new('L', (8 * 144 + 20, 5 * 144 + 20), 0)
    for ri, cid in enumerate(IDS):
        for ci, emo in enumerate(EMOS):
            gs.paste(Image.open(os.path.join(PUB, 'glasses', 'companions', cid, f'{emo}.png')), (10 + ci * 144, 10 + ri * 144))
    gs.save(os.path.join(GEN, 'glasses_contact_sheet.png'))
    print(f'imported 40 sprites ({f"{G}x{G} grid" if G else f"full resolution {side}x{side}"})')


if __name__ == '__main__':
    main()
