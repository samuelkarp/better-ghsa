#!/usr/bin/env python3
"""Render the Chrome Web Store listing images.

    python3 tools/render-store-assets.py docs

Write store-icon-128.png with 96x96 artwork centered on a transparent 128x128
canvas, and promo-small-440x280.png with the small promotional tile.

Both images use the shield geometry from src/icons. The tile background
matches the icon background, allowing the tile to omit the rounded square.

Rendering requires pycairo and the Liberation Sans font.
"""

import math
import os
import sys

import cairo

# These colours match src/icons.
BG = (0x14 / 255, 0x1B / 255, 0x27 / 255)
SHIELD = (0xE8 / 255, 0xED / 255, 0xF4 / 255)
ACCENT = (0xF0 / 255, 0x8C / 255, 0x28 / 255)
MUTED = (0x9A / 255, 0xA6 / 255, 0xB8 / 255)

# These unit coordinates match tools/render-icon.py.
LEFT, RIGHT = 0.220, 0.780
TOP, BOTTOM = 0.160, 0.862
SHOULDER = 0.050
WAIST = 0.455
CHIEF = 0.302
CHECK = [(0.375, 0.560), (0.464, 0.652), (0.641, 0.440)]
CHECK_WIDTH = 0.102

NAME = "Better GHSA"
TAGLINE = ["Triage tracking for", "GitHub Security Advisories"]


def quad_to(ctx, qx, qy, x, y):
    """Convert a quadratic segment to a cubic segment for cairo."""
    px, py = ctx.get_current_point()
    ctx.curve_to(
        px + 2 / 3 * (qx - px),
        py + 2 / 3 * (qy - py),
        x + 2 / 3 * (qx - x),
        y + 2 / 3 * (qy - y),
        x,
        y,
    )


def shield_path(ctx):
    """Draw a closed shield outline in unit coordinates."""
    ctx.new_path()
    ctx.move_to(LEFT, TOP + SHOULDER)
    ctx.arc(LEFT + SHOULDER, TOP + SHOULDER, SHOULDER, math.pi, 1.5 * math.pi)
    ctx.line_to(RIGHT - SHOULDER, TOP)
    ctx.arc(RIGHT - SHOULDER, TOP + SHOULDER, SHOULDER, 1.5 * math.pi, 2 * math.pi)
    ctx.line_to(RIGHT, WAIST)
    quad_to(ctx, RIGHT, BOTTOM - 0.200, 0.5, BOTTOM)
    quad_to(ctx, LEFT, BOTTOM - 0.200, LEFT, WAIST)
    ctx.close_path()


def rounded_rect(ctx, x, y, w, h, r):
    ctx.new_path()
    ctx.arc(x + r, y + r, r, math.pi, 1.5 * math.pi)
    ctx.arc(x + w - r, y + r, r, 1.5 * math.pi, 2 * math.pi)
    ctx.arc(x + w - r, y + h - r, r, 0, 0.5 * math.pi)
    ctx.arc(x + r, y + h - r, r, 0.5 * math.pi, math.pi)
    ctx.close_path()


def draw_mark(ctx, x, y, size, badge):
    """Draw the mark at (x, y), scaled to a square of side length `size`.

    Set `badge` to include the extension icon's rounded slate background.
    """
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(size, size)

    if badge:
        ctx.set_source_rgb(*BG)
        rounded_rect(ctx, 0, 0, 1, 1, 0.215)
        ctx.fill()

    ctx.set_source_rgb(*SHIELD)
    shield_path(ctx)
    ctx.fill()

    ctx.save()
    shield_path(ctx)
    ctx.clip()
    ctx.set_source_rgb(*ACCENT)
    ctx.rectangle(LEFT, TOP, RIGHT - LEFT, CHIEF - TOP)
    ctx.fill()
    ctx.restore()

    ctx.set_source_rgb(*BG)
    ctx.set_line_width(CHECK_WIDTH)
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.set_line_join(cairo.LINE_JOIN_ROUND)
    ctx.new_path()
    ctx.move_to(*CHECK[0])
    for point in CHECK[1:]:
        ctx.line_to(*point)
    ctx.stroke()

    ctx.restore()


def store_icon(path):
    """Write a 128x128 icon with centered 96x96 artwork and transparent padding."""
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, 128, 128)
    ctx = cairo.Context(surface)
    draw_mark(ctx, 16, 16, 96, badge=True)
    surface.write_to_png(path)
    return path


def centered_text(ctx, text, width, baseline):
    """Draw `text` centered across `width` at `baseline`."""
    extents = ctx.text_extents(text)
    ctx.move_to((width - extents.width) / 2 - extents.x_bearing, baseline)
    ctx.show_text(text)


def promo_small(path):
    """Write a 440x280 promotional tile with the shield above the name."""
    w, h = 440, 280
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, w, h)
    ctx = cairo.Context(surface)

    ctx.set_source_rgb(*BG)
    ctx.rectangle(0, 0, w, h)
    ctx.fill()

    # Scale and position the shield using its bounds within the unit square.
    shield_height = 116
    size = shield_height / (BOTTOM - TOP)
    shield_top = 36
    draw_mark(ctx, (w - size) / 2, shield_top - TOP * size, size, badge=False)

    ctx.set_source_rgb(*SHIELD)
    ctx.select_font_face("Liberation Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
    ctx.set_font_size(40)
    centered_text(ctx, NAME, w, 212)

    ctx.set_source_rgb(*MUTED)
    ctx.select_font_face("Liberation Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
    ctx.set_font_size(16)
    centered_text(ctx, " ".join(TAGLINE), w, 240)

    surface.write_to_png(path)
    return path


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "docs"
    os.makedirs(out, exist_ok=True)
    for path in (
        store_icon(f"{out}/store-icon-128.png"),
        promo_small(f"{out}/promo-small-440x280.png"),
    ):
        print(f"{path}  {os.path.getsize(path)} bytes")


if __name__ == "__main__":
    main()
