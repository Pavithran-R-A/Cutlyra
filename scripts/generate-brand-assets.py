#!/usr/bin/env python3
"""Cutlyra canonical brand-asset pipeline.

Canonical source: assets/brand/source-logo.png (1254x1254, provided brand art).
Canonical outputs (assets/brand/): icon-only.png, icon-foreground.png,
icon-background.png, splash.png, splash-dark.png — plus the Android/iOS res
rasters the platforms need, written directly into their res trees.

No npm dependency is added. The pipeline is PIL-based and deterministic:
geometry is derived from the measured pixel bounds of the source art, never
regenerated, so re-running after dropping a new source-logo.png in place
reproduces the whole set.

Design rules encoded here (see assets/brand/README.md):
- mark sits inside the Android adaptive-icon ~66/108 center safe zone
- launcher foreground keeps the source tile OUT (transparent), the tile color
  becomes the adaptive background layer
- splash is the mark + CUTLYRA wordmark centered on the graphite/navy base
- splash-dark is the same on the pure-black OLED variant
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRAND = os.path.join(ROOT, "assets", "brand")
ANDROID_RES = os.path.join(ROOT, "apps", "mobile", "android", "app", "src", "main", "res")
IOS_APPICON = os.path.join(ROOT, "apps", "mobile", "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset")

# Brand tokens sampled from the source art (see Task A/B audit notes).
TILE = (11, 23, 44, 255)  # #0B172C dark graphite/navy base
CYAN = (1, 237, 252, 255)  # #01EDFC electric cyan accent
BLUE = (1, 140, 252, 255)  # #018CFC deep electric blue
WHITE = (247, 247, 247, 255)  # #F7F7F7 near-white geometry

SOURCE = os.path.join(BRAND, "source-logo.png")


def load_mark() -> Image.Image:
    """The mark = the source art minus its rounded-square tile, cropped to
    the artwork's tight bounding box and padded to a square canvas."""
    src = Image.open(SOURCE).convert("RGBA")
    w, h = src.size
    # Scan alpha to find the tile bounds; the tile itself is opaque inside
    # its rounded rect, transparent outside.
    alpha = src.split()[3]
    bbox = alpha.getbbox()
    tile = src.crop(bbox)
    tw, th = tile.size
    side = max(tw, th)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(tile, ((side - tw) // 2, (side - th) // 2))
    return canvas


def crop_mark_strip(mark: Image.Image) -> Image.Image:
    """Tight-crop the C mark itself (strip the outer tile margins) so it can
    be scaled onto other canvases with known relative size."""
    alpha = mark.split()[3]
    bbox = alpha.getbbox()
    return mark.crop(bbox)


def make_icon(size: int, with_tile: bool) -> Image.Image:
    """Square icon canvas. with_tile=True reproduces the source composition
    (tile + centered mark, the launcher look). with_tile=False yields the
    bare mark on transparent (icon-only / monochrome source)."""
    mark = load_mark()
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if with_tile:
        draw = ImageDraw.Draw(canvas)
        radius = int(size * 0.2237)  # matches the source tile's corner ratio
        draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=TILE)
    # Mark occupies 64% of the canvas side — generous adaptive-mask safe area.
    inner = int(size * 0.64)
    m = mark.resize((inner, inner), Image.LANCZOS)
    canvas.paste(m, ((size - inner) // 2, (size - inner) // 2), m)
    return canvas


def make_foreground(size: int) -> Image.Image:
    """Adaptive foreground: transparent 108dp-equivalent canvas, mark drawn
    inside the central ~66% safe zone (i.e. mark side = 44% of full canvas,
    because the safe zone is the middle 66% of the 108dp viewport)."""
    mark = load_mark()
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = int(size * 0.44)
    m = mark.resize((inner, inner), Image.LANCZOS)
    canvas.paste(m, ((size - inner) // 2, (size - inner) // 2), m)
    return canvas


def make_background(size: int) -> Image.Image:
    """Adaptive background: flat tile color, no art."""
    return Image.new("RGBA", (size, size), TILE)


def find_font() -> str:
    """Prefer Albert Sans (bundled with the app), fall back to a heavy system
    sans. The wordmark must read as geometric/rounded."""
    candidates = [
        os.path.join(ROOT, "apps", "mobile", "public", "fonts", "AlbertSans-Bold.ttf"),
        os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "segoeuib.ttf"),
        os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "arialbd.ttf"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    raise SystemExit("no suitable font found for the wordmark")


def make_splash(size: int, dark: bool) -> Image.Image:
    """Full splash: tile-colored field, centered mark, CUTLYRA wordmark."""
    canvas = Image.new("RGBA", (size, size), TILE if not dark else (0, 0, 0, 255))
    mark = load_mark()
    inner = int(size * 0.34)
    m = mark.resize((inner, inner), Image.LANCZOS)
    mx = (size - inner) // 2
    my = int(size * 0.30)
    canvas.paste(m, (mx, my), m)

    font_path = find_font()
    font_size = int(size * 0.085)
    font = ImageFont.truetype(font_path, font_size)
    text = "CUTLYRA"
    d = ImageDraw.Draw(canvas)
    tw = d.textlength(text, font=font)
    tx = (size - tw) / 2
    ty = my + inner + int(size * 0.07)
    d.text((tx, ty), text, font=font, fill=WHITE)
    return canvas


def write(img: Image.Image, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)
    print("wrote", os.path.relpath(path, ROOT))


def main() -> None:
    mark = load_mark()

    # Canonical sources.
    write(make_icon(1024, with_tile=True), os.path.join(BRAND, "icon-only.png"))
    write(make_foreground(1024), os.path.join(BRAND, "icon-foreground.png"))
    write(make_background(1024), os.path.join(BRAND, "icon-background.png"))
    write(make_splash(2732, dark=False), os.path.join(BRAND, "splash.png"))
    write(make_splash(2732, dark=True), os.path.join(BRAND, "splash-dark.png"))

    # Android launcher rasters (pre-26 fallback; adaptive uses vectors below).
    for dpi, px in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
        d = os.path.join(ANDROID_RES, f"mipmap-{dpi}")
        write(make_icon(px, with_tile=True), os.path.join(d, "ic_launcher.png"))
        write(make_icon(px, with_tile=True), os.path.join(d, "ic_launcher_round.png"))

    # Android 12+ splash icon + legacy splash rasters.
    for dpi, px in (("mdpi", 96), ("hdpi", 144), ("xhdpi", 192), ("xxhdpi", 288), ("xxxhdpi", 384)):
        d = os.path.join(ANDROID_RES, f"drawable-{dpi}")
        write(make_splash_icon(px), os.path.join(d, "splash_icon.png"))

    # iOS app icon (single 1024 modern asset; Contents.json references
    # AppIcon-512@2x.png, Xcode's single-size convention).
    write(make_icon(1024, with_tile=True), os.path.join(IOS_APPICON, "AppIcon-512@2x.png"))

    regenerate_android_res()
    regenerate_ios_splash()

    print("brand pipeline complete")


ADAPTIVE_VIEWPORT = 108.0


def make_foreground_png(px: int) -> Image.Image:
    """Adaptive foreground raster at native bucket size: the 108dp viewport
    rendered at `px`. Mark sits inside the middle-66dp safe zone, exactly as
    the vector version did (mark side = 44/108 of the viewport)."""
    mark = load_mark()
    canvas = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    inner = int(px * 44.0 / ADAPTIVE_VIEWPORT)
    m = mark.resize((inner, inner), Image.LANCZOS)
    canvas.paste(m, ((px - inner) // 2, (px - inner) // 2), m)
    return canvas


def regenerate_android_res() -> None:
    """Replace legacy splash PNGs at their existing bucket dimensions and
    emit the density-bucketed adaptive foregrounds."""
    res_files = []
    for dirpath, _dirnames, filenames in os.walk(ANDROID_RES):
        for fn in filenames:
            if fn == "splash.png":
                res_files.append(os.path.join(dirpath, fn))

    for path in sorted(res_files):
        old = Image.open(path)
        w, h = old.size
        portrait = h >= w
        img = make_splash_billboard(w, h, portrait=portrait)
        write(img, path)

    # Adaptive foreground PNGs replace the old hand-drawn violet-arc vector.
    for dpi, px in (("mdpi", 108), ("hdpi", 162), ("xhdpi", 216), ("xxhdpi", 324), ("xxxhdpi", 432)):
        d = os.path.join(ANDROID_RES, f"drawable-{dpi}")
        write(make_foreground_png(px), os.path.join(d, "ic_launcher_foreground.png"))

    # First-run logo (the bare mark on transparent).
    mark = load_mark()
    write(mark.resize((288, 288), Image.LANCZOS), os.path.join(ANDROID_RES, "drawable", "first_run_logo.png"))


def make_splash_icon(size: int) -> Image.Image:
    """Android 12+ windowSplashScreenAnimatedIcon source. The system masks
    this into a circle and insets it, so the mark sits at 72% of the canvas
    with real padding — a bare bbox crop would get its edges clipped."""
    mark = load_mark()
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = int(size * 0.72)
    m = mark.resize((inner, inner), Image.LANCZOS)
    canvas.paste(m, ((size - inner) // 2, (size - inner) // 2), m)
    return canvas


def make_splash_billboard(w: int, h: int, portrait: bool) -> Image.Image:
    """Launch-theme windowBackground: flat navy field, centered mark with
    CUTLYRA wordmark beneath (portrait) or beside-centered (landscape)."""
    canvas = Image.new("RGBA", (w, h), TILE)
    mark = load_mark()
    if portrait:
        inner = int(min(w, h) * 0.26)
        mx, my = (w - inner) // 2, int(h * 0.335)
        text_dy = int(h * 0.045)
    else:
        inner = int(min(w, h) * 0.34)
        mx, my = (w - inner) // 2, int((h - inner) * 0.42)
        text_dy = int(h * 0.09)
    m = mark.resize((inner, inner), Image.LANCZOS)
    canvas.paste(m, (mx, my), m)

    font = ImageFont.truetype(find_font(), int(inner * 0.26))
    d = ImageDraw.Draw(canvas)
    text = "CUTLYRA"
    tw = d.textlength(text, font=font)
    d.text(((w - tw) / 2, my + inner + text_dy), text, font=font, fill=WHITE)
    return canvas


def regenerate_ios_splash() -> None:
    """Replace the three Capacitor iOS splash rasters at their stored dims."""
    imageset = os.path.join(ROOT, "apps", "mobile", "ios", "App", "App", "Assets.xcassets", "Splash.imageset")
    for fn in sorted(os.listdir(imageset)):
        if not fn.endswith(".png"):
            continue
        path = os.path.join(imageset, fn)
        w, h = Image.open(path).size
        write(make_splash_billboard(w, h, portrait=False), path)


if __name__ == "__main__":
    main()
