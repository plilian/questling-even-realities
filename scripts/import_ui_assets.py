#!/usr/bin/env python3
"""Import the painted UI art sheets (assets/source/) into public/assets.

Every option is independent; pass only the sheets you have:

  python3 scripts/import_ui_assets.py \
      --scene dawn=path.png --scene day=path.png --scene dusk=path.png --scene night=path.png \
      --icons quest_icons.png  (6x4 grid)  --items items.png (4x2 grid) \
      --heroes heroes.png (3x1 grid)       --ruins ruins.png

The background colour is read from the image corners (ask for flat #FF00FF) and keyed out.
Each grid cell is trimmed to its object, padded square, resized and quantized to 48 colours so
pixel-art edges stay crisp and files stay small. src/ui/art/manifest.ts is rewritten to match.
"""
import argparse
import re
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / 'public' / 'assets'
MANIFEST = ROOT / 'src' / 'ui' / 'art' / 'manifest.ts'

QUEST_ICON_IDS = [
    'laptop', 'book', 'calendar', 'dumbbell', 'meal', 'books',
    'backpack', 'envelope', 'phone', 'basket', 'broom', 'watering_can',
    'coins', 'medicine', 'shoe', 'palette', 'checklist', 'lute',
    'bed', 'house', 'gift', 'herb', 'quill', 'hourglass',
]
ITEM_IDS = ['wooden_sword', 'iron_sword', 'travelers_cloak', 'silver_ring', 'sages_staff', 'guardian_shield', 'golden_crown', 'adventurers_badge']
HERO_IDS = ['adventurer', 'knight', 'mage']
# 4×4 sheet: skills, quest categories, then 8 achievement medals
EXTRA_ICON_FILES = [
    'skill_str', 'skill_int', 'skill_dis', 'skill_soc',
    'cat_daily', 'cat_personal', 'cat_work', 'cat_boss',
    'ach_first_quest', 'ach_first_level_up', 'ach_five_quests', 'ach_first_boss',
    'ach_goal_achieved', 'ach_consistent', 'ach_knowledge_seeker', 'ach_balanced_hero',
]


def key_background(img: Image.Image, tol: int = 60) -> Image.Image:
    a = np.array(img.convert('RGBA')).astype(int)
    h, w = a.shape[:2]
    k = max(2, min(h, w) // 60)
    corners = np.concatenate([a[:k, :k].reshape(-1, 4), a[:k, -k:].reshape(-1, 4), a[-k:, :k].reshape(-1, 4), a[-k:, -k:].reshape(-1, 4)])
    bg = np.median(corners[:, :3], axis=0)
    dist = np.sqrt(((a[..., :3] - bg) ** 2).sum(-1))
    alpha = np.clip((dist - tol * 0.5) / (tol * 0.5), 0, 1)
    # de-fringe: pull keyed colour out of semi-transparent edge pixels
    out = a.copy()
    out[..., 3] = (alpha * a[..., 3]).astype(int)
    semi = (alpha > 0) & (alpha < 1)
    for c in range(3):
        ch = out[..., c].astype(float)
        ch[semi] = np.clip((ch[semi] - bg[c] * (1 - alpha[semi])) / np.maximum(alpha[semi], 1e-3), 0, 255)
        out[..., c] = ch.astype(int)
    # remove the background-tinted halo: edge pixels that still carry the key colour's hue
    from scipy import ndimage

    for _ in range(2):
        clear = out[..., 3] < 8
        edge = ndimage.binary_dilation(clear, iterations=1) & ~clear
        r, g, b = out[..., 0], out[..., 1], out[..., 2]
        if bg[1] < bg[0] - 80 and bg[1] < bg[2] - 80:  # magenta-like key
            tinted = (r - g > 45) & (b - g > 45) & (np.abs(r - b) < 90)
        else:
            tinted = np.sqrt(((out[..., :3] - bg) ** 2).sum(-1)) < tol * 1.6
        out[edge & tinted, 3] = 0
    return Image.fromarray(out.astype(np.uint8), 'RGBA')


def key_border_flood(img: Image.Image, tol: float = 26) -> Image.Image:
    """Remove only the background region connected to the image border (for art on white/flat paper
    whose interior also contains light colours, e.g. a pale sky inside an archway)."""
    from scipy import ndimage

    a = np.array(img.convert('RGBA')).astype(int)
    h, w = a.shape[:2]
    k = max(2, min(h, w) // 60)
    corners = np.concatenate([a[:k, :k].reshape(-1, 4), a[:k, -k:].reshape(-1, 4), a[-k:, :k].reshape(-1, 4), a[-k:, -k:].reshape(-1, 4)])
    bg = np.median(corners[:, :3], axis=0)
    near = np.sqrt(((a[..., :3] - bg) ** 2).sum(-1)) < tol
    labels, _ = ndimage.label(near)
    border = set(np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))) - {0}
    mask = np.isin(labels, list(border))
    # soften the cut by one pixel
    soft = ndimage.binary_dilation(mask, iterations=1) & ~mask
    out = a.copy()
    out[mask, 3] = 0
    out[soft, 3] = (out[soft, 3] * 0.5).astype(int)
    return Image.fromarray(out.astype(np.uint8), 'RGBA')


def trim_square(cell: Image.Image, pad_ratio: float = 0.06) -> Image.Image:
    bbox = cell.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox()
    if not bbox:
        return cell
    obj = cell.crop(bbox)
    side = int(max(obj.size) * (1 + 2 * pad_ratio))
    sq = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    sq.paste(obj, ((side - obj.width) // 2, (side - obj.height) // 2))
    return sq


def quantize(img: Image.Image, colors: int = 48) -> Image.Image:
    alpha = img.getchannel('A')
    q = img.convert('RGB').quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert('RGBA')
    q.putalpha(alpha.point(lambda v: 0 if v < 40 else (255 if v > 215 else v)))
    return q


def grid(path: str, cols: int, rows: int):
    """Yield one RGBA image per grid cell, in reading order.

    Objects are found as connected blobs on the whole sheet (slightly dilated so steam, coins or a
    gem stay attached) and each blob goes to the cell holding its centre. This keeps objects that
    cross a grid line whole and drops slivers of neighbours that a plain crop would include.
    """
    from scipy import ndimage

    img = key_background(Image.open(path))
    a = np.array(img)
    h, w = a.shape[:2]
    solid = a[..., 3] > 24
    grown = ndimage.binary_dilation(solid, iterations=max(2, min(w, h) // 160))
    labels, n = ndimage.label(grown)
    cw, ch = w / cols, h / rows
    cells = {}
    min_px = w * h * 0.0004
    for lab, sl in enumerate(ndimage.find_objects(labels), start=1):
        if sl is None:
            continue
        part = (labels[sl] == lab) & solid[sl]
        if part.sum() < min_px:
            continue
        ys, xs = np.nonzero(part)
        cy, cx = ys.mean() + sl[0].start, xs.mean() + sl[1].start
        key = (min(rows - 1, int(cy // ch)), min(cols - 1, int(cx // cw)))
        cells.setdefault(key, []).append(lab)
    for r in range(rows):
        for c in range(cols):
            labs = cells.get((r, c), [])
            keep = np.isin(labels, labs) & solid if labs else np.zeros_like(solid)
            out = a.copy()
            out[~keep, 3] = 0
            ys, xs = np.nonzero(keep) if labs else (np.array([0]), np.array([0]))
            box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
            yield Image.fromarray(out, 'RGBA').crop(box)


KIT_PARTS = {
    # name: (x range, y range) of the blob centre, as fractions of the sheet
    'page': ((0.0, 0.32), (0.0, 0.66)),
    'card': ((0.32, 0.76), (0.0, 0.62)),
    'seal': ((0.76, 1.0), (0.0, 0.33)),
    'ribbon': ((0.76, 1.0), (0.33, 0.62)),
    'bar': ((0.0, 0.66), (0.62, 1.0)),
    'hex': ((0.66, 1.0), (0.58, 1.0)),
}


def kit_parts(path: str):
    """Find the six UI-kit objects (page, card, seal, ribbon, bar frame, hex frame) by position."""
    from scipy import ndimage

    img = key_background(Image.open(path))
    a = np.array(img)
    h, w = a.shape[:2]
    solid = a[..., 3] > 24
    labels, _ = ndimage.label(ndimage.binary_dilation(solid, iterations=6))
    found = {}
    for lab, sl in enumerate(ndimage.find_objects(labels), start=1):
        part = (labels[sl] == lab) & solid[sl]
        if part.sum() < w * h * 0.0005:
            continue
        ys, xs = np.nonzero(part)
        cx, cy = (xs.mean() + sl[1].start) / w, (ys.mean() + sl[0].start) / h
        for name, ((x0, x1), (y0, y1)) in KIT_PARTS.items():
            if x0 <= cx < x1 and y0 <= cy < y1:
                found.setdefault(name, []).append(lab)
    for name, labs in found.items():
        keep = np.isin(labels, labs) & solid
        ys, xs = np.nonzero(keep)
        out = a.copy()
        out[~keep, 3] = 0
        yield name, Image.fromarray(out, 'RGBA').crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))


def save(img: Image.Image, rel: str):
    out = PUB / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.suffix == '.webp':
        img.save(out, quality=86, method=6)
    else:
        img.save(out, optimize=True)
    print('wrote', out.relative_to(ROOT), f'{out.stat().st_size // 1024} KB')


def read_manifest():
    text = MANIFEST.read_text() if MANIFEST.exists() else ''
    icons = re.findall(r"'([a-z_]+)'", re.search(r'QUEST_ICON_FILES[^=]*=\s*\[(.*?)\]', text, re.S).group(1)) if 'QUEST_ICON_FILES' in text else []
    heroes = 'HAS_HERO_SPRITES = true' in text
    ruins = 'HAS_RUINS_BACKDROP = true' in text
    return icons, heroes, ruins


def write_manifest(icons, heroes, ruins):
    MANIFEST.write_text(
        '/**\n * Painted UI art available in this build. Rewritten by scripts/import_ui_assets.py when the\n'
        " * source sheets are imported; empty lists mean \"use the generated placeholders\".\n */\n"
        f"export const QUEST_ICON_FILES: readonly string[] = [{', '.join(repr(i) for i in icons)}]\n"
        f'export const HAS_HERO_SPRITES = {str(heroes).lower()}\n'
        f'export const HAS_RUINS_BACKDROP = {str(ruins).lower()}\n'
    )
    print('wrote', MANIFEST.relative_to(ROOT))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scene', action='append', default=[], help='dawn|day|dusk|night=path')
    ap.add_argument('--icons')
    ap.add_argument('--items')
    ap.add_argument('--heroes')
    ap.add_argument('--ruins')
    ap.add_argument('--kit', help='UI kit sheet: parchment page, card, wax seal, ribbon, bar frame, hex frame')
    ap.add_argument('--extra-icons', help='4x4 sheet: skills, categories, achievement medals')
    ap.add_argument('--from-source', action='store_true', help='use the source sheets kept in assets/source/')
    a = ap.parse_args()
    if a.from_source:
        src = ROOT / 'assets' / 'source'
        pick = lambda n: str(src / n) if (src / n).exists() else None  # noqa: E731
        a.scene = [f'{t}={pick(f"scene_{t}.png")}' for t in ('dawn', 'day', 'dusk', 'night') if pick(f'scene_{t}.png')]
        a.icons, a.items, a.heroes = pick('quest_icons.png'), pick('items.png'), pick('heroes.png')
        a.ruins, a.kit = pick('ruins.png'), pick('ui_kit.png')
        a.extra_icons = pick('icons_extra.png')
    icons, heroes, ruins = read_manifest()

    for spec in a.scene:
        name, path = spec.split('=', 1)
        assert name in ('dawn', 'day', 'dusk', 'night'), name
        img = Image.open(path).convert('RGB')
        # cover-crop to 16:9 and downscale; quantize keeps the pixel-art look and the size small
        tw, th = 960, 540
        s = max(tw / img.width, th / img.height)
        img = img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)
        l, t = (img.width - tw) // 2, (img.height - th) // 2
        img = img.crop((l, t, l + tw, t + th))
        save(img, f'scenes/{name}.webp')

    if a.icons:
        icons = []
        for qid, cell in zip(QUEST_ICON_IDS, grid(a.icons, 6, 4)):
            save(quantize(trim_square(cell).resize((96, 96), Image.LANCZOS)), f'quest/{qid}.png')
            icons.append(qid)

    if a.items:
        for iid, cell in zip(ITEM_IDS, grid(a.items, 4, 2)):
            save(quantize(trim_square(cell).resize((96, 96), Image.LANCZOS)), f'icons/item_{iid}.png')

    if a.extra_icons:
        for fid, cell in zip(EXTRA_ICON_FILES, grid(a.extra_icons, 4, 4)):
            save(quantize(trim_square(cell).resize((96, 96), Image.LANCZOS)), f'icons/{fid}.png')

    if a.heroes:
        for hid, cell in zip(HERO_IDS, grid(a.heroes, 3, 1)):
            bbox = cell.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox()
            obj = cell.crop(bbox) if bbox else cell
            h = 336
            save(quantize(obj.resize((max(1, round(obj.width * h / obj.height)), h), Image.LANCZOS)), f'avatars/{hid}_full.png')
            # glasses portrait (144×144 greyscale) from the same art: head and shoulders
            import importlib.util

            spec = importlib.util.spec_from_file_location('import_sprites', Path(__file__).with_name('import_sprites.py'))
            sprites = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(sprites)
            top = obj.crop((0, 0, obj.width, int(obj.height * 0.55))).resize((300, round(0.55 * obj.height * 300 / obj.width)), Image.LANCZOS)
            save(sprites.glasses(top), f'glasses/avatars/{hid}.png')
        heroes = True

    if a.ruins:
        img = key_border_flood(Image.open(a.ruins))
        w = 480
        save(img.resize((w, round(img.height * w / img.width)), Image.LANCZOS), 'frames/ruins.webp')
        ruins = True

    if a.kit:
        # sized for ~2x the on-screen size
        width = {'page': 280, 'card': 400, 'seal': 200, 'ribbon': 96, 'bar': 560, 'hex': 150}
        for name, part in kit_parts(a.kit):
            tw = width.get(name, part.width)
            save(part.resize((tw, round(part.height * tw / part.width)), Image.LANCZOS), f'kit/{name}.webp')

    write_manifest(icons, heroes, ruins)


if __name__ == '__main__':
    main()
