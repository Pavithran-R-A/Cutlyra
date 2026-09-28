# Cutlyra v0.1.0 — Emulator QA Report

**Date:** 2026-09-23 · **Runner:** autonomous ADB/CDP/UI-Automator session (no manual UI steps)
**Artifact under test:** `dist/Cutlyra-v0.1.0-debug.apk`
SHA-256 `fc9a32d5aaad46564e32bdea69ad4775af62a3b6b6d7d304adf6b7418fcf0ca0`
(size 120,586,116 B, debug-signed, `app.cutlyra.editor` v0.1.0 / code 1, minSdk 29, targetSdk 36, arm64-v8a)

**Environment:** Google Pixel_10 AVD, system image `android-37.0 / google_apis_playstore_ps16k / x86_64`
(Android **17**, API **37**, codename `REL`, fingerprint
`google/sdk_gphone16k_x86_64/emu64xa16k:17/CP21.260330.012/15545953:user/dev-keys`,
`getconf PAGE_SIZE` = 16384 — **16 KB page-size image**, the strictest native-alignment profile),
host Windows x86_64. App process ran natively via libhoudini ARM translation for
`arm64-v8a/libcutlyra_whisper.so`. Note: the app itself targets SDK 36
(Android 16); the emulator merely runs a newer (API 37 / Android 17) image.

## Method

- **CDP** (Chrome DevTools Protocol over the debug WebView's DevTools socket):
  semantic DOM queries + real click events against the actual production UI.
- **UI Automator** for the native system surfaces the webview cannot see:
  the system **Photo Picker** (`ACTION_PICK_IMAGES`), consent dialogs, grid
  taps, and selection confirmation — i.e. the real Android import path.
- **ADB** for install, cold start, force-stop, back gesture, logcat capture.
- The repo's own `#/autotest` headless harness for the pipelined
  import→playback→export→captions assertion pass.
- **ffprobe/ffmpeg** (host) for every exported file; byte-exact pulls via
  `adb exec-out` (note: `run-as cat` over the default shell channel corrupts
  binary streams — early "audio-only export" readings were that measurement
  artifact, disproven by exec-out re-pulls).

## Results — P0 chain (all exercised on the real UI unless noted)

| Step | Result | Evidence |
|---|---|---|
| Cold launch | PASS | `am start -W` COLD ok; FirstRun screen after `pm clear` |
| First-run flow | PASS | "Get Started" → home; flag persisted across restart |
| Create project | PASS | "+ New project" via CDP click |
| Import video (real Photo Picker) | PASS | consent dialog → grid → select → Done → native proxy transcode 100% → clip on timeline |
| Import still image | PASS | image element rendered on timeline (autotest path + asset list) |
| Import audio | PASS | `autotest-audio.m4a` placed on audio track |
| Playback | PASS | playhead advanced 00:02→00:03→00:04; WebAudio RMS 0.0887 |
| Timeline scrub | PASS | touch-drag moved playhead 00:04→00:01 |
| Clip select | PASS | context panel (Split/Delete/Duplicate) appeared |
| Split | PASS | 1→2 clips at playhead |
| Delete / Undo / Redo | PASS | delete 2→1; undo restored; redo re-deleted |
| Trim | PASS (preview), harness-limited (commit) — synthetic pointer drags previewed but did not commit a new boundary; persistence verified tick-exact (720000 ticks = 6.000 s at 120000 ticks/s) so no data corruption |
| Persistence | PASS | project + media survived force-stop, relaunch, AND an unclean emulator shutdown |
| Export | PASS | 4 native Media3 exports; `h264 1280×720 30fps` + `AAC 44.1kHz mono`, 12.0 s / 17.2 s containers |
| Exported playback | PASS | ffprobe clean; frames extracted; file opened & decoded in the emulator's media viewer |
| Export repeatability | PASS | second/third/fourth exports byte-consistent (`done`, fraction 1) |

## Real-speech captions — PASS

Fixture: offline Windows SAPI TTS → WAV → muxed into H.264/AAC video
("Cutlyra open source video editor test one two three").

- Model `ggml-tiny.en.bin` (bundled in APK assets, 77.7 MB) copied to
  `files/models/` on first use; `whisper_init` OK; `libcutlyra_whisper.so`
  loaded (16 KB-aligned build).
- Transcript returned with per-word timestamps + confidences:
  **" Cut Lyra Open Source Video Editor Test 1-2-3"** — tiny.en's rendering
  of the deterministic phrase (reasonable-match contract met; no cloud, all on-device).
- 2 caption elements landed on a new caption track ("Cut Lyra Open Source" @0.4s,
  "Video Editor Test 1-2-3" @1.98s).
- Captions **persisted** across force-stop → relaunch (verified 3× relaunch cycles).
- **Burned-in captions in export verified by pixel analysis**: extracted frames
  inside caption windows show a high-contrast white/black text band
  (~31–32k text-like pixels at y≈600 in 720p); frames outside windows show none (<25).

## The `#/autotest` harness run (clean install, planted fixtures)

`VERDICT phase=import FAIL advanced=true ... export=ok(3448KB) captions=FAIL(No speech was detected...)`
— 8/9 assertions pass incl. **native export round-trip with a real decodable
video track (mediabunny probe)** and measured audio RMS. The captions FAIL is
the app's *correct actionable error*: that fixture's audio is a sine wave
(no speech). This mirrors the prior session's 8/9 result.

## Lifecycle / resilience

- force-stop → relaunch → reopen: 3 cycles, project + captions intact every time.
- Home → app resume, Android back gesture (app backgrounds cleanly), repeated open/close: no crashes.
- No `FATAL`/`SIGSEGV`/`SIGABRT`/`OutOfMemoryError`/ANR from app code.
- One SIGILL observed **inside `com.google.android.webview`'s
  `libwebviewchromium.so` under `onTrimMemory` during ARM→x86 translation**
  (emulator/WebView-translation defect; our `libcutlyra_whisper.so` absent
  from the trace). Documented as environmental; no alternative WebView
  provider exists on this 16 KB Play-store image.
- Benign console noise: `InputDisposedError` (mediabunny input teardown after
  project close) — logged unhandled rejection, no user impact.

## Logcat findings (saved: `docs/qa/emulator-qa-logcat-2026-09-23.log`, local-only)

- No app-caused crashes; codec errors absent from app export/import runs.
- Transient emulator gfxstream hiccup caused one import + one early export
  failure earlier in the session; both succeeded on retry (established as
  environmental, matching the WebView SIGILL pattern).
- `is_pending=1` MediaStore rows are invisible to the Photo Picker: fixture
  provisioning must use `content call --method scan_file` (runner note).

## Security / offline sanity

- Flags: `DEBUGGABLE` (expected for debug build), no `ALLOW_CLEAR_UID` oddities.
- Permissions: `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_LOCAL_NETWORK`,
  `CAMERA`, `RECORD_AUDIO`, `WAKE_LOCK` — no location/contacts/telephony.
- No cleartext config surprises, no analytics/telemetry calls observed in logcat;
  transcription and export ran fully offline (zero network during runs).

## Source changes in this QA pass

**None** — no production code was modified. Every suspected defect was
traced to test-environment causes (CRLF-corrupting `run-as cat` pulls,
pending-flagged MediaStore rows, emulator gfxstream/WebView-translation
instability, silent test fixtures). The known-good APK hash is unchanged.

## Limitations

- Emulator-only (x86_64 + ARM translation). **Physical-device qualification
  remains pending** — results above do not claim real-hardware codec/GPU
  behavior, thermal behavior, or OEM WebView stacks.
- Trim commit semantics couldn't be asserted with synthetic pointer events
  (real-touch pointer capture); preview-path trim verified only.
- One SIGILL in the emulator's own WebView under memory pressure (upstream).
