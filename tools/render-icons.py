#!/usr/bin/env python3
"""Render Aegis shield icons (16/24/32/48/128) as pure PNGs — no native deps."""
import math, struct, zlib

VIRTUAL = 384  # chosen so all target sizes divide it evenly: 384/128=3, /48=8, /32=12, /24=16, /16=24
N = VIRTUAL

def cubic_bezier(p0, p1, p2, p3, t):
    mt = 1 - t
    x = mt*mt*mt*p0[0] + 3*mt*mt*t*p1[0] + 3*mt*t*t*p2[0] + t*t*t*p3[0]
    y = mt*mt*mt*p0[1] + 3*mt*mt*t*p1[1] + 3*mt*t*t*p2[1] + t*t*t*p3[1]
    return (x, y)

def shield_poly(scale_shift):
    # Outer plate path, scaled/translated about center 64,64
    cx, cy = 64, 64
    def tx(pt):
        dx, dy = pt[0] - cx, pt[1] - cy
        s = scale_shift[0]
        return (cx + dx * s + scale_shift[1], cy + dy * s + scale_shift[2])
    left_top = (14, 25.5); right_top = (114, 25.5); top = (64, 4)
    pts = [tx(top), tx(right_top), tx((114, 62.5))]
    # right curve down to bottom center
    for i in range(1, 21):
        t = i / 20
        pts.append(tx(cubic_bezier((114, 62.5), (114, 93.5), (97.5, 113.8), (64, 124), t)))
    for i in range(1, 21):
        t = i / 20
        pts.append(tx(cubic_bezier((64, 124), (30.5, 113.8), (14, 93.5), (14, 62.5), t)))
    pts.append(tx((14, 25.5)))
    return pts

def point_in_poly(x, y, poly):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]; xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside

def dist_to_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

def grad3(c1, c2, c3, t):
    if t < 0.5:
        return lerp(c1, c2, t * 2)
    return lerp(c2, c3, (t - 0.5) * 2)

TEAL_TOP, TEAL_MID, TEAL_BOT = (66, 230, 209), (28, 205, 185), (19, 181, 163)
DARK_TOP, DARK_BOT = (10, 21, 33), (18, 36, 56)
CHECK_TOP, CHECK_BOT = (2, 22, 17), (2, 22, 17)

outer = shield_poly((1.0, 0, 0))
inner = shield_poly((0.845, 0, 3))
check_pts = [(42.5, 66), (57.5, 80.5), (89.5, 45)]
CHECK_W = 8.2 / 2

# gradient t along diagonal for shield body
def diag_t(x, y):
    return max(0.0, min(1.0, (x + y) / 256))

print('rasterizing…')
rows = bytearray()
for sy in range(N):
    rows.append(0)  # filter type 0
    for sx in range(N):
        x, y = (sx + 0.5) * (128 / N), (sy + 0.5) * (128 / N)
        r = g = b = 0
        a = 0
        if point_in_poly(x, y, outer):
            t = y / 128
            col = lerp(DARK_TOP, DARK_BOT, t)
            r, g, b, a = col[0], col[1], col[2], 255
        if point_in_poly(x, y, inner):
            col = grad3(TEAL_TOP, TEAL_MID, TEAL_BOT, diag_t(x, y))
            # top sheen overlay
            sheen = max(0.0, 1.0 - y / 60.0) * 0.18
            col = tuple(min(255, round(c + (255 - c) * sheen)) for c in col)
            r, g, b, a = col[0], col[1], col[2], 255
        # check mark stroke (round caps/joins)
        d = min(dist_to_segment(x, y, *check_pts[0], *check_pts[1]), dist_to_segment(x, y, *check_pts[1], *check_pts[2]))
        if d < CHECK_W:
            col = lerp(CHECK_TOP, CHECK_BOT, y / 128)
            r, g, b, a = col[0], col[1], col[2], 255
        rows += bytes((r, g, b, a))

print('downscaling…')

# The rows buffer has per-row filter byte interleaved; strip it first.
raw = bytearray()
stride = N * 4
for y in range(N):
    start = y * (stride + 1) + 1
    raw += rows[start:start + stride]

# box downsample to target sizes
def resize_box(raw, src, factor):
    dst = src // factor
    out = bytearray()
    for dy in range(dst):
        y0 = dy * factor
        line = bytearray(dst * 4)
        for dx in range(dst):
            x0 = dx * factor
            acc = [0, 0, 0, 0]
            for fy in range(factor):
                base = ((y0 + fy) * src + x0) * 4
                for fx in range(factor):
                    o = base + fx * 4
                    acc[0] += raw[o]; acc[1] += raw[o + 1]; acc[2] += raw[o + 2]; acc[3] += raw[o + 3]
            n = factor * factor
            o = dx * 4
            line[o] = acc[0] // n; line[o + 1] = acc[1] // n; line[o + 2] = acc[2] // n; line[o + 3] = acc[3] // n
        out.append(0)
        out += line
    return out, dst

def write_png(path, rgba_rows, size):
    def chunk(typ, payload):
        c = struct.pack('>I', len(payload)) + typ + payload
        return c + struct.pack('>I', zlib.crc32(typ + payload) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(rgba_rows), 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)

import os
for size in (128, 48, 32, 24, 16):
    factor = N // size
    data, dst = resize_box(raw, N, factor)
    out = f'extension/icons/icon{size}.png'
    write_png(out, data, size)
    print('wrote', out)
print('done')
