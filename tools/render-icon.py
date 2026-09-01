#!/usr/bin/env python3
"""Render the Better GHSA extension icon to the PNG sizes the manifest names.

    python3 tools/render-icon.py src/icons

The icon is a dark rounded square carrying a shield, a band across the shield's
head, and a check mark on its face. Geometry is written in unit coordinates
(0..1 across the canvas) and sampled with supersampling for antialiasing. The
standard library is the whole dependency: zlib and struct build the PNG.
"""

import math
import struct
import sys
import zlib

# Palette. A self-contained badge so the icon reads on a light or dark theme.
BG = (0x14, 0x1B, 0x27)  # slate, the badge
SHIELD = (0xE8, 0xED, 0xF4)  # near-white, the shield face
MARK = (0x14, 0x1B, 0x27)  # the check, knocked out of the shield
ACCENT = (0xF0, 0x8C, 0x28)  # amber, the band across the shield head

SS = 6  # supersample factor per axis


def rounded_rect(x, y, r):
    """Inside the full-canvas rounded square of corner radius r."""
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return math.hypot(x - cx, y - cy) <= r


LEFT, RIGHT = 0.220, 0.780
TOP, BOTTOM = 0.160, 0.862
SHOULDER = 0.050  # corner radius at the head
WAIST = 0.455  # where the straight sides give way to the taper
CHIEF = 0.302  # the band across the head ends here


def shield_outline(steps=64):
    """The shield as a closed polygon in unit coordinates.

    A flat head with rounded shoulders, straight sides down to the waist, then
    a taper to a point at the base.
    """
    pts = []

    def arc(cx, cy, r, a0, a1):
        for i in range(steps // 4 + 1):
            a = a0 + (a1 - a0) * i / (steps // 4)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))

    def bez(p0, p1, p2):
        for i in range(1, steps + 1):
            t = i / steps
            u = 1 - t
            pts.append(
                (
                    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
                )
            )

    # Head: left shoulder, across, right shoulder.
    arc(LEFT + SHOULDER, TOP + SHOULDER, SHOULDER, math.pi, 1.5 * math.pi)
    arc(RIGHT - SHOULDER, TOP + SHOULDER, SHOULDER, 1.5 * math.pi, 2 * math.pi)
    # Right side straight down, then taper to the base point.
    pts.append((RIGHT, WAIST))
    bez((RIGHT, WAIST), (RIGHT, BOTTOM - 0.200), (0.5, BOTTOM))
    # Left side back up, mirrored.
    bez((0.5, BOTTOM), (LEFT, BOTTOM - 0.200), (LEFT, WAIST))
    pts.append((LEFT, TOP + SHOULDER))
    return pts


SHIELD_POLY = shield_outline()


def in_poly(x, y, poly):
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y):
            xc = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < xc:
                inside = not inside
        j = i
    return inside


def seg_dist(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L = vx * vx + vy * vy
    t = 0.0 if L == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


# The check: two segments, round joins, drawn on the shield face.
CHECK = [((0.375, 0.560), (0.464, 0.652)), ((0.464, 0.652), (0.641, 0.440))]
CHECK_W = 0.051  # half-width of the stroke


def in_check(x, y):
    return any(seg_dist(x, y, a[0], a[1], b[0], b[1]) <= CHECK_W for a, b in CHECK)


def in_chief(x, y):
    """The band across the head. The caller clips it to the shield."""
    return y <= CHIEF


def sample(x, y):
    """Colour at a unit-coordinate point, or None for transparent."""
    if not rounded_rect(x, y, 0.215):
        return None
    if in_poly(x, y, SHIELD_POLY):
        if in_chief(x, y):
            return ACCENT
        if in_check(x, y):
            return MARK
        return SHIELD
    return BG


def render(size):
    px = bytearray()
    inv = 1.0 / (size * SS)
    for row in range(size):
        px.append(0)  # PNG filter type 0
        for col in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                y = (row * SS + sy + 0.5) * inv
                for sx in range(SS):
                    x = (col * SS + sx + 0.5) * inv
                    c = sample(x, y)
                    if c is not None:
                        r += c[0]
                        g += c[1]
                        b += c[2]
                        a += 255
            n = SS * SS
            if a == 0:
                px.extend((0, 0, 0, 0))
            else:
                cov = a // n
                # Unpremultiplied colour: average over the covered samples only.
                covered = a // 255
                px.extend((r // covered, g // covered, b // covered, cov))
    return bytes(px)


def png(size, raw):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main():
    out = sys.argv[1]
    for size in (16, 32, 48, 64, 128):
        data = png(size, render(size))
        path = f"{out}/icon-{size}.png"
        with open(path, "wb") as f:
            f.write(data)
        print(f"{path}  {len(data)} bytes")


if __name__ == "__main__":
    main()
