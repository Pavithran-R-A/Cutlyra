#!/usr/bin/env python3
"""Cutlyra canonical brand-asset pipeline.

Canonical source: assets/brand/cutlyra-mark.svg (original scalable timeline mark).
Canonical outputs (assets/brand/): icon-only.png, icon-foreground.png,
icon-background.png, splash.png, splash-dark.png — plus the Android/iOS res
rasters the platforms need, written directly into their res trees.

No npm dependency is added. The pipeline is PIL-based and deterministic:
the SVG is rendered at a fixed resolution then alpha-cropped; rerunning with
the same cutlyra-mark.svg regenerates all platform rasters.

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

# Cutlyra palette shared by launcher, splash and store graphics.
TILE = (11, 23, 44, 255)  # #0B172C dark graphite/navy base
CYAN = (1, 237, 252, 255)  # #01EDFC electric cyan accent
BLUE = (1, 140, 252, 255)  # #018CFC deep electric blue
WHITE = (247, 247, 247, 255)  # #F7F7F7 near-white geometry

SOURCE = os.path.join(BRAND, "cutlyra-mark.svg")


def load_mark() -> Image.Image:
    """Render and crop the transparent timeline-C / editing playhead mark.
    The dark tile is never included in adaptive foreground layers.
    """
    import io
    import cairosvg
    with open(SOURCE, "rb") as f:
        svg = f.read()
    png = cairosvg.svg2png(bytestring=svg, output_width=1024, output_height=1024)
    mark = Image.open(io.BytesIO(png)).convert("RGBA")
    bbox = mark.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError("Cutlyra SVG has empty alpha")
    cut = mark.crop(bbox)
    side = max(cut.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.alpha_composite(cut, ((side - cut.width) // 2, (side - cut.height) // 2))
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
        draw.rectangle([0, 0, size - 1, size - 1], fill=TILE)  # Google Play masks full square
    # Mark occupies 64% of the canvas side — generous adaptive-mask safe area.
    inner = int(size * 0.64)
    m = mark.resize((inner, inner), Image.LANCZOS)
    canvas.paste(m, ((size - inner) // 2, (size - inner) // 2), m)
    return canvas


def make_foreground(size: int) -> Image.Image:
    """Adaptive foreground: transparent 108dp-equivalent canvas, mark drawn
    inside the central ~66% safe zone (i.e. mark side = 58% of full canvas,
    because the safe zone is the middle 66% of the 108dp viewport)."""
    mark = load_mark()
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = int(size * 0.58)
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
    candidates.append("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
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


def make_feature_graphic() -> Image.Image:
    """Google Play feature graphic: exactly 1024x500, 24-bit RGB, no alpha.

    Composed from the canonical `icon-only.png` this same script writes (which
    is rendered from cutlyra-mark.svg), so the mark is pixel-identical to the
    store icon and the graphic needs no second SVG rasterizer. Both share the
    TILE navy, so the mark square composites seamlessly. Lockup is mark +
    CUTLYRA wordmark only — no tagline, claim, or inherited OpenCut art.
    """
    w, h = 1024, 500
    margin = 48
    gap = 56
    canvas = Image.new("RGB", (w, h), TILE[:3])
    d = ImageDraw.Draw(canvas)

    # Tight square that exactly contains the mark inside icon-only.png
    # (make_icon places it at 64% of the side, centered).
    src = Image.open(os.path.join(BRAND, "icon-only.png")).convert("RGB")
    inner = int(src.width * 0.64)
    off = (src.width - inner) // 2
    mark = src.crop((off, off, off + inner, off + inner))

    mark_side = 320  # fits the 500px height with generous margin
    m = mark.resize((mark_side, mark_side), Image.LANCZOS)

    text = "CUTLYRA"
    font_path = find_font()
    room = w - 2 * margin - mark_side - gap
    font_size = 120
    font = ImageFont.truetype(font_path, font_size)
    while font_size > 48 and d.textlength(text, font=font) > room:
        font_size -= 2
        font = ImageFont.truetype(font_path, font_size)
    tw = d.textlength(text, font=font)

    group = mark_side + gap + tw
    x0 = (w - group) / 2
    canvas.paste(m, (round(x0), (h - mark_side) // 2))

    # Center the glyphs themselves, not the font's ascent box.
    box = font.getbbox(text)
    ty = (h - (box[3] - box[1])) / 2 - box[1]
    d.text((x0 + mark_side + gap, ty), text, font=font, fill=WHITE[:3])
    return canvas


def write(img: Image.Image, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)
    print("wrote", os.path.relpath(path, ROOT))


def main() -> None:
    mark = load_mark()

    # Canonical sources.
    write(make_icon(1024, with_tile=True), os.path.join(BRAND, "icon-only.png"))
    write(make_icon(512, with_tile=True), os.path.join(BRAND, "play-store-icon-512.png"))
    write(make_foreground(1024), os.path.join(BRAND, "icon-foreground.png"))
    write(make_background(1024), os.path.join(BRAND, "icon-background.png"))
    write(make_splash(2732, dark=False), os.path.join(BRAND, "splash.png"))
    write(make_splash(2732, dark=True), os.path.join(BRAND, "splash-dark.png"))
    write(make_feature_graphic(), os.path.join(BRAND, "feature-graphic-1024x500.png"))

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
    regenerate_web_icons()

    print("brand pipeline complete")


ADAPTIVE_VIEWPORT = 108.0


def make_foreground_png(px: int) -> Image.Image:
    """Adaptive foreground raster at native bucket size: the 108dp viewport
    rendered at `px`. Mark sits inside the middle-66dp safe zone, exactly as
    the vector version did (mark side = 58/108 of the viewport)."""
    mark = load_mark()
    canvas = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    inner = int(px * 58.0 / ADAPTIVE_VIEWPORT)
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


def regenerate_web_icons() -> None:
    """Keep website favicon and platform icons aligned with mobile branding."""
    folder = os.path.join(ROOT, "apps", "web", "public", "icons")
    for fn in sorted(os.listdir(folder)):
        if not fn.endswith(".png"):
            continue
        path = os.path.join(folder, fn)
        old = Image.open(path)
        if old.width != old.height:
            raise ValueError(f"non-square web icon {fn}")
        write(make_icon(old.width, with_tile=True), path)

    favicon = os.path.join(ROOT, "apps", "web", "public", "favicon.ico")
    icons = [make_icon(n, with_tile=True).convert("RGBA") for n in (16, 32, 48)]
    icons[-1].save(favicon, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    print("wrote", os.path.relpath(favicon, ROOT))


if __name__ == "__main__":
    main()
