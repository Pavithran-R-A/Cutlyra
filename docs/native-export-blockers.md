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
2. **Surface readback for Freeze Frame capture** — `captureFreezeFrame`
   returns `DEVICE_ONLY` on this host; real capture needs a live preview
   surface. Web-side capture path is the fallback.
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