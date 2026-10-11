#!/usr/bin/python3
"""Draws Kiki's app and tray icons into desktop/resources (needs Pillow)."""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "resources"
ACCENT = (194, 65, 12, 255)
WHITE = (255, 255, 255, 255)


def bubble(draw, size, fill, inset):
    """A speech bubble with a tail, plus three dots, scaled to `size`."""
    s = size
    left, top, right, bottom = s * inset, s * (inset + 0.02), s * (1 - inset), s * (0.78 - inset * 0.5)
    draw.rounded_rectangle((left, top, right, bottom), radius=s * 0.16, fill=fill)
    draw.polygon([(s * 0.30, bottom - s * 0.02), (s * 0.26, s * 0.90 - inset * s * 0.5), (s * 0.48, bottom - s * 0.02)], fill=fill)
    return (left, top, right, bottom)


def app_icon(size=1024):
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=size * 0.22, fill=ACCENT)
    left, top, right, bottom = bubble(draw, size, WHITE, 0.2)
    cy = (top + bottom) / 2
    r = size * 0.045
    for cx in (size * 0.38, size * 0.5, size * 0.62):
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=ACCENT)
    return image


def tray_icon(size):
    image = Image.new("RGBA", (size * 4, size * 4), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    s = size * 4
    left, top, right, bottom = bubble(draw, s, (0, 0, 0, 255), 0.08)
    cy = (top + bottom) / 2
    r = s * 0.07
    for cx in (s * 0.3, s * 0.5, s * 0.7):
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(0, 0, 0, 0))
    return image.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    app_icon().resize((512, 512), Image.LANCZOS).save(OUT / "icon.png")
    tray_icon(16).save(OUT / "trayTemplate.png")
    tray_icon(32).save(OUT / "trayTemplate@2x.png")
    print("wrote", ", ".join(p.name for p in sorted(OUT.glob("*.png"))))
