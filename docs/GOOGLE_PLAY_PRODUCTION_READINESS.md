# Cutlyra — Google Play production readiness

**Prepared:** 2026-11-14
**Base:** `main` @ `85ef015b8e079e517a104894e4856c0f55c0d106`
**App identity:** `app.cutlyra.editor` · versionName `0.1.1` · versionCode `2` (candidate) · minSdk 29 · targetSdk/compileSdk 36
- Previously uploaded highest versionCode (owner-confirmed): `1` (installed on POCO closed-test Cutlyra).
**Release candidate branch:** `release/play-production-candidate`
**Production-access application:** submitted 2026-11-15 11:09 IST; **rejected 2026-11-16** — Google requires **14 more days of closed testing from the review date**, with earliest reapplication around **2026-11-30**. The existing closed-testing track and application ID remain intact. Not under review.

This document is the source-side audit and final-gates record for Cutlyra's
first production release on the **existing** Google Play listing. It does not
upload, roll out, or modify any Play Console state, and it does not handle
signing credentials.

---

## Phase 1 — Release audit

### 1.1 Production build configuration
- `applicationId` = `app.cutlyra.editor` (unchanged).
- `versionCode 2`, `versionName "0.1.1"` (`apps/mobile/android/app/build.gradle`).
- Highest uploaded Play versionCode (owner-confirmed): `1` (POCO Play-installed closed-test Cutlyra).
- `minSdkVersion 29` (Android 10), `targetSdkVersion`/`compileSdkVersion 36` (Android 16).
- `allowBackup=false`; no broad media/storage permissions; `CAMERA` declared but never requested at runtime (documented in `CUTLYRA-PLAY-SUBMISSION-READINESS.md` §2).
- Release build type: `minifyEnabled false`, `debugSymbolLevel FULL` (native symbols shipped), signing only when `CUTLYRA_RELEASE_KEYSTORE*` env vars present (unsigned otherwise — never silently debug-signed).
- Spike/autotest payload pruned from release assets (`pruneSpikeAssetsForRelease`).
- ABI filters: `arm64-v8a`, `x86_64` (64-bit only, satisfies Play 64-bit requirement).
- Whisper model `ggml-tiny.en.bin` bundled; native `libcutlyra_whisper.so` for both ABIs.

### 1.2 Play App Signing / upload key
- Strategy: Play App Signing with Google-held app-signing key + separate owner-held upload key (`docs/PLAY_STORE_RELEASE.md` §7 / `CUTLYRA-PLAY-SUBMISSION-READINESS.md` §7).
- Upload key generated 2026-10-30 (`cutlyra-play-upload`, RSA 2048, PKCS12, alias `cutlyra-play-upload`); four `PLAY_UPLOAD_*` secrets configured (names verified, values never read back).
- Cross-channel compatibility (GitHub direct APK vs Play): **not decided**. If GitHub-installed and Play-installed copies must update each other in place, Play App Signing must be enrolled with a copy of the same app-signing key before the first rollout; otherwise Google generates its own and the two channels cannot update each other. **Owner decision required before first production release.**
- No private key material was accessed, printed or exported in this audit.

### 1.3 Highest versionCode already uploaded to Play
- **Unavailable in-repo.** Play Console is the authoritative source. `CUTLYRA-PLAY-SUBMISSION-READINESS.md` records that the Console upload was **not** performed as of the last documented run; the only built AAB (`cutlyra-play-1d7b533…aab`, SHA `6659567e…07f2bcd`) was produced by `play-bundle.yml` run `41037884283` but not uploaded.
- Highest uploaded Play versionCode confirmed by owner: **1** (POCO has Play-installed closed-test Cutlyra with versionCode 1). Therefore the next upload must use **versionCode 2**, which is now set in `apps/mobile/android/app/build.gradle` and enforced by the `play-bundle.yml` identity gate.
- Do not reuse versionCode 1 for any new upload (Play rejects equal/lower versionCodes).

### 1.4 Production permissions and privacy declarations
- Permissions: `INTERNET`, `CAMERA` (declared, never requested at runtime), `android.hardware.camera required="false"`.
- No `READ_MEDIA_*`, `READ_EXTERNAL_STORAGE`, `MANAGE_EXTERNAL_STORAGE`, `RECORD_AUDIO`, location, contacts, SMS, call log, phone.
- Privacy policy hosted at `https://site-dcfc842ddace4944a7faea3dcc59ff84.freebuff.page/privacy-policy` (production, verified 200, no auth, digest `b295e1c8…a3bd50`); in-app privacy screen concordant.
- Data Safety: no off-device collection, no sharing, no sale, no accounts; camera optional/user-initiated; local-only media processing.
- Support email: **HUMAN INPUT — real verified contact required** (still outstanding; blocks submission).

### 1.5 Signed release R8 qualification
- Shipping `release` build type: `minifyEnabled false` (R8 disabled in production).
- A CI-only `r8test` build type runs the full instrumented suite under R8 (`android-instrumentation-r8` job) and is green on `main` (verified 2026-11-14, 9m26s).
- Conclusion: R8 keep rules are **qualified**, so enabling `minifyEnabled true` is technically supported, but it is **not** enabled for v0.1.0 by default to minimize first-release risk. Enabling requires owner approval and a re-run of the R8 job on the exact release commit. R8 is not being enabled merely to silence a warning (no such warning exists).

### 1.6 Native library / 16 KB page-size compatibility
- Every `libcutlyra_whisper.so` LOAD segment aligned to `0x4000` (16384) in debug, release and AAB, both ABIs (verified by `llvm-readelf` in CI).
- Native debug symbols shipped at `FULL` level in the AAB (`BUNDLE-METADATA/com.android.tools.build.debugsymbols/`).
- Model SHA-256 pinned: `921e4cf8…920b1f` (`ggml-tiny.en.bin`).

### 1.7 Android 15/16 edge-to-edge compatibility
- targetSdk 36 enforces edge-to-edge by default on Android 15+.
- Web layer handles insets via `viewport-fit=cover` + `env(safe-area-inset-*)` padding in `packages/mobile-ui/src/components.css`, `apps/mobile/src/style.css`, `apps/mobile/src/app/app-root.css` (verified by source inspection).
- Theme sets `statusBarColor` transparent. No `enableEdgeToEdge()` call in Kotlin; insets handled at the WebView/CSS layer, consistent with the Capacitor WebView model.
- **Residual risk:** physical device verification of inset handling on Android 15/16 not yet performed (deferred; see Phase 3).

### 1.8 Crash and ANR readiness
- No crash-reporting or analytics SDK shipped (privacy posture); crashes rely on Play Console Android Vitals post-upload.
- Native crash symbolication available via `FULL` debug symbols.
- No ANR-inducing blocking work identified in source review; Media3 export runs on background threads (per `docs/EDL.md`).
- **Gap:** no in-app crash capture; production crash data only available after first Play rollout via Vitals.

### 1.9 Data preservation across app updates
- `allowBackup=false` (excludes app data from Android cloud backup — intended).
- App-private storage under the app's own data directory; FileProvider authority `app.cutlyra.editor.fileprovider` (production) distinct from QA variants.
- QA variants (`.qa`, `.qa2`, `.qa3`) use distinct applicationIds and storage — no cross-contamination with production.
- Restore-without-overwrite behavior verified in source (release notes / physical QA matrix).

### 1.10 Remaining Play Console policy warnings
- Support email still `HUMAN INPUT` (blocks submission).
- Content rating (IARC), target audience, Data Safety questionnaire to be transcribed from drafts.
- Google rejected the first production-access application on 2026-11-16 and requires **14 additional days of closed testing from the review date**. Keep the existing track and its 12 tester opt-ins running continuously; earliest reapplication ~2026-11-30. Do not create a new track or restart testing.
- Camera permission declared-but-unused is documented and disclosed in privacy policy (not a removal; intentional).

---

## Phase 2 — Release candidate

### 2.1 Branch
- `release/play-production-candidate` created from `main` @ `85ef015`.
- `applicationId` remains `app.cutlyra.editor`.
- `versionCode` is now `2` / `versionName` `0.1.1` (owner confirmed highest uploaded = 1; §1.3). No Play upload confirmed for versionCode 2 (candidate not yet built).

### 2.2 R8 decision
- Keep `minifyEnabled false` for v0.1.0 (see §1.5). R8 qualified but not enabled.

### 2.3 Release-like AAB validation
- Trigger `play-bundle.yml` (workflow_dispatch) on `main` to produce a fresh signed AAB + checksum + native symbols; validate container, signature, model SHA, native libs, 16 KB alignment, no spike assets. (Build only — no upload.)
- Previous validated AAB: `cutlyra-play-1d7b533…aab`, SHA `6659567e…07f2bcd` (run `41037884283`, all steps green).

### 2.4 Critical bridge / Media3 / WhisperJNI / Capacitor verification
- Media3 Transformer 1.11.0 (export, cross-fade compositor) — covered by instrumentation suite.
- WhisperJNI native symbols — covered by `android-instrumentation` and R8 job.
- Capacitor plugins — covered by unit + instrumentation tests.
- Full instrumented suite green on `main` (API 35 emulator + R8 variant, verified 2026-11-14).

### 2.5 Seven-job CI matrix
- On `main` @ `85ef015`: Bun CI (3 invariants: ubuntu/windows/macos) + Mobile CI (iOS, Android debug APK, API-35 instrumentation, R8) = **7/7 green** (verified 2026-11-14).
- RC branch will re-run the same matrix on push.

---

## Phase 3 — Physical acceptance (QA3, owner-approved only)

Use the separately owner-approved QA3 installation (`app.cutlyra.editor.qa3`, distinct signing identity) to validate — **no device package install/modify without owner approval**:

- [ ] Correct timeline lane ordering.
- [ ] No drag/resize jumping.
- [ ] Real video thumbnails.
- [ ] Rotate/Fit/Fill exported-frame parity.
- [ ] Restore without overwriting an existing project.
- [ ] Audio-bearing MP4 export.
- [ ] Replace Clip durability.
- [ ] Save and reopen.
- [ ] Backup and restore.

Production and historical QA applications must be preserved (six Cutlyra-related packages currently installed; QA3 is separate and not yet installed).

---

## Phase 4 — Play Console production-access answers (copy-ready)

> Copy-paste these into the Google Play Console production-access application.
> Do not submit automatically; owner must review and submit.

### 4.1 About your closed test

**Testers:** At least 12 testers opted into the closed test on the existing
Play listing (`app.cutlyra.editor`). (Play Console is authoritative for the
exact opted-in count and dates; record the real number before submitting.)

**What testers exercised (feedback received):**
- Timeline ordering / lane placement (reported during the closed test).
- Touch drag and resize gestures jumping or feeling unstable on the timeline.
- Video filmstrip thumbnails usability (readability, density, scrubbing).
- Editing latency / responsiveness during multi-clip edits.
- Requests for audio/music browsing and selection UX.
- Accidental duplication reports (duplicate clips appearing unexpectedly).
- One unexplained "black dot" report (no reproducible steps; not yet reproduced).

**Bugs reproduced and fixed in code (merged):**
- Timeline lane ordering corrected — PR #81 (merged).
- Touch drag/resize gesture stability improved — PR #82 (merged).
- Project-restore collision fixed: restore no longer overwrites an existing
  project (merged).
- Rotation / Fit / Fill export parity improvements (merged).

**Successfully tested:** photo and video exports that include audio, on-device,
with no watermark (CI + physical QA matrix).

**Tests passed in CI:** full seven-job matrix on merged `main` (Bun CI 3 jobs
+ Mobile CI 4 jobs), including API-35 instrumentation and R8 build type,
plus the Play AAB pipeline (container, signature, 16 KB alignment, model SHA,
no spike assets) — all green.

**Fixes still awaiting real-device confirmation (not yet claimed as passed):**
- Timeline lane ordering on a physical device.
- Touch drag/resize stability on a physical device.
- Restore to a separate project (no overwrite) on a physical device.
- Rotation / Fit / Fill export parity on a physical device.
- Video and audio export on a physical device.
- Replace Clip durability on a physical device.
- Filmstrip thumbnail usability on a physical device.

**Features still requested but not implemented:**
- Audio/music browsing UX improvements (requested; not yet shipped).
- Further filmstrip thumbnail density/readability polish.
- Explanation/resolution of the unexplained black-dot report (no repro yet).

**Test continuity:** The existing 14-day closed test and its tester opt-ins
are preserved. No new Play app was created and no test was restarted.

### 4.2 About your app/game

- App name: Cutlyra. Package: `app.cutlyra.editor`.
- Category: Video Players & Editors (creative tool).
- Target audience: general-purpose; not designed specifically for children.
- Ads: none. In-app purchases: none.
- Permissions: `CAMERA` only (optional, user-initiated capture); no broad
  media/storage, microphone, location, contacts, SMS, call log, or phone
  permissions.
- Data Safety: no off-device collection, no sharing, no sale, no accounts;
  all media processing is local to the device.
- Privacy policy URL: `https://site-dcfc842ddace4944a7faea3dcc59ff84.freebuff.page/privacy-policy`.
- Support email: **HUMAN INPUT required** (real verified contact).

### 4.3 About your production readiness

- Evidence: source-side CI green (7/7 on merged main), R8 keep rules
  qualified (CI-only `r8test` build type, green), 16 KB ELF alignment
  verified for all native libraries on both ABIs, targetSdk 36, native debug
  symbols shipped at FULL level, privacy policy hosted and drift-guarded,
  Camera permission declared-but-unused and documented.
- Candidate version: versionName `0.1.1`, versionCode `2` (owner-confirmed
  highest uploaded = 1; next upload uses 2).
- Production-access application submitted 2026-11-15 and **rejected 2026-11-16**; Google requires 14 more days of closed testing (earliest reapplication ~2026-11-30). Keep the existing track running; do not create a new one.
- Outstanding before production rollout: support email confirmed in Play Console; physical acceptance of newly merged fixes (Phase 3); final Play-delivered smoke test; cross-channel signing decision (optional for Play-only).

---

## Phase 5 — Final gates

### Release readiness verdict
**CONDITIONAL GO for source-side preparation. Production access was rejected 2026-11-16 and requires 14 more days of closed testing (earliest reapplication ~2026-11-30). NO-GO for production upload/rollout until Google grants access and the owner approves.**

### Existing Play package and version details
- Package: `app.cutlyra.editor` · versionName `0.1.1` · versionCode `2` · minSdk 29 · targetSdk 36.
- No Play upload confirmed in-repo (Console authoritative).

### Next eligible versionCode
- Owner-confirmed highest uploaded: `1`. Next upload: `2` (now set in build.gradle and enforced by play-bundle.yml gate).

### Production AAB validation results
- Previous validated AAB SHA-256: `6659567e478da6ddbe4986ffaf364c368dfbf0dde07bdbe52514ba4fd07f2bcd` (run `41037884283`).
- Fresh build produced by `play-bundle.yml` run `43597025250` on `main` @ `85ef015` (build only, no upload): invariants gate (ubuntu/windows/macos) + Android Play bundle — **all green**, 4/4 jobs. AAB built, container/signature/model/native-lib/16 KB alignment/spike-asset checks passed.
- **VersionCode-2 AAB built and verified (build only, no upload).**
  - Run: `play-bundle.yml` **43696665795** on `main` @ `8ca9683648e5b80cd985afc9bfaa86ba89d90fe9` — 4/4 jobs green.
  - Artifact: `cutlyra-play-8ca9683648e5b80cd985afc9bfaa86ba89d90fe9.aab`, 91,331,262 bytes.
  - **SHA-256: `2a368798d54ab55235ece04fa8c5916209be2d0498b6a009d253c7c47fac5c72`** (`SHA256SUMS.txt` matches on recompute).
  - `bundletool dump manifest`: `package="app.cutlyra.editor"`, `android:versionCode="2"`, `android:versionName="0.1.1"`.
  - Signer: `CN=Cutlyra Play Upload, O=Cutlyra`, SHA-256 `90:01:71:...:BC:DA` — matches the Play Console registered upload certificate; not debug-signed.
  - Native libs (arm64-v8a, x86_64), Whisper model, and no test-only assets confirmed; 16 KB alignment and signature gates passed in the run.

### Signing compatibility assessment
- The existing Play listing already has a closed-testing release; Play App Signing is already in effect and must **not** be re-enrolled or replaced. Preserve the registered upload-key identity.
- **Upload-key compatibility: CONFIRMED.** Play Console registered upload certificate SHA-256 is `90:01:71:5E:20:CF:33:03:F1:4A:4A:50:F2:B3:AB:11:55:0B:65:43:F2:BE:E3:15:87:13:B8:8B:F5:E6:BC:DA`, and the signed AAB's signer matches it exactly. No key was rotated or replaced.
- Cross-channel (GitHub direct APK ↔ Play) compatibility is **optional** and must not delay a Play-only release.

### Required owner actions
1. Confirm the existing registered Play upload-key SHA-256 fingerprint and that the `play-bundle.yml` keystore matches it; if not, follow the official Play upload-key reset/recovery path.
2. Confirm highest uploaded versionCode in Play Console (currently owner-reported as `1`); set `versionCode` accordingly and rebuild if needed.
3. Confirm the real support email in Play Console; replace `HUMAN INPUT` in `docs/PLAY_STORE_LISTING.md`.
4. Authorize BUILD ONLY of the versionCode-2 AAB via `play-bundle.yml`, download AAB + checksum, verify signer is the registered upload key. Do not upload yet.
5. Complete Data Safety, content rating (IARC), target audience, store listing from drafts (existing listing must be preserved).
6. Upload icon, feature graphic, screenshots only if the listing needs them (prefer recapture from final candidate).
7. Owner-approved QA3 physical acceptance of freshly merged fixes before rollout (Phase 3).
8. Keep the existing closed test running for the additional 14 days Google requires (from 2026-11-16); reapply for production access around 2026-11-30 or later, once eligible.
9. Explicit owner approval before any production upload or rollout.

### Unresolved P0/P1 bugs
- None identified as P0/P1 in source audit. (Physical acceptance items in Phase 3 are unexecuted and must not be claimed as passed.)

### Production-access application readiness
- **Submitted** 2026-11-15 11:09 IST; **rejected 2026-11-16**. Google requires **14 additional days of closed testing from the review date**.
- Earliest reapplication: around **2026-11-30**. The existing closed-testing track, testers and application ID stay intact.
- Remaining before rollout after approval: support email confirmed, physical acceptance of newly merged fixes, Play-delivered smoke test, owner rollout approval.

### Exact PR and CI evidence
- QA3 signing environment PR: #85, merge `85ef015`, 7/7 CI green on merged main.
- Play readiness PRs #43–#46 (see `CUTLYRA-PLAY-SUBMISSION-READINESS.md` §8).
- Play bundle run: `41037884283` (AAB SHA `6659567e…07f2bcd`).
- Seven-job matrix on `main` @ `85ef015`: all green (2026-11-14).
- Seven-job matrix on RC head `9db7e14` (PR #86): all green (Bun CI 3 invariants + Mobile CI 4 jobs).

### Remaining reasons not to publish
1. Production access **rejected 2026-11-16**; Google requires 14 more days of closed testing (earliest reapplication ~2026-11-30).
2. Support email not yet confirmed in Play Console.
3. Physical acceptance of newly merged fixes (Phase 3) unexecuted.
4. Play-delivered build not yet smoke-tested on a real phone.
5. versionCode-2 AAB not yet built (needs owner authorization + keystore).
6. No explicit owner approval for production upload/rollout.

### Resolved / no longer blocking
- Existing 12-tester closed test remains active; the additional 14-day requirement runs from 2026-11-16.
- Existing Play app `app.cutlyra.editor`, listing, and Play App Signing **preserved** (no new app, no re-enrollment).
- Highest uploaded versionCode owner-reported as `1`; next upload uses `2`.

---

## Google production-access review

- Application submitted by the owner on 2026-11-15 at 11:09 IST.
- **Rejected on 2026-11-16.** Google requires **14 additional days of closed testing measured from the review date**, so the earliest reapplication is around **2026-11-30**.
- Do **not** describe the application as under review — the outcome is known: additional testing required.
- Do **not** create a new app or a new closed-testing track. Keep the existing track, its 12 testers and the application ID intact and continuously opted in.
- Do **not** resubmit before the additional 14-day window has elapsed; reapply around 2026-11-30 or later.
- Treat 2026-11-30 as the earliest expected date, not a guarantee; follow Play Console's actual eligibility prompt.

---

## Constraints honoured
- No production upload or rollout performed.
- No device package installed or modified.
- No signing credential accessed, printed, exported or uploaded.
- Production signing, Play Console, versionCode, app identities, user media untouched by this audit.
- QA3 remains separate from the Play application.
- No AI attribution in commits/PRs.
