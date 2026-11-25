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
3. **GIF → MP4 frame feeding** — `prepareGifExport` validates the plan and
   returns `DEVICE_ONLY` for the encode step; frame timing/transparency/loop
   metadata are covered by `GifExportPlan` unit tests and the web decoder
   contract (`packages/editor-core/src/media/gif-decoder.ts`).
4. **Android unit tests offline** — `testDebugUnitTest` needs
   `org.json:json:20250517` and `mockito-core:5.20.0`, which are not cached
   in offline mode. Run with network access: `./gradlew testDebugUnitTest`.

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
- Remaining M3 deep work (feeding real GIF frames to the encoder) is
  Rust/GIF-pipeline dependent and tracked here.
