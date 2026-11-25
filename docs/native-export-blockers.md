# Native Export Blockers (Cutlyra)

This note documents verification steps that cannot run in the current
development environment (no adb/emulator, no MediaCodec encode surface) and
must be validated in CI or on a physical device.

## Environment

- JDK 21: `C:\Users\Pavithran R A\Downloads\jdk21\jdk-21.0.13.1+2` (installed).
- `./gradlew :app:compileDebugKotlin` exits 0 (BUILD SUCCESSFUL).
- Android unit tests (`testDebugUnitTest`) pass when dependencies resolve online.

## Device-only verification pending

1. **MediaCodec encode / MP4 export** — `Media3Exporter` hardware/software
   encode path requires a device/emulator. Command to run in CI:
   `./gradlew connectedAndroidTest` (instrumented tests in
   `app/src/androidTest/`). Blocker: no emulator available in this environment.
2. **Freeze Frame capture (RESOLVED)** — `captureFreezeFrame` no longer
   returns `DEVICE_ONLY`. It decodes the clip's SOURCE frame at the exact
   mapped instant with `MediaMetadataRetriever.getFrameAtTime(ts,
   OPTION_CLOSEST)` (never `OPTION_CLOSEST_SYNC`, which would silently return
   a keyframe), writes a PNG into `<custody>/freeze/`, prunes stills the
   project no longer references, and reports the `file://` uri plus size. The
   asset record, its `freezeFrame` provenance and the timeline edit are all
   persisted; `persistFreezeFrame` performs a real read-modify-write through
   `storageService`. Out-of-range instants are refused with
   `CAPTURE_OUT_OF_RANGE` rather than clamped. A source frame (not a
   composited canvas grab) is captured on purpose so overlapping overlays
   stay live and editable.

   Verified on the emulator by `ExportFreezeFrameInstrumentedTest`, which
   generates a red/green/blue source video, captures through the production
   `FreezeFrameCapture` path, exports the freeze EDL, and decodes the MP4 to
   assert the exact colours of the frozen frame, the neighbouring frames and
   the expected total duration.
3. **Reverse Video (RESOLVED)** — the Edit panel's Reverse button generates
   real reversed media instead of setting a flag. `ReverseMediaGenerator`
   samples the element's own source range backwards
   (`getFrameAtTime(..., OPTION_CLOSEST)`), re-encodes it as a video-only MP4
   in `<custody>/reverse/`, and the clip is retargeted at it in one undoable
   command. Progress and cancellation are real (per-frame counter, partial
   file deleted). Reversed clips are silent BY POLICY and the UI says so.
   Verified by `ReverseVideoInstrumentedTest` on the emulator: the generated
   MP4 decodes as blue→green→red from a red→green→blue source, ~3.0s,
   320x240 and 240x320 preserved, zero audio tracks, cancellation leaves no
   file, and a range past the source end is refused with
   `RANGE_OUT_OF_BOUNDS`.
4. **Background blur → native export (RESOLVED 2026-11-25)** — Media3 1.11.0's
   `GaussianBlurWithFrameOverlaid` blurs and overlays the SAME cropped input,
   so it cannot produce a fitted sharp foreground over a fill-cropped blurred
   background when aspect ratios differ. The exporter now uses a custom
   single-input `BackgroundBlurEffect` (`GlShaderProgram`, 9 taps): the
   backdrop is the frame sampled with fill UVs and blurred, the foreground is
   the same frame sampled with fit UVs and left sharp. `BackgroundBlurMath`
   mirrors the preview's `intensity/5 × resolution/reference` sigma and both
   sides are tested against the same fixtures; the layout is computed from the
   frame the shader actually receives, so crop, rotation and Fit/Fill are
   honoured. `EdlMeta.background` is parsed (older EDLs default to colour) and
   `ExportBackgroundBlurInstrumentedTest` decodes the exported MP4s: sharp
   fitted foreground, non-black blurred same-source backdrop, stronger
   intensity blurs more, portrait-on-landscape and landscape-on-portrait.
5. **GIF → MP4 frame feeding (RESOLVED)** — a picked `.gif` is decoded
   natively (`GifDecoder`, pure Kotlin) into one real PNG per frame in media
   custody (`gif/<assetId>/frame-NNN.png`) plus the file's own per-frame
   delays and Netscape loop count; the JS import persists that on the asset
   (`MediaAssetData.gif`), with no uniform-delay guess.

   Export feeds those frames, not metadata: `buildEdl` carries each frame's
   custody URI and its own delay (`EdlGifAsset`/`EdlGifFrame`),
   `GifFrameTimeline` maps the clip's source span (trim + speed) onto the
   frames, and `EdlToComposition.buildTimelineItems` builds one Media3 item per
   visible frame through the same still-image path as any still (so framing,
   crop, colour effects and keyframes apply per frame).

   LOOP RULE: an ENDLESS GIF is placed at one loop of content and the export
   plays the clip's authored duration (it repeats inside that window, then the
   sequence ends — a video file cannot loop forever); a FINITE GIF gets
   `loopCount × loop duration` as its asset duration and HOLDS its last frame
   after the final loop instead of wrapping back to the first.

   `prepareGifExport` is now a real preflight, not a file-existence check: it
   DECODES every frame the EDL is about to reference and rejects with
   `GIF_FRAMES_MISSING`, `GIF_FRAME_UNREADABLE` or
   `GIF_FRAME_DIMENSION_MISMATCH` (naming the path), and the export sheet runs
   it before encoding starts so a corrupt frame is reported verbatim instead of
   as a generic Media3 asset-loader error.

   Verified on the emulator by `GifNativePipelineInstrumentedTest`
   (generated red/green/blue GIF, decoded-MP4 assertions on colour order,
   non-uniform per-frame timing, looping, trim/hold, per-frame filters and
   transforms), `GifExportPreflightInstrumentedTest` and
   `GifBackupRestoreInstrumentedTest` (frame order survives backup/restore).
4. **Android unit tests offline** — `testDebugUnitTest` needs
   `org.json:json:20250517` and `mockito-core:5.20.0`, which are not cached
   in offline mode. Run with network access: `./gradlew testDebugUnitTest`.

## Colour grade: sharpen & vignette (RESOLVED 2026-11-25)

Before this, a project using either Adjust slider could not be exported at all:
`ColorGrade.unsupportedParams()` named them and `EdlToComposition` threw
`ExportUnsupportedException` for the whole export, even though the preview
rendered them in `color_adjust.wgsl`.

`ColorGradeSpatialEffect` now renders both as a real one-input GL pass with the
WGSL shader's own formulas and constants — unsharp mask (4 neighbours, 1px,
`* 1.5`) added before `ColorGradeMatrixEffect`, radial `smoothstep(0.35, 0.9,
length(uv - 0.5) * 1.6)` vignette added after it. Panel units reach the shader
through the same `/100` mapping as `colorGradeUniforms()`, pinned by the shared
fixtures (`generate-color-grade-fixtures.ts` -> `spatial` per case).

Verified on the emulator by `ExportSharpenVignetteInstrumentedTest`: the
striped source is exported with and without each slider, the MP4 is decoded,
and sharpen raises edge contrast >10% without moving mean luma by 25 levels,
while vignette drops the corner band below 60% of the ungraded value and keeps
the centre within 10 levels. `ColorGradeMatrixTest` covers the JVM mapping.

Remaining limits: stacked Adjust + Filter grades render each sharpen pass
before all colour matrices and each vignette after them (preview interleaves
per effect); this only differs when two grades on one clip both use spatial
params.

## Invariants preserved

- Static graphics unchanged; transformation/crop/opacity/layer order covered
  by existing editor-core tests.
- Freeze Frame is reversible and non-destructive to source media
  (`FreezeFrameOps.apply`/`undo`).
- GIF export validates malformed/zero-delay input via `GifExportPlan.normalized()`.
## M1 repair status (2026-11-23)

- `apps/web` tsc: 0 errors (was 43).
- `scripts/invariants.sh`: green (build, typecheck all packages, lint within baseline, unit tests, offline audit, bridge-import, mouse-event).
- Android: `:app:compileDebugKotlin` BUILD SUCCESSFUL; `testDebugUnitTest` BUILD SUCCESSFUL.
- Freeze Frame (M2) is implemented end to end: accurate timeline→source
  mapping (trim + retime), real native capture, persisted still + config,
  rippling undoable timeline edit with a silent-hold audio policy, UI
  (freeze at playhead, hold slider, remove, progress/error), and a
  deterministic exported-MP4 pixel test.
- GIF (M3) is implemented end to end: native pick+decode to per-frame PNGs
  with the file's own delays and loop count, real frame feeding into the
  Media3 export, a decoding export preflight, and decoded-MP4 verification.
