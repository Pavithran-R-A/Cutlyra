# Cutlyra — Android compatibility statement (authoritative)

**Scope note:** Cutlyra targets **general Android distribution**. The iQOO I2221
used in earlier QA passes is **one physically tested device**, not the support
boundary. Nothing here claims more than was actually built and run.

## Version support

| Field | Value |
|---|---|
| minSdk | **29** (Android 10) |
| targetSdk | **36** (Android 16) |
| compileSdk | **36** (Android 16) |

- **Installable / config-supported baseline: Android 10 (API 29) and newer**,
  subject to device hardware, ABI, and runtime compatibility (e.g. a
  camera-less device cannot exercise camera capture; the manifest declares
  camera/microphone as `required="false"`, so such devices can still install).
- targetSdk 36 is a **Play submission property of the build**, not a maximum
  supported Android version.
- **Runtime emulator actually tested: API 37 / Android 17** (Pixel_10 AVD,
  `google_apis_playstore_ps16k` x86_64 image, 16 KB page size — `getconf
  PAGESIZE` = 16384). Android 16 = API 36 = targetSdk; Android 17 = API 37.
- **Physical cleaned-build smoke test: DEFERRED** (no physical device
  connected at test time; an emulator result is never substituted for one).

## ABI support

Shipped native ABIs: **arm64-v8a** and **x86_64** (`libcutlyra_whisper.so`
compiled natively for both; ELF machines verified AArch64 / X86-64).

**Support statement:** 64-bit Android devices from the minSdk baseline onward,
with **arm64-v8a as the production-phone ABI** and **x86_64 for compatible
x86_64 environments — Android emulators, ChromeOS x86_64, and similar**.

Not shipped / not tested:

- **armeabi-v7a** — not shipped, not compiled for distribution, not tested on
  hardware; consequently **some older 32-bit ARM Android devices are
  unsupported**.
- **x86 (32-bit)** — not shipped.

## Verified evidence (preserved)

- 16 KB page-size alignment: **PASS** — every `PT_LOAD` segment of
  `libcutlyra_whisper.so` at `0x4000` (16384) in debug APK, release APK, and
  AAB, for both ABIs (debug and release variants).
- **x86_64 native whisper runtime test** (API 37 / Android 17 emulator,
  16 KB pages): `nativeloader` loaded `lib/x86_64/libcutlyra_whisper.so`;
  audio decode → context init from bundled `ggml-tiny.en.bin` → two full
  `fullTranscribe` runs; graceful "No speech was detected" UX on a
  speechless fixture; zero `FATAL`/`SIGSEGV`/ANR.
- Emulator smoke (same session): `adb install -r`, launch, persisted-project
  reopen (data survived OS kill + reinstall), playback, 9:16/16:9 aspect
  switching (canvas 1080×1920 / 1920×1080), full 9:16 export (pulled MP4:
  h264, 1080×1920 with −90 display-rotation, real content frame-verified),
  process death/reopen, new-project creation; form factors: small phone,
  landscape, normal phone, tablet viewport — no horizontal overflow.
- Android JVM tests: `testDebugUnitTest` + `testReleaseUnitTest` — green.
- Play readiness: targetSdk 36; AAB produced; 64-bit present; 16 KB pass;
  `applicationId` `app.cutlyra.editor`; label `Cutlyra`; no debug-only
  resources in release; no secrets/keystores/`local.properties`/model
  weights/build output tracked (gitignored).
- Brand/legal: zero AI-tool branding references (brand forensics clean);
  third-party MIT
  attribution for whisper.cpp preserved (`docs/THIRD_PARTY_NOTICES.md`).

## Artifact hashes

| Artifact | SHA-256 |
|---|---|
| `app/build/outputs/apk/debug/app-debug.apk` | `c9e9fbbe77f9895ce3ba80d4ff7d7a239b8d607e18d67b8006b6cd5641dd05ea` |
| `app/build/outputs/apk/release/app-release.apk` (QA-signed) | `3a6d9df53ed6c06318ac9588f996d8fc123f1fb2b05d6bc6dfd6eab8fae69743` |
| `app/build/outputs/bundle/release/app-release.aab` | `74adf263678a831557aa303f1e58140e975c9970c6a8bfc433d4a544c7c2971c` |

## Known untested combinations (honest gaps)

- API 29–35 emulator runs (only the API 37 image installed; host disk
  constrained).
- Physical-device smoke of the cleaned/rebranded build (deferred).
- armeabi-v7a and x86 (deliberately not shipped).
- AAB is QA-signed; Play upload requires real Play App Signing in CI.
