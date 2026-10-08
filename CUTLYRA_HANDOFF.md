# CUTLYRA_HANDOFF.md — session handoff (2026-09-22, ~10:50 IST)

Written after the Verdent-recovery session that produced the first real
`dist/Cutlyra-v0.1.0-debug.apk`. Read this before doing anything: it is the
resume point so no future session repeats the forensic work.

## Repository / Git state

- Outer repo root: `C:\Users\Pavithran R A\Downloads\cutlyra` (a stray `$null`
  file lives there — pre-existing, gitignored, harmless).
- Project root: `kneecap-main/` inside it (the ZIP-extracted tree).
- Git history now EXISTS (created after the QA milestone):
  - `04c9adc` `chore: import upstream Cutlyra baseline` — 1520 files, the
    untouched staged ZIP index (verified: zero "cutlyra" matches, original
    `dev.kneecap.app` / `@kneecap/mobile` branding intact in the commit).
  - `193d4e6` `feat: establish Cutlyra Android v0.1.0 QA milestone` — 164
    files (rebrand, native linker fix, first-run headline, SECURITY.md,
    handoff doc); old→new Java/Kotlin trees detected as 99%-similar renames.
  - Branch `master`, repo-local identity only (no global git config set).
  - Worktree is CLEAN; excluded via root `.gitignore`: `dist/` (APK stays
    local per policy), `local.properties`, `.cxx/`, debug probes, `local tool metadata/`.
  re-extract, never nest another repo).
- Branch: `master`. **HEAD: none — the repo has ZERO commits.** Everything is
  staged once as the original Cutlyra ZIP baseline; all work since (Verdent's
  rebrand + this session's fixes) is UNSTAGED working-tree deltas on top.
  => `git diff` = every change since the ZIP. `git status --porcelain` ≈ 1535
  lines (A/AM/AD/?? mixes). Do NOT reset/checkout/clean — the only copy of
  the rebrand work is the working tree + index.
- Nothing has been committed, per task policy (user decides when).

## What Verdent had completed (verified, not assumed)

- Rebrand `dev.kneecap.app` → `app.cutlyra.editor` across Gradle, manifest,
  strings, Capacitor config, Kotlin/Java sources (moved trees), CI workflows
  (Bun 1.2.18 → 1.3.14; NDK 27.2.12479018 + CMake 3.22.1 pinned in both
  mobile-ci.yml and release.yml), signing env names Cutlyra_* → CUTLYRA_*,
  colors → cutlyra* tokens with new purple accent #7C5CFF.
- Native whisper build had been driven to the LINK step and failed on
  Windows; `manual3.log` (its experiment, EXIT=0) + `test.so/test2.so` probes
  were left in `.cxx/`. It died mid-debug of that linker failure.
- Lint baseline re-measured 108 → 131 in `scripts/invariants.sh` (repo
  policy: update number AND reason; plugin drift, repo contributed zero).

## What this session fixed / completed

1. **Windows static-libc++ linker failure** (the exact point Verdent died):
   root cause = NDK toolchain's `-no-canonical-prefixes` + 8.3 short paths
   (PAVITH~1/WINDOW~1) makes the clang++ driver silently drop `-lc++`
   (bisected flag-by-flag; repro saved to the session log). Fix in
   `apps/mobile/android/app/src/main/cpp/CMakeLists.txt`: `-nostdlib++` +
   explicit full-path static archives (libc++_static.a, libc++abi.a,
   libunwind.a from the toolchain dir resolved from CMAKE_CXX_COMPILER,
   major-only clang/18 fallback) + `-Wl,-Bdynamic` restore.
2. **First-run screen still said "Cutlyra"** → fixed to "Cutlyra"
   (`res/layout/activity_first_run.xml`).
3. **16 KB page-size crash (real device class: 16 KB-page Android 15+ devices, verified on an Android 17/API 37 emulator)**: dlopen of
   libcutlyra_whisper.so hard-crashed with SIGILL/UnsatisfiedLinkError
   ("program alignment (4096) cannot be smaller than system page size
   (16384)") — observed live on the API 37 emulator during the autotest.
   Fix: `-Wl,-z,max-page-size=16384` (all LOAD segments now 0x4000-aligned,
   verified with llvm-readelf; no-op on 4 KB devices).
4. `local.properties` created (gitignored): `sdk.dir=C:/Users/Pavithran R A/AppData/Local/Android/Sdk`
   (forward slashes REQUIRED; backslashes break Java properties parsing —
   first build failed on exactly that).
5. Rebuilt web bundle (`bun run build` in apps/mobile — sources were newer
   than Verdent's Sep 14 sync) + `cap sync android`.
6. JDK: no system java — use `JAVA_HOME=/c/Program Files/Android/Android Studio/jbr`
   (JBR 21, works with Gradle 8.14.3 / AGP 8.13.0).

## APK (the deliverable)

- Path: `kneecap-main/dist/kneecap-v0.1.0-debug.apk`
- Size: 120,586,116 bytes (115 MB)
- SHA-256: fc9a32d5aaad46564e32bdea69ad4775af62a3b6b6d7d304adf6b7418fcf0ca0
  (`SHA256SUMS.txt` present and `sha256sum -c` OK)
- package `app.cutlyra.editor`, versionName 0.1.0, versionCode 1,
  minSdk 29, targetSdk 36 (compileSdk 36), native-code arm64-v8a,
  label "Cutlyra", Android-Studio debug-cert signed (apksigner verify OK,
  SHA-256 cert c76bac68…bc9953), real classes.dex + libcutlyra_whisper.so
  (4.9 MB stripped) + Capacitor web assets.

## Emulator validation (AVD Pixel_10, API 37 x86_64 with arm64 translation)

- Install: Success. Launch chain verified: FirstRunActivity → "Get Started"
  tap → MainActivity → Capacitor WebView loads, no JS console errors of ours
  (one benign upstream Capacitor SystemBars safe-area CSS warning at boot).
- Home screen shows "Cutlyra / + New project / Project 1 / date" and the
  project SURVIVED force-stop + reinstall (IndexedDB persistence OK).
- Back-press exits cleanly from home; a WebView SIGILL crash observed under
  back-press inside the EDITOR was traced to
  `com.google.android.webview` libwebviewchromium.so under ARM→x86
  translation (WebView 153.0.8010.36 on the emulator), NOT our code —
  flagged, not fixed (upstream).
- `#/autotest` headless harness (real app, real bridge, real Media3):
  planted fixtures into `/data/user/0/app.cutlyra.editor/no_backup/Media/`
  via `run-as`, removed autotest.flag afterwards. Final VERDICT:
  `advanced=true sinks=1 decodedFrames=1 fonts=ok audio=ok(web)
  timeline=ok select=ok(sel=1 delete 2->1) export=ok(683KB) sound=ok(rms=0.0891)`
  = **8/9 PASS including a real native export round-trip**.
  Only `captions=FAIL("No speech was detected…")` — CORRECT app behavior:
  the planted fixture (sine wave) genuinely has no speech; the app returned
  an explicit actionable error instead of fake output. Autotest source needs
  a `testsrc2`-only mp4 with a spoken-audio fixture to fully pass; the
  `Unable to open asset URL … autotest-audio.m4a` noise seen mid-run was the
  runner not having planted audio yet (harness provisioning, since resolved).

## Test suites

- Root `bun test packages apps/web/src apps/mobile/src`:
  **488 pass / 3 fail** — the 3 fails are the DOCUMENTED pre-existing mask
  failures (mask snapping ×2, custom mask point insertion), zero new
  failures. (Verdent's "513" count vs 488 today = count-difference across
  runs/environments, not lost work: all test files present, old
  dev.kneecap.app Java tests replaced 1:1 by app.cutlyra.editor copies.)
- Lint: baseline updated to 131 by Verdent per repo policy (untouched here).

## Exact last successful command

`sha256sum -c SHA256SUMS.txt` in `kneecap-main/dist` → "kneecap-v0.1.0-debug.apk: OK"

## Exact last failing command (resolved)

`./gradlew assembleDebug` (pre-fix: libc++ link failure / then 16 KB
alignment crash at runtime) — both fixed as above; final assembleDebug:
BUILD SUCCESSFUL.

## Next recommended actions (in order)

1. Physical-device smoke test (no hardware attached yet): enable Developer
   options + USB debugging, `adb install -r dist/Cutlyra-v0.1.0-debug.apk`,
   tap through home → editor → export.
3. Give `#/autotest` a speech-bearing audio fixture (whisper tiny model +
   spoken wav) to turn the last autotest assertion green on-device.
4. Optional: investigate the WebView-153 back-press SIGILL under ARM
   translation (emulator-only, upstream); and re-verify on a 4 KB-page
   device that the 16 KB-aligned .so loads fine (it must — alignment is a
   minimum, not a requirement).
5. Release path when ready: docs/RELEASING.md keystore secrets →
   `assembleRelease` / release.yml (already Cutlyra-renamed).

## Environment quick-reference

- Bun 1.3.14 on PATH; JDK only at Android Studio JBR; SDK at
  `%LOCALAPPDATA%\Android\Sdk` (NDK 27.2.12479018, CMake 3.22.1,
  build-tools 36.1.0, platforms android-36/36.1); emulator AVD `Pixel_10`
  (API 37, x86_64 + arm64 translation). Disk: ~17 GB free C: — do NOT
  start large downloads without checking `df -h /c`.
- adb from Git Bash: prefix device paths with `//` (e.g. `//data/local/tmp/x`)
  or MSYS mangles them into `C:/Program Files/Git/data/...`.
- aapt2/apksigner with spaces-in-path: call via a .cmd batch with 8.3 paths
  (`PAVITH~1`), apksigner needs JAVA_HOME set.

---

# UPDATE 2026-09-23 — full autonomous emulator QA (post-physical-handoff run)

**Status: EMULATOR_QA_COMPLETE (emulator surface exhausted; physical device still pending).**
Full details in `docs/EMULATOR-QA.md` (new). No production source changed; APK hash unchanged
(`fc9a32d5…fcf0ca0`). Latest HEAD still `143cf0d` at QA start; docs committed after.

## What this run proved

1. **The "audio-only export" scare was a MEASUREMENT ARTIFACT** — `run-as cat`
   over the adb text channel corrupts binary (CRLF inflation 666141→666610).
   `adb exec-out` byte-exact pulls show every export is **h264 1280×720@30 +
   AAC 44.1kHz mono** (12.0s / 17.2s). Four exports total, all `done`,
   repeatable, ffprobe-clean, frames extracted, decode exercised in Google Photos.
2. **REAL-SPEECH CAPTIONS PASS end-to-end on-device** (was the one open item):
   offline SAPI-TTS fixture "Cutlyra open source video editor test one two
   three" → bundled `ggml-tiny.en.bin` → libcutlyra_whisper (16 KB-aligned) →
   transcript " Cut Lyra Open Source Video Editor Test 1-2-3" with per-word
   tokens/timestamps → 2 caption elements on a caption track → **persisted
   across 3× force-stop/relaunch** → **burned into the export** (pixel-band
   analysis: text band present only inside caption windows, ~31k text px @720p,
   absent outside). No speech in a fixture correctly yields the actionable
   "No speech was detected…" error (unmasked autotest assertion).
3. **UI-driven P0 chain fully automated via CDP + UI Automator**: real system
   Photo Picker (consent dialog → grid → select → Done), native proxy
   transcode 100%, playback advance, scrub, select/split/delete/undo/redo,
   persistence across unclean emulator shutdown, export sheet flow.
4. `#/autotest` re-run on a CLEAN install (correctly planted fixtures):
   `advanced=true … export=ok(3448KB)` — export round-trip + 8/9 (captions
   FAIL = correct actionable error on the silent fixture).
5. Lifecycle stress: 3× force-stop→relaunch→reopen (project+captions intact),
   HOME/back gesture, repeated import/export — no app crashes. One SIGILL in
   `com.google.android.webview`'s libwebviewchromium.so under ARM→x86
   translation (`onTrimMemory` path) — **upstream emulator/WebView defect**,
   our .so not in the trace; no alternative WebView provider on this image.
   Benign console noise: mediabunny `InputDisposedError` after project close.
6. Security sanity: DEBUGGABLE debug build; perms INTERNET/NETWORK_STATE/
   ACCESS_LOCAL_NETWORK/CAMERA/RECORD_AUDIO/WAKE_LOCK only; zero network
   during transcription/export (local-first confirmed).

## Runner gotchas (learned the hard way — reuse these)

- Binary pulls: **`adb exec-out run-as … cat file > local`**; never plain `shell`.
- Photo Picker can't see `is_pending=1` rows: `content call --method scan_file`
  after pushing fixtures; grid items are identified by content-desc timestamps.
- CDP port: Local WebView2 tooling uses port 9333 — use **tcp:9335**.
- `#/autotest` trigger needs `no_backup/autotest.flag` to EXIST with content
  (an empty/deleted flag file = normal app launch).
- cd `~/cutlyra-qa` holds cdp.py + fixtures (videoA/B, image, audio, speech);
  regenerable via make_speech.ps1 (SAPI) + ffmpeg testsrc2/sine.

## Next actions

1. **Physical-device qualification** (only remaining gap) — phases 3–5 of the
   physical handoff: install, P0 workflow, real-speech captions, logcat.
2. Optional hardening: surface unhandled `InputDisposedError` as a benign log;
   consider gating trims behind real-pointer-capture e2e coverage on device.

## Stage 8 — v0.1.0 release-candidate engineering (2026-09-23)

HEAD at stage start: 53dcac3 (QA golden APK SHA-256
fc9a32d5…fcf0ca0 — **preserved, never rebuilt**). Results:

- **Android platform facts corrected** (Phase 1): the emulator genuinely
  runs **Android 17 / API 37** (release=17, sdk=37, codename REL,
  fingerprint `...emu64xa16k:17/CP21.260330.012/15545953`, PAGE_SIZE=16384).
  Earlier "Android 16, API 37" doc wording was internally inconsistent
  (API 36 = Android 16, which is the app's **targetSdk**); docs now
  distinguish app targetSdk 36 from the emulator's API 37 image.
- **Disk safety**: 7.6 GB free (99% used). Nothing deleted: Temp holds
  other projects' files, AVD/userdata/snapshots are the QA env, Gradle
  caches are required for builds. AVD userdata 8.4 G, snapshots 4.1 G,
  .gradle/caches 2.7 G — watch disk before any large download.
- **Release-readiness fixes (production source changed — 2 hardening
  edits, both evidence-backed)**:
  1. AndroidManifest: removed the exported BROWSABLE
     `cutlyra-spike://` intent-filter (let any app/web page open the
     hidden diagnostics harness; MainActivity's onNewIntent handler kept
     for explicit-component internal QA intents). Verified on emulator:
     `cmd package query-activities -a VIEW -d cutlyra-spike://open` now
     returns "No activities found"; app still cold-launches.
  2. AndroidManifest: `allowBackup` true → **false** (auto-backup would
     upload project data/media to the user's Google cloud backup,
     contradicting the local-first "media never leaves the device"
     promise).
- **Licensing**: THIRD_PARTY_NOTICES.md inventory regenerated for the
  current bun.lock (was stale at 2026-08-17/1074 pkgs; now 1152 pkgs,
  0 unresolved). Generator bug fixed: OWN_WORKSPACE_PACKAGES still
  listed pre-rename names so @cutlyra/* workspaces + fsevents were
  reported "genuinely unresolved"; @cutlyra/* added, fsevents classified
  as a macOS-only platform binary family.
- **CI**: last bun-version straggler fixed — bun-ci.yml pinned 1.2.18
  while lockfile/workflows use 1.3.14; all five setup-bun steps now 1.3.14.
- **Release build exercised without credentials** (as designed):
  `./gradlew assembleRelease --offline` → BUILD SUCCESSFUL →
  `app-release-unsigned.apk` (109,424,260 B, SHA-256 d15a745c…d64e0d),
  not debuggable, minSdk 29 / targetSdk 36 / v0.1.0(1) / arm64-v8a,
  `zipalign -P 16 -c 4` PASS, all `libcutlyra_whisper.so` LOAD segments
  0x4000-aligned (stripped release lib verified). NOT installable
  as-is (unsigned) — correct and expected without signing credentials.
- **RC debug build**: assembleDebug rebuilt after the manifest fixes →
  app-debug.apk SHA-256 bc0fa424…c1321 (differs from the golden QA APK
  exactly because of the two manifest hardening edits), installed on the
  emulator, cold launch + persisted project + editor verified, Android
  JVM unit tests PASS (`testDebugUnitTest`).
- **Docs**: CHANGELOG.md created (honest claims; physical-device
  qualification explicitly NOT claimed); README screenshots section
  filled with real emulator captures (docs/screenshots/, from the QA
  build); RELEASING.md stale env-var name fixed (Cutlyra_RELEASE_KEY_*
  → CUTLYRA_RELEASE_KEY_*); docs/DEVELOPER-VERIFICATION.md added
  (informational: package-name/cert ownership, direct-download vs Play).
- **Validation**: `bash scripts/invariants.sh` GREEN (513 pass / 3
  documented pre-existing mask failures; lint 131 within baseline;
  offline audit clean incl. built bundle; all gates pass).
- **Deliberately NOT done**: no v0.1.0 or rc tag, no GitHub release, no
  Play submission, no signing key generated, no AAB. Physical-device
  qualification remains the primary outstanding blocker.

## Next actions (Stage 8 → release)

1. Physical-device qualification (unchanged, still the only P0 gap).
2. Human one-time keystore creation per docs/RELEASING.md §1 (never in
   an agent session), then repo secrets; tag v0.1.0 → release.yml ships
   the signed APK + SHA256SUMS.txt automatically.
3. ~~Optional before tagging: decide on the ~15 MB throwaway spike media
   in APK assets~~ DONE in Stage 9 (see below) — release APKs no longer
   ship the spike payload (109,424,260 -> 94,211,012 bytes, -15,213,248 B
   ~ -13.9%); debug builds keep it.

---

# Stage 9 — release payload slimming & final pre-phone RC packaging (2026-09-23)

HEAD at stage start: `36965ac5` (Stage 8's RELEASE_CANDIDATE_SOURCE_READY
tree, worktree clean). Golden QA APK
`dist/Cutlyra-v0.1.0-debug.apk` (SHA-256 `fc9a32d5...fcf0ca0`) verified
before/after — never rebuilt, still untouched.

## The payload (exact, from the Stage 8 release APK)

| APK entry | compressed B | source |
|---|---|---|
| `assets/public/spike-assets/full.mp4` | 11,332,094 | `apps/mobile/public/spike-assets/full.mp4` (tracked) -> vite publicDir -> www/ -> cap sync |
| `assets/public/spike-assets/proxy.mp4` | 3,800,479 | `apps/mobile/public/spike-assets/proxy.mp4` (tracked), same path |
| `assets/spike/clip-a.mp4` | 35,323 | `android/.../src/main/assets/spike/clip-a.mp4` (tracked) |
| `assets/spike/clip-b.mp4` | 34,988 | `android/.../src/main/assets/spike/clip-b.mp4` (tracked) |
| `assets/public/assets/spike-B1HJ4HZO.js` | 7,581 | vite entry `spike.html` (`src/spike/`) |
| `assets/public/spike.html` | 820 | `apps/mobile/spike.html` |
| `assets/public/assets/spike-CTXDbd1l.css` | 988 | vite entry `spike.html` |
| **Total** | **15,212,273 B** | zero production references (verified repo-wide) |

Reachability proof: `src/spike/` is bundled ONLY by the `spike.html` vite
entry, which is referenced ONLY by the `cutlyra-spike://` deep link
removed in Stage 8 (plus explicit internal intents, Stage 8's documented
exception). `src/autotest.tsx` references nothing spike; `legacy-harness.ts`
and editor-core tests use "clip-a/clip-b" as plain string IDs, not these
files. Both clips' only runtime consumer is `SpikeDiagnosticsPlugin.java`
(`asset:///spike/...`), itself throwaway and internal-intent-only.

## The fix (packaging-only; zero product-code changes)

1. `git mv android/.../src/main/assets/spike/` ->
   `android/.../src/debug/assets/spike/` (variant source set — release
   merges never see the clips at the source level).
2. `apps/mobile/android/app/build.gradle`: a `pruneSpikeAssetsForRelease`
   Gradle task deletes the spike web payload from the gitignored `cap sync`
   output copy (`src/main/assets/public/`) and is wired as a dependency of
   `mergeReleaseAssets` (release variants only). Debug builds keep
   everything; the canonical debug flow regenerates the payload via
   `bun run build && cap sync`.

Deliberate dead ends, documented so nobody re-walks them: AGP 8.13's
variant `Packaging` DSL has NO assets exclude (only jniLibs/resources —
verified against gradle-api-8.13.0); pruning the merge/compress
INTERMEDIATES is unsalvageable because AGP's compress task both silently
keeps stale `<path>.jar` outputs for vanished inputs AND hard-fails on
later incremental builds when its recorded output was deleted (both
reproduced in this session). Pruning the merge INPUT is immune to both.

## Measured results (all locally verified)

- Release: 109,424,260 -> **94,211,012 bytes** (-15,213,248 B ~ -14.5 MiB,
  -13.90%), `app-release-unsigned.apk` SHA-256
  `7042134f...aeed8`, 0 spike entries, byte-identical between the offline
  gradle build and the canonical `scripts/build-android-release.sh` flow —
  CI equivalence proven.
- Debug: canonical flow rebuild (`scripts/build-android-debug.sh`) keeps
  all 7 spike entries (new SHA-256 `e7bbbc84...1eaaf` — differs from
  Stage 8's RC debug only because www/ was rebuilt; a gradle-only rebuild
  after Stage 8's was bit-identical `bc0fa424...c1321`, proving the
  source-set move changed nothing). Golden APK untouched.
- Content audit (new release APK, 493 entries): whisper model
  70.5/77.7 MB (compressed/uncompressed), dex 13.2 MB, native lib 2.6 MB
  (`libcutlyra_whisper.so` only), web bundle 12.3 MB, res+arsc 0.7 MB;
  top file after the model is `classes.dex` (7.97 MB). Nothing accidental
  beyond the already-removed payload; debug-leak scan clean (no .map, no
  dev-server URLs, no test entrypoints; the only spike strings are dead
  code in SpikeDiagnosticsPlugin/MainActivity per Stage 8's documented
  decision, and the only "localhost" string is Capacitor's standard CSP).
- Android metadata re-verified via aapt2: app.cutlyra.editor / 0.1.0(1) /
  minSdk 29 / targetSdk 36 / arm64-v8a / unsigned (apksigner: DOES NOT
  VERIFY, missing META-INF — correct without credentials).
- Manifest: allowBackup=false, debuggable absent, launchable
  FirstRunActivity only, exported receiver = androidx ProfileInstallReceiver
  (DUMP-protected), zero custom-scheme intent filters (spike deep link
  stays gone).
- 16 KB: libcutlyra_whisper.so LOAD segments 0x4000/0x4000/0x4000
  (llvm-readelf); `zipalign -P 16 -c 4` PASS.
- Regression: `bash scripts/invariants.sh` GREEN exactly once (513 pass /
  3 documented pre-existing mask failures; lint within documented
  baseline; offline audit clean — 7 documented known-gap warnings).
  Focused emulator smoke on a fresh Android 17/API 37 boot: install ->
  force-stop -> cold launch (FirstRunActivity, no crash) -> Get Started ->
  MainActivity -> persisted project reopened straight into the editor
  (timeline clips, toolbar, playhead) with zero fatal/JS logcat errors;
  `#/autotest` flag absent (harness stays off) — full emulator QA
  campaign intentionally NOT repeated.

## Next actions (Stage 9 -> release)

1. Physical-device qualification (still the only P0 gap; unchanged).
2. Human one-time keystore creation per docs/RELEASING.md §1 (never in
   an agent session), then repo secrets; tag v0.1.0 -> release.yml ships
   the signed APK + SHA256SUMS.txt automatically (now without the spike
   payload, reproducibly).

# Stage 10 — signed release rehearsal & final pre-phone freeze (2026-09-24)

## What was proven (all with a disposable key — production identity NOT created)

- Signing contract re-verified from source: build.gradle's four
  `CUTLYRA_RELEASE_*` env vars, `hasReleaseSigning` guard (unset/missing
  keystore -> unsigned `app-release-unsigned.apk`, never a debug-sign
  fallback), zero hardcoded passwords in any .gradle, zero keystore-like
  files tracked or in git history; release.yml hard-fails without
  `ANDROID_KEYSTORE_BASE64`.
- Rehearsal keystore: keytool RSA-4096/PKCS12, alias `cutlyra-rc-rehearsal`,
  random temp passwords, generated in the OS temp dir (outside git),
  DN "CN=Cutlyra RC Rehearsal (TEST SIGNING ONLY)". SHA-256 fingerprint
  `2D:62:21:56...C3:78:7A` recorded as evidence only — NOT a production
  identity; keystore + password file deleted after use (Phase 10).
- `assembleRelease` via the canonical `build-android-release.sh` with the
  four env vars: BUILD SUCCESSFUL, `app-release.apk` 94,219,204 B,
  SHA-256 `53cf5f1b...61c657e3`. `apksigner verify`: v2 scheme true,
  signer DN/fingerprint = rehearsal cert (not the Android debug cert).
  zipalign -P 16 -c 4 PASS; minSdk 29 / targetSdk 36 / arm64-v8a;
  allowBackup=false, no debuggable attr; 0 spike entries; ELF LOAD align
  0x4000. Per-entry CRC parity vs the unsigned slimmed RC: identical set
  of 494 entries (payload unchanged; the +8,192 B size delta is exactly
  the v2 signing block).
- AAB: `bundleRelease` with the same env -> BUILD SUCCESSFUL, valid
  bundle structure (BundleConfig.pb, base/manifest, dex, whisper model,
  native lib), 0 spike entries, rehearsal cert on the jar signature;
  85,321,802 B, SHA-256 `d35590b1...b9ea1c2` (recorded, then deleted as
  regenerable). No Play publish, no bundletool download.
- CI parity rehearsal (Phase 8): local bun 1.3.14 / JDK 21.0.10 / NDK
  27.2.12479018 / cmake 3.22.1 / platform 36 match release.yml pins;
  base64 keystore decode path byte-identical round-trip; invariants gate
  GREEN at this exact HEAD (Stage 9, zero source changes since);
  artifact naming + SHA256SUMS.txt simulated in dist/rehearsal/. No tag,
  no secrets, no remote state touched.
- Release-mode emulator run (Phase 6+7 combined, data-preserving): the
  release APK (debug-cert-signed copy explicitly labeled
  `release-mode-debug-cert-test-only`, still non-debuggable + spike-free)
  was installed IN PLACE over the QA debug install (same cert ->
  `pm install -r`, no uninstall, no `pm clear`). Verified in release
  mode: cold launch -> home with persisted Autotest project -> project
  opens in the editor -> Media3 export runs to "Export complete" ->
  playback playhead advances 00:00 -> 00:12; zero fatal logcat lines.
  Golden debug APK then reinstalled in-place (DEBUGGABLE flags back,
  app data + QA state intact, Play Store re-enabled after being
  temporarily disabled to calm an environment-induced ANR storm).
  Known environment noise (not app defects): emulator host disk at 99%
  caused SystemUI/system_server ANRs and one emulator crash mid-run;
  release WebView logging is silent by design (non-debuggable).
- Evidence retained (gitignored): `dist/rehearsal/` with
  `Cutlyra-v0.1.0-release-REHEARSAL-NOT-FOR-DISTRIBUTION.apk` +
  `SHA256SUMS.txt` (`sha256sum -c` OK). No
  `Cutlyra-v0.1.0.apk` was created (that name belongs to the future
  real release).

## Docs

- docs/RELEASING.md: §3 gained the Stage 10 update paragraph; new §4 is
  the final human procedure (physical QA -> permanent key -> backup ->
  4 secrets -> optional local signed build -> tag v0.1.0 -> workflow ->
  verify checksum + `apksigner verify --print-certs` / `keytool -list
  -v` fingerprint), with the never-lose-the-key warning.

## Next actions (Stage 10 -> physical QA)

1. Physical-device qualification (the ONLY remaining pre-release gap).
2. Then RELEASING.md §4: permanent key, secrets, tag v0.1.0.
3. Freeze: no more autonomous product work before physical QA
   (`AUTONOMOUS_PRE_RELEASE_FREEZE`).

# Stage 11 — physical-device QA on iQOO I2221 + the regression fixes it produced (2026-09-24/25)

Physical QA DID happen (the Stage 10 freeze ended when the founder's iQOO
I2221, Android 16, arm64, was attached). It caught real defects the
emulator never showed, all fixed in commit `527e126`:

1. **Audio imports were impossible**: the photo picker (`ACTION_PICK_IMAGES`)
   cannot custody audio. `MediaPickerIntents` now routes audio picks through
   SAF (`ACTION_OPEN_DOCUMENT`).
2. **`MediaProbe` retriever crashes** on some stills — guarded retrievers +
   still-image bounds (portrait/landscape/PNG dims verified on device).
3. **Assetless library clips aborted native export** (`requireAsset()`) —
   `EdlToComposition` now filters them from the audible mix instead.
4. **WebGPU presentation is broken on Android WebView** — preview renderer
   suppresses it in favor of the working WebGL2 path on Android.
5. **Live wasm-boundary crash caught on device**: `invalid type: unit value,
   expected i64` crossing into Rust during React render — PlaybackManager
   now self-heals non-finite tick writes (JVM+bun tests included).
6. **Export-sheet honesty disclosure**: bundled preview-only sounds (data:-URI
   library audio) are not in the exported file; the sheet now SAYS so.

## Post-fix session continuation (2026-09-26, after a local tooling restart)

- Working tree was clean at `527e126` EXCEPT one leftover defect in that
  commit's `export-sheet.tsx`: a mangled edit inside `startExport` (brace
  structure corrupted — `}					if (event.stage === "done") {`). It
  typechecked by luck but was one edit from breaking. Restored the block to
  the exact intended structure (error/done branches + `refreshLibraryAudioNote()`
  after the loop); the Stage 11 feature set is otherwise byte-equivalent.
- Re-verified: `tsc --noEmit` (mobile-ui) clean; `bun test packages/mobile-ui`
  87 pass / 0 fail; playback-manager Stage 11 tests 7 pass.
- Rebuilt web bundle (`vite build`), `cap sync`, `assembleDebug` BUILD
  SUCCESSFUL (app-debug.apk SHA-256 `18f7825b...70c80`, 115,664,677 B).
- Installed on the iQOO (`adb install -r`, same debug cert, app data kept —
  all QA projects intact). Cold launch OK; opened Project 10 from home;
  playback advanced 00:00 -> 00:04 (no wasm crash — the tick fix holds);
  export sheet opens; a deliberate export attempt on an audio-only project
  returns the correct actionable error "main track has no video/image clips".
- Session interrupted by the device locking (CDP socket stops serving while
  keyguard shows; app process and editor state stay alive). Environment
  noise only.
- CHANGELOG.md updated: [Unreleased] gained the Stage 11 Fixed section; the
  stale "physical-device qualification has not been performed" claim is
  replaced by the honest single-device qualification statement (one device;
  matrix/thermal still unqualified).

## Full-session deep qualification (2026-09-26, iQOO I2221, continued)

The complete 20-phase physical qualification was executed end-to-end on the
same iQOO I2221 (Android 16, SDK 36, arm64-v8a, WebView 154.0.8037.57).
Summary of what the deep pass added on top of the sections above:

- **Phase 3**: delete-cancel flow verified (native confirm dialog: CANCEL
  keeps the project, dialog closes); 5 rapid taps on "+ New project" create
  exactly ONE project (dedupe holds); home scroll, editor open, system back
  (app stays alive) all verified. Manifest has no orientation lock
  (configChanges only) — portrait is the default, not enforced.
- **Phase 4 (import matrix)**: real-device imports of MP4 (31s camera
  video), PNG screenshot (1080x2400), camera JPEG, M4A, MP3, and the bundled
  Soft Chime — all probed correctly (durations, hasAudio, codecs logged) and
  persisted across close/reopen. Stage 11 audio-pick (SAF DocumentsUI) and
  still-image probe retests: PASS on device.
- **Phases 5–8**: full editing surface exercised — select/split/delete/
  duplicate (creates an overlay copy)/cut-gaps UI/undo/redo chain
  (undo C -> undo B -> redo B -> new edit D clears redo), per-clip Speed
  slider (1.00x -> 1.91x), Volume slider (100 -> 255), text clips with
  Tamil + emoji + multiline Unicode accepted and persisted. "Mute clip
  audio" and "AI clipper" chips are intentionally inert parity chrome
  (code comment: features outside v1, not fake-wired) — documented, not a
  defect. Playback: play/pause/resume, seek paused + while playing,
  video->image boundary crossing, end-of-timeline auto-pause, replay-after-
  end all PASS with clean logcat; WebGPU->WebGL2 fallback fires as designed.
- **Phase 9 (export matrix) — two NEW product defects found and fixed**:
  1. `ConstantSpeedProvider.getNextSpeedChangeTimeUs()` returned
     `Long.MAX_VALUE`. Media3's `SpeedProviderMapper` treats anything except
     `C.TIME_UNSET` as a real speed change and asserts `next > inputUs`, so
     `Transformer.start()` threw `IllegalStateException` and EVERY export of
     ANY project containing a speed-changed clip aborted ("export failed to
     start"). Fixed to return `C.TIME_UNSET`; regression test added
     (`ConstantSpeedProviderTest`). Physical retest: the exact failing
     project now exports — 40.14s MP4, H.264+AAC, opens in the system
     player.
  2. `Media3Exporter` assigned its `activeTransformer` singleton BEFORE
     `transformer.start()`; a synchronous throw left the slot assigned
     forever, so all later exports failed with "an export is already in
     progress" until process death. Slots are now released on synchronous
     failure, and the generic catch logs the full stack and names the
     exception class (the old code surfaced only a null-message fallback
     string, which hid the root cause above).
- Export matrix results: image-only (3s JPEG) export COMPLETE, duration
  exact 3.00s, HEVC (hvc1) 671 KB, plays in Photos; multi-track project
  (video + text + MP3 + Soft Chime + M4A) exports COMPLETE with a mixed
  mp4a audio track (bundled library sound correctly omitted from the mix,
  preview-only disclosure rendered in the sheet — Stage 11 fix holds);
  intentionally invalid projects (sticker+text only; audio-only) return the
  correct actionable errors; a corrupt MP3 fixture fails with "Asset loader
  error" (hardware then software encoder retry both fire — failing on
  genuinely corrupt input is acceptable; message wording is a candidate
  improvement).
- **Phases 10–13**: force-stop + cold relaunch preserves all 13 projects
  (cold start ~0.5–0.7 s); background-during-playback returns with state
  intact; export of the 40.1s multi-track project finished in ~40 s wall
  clock with the UI responsive. Battery 80–83%, thermal status 0, ~33–36°C
  through the session.
- **Phase 17 (log audit)**: zero FATAL/ANR/SIGSEGV/SIGABRT/OutOfMemory/
  ActivityNotFound across the session. Notable lines classified: vendor
  (vivo) SELinux avc denials and Kotak/Drive/Ads noise = EXPECTED PLATFORM
  NOISE; "WebGPU canvas presentation broken on this WebView — using WebGL2
  renderer" = INTENTIONAL Stage 11 fallback (working as designed);
  "A resource failed to call close" x~10 during export teardown = minor
  hygiene note (no functional impact, candidate cleanup).
- Gates after fixes: Kotlin `testDebugUnitTest` (incl. new
  ConstantSpeedProviderTest) + `assembleDebug` BUILD SUCCESSFUL (APK
  SHA-256 `53a5bb09...d9950`, 115,755,128 B); editor-core + mobile-ui
  `tsc --noEmit` clean; `scripts/invariants.sh` GREEN (125 lint errors vs
  baseline 131). Updated debug APK installed in place (`adb install -r`,
  data preserved).
- **Phase 14 (font scale 1.3x)**: home and editor re-laid out cleanly at
  1.3x (no horizontal overflow, controls in viewport); device setting
  restored to 1.0 afterwards.
- **Phase 15 (offline)**: airplane mode ON (navigator.onLine=false):
  playback, seek, and a full multi-track EXPORT all completed with zero
  network; connectivity restored after. The editor pipeline is genuinely
  local.
- **Phase 16 (release mode on the iQOO, Stage 10 method)**:
  `assembleRelease` (slim payload, spike-free, non-debuggable) signed with
  the EXISTING Android debug keystore via the four `CUTLYRA_RELEASE_*` env
  vars — no new signing identity was created; the labelled copy
  `Cutlyra-PHYSICAL-QA-TEST-ONLY-NOT-FOR-DISTRIBUTION.apk` was installed
  IN PLACE over the debug install (same cert → `pm install -r`, data
  intact). Verified in release mode: cold launch 351 ms → home with all 13
  projects → Project 12 opens with every track → **multi-track export
  "Export complete" in ~20 s** (library-sound disclosure renders) →
  background/return clean → 0 fatal logcat lines. The golden debug APK was
  then reinstalled in place (cold start 653 ms, all 13 projects intact) and
  the labelled keystore copy / password file / test APK were deleted. No
  production identity exists.

## Next actions (Stage 11 -> release)

1. Human per RELEASING.md §4: permanent keystore, repo secrets, tag v0.1.0.
2. Recommended before GA: nothing blocking found in this pass; the release
   artifact chain (permanent key + real signed build) is the human step in
   RELEASING.md §4.
3. Optional: re-run real-speech captions once on the iQOO (pipeline
   unchanged; emulator-verified).
4. Optional: broader physical matrix (4 KB-page device, another OEM WebView).
5. Hygiene: Closeable teardown during export ("resource failed to call
   close") and the corrupt-input error wording.
# Stage 12 — final repository release hardening and merge (2026-10-04)

The Google Play preparation work is now merged and the repository-level gates
have been re-verified from GitHub, not inferred from the older local handoff.

## Repository state

- `main` release-prep merge checkpoint:
  `ec4037d37e472db2a94f2b359da812344632f223`.
- PR #1 ("Prepare Cutlyra for Google Play release") is merged.
- No open PRs or open issues were present at this checkpoint.
- No GitHub Release has been published yet; no production tag was created.

## What the release-hardening pass closed

1. GitHub Actions runner execution was re-tested. The original zero-step
   runner failures were transient/environmental; later runs executed normally.
2. Android CI's real `./gradlew: Permission denied` blocker was fixed by
   preserving the executable bit on `apps/mobile/android/gradlew`.
3. Bun/tooling pins were aligned on Bun 1.3.14.
4. The three inherited mask-test failures were fixed rather than grandfathered,
   and the unit-test gate is now strict at zero failures.
5. Release-facing OpenCut-era support/contribution copy was replaced with
   Cutlyra-specific guidance.
6. The Android direct-install guide was corrected so it no longer claims the
   app is permanently outside Google Play.
7. The Play-prep branch added the signed AAB workflow, minimized permissions
   and FileProvider exposure, in-app privacy UI, Play listing/Data Safety
   drafts, and the Play release runbook.

## GitHub verification on the merged source

- **Bun CI: SUCCESS** on `main` merge SHA `ec4037d...`:
  Ubuntu, Windows, and macOS invariant jobs all passed.
- **Mobile CI: SUCCESS** on the same SHA:
  Android debug/JVM/instrumentation-package build path passed and the unsigned
  iOS simulator build passed.
- The current source targets Android 16 / API 36, matching Google Play's
  post-2026-08-31 requirement for new phone/tablet apps and updates.

## Readiness classification

**SOURCE / ENGINEERING READY: 100%.** There is no known remaining code, CI,
release-workflow-definition, permission, documentation, or single-device QA
blocker for v0.1.0.

**NOT YET CONSUMER-LIVE.** The remaining gates require publisher-controlled or
Google-controlled state and must not be faked by an agent:

1. Play Console account/identity/contact/device verification as applicable.
2. A real public support/privacy contact and active public privacy-policy URL.
3. Required Google Play listing graphics from the final candidate: 512×512
   store icon, 1024×500 feature graphic, and compliant final screenshots.
4. Permanent upload key creation + secure backup + GitHub Actions secrets.
5. Final signed AAB generation from the release commit and Play App Signing.
6. Internal-test install/smoke of the Play-delivered artifact.
7. For a new personal developer account created after 2023-11-13: at least
   12 closed-test users continuously opted in for 14 days, then production
   access application.
8. Google production review/approval and publication.

Do not describe those external gates as complete until they are actually
observed in the publisher account.

# Stage 13 — GitHub + Play final hardening (2026-10-04)

This stage supersedes Stage 12's "SOURCE / ENGINEERING READY: 100%" statement.
A second-device POCO M4 Pro 5G campaign against authoritative `main`
(`44849e958bdcd3b08821fcb2bb37ad7e7356f985`) exposed release-guard defects
that had not been visible in host CI. Product release remains **NO-GO** until
this stage's corrected gates pass on the final merged candidate.

## POCO findings that triggered this stage

- The instrumentation APK finally executed on Android 13/MIUI 14: **8 tests
  ran, 5 failed**.
- Four failures were one harness defect: `R.raw.test_clip` is packaged in
  the instrumentation APK, but the tests opened that test-package resource id
  through the target app's `Resources`. The integer id collided with an
  unrelated ~388-byte target resource instead of the 32,663-byte MP4 fixture,
  cascading into probe/thumbnail/import/export failures.
- The fifth failure was a stale architecture assertion: the cross-fade fixture
  now correctly produces three sequences — base video, transition overlay,
  and the Stage-11-separated main-track audio sequence — not two.
- These are test/release-guard defects, not evidence that a real user export
  is broken. They still block release because the native export guard was not
  providing trustworthy regression signal.

## Hardening branch / PR

- Branch: `release/github-play-hardening`
- PR: #3, **Harden final GitHub and Play release gates**
- Base: `main@44849e958bdcd3b08821fcb2bb37ad7e7356f985`
- Do not merge until the latest PR-head CI is green, including the emulator
  instrumentation job.

## What this stage changes

1. **Instrumentation correctness**
   - test resources are opened through
     `InstrumentationRegistry.getInstrumentation().context`;
   - the composition-shape assertion now expects the intentional third audio
     sequence;
   - the stale Capacitor template instrumentation test is removed.
2. **Connected tests become a real CI gate**
   - Mobile CI runs the instrumentation suite on a pinned API-35 x86_64
     emulator runner instead of merely assembling the test APK.
3. **Offline captions are guaranteed in release artifacts**
   - whisper.cpp v1.9.2 is additionally pinned to immutable commit
     `306c88f4d1286aec1bf96e544632897886af5501`;
   - the tiny.en model is fetched at build time and its pinned SHA-256 is
     verified with a portable, fail-closed checker;
   - Android CI, GitHub release, and Play AAB workflows fetch the native/model
     inputs and assert that the model + arm64/x86_64 native libraries are
     physically present in the resulting artifacts.
4. **Release artifact fail-closed checks**
   - signed APK/AAB identity/container checks;
   - pinned model digest;
   - no internal spike payload;
   - native debug symbols;
   - 16 KB ZIP/ELF alignment checks for packaged native libraries.
5. **Signing separation**
   - direct GitHub APK uses `ANDROID_RELEASE_*` secrets;
   - Play upload uses distinct `PLAY_UPLOAD_*` secrets;
   - the Play app-signing-key strategy is decided separately so upload-key
     rotation never becomes the app identity.
6. **v0.1 release surface honesty**
   - unsupported filter/effect/reverse controls are not exposed;
   - only export-supported transition semantics are exposed;
   - nonfunctional caption language choices and future-only helper chips are
     removed from the Android v0.1 surface;
   - public feature/listing copy is aligned with what native export actually
     supports.
7. **Legal / Play preparation**
   - Cutlyra-specific terms replace inherited OpenCut terms;
   - standalone static privacy + terms pages live under `apps/web/public/`
     for dependency-free public hosting;
   - Play listing/runbook points at the standalone privacy policy.
8. **GitHub v0.1 distribution is Android-only**
   - iOS remains compile-checked but is not a physically qualified v0.1
     shipping target, so no unsigned iOS binary is published as if it were one.

## Remaining release gates

Engineering may be called ready only after ALL of these are observed:

1. latest PR #3 Bun CI green on Ubuntu, Windows, macOS;
2. latest PR #3 Mobile CI green, including Android JVM/build, iOS compile,
   and **executed** Android instrumentation with zero failures;
3. PR #3 merged without tree drift; post-merge main CI green;
4. Freebuff syncs/clones that exact merged main SHA and the POCO reruns:
   instrumentation, permissions, import corpus, editing/playback, real-speech
   captions, all export cases, offline/lifecycle/stress/logcat, and a
   release-mode physical workflow;
5. zero unresolved P0/P1 findings.

Only after those engineering gates: create/back up real signing/upload keys,
configure secrets, build final APK/AAB, run Play Internal testing/pre-launch
report, complete the applicable closed-test/production-access requirements,
and submit.

No permanent signing identity, release tag, GitHub Release, or Play submission
was created during this stage.

# Stage 14 — POCO physical qualification found video-only export blocker (2026-10-05)

Authoritative candidate tested:
`main@8003289d92c500df586eeea311e8192d86272424`.

Device:
POCO M4 Pro 5G (Android 13 / API 33, MIUI 14).

## What passed physically

- repository/source invariant at the exact merged SHA;
- Bun/unit/typecheck/Android JVM gates;
- corrected connected instrumentation: **7/7 PASS**;
- clean/upgrade install and persistence;
- SAF audio picker on MIUI when navigated through a visible provider root;
- real on-device English captions from a public-domain LibriVox sample;
- caption edit + persistence + model-cache repeat behavior;
- offline cold launch/playback/captions/export with zero required network calls;
- release APK non-debuggable, targetSdk 36, both supported ABIs, bundled tiny.en,
  bundled native whisper runtime, legal notices, 16 KB ZIP/ELF alignment;
- release-mode project -> media/audio -> captions -> multi-track export completed;
- no Cutlyra FATAL/ANR/native fatal/OOM in the final forensic sweep.

## Release blocker discovered

**P0: an ordinary video-only MP4 (no audio stream) crashes export composition.**

The dedicated audio-lane builder admitted main-track video assets even when
`EdlAsset.hasAudio == false`. The audio lane then called
`buildEditedMediaItem(... removeVideo=true)`, while that helper inferred
`removeAudio=true` from the missing audio stream. Media3 rejects an
`EditedMediaItem` that removes both tracks.

Physical isolation:
- H.264 video-only inputs: FAIL;
- H.264 + AAC input: PASS;
- stack pointed to `EdlToComposition.buildEditedMediaItem`.

This is a real product blocker because screen recordings/downloaded videos may
legitimately contain no audio.

## Fix branch / PR

- branch: `fix/poco-video-only-export`
- PR: #4, "Fix POCO video-only export blocker and close release QA gaps"

PR #4:
1. filters `hasAudio=false` assets out of dedicated audio sequences so their
   time range becomes silence;
2. adds a fail-closed guard against ever giving Media3 an item with both tracks
   removed;
3. adds an instrumentation regression that remuxes the existing MP4 fixture
   into a **real video-only MP4 at runtime** and proves end-to-end export;
4. guarantees non-blank native/UI export diagnostics;
5. rejects audio-only *video export* with explicit "add a video or image"
   guidance;
6. prunes hidden autotest/legacy-diagnostics chunks from release artifacts and
   extends release CI leak checks;
7. reports on-device STT capability truthfully now that release-mode Android
   captions were physically proven.

## Remaining qualification after PR #4

Do not permanently sign/tag/publish yet.

Required:
1. PR #4 Bun CI green;
2. PR #4 Mobile CI green, including the new video-only instrumentation test;
3. merge PR #4, then merged-main CI green;
4. sync Freebuff to that exact merged SHA;
5. rerun the POCO export matrix cases blocked/skipped by the P0, especially:
   image-only, portrait, landscape, speed, crossfade, keyframes/transforms,
   M4A, mixed-media, repeated exports, heavy/combined project;
6. explicitly re-run video-only MP4 physical export;
7. verify caption playback sync + caption visibility in a produced file;
8. verify release-mode result and forensic sweep;
9. require **0 P0 + 0 P1**.

Only then is permanent signing / GitHub v0.1.0 release / Play Internal Testing
eligible.

# Stage 15 — final POCO pass exposed audio-tail polish defect (2026-10-05)

Authoritative candidate physically qualified:
`main@97192a5678ecff08e9566bf17ade5f0a9e991583`.

The Stage 14 release-blocking video-only export defect is physically fixed.
The focused POCO rerun reported **P0=0 / P1=0**, 8/8 connected tests, successful
release-mode video-only export, real offline captions, release payload audit,
repeated-export stability, and clean Cutlyra logcat.

## Remaining user-visible defect found

**P2: audio can extend a video export into a black tail.**

Physical reproduction:
- visual main track: 8 s;
- external MP3: 15 s;
- export duration: ~15 s;
- blackdetect: black starts at 8 s and runs to ~15.03 s.

The exporter intentionally padded the base video sequence to
`edl.meta.durationTicks`, which includes audio-only clips, and also allowed
audio sequences to run to that same project end. That behavior preserved
text/caption tails but incorrectly let audio alone extend a VIDEO file.

## Fix branch

- branch: `fix/export-audio-black-tail`

The fix defines the video-export end as the last VISUAL item:
- main video/image end;
- overlay video/graphic end;
- text/caption overlay end.

Audio may be padded with silence up to that visual end but can no longer extend
the video beyond it. Audio clips that straddle the visual boundary are trimmed
to it; clips starting after the visual end are omitted from video export.

A real Media3 instrumentation regression reuses the 2 s MP4 fixture to create a
1 s visual timeline plus 2 s audio and requires the final MP4 to end at ~1 s
while retaining valid audio during that visible second.

## Final remaining physical proof after merge

Before permanent signing/tagging:
1. CI green including the new audio-tail regression;
2. merge and post-merge CI green;
3. POCO re-test:
   - 8 s video + 15 s MP3 must export to ~8 s with no black tail;
   - cross-fade export physically observed;
   - transform/keyframe export physically observed;
   - final release-mode combined export/logcat check;
4. require P0=0 / P1=0.

No permanent signing, tag, GitHub Release, or Play submission has happened yet.

# Stage 16 — POCO release-surface cross-fade fix (2026-10-06)

Authoritative candidate physically inspected:
`main@48e4a37f9f1b2da3ddfa107df0b867166d8ab719`.

The Stage 15 black-tail fix physically passed on the POCO, and the final
forensic sweep still showed P0=0 / P1=0. The remaining release blocker was a
**user-facing construction defect**: the release UI exposed Cross-fade, but
ordinary Add clip imports could not create two adjacent main-track clips.

## Physical root cause

The timeline's `+ Add clip` button is rendered after the main track's final
clip, but `importAndPlaceMedia()` inserted every picked asset at the current
playhead using generic auto placement:

`placement: { mode: "auto", trackType: "video" }`.

When the playhead overlapped the existing main clip, the generic placement
resolver correctly found no free span on main and created an overlay video
track. POCO UI dumps repeatedly showed:
- first picked video on the main row;
- second picked video on a separate overlay row;
- no supported release-UI action to promote/move that overlay clip onto main.

Because transition squares only exist between adjacent main-track clips,
Cross-fade was publicly visible but unreachable.

## Fix branch / PR

- branch: `fix/main-track-add-clip-crossfade`
- PR: #6, "Make Add clip append to the main track so transitions are reachable"

The fix:
1. recomputes the end of the magnetic main track for every Add clip import;
2. appends the imported element at that end;
3. uses explicit placement into the existing main track instead of generic
   auto placement;
4. recomputes after every item in a multi-select import so picker order becomes
   sequential main-track order;
5. leaves Overlay import semantics unchanged and isolated in
   `importAndPlaceOverlay()`;
6. adds a pure append-time helper and unit regression tests.

## Why this is the correct surface contract

The Add clip affordance is spatially located after the final main-track clip,
so append-to-main matches what the control communicates. Picture-in-picture
already has a separate Overlay action and should not be an accidental fallback
of ordinary clip import.

Android Media3 Composition still does not provide native cross-track
crossfading, so Cutlyra continues to use its existing custom compositor/export
implementation. This stage changes only how users construct the adjacent main
sequence required to reach that existing transition implementation.

## Remaining final gate

Do not permanently sign/tag/publish yet.

Required after PR #6:
1. Bun CI + Mobile CI green on the exact PR head;
2. merge, then post-merge main CI green;
3. POCO release build:
   - import videoA + videoC through Add clip;
   - verify both are adjacent on the SAME main row;
   - open the transition square and apply Cross-fade;
   - export and visually confirm the fade;
   - physically verify transform + keyframe export;
   - run one combined representative release export;
   - final logcat sweep;
4. require P0=0 / P1=0 and no release-surface blocker.

The prior POCO evidence host also hit 0 bytes free during Stage 16 discovery.
That is an infrastructure constraint, not an app defect; free enough workspace
for evidence/build artifacts before the final device rerun.

# Stage 17 — transition persistence and Gallery export delivery (2026-10-08)

Physical qualification of release-mode SHA
`main@19e900afa1d90d0c382a1adfece832459c2fcda9` finally used a
hash-matched fresh PR #6 APK. The old install was demonstrably stale.

POCO results:
- Two sequential `+ Add clip` imports finally landed adjacent on MAIN: PASS.
- Cross-fade created through the real transition square: PASS.
- Preview fade verified quantitatively (real intermediate alpha blending): PASS.
- Transform gesture, two keyframes, their animated interpolation: PASS.
- Combined in-app export reached Done; logcat clean: PASS.
- Release asset pruning: PASS; production APK contains none of the
  spike/autotest/legacy-harness payloads despite their presence in Vite www/.
- **P1:** cross-fade disappeared on project close/reload. `StorageService`
  hand-enumerated scene fields and omitted `scene.transitions` on BOTH
  saving and loading. The UI reverted to Add transition / None.
- **P2:** export success returned a private `noBackupFilesDir/exports/*.mp4`
  file URI, unusable from Gallery/share apps and unreadable to physical QA
  without privileged access. A Done event did not mean a customer got a file.

Branch: `fix/poco-transition-persistence`.

Changes:
1. Scene serialization now preserves the whole TScene shape and transforms
   only date/audio-buffer fields. Legacy scenes without transitions remain
   compatible; round-trip regression tests included.
2. Android completed export now publishes the verified video to the public
   MediaStore Videos collection at `Movies/Cutlyra` (API 29+, no storage
   permission), copying off the main thread, finalizing the pending media
   row only after all bytes are copied. On failure the pending row is deleted
   and a meaningful export error is surfaced; no false Done.
3. After successful publication the invisible private temp copy is removed
   to avoid accumulating large duplicate videos. Export Sheet tells users
   where their saved video appears.
4. Android device instrumentation verifies that gallery-published bytes
   are actually readable and identical to the source.

Release gate: Bun + Mobile CI must pass on exact PR head, followed by merged
main CI. Then build a FRESH release APK from exact merged SHA, prove its
bundled editor JS is current (no stale Vite/cap-sync state), upgrade the POCO
without deleting existing project data, reapply Fade, close/reopen and verify
it persists; export and independently retrieve/play the Gallery file
(including cross-fade and keyframe effects), verify no permission creep, and
perform a final logcat/resource audit.

Do not sign permanently, tag/publish GitHub Release, or submit Play until
the physical P1/P2 acceptance and all release gates are green.

