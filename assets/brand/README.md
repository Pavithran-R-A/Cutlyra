# Cutlyra brand assets

Canonical source: `source-logo.png` — the provided Cutlyra brand art
(dark navy `#0B172C` rounded tile, cyan→blue "C" with film-strip
perforations, white timeline blocks with a cut handle). Regenerate
everything with:

```
python scripts/generate-brand-assets.py
```

Outputs:

| File | Purpose |
| --- | --- |
| `icon-only.png` | 1024 square, tile + mark — store/app icon canonical |
| `icon-foreground.png` | 1024 adaptive foreground layer (transparent, mark at 44/108) |
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
splash surfaces; flat geometry, no gradients introduced by the pipeline.
