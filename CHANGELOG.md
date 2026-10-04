# Changelog

All notable changes to Cutlyra are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed (Android, physical-device Stage 11 — 2026-09-25/26)

- **Audio picks now route through SAF** (system file picker) instead of the
  visual photo picker, which cannot custody audio files; media probes guard
  retriever failures and still-image bounds (portrait/landscape/PNG verified
  on device); assetless library clips no longer abort native export; broken
  WebGPU presentation on Android WebView is suppressed in favor of the
  working WebGL2 path; PlaybackManager self-heals non-finite tick writes
  (a live `invalid type: unit value, expected i64` wasm crash caught on
  device during React render); the export sheet now discloses that bundled
  preview-only sounds are not included in the exported file.
- **Speed-changed clips no longer abort every export** (found in the
  2026-09-26 deep iQOO pass): `ConstantSpeedProvider` answered media3's
  "no more speed changes" with `Long.MAX_VALUE` instead of the
  `C.TIME_UNSET` sentinel, so `Transformer.start()` threw
  `IllegalStateException` for any project containing a retimed clip.
  Fixed to the sentinel; regression test added
  (`ConstantSpeedProviderTest`).
- **A failed export no longer wedges the exporter for the life of the
  process**: `Media3Exporter` now releases its singleton slots when
  `Transformer.start()` throws synchronously (previously every later export
  failed with "an export is already in progress" until force-stop), and the
  start-up catch logs the full exception stack and class name instead of a
  message-less fallback string that hid the root cause above.
- Full evidence and per-fix rationale: `CUTLYRA_HANDOFF.md` "Stage 11".

### Changed (Android packaging — Stage 9, release payload slimming)

- **Release APKs no longer ship the M1 spike diagnostics payload.**
  Measured on this machine: unsigned `assembleRelease` went from
  109,424,260 bytes (Stage 8) to **94,211,012 bytes** — **15,213,248
  bytes (~14.5 MiB, 13.9%) smaller** — with zero product-code changes
  (see `CUTLYRA_HANDOFF.md` "Stage 9" for the exact entry-level breakdown
  and the debug-build equivalences that prove packaging-only impact).
- The two native spike fixture clips (`clip-a.mp4`, `clip-b.mp4`) moved
  from `src/main/assets/spike/` to the debug source set
  (`src/debug/assets/spike/`) — release merges simply never see them.
- The generated `cap sync` web copy (`android/.../src/main/assets/public/`)
  is pruned of the spike web payload only in release builds, by a Gradle
  task (`pruneSpikeAssetsForRelease`, declared in
  `apps/mobile/android/app/build.gradle`) wired ahead of
  `mergeReleaseAssets`. Debug builds keep the full payload; the canonical
  debug flow (`scripts/build-android-debug.sh` -> `bun run build` +
  `cap sync`) regenerates it.
- Verified on the built artifacts: release contains **0** spike entries;
  the canonical debug rebuild contains all 7; packaging of the native
  library (16 KB ELF/ZIP alignment), metadata, and manifest hardening are
  structurally unchanged.


Nothing yet. v0.1.0 release-candidate engineering is in progress; see below.

## [0.1.0] — RELEASE CANDIDATE (source ready; single-device physical qualification done 2026-09-25)

The first Cutlyra release: a free, open-source, local-first Android mobile
video editor. No account, no subscription, no ads, no watermark, no cloud —
editing and export run entirely on-device.

### Added (Android, arm64-v8a phones; x86_64 compatible environments, minSdk 29 / targetSdk 36)

- **Local projects** — create, rename, delete, and reopen projects; all
  data is stored on-device (IndexedDB + app-private native storage).
- **Media import** — video, photo, and audio import through the modern
  Android **Photo Picker** with a SAF document-picker fallback; imports
  are copied into the app's private storage (bounded-memory, with a
  native proxy transcode for large videos).
- **Editing** — multi-track timeline; trim, split, duplicate, delete;
  reorder; per-clip speed; aspect-ratio canvas; overlays /
  picture-in-picture; text; cross-fade transitions; transform/opacity
  keyframes; undo/redo throughout. Preview-only effect/filter code remains
  in the shared engine but is not exposed in Android v0.1.0 because native
  export parity is not yet implemented.
- **Playback** — frame-accurate preview backed by the same engine state
  used for export.
- **Export** — hardware-accelerated MP4 (Media3 Transformer): H.264 +
  AAC, with overlays/text/captions rendered into the output.
- **On-device auto-captions** — whisper.cpp running locally via JNI
  (`libcutlyra_whisper.so`, bundled `ggml-tiny.en.bin` model, English);
  captions are generated fully offline, persist with the project, and
  can be burned into exports.
- **Persistence** — projects survive force-stop, process death, and
  device restarts.

### Validated quality

- Full P0 flow (launch → create → import → edit → persistence → export)
  exercised end-to-end on an Android emulator via real system UI
  automation (Photo Picker included), plus a real-speech caption round
  trip and multiple exports verified with ffprobe (`docs/EMULATOR-QA.md`).
- **Physical-device qualification WAS performed 2026-09-24/25** on an
  iQOO I2221 (Android 16, arm64, 16 KB-page capable), with a second-device
  POCO M4 Pro 5G qualification campaign in progress for the final release
  candidate: install, cold
  launch, first-run, project create, import (photo picker + SAF),
  playback, scrub, split/undo/redo, persistence across force-stop, and
  native Media3 exports — plus the Stage 11 regression fixes above,
  found and closed from live device crashes.
- **16 KB page-size compatibility**: every packaged native library has
  16 KB-aligned ELF LOAD segments (`-Wl,-z,max-page-size=16384`) and the
  APK passes `zipalign -P 16` — required by 16 KB-page Android devices.
- Release build pipeline verified: `assembleRelease` compiles with R8
  resources off/minify off as configured, produces a valid, zipaligned
  APK; release signing is prepared via environment variables only
  (`docs/RELEASING.md`) — no signing material is committed.

### Not yet claimed

- Physical-device qualification has been performed on ONE device (iQOO
  I2221, Android 16); a broader device matrix (other OEMs, Android
  versions, 4 KB-page devices) remains untested, and thermal/long-session
  behavior is unqualified.
- Real-speech caption generation has not been re-run on the physical
  device (emulator-verified only; the on-device model pipeline is
  unchanged since).
- iOS shell is kept building but is not a validated v0.1.0 target.
- Production signing key: not yet created (deliberately; see
  `docs/RELEASING.md`).

### Attribution

Cutlyra's editing engine is derived from
[`OpenCut-app/opencut-classic`](https://github.com/OpenCut-app/opencut-classic)
(MIT). See `LICENSE`, `NOTICE`, and `docs/THIRD_PARTY_NOTICES.md`.
Cutlyra is an independent project, unaffiliated with OpenCut or
CapCut/ByteDance.

[Unreleased]: https://github.com/cutlyra/cutlyra/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/cutlyra/cutlyra/releases/tag/v0.1.0
