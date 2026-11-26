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

## Voiceover recording (IMPLEMENTED 2026-11-25)

Recording is no longer a gap. There is one recorder, one custody rule and one
mix policy, and the mix is measured from decoded MP4 audio.

**Capture.** `VoiceoverRecorder` (pure Kotlin, JVM-tested) pulls PCM from a
`PcmSource` on its own thread and streams 44.1 kHz mono 16-bit WAV chunks to
`<custody>/generated/voiceover-<takeId>.wav.tmp`, renaming to `.wav` only on a
successful stop. `AudioRecordPcmSource` is the device implementation
(`MediaRecorder.AudioSource.MIC`); the recorder itself never touches
`AudioRecord`, which is what lets a deterministic source drive the production
path in tests. One 4096-sample buffer is reused for the whole take, so a
five-minute take allocates the same bytes as a one-second take. Takes shorter
than 250 ms are rejected (`TOO_SHORT`) and deleted; cancel deletes; a killed
process leaves only an unreferenced `.tmp` that the next sweep removes.

**Permission and lifecycle.** `RECORD_AUDIO` is requested at the point of use
from the Record button (`requestMicrophonePermission`), never at launch. A
denial stops before recording starts and the panel distinguishes "ask again"
from "blocked in Settings". Recording runs on a native thread, not the
activity, so backgrounding keeps the take alive and the capture thread stops
itself at the limit; the UI commits it on the next poll. Closing the sheet
mid-take cancels and deletes it.

**Take length.** `voiceoverTakeLimit` = min(remaining project duration at the
playhead, 300 s). A playhead at or past the project end refuses to start rather
than recording something nobody can hear.

**State.** A finished take becomes one audio asset row (custody paths, no JS
bytes) plus one audio-track element at the record position, inserted as a
single `BatchCommand` — so undo/redo is one step, save/reopen round-trips it,
and archive/restore reproduces it because it is ordinary media. Custody is the
same rule as other generated media: `pruneTakes` deletes only
`generated/voiceover-*` files that no asset row references (identified by
path, so archive/restore rewriting the take location cannot orphan it), and
never library sounds or freeze frames.

**Mix policy — documented, implemented, measured.** Unity gain (0 dB, element
volume 1.0), summed with the clip's own audio, and **no automatic ducking**.
`LimitingAudioMixer` caps the sum at full scale, which is the only nonlinearity.
The policy is intentionally the simple one: ducking is not implemented, so the
UI and docs must not suggest it. The voiceover is not a special export path —
it reaches the EDL as an ordinary audio element on an audio track and is mixed
by the existing Media3 audio lane, at its own element start, after trim and
retiming.

**Verification.** `ExportVoiceoverInstrumentedTest` (emulator, 3 tests) drives
`VoiceoverRecorder` with a deterministic tone source, exports, and decodes the
MP4's audio PCM with `MediaExtractor` + `MediaCodec`: voiceover present at
0.380 s against an expected 0.400 s (±80 ms tolerance), gain within **0.01 dB**
of the clip's audio bed (unity), and the bed level changing by only **0.42 dB**
while the voiceover plays (no ducking). A trimmed take starts at its element
position (0.180 s measured vs 0.200 s expected), ends at its trimmed end
(0.600 s, silence after), and a take that survives archive → restore still
exports its tone (1 kHz amplitude 7994). `VoiceoverRecorderTest` covers the
recorder and the custody sweep on the JVM; `voiceover.test.ts` covers the take
limit, the asset+element commit, one-step undo/redo and the sweep boundary.

**Open limitation.** Live microphone capture is not exercised in CI or on the
emulator: the tests drive the production recorder through `PcmSource`, so
record → custody → mix → export is proven, but `AudioRecordPcmSource` gaining
real sound from a physical mic (and the OS permission dialog itself) is a
device-only check that has not been performed. Nothing else in the path is
assumed: encode of the take, its timing and its gain are all measured.

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
