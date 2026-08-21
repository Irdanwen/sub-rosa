#!/usr/bin/env python3
"""Regenerate the per-accent dock icons (../icon-<accent>.png).

The themed icons are the Sub Rosa rose art (the 1024px rep of
src-tauri/icons/icon.icns) recolored per accent, composited into the macOS
dock-icon geometry: a 1024x1024 canvas with a 824x824 rounded square centered
(the shape setApplicationIconImage expects — see theme_icon.rs).

Recoloring is a per-channel multiply that maps the art's cream rose
(#FDE3DE) to a pastel of the accent color; the near-black background is
barely affected, and anti-aliased edges scale proportionally. The "rose"
accent (the default) is left untouched so the swapped dock icon is
pixel-identical to the bundled app icon.

Keep the accent ids and hex values in sync with BRAND_PRESETS in
src/lib/brand.ts.

Usage:  python3 generate.py   (requires Pillow; run from this directory)
"""

import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
ICONS = HERE.parent.parent  # src-tauri/icons/
OUT = HERE.parent  # src-tauri/icons/themed/

# The cream color of the rose glyph in the source art.
CREAM = (253, 227, 222)

# How far the accent is pushed toward white for the rose tint (0..1).
PASTEL = 0.62

# id -> accent hex, from BRAND_PRESETS in src/lib/brand.ts. "rose" is None:
# the default accent keeps the original cream art untouched.
ACCENTS = {
    "rose": None,
    "clay": (0x9D, 0x57, 0x28),
    "amber": (0x8B, 0x6E, 0x4D),
    "gold": (0x8F, 0x6B, 0x2E),
    "sage": (0x60, 0x7D, 0x65),
    "blue": (0x59, 0x78, 0x93),
    "plum": (0x88, 0x68, 0x85),
}

CANVAS = 1024
BODY = 824  # Apple icon-grid body size at 1024
MARGIN = (CANVAS - BODY) // 2
RADIUS = 185  # ~22.4% of BODY, Apple's corner ratio
SUPERSAMPLE = 4


def load_source_art() -> Image.Image:
    """Extract the 1024px rep from icon.icns."""
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        subprocess.run(
            ["iconutil", "--convert", "iconset", str(ICONS / "icon.icns"), "-o", str(iconset)],
            check=True,
        )
        return Image.open(iconset / "icon_512x512@2x.png").convert("RGBA").copy()


def pastel(accent: tuple[int, int, int]) -> tuple[int, int, int]:
    return tuple(round(c + PASTEL * (255 - c)) for c in accent)


def recolor(art: Image.Image, accent: tuple[int, int, int]) -> Image.Image:
    """Per-channel multiply mapping CREAM to the accent pastel."""
    tint = pastel(accent)
    channels = list(art.split())
    for i in range(3):
        ratio = tint[i] / CREAM[i]
        channels[i] = channels[i].point(lambda v, r=ratio: min(255, round(v * r)))
    return Image.merge("RGBA", channels)


def rounded_mask() -> Image.Image:
    big = CANVAS * SUPERSAMPLE
    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    m, r = MARGIN * SUPERSAMPLE, RADIUS * SUPERSAMPLE
    draw.rounded_rectangle([m, m, big - m, big - m], radius=r, fill=255)
    return mask.resize((CANVAS, CANVAS), Image.LANCZOS)


def compose(art: Image.Image, mask: Image.Image) -> Image.Image:
    body = art.resize((BODY, BODY), Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(body, (MARGIN, MARGIN))
    canvas.putalpha(mask)
    return canvas


def main() -> None:
    art = load_source_art()
    mask = rounded_mask()
    for name, accent in ACCENTS.items():
        variant = art if accent is None else recolor(art, accent)
        icon = compose(variant, mask)
        # Palette-quantize: ~9x smaller (the icons are embedded in the app
        # binary) and indistinguishable at dock render sizes.
        icon = icon.quantize(colors=256, method=Image.FASTOCTREE, dither=Image.FLOYDSTEINBERG)
        out = OUT / f"icon-{name}.png"
        icon.save(out, optimize=True)
        print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
