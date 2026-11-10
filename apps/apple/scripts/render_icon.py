#!/usr/bin/env python3
"""Render VEIL app icons from the same geometry as veil-browser/branding/src.

Below 48 px the </> mark is noise, so those sizes use veil-icon-small.svg
(a heavier V). Larger sizes use veil-icon.svg. Requires Pillow.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1] / "Veil" / "Assets.xcassets" / "AppIcon.appiconset"
INK = (0x11, 0x18, 0x20, 255)
WHITE = (255, 255, 255, 255)
MARK = (0x8F, 0xA3, 0xB8, 255)
VIEW = 256


def scale(points, size):
    return [(x * size / VIEW, y * size / VIEW) for x, y in points]


def stamp_caps(draw, points, width, fill):
    radius = width / 2
    for point in (points[0], points[-1]):
        draw.ellipse(
            (point[0] - radius, point[1] - radius, point[0] + radius, point[1] + radius),
            fill=fill,
        )


def draw(size: int, detailed: bool) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    plate = Image.new("RGBA", (size, size), INK)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=56 * size / VIEW, fill=255
    )
    plate.putalpha(mask)
    image.alpha_composite(plate)
    pen = ImageDraw.Draw(image)
    if detailed:
        v = scale([(60, 64), (128, 196), (196, 64)], size)
        width = max(1, round(26 * size / VIEW))
        marks = [
            (scale([(100, 52), (84, 68), (100, 84)], size), MARK),
            (scale([(156, 52), (172, 68), (156, 84)], size), MARK),
            (scale([(136, 46), (120, 90)], size), MARK),
        ]
        mark_width = max(1, round(7 * size / VIEW))
    else:
        v = scale([(58, 58), (128, 202), (198, 58)], size)
        width = max(1, round(34 * size / VIEW))
        marks = []
        mark_width = 1
    pen.line(v, fill=WHITE, width=width, joint="curve")
    stamp_caps(pen, v, width, WHITE)
    for mark, color in marks:
        pen.line(mark, fill=color, width=mark_width, joint="curve")
        stamp_caps(pen, mark, mark_width, color)
    return image


CONTENTS = """{
  "images" : [
    { "filename" : "icon_16.png", "idiom" : "mac", "scale" : "1x", "size" : "16x16" },
    { "filename" : "icon_32.png", "idiom" : "mac", "scale" : "2x", "size" : "16x16" },
    { "filename" : "icon_32.png", "idiom" : "mac", "scale" : "1x", "size" : "32x32" },
    { "filename" : "icon_64.png", "idiom" : "mac", "scale" : "2x", "size" : "32x32" },
    { "filename" : "icon_128.png", "idiom" : "mac", "scale" : "1x", "size" : "128x128" },
    { "filename" : "icon_256.png", "idiom" : "mac", "scale" : "2x", "size" : "128x128" },
    { "filename" : "icon_256.png", "idiom" : "mac", "scale" : "1x", "size" : "256x256" },
    { "filename" : "icon_512.png", "idiom" : "mac", "scale" : "2x", "size" : "256x256" },
    { "filename" : "icon_512.png", "idiom" : "mac", "scale" : "1x", "size" : "512x512" },
    { "filename" : "icon_1024.png", "idiom" : "mac", "scale" : "2x", "size" : "512x512" },
    { "filename" : "icon_1024.png", "idiom" : "universal", "platform" : "ios", "scale" : "1x", "size" : "1024x1024" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
"""


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 64, 128, 256, 512, 1024):
        draw(size, detailed=size >= 48).save(ROOT / f"icon_{size}.png", "PNG")
    (ROOT / "Contents.json").write_text(CONTENTS, encoding="utf-8")
    (ROOT.parent / "Contents.json").write_text(
        '{ "info" : { "author" : "xcode", "version" : 1 } }\n', encoding="utf-8"
    )


if __name__ == "__main__":
    main()
