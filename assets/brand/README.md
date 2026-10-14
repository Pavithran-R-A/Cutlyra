# Cutlyra brand assets

Canonical source: `cutlyra-mark.svg` — an original, transparent scalable mark
constructed from a cyan filmstrip shaped as the letter C, a white playback
triangle and a coral timeline playhead (video editing, preview and cut).

The palette deliberately shares Cutlyra's navy `#0B172C` backdrop and
cyan `#00CAE0` editing accent. The geometric mark contains no text and is
designed to read as an app icon at small sizes. The old `source-logo.png`
is superseded and must not be used for new branding.

Regenerate everything with:

```
python scripts/generate-brand-assets.py
```

Outputs:

| File | Purpose |
| --- | --- |
| `icon-only.png` | 1024 square full-bleed store/app canonical icon |
| `play-store-icon-512.png` | 512×512 sRGB full-bleed PNG, Play Console icon, must be <=1024 KB |
| `icon-foreground.png` | 1024 adaptive foreground layer (transparent, mark at 58/108) |
| `icon-background.png` | 1024 adaptive background layer (flat navy) |
| `splash.png` | 2732 square, mark + CUTLYRA wordmark (canonical splash) |
| `splash-dark.png` | 2732 square, same on pure black (OLED variant) |

The script also writes platform rasters directly into their res trees:

- Android `mipmap-*/ic_launcher{,_round}.png` (legacy API < 26 fallback)
- Android `drawable-*/ic_launcher_foreground.png` (adaptive layers, API 26+;
  referenced by `mipmap-anydpi-v26/*.xml`, which also declares the
  monochrome/themed layer)
- Android `drawable-*/splash_icon.png` (Android 12+ SplashScreen icon,
  pre-padded for the system's circular mask; consumed by
  `values-v31/styles.xml` → `Theme.Cutlyra.Splash`)
- Android `drawable-{port,land}-*/splash.png` (pre-12 launch windowBackground
  billboards, regenerated at the original bucket dimensions)
- Android `drawable/first_run_logo.png` (first-run screen mark)
- iOS `AppIcon.appiconset/AppIcon-512@2x.png` (single-size 1024)
- iOS `Splash.imageset/splash-2732x2732*.png`

Design constraints encoded in the pipeline: no text inside the launcher
icon; mark centered with generous adaptive-mask safe area; wordmark only on
splash surfaces; SVG mark with subtle cyan and coral gradients; generation does not invent gradients.

The CI regeneration workflow for the icon-refresh feature branch runs
`pip install pillow cairosvg` and this generator. All Android adaptive,
legacy mipmap, splash, first-run, iOS, website favicon and Play icon assets
must be committed from the same SVG. Do not hand-edit one platform's raster.
The brand mark was independently designed for Cutlyra, but worldwide visual
uniqueness and trademark clearance cannot be guaranteed by source generation
or a web search alone; do a trademark/image similarity check before launch.
