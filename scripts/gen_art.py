#!/usr/bin/env python3
"""
Questling original pixel-art generator (all assets are original, programmatic).

Outputs (stable names):
  public/assets/companions/<id>/<emotion>.png      48x48 native (mobile scales with nearest-neighbour)
  public/assets/companions/<id>/react_<n>.png      reaction sequence frames
  public/assets/glasses/companions/<id>/<emotion>.png  144x144 greyscale "glow line-art" for the G2 image container
  public/assets/avatars/<id>.png (+ glasses variant)
  public/assets/icons/*.png                         16x16 UI icons
  public/assets/brand/logo.png, app-icon.png, evenhub-icon-24.png
  assets/generated/contact_sheet.png                review sheet
  assets/generated/manifest.json                    dimensions + attribution
"""
import json
import math
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(ROOT, 'public', 'assets')
GEN = os.path.join(ROOT, 'assets', 'generated')
S = 48
EMOTIONS = ['idle', 'happy', 'annoyed', 'thinking', 'surprised', 'celebrating', 'concerned', 'sleepy']


def hexc(h, a=255):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


T = (0, 0, 0, 0)


class C:
    """Pixel canvas with simple raster primitives (pixel centres)."""

    def __init__(self, w=S, h=S):
        self.w, self.h = w, h
        self.px = [[T for _ in range(w)] for _ in range(h)]
        self.fx = [[T for _ in range(w)] for _ in range(h)]  # effects layer (not outlined)

    def set(self, x, y, c, fx=False):
        x, y = int(round(x)), int(round(y))
        if 0 <= x < self.w and 0 <= y < self.h:
            (self.fx if fx else self.px)[y][x] = c

    def get(self, x, y):
        if 0 <= x < self.w and 0 <= y < self.h:
            return self.px[y][x]
        return T

    def rect(self, x0, y0, x1, y1, c, fx=False):
        for y in range(int(y0), int(y1) + 1):
            for x in range(int(x0), int(x1) + 1):
                self.set(x, y, c, fx)

    def ellipse(self, cx, cy, rx, ry, c, fx=False, clip=None):
        for y in range(int(cy - ry - 1), int(cy + ry + 2)):
            for x in range(int(cx - rx - 1), int(cx + rx + 2)):
                dx = (x + 0.5 - cx) / max(rx, 0.01)
                dy = (y + 0.5 - cy) / max(ry, 0.01)
                if dx * dx + dy * dy <= 1.0 and (clip is None or clip(x, y)):
                    self.set(x, y, c, fx)

    def poly(self, pts, c, fx=False):
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        for y in range(int(min(ys)) - 1, int(max(ys)) + 2):
            for x in range(int(min(xs)) - 1, int(max(xs)) + 2):
                if _inside(x + 0.5, y + 0.5, pts):
                    self.set(x, y, c, fx)

    def line(self, x0, y0, x1, y1, c, fx=False):
        x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
        err = dx + dy
        while True:
            self.set(x0, y0, c, fx)
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * err
            if e2 >= dy:
                err += dy
                x0 += sx
            if e2 <= dx:
                err += dx
                y0 += sy

    def recolor(self, src, dst, cond):
        for y in range(self.h):
            for x in range(self.w):
                if self.px[y][x] == src and cond(x, y):
                    self.px[y][x] = dst

    def outline(self, oc):
        out = [row[:] for row in self.px]
        for y in range(self.h):
            for x in range(self.w):
                if self.px[y][x][3] == 0:
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        n = self.get(x + dx, y + dy)
                        if n[3] != 0 and n != oc:
                            out[y][x] = oc
                            break
        self.px = out

    def shift(self, dx, dy):
        n = C(self.w, self.h)
        for y in range(self.h):
            for x in range(self.w):
                if self.px[y][x][3]:
                    n.set(x + dx, y + dy, self.px[y][x])
                if self.fx[y][x][3]:
                    n.set(x + dx, y + dy, self.fx[y][x], True)
        return n

    def image(self):
        img = Image.new('RGBA', (self.w, self.h), T)
        p = img.load()
        for y in range(self.h):
            for x in range(self.w):
                c = self.fx[y][x] if self.fx[y][x][3] else self.px[y][x]
                p[x, y] = c
        return img


def _inside(x, y, pts):
    n = len(pts)
    ins = False
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-9) + xi):
            ins = not ins
        j = i
    return ins


# ---------------------------------------------------------------- shared FX
GOLD = hexc('D7B875')
GOLD_HI = hexc('F4E3A1')
WHITE = hexc('F7F3E3')
INK = hexc('1A1410')


def sparkle(c, x, y, col=GOLD_HI, big=False):
    c.set(x, y, col, True)
    for d in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        c.set(x + d[0], y + d[1], col, True)
    if big:
        for d in ((2, 0), (-2, 0), (0, 2), (0, -2)):
            c.set(x + d[0], y + d[1], GOLD, True)


def bang(c, x, y, col=GOLD_HI):
    c.rect(x, y, x + 1, y + 5, col, True)
    c.rect(x, y + 7, x + 1, y + 8, col, True)


def qmark(c, x, y, col=WHITE):
    for (px, py) in [(1, 0), (2, 0), (3, 0), (0, 1), (4, 1), (4, 2), (3, 3), (2, 4), (2, 6)]:
        c.set(x + px, y + py, col, True)


def zzz(c, x, y, col=WHITE):
    for (ox, oy, s) in [(0, 6, 3), (4, 1, 4)]:
        for i in range(s):
            c.set(x + ox + i, y + oy, col, True)
            c.set(x + ox + i, y + oy + s - 1, col, True)
            c.set(x + ox + s - 1 - i, y + oy + i, col, True)


def sweat(c, x, y):
    blue = hexc('8EC9F2')
    c.set(x, y, blue, True)
    c.rect(x - 1, y + 1, x + 1, y + 2, blue, True)
    c.set(x, y + 3, blue, True)
    c.set(x, y + 1, hexc('DFF2FF'), True)


def dots(c, x, y, col=WHITE):
    for i in range(3):
        c.rect(x + i * 3, y, x + i * 3 + 1, y + 1, col, True)


def confetti(c, seed=0):
    cols = [hexc('E07A5F'), hexc('75D89A'), GOLD_HI, hexc('8FA9C9'), hexc('B39DDB')]
    pts = [(4, 6), (42, 5), (7, 20), (41, 18), (3, 33), (44, 31), (12, 3), (36, 9)]
    for i, (x, y) in enumerate(pts):
        col = cols[(i + seed) % len(cols)]
        c.rect(x, y, x + 1, y, col, True) if i % 2 else c.rect(x, y, x, y + 1, col, True)


# ---------------------------------------------------------------- face kit
class Face:
    def __init__(self, eyes, eye_style, sclera, pupil, brow_col, brow_dy, mouth, mouth_w, skin, mouth_col=INK, lid_col=None):
        self.eyes = eyes  # [(x,y),(x,y)] top-left of eye box
        self.style = eye_style
        self.sclera = sclera
        self.pupil = pupil
        self.brow_col = brow_col
        self.brow_dy = brow_dy
        self.mouth = mouth  # centre
        self.mw = mouth_w
        self.skin = skin
        self.mouth_col = mouth_col
        self.lid = lid_col or skin


def draw_eyes(c, f, kind, look=(0, 0)):
    for i, (ex, ey) in enumerate(f.eyes):
        big = f.style == 'big'
        w, h = (4, 5) if big else (3, 3)
        if kind in ('happy', 'celebrating'):
            # ^ ^ closed happy eyes
            c.set(ex, ey + 2, f.pupil)
            c.set(ex + 1, ey + 1, f.pupil)
            c.set(ex + w - 2, ey + 1, f.pupil)
            c.set(ex + w - 1, ey + 2, f.pupil)
            if big:
                c.rect(ex + 1, ey + 1, ex + 2, ey + 1, f.pupil)
            continue
        if kind == 'sleepy':
            c.rect(ex, ey + h - 2, ex + w - 1, ey + h - 2, f.pupil)
            continue
        if kind == 'surprised':
            c.rect(ex - 1, ey - 1, ex + w, ey + h, f.sclera)
            c.rect(ex + w // 2 - 1, ey + h // 2 - 1, ex + w // 2, ey + h // 2, f.pupil)
            continue
        c.rect(ex, ey, ex + w - 1, ey + h - 1, f.sclera)
        px = ex + (w // 2) - (0 if big else 1) + look[0]
        py = ey + (h // 2) - (1 if big else 1) + look[1]
        pw = 2 if big else 2
        c.rect(px, py, px + pw - 1, py + (2 if big else 1), f.pupil)
        if big:
            c.set(px, py, WHITE)
        if kind == 'annoyed':
            c.rect(ex, ey, ex + w - 1, ey + (2 if big else 1), f.lid)
        if kind == 'concerned':
            c.rect(ex, ey, ex + w - 1, ey, f.lid)


def draw_brows(c, f, kind, thick=1, wide=0):
    for i, (ex, ey) in enumerate(f.eyes):
        big = f.style == 'big'
        w = (4 if big else 3) + wide
        x0 = ex - (wide // 2)
        by = ey - 2 + f.brow_dy
        inner_left = (i == 0)
        for k in range(w):
            x = x0 + k
            t = k / max(w - 1, 1)
            if kind == 'annoyed':
                dy = round(t * 2) if inner_left else round((1 - t) * 2)
            elif kind in ('concerned',):
                dy = round((1 - t) * 2) if inner_left else round(t * 2)
                dy = -dy + 1
            elif kind == 'surprised':
                dy = -2
            elif kind == 'thinking':
                dy = -1 if i == 1 else 0
            else:
                dy = 0
            for th in range(thick):
                c.set(x, by + dy + th, f.brow_col)


def draw_mouth(c, f, kind):
    mx, my, w = f.mouth[0], f.mouth[1], f.mw
    m = f.mouth_col
    tongue = hexc('D9605A')
    if kind in ('happy',):
        c.set(mx - w // 2, my - 1, m)
        c.rect(mx - w // 2 + 1, my, mx + w // 2 - 1, my, m)
        c.set(mx + w // 2, my - 1, m)
    elif kind == 'celebrating':
        c.rect(mx - w // 2, my - 1, mx + w // 2, my - 1, m)
        c.rect(mx - w // 2 + 1, my, mx + w // 2 - 1, my + 1, m)
        c.rect(mx - 1, my + 1, mx + 1, my + 1, tongue)
    elif kind == 'annoyed':
        c.rect(mx - w // 2, my, mx + w // 2, my, m)
        c.set(mx + w // 2, my - 1, m)
    elif kind == 'thinking':
        c.rect(mx, my, mx + w // 2, my, m)
    elif kind == 'surprised':
        c.rect(mx - 1, my - 1, mx + 1, my + 1, m)
    elif kind == 'concerned':
        c.set(mx - w // 2, my + 1, m)
        c.rect(mx - w // 2 + 1, my, mx + w // 2 - 1, my, m)
        c.set(mx + w // 2, my + 1, m)
    elif kind == 'sleepy':
        c.rect(mx - 1, my, mx, my, m)
    else:  # idle
        c.rect(mx - w // 2 + 1, my, mx + w // 2 - 1, my, m)


def expression_fx(c, kind, head_top=(34, 6)):
    hx, hy = head_top
    if kind == 'surprised':
        bang(c, hx + 6, hy)
    elif kind == 'thinking':
        qmark(c, hx + 5, hy)
    elif kind == 'celebrating':
        confetti(c)
        sparkle(c, 5, 10, big=True)
        sparkle(c, 42, 14, big=True)
    elif kind == 'sleepy':
        zzz(c, hx + 3, hy - 2)
    elif kind == 'concerned':
        sweat(c, hx + 2, hy + 8)
    elif kind == 'happy':
        sparkle(c, hx + 7, hy + 2)


# ---------------------------------------------------------------- characters
def grumpy(kind, frame=None):
    c = C()
    skin, skin_d = hexc('E9B48A'), hexc('C98B64')
    beard, beard_d, beard_h = hexc('B5652F'), hexc('8A4721'), hexc('D88A4C')
    helm, helm_d, helm_h = hexc('8C939C'), hexc('5E646C'), hexc('BFC6CC')
    tunic, tunic_d = hexc('4F6B4A'), hexc('384D35')
    # shoulders / tunic
    c.ellipse(24, 49, 20, 11, tunic)
    c.recolor(tunic, tunic_d, lambda x, y: x > 30)
    # head
    c.ellipse(24, 23, 13, 12, skin)
    c.recolor(skin, skin_d, lambda x, y: x >= 33)
    # ears
    c.ellipse(10.5, 24, 2.5, 3.5, skin)
    c.ellipse(37.5, 24, 2.5, 3.5, skin_d)
    # beard: big triangle-ish mass
    c.poly([(9, 25), (39, 25), (37, 36), (30, 45), (24, 47), (18, 45), (11, 36)], beard)
    c.recolor(beard, beard_d, lambda x, y: (x + y) % 5 == 0 and y > 30)
    c.recolor(beard, beard_h, lambda x, y: (x * 3 + y) % 11 == 0 and y < 40)
    # moustache
    c.poly([(15, 30), (24, 28), (33, 30), (34, 33), (24, 31), (14, 33)], beard_d)
    # nose (bulbous)
    c.ellipse(24, 26.5, 3, 2.6, hexc('E79A7A'))
    c.set(23, 26, hexc('F3C0A3'))
    # helmet
    c.ellipse(24, 16, 14, 9, helm, clip=lambda x, y: y <= 16)
    c.rect(9, 16, 39, 18, helm_d)
    c.recolor(helm, helm_h, lambda x, y: x < 20 and y < 12)
    for x in range(11, 38, 4):
        c.set(x, 17, helm_h)
    # little horns
    c.poly([(9, 14), (4, 6), (6, 5), (12, 12)], WHITE)
    c.poly([(39, 14), (44, 6), (42, 5), (36, 12)], hexc('DCD3BE'))
    f = Face(eyes=[(16, 21), (29, 21)], eye_style='dot', sclera=WHITE, pupil=INK, brow_col=beard_d, brow_dy=0,
             mouth=(24, 35), mouth_w=6, skin=skin, mouth_col=hexc('4A1E10'))
    look = (0, 0)
    ek = kind
    if frame is not None:  # eye roll sequence
        look = [(-1, -1), (0, -1), (1, -1)][frame % 3]
        ek = 'idle'
    draw_eyes(c, f, ek, look)
    draw_brows(c, f, 'annoyed' if kind in ('idle', 'annoyed', 'thinking') else kind, thick=2, wide=3)
    draw_mouth(c, f, 'annoyed' if frame is not None else kind)
    c.outline(hexc('24150E'))
    if frame is not None:
        # exasperated sigh puff drifting away during the eye roll
        px, py = 38 + frame * 3, 33 - frame * 3
        c.ellipse(px, py, 2 + frame * 0.6, 1.6 + frame * 0.4, hexc('DDE6EA'), True)
        c.set(px - 3, py + 1, hexc('DDE6EA'), True)
    else:
        expression_fx(c, kind, (34, 4))
    return c


def commander(kind, frame=None):
    c = C()
    skin, skin_d = hexc('D9A27E'), hexc('B07C5C')
    steel, steel_d, steel_h = hexc('8FA9C9'), hexc('5C7593'), hexc('CFE0F2')
    plume, plume_d = hexc('C8453A'), hexc('8E2C25')
    gold = GOLD
    # pauldrons + chest
    c.ellipse(24, 50, 21, 12, steel)
    c.ellipse(7, 40, 7, 5, steel)
    c.ellipse(41, 40, 7, 5, steel)
    c.ellipse(6, 38, 4, 2, steel_h)
    c.recolor(steel, steel_d, lambda x, y: x > 32)
    c.rect(22, 40, 26, 47, gold)
    # neck
    c.rect(20, 33, 28, 38, skin_d)
    # face
    c.ellipse(24, 25, 9.5, 10, skin)
    c.recolor(skin, skin_d, lambda x, y: x >= 31)
    # helmet shell with open face
    c.ellipse(24, 20, 13, 12, steel, clip=lambda x, y: y < 20 or x < 15 or x > 33)
    c.recolor(steel, steel_d, lambda x, y: x > 31 and y > 10)
    c.recolor(steel, steel_h, lambda x, y: x < 18 and y < 15)
    c.rect(14, 17, 34, 18, gold)  # brow band
    c.rect(23, 18, 25, 26, steel_d)  # nasal guard
    # cheek guards
    c.poly([(12, 22), (16, 22), (16, 33), (13, 30)], steel)
    c.poly([(36, 22), (32, 22), (32, 33), (35, 30)], steel_d)
    # plume
    c.poly([(22, 9), (26, 9), (30, 2), (35, 1), (31, 6), (27, 10)], plume)
    c.poly([(22, 9), (24, 4), (29, 1), (26, 7)], plume_d)
    f = Face(eyes=[(18, 21), (27, 21)], eye_style='dot', sclera=WHITE, pupil=hexc('1F2A3A'), brow_col=hexc('3B2A20'), brow_dy=0,
             mouth=(24, 30), mouth_w=6, skin=skin, mouth_col=hexc('6B3A2A'))
    draw_eyes(c, f, kind)
    draw_brows(c, f, kind, thick=1)
    draw_mouth(c, f, kind)
    if kind == 'celebrating' or frame is not None:
        # salute: hand at the brow
        hand_y = 14 if (frame is None or frame >= 1) else 22
        c.ellipse(36, hand_y + 2, 3.5, 3, skin)
        c.rect(32, hand_y + 1, 38, hand_y + 2, skin)
        c.line(38, hand_y + 4, 42, hand_y + 14, steel_d)
        c.line(39, hand_y + 4, 43, hand_y + 14, steel_d)
    c.outline(hexc('141B26'))
    expression_fx(c, kind, (34, 4))
    return c


def optimist(kind, frame=None):
    c = C()
    body, body_d, body_h = hexc('8ED16F'), hexc('5FA24A'), hexc('BDEB9F')
    leaf, leaf_d = hexc('4FAE5C'), hexc('2F7F3F')
    cheek = hexc('F59C8F')
    dy = 0
    if frame is not None:
        dy = [0, -3, 0][frame % 3]
    # leaf ears
    c.poly([(12, 22 + dy), (1, 6 + dy), (4, 5 + dy), (17, 16 + dy)], leaf)
    c.line(4, 7 + dy, 14, 18 + dy, leaf_d)
    c.poly([(36, 22 + dy), (47, 6 + dy), (44, 5 + dy), (31, 16 + dy)], leaf)
    c.line(44, 7 + dy, 34, 18 + dy, leaf_d)
    # round body
    c.ellipse(24, 29 + dy, 16, 15, body)
    c.recolor(body, body_d, lambda x, y: (x - 24) ** 2 + (y - 22 - dy) ** 2 > 230 and y > 28 + dy)
    c.ellipse(19, 21 + dy, 4, 2.5, body_h)
    # little feet
    c.ellipse(16, 45 + dy, 4, 2.5, body_d)
    c.ellipse(32, 45 + dy, 4, 2.5, body_d)
    # sprout
    c.line(24, 14 + dy, 24, 9 + dy, leaf_d)
    c.ellipse(21, 8 + dy, 3, 1.6, leaf)
    c.ellipse(27.5, 7 + dy, 3, 1.6, leaf)
    # belly flower
    c.ellipse(24, 38 + dy, 2, 2, GOLD_HI)
    f = Face(eyes=[(16, 24 + dy), (28, 24 + dy)], eye_style='big', sclera=WHITE, pupil=hexc('20331F'), brow_col=leaf_d, brow_dy=0,
             mouth=(24, 33 + dy), mouth_w=6, skin=body, mouth_col=hexc('2A3A20'))
    draw_eyes(c, f, kind)
    if kind in ('annoyed', 'concerned', 'surprised', 'thinking'):
        draw_brows(c, f, kind)
    draw_mouth(c, f, kind if kind != 'idle' else 'happy')
    c.ellipse(13.5, 31 + dy, 2, 1.2, cheek)
    c.ellipse(34.5, 31 + dy, 2, 1.2, cheek)
    c.outline(hexc('183018'))
    expression_fx(c, kind, (34, 6))
    return c


def sage(kind, frame=None):
    c = C()
    robe, robe_d, robe_h = hexc('6A54A8'), hexc('47377A'), hexc('8E7BCB')
    skin, skin_d = hexc('E4BD9A'), hexc('BF9473')
    beard, beard_d = hexc('ECE8DF'), hexc('BDB6A8')
    staff, staff_d = hexc('8A5A33'), hexc('5E3B20')
    orb = hexc('9EE7FF')
    # staff (behind)
    c.rect(40, 8, 41, 47, staff)
    c.rect(41, 8, 41, 47, staff_d)
    c.ellipse(40.5, 6, 3.5, 3.5, orb)
    c.set(39, 5, WHITE)
    # robe shoulders
    c.poly([(6, 47), (12, 33), (36, 33), (42, 47)], robe)
    c.recolor(robe, robe_d, lambda x, y: x > 30)
    # hand on staff
    c.ellipse(40.5, 30, 2.5, 2.5, skin)
    # face
    c.ellipse(24, 24, 9, 9, skin)
    c.recolor(skin, skin_d, lambda x, y: x >= 30 and y < 34)
    # long beard
    c.poly([(15, 25), (33, 25), (31, 37), (27, 46), (24, 47), (21, 46), (17, 37)], beard)
    c.recolor(beard, beard_d, lambda x, y: x % 3 == 0 and y > 31)
    c.poly([(18, 28), (24, 26), (30, 28), (29, 30), (24, 29), (19, 30)], beard_d)
    # hat: brim + tall bent cone
    c.ellipse(24, 16, 16, 3, robe_d)
    c.poly([(12, 16), (36, 16), (30, 6), (26, 0), (21, 2), (19, 7)], robe)
    c.recolor(robe, robe_h, lambda x, y: x < 21 and y < 15)
    c.rect(14, 14, 34, 15, GOLD)
    # stars on hat
    for (sx, sy) in [(24, 8), (28, 12)]:
        c.set(sx, sy, GOLD_HI)
        c.set(sx - 1, sy, GOLD)
        c.set(sx + 1, sy, GOLD)
    f = Face(eyes=[(18, 20), (27, 20)], eye_style='dot', sclera=WHITE, pupil=hexc('2B2340'), brow_col=beard_d, brow_dy=0,
             mouth=(24, 31), mouth_w=4, skin=skin, mouth_col=hexc('6B5B4B'))
    ek = 'sleepy' if kind == 'idle' else kind  # calm half-closed default
    if kind == 'idle':
        for (ex, ey) in f.eyes:
            c.rect(ex, ey + 1, ex + 2, ey + 1, f.pupil)
            c.set(ex + 1, ey + 2, f.pupil)
    else:
        draw_eyes(c, f, ek)
    draw_brows(c, f, kind, thick=1, wide=1)
    draw_mouth(c, f, kind)
    glow = frame is not None or kind in ('celebrating', 'thinking')
    c.outline(hexc('1C1530'))
    if glow:
        r = [5, 7, 5][frame % 3] if frame is not None else 6
        for a in range(0, 360, 45):
            x = 40.5 + math.cos(math.radians(a)) * r
            y = 6 + math.sin(math.radians(a)) * r
            c.set(x, y, orb, True)
        c.ellipse(40.5, 6, 2, 2, WHITE, True)
    expression_fx(c, kind if kind != 'thinking' else 'thinking', (6, 6) if kind != 'thinking' else (6, 4))
    return c


def savage(kind, frame=None):
    c = C()
    skin, skin_d, skin_h = hexc('8DB255'), hexc('5F7D35'), hexc('B4D27C')
    hood, hood_d = hexc('B23A2E'), hexc('7A241C')
    leather = hexc('6E4A2E')
    shake = 0
    if frame is not None:
        shake = [-1, 1, 0][frame % 3]
    # body / leather vest
    c.ellipse(24 + shake, 49, 18, 11, leather)
    c.rect(22 + shake, 40, 26 + shake, 47, hood_d)
    # long horizontal ears
    c.poly([(13 + shake, 22), (0 + shake, 14), (1 + shake, 18), (12 + shake, 28)], skin)
    c.poly([(35 + shake, 22), (48 + shake, 14), (47 + shake, 18), (36 + shake, 28)], skin_d)
    c.line(3 + shake, 17, 11 + shake, 23, skin_d)
    # head (wide jaw)
    c.ellipse(24 + shake, 25, 12, 11, skin)
    c.recolor(skin, skin_d, lambda x, y: x >= 32 + shake)
    c.recolor(skin, skin_h, lambda x, y: x < 18 + shake and y < 22)
    # hood
    c.ellipse(24 + shake, 16, 13, 9, hood, clip=lambda x, y: y < 18)
    c.poly([(11 + shake, 17), (37 + shake, 17), (35 + shake, 14), (13 + shake, 14)], hood)
    c.poly([(30 + shake, 9), (40 + shake, 3), (38 + shake, 10)], hood_d)  # hood tail
    c.recolor(hood, hood_d, lambda x, y: x > 31 + shake)
    # pointy nose
    c.poly([(23 + shake, 24), (27 + shake, 27), (23 + shake, 28)], skin_d)
    eye_sclera = hexc('F3E36B')
    f = Face(eyes=[(16 + shake, 20), (28 + shake, 20)], eye_style='dot', sclera=eye_sclera, pupil=INK, brow_col=hexc('2E3A18'), brow_dy=0,
             mouth=(24 + shake, 32), mouth_w=10, skin=skin, mouth_col=hexc('3A1A14'))
    draw_eyes(c, f, kind)
    draw_brows(c, f, 'annoyed' if kind in ('idle', 'happy') else kind, thick=1, wide=1)
    # signature grin with teeth
    mx, my = 24 + shake, 32
    if kind in ('idle', 'happy', 'celebrating') or frame is not None:
        c.rect(mx - 6, my - 1, mx + 6, my + 1, hexc('3A1A14'))
        c.set(mx - 7, my - 2, hexc('3A1A14'))
        c.set(mx + 7, my - 2, hexc('3A1A14'))
        for tx in range(mx - 5, mx + 6, 2):
            c.set(tx, my - 1, WHITE)
        c.set(mx - 4, my + 1, WHITE)
        c.set(mx + 4, my + 1, WHITE)
        if kind == 'celebrating' or frame is not None:
            c.rect(mx - 6, my + 2, mx + 6, my + 3, hexc('3A1A14'))
            c.rect(mx - 2, my + 2, mx + 2, my + 3, hexc('D9605A'))
    else:
        draw_mouth(c, f, kind)
    if kind == 'annoyed' or (frame is not None and frame == 2 and kind == 'facepalm'):
        pass
    c.outline(hexc('1B210E'))
    if frame is not None:
        for i, (hx, hy) in enumerate([(3, 4), (37, 2), (40, 34)][: frame % 3 + 1]):
            # "HA" marks
            c.rect(hx, hy, hx, hy + 4, GOLD_HI, True)
            c.rect(hx + 2, hy, hx + 2, hy + 4, GOLD_HI, True)
            c.rect(hx, hy + 2, hx + 2, hy + 2, GOLD_HI, True)
            c.rect(hx + 4, hy + 1, hx + 4, hy + 4, GOLD_HI, True)
            c.rect(hx + 6, hy + 1, hx + 6, hy + 4, GOLD_HI, True)
            c.rect(hx + 5, hy, hx + 5, hy, GOLD_HI, True)
            c.rect(hx + 5, hy + 2, hx + 5, hy + 2, GOLD_HI, True)
    else:
        expression_fx(c, kind, (34, 4))
    return c


COMPANIONS = {'grumpy': grumpy, 'commander': commander, 'optimist': optimist, 'sage': sage, 'savage': savage}
OUTLINES = {'grumpy': (0x24, 0x15, 0x0E), 'commander': (0x14, 0x1B, 0x26), 'optimist': (0x18, 0x30, 0x18), 'sage': (0x1C, 0x15, 0x30), 'savage': (0x1B, 0x21, 0x0E)}


# ---------------------------------------------------------------- player avatars
def avatar(kind):
    c = C()
    skin, skin_d = hexc('E2B08C'), hexc('BD8A68')
    if kind == 'adventurer':
        tunic, tunic_d = hexc('3F7D5A'), hexc('2B5A40')
        hoodc, hoodc_d = hexc('8B5E34'), hexc('5E3E20')
        c.ellipse(24, 50, 19, 12, tunic)
        c.recolor(tunic, tunic_d, lambda x, y: x > 30)
        c.line(12, 38, 34, 47, hoodc_d)  # satchel strap
        c.line(13, 38, 35, 47, hoodc_d)
        c.ellipse(24, 24, 9, 10, skin)
        c.recolor(skin, skin_d, lambda x, y: x > 30)
        c.ellipse(24, 20, 13, 13, hoodc, clip=lambda x, y: y < 18 or x < 15 or x > 33)
        c.poly([(11, 22), (15, 18), (15, 36), (11, 34)], hoodc)
        c.poly([(37, 22), (33, 18), (33, 36), (37, 34)], hoodc_d)
        c.rect(17, 14, 31, 16, hexc('5A3A1E'))  # hair fringe
        f = Face([(18, 22), (27, 22)], 'dot', WHITE, INK, hexc('5A3A1E'), 0, (24, 30), 6, skin)
    elif kind == 'knight':
        steel, steel_d, steel_h = hexc('B8C2CC'), hexc('7D8994'), hexc('E6EDF2')
        c.ellipse(24, 50, 20, 12, steel)
        c.recolor(steel, steel_d, lambda x, y: x > 30)
        c.ellipse(24, 22, 12, 13, steel)
        c.recolor(steel, steel_d, lambda x, y: x > 31)
        c.recolor(steel, steel_h, lambda x, y: x < 18 and y < 18)
        c.rect(14, 20, 34, 22, INK)  # visor slit
        c.rect(23, 23, 25, 32, steel_d)
        for y in range(25, 33, 2):
            c.rect(17, y, 21, y, steel_d)
            c.rect(27, y, 31, y, steel_d)
        c.poly([(22, 10), (26, 10), (27, 3), (24, 1), (21, 3)], hexc('3F6FB5'))
        # shield
        c.poly([(33, 34), (45, 34), (45, 41), (39, 47), (33, 41)], hexc('3F6FB5'))
        c.rect(38, 35, 39, 45, GOLD)
        c.rect(34, 38, 44, 39, GOLD)
        c.outline(hexc('1A2028'))
        return c
    else:  # mage
        robe, robe_d = hexc('3F6FB5'), hexc('2A4C80')
        c.ellipse(24, 50, 19, 12, robe)
        c.recolor(robe, robe_d, lambda x, y: x > 30)
        c.ellipse(24, 26, 9, 10, skin)
        c.recolor(skin, skin_d, lambda x, y: x > 30)
        c.rect(15, 18, 33, 21, hexc('C9C3B6'))  # silver hair
        c.ellipse(24, 18, 15, 3, robe_d)
        c.poly([(11, 18), (37, 18), (28, 4), (34, 1), (24, 2), (18, 8)], robe)
        c.rect(14, 16, 34, 17, GOLD)
        # glowing hand
        c.ellipse(8, 38, 3, 3, skin)
        for a in range(0, 360, 60):
            c.set(8 + math.cos(math.radians(a)) * 5, 34 + math.sin(math.radians(a)) * 4, hexc('9EE7FF'), True)
        f = Face([(18, 24), (27, 24)], 'dot', WHITE, INK, hexc('8F897D'), 0, (24, 31), 4, skin)
    draw_eyes(c, f, 'idle')
    draw_brows(c, f, 'idle')
    draw_mouth(c, f, 'happy')
    c.outline(hexc('1A1410'))
    return c


# ---------------------------------------------------------------- 16x16 icons
def icon(name):
    c = C(16, 16)
    g, w, d = hexc('D7B875'), hexc('E5DFC7'), hexc('75D89A')
    if name == 'skill_str':  # dumbbell
        c.rect(2, 5, 4, 10, w); c.rect(11, 5, 13, 10, w); c.rect(5, 7, 10, 8, g); c.rect(0, 6, 1, 9, w); c.rect(14, 6, 15, 9, w)
    elif name == 'skill_int':  # open book
        c.poly([(1, 3), (7, 4), (7, 13), (1, 12)], w); c.poly([(15, 3), (9, 4), (9, 13), (15, 12)], w); c.rect(7, 4, 8, 13, g)
        for y in (6, 8, 10):
            c.line(2, y, 5, y + 1, hexc('8A8370')); c.line(10, y + 1, 13, y, hexc('8A8370'))
    elif name == 'skill_dis':  # check shield
        c.poly([(2, 2), (14, 2), (14, 8), (8, 15), (2, 8)], hexc('8FA9C9')); c.line(4, 8, 7, 11, w); c.line(7, 11, 12, 5, w); c.line(5, 8, 7, 10, w)
    elif name == 'skill_soc':  # speech bubbles
        c.ellipse(6, 6, 5.5, 4, w); c.poly([(3, 9), (5, 9), (2, 13)], w); c.ellipse(11, 10, 4.5, 3.5, d)
    elif name == 'cat_daily':  # sun
        c.ellipse(8, 8, 3.5, 3.5, g)
        for a in range(0, 360, 45):
            c.set(8 + math.cos(math.radians(a)) * 6, 8 + math.sin(math.radians(a)) * 6, g)
    elif name == 'cat_personal':  # heart
        c.ellipse(5.5, 6, 3.5, 3.2, hexc('E07A5F')); c.ellipse(10.5, 6, 3.5, 3.2, hexc('E07A5F')); c.poly([(2, 7), (14, 7), (8, 14)], hexc('E07A5F'))
    elif name == 'cat_work':  # briefcase
        c.rect(1, 5, 14, 13, hexc('8B5E34')); c.rect(5, 2, 10, 4, hexc('5E3E20')); c.rect(6, 3, 9, 4, T); c.rect(1, 8, 14, 8, hexc('5E3E20')); c.rect(7, 7, 8, 9, g)
    elif name == 'cat_boss':  # horned skull
        c.ellipse(8, 8, 5, 5, w); c.rect(5, 12, 10, 14, w); c.rect(5, 7, 6, 8, INK); c.rect(9, 7, 10, 8, INK); c.poly([(2, 6), (0, 1), (4, 4)], g); c.poly([(13, 6), (15, 1), (11, 4)], g)
    elif name == 'nav_home':
        c.poly([(1, 8), (8, 1), (15, 8)], g); c.rect(3, 8, 12, 14, w); c.rect(7, 10, 8, 14, hexc('8B5E34'))
    elif name == 'nav_quests':  # scroll
        c.rect(3, 2, 12, 13, w); c.ellipse(3, 2.5, 2, 1.5, g); c.ellipse(12, 13.5, 2, 1.5, g)
        for y in (5, 7, 9, 11):
            c.rect(5, y, 10, y, hexc('8A8370'))
    elif name == 'nav_companion':  # sparkle face
        c.ellipse(8, 9, 6, 6, d); c.rect(5, 8, 6, 9, INK); c.rect(10, 8, 11, 9, INK); c.rect(6, 12, 10, 12, INK); c.poly([(2, 4), (4, 0), (6, 4)], d); c.poly([(10, 4), (12, 0), (14, 4)], d)
    elif name == 'nav_character':  # helmet
        c.ellipse(8, 8, 6, 6.5, hexc('B8C2CC')); c.rect(3, 7, 13, 8, INK); c.rect(7, 9, 8, 13, hexc('7D8994')); c.rect(7, 0, 8, 2, hexc('E07A5F'))
    elif name == 'nav_settings':  # gear
        c.ellipse(8, 8, 5, 5, w)
        for a in range(0, 360, 45):
            x, y = 8 + math.cos(math.radians(a)) * 6, 8 + math.sin(math.radians(a)) * 6
            c.rect(x - 1, y - 1, x, y, w)
        c.ellipse(8, 8, 2, 2, T)
    elif name == 'xp':  # orb
        c.ellipse(8, 8, 6, 6, d); c.ellipse(6, 6, 2, 2, hexc('C9F5D8')); c.rect(6, 7, 10, 9, T); c.rect(7, 7, 7, 9, hexc('1E4A2E')); c.rect(9, 7, 9, 9, hexc('1E4A2E'))
    elif name == 'level':  # star
        c.poly([(8, 0), (10, 5), (15, 6), (11, 10), (12, 15), (8, 12), (4, 15), (5, 10), (1, 6), (6, 5)], g)
    elif name == 'mic':
        c.rect(6, 1, 9, 9, w); c.ellipse(7.5, 1.5, 2, 1.5, w); c.ellipse(7.5, 9, 2, 1.5, w); c.line(3, 7, 4, 11, g); c.line(12, 7, 11, 11, g); c.rect(5, 11, 10, 12, g); c.rect(7, 13, 8, 15, g)
    elif name == 'calendar':
        c.rect(1, 3, 14, 14, w); c.rect(1, 3, 14, 6, hexc('E07A5F')); c.rect(4, 1, 5, 4, g); c.rect(10, 1, 11, 4, g)
        for (x, y) in [(3, 8), (6, 8), (9, 8), (12, 8), (3, 11), (6, 11), (9, 11)]:
            c.rect(x, y, x + 1, y + 1, hexc('8A8370'))
    elif name == 'bell':
        c.ellipse(8, 7, 5, 5, g); c.rect(3, 7, 12, 11, g); c.rect(2, 11, 13, 12, g); c.rect(7, 13, 8, 14, w)
    elif name == 'lock':
        c.rect(3, 7, 12, 14, g); c.ellipse(7.5, 6, 4, 4, w); c.ellipse(7.5, 6, 2, 2, T); c.rect(4, 6, 11, 6, T); c.rect(7, 9, 8, 12, INK)
    elif name.startswith('item_') or name.startswith('ach_'):
        return item_icon(name)
    if name not in ('nav_settings',):
        c.outline(hexc('101410'))
    return c


def item_icon(name):
    c = C(16, 16)
    wood, iron, gold, silver = hexc('A0703F'), hexc('AEB8C2'), GOLD, hexc('D8E0E6')
    if name == 'item_wooden_sword':
        c.line(3, 13, 12, 4, wood); c.line(4, 13, 13, 4, wood); c.rect(3, 10, 6, 11, hexc('6E4A2E')); c.rect(2, 13, 3, 14, hexc('6E4A2E'))
    elif name == 'item_iron_sword':
        c.line(3, 13, 13, 3, iron); c.line(4, 13, 14, 3, iron); c.line(3, 9, 7, 13, gold); c.rect(1, 14, 2, 15, gold)
    elif name == 'item_travelers_cloak':
        c.poly([(5, 1), (11, 1), (14, 15), (2, 15)], hexc('8B5E34')); c.rect(6, 2, 10, 3, gold)
    elif name == 'item_silver_ring':
        c.ellipse(8, 9, 5, 5, silver); c.ellipse(8, 9, 3, 3, T); c.ellipse(8, 3.5, 2, 2, hexc('9EE7FF'))
    elif name == 'item_sages_staff':
        c.rect(7, 4, 8, 15, wood); c.ellipse(7.5, 3, 3, 3, hexc('9EE7FF'))
    elif name == 'item_guardian_shield':
        c.poly([(2, 2), (14, 2), (14, 8), (8, 15), (2, 8)], hexc('3F6FB5')); c.rect(7, 3, 8, 12, gold); c.rect(3, 6, 13, 7, gold)
    elif name == 'item_golden_crown':
        c.poly([(1, 13), (1, 5), (5, 9), (8, 3), (11, 9), (15, 5), (15, 13)], gold); c.set(8, 10, hexc('E07A5F'))
    elif name == 'item_adventurers_badge':
        c.ellipse(8, 7, 5.5, 5.5, gold); c.poly([(5, 11), (3, 15), (6, 14), (8, 12)], hexc('E07A5F')); c.poly([(11, 11), (13, 15), (10, 14), (8, 12)], hexc('E07A5F')); c.ellipse(8, 7, 2.5, 2.5, hexc('F4E3A1'))
    else:  # achievements: medal with glyph variations
        idx = abs(hash(name)) % 4
        cols = [hexc('75D89A'), hexc('8FA9C9'), hexc('B39DDB'), hexc('E07A5F')]
        c.poly([(3, 0), (7, 0), (9, 6), (6, 7)], cols[idx])
        c.poly([(13, 0), (9, 0), (7, 6), (10, 7)], cols[(idx + 1) % 4])
        c.ellipse(8, 10.5, 5, 5, gold)
        c.poly([(8, 6.5), (9.2, 9.3), (12, 9.5), (9.8, 11.3), (10.6, 14), (8, 12.5), (5.4, 14), (6.2, 11.3), (4, 9.5), (6.8, 9.3)], GOLD_HI)
    c.outline(hexc('101410'))
    return c


# ---------------------------------------------------------------- brand
FONT5 = {
    'Q': ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
    'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    'I': ['111', '010', '010', '010', '010', '010', '111'],
    'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
}


def wordmark(text, scale=1):
    w = sum(len(FONT5[ch][0]) + 1 for ch in text) + 2
    c = C(w, 11)
    x = 1
    for ch in text:
        g = FONT5[ch]
        for yy, row in enumerate(g):
            for xx, bit in enumerate(row):
                if bit == '1':
                    col = GOLD_HI if yy < 3 else GOLD
                    c.set(x + xx, 2 + yy, col)
        x += len(g[0]) + 1
    c.outline(hexc('3A2A10'))
    return c


def evenhub_icon():
    """24x24 monochrome icon built from 2x2 blocks in #F4F4F4 (Even Hub CLI icon rule)."""
    grid = [
        '............',
        '..#......#..',
        '..##....##..',
        '...######...',
        '..########..',
        '..#.####.#..',
        '..########..',
        '...#....#...',
        '....####....',
        '...######...',
        '..##.##.##..',
        '............',
    ]
    img = Image.new('RGBA', (24, 24), (0, 0, 0, 0))
    p = img.load()
    for y, row in enumerate(grid):
        for x, ch in enumerate(row):
            if ch == '#':
                for dy in (0, 1):
                    for dx in (0, 1):
                        p[x * 2 + dx, y * 2 + dy] = (0xF4, 0xF4, 0xF4, 255)
    return img


# ---------------------------------------------------------------- glasses conversion
def glasses_variant(img, outline_rgb, scale=3):
    """Green-display friendly greyscale: transparent → black (off), outline → brightest, fills → mid tones."""
    w, h = img.size
    out = Image.new('L', (w, h), 0)
    src = img.load()
    dst = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = src[x, y]
            if a == 0:
                v = 0
            elif (r, g, b) == outline_rgb or (r + g + b) < 90:
                v = 255
            else:
                lum = 0.299 * r + 0.587 * g + 0.114 * b
                v = int(28 + (lum / 255.0) ** 1.15 * 165)  # 28..193 → fills read as shading under bright line-art
            dst[x, y] = v
    return out.resize((w * scale, h * scale), Image.NEAREST)


def save(img, *parts):
    path = os.path.join(*parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)
    return path


def main():
    manifest = {'generator': 'scripts/gen_art.py', 'license': 'Original artwork, MIT (same as repository)', 'attribution': 'Created programmatically for Questling; no third-party sprites.', 'assets': []}
    sheet_rows = []
    for cid, fn in COMPANIONS.items():
        row = []
        for emo in EMOTIONS:
            img = fn(emo).image()
            save(img, PUB, 'companions', cid, f'{emo}.png')
            g = glasses_variant(img, OUTLINES[cid])
            save(g, PUB, 'glasses', 'companions', cid, f'{emo}.png')
            manifest['assets'].append({'path': f'companions/{cid}/{emo}.png', 'size': [S, S], 'glasses': [S * 3, S * 3]})
            row.append(img)
        for n in range(3):
            img = fn('happy', frame=n).image()
            save(img, PUB, 'companions', cid, f'react_{n}.png')
            save(glasses_variant(img, OUTLINES[cid]), PUB, 'glasses', 'companions', cid, f'react_{n}.png')
            row.append(img)
        sheet_rows.append(row)
    av_row = []
    for a in ['adventurer', 'knight', 'mage']:
        img = avatar(a).image()
        save(img, PUB, 'avatars', f'{a}.png')
        save(glasses_variant(img, (0x1A, 0x14, 0x10) if a != 'knight' else (0x1A, 0x20, 0x28)), PUB, 'glasses', 'avatars', f'{a}.png')
        av_row.append(img)
    sheet_rows.append(av_row)
    icons = ['skill_str', 'skill_int', 'skill_dis', 'skill_soc', 'cat_daily', 'cat_personal', 'cat_work', 'cat_boss', 'nav_home', 'nav_quests', 'nav_companion', 'nav_character', 'nav_settings', 'xp', 'level', 'mic', 'calendar', 'bell', 'lock']
    items = ['item_wooden_sword', 'item_iron_sword', 'item_travelers_cloak', 'item_silver_ring', 'item_sages_staff', 'item_guardian_shield', 'item_golden_crown', 'item_adventurers_badge']
    achs = ['ach_first_quest', 'ach_first_level_up', 'ach_five_quests', 'ach_first_boss', 'ach_goal_achieved', 'ach_consistent', 'ach_knowledge_seeker', 'ach_balanced_hero']
    icon_imgs = []
    for n in icons + items + achs:
        img = icon(n).image()
        save(img, PUB, 'icons', f'{n}.png')
        icon_imgs.append(img)
    wm = wordmark('QUESTLING').image()
    save(wm, PUB, 'brand', 'wordmark.png')
    logo = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
    logo.alpha_composite(optimist('happy').image().resize((48, 48), Image.NEAREST), (8, 4))
    save(logo, PUB, 'brand', 'mascot.png')
    save(evenhub_icon(), PUB, 'brand', 'evenhub-icon-24.png')
    save(evenhub_icon(), ROOT, 'assets', 'evenhub-icon-24.png')
    app_icon = Image.new('RGBA', (48, 48), hexc('19251D'))
    app_icon.alpha_composite(optimist('happy').image(), (0, 0))
    save(app_icon.resize((192, 192), Image.NEAREST), PUB, 'brand', 'app-icon-192.png')

    # contact sheet (4x scale) for visual review
    sc = 3
    cols = max(len(r) for r in sheet_rows)
    sheet = Image.new('RGBA', (cols * S * sc + 20, len(sheet_rows) * S * sc + 20 + 60), hexc('19251D'))
    for ri, row in enumerate(sheet_rows):
        for ci, img in enumerate(row):
            sheet.alpha_composite(img.resize((S * sc, S * sc), Image.NEAREST), (10 + ci * S * sc, 10 + ri * S * sc))
    for i, img in enumerate(icon_imgs):
        sheet.alpha_composite(img.resize((32, 32), Image.NEAREST), (10 + i * 34 % (cols * S * sc - 34), 20 + len(sheet_rows) * S * sc + (i * 34 // (cols * S * sc - 34)) * 34))
    os.makedirs(GEN, exist_ok=True)
    sheet.save(os.path.join(GEN, 'contact_sheet.png'))
    gsheet = Image.new('L', (8 * 144 + 20, 5 * 144 + 20), 0)
    for ri, cid in enumerate(COMPANIONS):
        for ci, emo in enumerate(EMOTIONS):
            gsheet.paste(Image.open(os.path.join(PUB, 'glasses', 'companions', cid, f'{emo}.png')), (10 + ci * 144, 10 + ri * 144))
    gsheet.save(os.path.join(GEN, 'glasses_contact_sheet.png'))
    with open(os.path.join(GEN, 'manifest.json'), 'w') as fh:
        json.dump(manifest, fh, indent=1)
    print('assets written')


if __name__ == '__main__':
    main()


# ---------------------------------------------------------------- v2 art direction: scenes, frames, seals
def scene(tod):
    """128x56 pixel landscape: dawn / day / dusk / night. Original."""
    W, H = 128, 56
    c = C(W, H)
    pal = {
        'dawn': dict(sky=['3B2E4F', '6E4A6B', 'C2707A', 'EBA37A', 'F4C98E'], far='5A4A6A', mid='3E3A55', near='263247', ground='1E2A2A', sun='FFE3A3'),
        'day': dict(sky=['4F86B8', '6A9FCB', '8DB7D9', 'B5D2E6', 'D9E8EE'], far='8FA6B8', mid='5F8A7A', near='3E6B4F', ground='2C4A35', sun='FFF4C9'),
        'dusk': dict(sky=['1F2340', '3A2E58', '7A3F5E', 'C9685A', 'E8A066'], far='4A3550', mid='2E2A40', near='1C2230', ground='151B1F', sun='FFCF8A'),
        'night': dict(sky=['0A0F1C', '0E1526', '121C30', '172338', '1C2A40'], far='1F2B3E', mid='17222F', near='101820', ground='0C1216', sun='E9EEF2'),
    }[tod]
    bands = pal['sky']
    for y in range(H):
        t = y / (H * 0.78)
        i = min(len(bands) - 1, int(t * len(bands)))
        j = min(len(bands) - 1, i + 1)
        frac = t * len(bands) - i
        for x in range(W):
            # ordered dither between adjacent bands
            bayer = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]][y % 4][x % 4] / 16
            col = bands[j] if frac > bayer else bands[i]
            c.set(x, y, hexc(col))
    # sun / moon
    if tod == 'night':
        c.ellipse(100, 11, 5, 5, hexc(pal['sun']))
        c.ellipse(102, 9.5, 4.2, 4.2, hexc(bands[1]))
        import random
        rnd = random.Random(7)
        for _ in range(46):
            x, y = rnd.randrange(W), rnd.randrange(30)
            c.set(x, y, hexc('E9EEF2') if rnd.random() < 0.3 else hexc('7F8EA8'))
    elif tod == 'day':
        c.ellipse(104, 10, 6, 6, hexc(pal['sun']))
        for (cx, cy, w) in [(24, 9, 9), (34, 7, 6), (70, 14, 11), (80, 12, 7)]:
            c.ellipse(cx, cy, w, 2.6, hexc('F2F6F7'))
            c.ellipse(cx + 3, cy - 1.5, w * 0.55, 2.4, hexc('FFFFFF'))
    else:
        c.ellipse(96 if tod == 'dusk' else 30, 34, 9, 9, hexc(pal['sun']))
    # far mountains
    import math as _m
    for x in range(W):
        h = 30 + 6 * _m.sin(x * 0.08) + 4 * _m.sin(x * 0.21 + 1.3) + (3 if (x // 9) % 3 == 0 else 0)
        for y in range(int(h), H):
            c.set(x, y, hexc(pal['far']))
    for x in range(W):
        h = 38 + 4 * _m.sin(x * 0.13 + 2) + 3 * _m.sin(x * 0.05)
        for y in range(int(h), H):
            c.set(x, y, hexc(pal['mid']))
    # pine silhouettes
    for tx in [56, 63, 70, 78, 88, 96, 104, 115, 122]:
        base = 44 + (tx * 7) % 4
        hgt = 9 + (tx * 3) % 6
        for k in range(hgt):
            w = max(0, (k * 3) // 4)
            c.rect(tx - w // 2, base - hgt + k, tx + w // 2, base - hgt + k, hexc(pal['near']))
        c.rect(tx, base, tx, base + 2, hexc(pal['near']))
    # foreground hill where the companion stands (left)
    for x in range(W):
        h = 47 - 7 * _m.exp(-((x - 22) / 26) ** 2) + 1.5 * _m.sin(x * 0.3)
        for y in range(int(h), H):
            c.set(x, y, hexc(pal['ground']))
    # path
    for y in range(49, H):
        x0 = 40 + (y - 49) * 3
        c.rect(x0, y, x0 + 3 + (y - 49), y, hexc('3B3A2E') if tod != 'night' else hexc('1C1F22'))
    # grass tufts + fireflies
    for x in range(2, 50, 5):
        c.set(x, 46 - (x % 3), hexc(pal['near']))
    if tod in ('dusk', 'night'):
        for (x, y) in [(48, 40), (60, 44), (84, 41), (110, 46), (12, 38), (30, 42)]:
            c.set(x, y, hexc('F4E3A1'))
    return c


def frame9(kind):
    """24x24 9-slice frame for CSS border-image (slice 8)."""
    c = C(24, 24)
    if kind == 'gold':
        dark, mid, hi = hexc('5A4524'), hexc('D7B875'), hexc('F4E3A1')
        c.rect(0, 0, 23, 23, T)
        for i in range(24):
            for (x, y) in [(i, 2), (i, 21), (2, i), (21, i)]:
                c.set(x, y, mid)
            for (x, y) in [(i, 3), (3, i)]:
                c.set(x, y, dark)
        for (ox, oy) in [(0, 0), (16, 0), (0, 16), (16, 16)]:
            c.rect(ox + 1, oy + 1, ox + 6, oy + 6, mid)
            c.rect(ox + 2, oy + 2, ox + 5, oy + 5, dark)
            c.rect(ox + 3, oy + 3, ox + 4, oy + 4, hi)
    else:  # 'stone' subtle frame
        edge, hi = hexc('2C4236'), hexc('3B5646')
        for i in range(24):
            for (x, y) in [(i, 0), (i, 23), (0, i), (23, i)]:
                c.set(x, y, edge)
            for (x, y) in [(i, 1), (1, i)]:
                c.set(x, y, hi)
        for (x, y) in [(0, 0), (23, 0), (0, 23), (23, 23)]:
            c.set(x, y, T)
    return c


def seal(done):
    c = C(24, 24)
    wax, wax_d, wax_h = (hexc('B5402F'), hexc('7E2A1F'), hexc('D9654F')) if done else (hexc('3A4D40'), hexc('263329'), hexc('4E6656'))
    for a in range(0, 360, 30):
        x = 12 + math.cos(math.radians(a)) * 9.5
        y = 12 + math.sin(math.radians(a)) * 9.5
        c.ellipse(x, y, 2.2, 2.2, wax)
    c.ellipse(12, 12, 9, 9, wax)
    c.ellipse(12, 12, 6.5, 6.5, wax_d)
    c.ellipse(10, 9, 2, 1.5, wax_h)
    mark = hexc('F4E3A1') if done else hexc('8FB39A')
    for (x, y) in [(8, 12), (9, 13), (10, 14), (11, 13), (12, 12), (13, 11), (14, 10), (15, 9)]:
        c.set(x, y, mark)
        c.set(x, y + 1, mark)
    return c


def ornament():
    c = C(80, 7)
    g, d = hexc('D7B875'), hexc('6E5A33')
    for x in range(4, 33):
        c.set(x, 3, d)
    for x in range(47, 76):
        c.set(x, 3, d)
    c.poly([(40, 0), (44, 3.5), (40, 7), (36, 3.5)], g)
    c.set(40, 3, hexc('F4E3A1'))
    for x in (34, 46):
        c.rect(x, 2, x, 4, g)
    return c


def main_v2():
    for tod in ['dawn', 'day', 'dusk', 'night']:
        save(scene(tod).image(), PUB, 'scenes', f'{tod}.png')
    save(frame9('gold').image(), PUB, 'frames', 'gold.png')
    save(frame9('stone').image(), PUB, 'frames', 'stone.png')
    save(seal(False).image(), PUB, 'icons', 'seal_open.png')
    save(seal(True).image(), PUB, 'icons', 'seal_done.png')
    save(ornament().image(), PUB, 'frames', 'ornament.png')
    sheet = Image.new('RGBA', (128 * 2 * 3 + 30, 56 * 2 * 3 + 30), (10, 10, 10, 255))
    for i, tod in enumerate(['dawn', 'day', 'dusk', 'night']):
        im = Image.open(os.path.join(PUB, 'scenes', f'{tod}.png')).resize((128 * 3, 56 * 3), Image.NEAREST)
        sheet.alpha_composite(im, (10 + (i % 2) * (128 * 3 + 10), 10 + (i // 2) * (56 * 3 + 10)))
    sheet.save(os.path.join(GEN, 'scenes_sheet.png'))
    print('v2 assets written')


if __name__ == '__main__':
    main_v2()
